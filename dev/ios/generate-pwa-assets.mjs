#!/usr/bin/env node
// dev/ios/generate-pwa-assets.mjs
//
// 生成 iOS「添加到主屏幕」用的两份资产，图形全部从 public/icon.svg 派生（唯一图形来源）：
//
//   public/apple-touch-icon.png       180×180。满幅方图，不带留边、不带圆角——iOS 会自己套
//                                     圆角遮罩；Safari 不认 SVG 的 apple-touch-icon，
//                                     缺 PNG 会退回拿网页截图当图标。
//   public/splash/apple-splash-*.png  竖屏启动图（standalone 冷启动时先于网页显示，防白闪）。
//
//   node dev/ios/generate-pwa-assets.mjs
//
// 渲染借仓库里现成的 Playwright Chromium（矢量按需栅格化，不再引图形依赖）。
// index.html 里 <link rel="apple-touch-startup-image"> 的尺寸与媒体查询和下面的 DEVICES
// 一一对应——改这里就要同步改那里。只做竖屏：横屏冷启动是少数场景，再加一组（文件翻倍）
// 不值当，退回系统默认即可。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ICON_PATH = path.join(ROOT, 'public', 'icon.svg');
const TOUCH_ICON_PATH = path.join(ROOT, 'public', 'apple-touch-icon.png');
const SPLASH_DIR = path.join(ROOT, 'public', 'splash');

// 竖屏尺寸表：w/h 是 CSS 像素（媒体查询里 device-width/height 用的就是它们），dpr 是设备
// 像素比，产出 PNG = w×dpr × h×dpr。按新→旧排列。
const DEVICES = [
    { w: 440, h: 956, dpr: 3 }, // 16 Pro Max
    { w: 402, h: 874, dpr: 3 }, // 16 Pro
    { w: 430, h: 932, dpr: 3 }, // 14 Pro Max / 15 Plus / 15 Pro Max / 16 Plus
    { w: 393, h: 852, dpr: 3 }, // 14 Pro / 15 / 15 Pro / 16
    { w: 390, h: 844, dpr: 3 }, // 12 / 13 / 14
    { w: 428, h: 926, dpr: 3 }, // 12–14 Pro Max / 14 Plus
    { w: 375, h: 812, dpr: 3 }, // X / XS / 11 Pro / 12 mini / 13 mini
    { w: 414, h: 896, dpr: 2 }, // XR / 11
    { w: 414, h: 896, dpr: 3 }, // XS Max / 11 Pro Max
    { w: 375, h: 667, dpr: 2 }, // SE 2/3 · 8
];

// 启动图上图钉的显示宽度（CSS px，各屏宽下约占 29–34%）。
const SPLASH_ICON_PX = 128;

const iconSource = fs.readFileSync(ICON_PATH, 'utf8');
const iconDataUrl = `data:image/svg+xml;base64,${Buffer.from(iconSource).toString('base64')}`;

// 满幅版：取 icon.svg 的 <defs>（渐变 + 阴影）与白色「F」组，把外圈的圆角方垫换成铺满画布
// 的渐变矩形。结构对不上就抛错，让生成失败得响亮，而不是产出一张半成品。
const defs = iconSource.match(/<defs>[\s\S]*?<\/defs>/)?.[0];
const glyph = iconSource.match(/<g filter="url\(#dropShadow\)">[\s\S]*?<\/g>/)?.[0];
if (!defs || !glyph) throw new Error(`icon.svg 结构变了：${ICON_PATH} 里找不到 <defs> 或 F 字形组`);
const touchIconSvg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512" fill="none">
${defs}
<rect width="512" height="512" fill="url(#folia_gradient)"/>
${glyph}
</svg>`;

/** setContent 的 load 事件不保证 data URL 的 <img> 已解码完，截图前显式等它。 */
const waitForImages = (page) => page.waitForFunction(() => {
    const img = document.querySelector('img');
    return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
});

const main = async () => {
    fs.mkdirSync(SPLASH_DIR, { recursive: true });
    const browser = await chromium.launch();

    // —— 主屏图标 ——
    const touchPage = await browser.newPage({ viewport: { width: 180, height: 180 } });
    await touchPage.setContent(`<!doctype html><html><body style="margin:0">${touchIconSvg(180)}</body></html>`);
    await touchPage.screenshot({ path: TOUCH_ICON_PATH });

    // —— 启动图 ——
    for (const { w, h, dpr } of DEVICES) {
        const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
        const page = await context.newPage();
        await page.setContent(`<!doctype html><html><head><style>
            html, body { margin: 0; height: 100%; }
            body { background: #09090b; display: flex; align-items: center; justify-content: center; }
            img { width: ${SPLASH_ICON_PX}px; height: ${SPLASH_ICON_PX}px; }
        </style></head><body><img src="${iconDataUrl}" alt=""></body></html>`);
        await waitForImages(page);
        await page.screenshot({ path: path.join(SPLASH_DIR, `apple-splash-${w * dpr}x${h * dpr}.png`) });
        await context.close();
    }

    await browser.close();

    const written = [TOUCH_ICON_PATH, ...fs.readdirSync(SPLASH_DIR).map(file => path.join(SPLASH_DIR, file))];
    for (const file of written) {
        console.log(`${path.relative(ROOT, file)}  ${fs.statSync(file).size} B`);
    }
};

await main();
