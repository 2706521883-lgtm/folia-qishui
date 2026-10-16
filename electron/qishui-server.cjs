'use strict';

/**
 * 汽水音源服务器（路线 A / 里程碑 M1）：把 electron/qishuiApiBridge.cjs 的 IPC 桥**原样**包成
 * 「带令牌的 HTTP RPC + 音频反代」，让浏览器形态（以及将来的 iOS 壳）用同一个桥。
 *
 * 签名、解密、扫码登录一律不动，仍然跑在这台 Windows 的 Electron 里 —— 不碰风控、不需要逆向。
 *
 * 启动（注意本机全局设了 ELECTRON_RUN_AS_NODE，必须先去掉，否则 Electron 会被降级成纯 Node）：
 *   unset ELECTRON_RUN_AS_NODE
 *   npx electron electron/qishui-server.cjs [--config <path>] [--port 8787] [--host 127.0.0.1]
 *
 * 端点：
 *   GET  /healthz           探活（免令牌）
 *   GET  /rpc/_meta         版本 + operation 清单 + 能力（需令牌）
 *   POST /rpc/<operation>   body = params JSON；响应与 IPC 的 { ok, data|error } 信封逐字段一致
 *   GET  /a?u=&a=&t=        音频反代（保留 Range/HEAD/206；t 是设备令牌，因为 <audio> 设不了请求头）
 *   GET  /a?...&fmt=mp3     同上，但先在服务器上转成 MP3 落缓存（客户端放不了 AAC 时才走，见
 *                           qishui-audio-transcode.cjs；转码不可用或失败一律原样回退 AAC）
 *
 * 边界（路线A详细设计.md §5.2）：
 *   - 只绑回环，对外交给 Tailscale / 反向代理；本进程不做 TLS。
 *   - 从不向客户端下发任何汽水凭据（cookie / token / deviceId 全留在本机 userData）。
 *   - 日志只记 operation 名、状态与耗时，不记参数、不记请求头。
 *   - /a 的 `u` 是「替客户端下载任意 URL」，必须过 host 白名单，否则就是 SSRF 面。
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');

const { createQishuiApiBridge, QISHUI_OPERATIONS } = require('./qishuiApiBridge.cjs');
const { createAudioTranscoder, DEFAULT_CACHE_LIMIT_BYTES, DEFAULT_BITRATE } = require('./qishui-audio-transcode.cjs');

const REPO_ROOT = path.join(__dirname, '..');
const PACKAGE_JSON = require(path.join(REPO_ROOT, 'package.json'));
const APP_NAME = String(PACKAGE_JSON.productName || PACKAGE_JSON.name || 'Folia');
const SERVER_VERSION = String(PACKAGE_JSON.version || '0.0.0');

// ---------------------------------------------------------------- Electron 环境

const electron = (() => {
  try { return require('electron'); } catch (_) { return null; }
})();
// ELECTRON_RUN_AS_NODE=1 时 require('electron') 返回的是可执行文件路径字符串，没有 app。
const app = electron && typeof electron === 'object' ? electron.app : null;

if (!app || typeof app.whenReady !== 'function') {
  console.error('[qishui-server] 必须在 Electron 主进程里运行。');
  console.error('[qishui-server] 本机若设了 ELECTRON_RUN_AS_NODE，先去掉：unset ELECTRON_RUN_AS_NODE');
  console.error('[qishui-server] 然后：npx electron electron/qishui-server.cjs');
  process.exit(1);
}

// `electron electron/qishui-server.cjs` 的 appPath 是 <repo>/electron，那里没有 package.json，
// Electron 会退回 name='Electron' → userData 指向 %APPDATA%/Electron，与桌面版登录态错开。
// 这里按仓库 package.json 显式钉住桌面版的 userData 目录（必须在 ready 之前）。
app.setName(APP_NAME);
if (!String(process.env.QISHUI_SERVER_USER_DATA || '').trim()) {
  app.setPath('userData', path.join(app.getPath('appData'), APP_NAME));
}

const USER_DATA_DIR = app.getPath('userData');
const DEFAULT_CONFIG_PATH = path.join(USER_DATA_DIR, 'qishui-server.config.json');
const LOG_FILE = path.join(USER_DATA_DIR, 'qishui-server.log');

// ---------------------------------------------------------------- 参数与配置

function parseArgs(argv) {
  const options = { config: '', host: '', port: 0, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--config') options.config = String(argv[index += 1] || '');
    else if (arg === '--host') options.host = String(argv[index += 1] || '');
    else if (arg === '--port') options.port = Number(argv[index += 1] || 0) || 0;
  }
  return options;
}

const cli = parseArgs(process.argv.slice(2));

if (cli.help) {
  console.log('用法: npx electron electron/qishui-server.cjs [--config <path>] [--host 127.0.0.1] [--port 8787]');
  console.log('配置默认路径: ' + DEFAULT_CONFIG_PATH);
  process.exit(0);
}

// 只放实测会出现的域。注意别照抄桥里那套「选 Referer 用」的关键词：那是 includes 匹配，
// 而这里要求标签边界（host 等于白名单项或是它的子域），写 `douyin` 匹配不到 `douyinvod.com`。
// 实测音频直链落在 v11-luna.douyinvod.com，所以必须列 douyinvod.com。被拒的域名会写进日志，照着补即可。
const DEFAULT_AUDIO_HOST_ALLOWLIST = [
  'qishui.com',
  'douyinvod.com',
  'douyin.com',
  'douyinpic.com',
  'douyinstatic.com',
  'douyincdn.com',
  'byteimg.com',
  'bytecdntp.com',
  'pstatp.com',
  'snssdk.com',
  'bytedance.com',
];
// `http://localhost:*` 是端口通配（见 originAllowed）：开发期 Vite 端口会变，
// 而这一层的门槛从来不是 CORS 而是令牌，放宽成回环任意端口不会多开一扇门。
const DEFAULT_ALLOWED_ORIGINS = ['capacitor://localhost', 'http://localhost:*', 'http://127.0.0.1:*'];
const AUDIO_URL_MAX_LENGTH = 4096;
const AUDIO_AUTH_MAX_LENGTH = 1024;
const RPC_BODY_MAX_BYTES = 1024 * 1024;

// 首次运行时生成一份可直接用的配置：一枚令牌 + 只绑回环。写盘后把令牌打印到控制台
// （不进日志文件），用户把它填进客户端即可。
function createDefaultConfig() {
  return {
    bind: '127.0.0.1',
    port: 8787,
    publicBaseUrl: '',
    tokens: [{
      name: 'default',
      token: crypto.randomBytes(24).toString('hex'),
      createdAt: new Date().toISOString().slice(0, 10),
    }],
    allowedOrigins: DEFAULT_ALLOWED_ORIGINS.slice(),
    audio: {
      hostAllowlist: DEFAULT_AUDIO_HOST_ALLOWLIST.slice(),
      // 客户端要 fmt=mp3 时把整轨转成 MP3 落缓存（只在「放不了 AAC」的浏览器里有影响）。
      transcode: true,
      // 缓存上限（字节）；0 = 不设上限。
      cacheMaxBytes: DEFAULT_CACHE_LIMIT_BYTES,
      transcodeBitrate: DEFAULT_BITRATE,
    },
  };
}

function loadConfig(configPath) {
  let created = false;
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      raw = createDefaultConfig();
      created = true;
      try {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf8');
      } catch (writeError) {
        console.error('[qishui-server] 写配置失败:', (writeError && writeError.message) || writeError);
      }
    } else {
      console.error('[qishui-server] 读配置失败，按默认值启动:', (error && error.message) || error);
      raw = createDefaultConfig();
    }
  }
  const config = raw && typeof raw === 'object' ? raw : {};
  const tokens = Array.isArray(config.tokens)
    ? config.tokens.filter(entry => entry && String(entry.token || '').trim())
    : [];
  if (tokens.length === 0) {
    const token = crypto.randomBytes(24).toString('hex');
    tokens.push({ name: 'default', token, createdAt: new Date().toISOString().slice(0, 10) });
    created = true;
  }
  return {
    created,
    bind: String(cli.host || config.bind || '127.0.0.1'),
    port: Number(cli.port || config.port || 8787),
    publicBaseUrl: String(config.publicBaseUrl || '').replace(/\/+$/, ''),
    tokens,
    allowedOrigins: Array.isArray(config.allowedOrigins) && config.allowedOrigins.length
      ? config.allowedOrigins.map(value => String(value))
      : DEFAULT_ALLOWED_ORIGINS.slice(),
    audioHostAllowlist: Array.isArray(config.audio && config.audio.hostAllowlist) && config.audio.hostAllowlist.length
      ? config.audio.hostAllowlist.map(value => String(value).toLowerCase())
      : DEFAULT_AUDIO_HOST_ALLOWLIST.slice(),
    audioTranscode: !(config.audio && config.audio.transcode === false),
    audioCacheMaxBytes: config.audio && Number.isFinite(config.audio.cacheMaxBytes)
      ? config.audio.cacheMaxBytes
      : DEFAULT_CACHE_LIMIT_BYTES,
    audioTranscodeBitrate: (config.audio && String(config.audio.transcodeBitrate || '').trim()) || DEFAULT_BITRATE,
  };
}

const configPath = cli.config || String(process.env.QISHUI_SERVER_CONFIG || '').trim() || DEFAULT_CONFIG_PATH;
const config = loadConfig(configPath);

// ---------------------------------------------------------------- 日志

let logStream = null;
try {
  logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
} catch (_) {
  logStream = null;
}

// 只记「谁被调、成没成、多久」；参数与请求头一概不落盘（可能带凭据）。
function logLine(line) {
  const stamp = new Date().toISOString();
  const text = '[' + stamp + '] ' + line;
  console.log(text);
  if (logStream) logStream.write(text + '\n');
}

// ---------------------------------------------------------------- 令牌与 CORS

function tokenMatches(candidate, expected) {
  const a = Buffer.from(String(candidate || ''), 'utf8');
  const b = Buffer.from(String(expected || ''), 'utf8');
  if (a.length === 0 || a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function findToken(candidate) {
  if (!candidate) return null;
  for (const entry of config.tokens) {
    if (tokenMatches(candidate, entry.token)) return entry;
  }
  return null;
}

function readBearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1].trim() : '';
}

function originAllowed(origin) {
  if (!origin) return false;
  for (const pattern of config.allowedOrigins) {
    if (pattern === '*') return true;
    // 支持 `http://localhost:*` 这种端口通配：开发期端口会变，写死一个很难用。
    const wildcard = /^(.*):\*$/.exec(pattern);
    if (wildcard) {
      if (origin === wildcard[1] || origin.startsWith(wildcard[1] + ':')) return true;
      continue;
    }
    if (pattern === origin) return true;
  }
  return false;
}

function corsHeaders(req) {
  const origin = String(req.headers.origin || '');
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '600',
  };
  // 令牌走 Authorization 头，不依赖 Cookie，所以这里不需要 Allow-Credentials。
  if (originAllowed(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function sendJson(req, res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length),
    'Cache-Control': 'no-store',
  }, corsHeaders(req)));
  res.end(body);
}

function failureEnvelope(code, message) {
  return { ok: false, error: { code, message } };
}

// 转码后的音频由本进程供片（不走上游），但 CORS 得和直通那条路一模一样。
function audioCorsHeaders(req) {
  return Object.assign(corsHeaders(req), {
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
  });
}

// ---------------------------------------------------------------- 音频反代（SSRF 白名单）

// 比桥里选 Referer 的那套 `includes` 严格：只有「等于白名单」或「是它的子域」才算过，
// 否则 `evilqishui.com` 这种仿冒域也会 `.includes('qishui.com')` 命中。
function audioHostAllowed(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch (_) {
    return { ok: false, reason: 'u 不是合法 URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'u 的协议只允许 http/https' };
  }
  const host = parsed.hostname.toLowerCase();
  const allowed = config.audioHostAllowlist.some(hint => host === hint || host.endsWith('.' + hint));
  if (!allowed) return { ok: false, reason: 'u 的 host 不在 audio.hostAllowlist 里: ' + host };
  return { ok: true, host };
}

function buildLoopbackAudioUrl(cleanUrl, auth) {
  const info = bridge.getAudioInfo();
  if (!info || !info.port) return '';
  const query = new URLSearchParams({ u: cleanUrl, a: auth || '' });
  // 路径里的随机 token 是桥自己的鉴权：只有本机能拼出这条地址。
  return 'http://' + info.host + ':' + info.port + '/' + info.token + '/' + info.route + '?' + query.toString();
}

const AUDIO_RESPONSE_HEADERS = [
  'content-type',
  'content-length',
  'content-range',
  'accept-ranges',
  'cache-control',
  'etag',
  'last-modified',
];

function handleAudioRequest(req, res, url) {
  const cleanUrl = url.searchParams.get('u') || '';
  const auth = url.searchParams.get('a') || '';
  if (!cleanUrl || cleanUrl.length > AUDIO_URL_MAX_LENGTH) {
    sendJson(req, res, 400, failureEnvelope('invalid-response', 'u 缺失或过长'));
    return;
  }
  if (auth.length > AUDIO_AUTH_MAX_LENGTH) {
    sendJson(req, res, 400, failureEnvelope('invalid-response', 'a 过长'));
    return;
  }
  const verdict = audioHostAllowed(cleanUrl);
  if (!verdict.ok) {
    logLine('403 GET /a (' + verdict.reason + ')');
    sendJson(req, res, 403, failureEnvelope('unavailable', verdict.reason));
    return;
  }
  const target = buildLoopbackAudioUrl(cleanUrl, auth);
  if (!target) {
    sendJson(req, res, 503, failureEnvelope('unavailable', '音频代理还没起来（先请求一次 song.url）'));
    return;
  }

  // 客户端自报放不了 AAC（能力探针）时才带 fmt=mp3：先在服务器上把整轨转成 MP3 落缓存，再本地
  // Range 供片。转码不可用/失败一律原样回退到下面的直通 —— 这条分支不能让任何请求变得更糟。
  if (url.searchParams.get('fmt') === 'mp3' && transcoder.isEnabled()) {
    const startedAt = Date.now();
    transcoder.ensure(target, cleanUrl)
      .then(entry => {
        if (res.writableEnded || res.destroyed) return;
        logLine('OK   ' + req.method + ' /a ' + (entry.cached ? '转码缓存命中' : '新转码') + ' '
          + entry.size + 'B ' + (Date.now() - startedAt) + 'ms');
        return transcoder.serve(req, res, entry.path, audioCorsHeaders(req));
      })
      .catch(error => {
        logLine('WARN GET /a 转码不可用，回退原样: ' + ((error && error.message) || error));
        if (res.headersSent || res.writableEnded) { res.destroy(); return; }
        proxyAudioUpstream(req, res, target);
      });
    return;
  }
  proxyAudioUpstream(req, res, target);
}

/** 原样透传到桥的 loopback 音频路由：Range/HEAD/206 都跟着上游走，字节一个不改。 */
function proxyAudioUpstream(req, res, target) {
  const upstream = http.request(target, {
    method: req.method,
    headers: {
      ...(req.headers.range ? { Range: String(req.headers.range) } : {}),
    },
  }, upstreamRes => {
    const headers = Object.assign({}, corsHeaders(req));
    for (const name of AUDIO_RESPONSE_HEADERS) {
      if (upstreamRes.headers[name] !== undefined) headers[name] = upstreamRes.headers[name];
    }
    headers['Access-Control-Expose-Headers'] = 'Content-Length, Content-Range, Accept-Ranges';
    res.writeHead(upstreamRes.statusCode || 502, headers);
    upstreamRes.pipe(res);
  });
  upstream.on('error', error => {
    logLine('502 GET /a upstream: ' + ((error && error.message) || error));
    if (!res.headersSent) sendJson(req, res, 502, failureEnvelope('network', '音频上游失败'));
    else res.destroy();
  });
  // 客户端中途换歌/断开时别把上游连接挂住。
  res.on('close', () => upstream.destroy());
  upstream.end();
}

// ---------------------------------------------------------------- RPC

// 唯一的返回值改写点：桥把 `song.url` 写成 loopback 代理地址，服务器把它换成客户端可达的形态。
// 其余 operation 一律原样透传（审计面越小越好）。
function rewriteSongUrlPayload(req, data, deviceToken) {
  if (!data || typeof data !== 'object' || !data.url || data.localProxy !== true) return data;
  let parsed;
  try {
    parsed = new URL(String(data.url));
  } catch (_) {
    return data;
  }
  const cleanUrl = parsed.searchParams.get('u') || '';
  const auth = parsed.searchParams.get('a') || '';
  if (!cleanUrl) return data;
  const host = String(req.headers.host || '').trim();
  const base = config.publicBaseUrl || (host ? 'http://' + host : 'http://127.0.0.1:' + config.port);
  const query = new URLSearchParams({ u: cleanUrl, a: auth, t: deviceToken });
  return Object.assign({}, data, { url: base + '/a?' + query.toString(), upstreamUrl: cleanUrl });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > RPC_BODY_MAX_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleRpcRequest(req, res, operation, tokenEntry) {
  let params = {};
  if (req.method === 'POST') {
    const body = await readJsonBody(req);
    if (body.trim()) {
      try {
        params = JSON.parse(body);
      } catch (_) {
        sendJson(req, res, 400, failureEnvelope('invalid-response', 'body 不是合法 JSON'));
        return;
      }
      if (!params || typeof params !== 'object' || Array.isArray(params)) {
        sendJson(req, res, 400, failureEnvelope('invalid-response', 'body 必须是对象'));
        return;
      }
    }
  } else if (req.method !== 'GET') {
    sendJson(req, res, 405, failureEnvelope('unsupported', '只支持 GET/POST'));
    return;
  }

  if (!QISHUI_OPERATIONS.includes(operation)) {
    sendJson(req, res, 404, failureEnvelope('unsupported', '未知 operation: ' + operation));
    return;
  }

  const startedAt = Date.now();
  let envelope;
  try {
    envelope = await bridge.request(operation, params);
  } catch (error) {
    envelope = failureEnvelope('unavailable', (error && error.message) || String(error));
  }
  if (envelope && envelope.ok && operation === 'song.url') {
    envelope = { ok: true, data: rewriteSongUrlPayload(req, envelope.data, tokenEntry.token) };
  }
  const duration = Date.now() - startedAt;
  const failed = envelope && envelope.ok === false;
  logLine((failed ? 'ERR ' : 'OK  ') + req.method + ' /rpc/' + operation + ' ' + duration + 'ms'
    + (failed ? ' ' + String((envelope.error && envelope.error.code) || '') : ''));
  sendJson(req, res, 200, envelope);
}

// ---------------------------------------------------------------- 服务器

const bridge = createQishuiApiBridge({ userDataDir: USER_DATA_DIR, warn: message => logLine('WARN ' + message) });

// 只在客户端明确要 fmt=mp3 时才会被碰到。这里建好，启动后异步探一次 ffmpeg（探不到就原样回退 AAC）。
const transcoder = createAudioTranscoder({
  cacheDir: path.join(USER_DATA_DIR, 'qishui-audio-cache'),
  enabled: config.audioTranscode,
  maxBytes: config.audioCacheMaxBytes,
  bitrate: config.audioTranscodeBitrate,
  log: message => logLine('[转码] ' + message),
});

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(String(req.url || '/'), 'http://127.0.0.1');
  } catch (_) {
    sendJson(req, res, 400, failureEnvelope('invalid-response', 'URL 解析失败'));
    return;
  }
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }

  if (pathname === '/healthz') {
    sendJson(req, res, 200, { ok: true, name: APP_NAME, version: SERVER_VERSION });
    return;
  }

  if (pathname === '/rpc/_meta') {
    const tokenEntry = findToken(readBearerToken(req));
    if (!tokenEntry) {
      sendJson(req, res, 401, failureEnvelope('server-auth-required', '令牌无效或缺失'));
      return;
    }
    sendJson(req, res, 200, {
      ok: true,
      data: {
        name: APP_NAME,
        version: SERVER_VERSION,
        operations: QISHUI_OPERATIONS.slice(),
        capabilities: {
          audioProxy: true,
          audioTranscode: transcoder.isEnabled(),
          publicBaseUrl: config.publicBaseUrl || null,
        },
      },
    });
    return;
  }

  if (pathname === '/a') {
    // <audio> 设不了请求头，所以音频端点额外接受 `?t=`；两者都走同一套常量时间比较。
    const tokenEntry = findToken(readBearerToken(req)) || findToken(url.searchParams.get('t'));
    if (!tokenEntry) {
      sendJson(req, res, 401, failureEnvelope('server-auth-required', '令牌无效或缺失'));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(req, res, 405, failureEnvelope('unsupported', '只支持 GET/HEAD'));
      return;
    }
    handleAudioRequest(req, res, url);
    return;
  }

  if (pathname.startsWith('/rpc/')) {
    const tokenEntry = findToken(readBearerToken(req));
    if (!tokenEntry) {
      sendJson(req, res, 401, failureEnvelope('server-auth-required', '令牌无效或缺失'));
      return;
    }
    const operation = decodeURIComponent(pathname.slice('/rpc/'.length));
    handleRpcRequest(req, res, operation, tokenEntry).catch(error => {
      if (!res.headersSent) sendJson(req, res, 500, failureEnvelope('unavailable', (error && error.message) || String(error)));
    });
    return;
  }

  sendJson(req, res, 404, failureEnvelope('unsupported', '未知路径: ' + pathname));
});

// 隐藏签名窗口被销毁时不能让 Electron 顺手把整个进程退掉——我们是服务器，得一直挂着。
app.on('window-all-closed', () => {});

function shutdown(signal) {
  logLine('收到 ' + signal + '，正在退出');
  try { server.close(); } catch (_) { /* 已经关了 */ }
  try { bridge.dispose(); } catch (_) { /* 忽略 */ }
  if (logStream) logStream.end();
  app.quit();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

app.whenReady().then(() => {
  void transcoder.init();
  server.on('error', error => {
    // EADDRINUSE 几乎总是「上一个服务器还活着」（关窗口杀不掉 Electron，得杀 electron.exe）。
    const detail = error && error.code === 'EADDRINUSE'
      ? '端口 ' + config.port + ' 已被占用，可能已经有一个服务器在跑。查：netstat -ano | findstr ' + config.port
      : ((error && error.message) || error);
    logLine('监听失败: ' + detail);
    process.exitCode = 1;
    app.quit();
  });
  server.listen(config.port, config.bind, () => {
    logLine('汽水音源服务器已启动 http://' + config.bind + ':' + config.port
      + ' · userData=' + USER_DATA_DIR + ' · operations=' + QISHUI_OPERATIONS.length + ' · 令牌=' + config.tokens.length);
    logLine('配置: ' + configPath + ' · 日志: ' + LOG_FILE);
    if (config.created) {
      // 只在「这一份配置是刚生成的」时把令牌打到控制台，方便直接抄进 .env.local；不写进日志文件。
      console.log('[qishui-server] 新生成的令牌（写进客户端配置，勿外传）:');
      for (const entry of config.tokens) console.log('  ' + entry.name + ': ' + entry.token);
    }
  });
});
