// dev/we-diag.cjs
// Live diagnosis for the two things the first E2E run got wrong (run under Electron):
//
//   npx electron dev/we-diag.cjs
//
// 1. The window helper could not find the parked window (`not-found`) even though the capture
//    source lookup did. This enumerates the real window list next to a FindWindow probe.
// 2. `applyProperties` exits 4 with the plain execFile argument encoding. This compares the plain
//    invocation with the verbatim command line the reference implementation uses for RAW payloads.
//
// It opens one parked playback window and closes it again on the way out.

const fs = require('fs');
const path = require('path');
const { execFile, spawn, execFileSync } = require('child_process');
const { app, desktopCapturer, screen } = require('electron');

const { createWallpaperEngineLibrary } = require('../electron/wallpaperEngineLibrary.cjs');
const { createWallpaperEngineRuntime, buildApplyPropertiesArgs } = require('../electron/wallpaperEngineRuntime.cjs');
const { encodePowerShellCommand } = require('../electron/wallpaperEngineWindow.cjs');

const quoteWindowsArgument = (value) => {
    const text = String(value == null ? '' : value);
    if (text && !/[\s"]/.test(text)) return text;
    return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
};

const WINDOW_DIAG_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class FoliaWeDiag {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowTextLengthW(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassNameW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr FindWindowW(string cls, string title);
  [DllImport("user32.dll", CharSet=CharSet.Ansi)] static extern IntPtr FindWindowA(string cls, string title);
  public static object[] List(string needle) {
    var found = new List<object>();
    EnumWindows((h, l) => {
      int len = GetWindowTextLengthW(h);
      if (len <= 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowTextW(h, sb, sb.Capacity);
      string title = sb.ToString();
      if (!title.Contains(needle)) return true;
      var cls = new StringBuilder(256);
      GetClassNameW(h, cls, cls.Capacity);
      uint pid; GetWindowThreadProcessId(h, out pid);
      RECT r; bool hasRect = GetWindowRect(h, out r);
      found.Add(new { hwnd = h.ToInt64(), title = title, cls = cls.ToString(), pid = pid,
        visible = IsWindowVisible(h),
        rect = hasRect ? new { left = r.Left, top = r.Top, right = r.Right, bottom = r.Bottom } : null });
      return true;
    }, IntPtr.Zero);
    return found.ToArray();
  }
  public static object[] Probe(string title) {
    var result = new List<object>();
    IntPtr wide = FindWindowW(null, title);
    IntPtr ansi = FindWindowA(null, title);
    result.Add(new { api = "FindWindowW", hwnd = wide.ToInt64(), ok = wide != IntPtr.Zero });
    result.Add(new { api = "FindWindowA", hwnd = ansi.ToInt64(), ok = ansi != IntPtr.Zero });
    return result.ToArray();
  }
}
'@
$title = $env:FOLIA_WE_TITLE
$found = @([FoliaWeDiag]::List('Folia Wallpaper'))
$probe = @([FoliaWeDiag]::Probe($title))
Write-Output (@{
  exactTitle = $title
  matchCount = $found.Count
  windows = $found
  findWindow = $probe
} | ConvertTo-Json -Depth 6 -Compress)
`.trim();

const runPowerShell = (script, env = {}) => new Promise((resolve) => {
    execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encodePowerShellCommand(script),
    ], {
        windowsHide: true,
        timeout: 25000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ...env },
    }, (error, stdout, stderr) => resolve({
        ok: !error,
        code: error && typeof error.code === 'number' ? error.code : (error ? -1 : 0),
        stderr: String(stderr || '').trim(),
        stdout: String(stdout || '').trim(),
    }));
});

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

let runtime = null;

(async () => {
    await app.whenReady();

    const library = createWallpaperEngineLibrary({ fs, path, execFile, logWarn: () => {} });
    const scan = await library.scan();
    const item = scan.items.filter((entry) => entry.enginePlayable && entry.audioPropertyCount > 0)[0]
        || scan.items.filter((entry) => entry.enginePlayable)[0];

    runtime = createWallpaperEngineRuntime({
        fs,
        path,
        execFile,
        spawn,
        log: () => {},
        logWarn: (...args) => console.warn('[diag:runtime]', ...args),
        windowHelper: null,
        getVirtualDesktopBounds: () => {
            const displays = screen.getAllDisplays();
            const left = Math.min(...displays.map((d) => d.bounds.x));
            const top = Math.min(...displays.map((d) => d.bounds.y));
            const right = Math.max(...displays.map((d) => d.bounds.x + d.bounds.width));
            const bottom = Math.max(...displays.map((d) => d.bounds.y + d.bounds.height));
            return { x: left, y: top, width: right - left, height: bottom - top };
        },
        emitStatus: () => {},
    });

    const started = await runtime.start({ item, muteAudio: false });
    console.log('[diag] start:', JSON.stringify(started));
    if (!started.ok) throw new Error('start failed');
    const title = runtime.getStatus().locationTitle;

    // 1) Window identity: does the title exist, and can FindWindow see it?
    for (const wait of [0, 900, 2600]) {
        if (wait) await delay(wait);
        const result = await runPowerShell(WINDOW_DIAG_SCRIPT, { FOLIA_WE_TITLE: title });
        if (!result.ok) { console.log('[diag] window probe failed', result.code, result.stderr.slice(0, 300)); continue; }
        let parsed = null;
        for (const line of result.stdout.split(/\r?\n/).reverse()) {
            try { parsed = JSON.parse(line); break; } catch { /* keep scanning */ }
        }
        console.log('[diag] t+' + wait + 'ms window list:', JSON.stringify(parsed));
    }

    const executable = await runtime.resolveExecutable();
    const exeDir = path.dirname(executable);
    const payload = buildApplyPropertiesArgs({ locationTitle: title, properties: item.muteProperties });
    const raw = payload[payload.indexOf('-properties') + 1];

    // 2) applyProperties: plain encoding vs the verbatim command line.
    const plain = await new Promise((resolve) => execFile(executable, payload, {
        windowsHide: true, timeout: 8000, encoding: 'utf8',
    }, (error, stdout, stderr) => resolve({
        code: error ? (error.code || -1) : 0, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim(),
    })));
    console.log('[diag] applyProperties plain    :', JSON.stringify(plain));

    const verbatimArgs = payload.map((value) => (value === raw ? String(value) : quoteWindowsArgument(value)));
    const verbatim = await new Promise((resolve) => execFile(path.basename(executable), verbatimArgs, {
        cwd: exeDir, windowsHide: true, timeout: 8000, encoding: 'utf8',
        windowsVerbatimArguments: true, shell: false,
    }, (error, stdout, stderr) => resolve({
        code: error ? (error.code || -1) : 0, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim(),
    })));
    console.log('[diag] applyProperties verbatim :', JSON.stringify(verbatim));

    // 3) Does the quoted-everything form of the verbatim line also work? (isolates quoting from cwd)
    const syncVerbatim = (() => {
        try {
            execFileSync(path.basename(executable), verbatimArgs, {
                cwd: exeDir, windowsHide: true, timeout: 8000, encoding: 'utf8',
                windowsVerbatimArguments: true, shell: false,
            });
            return { code: 0 };
        } catch (error) {
            return { code: error.status, stderr: String(error.stderr || '').trim() };
        }
    })();
    console.log('[diag] applyProperties sync     :', JSON.stringify(syncVerbatim));

    // 4) Re-open probe: did the property command mute anything the engine can report?
    const capture = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
    console.log('[diag] capture source present  :', capture.some((source) => source.name === title));

    await runtime.stop({ reason: 'diag' });
    await runtime.dispose();
    app.exit(0);
})().catch(async (error) => {
    console.warn('[diag] failed:', error && error.stack ? error.stack : error);
    try { if (runtime) { await runtime.stop({ reason: 'diag-error' }); await runtime.dispose(); } } catch { /* best effort */ }
    app.exit(1);
});
