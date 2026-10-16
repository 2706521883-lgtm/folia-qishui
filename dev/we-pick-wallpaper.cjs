// dev/we-pick-wallpaper.cjs
// First-run helper for the Wallpaper Engine background in a *packaged* app (no /src module to reach
// into): picks a wallpaper through the real UI so a session can start at all.
//
// It walks 背景类型 → 更多设置 (the stepper's dropdown footer action) into 设置/外观/背景, scans the
// library, and clicks the item whose title is given on the command line (default: the first
// playable one). Reports the main-process phase afterwards. The chosen item is persisted by the
// app's own settings save path — this script writes nothing itself.
//
// Usage: node dev/we-pick-wallpaper.cjs [debugPort] [titleSubstring]
const { chromium } = require('playwright-core');

const PORT = process.argv[2] || '9222';
const WANTED = process.argv[3] || '';
const BACKGROUND_LABEL = /背景类型|Background Type/;
const MORE_LABEL = /^(更多设置|More settings)$/;
const SCAN_LABEL = /^(识别壁纸|重新识别|Detect wallpapers|Rescan)$/;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
    const page = browser.contexts().flatMap(context => context.pages())
        .find(candidate => candidate.url().startsWith('http://localhost:3000')
            || (candidate.url().startsWith('file://') && candidate.url().includes('index.html')));
    if (!page) {
        console.error(`PICK FAILED: no renderer page on port ${PORT}`);
        process.exit(1);
    }
    await page.bringToFront();

    // 1. the 背景类型 row's dropdown → 更多设置 → the background card in the settings modal.
    // The row's own label lives in aria-label (the visible text is the current value). When the
    // panel is closed, the command palette opens it — the packaged app has no /src module to import.
    const rowTitles = () => page.evaluate(() => Array.from(document.querySelectorAll('button[aria-haspopup="listbox"]'))
        .map(el => el.getAttribute('title')));
    for (let attempt = 0; attempt < 3 && (await rowTitles()).length === 0; attempt += 1) {
        // Escape first: a leftover modal blocks the palette, and it may still be up from last time.
        await page.keyboard.press('Escape');
        await sleep(300);
        await page.keyboard.press('Control+k');
        await sleep(900);
        await page.keyboard.type('Panel: controls');
        await sleep(900);
        await page.keyboard.press('Enter');
        await sleep(1500);
    }
    const opened = await page.evaluate((source) => {
        const regex = new RegExp(source);
        const button = Array.from(document.querySelectorAll('button[aria-haspopup="listbox"]'))
            .find(el => regex.test(el.getAttribute('aria-label') || ''));
        if (!button) return false;
        button.click();
        return true;
    }, BACKGROUND_LABEL.source);
    if (!opened) {
        console.error('PICK FAILED: the 背景类型 row is not on screen — open the player page first');
        process.exit(1);
    }
    await sleep(500);
    await page.getByRole('button', { name: MORE_LABEL }).first().click();
    await sleep(1500);

    // 2. scan (the button flips 识别壁纸 → 重新识别 after the first scan).
    const scan = page.getByRole('button', { name: SCAN_LABEL }).first();
    if (await scan.isVisible().catch(() => false)) {
        await scan.click();
        await sleep(2500);
    }

    // 3. pick a wallpaper from the grid.
    const items = page.locator('div.grid.max-h-64 button');
    await items.first().waitFor({ state: 'visible', timeout: 20000 }).catch(() => undefined);
    const titles = await items.allInnerTexts().catch(() => []);
    const index = WANTED ? titles.findIndex(text => text.includes(WANTED)) : 0;
    if (titles.length === 0) {
        console.error('PICK FAILED: the Wallpaper Engine picker listed no playable item');
        process.exit(1);
    }
    if (index < 0) {
        console.error(`PICK FAILED: no item matches ${JSON.stringify(WANTED)}; first five: ${titles.slice(0, 5).join(' / ')}`);
        process.exit(1);
    }
    console.log(`picking #${index}: ${titles[index].split('\n')[0].slice(0, 60)}`);
    await items.nth(index).click();
    await sleep(2000);

    // 4. close the modal and report where the runtime ended up.
    await page.keyboard.press('Escape');
    await sleep(1200);
    const status = await page.evaluate(async () => {
        const result = await window.electron.getWallpaperEngineStatus().catch(() => null);
        return result && result.status ? result.status : result;
    });
    const picked = await page.evaluate(() => document.querySelectorAll('[data-we-poster]').length);
    console.log(`phase=${status?.phase} itemId=${status?.itemId} title=${status?.title}`);
    console.log(picked >= 0 ? `poster nodes on surface: ${picked}` : '');
    if (!status?.itemId) {
        console.error('PICK FAILED: the runtime reports no active item after the click');
        process.exit(1);
    }
    console.log('PICK OK');
    browser.close();
})().catch(error => {
    console.error('PICK FAILED:', error && error.message ? error.message : error);
    process.exit(1);
});
