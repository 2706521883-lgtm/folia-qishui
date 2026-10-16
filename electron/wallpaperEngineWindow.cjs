// electron/wallpaperEngineWindow.cjs
// One-shot PowerShell bridge that locates the Wallpaper Engine playback window by its unique
// title, refuses to touch any window that does not belong to wallpaper64/wallpaper32.exe, and
// parks it on the virtual-desktop bottom-right corner (≤1px visible) so the renderer can capture
// it without it overlapping the user's screen.
//
// The park technique (SetWindowPos with SWP_NOZORDER|SWP_NOACTIVATE|SWP_NOOWNERZORDER|
// SWP_NOSENDCHANGING onto the virtual-screen corner) is ported from Mineradio (GPL-3.0-only)
// desktop/wallpaper-engine-runtime.js, revision d43de565acabfdc1a9c9820a27e81a98ccbebcef.
// This file is distributed with Folia under AGPL-3.0.

const WALLPAPER_ENGINE_PROCESS_NAMES = ['wallpaper64', 'wallpaper32'];
const PARK_TOLERANCE_PX = 2;
// Wallpaper Engine creates the popout window asynchronously, so the first look usually misses it.
const WINDOW_WAIT_DEFAULT_MS = 8000;
const WINDOW_WAIT_POLL_MS = 250;

// Window is never activated, never re-ordered and never receives WM_WINDOWPOSCHANGING — the parked
// window must stay invisible and out of the Z order. It keeps its size because the call passes the
// size it already has: omitting the size without SWP_NOSIZE would shrink the window to 0×0 and the
// capture would then only ever see an empty frame.
const SWP_FLAGS = 0x0004 | 0x0010 | 0x0200 | 0x0400;

const WINDOW_HELPER_SCRIPT = `
$ErrorActionPreference = 'Stop'
$allowed = @('${WALLPAPER_ENGINE_PROCESS_NAMES.join("', '")}')
try {
  Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class FoliaWeWindow {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int GetWindowTextLengthW(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern int GetWindowThreadProcessId(IntPtr hWnd, out int lpdwProcessId);
  [DllImport("user32.dll", SetLastError = true)]
  public static extern int GetSystemMetrics(int nIndex);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  // Exact ordinal title match, unlike FindWindow: the unique session title must never be confused
  // with another window that merely differs in case.
  public static IntPtr FindByExactTitle(string title) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      int length = GetWindowTextLengthW(h);
      if (length <= 0) return true;
      var buffer = new StringBuilder(length + 1);
      if (GetWindowTextW(h, buffer, buffer.Capacity) <= 0) return true;
      if (!string.Equals(buffer.ToString(), title, StringComparison.Ordinal)) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }
}
'@
  # SM_XVIRTUALSCREEN/SM_YVIRTUALSCREEN/SM_CXVIRTUALSCREEN/SM_CYVIRTUALSCREEN are already in
  # physical pixels, which is exactly the coordinate space SetWindowPos expects — computing the
  # corner here keeps a mixed-DPI multi-monitor layout from parking the window on a real screen.
  $targetX = [FoliaWeWindow]::GetSystemMetrics(76) + [FoliaWeWindow]::GetSystemMetrics(78) - 1
  $targetY = [FoliaWeWindow]::GetSystemMetrics(77) + [FoliaWeWindow]::GetSystemMetrics(79) - 1
  $waitMs = ${WINDOW_WAIT_DEFAULT_MS}
  if ($env:FOLIA_WE_WINDOW_WAIT_MS -match '^\d+$') { $waitMs = [int]$env:FOLIA_WE_WINDOW_WAIT_MS }
  $startedAt = Get-Date
  $deadline = $startedAt.AddMilliseconds($waitMs)
  # openWallpaper returns before the popout window exists and the engine needs a moment to load the
  # scene, so the lookup polls until the exact title shows up on a window owned by wallpaper*.exe.
  $hwnd = [IntPtr]::Zero
  $owner = $null
  $foreignProcessName = ''
  while ($hwnd -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) {
    $candidate = [FoliaWeWindow]::FindByExactTitle($env:FOLIA_WE_TITLE)
    if ($candidate -ne [IntPtr]::Zero) {
      $candidateProcessId = 0
      [void][FoliaWeWindow]::GetWindowThreadProcessId($candidate, [ref]$candidateProcessId)
      $candidateOwner = Get-Process -Id $candidateProcessId -ErrorAction SilentlyContinue
      if (-not $candidateOwner) {
        $foreignProcessName = 'gone'
      } elseif ($allowed -contains $candidateOwner.ProcessName.ToLowerInvariant()) {
        $hwnd = $candidate
        $owner = $candidateOwner
      } else {
        $foreignProcessName = $candidateOwner.ProcessName
      }
    }
    if ($hwnd -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds ${WINDOW_WAIT_POLL_MS} }
  }
  $waitedMs = [int]((Get-Date) - $startedAt).TotalMilliseconds
  if ($hwnd -eq [IntPtr]::Zero) {
    if ($foreignProcessName) {
      Write-Output (@{ ok = $false; reason = 'foreign-process'; processName = $foreignProcessName; waitedMs = $waitedMs } | ConvertTo-Json -Compress)
    } else {
      Write-Output (@{ ok = $false; reason = 'not-found'; waitedMs = $waitedMs } | ConvertTo-Json -Compress)
    }
    exit 0
  }
  $rect = [FoliaWeWindow+RECT]::new()
  [void][FoliaWeWindow]::GetWindowRect($hwnd, [ref]$rect)
  $before = @{ x = $rect.Left; y = $rect.Top; width = ($rect.Right - $rect.Left); height = ($rect.Bottom - $rect.Top) }
  $moved = $false
  if ([Math]::Abs($rect.Left - $targetX) -gt ${PARK_TOLERANCE_PX} -or [Math]::Abs($rect.Top - $targetY) -gt ${PARK_TOLERANCE_PX}) {
    $moved = [FoliaWeWindow]::SetWindowPos($hwnd, [IntPtr]::Zero, $targetX, $targetY, $before.width, $before.height, ${SWP_FLAGS})
    Start-Sleep -Milliseconds 60
    [void][FoliaWeWindow]::GetWindowRect($hwnd, [ref]$rect)
  }
  Write-Output (@{
    ok = $true
    hwnd = $hwnd.ToInt64()
    processName = $owner.ProcessName
    moved = [bool]$moved
    waitedMs = $waitedMs
    target = @{ x = $targetX; y = $targetY }
    before = $before
    after = @{ x = $rect.Left; y = $rect.Top; width = ($rect.Right - $rect.Left); height = ($rect.Bottom - $rect.Top) }
  } | ConvertTo-Json -Compress -Depth 4)
} catch {
  Write-Output (@{ ok = $false; reason = 'helper-error'; message = $_.Exception.Message } | ConvertTo-Json -Compress -Depth 4)
}
`;

// PowerShell -EncodedCommand takes UTF-16LE base64: the script never touches command-line quoting,
// so window titles and coordinates cannot break out of the invocation.
const encodePowerShellCommand = (script) => Buffer.from(String(script), 'utf16le').toString('base64');

// The helper prints one JSON object; any surrounding PowerShell noise is ignored so a stray
// Add-Type warning cannot break the caller.
const parseWindowHelperOutput = (stdout) => {
  const lines = String(stdout || '').split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // Not our payload; keep scanning upwards.
    }
  }
  return null;
};

function createWallpaperEngineWindowHelper(options = {}) {
  const {
    spawn,
    logWarn = () => {},
    // Larger than the in-script wait: the helper answers "not-found" itself instead of being killed.
    timeoutMs = WINDOW_WAIT_DEFAULT_MS + 8000,
  } = options;

  // Finds the playback window by title and moves it onto the true virtual-desktop corner when the
  // engine ignored the open-time -x/-y. The returned `target` is authoritative and gets reused for
  // the next openWallpaper, so only the first window pays for the geometry query.
  // Never throws: the caller falls back to the open-time coordinates.
  const parkWindow = ({ title }) => new Promise((resolve) => {
    const env = { ...process.env, FOLIA_WE_TITLE: String(title) };
    let settled = false;
    let child = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { if (child) child.kill(); } catch { /* already gone */ }
      finish({ ok: false, reason: 'helper-timeout' });
    }, timeoutMs);
    try {
      child = spawn('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', encodePowerShellCommand(WINDOW_HELPER_SCRIPT),
      ], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      logWarn('[wallpaper-engine] window helper spawn failed', error && error.message);
      finish({ ok: false, reason: 'helper-spawn-failed' });
      return;
    }
    let stdout = '';
    if (child.stdout) child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    if (child.stderr) child.stderr.on('data', () => { /* helper diagnostics are not surfaced */ });
    child.on('error', (error) => {
      logWarn('[wallpaper-engine] window helper error', error && error.message);
      finish({ ok: false, reason: 'helper-spawn-failed' });
    });
    child.on('close', () => finish(parseWindowHelperOutput(stdout) || { ok: false, reason: 'helper-no-output' }));
  });

  return { parkWindow };
}

module.exports = {
  PARK_TOLERANCE_PX,
  SWP_FLAGS,
  WALLPAPER_ENGINE_PROCESS_NAMES,
  WINDOW_HELPER_SCRIPT,
  WINDOW_WAIT_DEFAULT_MS,
  WINDOW_WAIT_POLL_MS,
  createWallpaperEngineWindowHelper,
  encodePowerShellCommand,
  parseWindowHelperOutput,
};
