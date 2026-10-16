#!/usr/bin/env node
// dev/mobile/generate-shell-icon.mjs
//
// 生成移动端壳（Capacitor）要用的图标源图，图形全部派生自 public/icon.svg（唯一图形来源）：
//
//   mobile-assets/logo.png         1024×1024 满幅方图（渐变垫 + F 字形）。iOS 主屏图标、
//                                  Android 自适应图标前景与旧版图标都用它。
//   mobile-assets/splash.png       2732×2732，#09090b 底 + 居中图标，启动图。
//   mobile-assets/splash-dark.png  同上（图标本就是深色渐变，明暗共用一张）。
//
//   node dev/mobile/generate-shell-icon.mjs
//
// CI（.github/workflows/mobile-build.yml）在 cap add 平台目录后用 @capacitor/assets
// 把这些源图铺进 android/ios。渲染借仓库里现成的 Playwright Chromium，与
// dev/ios/generate-pwa-assets.mjs 同一套路，不引图形依赖。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ICON_PATH = path.join(ROOT, 'public', 'icon.svg');
const OUT_DIR = path.join(ROOT, 'mobile-assets');

const ICON_SIZE = 1024;
const SPLASH_SIZE = 2732;
const SPLASH_ICON_PX = 448;           // 2732 画布上约 16%，接近系统启动图的观感
const SPLASH_BACKGROUND = '#09090b';  // 与应用背景一致（index.html / PWA manifest 同色）

const iconSource = fs.readFileSync(ICON_PATH, 'utf8');

// 满幅版：取 icon.svg 的 <defs>（渐变 + 阴影）与白色「F」组，把外圈的圆角方垫换成铺满画布
// 的渐变矩形（与 dev/ios/generate-pwa-assets.mjs 同一取法）。结构对不上就抛错，让失败响亮。
const defs = iconSource.match(/<defs>[\s\S]*?<\/defs>/)?.[0];
const glyph = iconSource.match(/<g filter="url\(#dropShadow\)">[\s\S]*?<\/g>/)?.[0];
if (!defs || !glyph) throw new Error(`icon.svg 结构变了：${ICON_PATH} 里找不到 <defs> 或 F 字形组`);
const fullBleedSvg = (size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 512 512" fill="none">
${defs}
<rect width="512" height="512" fill="url(#folia_gradient)"/>
${glyph}
</svg>`;

/** setContent 的 load 事件不保证 data URL 的 <img> 已解码完，截图前显式等它。 */
const waitForImage = (page) => page.waitForFunction(() => {
  const img = document.querySelector('img');
  return img instanceof HTMLImageElement && img.complete && img.naturalWidth > 0;
});

const main = async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch();

  // —— 应用图标（明暗两张同一内容：图标自带深色渐变垫，不随主题变）——
  const iconPage = await browser.newPage({ viewport: { width: ICON_SIZE, height: ICON_SIZE } });
  await iconPage.setContent(`<!doctype html><html><body style="margin:0">${fullBleedSvg(ICON_SIZE)}</body></html>`);
  await iconPage.screenshot({ path: path.join(OUT_DIR, 'logo.png') });
  await iconPage.screenshot({ path: path.join(OUT_DIR, 'logo-dark.png') });
  await iconPage.close();

  // —— 启动图（明暗两张同一内容）——
  const iconDataUrl = `data:image/svg+xml;base64,${Buffer.from(iconSource).toString('base64')}`;
  const splashPage = await browser.newPage({ viewport: { width: SPLASH_SIZE, height: SPLASH_SIZE } });
  await splashPage.setContent(`<!doctype html><html><head><style>
      html, body { margin: 0; height: 100%; }
      body { background: ${SPLASH_BACKGROUND}; display: flex; align-items: center; justify-content: center; }
      img { width: ${SPLASH_ICON_PX}px; height: ${SPLASH_ICON_PX}px; }
    </style></head><body><img src="${iconDataUrl}" alt=""></body></html>`);
  await waitForImage(splashPage);
  await splashPage.screenshot({ path: path.join(OUT_DIR, 'splash.png') });
  await splashPage.screenshot({ path: path.join(OUT_DIR, 'splash-dark.png') });
  await splashPage.close();

  await browser.close();

  for (const file of fs.readdirSync(OUT_DIR)) {
    console.log(`mobile-assets/${file}  ${fs.statSync(path.join(OUT_DIR, file)).size} B`);
  }
};

await main();
