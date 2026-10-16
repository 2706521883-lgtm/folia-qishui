// dev/we-control-probe.cjs
// Read-only probe of the Wallpaper Engine control channel: resolves wallpaper64.exe the same way
// the runtime does, then runs `-control getWallpaper -monitor 0` and prints the raw result.
// It opens no wallpaper window and applies no properties, so it changes nothing on screen.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const { findExecutableCandidates } = require('../electron/wallpaperEngineRuntime.cjs');

const run = (file, args, timeout) => new Promise((resolve) => {
    execFile(file, args, { timeout, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        resolve({
            code: error ? (error.code ?? -1) : 0,
            killed: Boolean(error && error.killed),
            stdout: String(stdout || '').trim(),
            stderr: String(stderr || '').trim(),
        });
    });
});

(async () => {
    const candidates = await findExecutableCandidates({ fsp: fs.promises, path, execFile });
    console.log('exe candidates  :', candidates.length ? candidates : '(none)');

    const signature = await run('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `$s = Get-AuthenticodeSignature -FilePath '${candidates[0] || ''}'; "$($s.Status) | $($s.SignerCertificate.Subject)"`,
    ], 20000);
    console.log('signature       :', signature.stdout || signature.stderr);

    const probe = await run(candidates[0], ['-control', 'getWallpaper', '-monitor', '0'], 8000);
    console.log('probe exit      :', probe.code, probe.killed ? '(killed/timeout)' : '');
    console.log('probe stdout    :', JSON.stringify(probe.stdout));
    console.log('probe stderr    :', JSON.stringify(probe.stderr));
})().catch(error => {
    console.error('probe failed:', error);
    process.exitCode = 1;
});
