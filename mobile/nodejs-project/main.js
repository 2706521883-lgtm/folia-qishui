// Folia iOS/Android App 内置 Node 服务端入口。
//
// 把桌面版的三套在线音源后端跑在 App 内（只监听 127.0.0.1）：
//   酷狗   3211  vendor/KuGouMusicApi（自带 Express 服务）
//   QQ     3212  @yakult-green-tea/qq-music-api（require 即监听）
//   汽水   3302  qishui-inapp.cjs（公开搜索 + 扫码登录 + SEO 取流）
//
// 真机 stdout 是管道，切后台后会 `write EIO`；日志处理器自己再写 stdout 会自激死循环。
// 所以下面所有写操作一律 try/catch，连续失败就停写 stdout；文件日志限制在 2MB 以内。
const __fs = require('fs');
const __path = require('path');

// 原生侧通过 FOLIA_LOG_DIR 传 Documents 下的可写目录；状态（Cookie/设备/日志）都放这里。
const __stateDir = process.env.FOLIA_STATE_DIR || process.env.FOLIA_LOG_DIR || __path.join(__dirname, 'state');
process.env.FOLIA_STATE_DIR = __stateDir;
process.env.FOLIA_LOG_DIR = process.env.FOLIA_LOG_DIR || __stateDir;
try { __fs.mkdirSync(__stateDir, { recursive: true }); } catch (_) { /* ignore */ }

const __logFile = __path.join(__stateDir, 'folia-node-js.log');
const __LOG_MAX_BYTES = 2 * 1024 * 1024;
let __logWritesSinceCheck = 0;
let __stdoutFailures = 0;
let __stdoutDisabled = false;
const __rawLog = console.log.bind(console);
const __toLine = args => Array.prototype.map.call(args, a => (
  typeof a === 'string'
    ? a
    : (() => { try { return JSON.stringify(a); } catch (_) { return String(a); } })()
)).join(' ');
const __shouldLog = line => line.indexOf('[folia-node]') === 0 || line.indexOf('ERROR') !== -1;
console.log = function () {
  const line = __toLine(arguments);
  if (!__shouldLog(line)) return;
  if (!__stdoutDisabled) {
    try {
      __rawLog(line);
      __stdoutFailures = 0;
    } catch (_) {
      __stdoutFailures += 1;
      if (__stdoutFailures >= 20) __stdoutDisabled = true;
    }
  }
  try {
    __logWritesSinceCheck += 1;
    if (__logWritesSinceCheck >= 200) {
      __logWritesSinceCheck = 0;
      if (__fs.statSync(__logFile).size > __LOG_MAX_BYTES) __fs.writeFileSync(__logFile, '');
    }
    __fs.appendFileSync(__logFile, '[' + new Date().toISOString() + '] ' + line + '\n');
  } catch (_) { /* 设备上日志失败绝不能影响服务本身 */ }
};

// nodejs-mobile 的 Node 18 没有 globalThis.crypto（QQ 的设备初始化需要 WebCrypto）。
if (typeof globalThis.crypto === 'undefined') {
  try {
    globalThis.crypto = require('crypto').webcrypto;
    console.log('[folia-node] crypto polyfilled (webcrypto)');
  } catch (error) {
    console.log('[folia-node] ERROR crypto polyfill failed: ' + ((error && error.message) || error));
  }
}

// cwd 在真机上是 `/`（只读）：QQ 的设备身份必须写到可写目录，否则每次都注册新设备。
if (!process.env.QQ_AUTH_STATE_PATH) {
  process.env.QQ_AUTH_STATE_PATH = __path.join(__stateDir, 'qq-device.json');
}

// Node 18 没有 AbortSignal.any（qq-music-api 用到；Node 20.3 才加）。
if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any !== 'function') {
  AbortSignal.any = function any(signals) {
    const controller = new AbortController();
    const abort = reason => { try { controller.abort(reason); } catch (_) { /* ignore */ } };
    for (const signal of signals) {
      if (!signal) continue;
      if (signal.aborted) { abort(signal.reason); break; }
      signal.addEventListener('abort', () => abort(signal.reason), { once: true });
    }
    return controller.signal;
  };
  console.log('[folia-node] AbortSignal.any polyfilled');
}

const HOST = '127.0.0.1';
const KUGOU_PORT = Number(process.env.FOLIA_KUGOU_PORT || 3211);
const QQ_PORT = Number(process.env.FOLIA_QQ_PORT || 3212);
const QISHUI_PORT = Number(process.env.FOLIA_QISHUI_PORT || 3302);

console.log('[folia-node] booting, node ' + process.version + ', state ' + __stateDir);

const __report = (kind, error) => {
  try { console.log('[folia-node] ERROR ' + kind + ': ' + ((error && error.stack) || error)); } catch (_) { /* ignore */ }
};
process.on('uncaughtException', error => __report('uncaught', error));
process.on('unhandledRejection', error => __report('unhandled', error));

function startQishui() {
  try {
    const { startServer } = require('./qishui-inapp.cjs');
    startServer(line => console.log(line));
  } catch (error) {
    console.log('[folia-node] ERROR qishui failed: ' + ((error && error.stack) || error));
  }
}

async function startKugou() {
  try {
    process.env.PORT = String(KUGOU_PORT);
    process.env.HOST = HOST;
    const kugou = require('kugoumusicapi/server.js');
    await kugou.startService();
    console.log('[folia-node] kugou listening on http://' + HOST + ':' + KUGOU_PORT);
  } catch (error) {
    console.log('[folia-node] ERROR kugou failed: ' + ((error && error.stack) || error));
  }
}

function startQq() {
  // QQ 服务端内部只调 app.listen(port)（绑 0.0.0.0）。App 里没有理由把它暴露到局域网，
  // 在 require 期间临时把 listen 补成 127.0.0.1，加载完立刻还原，不影响其它代码。
  const http = require('http');
  const originalListen = http.Server.prototype.listen;
  http.Server.prototype.listen = function listen(...args) {
    if (typeof args[0] === 'number' && (args.length === 1 || typeof args[1] === 'function')) {
      args.splice(1, 0, HOST);
    }
    return originalListen.apply(this, args);
  };
  try {
    process.env.PORT = String(QQ_PORT);
    require('@yakult-green-tea/qq-music-api');
    console.log('[folia-node] qq requested on http://' + HOST + ':' + QQ_PORT);
  } catch (error) {
    console.log('[folia-node] ERROR qq failed: ' + ((error && error.stack) || error));
  } finally {
    http.Server.prototype.listen = originalListen;
  }
}

// 汽水最先起（纯 Node、无外部依赖），酷狗注册设备可能较慢，QQ require 即监听。
startQishui();
startQq();
startKugou();
