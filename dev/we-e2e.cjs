// dev/we-e2e.cjs
// Light end-to-end check of the Wallpaper Engine background, run under Electron:
//
//   npx electron dev/we-e2e.cjs
//
// It drives the real engine through the real modules (scan → start → park → mute → capture) and
// closes the playback window again on the way out, including on failure. The desktop wallpaper
// itself is never touched: the session gets its own window and its own mute properties, and the
// window is parked on the virtual-screen corner where at most one pixel is on screen.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, spawn } = require('child_process');
const { app, BrowserWindow, desktopCapturer, screen } = require('electron');

const { createWallpaperEngineLibrary } = require('../electron/wallpaperEngineLibrary.cjs');
const { createWallpaperEngineRuntime } = require('../electron/wallpaperEngineRuntime.cjs');
const { createWallpaperEngineWindowHelper } = require('../electron/wallpaperEngineWindow.cjs');

const HARD_TIMEOUT_MS = 75000;
const SOURCE_WAIT_MS = 9000;

const log = (...args) => console.log('[e2e]', ...args);
const warn = (...args) => console.warn('[e2e]', ...args);

// The renderer-side half of the check, executed inside a hidden BrowserWindow loaded from file://
// (a secure context, so navigator.mediaDevices exists) with the source id the main process found.
const buildCaptureProbe = (sourceId) => `(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: ${JSON.stringify(sourceId)}, minFrameRate: 10, maxFrameRate: 30 } },
    });
    const track = stream.getVideoTracks()[0];
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    document.body.appendChild(video);
    await video.play().catch(() => undefined);
    const first = video.currentTime;
    await new Promise(resolve => setTimeout(resolve, 1500));
    const advanced = video.currentTime - first;
    const result = {
        hasTrack: Boolean(track),
        width: video.videoWidth,
        height: video.videoHeight,
        advanced,
    };
    track.stop();
    return result;
})()`;

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

let runtime = null;
let browserWindow = null;
let stopping = false;

const teardown = async () => {
    if (stopping) return;
    stopping = true;
    try {
        if (runtime) {
            const status = runtime.getStatus();
            if (status.locationTitle) {
                log('closing playback window', status.locationTitle);
                await runtime.stop({ reason: 'e2e-teardown' });
            }
            await runtime.dispose();
        }
    } catch (error) {
        warn('teardown failed', error && error.message);
    }
    try {
        if (browserWindow && !browserWindow.isDestroyed()) browserWindow.destroy();
    } catch { /* already gone */ }
};

const waitForCaptureSource = async (title) => {
    const deadline = Date.now() + SOURCE_WAIT_MS;
    let attempts = 0;
    for (;;) {
        attempts += 1;
        const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
        const match = sources.find((source) => source.name === title);
        if (match) return { match, attempts, total: sources.length };
        if (Date.now() >= deadline) return { match: null, attempts, total: sources.length };
        await delay(500);
    }
};

(async () => {
    await app.whenReady();

    const autoQuit = setTimeout(() => {
        warn('hard timeout reached, tearing down');
        void teardown().then(() => app.exit(1));
    }, HARD_TIMEOUT_MS);

    const library = createWallpaperEngineLibrary({
        fs,
        path,
        execFile,
        logWarn: (label, detail) => warn('library', label, detail || ''),
    });
    const windowHelper = createWallpaperEngineWindowHelper({
        spawn,
        logWarn: (label, detail) => warn('window-helper', label, detail || ''),
    });

    const scan = await library.scan();
    const playable = (scan.items || []).filter((item) => item.enginePlayable);
    const withAudio = playable.filter((item) => item.audioPropertyCount > 0);
    const item = withAudio[0] || playable[0];
    log('library:', scan.total, 'projects |', playable.length, 'playable |', withAudio.length, 'with audio props');
    if (!item) throw new Error('no playable scene found');
    log('picked:', item.title, '|', item.id, '| audio props:', item.audioPropertyCount);
    log('mute patch:', JSON.stringify(item.muteProperties));

    runtime = createWallpaperEngineRuntime({
        fs,
        path,
        execFile,
        spawn,
        log: (...args) => log('runtime', ...args),
        logWarn: (...args) => warn('runtime', ...args),
        windowHelper,
        getVirtualDesktopBounds: () => {
            const displays = screen.getAllDisplays();
            const left = Math.min(...displays.map((display) => display.bounds.x));
            const top = Math.min(...displays.map((display) => display.bounds.y));
            const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width));
            const bottom = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height));
            return { x: left, y: top, width: right - left, height: bottom - top };
        },
        emitStatus: (status) => log('status', status.phase, '| ready:', status.engineReady, '| muted:', status.muted, '| title:', status.locationTitle || '-'),
    });

    const started = await runtime.start({ item, muteAudio: true });
    log('start():', JSON.stringify(started));
    if (!started.ok) throw new Error('start failed: ' + started.error);

    const problems = [];
    const status = runtime.getStatus();
    log('requested:', status.width + 'x' + status.height, '| park corner:', status.parkX, status.parkY);

    const capture = await waitForCaptureSource(status.locationTitle);
    log('capture source:', capture.match
        ? 'FOUND after ' + capture.attempts + ' attempt(s); ' + capture.total + ' window sources'
        : 'MISSING after ' + capture.attempts + ' attempt(s); ' + capture.total + ' window sources');
    if (!capture.match) problems.push('capture source missing');

    if (capture.match) {
        browserWindow = new BrowserWindow({ show: false, width: 320, height: 180 });
        const probeFile = path.join(os.tmpdir(), 'folia-we-capture-probe.html');
        fs.writeFileSync(probeFile, '<!doctype html><meta charset="utf-8"><title>probe</title><body></body>');
        await browserWindow.loadFile(probeFile);
        const result = await browserWindow.webContents.executeJavaScript(buildCaptureProbe(capture.match.id), true);
        log('getUserMedia:', JSON.stringify(result));
        // A parked window that kept its size: the 0x0 resize bug would show up here as a tiny frame.
        const framed = result.width > 500 && result.height > 500 && result.advanced > 0.5;
        log('capture check:', framed ? 'PASS' : 'FAIL');
        if (!framed) problems.push('capture returned no usable frames');
    }

    // The mute schedule keeps re-asserting for ~12s; sampling here proves the engine accepted it.
    await delay(2600);
    const afterMute = runtime.getStatus();
    log('after mute window: muted =', afterMute.muted, '| muted properties =', afterMute.mutedPropertyCount, '| phase =', afterMute.phase);
    if (!afterMute.muted) problems.push('mute was never acknowledged');

    await teardown();
    const leftover = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 } });
    const stillPresent = leftover.some((source) => source.name === status.locationTitle);
    log('window closed:', stillPresent ? 'STILL PRESENT' : 'gone');
    if (stillPresent) problems.push('playback window still present after teardown');

    clearTimeout(autoQuit);
    if (problems.length) {
        warn('E2E FAILED:', problems.join('; '));
        app.exit(1);
    }
    log('E2E PASSED');
    app.exit(0);
})().catch(async (error) => {
    warn('E2E failed:', error && error.stack ? error.stack : error);
    await teardown();
    app.exit(1);
});
