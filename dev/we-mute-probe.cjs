// dev/we-mute-probe.cjs
// Focused live probe for the `-control applyProperties` invocation, run under Electron:
//
//   npx electron dev/we-mute-probe.cjs
//
// It opens one parked playback window of the user's own library, then tries the same RAW payload
// through the plain execFile encoding and through the verbatim command line, and closes the window
// again. Only that window's location is addressed, so the user's desktop wallpaper and its saved
// properties are never touched.

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { app, screen } = require('electron');

const { createWallpaperEngineLibrary } = require('../electron/wallpaperEngineLibrary.cjs');
const {
    createWallpaperEngineRuntime,
    buildApplyPropertiesArgs,
    buildVerbatimControlInvocation,
} = require('../electron/wallpaperEngineRuntime.cjs');
const { createWallpaperEngineWindowHelper } = require('../electron/wallpaperEngineWindow.cjs');

const run = (file, args, options) => new Promise((resolve) => {
    execFile(file, args, {
        timeout: 8000,
        windowsHide: true,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
        ...options,
    }, (error, stdout, stderr) => resolve({
        code: error ? (error.code !== undefined ? error.code : -1) : 0,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
    }));
});

let runtime = null;

(async () => {
    await app.whenReady();

    const library = createWallpaperEngineLibrary({ fs, path, execFile, logWarn: () => {} });
    const scan = await library.scan();
    const item = scan.items.filter((entry) => entry.enginePlayable && entry.audioPropertyCount > 0)[0]
        || scan.items.filter((entry) => entry.enginePlayable)[0];
    console.log('[mute] item:', item.title, '| mute patch:', JSON.stringify(item.muteProperties));

    runtime = createWallpaperEngineRuntime({
        fs,
        path,
        execFile,
        spawn,
        log: (...args) => console.log('[mute:runtime]', ...args),
        logWarn: (...args) => console.warn('[mute:runtime]', ...args),
        windowHelper: createWallpaperEngineWindowHelper({ spawn, logWarn: (...args) => console.warn('[mute:window]', ...args) }),
        getVirtualDesktopBounds: () => {
            const displays = screen.getAllDisplays();
            const left = Math.min(...displays.map((display) => display.bounds.x));
            const top = Math.min(...displays.map((display) => display.bounds.y));
            const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width));
            const bottom = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height));
            return { x: left, y: top, width: right - left, height: bottom - top };
        },
        emitStatus: (status) => console.log('[mute] status', status.phase, '| muted:', status.muted, '| park', status.parkX, status.parkY),
    });

    const started = await runtime.start({ item, muteAudio: false });
    console.log('[mute] start:', JSON.stringify(started));
    if (!started.ok) throw new Error('start failed: ' + started.error);

    const title = runtime.getStatus().locationTitle;
    const executable = await runtime.resolveExecutable();
    const args = buildApplyPropertiesArgs({ locationTitle: title, properties: item.muteProperties });
    const payload = args[args.indexOf('-properties') + 1];
    console.log('[mute] payload:', payload);

    console.log('[mute] plain execFile     :', JSON.stringify(await run(executable, args)));
    console.log('[mute] volume only plain  :', JSON.stringify(await run(executable, buildApplyPropertiesArgs({ locationTitle: title, properties: { volume: 0 } }))));

    const verbatim = buildVerbatimControlInvocation(executable, args);
    console.log('[mute] verbatim args      :', JSON.stringify(verbatim && verbatim.args));
    console.log('[mute] verbatim full path :', JSON.stringify(await run(verbatim.file, verbatim.args, {
        cwd: verbatim.cwd,
        windowsVerbatimArguments: true,
        shell: false,
    })));
    console.log('[mute] verbatim basename  :', JSON.stringify(await run(path.basename(executable), verbatim.args, {
        cwd: verbatim.cwd,
        windowsVerbatimArguments: true,
        shell: false,
    })));

    // Reference route: one command line handed to cmd.exe with /s /c so the payload keeps its quotes.
    const commandLine = `"${executable}" ${verbatim.args.join(' ')}`;
    console.log('[mute] via cmd.exe /s /c  :', JSON.stringify(await run(process.env.ComSpec || 'cmd.exe', [
        '/d', '/s', '/c', `"${commandLine}"`,
    ], { windowsVerbatimArguments: true })));

    await runtime.stop({ reason: 'mute-probe' });
    await runtime.dispose();
    app.exit(0);
})().catch(async (error) => {
    console.warn('[mute] failed:', error && error.stack ? error.stack : error);
    try { if (runtime) { await runtime.stop({ reason: 'mute-probe-error' }); await runtime.dispose(); } } catch { /* best effort */ }
    app.exit(1);
});
