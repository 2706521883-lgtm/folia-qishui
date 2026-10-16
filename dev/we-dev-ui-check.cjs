// dev/we-dev-ui-check.cjs
// Entry-point probe for the desktop dev app: connects to the Electron renderer over CDP, opens
// 设置 → 歌词样式 → 背景 and checks that the Wallpaper Engine chip is listed next to the other
// background types and that selecting it renders the session card. The desktop build must show the
// controls — the "Windows desktop only" notice is the browser fallback and counts as a failure
// here. Writes a screenshot of the tab for eyeballing.
//
// Usage: node dev/we-dev-ui-check.cjs [debugPort]
// The app must already run with --remote-debugging-port=<debugPort> (default 9222).
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');

const PORT = process.argv[2] || '9222';
const SCREENSHOT = path.join(os.tmpdir(), 'folia-we-dev-ui-check.png');
const CHIP_LABEL = /^(壁纸引擎|Wallpaper Engine)$/;
const GROUP_LABEL = /Background Type|背景类型/;
const CARD_LABEL = /壁纸引擎背景|Wallpaper Engine Background/;
const DETECT_LABEL = /^(识别壁纸|重新识别|Detect wallpapers|Rescan)$/;
const PLATFORM_NOTICE = /only available in the Windows desktop build|仅 Windows 桌面版支持壁纸引擎背景/i;

(async () => {
  const problems = [];
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => candidate.url().startsWith('http://localhost:3000'));
  if (!page) {
    console.error(`DEV UI CHECK FAILED: no renderer page on port ${PORT}`);
    process.exit(1);
  }
  console.log(`renderer: ${await page.title()} — ${page.url()}`);

  await page.evaluate(async () => {
    const module = await import('/src/stores/useSettingsModalStore.ts');
    module.useSettingsModalStore.getState().openSettings('options', 'visualizer', 'background');
  });

  // Scoped to the background chip row: the visualizer-mode row above uses some of the same labels.
  const group = page.locator('div.space-y-2\\.5').filter({ hasText: GROUP_LABEL });
  const chip = group.getByRole('button', { name: CHIP_LABEL });
  try {
    await chip.waitFor({ state: 'visible', timeout: 8000 });
  } catch {
    problems.push('the background picker does not list a Wallpaper Engine chip');
  }
  const chips = await group.getByRole('button').allInnerTexts().catch(() => []);
  console.log(`background chips: ${chips.map((text) => text.trim()).filter(Boolean).join(' / ')}`);

  if (!problems.length) {
    const card = page.locator('div.space-y-5').filter({ hasText: CARD_LABEL });
    await chip.click();
    try {
      await card.getByRole('button', { name: DETECT_LABEL }).waitFor({ state: 'visible', timeout: 8000 });
    } catch {
      problems.push('the settings card did not render its scan button');
    }
    if (await card.getByText(PLATFORM_NOTICE).isVisible().catch(() => false)) {
      problems.push('the card shows the browser-only platform notice inside the desktop app');
    }
  }

  await page.screenshot({ path: SCREENSHOT }).catch(() => undefined);

  if (problems.length) {
    console.error('DEV UI CHECK FAILED:');
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log('DEV UI CHECK PASSED (scan button visible, platform notice absent)');
  console.log(`screenshot: ${SCREENSHOT}`);
  process.exit(0);
})().catch((error) => {
  console.error('DEV UI CHECK FAILED:', error);
  process.exit(1);
});
