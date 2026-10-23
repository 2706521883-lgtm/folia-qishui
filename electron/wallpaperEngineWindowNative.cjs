// electron/wallpaperEngineWindowNative.cjs
// Native (koffi + user32.dll) manager for the Wallpaper Engine "play in window" surface.
//
// The engine creates that window as an ordinary top-level window: it gets a taskbar button, it
// appears in Alt+Tab, and clicking it activates a full-size window that is only parked a few pixels
// inside the primary screen's bottom-right corner. Moving it off-screen is not enough, so this
// module also:
//
//   1. makes it a tool window (WS_EX_TOOLWINDOW) and non-activatable (WS_EX_NOACTIVATE),
//   2. removes the taskbar button that already exists by hiding/showing it once,
//   3. keeps it just inside the primary screen's bottom-right corner and at the bottom of the Z order,
//   4. exposes a cheap monitor() the runtime calls on a timer, so an engine restart, a display
//      change or a window move is repaired before the user can see it.
//
// Koffi is already a production dependency (used by the macOS wallpaper controller), and its
// prebuilt win32-x64 binary is covered by electron-builder's asarUnpack rule. If koffi or user32
// cannot be loaded, the caller falls back to the PowerShell helper in wallpaperEngineWindow.cjs.
//
// The window is still a real Wallpaper Engine window: this module never reparents it (SetParent
// tears it out of the engine's render loop) and never touches the wallpaper project on disk.

const WALLPAPER_ENGINE_PROCESS_NAMES = ['wallpaper64', 'wallpaper32'];
const ENGINE_MAIN_WINDOW_TITLE = 'Wallpaper Engine';

const WS_EX_TOOLWINDOW = 0x00000080;
const WS_EX_APPWINDOW = 0x00040000;
const WS_EX_NOACTIVATE = 0x08000000;

const GWL_EXSTYLE = -20;
const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_NOACTIVATE = 0x0010;
const SWP_FRAMECHANGED = 0x0020;
const SWP_NOOWNERZORDER = 0x0200;
const SWP_NOSENDCHANGING = 0x0400;
const HWND_BOTTOM = 1;

const SW_HIDE = 0;
const SW_SHOWNOACTIVATE = 4;
const SW_RESTORE = 9;

// Primary-screen metrics. The virtual desktop's bottom-right corner can live on a secondary
// monitor that is off/asleep or not composited; DWM then refuses to provide frames and
// desktopCapturer fails with NotReadableError. The primary screen is always composed, so the
// playback window is parked just inside its bottom-right corner instead.
const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
// Leave a few pixels visible so the window is never treated as fully off-screen. The sliver sits
// under the taskbar in the usual layout and is invisible in practice.
const PARK_VISIBLE_INSET_PX = 4;

const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

const WINDOW_WAIT_DEFAULT_MS = 8000;
const WINDOW_WAIT_POLL_MS = 80;
const PARK_TOLERANCE_PX = 2;

// Pure style/geometry helpers are exported so the tests can lock the contract without loading
// user32 or opening a real window.
const computeManagedExStyle = (exStyle) => (
  ((Number(exStyle) | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE) & ~WS_EX_APPWINDOW) >>> 0
);

const hasManagedExStyle = (exStyle) => {
  const value = Number(exStyle) >>> 0;
  return (value & WS_EX_TOOLWINDOW) !== 0
    && (value & WS_EX_NOACTIVATE) !== 0
    && (value & WS_EX_APPWINDOW) === 0;
};

// The park target is a few pixels inside the primary screen's bottom-right corner. Window
// coordinates are relative to the primary monitor, whose origin is always (0, 0). Keeping the
// window on the primary display avoids capturing a window parked on an inactive secondary monitor.
const primaryScreenCorner = ({ width, height }) => ({
  x: Math.max(0, Math.round(Number(width) - PARK_VISIBLE_INSET_PX)),
  y: Math.max(0, Math.round(Number(height) - PARK_VISIBLE_INSET_PX)),
});

const isRectAtTarget = (rect, target, tolerance = PARK_TOLERANCE_PX) => {
  if (!rect || !target) return false;
  return Math.abs(rect.left - target.x) <= tolerance
    && Math.abs(rect.top - target.y) <= tolerance;
};

const rectWidth = (rect) => Math.max(1, Number(rect.right) - Number(rect.left));
const rectHeight = (rect) => Math.max(1, Number(rect.bottom) - Number(rect.top));

let nativeApi = null;

const loadNativeApi = () => {
  if (nativeApi) return nativeApi;
  if (process.platform !== 'win32') {
    throw new Error('not-win32');
  }
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const kernel32 = koffi.load('kernel32.dll');

  // The struct must be declared before the function signature that mentions it. Guard against a
  // retry after a partially-failed initialization (koffi keeps type names process-wide).
  try {
    koffi.struct('FOLIA_WE_RECT', {
      left: 'int',
      top: 'int',
      right: 'int',
      bottom: 'int',
    });
  } catch {
    // Already declared by a previous attempt.
  }

  const EnumWindowsProc = koffi.proto('bool __stdcall FOLIA_WE_ENUM_PROC(void *hwnd, intptr_t lparam)');
  const EnumWindows = user32.func('bool __stdcall EnumWindows(FOLIA_WE_ENUM_PROC *cb, intptr_t lparam)');
  const GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(void *hwnd)');
  const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(void *hwnd, void *buf, int max)');
  const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void *hwnd, _Out_ uint32 *pid)');
  const GetWindowLongPtrW = user32.func('intptr_t __stdcall GetWindowLongPtrW(void *hwnd, int index)');
  const SetWindowLongPtrW = user32.func('intptr_t __stdcall SetWindowLongPtrW(void *hwnd, int index, intptr_t value)');
  const SetWindowPos = user32.func('bool __stdcall SetWindowPos(void *hwnd, void *after, int x, int y, int cx, int cy, uint32 flags)');
  const GetWindowRect = user32.func('bool __stdcall GetWindowRect(void *hwnd, _Out_ FOLIA_WE_RECT *rect)');
  const ShowWindow = user32.func('bool __stdcall ShowWindow(void *hwnd, int cmd)');
  const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(void *hwnd)');
  const IsIconic = user32.func('bool __stdcall IsIconic(void *hwnd)');
  const GetForegroundWindow = user32.func('void * __stdcall GetForegroundWindow()');
  const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int index)');

  const OpenProcess = kernel32.func('void * __stdcall OpenProcess(uint32 access, bool inherit, uint32 pid)');
  const QueryFullProcessImageNameW = kernel32.func('bool __stdcall QueryFullProcessImageNameW(void *handle, uint32 flags, void *buf, _Inout_ uint32 *size)');
  const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *handle)');

  const windowTitle = (hwnd) => {
    const length = GetWindowTextLengthW(hwnd);
    if (length <= 0) return '';
    const buffer = Buffer.alloc((length + 1) * 2);
    const copied = GetWindowTextW(hwnd, buffer, length + 1);
    return buffer.toString('utf16le', 0, Math.max(0, copied) * 2);
  };

  const windowProcessId = (hwnd) => {
    const pid = [0];
    GetWindowThreadProcessId(hwnd, pid);
    return pid[0] >>> 0;
  };

  const processImagePath = (pid) => {
    let handle = null;
    try {
      handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
      if (!handle) return '';
      const size = [1024];
      const buffer = Buffer.alloc(size[0] * 2);
      if (!QueryFullProcessImageNameW(handle, 0, buffer, size)) return '';
      return buffer.toString('utf16le', 0, Math.max(0, size[0]) * 2);
    } catch {
      return '';
    } finally {
      if (handle) {
        try { CloseHandle(handle); } catch { /* already gone */ }
      }
    }
  };

  const processBaseName = (imagePath) => {
    const text = String(imagePath || '');
    const index = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'));
    return (index >= 0 ? text.slice(index + 1) : text).toLowerCase();
  };

  const processNameForPid = (pid) => processBaseName(processImagePath(pid));

  const isEngineProcess = (pid) => {
    // QueryFullProcessImageNameW reports "wallpaper64.exe"; the shared name list is extension-less
    // to match PowerShell's Get-Process.ProcessName and the user-facing logs.
    const base = processBaseName(processImagePath(pid)).replace(/\.exe$/, '');
    return WALLPAPER_ENGINE_PROCESS_NAMES.includes(base);
  };

  const getExStyle = (hwnd) => Number(GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) >>> 0;

  const getRect = (hwnd) => {
    const rect = {};
    GetWindowRect(hwnd, rect);
    return {
      left: Number(rect.left) || 0,
      top: Number(rect.top) || 0,
      right: Number(rect.right) || 0,
      bottom: Number(rect.bottom) || 0,
    };
  };

  const currentParkTarget = () => primaryScreenCorner({
    width: GetSystemMetrics(SM_CXSCREEN),
    height: GetSystemMetrics(SM_CYSCREEN),
  });

  const enumerateWindows = () => {
    const entries = [];
    EnumWindows((hwnd) => {
      const title = windowTitle(hwnd);
      if (!title) return true;
      entries.push({
        hwnd,
        title,
        pid: windowProcessId(hwnd),
        style: getExStyle(hwnd),
        rect: getRect(hwnd),
        visible: Boolean(IsWindowVisible(hwnd)),
      });
      return true;
    }, 0);
    return entries;
  };

  const findExactTitle = (title) => {
    let found = null;
    EnumWindows((hwnd) => {
      if (windowTitle(hwnd) === title) {
        found = {
          hwnd,
          title,
          pid: windowProcessId(hwnd),
          style: getExStyle(hwnd),
          rect: getRect(hwnd),
          visible: Boolean(IsWindowVisible(hwnd)),
        };
        return false;
      }
      return true;
    }, 0);
    return found;
  };

  const pushToBottom = (hwnd) => SetWindowPos(
    hwnd,
    HWND_BOTTOM,
    0,
    0,
    0,
    0,
    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
  );

  const moveToParkTarget = (hwnd, target, size = null) => {
    const before = getRect(hwnd);
    const width = size && Number(size.width) > 0 ? Math.round(Number(size.width)) : rectWidth(before);
    const height = size && Number(size.height) > 0 ? Math.round(Number(size.height)) : rectHeight(before);
    if (isRectAtTarget(before, target) && width === rectWidth(before) && height === rectHeight(before)) {
      return { moved: false, before, after: before };
    }
    SetWindowPos(
      hwnd,
      HWND_BOTTOM,
      target.x,
      target.y,
      width,
      height,
      SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOSENDCHANGING,
    );
    return { moved: true, before, after: getRect(hwnd) };
  };

  // Setting WS_EX_TOOLWINDOW on an already-created window does not necessarily remove the taskbar
  // button that the shell has already registered. A single hide/show cycle (before the renderer
  // starts capturing) makes the shell rebuild the button set; the window is then put back with
  // SW_SHOWNOACTIVATE so it never steals focus.
  const applyManagedStyle = (hwnd, { hideShow = true } = {}) => {
    const previous = getExStyle(hwnd);
    const next = computeManagedExStyle(previous);
    if (next === previous && hasManagedExStyle(previous)) {
      return { changed: false, previous, next };
    }
    SetWindowLongPtrW(hwnd, GWL_EXSTYLE, next);
    // The hide/show cycle is what makes the shell drop an already-registered taskbar button. It
    // must only run for a newly created window or during the initial park: doing it while the
    // renderer is capturing the same window can make getUserMedia fail with NotReadableError.
    if (hideShow) {
      ShowWindow(hwnd, SW_HIDE);
      ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
    SetWindowPos(
      hwnd,
      null,
      0,
      0,
      0,
      0,
      SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
    );
    return { changed: true, previous, next: getExStyle(hwnd), hideShow };
  };

  nativeApi = {
    koffi,
    user32,
    kernel32,
    EnumWindows,
    windowTitle,
    windowProcessId,
    processImagePath,
    processBaseName,
    processNameForPid,
    isEngineProcess,
    getExStyle,
    getRect,
    currentParkTarget,
    ShowWindow,
    IsIconic,
    GetForegroundWindow,
    enumerateWindows,
    findExactTitle,
    pushToBottom,
    moveToParkTarget,
    applyManagedStyle,
  };
  return nativeApi;
};

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function createWallpaperEngineNativeWindow(options = {}) {
  const {
    log = () => {},
    logWarn = () => {},
    waitMs = WINDOW_WAIT_DEFAULT_MS,
    pollMs = WINDOW_WAIT_POLL_MS,
  } = options;

  let api;
  try {
    api = loadNativeApi();
  } catch (error) {
    return {
      available: false,
      backend: 'native',
      reason: error && error.message ? error.message : 'native-load-failed',
    };
  }
  // The engine picks the playback size (it clamps/ignores the requested geometry). Remember the
  // size it actually used so a later display change or external resize cannot silently downgrade
  // the capture, while a recreated window (new title) starts from its own measured size.
  let lastParkedSize = null;
  // The handle whose taskbar button has already been removed. A different handle means the engine
  // re-created the window, so the hide/show cycle is needed again; the same handle only needs the
  // style bits re-applied, which must not interrupt a live capture.
  let lastManagedHwnd = '';

  const verifyEngineWindow = (entry) => {
    if (!entry) return { ok: false, reason: 'not-found' };
    if (!entry.processName) {
      entry.processName = api.processNameForPid(entry.pid);
    }
    if (!entry.engineProcess) {
      entry.engineProcess = api.isEngineProcess(entry.pid);
    }
    if (!entry.engineProcess) {
      return { ok: false, reason: 'foreign-process', processName: entry.processName || 'unknown' };
    }
    return { ok: true, processName: entry.processName || 'wallpaper64' };
  };

  const decorate = (entry) => {
    const verification = verifyEngineWindow(entry);
    return {
      hwnd: String(entry.hwnd),
      title: entry.title,
      pid: entry.pid,
      processName: verification.processName || api.processNameForPid(entry.pid),
      style: entry.style,
      rect: entry.rect,
      visible: entry.visible,
      engineProcess: verification.ok,
      verification,
    };
  };

  // Waits for the exact-title window, verifies its owner and returns the first usable entry.
  const waitForEngineWindow = async (title, requestedWaitMs = waitMs) => {
    const deadline = Date.now() + Math.max(0, Number(requestedWaitMs) || waitMs);
    let foreignProcessName = '';
    for (;;) {
      const entry = api.findExactTitle(title);
      if (entry) {
        const verification = verifyEngineWindow(entry);
        if (verification.ok) return { ok: true, entry, waited: false };
        foreignProcessName = verification.processName || '';
      }
      if (Date.now() >= deadline) break;
      await delay(pollMs);
    }
    return { ok: false, reason: foreignProcessName ? 'foreign-process' : 'not-found', processName: foreignProcessName };
  };

  const parkWindow = async ({ title, waitMs: requestedWaitMs } = {}) => {
    const startedAt = Date.now();
    const found = await waitForEngineWindow(String(title || ''), requestedWaitMs);
    if (!found.ok) {
      return {
        ok: false,
        reason: found.reason,
        processName: found.processName || '',
        waitedMs: Date.now() - startedAt,
      };
    }
    const entry = found.entry;
    const target = api.currentParkTarget();
    const style = api.applyManagedStyle(entry.hwnd);
    lastManagedHwnd = String(entry.hwnd);
    const measured = api.getRect(entry.hwnd);
    lastParkedSize = {
      width: rectWidth(measured),
      height: rectHeight(measured),
    };
    const parked = api.moveToParkTarget(entry.hwnd, target, lastParkedSize);
    api.pushToBottom(entry.hwnd);
    const after = api.getRect(entry.hwnd);
    log('[wallpaper-engine] native park', JSON.stringify({
      title: entry.title,
      hwnd: String(entry.hwnd),
      processName: api.processNameForPid(entry.pid),
      styleChanged: style.changed,
      moved: parked.moved,
      target,
      before: parked.before,
      after,
    }));
    return {
      ok: true,
      hwnd: String(entry.hwnd),
      processName: api.processNameForPid(entry.pid),
      moved: parked.moved,
      styleApplied: style.changed,
      target,
      before: parked.before,
      after,
      waitedMs: Date.now() - startedAt,
    };
  };

  const monitorWindow = ({ title } = {}) => {
    const expectedTitle = String(title || '');
    if (!expectedTitle) return { ok: false, reason: 'no-title' };
    const entry = api.findExactTitle(expectedTitle);
    if (!entry) return { ok: false, reason: 'not-found' };
    const verification = verifyEngineWindow(entry);
    if (!verification.ok) {
      return { ok: false, reason: verification.reason, processName: verification.processName || '' };
    }

    const sameWindow = lastManagedHwnd === String(entry.hwnd);
    let restoredVisible = false;
    if (api.IsIconic(entry.hwnd)) {
      // A minimized window is still IsWindowVisible=true, but Chromium cannot capture it.
      api.ShowWindow(entry.hwnd, SW_RESTORE);
      restoredVisible = true;
    } else if (!entry.visible) {
      api.ShowWindow(entry.hwnd, SW_SHOWNOACTIVATE);
      restoredVisible = true;
    }

    const target = api.currentParkTarget();
    const style = api.applyManagedStyle(entry.hwnd, { hideShow: !sameWindow });
    lastManagedHwnd = String(entry.hwnd);
    const parked = api.moveToParkTarget(entry.hwnd, target, lastParkedSize);
    const foreground = String(api.GetForegroundWindow()) === String(entry.hwnd);
    if (foreground) api.pushToBottom(entry.hwnd);
    const after = api.getRect(entry.hwnd);
    return {
      ok: true,
      hwnd: String(entry.hwnd),
      processName: verification.processName,
      styleApplied: style.changed,
      restoredVisible,
      moved: parked.moved,
      foreground,
      target,
      before: parked.before,
      after,
    };
  };

  const listSessionWindows = ({ prefix } = {}) => {
    const titlePrefix = String(prefix || '');
    if (!titlePrefix) return [];
    return api.enumerateWindows()
      .filter((entry) => entry.title.startsWith(titlePrefix))
      .map((entry) => {
        const decorated = decorate(entry);
        return decorated.engineProcess ? decorated : null;
      })
      .filter(Boolean);
  };

  const hideWindow = ({ title } = {}) => {
    const entry = api.findExactTitle(String(title || ''));
    if (!entry) return { ok: false, reason: 'not-found' };
    const verification = verifyEngineWindow(entry);
    if (!verification.ok) return { ok: false, reason: verification.reason };
    api.applyManagedStyle(entry.hwnd);
    api.moveToParkTarget(entry.hwnd, api.currentParkTarget());
    api.ShowWindow(entry.hwnd, SW_HIDE);
    return { ok: true, hwnd: String(entry.hwnd), processName: verification.processName };
  };

  const neutraliseWindow = ({ title } = {}) => {
    const entry = api.findExactTitle(String(title || ''));
    if (!entry) return { ok: false, reason: 'not-found' };
    const verification = verifyEngineWindow(entry);
    if (!verification.ok) return { ok: false, reason: verification.reason };
    api.applyManagedStyle(entry.hwnd);
    const target = api.currentParkTarget();
    api.moveToParkTarget(entry.hwnd, target, lastParkedSize);
    api.pushToBottom(entry.hwnd);
    return { ok: true, hwnd: String(entry.hwnd), processName: verification.processName };
  };

  const hideEngineMainWindow = () => {
    const candidates = api.enumerateWindows().filter((entry) => (
      entry.title === ENGINE_MAIN_WINDOW_TITLE && api.isEngineProcess(entry.pid)
    ));
    if (!candidates.length) return { ok: false, reason: 'not-found' };
    const entry = candidates[0];
    api.ShowWindow(entry.hwnd, SW_HIDE);
    log('[wallpaper-engine] hid engine main window', String(entry.hwnd));
    return { ok: true, hwnd: String(entry.hwnd) };
  };

  const getWindowInfo = ({ title } = {}) => {
    const entry = api.findExactTitle(String(title || ''));
    if (!entry) return { ok: false, reason: 'not-found' };
    return { ok: true, ...decorate(entry) };
  };

  return {
    available: true,
    backend: 'native',
    parkWindow,
    monitorWindow,
    listSessionWindows,
    hideWindow,
    neutraliseWindow,
    hideEngineMainWindow,
    getWindowInfo,
    dispose: () => {},
  };
}

module.exports = {
  ENGINE_MAIN_WINDOW_TITLE,
  GWL_EXSTYLE,
  HWND_BOTTOM,
  PARK_TOLERANCE_PX,
  PARK_VISIBLE_INSET_PX,
  SWP_FLAGS: SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_NOSENDCHANGING | SWP_NOZORDER,
  WALLPAPER_ENGINE_PROCESS_NAMES,
  WINDOW_WAIT_DEFAULT_MS,
  WINDOW_WAIT_POLL_MS,
  WS_EX_APPWINDOW,
  WS_EX_NOACTIVATE,
  WS_EX_TOOLWINDOW,
  computeManagedExStyle,
  createWallpaperEngineNativeWindow,
  hasManagedExStyle,
  isRectAtTarget,
  rectHeight,
  rectWidth,
  primaryScreenCorner,
};
