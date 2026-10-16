// test/manual/shell-boot-check-probe.mjs
//
// 在真 Chromium 里过一遍 index.html 里的「手机壳启动自检」四种情形（改那段的开关/文案后跑一遍）：
//   A  壳内正常启动          → 15 秒后不许有面板，启动遮罩应已撤
//   B1 壳内主 JS 语法错误     → 面板出现，且捕获到带 main-*.js 的报错
//   B2 壳内主 JS 静默不启动   → 面板出现，提示「没有捕获到 JavaScript 报错」
//   C  桌面 http:// 协议      → 即使启动失败也不许出现面板（桌面必须像素级不变）
//
//   npm run build:mobile && node test/manual/shell-boot-check-probe.mjs
//
// 用 Playwright 路由把 https://localhost/** 全部喂给本地 dist（壳内的 origin 就长这样），
// 不启动任何真服务、不碰网络。全程约 20 秒（自检超时 15 秒是生产值，不缩短）。
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const DIST = path.resolve('dist');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

const resolveDist = (pathname) => {
  const rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
  return path.join(DIST, rel);
};

const readIfFile = (file) => (fs.existsSync(file) && fs.statSync(file).isFile() ? fs.readFileSync(file) : null);

// http 服务（给场景 C 用）
const server = http.createServer((req, res) => {
  const body = readIfFile(resolveDist(new URL(req.url, 'http://x').pathname));
  if (!body) {
    res.writeHead(404);
    res.end('nope');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(req.url)] ?? 'application/octet-stream' });
  res.end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const httpPort = server.address().port;

const browser = await chromium.launch();
const results = [];

async function scenario(name, { url, breakMain }) {
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e.message).split('\n')[0]));
  if (breakMain) {
    await page.route('https://localhost/**', async (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (breakMain === 'syntax' && /^\/assets\/main-.*\.js$/.test(pathname)) {
        await route.fulfill({ status: 200, contentType: 'text/javascript', body: '%%% not javascript %%' });
        return;
      }
      if (breakMain === 'inert' && /^\/assets\/main-.*\.js$/.test(pathname)) {
        await route.fulfill({ status: 200, contentType: 'text/javascript', body: '/* 什么都不做的模块：模拟启动静默卡死 */' });
        return;
      }
      const body = readIfFile(resolveDist(pathname));
      if (!body) {
        await route.fulfill({ status: 404, body: 'nope' });
        return;
      }
      await route.fulfill({ status: 200, contentType: MIME[path.extname(pathname)] ?? 'text/plain', body });
    });
  }
  await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(17000);
  const state = await page.evaluate(() => {
    const splash = document.getElementById('app-splash');
    const root = document.getElementById('root');
    const body = document.body.textContent ?? '';
    const panel = document.querySelector('[role="alert"]');
    return {
      // 只能看面板元素：内联脚本自己的源码也在 body.textContent 里，按文本找会假阳性。
      hasPanel: Boolean(panel),
      splashState: !splash ? 'removed' : String(splash.className).includes('is-hiding') ? 'is-hiding' : 'present',
      panelText: panel ? (panel.textContent ?? '') : null,
    };
  });
  results.push({ name, ...state, pageErrors: pageErrors.slice(0, 3) });
  await page.close();
}

await Promise.all([
  scenario('A 壳内正常启动', { url: 'https://localhost/index.html' }),
  scenario('B1 壳内主 JS 语法错误', { url: 'https://localhost/index.html', breakMain: 'syntax' }),
  scenario('B2 壳内主 JS 静默卡死', { url: 'https://localhost/index.html', breakMain: 'inert' }),
  scenario('C 桌面 http（不该出自检）', { url: `http://127.0.0.1:${httpPort}/index.html`, breakMain: 'syntax' }),
]);

for (const r of results) console.log(JSON.stringify(r, null, 1));

const checks = [
  ['A 无面板且启动遮罩已撤', results[0] && !results[0].hasPanel && results[0].splashState === 'removed'],
  ['B1 面板出现', results[1] && results[1].hasPanel],
  // 主 JS 语法错误按浏览器行为可能走两条分支：window error（报 "错误: ... @ main-x.js"）
  // 或 script 元素的资源加载失败。两条都算捕获成功，但必须带上文件名。
  ['B1 捕获到主 JS 报错', results[1] && /(资源加载失败|错误:.*)main-[^ ]*\.js/.test(results[1].panelText ?? '')],
  ['B2 面板出现', results[2] && results[2].hasPanel],
  ['B2 提示无报错', results[2] && (results[2].panelText ?? '').includes('没有捕获到 JavaScript 报错')],
  ['C 不出现面板且已启动', results[3] && !results[3].hasPanel && results[3].splashState === 'removed'],
];
let ok = true;
for (const [label, pass] of checks) {
  console.log(`${pass ? '✓' : '✗'} ${label}`);
  if (!pass) ok = false;
}
await browser.close();
server.close();
process.exit(ok ? 0 : 1);
