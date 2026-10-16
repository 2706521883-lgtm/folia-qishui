// dev/we-live-session-stop-check.cjs
// Live check for the Wallpaper Engine session lifecycle in a running app — the dev app
// (`ELECTRON_DEV=true npx electron .`) or the packaged one (`<安装目录>\Folia.exe`), both launched
// with --remote-debugging-port. The component probe stubs the store, so this one drives the real UI
// instead: the panel's two steppers (歌词样式 ± / 背景类型 ±, aria-label 取自 i18n) are clicked, and
// only the main process status (`window.electron.getWallpaperEngineStatus()`) plus DOM mutations on
// the player visual surface are read back. Deliberately NOT the front-end stores: a console
// `import('/src/stores/...')` after an HMR update resolves to a different module instance, which
// makes a store-only check lie.
//
// It opens what it needs itself: if the 外观 steppers are not on screen it runs the command palette
// ('Panel: controls') — the packaged app has no /src module to reach into — and if 背景类型 is on
// another value it steps to 壁纸引擎 first.
//
// Asserts, in order:
//   1. 背景类型 leaves 壁纸引擎 → the layer unmounts, and the session stops only after the
//      IDLE_STOP_DELAY_MS grace (~3s), not immediately.
//   2. 背景类型 returns → the session starts again and the capture re-attaches.
//   3. 歌词样式 switches → the session must stay running the whole time (a remount inside the grace
//      cancels the stop; otherwise every style change would restart the engine).
// Restores the background type and the lyric style it started from.
//
// Usage: node dev/we-live-session-stop-check.cjs [debugPort]   (default 9222)
// Page: http://localhost:3000 (dev) or file:///.../dist/index.html (packaged). The player page must
// be showing with a song playing, e.g.
//   ELECTRON_DEV=true npx electron . --remote-debugging-port=9222
const { chromium } = require('playwright-core');

const PORT = process.argv[2] || '9222';
const STYLE_LABEL = /歌词样式|Lyrics Style/;
const BACKGROUND_LABEL = /背景类型|Background Type/;
const WE_VALUE = /壁纸引擎|Wallpaper Engine/;
// The stop must be *delayed* (grace) but must still happen; anything outside this window means the
// either the grace is gone or the stop never fired.
const STOP_AFTER_MS = { min: 2000, max: 6000 };
// Steps allowed when walking the background-type ring to reach 壁纸引擎 (or back to the start value).
const MAX_BACKGROUND_STEPS = 8;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** The renderer page, whichever build is running: vite dev server or packaged dist. */
const findAppPage = (browser) => browser.contexts()
    .flatMap(context => context.pages())
    .find(candidate => candidate.url().startsWith('http://localhost:3000')
        || (candidate.url().startsWith('file://') && candidate.url().includes('index.html')));

const status = (page) => page.evaluate(async () => {
    const result = await window.electron.getWallpaperEngineStatus().catch(() => null);
    const s = result && result.status ? result.status : result;
    return s ? { phase: s.phase, itemId: s.itemId } : null;
});

const surface = (page) => page.evaluate(() => {
    const el = document.querySelector('[data-testid="player-visual-surface"]');
    const videos = el ? Array.from(el.querySelectorAll('video')) : [];
    return {
        videos: videos.length,
        stream: videos.some(video => Boolean(video.srcObject)),
        posters: el ? el.querySelectorAll('[data-we-poster]').length : 0,
    };
});

/** Row labels, read off the stepper triggers so the script follows the app language. */
const rowLabels = (page) => page.evaluate(() => Array.from(document.querySelectorAll('button[aria-haspopup="listbox"]'))
    .map(button => button.getAttribute('title'))
    .filter(Boolean));

const rowValue = (page, pattern) => page.evaluate(({ source, flags }) => {
    const regex = new RegExp(source, flags);
    const trigger = Array.from(document.querySelectorAll('button[aria-haspopup="listbox"]'))
        .find(button => regex.test(button.getAttribute('title') || ''));
    return trigger ? (trigger.getAttribute('title') || '').split(': ')[1] : null;
}, { source: pattern.source, flags: pattern.flags });

const step = (page, label, direction) => page.locator(`button[aria-label="${label} ${direction === 1 ? '+' : '−'}"]`).first().click();

/**
 * Opens the 外观 steppers through the command palette when they are not on screen (the packaged app
 * exposes no /src module to import). Returns the row titles, empty when the palette did not land.
 */
const ensureAppearancePanel = async (page) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        if ((await rowLabels(page)).length) return rowLabels(page);
        // Escape first: a leftover modal keeps the palette from opening, and the palette itself may
        // still be up from a previous attempt.
        await page.keyboard.press('Escape');
        await sleep(300);
        await page.keyboard.press('Control+k');
        await sleep(900);
        await page.keyboard.type('Panel: controls');
        await sleep(900);
        await page.keyboard.press('Enter');
        await sleep(1500);
    }
    return rowLabels(page);
};

/** Walks 背景类型 with ± until the row reads `wanted`; returns the value it ended on. */
const walkBackgroundTo = async (page, backgroundLabel, wanted) => {
    let value = await rowValue(page, BACKGROUND_LABEL);
    for (let i = 0; i < MAX_BACKGROUND_STEPS && value && !wanted.test(value); i += 1) {
        await step(page, backgroundLabel, 1);
        await sleep(1200);
        value = await rowValue(page, BACKGROUND_LABEL);
    }
    return value;
};

const waitForPhase = async (page, wanted, timeoutMs) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        const current = await status(page);
        if (current && wanted.includes(current.phase)) return { waitedMs: Date.now() - started, status: current };
        await sleep(200);
    }
    return { waitedMs: Date.now() - started, status: await status(page) };
};

(async () => {
    const failures = [];
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const page = findAppPage(browser);
    if (!page) {
        console.error(`LIVE CHECK FAILED: no renderer page on port ${PORT}`);
        process.exit(1);
    }
    await page.bringToFront();

    const labels = await ensureAppearancePanel(page);
    const styleLabel = labels.find(title => STYLE_LABEL.test(title))?.split(': ')[0] ?? null;
    const backgroundLabel = labels.find(title => BACKGROUND_LABEL.test(title))?.split(': ')[0] ?? null;
    if (!styleLabel || !backgroundLabel) {
        console.error(`LIVE CHECK FAILED: stepper rows not found — is the player page showing? rows: ${JSON.stringify(labels)}`);
        process.exit(1);
    }
    const startBackground = await rowValue(page, BACKGROUND_LABEL);
    const startStyle = await rowValue(page, STYLE_LABEL);
    console.log(`rows: ${styleLabel} = ${startStyle}, ${backgroundLabel} = ${startBackground}`);

    if (!WE_VALUE.test(startBackground || '')) {
        const walked = await walkBackgroundTo(page, backgroundLabel, WE_VALUE);
        console.log(`stepped ${backgroundLabel} to 壁纸引擎: ${walked}`);
        if (!WE_VALUE.test(walked || '')) {
            console.error(`LIVE CHECK FAILED: 壁纸引擎 is not in the background ring (ended on ${walked})`);
            process.exit(1);
        }
    }
    const running = await waitForPhase(page, ['running'], 30000);
    if (!running.status || running.status.phase !== 'running') {
        console.error(`LIVE CHECK FAILED: no running session to observe the stop with (${JSON.stringify(running.status)})`);
        process.exit(1);
    }
    const sessionItemId = running.status.itemId;
    console.log(`start: phase=running itemId=${sessionItemId} ${JSON.stringify(await surface(page))}`);
    // The capture can take a moment after a cold start; only failure-3 re-checks it, so wait here.
    for (let i = 0; i < 40 && !(await surface(page)).stream; i += 1) await sleep(250);
    console.log(`capture attached: ${(await surface(page)).stream}`);

    // --- 1. leave 壁纸引擎: delayed stop ---
    await step(page, backgroundLabel, 1);
    const unmounted = await (async () => {
        const started = Date.now();
        while (Date.now() - started < 4000) {
            if ((await surface(page)).videos === 0) return Date.now() - started;
            await sleep(200);
        }
        return null;
    })();
    if (unmounted === null) failures.push('背景类型 切走后背景层没有卸载（4s 内 video 仍在）');
    const stopped = await waitForPhase(page, ['idle'], 8000);
    console.log(`after leaving 壁纸引擎: layerGoneAfter=${unmounted}ms phase=${stopped.status?.phase} after=${stopped.waitedMs}ms`);
    if (stopped.status?.phase !== 'idle') {
        failures.push(`切走背景类型后会话没有停（phase=${stopped.status?.phase}）`);
    } else if (unmounted !== null && stopped.waitedMs < STOP_AFTER_MS.min) {
        failures.push(`会话停得太早（${stopped.waitedMs}ms < ${STOP_AFTER_MS.min}ms）：宽限期没生效，切歌词样式会重启引擎`);
    } else if (stopped.waitedMs > STOP_AFTER_MS.max) {
        failures.push(`会话停得太晚（${stopped.waitedMs}ms > ${STOP_AFTER_MS.max}ms）`);
    }

    // --- 2. back to 壁纸引擎: session restarts ---
    await step(page, backgroundLabel, -1);
    const restarted = await waitForPhase(page, ['running'], 12000);
    let attached = false;
    if (restarted.status?.phase === 'running') {
        const started = Date.now();
        while (Date.now() - started < 8000) {
            if ((await surface(page)).stream) { attached = true; break; }
            await sleep(200);
        }
    }
    console.log(`back on 壁纸引擎: phase=${restarted.status?.phase} after=${restarted.waitedMs}ms captureAttached=${attached}`);
    if (restarted.status?.phase !== 'running') failures.push('切回壁纸引擎后会话没有自动重启');
    else if (!attached) failures.push('会话重启了但采集流没有接上（一直停在预览图）');

    // --- 3. lyric style switch: must not stop the session ---
    const beforeStyle = await surface(page);
    await step(page, styleLabel, 1);
    const seen = [];
    let afterStyle = beforeStyle;
    for (let i = 0; i < 10; i += 1) {
        await sleep(500);
        seen.push((await status(page))?.phase);
        afterStyle = await surface(page);
    }
    const stoppedByStyle = seen.some(phase => phase !== 'running');
    // A style that renders no shared background layer unmounts it, and then the delayed stop is the
    // feature doing its job. Only a stop with the layer still mounted is a regression.
    const styleWithoutLayer = stoppedByStyle && afterStyle.videos === 0 && afterStyle.posters === 0;
    console.log(`after 歌词样式 switch: phases=${JSON.stringify(seen)} posters=${afterStyle.posters} stream=${afterStyle.stream} videos=${beforeStyle.videos}->${afterStyle.videos}${styleWithoutLayer ? ' （该样式不挂背景层，第 3 步跳过）' : ''}`);
    if (!styleWithoutLayer) {
        if (stoppedByStyle) failures.push(`切歌词样式把会话停了（phases=${JSON.stringify(seen)}）`);
        if (afterStyle.videos === 0) failures.push('切歌词样式后背景层没回来');
        if (afterStyle.posters > 0) failures.push('切歌词样式后还留着低清预览图');
    }

    // --- restore ---
    await step(page, styleLabel, -1);
    await sleep(1500);
    const restoredStyle = await rowValue(page, STYLE_LABEL);
    // The background ring is walked forward back to the value it had (it was stepped to 壁纸引擎).
    const startValuePattern = new RegExp(`^${String(startBackground || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
    const restoredBackground = await walkBackgroundTo(page, backgroundLabel, startValuePattern);
    console.log(`restored: ${styleLabel} = ${restoredStyle}, ${backgroundLabel} = ${restoredBackground}, ${JSON.stringify(await status(page))}`);
    if (restoredStyle !== startStyle) failures.push(`歌词样式没有还原（${startStyle} -> ${restoredStyle}）`);
    if (restoredBackground !== startBackground) failures.push(`背景类型没有还原（${startBackground} -> ${restoredBackground}）`);

    if (failures.length) {
        console.error(`LIVE CHECK FAILED:\n- ${failures.join('\n- ')}`);
        process.exit(1);
    }
    console.log('LIVE CHECK PASSED');
    browser.close();
})().catch(error => {
    console.error('LIVE CHECK FAILED:', error && error.message ? error.message : error);
    process.exit(1);
});
