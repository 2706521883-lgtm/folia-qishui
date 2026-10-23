// electron/wallpaperEngineRuntime.cjs
// Wallpaper Engine side-car runtime: locates and verifies wallpaper64.exe, guarantees the
// `-control` channel is answering, opens one scene project into a parked playback window, and
// keeps the scene's audio properties muted through a retry schedule.
//
// The engine control protocol, the Authenticode signer gate, the control-channel-ready-then-send
// rule, the no-arg engine bootstrap and the mute retry schedules are ported from Mineradio
// (GPL-3.0-only) desktop/wallpaper-engine-runtime.js, revision
// d43de565acabfdc1a9c9820a27e81a98ccbebcef.
// This file is distributed with Folia under AGPL-3.0.
//
// Nothing here patches or rewrites the user's wallpaper projects: the audio suppression rides on
// `-control applyProperties` only, so every file on disk stays byte-identical.

const { resolveSteamLibraryRoots } = require('./wallpaperEngineLibrary.cjs');
const { encodePowerShellCommand } = require('./wallpaperEngineWindow.cjs');

const WALLPAPER_ENGINE_EXECUTABLES = ['wallpaper64.exe', 'wallpaper32.exe'];
const WALLPAPER_ENGINE_INSTALL_SUBPATH = ['steamapps', 'common', 'wallpaper_engine'];
const ENGINE_SIGNER_PATTERN = /\bSkutta Software\b/i;
const ENGINE_READY_CACHE_MS = 2500;
const ENGINE_READY_SUCCESS_COUNT = 2;
const ENGINE_PROCESS_STABLE_MS = 720;
const CONTROL_PROBE_ARGS = ['-control', 'getWallpaper', '-monitor', '0'];
const CONTROL_TIMEOUT_MS = 8000;
const OPEN_TIMEOUT_MS = 15000;
const ENGINE_BOOT_TIMEOUT_MS = 25000;
const CONTROL_POLL_INTERVAL_MS = 400;
const MAX_MUTE_PROPERTIES = 256;
const MIN_PLAYBACK_SIZE = 480;
const MAX_PLAYBACK_SIZE = 3840;

// Every playback window is titled with this prefix. It is how the runtime finds orphaned windows
// from a crashed/rebuilt session and how the native manager lists the ones it must repair.
const WALLPAPER_ENGINE_LOCATION_PREFIX = 'Folia Wallpaper ';
// The engine can move/resize its playback window after openWallpaper returns (observed on a real
// session: park 3711,1524 -> engine moved it to 3999,2036). A fast, cheap native watch is what
// keeps it parked; PowerShell is only the fallback and does not run this watch.
const WINDOW_WATCH_INTERVAL_MS = 750;
const WINDOW_LOST_GRACE_MS = 6000;
// Engine restarts and graphics-settings changes can re-create the playback window after the
// title-bound watcher has already reset. This slow, session-independent scan catches those late
// orphans (and any window whose title changed) for the rest of the app's lifetime.
const ORPHAN_WATCH_INTERVAL_MS = 5000;
const SAFE_PROPERTY_KEY = /^[a-z0-9_.-]{1,128}$/i;
const BLOCKED_PROPERTY_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

// Audio keeps re-asserting long after the window opens: a scene may restore its own volume from
// its saved user settings at any point during startup.
const INITIAL_MUTE_RETRY_DELAYS_MS = [0, 120, 320, 700, 1300, 2200];
const MUTE_REASSERT_DELAYS_MS = [80, 220, 650, 1500, 3200, 6500, 10000];
const MUTE_SCHEDULE_MS = [
  ...INITIAL_MUTE_RETRY_DELAYS_MS,
  ...MUTE_REASSERT_DELAYS_MS.map(
    (delay) => delay + INITIAL_MUTE_RETRY_DELAYS_MS[INITIAL_MUTE_RETRY_DELAYS_MS.length - 1],
  ),
];

const SIGNATURE_SCRIPT = `
$ErrorActionPreference = 'Stop'
try {
  $signature = Get-AuthenticodeSignature -FilePath $env:FOLIA_WE_EXE
  Write-Output (@{
    ok = ($signature.Status -eq 'Valid')
    status = [string]$signature.Status
    subject = if ($signature.SignerCertificate) { $signature.SignerCertificate.Subject } else { '' }
  } | ConvertTo-Json -Compress -Depth 3)
} catch {
  Write-Output (@{ ok = $false; status = 'error'; message = $_.Exception.Message } | ConvertTo-Json -Compress -Depth 3)
}
`;

// A playback window is addressed by its title only, so the title must be unique per session and
// impossible to collide with a user-named window.
const buildLocationTitle = (seed) => {
  const token = String(seed || '').replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase() || 'session';
  const nonce = Math.random().toString(16).slice(2, 8);
  return WALLPAPER_ENGINE_LOCATION_PREFIX + token + nonce;
};

const clampPlaybackSize = (value, fallback) => {
  const size = Math.round(Number(value));
  if (!Number.isFinite(size) || size <= 0) return fallback;
  return Math.min(MAX_PLAYBACK_SIZE, Math.max(MIN_PLAYBACK_SIZE, size));
};

const buildOpenWallpaperArgs = ({ file, locationTitle, width, height, x, y }) => [
  '-control', 'openWallpaper',
  '-file', String(file),
  '-playInWindow', String(locationTitle),
  '-width', String(Math.round(width)),
  '-height', String(Math.round(height)),
  '-x', String(Math.round(x)),
  '-y', String(Math.round(y)),
  '-borderless',
];

// Only plain scalar values under safe property keys survive; anything else is dropped rather than
// handed to the engine, which would reject the whole RAW payload.
const sanitizeMuteProperties = (properties) => {
  const safe = {};
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) return safe;
  for (const [rawKey, rawValue] of Object.entries(properties)) {
    if (Object.keys(safe).length >= MAX_MUTE_PROPERTIES) break;
    const key = String(rawKey || '').trim();
    if (!SAFE_PROPERTY_KEY.test(key) || BLOCKED_PROPERTY_KEYS.has(key.toLowerCase())) continue;
    if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
      safe[key] = rawValue;
    } else if (typeof rawValue === 'boolean') {
      safe[key] = rawValue;
    } else if (typeof rawValue === 'string' && rawValue.length <= 256) {
      safe[key] = rawValue;
    }
  }
  return safe;
};

const buildApplyPropertiesArgs = ({ locationTitle, properties }) => {
  const payload = 'RAW~(' + JSON.stringify(sanitizeMuteProperties(properties)) + ')~END';
  return ['-control', 'applyProperties', '-properties', payload, '-location', String(locationTitle)];
};

const RAW_PAYLOAD_ARG = /^RAW~\(.*\)~END$/s;

// Windows command-line escaping for the verbatim path: only arguments that contain a space or a
// quote are wrapped, and backslashes in front of the closing quote are doubled.
const quoteWindowsArgument = (value) => {
  const text = String(value == null ? '' : value);
  if (text && !/[\s"]/.test(text)) return text;
  return '"' + text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
};

const windowsDirectoryOf = (file) => {
  const text = String(file || '');
  const index = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
  return index > 0 ? text.slice(0, index) : '';
};

// The engine reads the RAW~({...})~END payload straight from the raw command line, so the payload's
// own quotes must survive: Node's default Windows escaping rewrites them as \" and the engine then
// answers with exit code 4 instead of applying anything. Returns null for argument sets that do not
// carry a payload — those go through the ordinary execFile encoding.
const buildVerbatimControlInvocation = (executable, args) => {
  const payloadIndex = args.findIndex((value) => RAW_PAYLOAD_ARG.test(String(value)));
  if (payloadIndex < 0) return null;
  const file = String(executable);
  return {
    file,
    args: args.map((value, index) => (index === payloadIndex ? String(value) : quoteWindowsArgument(value))),
    // The reference implementation runs the control command from the install directory; the
    // directory is split off by hand so this stays host-independent.
    cwd: windowsDirectoryOf(file),
  };
};

// `reg`-discovered library roots → candidate wallpaper64.exe paths on disk (existence only; the
// signer check happens once, on the first candidate that exists).
const findExecutableCandidates = async ({ fsp, path, execFile }) => {
  const { libraryRoots } = await resolveSteamLibraryRoots({ fsp, path, execFile });
  const candidates = [];
  for (const root of libraryRoots) {
    for (const executable of WALLPAPER_ENGINE_EXECUTABLES) {
      candidates.push(path.join(root, ...WALLPAPER_ENGINE_INSTALL_SUBPATH, executable));
    }
  }
  const existing = [];
  for (const candidate of candidates) {
    try {
      const stats = await fsp.stat(candidate);
      if (stats.isFile()) existing.push(candidate);
    } catch {
      // Not installed in this library.
    }
  }
  return existing;
};

function createWallpaperEngineRuntime(options = {}) {
  const {
    fs,
    path,
    execFile,
    spawn,
    log = () => {},
    logWarn = () => {},
    windowHelper = null,
    getVirtualDesktopBounds = () => null,
    emitStatus = () => {},
    timers = { setTimeout, clearTimeout, setInterval, clearInterval },
    delay = (ms) => new Promise((resolve) => { timers.setTimeout(resolve, ms); }),
  } = options;
  const fsp = fs.promises;

  let executablePath = '';
  let executableVerified = false;
  let readyAt = 0;
  let readyPromise = null;
  let muteTimers = [];
  let muteChain = Promise.resolve();
  let currentItem = null;
  // Physical-pixel corner learned from the window helper; null until the first successful park.
  let parkTarget = null;
  let disposed = false;
  let watchTimer = null;
  let watchBusy = false;
  let watchMisses = 0;
  let orphanWatchTimer = null;
  let orphanWatchBusy = false;

  const status = {
    phase: 'idle',
    engineReady: false,
    executable: '',
    locationTitle: '',
    itemId: '',
    title: '',
    width: 0,
    height: 0,
    parkX: 0,
    parkY: 0,
    muted: false,
    audioPropertyCount: 0,
    mutedPropertyCount: 0,
    startedAt: 0,
    error: '',
    windowManaged: false,
    windowWatchActive: false,
    windowLost: false,
  };

  const publishStatus = (patch = {}) => {
    Object.assign(status, patch);
    emitStatus({ ...status });
  };

  const runExecFile = (file, args, timeoutMs, extra = null) => new Promise((resolve) => {
    execFile(file, args, {
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 4,
      ...(extra || {}),
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error && typeof error.code === 'number' ? error.code : (error ? -1 : 0),
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
      });
    });
  });

  // Runs one `-control` command against the engine. Never throws: callers branch on `ok`.
  const spawnControl = async (args, timeoutMs = CONTROL_TIMEOUT_MS) => {
    if (!executablePath) return { ok: false, code: -1, stdout: '', stderr: 'no-executable' };
    const verbatim = buildVerbatimControlInvocation(executablePath, args);
    const result = verbatim
      ? await runExecFile(verbatim.file, verbatim.args, timeoutMs, {
        cwd: verbatim.cwd,
        windowsVerbatimArguments: true,
        shell: false,
      })
      : await runExecFile(executablePath, args, timeoutMs);
    if (!result.ok) {
      logWarn('[wallpaper-engine] control command failed', args[1] || args.join(' '), result.code);
    }
    return result;
  };

  // `-control getWallpaper -monitor 0` answers exactly when the engine's control channel is up.
  const probeControlChannel = async () => {
    if (!executablePath) return false;
    const result = await runExecFile(executablePath, CONTROL_PROBE_ARGS, CONTROL_TIMEOUT_MS);
    return result.ok;
  };

  // Confirms the binary really is Wallpaper Engine before we ever execute it: the install path
  // comes from the registry, which an unprivileged process could point somewhere else.
  const verifyExecutableSignature = async (candidate) => {
    const script = await new Promise((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encodePowerShellCommand(SIGNATURE_SCRIPT),
      ], {
        timeout: 20000,
        windowsHide: true,
        env: { ...process.env, FOLIA_WE_EXE: candidate },
      }, (error, stdout) => resolve(String(stdout || '')));
    });
    const lines = script.split(/\r?\n/);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line.startsWith('{') || !line.endsWith('}')) continue;
      try {
        const parsed = JSON.parse(line);
        return {
          ok: Boolean(parsed.ok) && ENGINE_SIGNER_PATTERN.test(String(parsed.subject || '')),
          status: String(parsed.status || ''),
          subject: String(parsed.subject || ''),
        };
      } catch {
        // Keep scanning.
      }
    }
    return { ok: false, status: 'unparsed', subject: '' };
  };

  const resolveExecutable = async ({ force = false } = {}) => {
    if (executableVerified && executablePath && !force) return executablePath;
    const candidates = await findExecutableCandidates({ fsp, path, execFile });
    for (const candidate of candidates) {
      const verification = await verifyExecutableSignature(candidate);
      if (verification.ok) {
        executablePath = candidate;
        executableVerified = true;
        publishStatus({ executable: candidate });
        return candidate;
      }
      logWarn('[wallpaper-engine] refusing unverified executable', candidate, verification.status, verification.subject);
    }
    executablePath = '';
    executableVerified = false;
    logWarn('[wallpaper-engine] no verified Wallpaper Engine executable found', candidates.length);
    return '';
  };

  const launchEngine = async () => {
    if (!executableVerified || !executablePath) return false;
    try {
      const child = spawn(executablePath, [], { windowsHide: true, stdio: 'ignore', detached: false });
      child.on('error', (error) => logWarn('[wallpaper-engine] engine launch failed', error && error.message));
      child.unref();
    } catch (error) {
      logWarn('[wallpaper-engine] engine spawn threw', error && error.message);
      return false;
    }
    await delay(ENGINE_PROCESS_STABLE_MS);
    // A no-argument launch can bring up the engine's main UI, which is another taskbar entry and
    // another surface that can cover the player. We only get here after the control channel was
    // silent, i.e. this is an engine Folia just started; hide that window, never touch a window
    // the user opened themselves while the engine was already running.
    if (windowHelper && typeof windowHelper.hideEngineMainWindow === 'function') {
      try {
        const hidden = windowHelper.hideEngineMainWindow();
        if (hidden && hidden.ok) log('[wallpaper-engine] hid engine main window', hidden.hwnd);
      } catch (error) {
        logWarn('[wallpaper-engine] hide engine main window failed', error && error.message);
      }
    }
    return true;
  };

  // Polls until the control channel answers consecutively, so a half-started engine cannot swallow
  // the following openWallpaper.
  const waitForControlChannel = async (timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    let consecutive = 0;
    for (;;) {
      if (disposed) return false;
      if (await probeControlChannel()) {
        consecutive += 1;
        if (consecutive >= ENGINE_READY_SUCCESS_COUNT) return true;
      } else {
        consecutive = 0;
      }
      if (Date.now() >= deadline) return false;
      await delay(CONTROL_POLL_INTERVAL_MS);
    }
  };

  const ensureControlReady = async ({ force = false } = {}) => {
    if (!executablePath) {
      const resolved = await resolveExecutable();
      if (!resolved) {
        publishStatus({ engineReady: false, error: 'engine-not-found' });
        return false;
      }
    }
    if (!force && Date.now() - readyAt < ENGINE_READY_CACHE_MS) return true;
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
      if (await waitForControlChannel(1500)) {
        readyAt = Date.now();
        publishStatus({ engineReady: true });
        return true;
      }
      log('[wallpaper-engine] control channel silent, bootstrapping engine');
      await launchEngine();
      const ready = await waitForControlChannel(ENGINE_BOOT_TIMEOUT_MS);
      readyAt = ready ? Date.now() : 0;
      publishStatus({ engineReady: ready, error: ready ? '' : 'engine-not-ready' });
      return ready;
    })();
    try {
      return await readyPromise;
    } finally {
      readyPromise = null;
    }
  };

  const clearMuteTimers = () => {
    for (const timer of muteTimers) timers.clearTimeout(timer);
    muteTimers = [];
  };

  const applyMuteOnce = async () => {
    if (disposed || !status.locationTitle || !status.itemId) return false;
    const item = currentItem;
    if (!item) return false;
    const properties = sanitizeMuteProperties(item.muteProperties);
    if (!Object.keys(properties).length) return false;
    const result = await spawnControl(
      buildApplyPropertiesArgs({ locationTitle: status.locationTitle, properties }),
      CONTROL_TIMEOUT_MS,
    );
    if (result.ok) {
      if (!status.muted) {
        publishStatus({
          muted: true,
          mutedPropertyCount: Object.keys(properties).length,
          audioPropertyCount: Number(item.audioPropertyCount) || 0,
        });
      }
      return true;
    }
    return false;
  };

  // Serialises the re-assert attempts: parallel control invocations can arrive out of order and
  // an early attempt would then win over a later one.
  const queueMute = () => {
    muteChain = muteChain.then(() => applyMuteOnce()).catch(() => false);
    return muteChain;
  };

  const scheduleMute = () => {
    clearMuteTimers();
    for (const delayMs of MUTE_SCHEDULE_MS) {
      muteTimers.push(timers.setTimeout(() => { queueMute(); }, delayMs));
    }
  };

  const resolvePlaybackGeometry = () => {
    const bounds = getVirtualDesktopBounds() || { x: 0, y: 0, width: 1920, height: 1080 };
    const width = clampPlaybackSize(bounds.width, 1920);
    const height = clampPlaybackSize(bounds.height, 1080);
    // Parked just inside the primary screen's bottom-right corner: a few pixels stay on screen,
    // which keeps the window composed/capturable without it being noticeable. The first window uses
    // this DIP approximation; the native helper then re-parks at the OS's primary-screen corner.
    return {
      width,
      height,
      // Open-time hint only; the native helper re-parks on the primary screen with a small visible
      // inset (the virtual corner can sit on an inactive secondary and break desktop capture).
      parkX: parkTarget ? parkTarget.x : Math.round(bounds.x + bounds.width - 4),
      parkY: parkTarget ? parkTarget.y : Math.round(bounds.y + bounds.height - 4),
    };
  };

  const stopWindowWatch = ({ silent = false } = {}) => {
    if (watchTimer) timers.clearInterval(watchTimer);
    watchTimer = null;
    watchBusy = false;
    watchMisses = 0;
    if (status.windowWatchActive) {
      if (silent) status.windowWatchActive = false;
      else publishStatus({ windowWatchActive: false });
    }
  };

  const startWindowWatch = () => {
    stopWindowWatch({ silent: true });
    if (disposed) return false;
    if (!windowHelper || typeof windowHelper.monitorWindow !== 'function') return false;
    if (typeof timers.setInterval !== 'function' || typeof timers.clearInterval !== 'function') return false;
    if (!status.locationTitle) return false;
    watchMisses = 0;
    watchTimer = timers.setInterval(() => { void runWindowWatch(); }, WINDOW_WATCH_INTERVAL_MS);
    return true;
  };

  const handleWindowLost = (reason) => {
    if (disposed) return;
    stopWindowWatch({ silent: true });
    clearMuteTimers();
    currentItem = null;
    logWarn('[wallpaper-engine] playback window lost, resetting session', reason || 'not-found');
    publishStatus({
      phase: 'idle',
      locationTitle: '',
      itemId: '',
      title: '',
      muted: false,
      mutedPropertyCount: 0,
      audioPropertyCount: 0,
      startedAt: 0,
      error: '',
      windowManaged: false,
      windowWatchActive: false,
      windowLost: true,
    });
    // The engine may have re-created the playback window under a title the watcher no longer
    // knows. Close every Folia-prefixed leftover so it cannot sit in the taskbar while auto-start
    // is off; a session that auto-restarts will skip its own title.
    void cleanupOrphanWindows();
  };

  // Runs on the native manager's cheap timer. It never throws into the interval: a failed repair
  // is retried on the next tick, and only a sustained loss resets the session.
  const runWindowWatch = async () => {
    if (disposed || watchBusy || !status.locationTitle) return;
    watchBusy = true;
    try {
      const result = await windowHelper.monitorWindow({ title: status.locationTitle });
      if (!result || !result.ok) {
        watchMisses += 1;
        if (watchMisses === 1) logWarn('[wallpaper-engine] window monitor lost', (result && result.reason) || 'unknown');
        if (watchMisses * WINDOW_WATCH_INTERVAL_MS >= WINDOW_LOST_GRACE_MS) {
          handleWindowLost((result && result.reason) || 'not-found');
        }
        return;
      }
      if (watchMisses > 0) {
        log('[wallpaper-engine] window monitor reacquired', result.hwnd);
        watchMisses = 0;
      }
      if (result.styleApplied || result.restoredVisible || result.moved || result.foreground) {
        log('[wallpaper-engine] window monitor repaired', JSON.stringify(result));
      }
      if (!status.windowManaged) publishStatus({ windowManaged: true });
    } catch (error) {
      watchMisses += 1;
      logWarn('[wallpaper-engine] window monitor error', error && error.message);
      if (watchMisses * WINDOW_WATCH_INTERVAL_MS >= WINDOW_LOST_GRACE_MS) {
        handleWindowLost('monitor-error');
      }
    } finally {
      watchBusy = false;
    }
  };

  const hideWindowSafe = (title) => {
    if (!windowHelper || typeof windowHelper.hideWindow !== 'function' || !title) return false;
    try {
      const result = windowHelper.hideWindow({ title });
      if (result && result.ok) {
        log('[wallpaper-engine] hid playback window', title, result.hwnd);
        return true;
      }
      logWarn('[wallpaper-engine] hide playback window failed', title, result && result.reason);
    } catch (error) {
      logWarn('[wallpaper-engine] hide playback window threw', error && error.message);
    }
    return false;
  };

  // Closes one Folia-prefixed playback window through the engine; if the engine refuses (or is
  // not ready), it is hidden through the native manager instead. Returns 'closed' | 'hidden'.
  const closeOrphanWindow = async (title) => {
    const name = String(title || '');
    if (!name || name === status.locationTitle) return 'skipped';
    const result = await spawnControl(['-control', 'closeWallpaper', '-location', name], CONTROL_TIMEOUT_MS);
    if (result.ok) {
      log('[wallpaper-engine] orphan window closed', name);
      return 'closed';
    }
    logWarn('[wallpaper-engine] orphan close failed', name, result.code);
    return hideWindowSafe(name) ? 'hidden' : 'failed';
  };

  // Windows from a crashed/killed session keep their titles for the lifetime of the engine. Close
  // every one that belongs to an earlier session before opening a new one; if the engine refuses,
  // at least hide it so it cannot surface over the player.
  const cleanupOrphanWindows = async () => {
    if (!windowHelper || typeof windowHelper.listSessionWindows !== 'function') {
      return { checked: 0, closed: 0, hidden: 0 };
    }
    let entries = [];
    try {
      entries = windowHelper.listSessionWindows({ prefix: WALLPAPER_ENGINE_LOCATION_PREFIX }) || [];
    } catch (error) {
      logWarn('[wallpaper-engine] orphan scan failed', error && error.message);
      return { checked: 0, closed: 0, hidden: 0 };
    }
    let closed = 0;
    let hidden = 0;
    for (const entry of entries) {
      const title = entry && entry.title ? String(entry.title) : '';
      if (!title || title === status.locationTitle) continue;
      const outcome = await closeOrphanWindow(title);
      if (outcome === 'closed') closed += 1;
      else if (outcome === 'hidden') hidden += 1;
    }
    if (entries.length) {
      log('[wallpaper-engine] orphan windows', entries.length, 'closed', closed, 'hidden', hidden);
    }
    return { checked: entries.length, closed, hidden };
  };

  // A slow scan that does not depend on the current session title. It catches the window that the
  // engine re-creates after a graphics-settings change/restart (often later than the 6s title-bound
  // watcher allows), and any window whose title changed. It runs for the app's lifetime once the
  // feature has been used, so a late orphan is cleaned even when auto-start is off.
  const runOrphanWatch = async () => {
    if (disposed || orphanWatchBusy) return;
    if (!windowHelper || typeof windowHelper.listSessionWindows !== 'function') return;
    orphanWatchBusy = true;
    try {
      let entries = [];
      try {
        entries = windowHelper.listSessionWindows({ prefix: WALLPAPER_ENGINE_LOCATION_PREFIX }) || [];
      } catch (error) {
        logWarn('[wallpaper-engine] orphan watch scan failed', error && error.message);
        return;
      }
      const stale = entries.filter((entry) => entry && entry.title && entry.title !== status.locationTitle);
      if (!stale.length) return;
      log('[wallpaper-engine] orphan watch found', stale.map((entry) => entry.title).join(' | '));
      for (const entry of stale) await closeOrphanWindow(entry.title);
    } finally {
      orphanWatchBusy = false;
    }
  };

  const startOrphanWatch = () => {
    if (orphanWatchTimer || disposed) return false;
    if (!windowHelper || typeof windowHelper.listSessionWindows !== 'function') return false;
    if (typeof timers.setInterval !== 'function' || typeof timers.clearInterval !== 'function') return false;
    orphanWatchTimer = timers.setInterval(() => { void runOrphanWatch(); }, ORPHAN_WATCH_INTERVAL_MS);
    log('[wallpaper-engine] orphan watch started');
    return true;
  };

  const stopOrphanWatch = () => {
    if (orphanWatchTimer) timers.clearInterval(orphanWatchTimer);
    orphanWatchTimer = null;
    orphanWatchBusy = false;
  };

  const stop = async ({ reason = 'stop' } = {}) => {
    stopWindowWatch({ silent: true });
    clearMuteTimers();
    const locationTitle = status.locationTitle;
    currentItem = null;
    if (!locationTitle) {
      publishStatus({
        phase: 'idle',
        locationTitle: '',
        itemId: '',
        title: '',
        muted: false,
        windowManaged: false,
        windowWatchActive: false,
        windowLost: false,
      });
      return { ok: true };
    }
    publishStatus({ phase: 'stopping' });
    const result = await spawnControl(['-control', 'closeWallpaper', '-location', locationTitle], CONTROL_TIMEOUT_MS);
    // A failed close is exactly how a playback window becomes an orphan (and how multiple taskbar
    // entries accumulate). Hiding it is an immediate, reversible containment; the next start also
    // retries the engine-side close during orphan cleanup.
    if (!result.ok) hideWindowSafe(locationTitle);
    publishStatus({
      phase: 'idle',
      locationTitle: '',
      itemId: '',
      title: '',
      muted: false,
      mutedPropertyCount: 0,
      audioPropertyCount: 0,
      startedAt: 0,
      error: result.ok ? '' : 'close-failed',
      windowManaged: false,
      windowWatchActive: false,
      windowLost: false,
    });
    log('[wallpaper-engine] playback stopped', reason, result.ok ? 'ok' : 'close-failed');
    return { ok: result.ok };
  };

  const start = async ({ item, muteAudio = true } = {}) => {
    if (disposed) return { ok: false, error: 'disposed' };
    if (!item || !item.enginePlayable || !item.projectFile) {
      publishStatus({
        phase: 'error',
        error: 'item-not-playable',
        windowManaged: false,
        windowWatchActive: false,
        windowLost: false,
      });
      return { ok: false, error: 'item-not-playable' };
    }
    if (status.phase === 'starting') return { ok: false, error: 'busy' };
    // Once the engine-capture path is used, keep a session-independent orphan scan alive for the
    // rest of the process. It survives stop()/window-loss resets and catches late re-created wins.
    startOrphanWatch();
    if (status.locationTitle) await stop({ reason: 'restart' });
    publishStatus({ phase: 'starting', error: '', muted: false, windowLost: false });
    currentItem = item;
    try {
      if (!(await ensureControlReady())) {
        currentItem = null;
        publishStatus({
          phase: 'error',
          error: status.error || 'engine-not-ready',
          windowManaged: false,
          windowWatchActive: false,
          windowLost: false,
        });
        return { ok: false, error: status.error || 'engine-not-ready' };
      }
      // Previous sessions may have left playback windows behind (engine restart, failed close,
      // killed Folia). Close them before opening the new one so the taskbar cannot accumulate.
      await cleanupOrphanWindows();
      const geometry = resolvePlaybackGeometry();
      const locationTitle = buildLocationTitle(item.id);
      publishStatus({ locationTitle, itemId: item.id, title: item.title, width: geometry.width, height: geometry.height, parkX: geometry.parkX, parkY: geometry.parkY });
      let opened = await spawnControl(buildOpenWallpaperArgs({
        file: item.projectFile,
        locationTitle,
        width: geometry.width,
        height: geometry.height,
        x: geometry.parkX,
        y: geometry.parkY,
      }), OPEN_TIMEOUT_MS);
      if (!opened.ok) {
        // The probe can be optimistic (the engine answers even while it is still tearing down);
        // one forced bootstrap + retry covers that instead of surfacing a dead playback window.
        logWarn('[wallpaper-engine] openWallpaper failed, forcing engine bootstrap and retrying');
        await ensureControlReady({ force: true });
        opened = await spawnControl(buildOpenWallpaperArgs({
          file: item.projectFile,
          locationTitle,
          width: geometry.width,
          height: geometry.height,
          x: geometry.parkX,
          y: geometry.parkY,
        }), OPEN_TIMEOUT_MS);
      }
      if (!opened.ok) {
        currentItem = null;
        publishStatus({
          phase: 'error',
          locationTitle: '',
          itemId: '',
          title: '',
          error: 'open-failed',
          windowManaged: false,
          windowWatchActive: false,
          windowLost: false,
        });
        return { ok: false, error: 'open-failed' };
      }
      let parkedResult = null;
      if (windowHelper) {
        parkedResult = await windowHelper.parkWindow({ title: locationTitle });
        if (parkedResult && parkedResult.ok && parkedResult.target) {
          // The helper reports the OS's own primary-screen corner; reuse it so the next window is
          // opened at the right place instead of relying on the DIP approximation.
          parkTarget = { x: Number(parkedResult.target.x), y: Number(parkedResult.target.y) };
          publishStatus({ parkX: parkTarget.x, parkY: parkTarget.y });
        }
        log('[wallpaper-engine] park check', JSON.stringify(parkedResult));
      }
      const watchActive = startWindowWatch();
      publishStatus({
        phase: 'running',
        startedAt: Date.now(),
        windowManaged: Boolean(parkedResult && parkedResult.ok),
        windowWatchActive: watchActive,
        windowLost: false,
      });
      if (muteAudio) scheduleMute();
      return { ok: true, locationTitle, width: geometry.width, height: geometry.height };
    } catch (error) {
      stopWindowWatch({ silent: true });
      currentItem = null;
      publishStatus({
        phase: 'error',
        error: 'start-failed',
        windowManaged: false,
        windowWatchActive: false,
        windowLost: false,
      });
      logWarn('[wallpaper-engine] start threw', error && error.message);
      return { ok: false, error: 'start-failed' };
    }
  };

  const dispose = async () => {
    disposed = true;
    stopOrphanWatch();
    stopWindowWatch({ silent: true });
    clearMuteTimers();
    if (status.locationTitle) {
      const result = await spawnControl(['-control', 'closeWallpaper', '-location', status.locationTitle], CONTROL_TIMEOUT_MS);
      if (!result.ok) hideWindowSafe(status.locationTitle);
    }
    publishStatus({
      phase: 'idle',
      locationTitle: '',
      itemId: '',
      title: '',
      muted: false,
      windowManaged: false,
      windowWatchActive: false,
      windowLost: false,
    });
  };

  return {
    dispose,
    ensureControlReady,
    getStatus: () => ({ ...status }),
    resolveExecutable,
    start,
    stop,
  };
}

module.exports = {
  CONTROL_PROBE_ARGS,
  ENGINE_BOOT_TIMEOUT_MS,
  ENGINE_READY_CACHE_MS,
  ENGINE_READY_SUCCESS_COUNT,
  ENGINE_SIGNER_PATTERN,
  INITIAL_MUTE_RETRY_DELAYS_MS,
  MUTE_REASSERT_DELAYS_MS,
  MUTE_SCHEDULE_MS,
  ORPHAN_WATCH_INTERVAL_MS,
  SIGNATURE_SCRIPT,
  WALLPAPER_ENGINE_EXECUTABLES,
  WALLPAPER_ENGINE_LOCATION_PREFIX,
  WINDOW_LOST_GRACE_MS,
  WINDOW_WATCH_INTERVAL_MS,
  buildApplyPropertiesArgs,
  buildLocationTitle,
  buildOpenWallpaperArgs,
  buildVerbatimControlInvocation,
  clampPlaybackSize,
  createWallpaperEngineRuntime,
  findExecutableCandidates,
  quoteWindowsArgument,
  sanitizeMuteProperties,
};
