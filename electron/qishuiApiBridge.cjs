'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');

const { createQishuiCredentials } = require('./qishui/credentials.cjs');

// electron/qishuiApiBridge.cjs

// 汽水音乐（Qishui / SodaMusic）主进程桥。
// 三层结构：协议层 electron/qishui/qishui-api.js（纯 Node）→ 签名/登录层
// electron/qishui/qishui-auth-v6.js（依赖 Electron + qrcode + bdms.node）→ 本桥（IPC 派发 + 本地音频代理）。
// 与 Mineradio X 的差别只有三处：凭据落到 app.getPath('userData')、不写诊断日志、加密音频改由本进程
// 的 loopback 代理解密后喂给 HTML5 <audio>（Range 请求按 server.js sendAudioBuffer 的逻辑实现）。

const QISHUI_AUDIO_DECRYPT_CACHE_MAX_BYTES = 96 * 1024 * 1024;
const QISHUI_AUDIO_ROUTE = 'audio';
const QISHUI_AUDIO_PROXY_HOST = '127.0.0.1';
// 汽水/字节自家 CDN 需要 qishui 的 Referer，其它源沿用 Mineradio 的网易云 Referer 兜底。
const QISHUI_AUDIO_CDN_HOST_HINTS = ['qishui.com', 'byteimg.com', 'douyin', 'bytedance'];
const QISHUI_AUDIO_PROXY_UA = 'Folia/0.7.13 (Qishui audio proxy)';

// 与 qishui-api.js 的 qishuiUnavailable() / restriction.category 对齐的短横线错误码。
function qishuiErrorCode(value) {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// 照抄 server.js 的 parseInt(x || '默认', 10) || 默认 语义：解析失败或得 0 都回落到默认值，再夹到区间内。
function qishuiClampInt(value, fallback, min, max) {
  const raw = value === undefined || value === null || value === '' ? String(fallback) : String(value);
  const parsed = parseInt(raw, 10) || fallback;
  return Math.max(min, Math.min(max, parsed));
}

// 上游音频 URL 用 '#auth=' 携带 spade_a 密钥；分离出可直连的 cleanUrl 与密钥本身。
function qishuiAudioAuthFromUrl(audioUrl) {
  const text = String(audioUrl || '');
  const idx = text.indexOf('#auth=');
  if (idx < 0) return { cleanUrl: text, auth: '' };
  let auth = '';
  try {
    auth = decodeURIComponent(text.slice(idx + 6));
  } catch (_) {
    auth = text.slice(idx + 6);
  }
  return { cleanUrl: text.slice(0, idx), auth };
}

function qishuiAudioCacheKey(cleanUrl, auth) {
  return crypto.createHash('sha1').update(String(cleanUrl || '') + '\n' + String(auth || '')).digest('hex');
}

function qishuiAudioProxyHeadersFor(audioUrl, range) {
  const headers = { 'User-Agent': QISHUI_AUDIO_PROXY_UA, Referer: 'https://music.163.com/' };
  let host = '';
  try {
    host = new URL(String(audioUrl)).host;
  } catch (_) {
    host = '';
  }
  if (QISHUI_AUDIO_CDN_HOST_HINTS.some(hint => host.indexOf(hint) >= 0)) {
    headers.Referer = 'https://www.qishui.com/';
  }
  if (range) headers.Range = range;
  return headers;
}

function qishuiAudioCorsHeaders(contentType) {
  return {
    'Content-Type': contentType || 'audio/mp4',
    'Access-Control-Allow-Origin': '*',
    'Accept-Ranges': 'bytes',
  };
}

// 直接把内存里的音频按 RFC 7233 切给客户端（照 server.js:4065-4105 sendAudioBuffer）。
function qishuiSendAudioBuffer(res, buffer, contentType, range) {
  const total = buffer.length;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(range || ''));
  if (match) {
    let start = match[1] ? Number(match[1]) : 0;
    let end = match[2] ? Number(match[2]) : total - 1;
    if (!Number.isFinite(start) || start < 0) start = 0;
    if (!Number.isFinite(end) || end >= total) end = total - 1;
    if (start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + total });
      res.end();
      return;
    }
    res.writeHead(206, Object.assign(qishuiAudioCorsHeaders(contentType), {
      'Content-Length': end - start + 1,
      'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
    }));
    res.end(buffer.subarray(start, end + 1));
    return;
  }
  res.writeHead(200, Object.assign(qishuiAudioCorsHeaders(contentType), { 'Content-Length': total }));
  res.end(buffer);
}

// 渲染层只接受 ok/data 信封；这里声明哪些 operation 的结果需要额外判据才算成功
// （协议层习惯用 HTTP 200 + error 字段表达降级，不能把空壳当数据交给 UI）。返回 true 表示失败。
const QISHUI_RESULT_FAILURES = {
  'song.url': result => !result || result.playable === false || !result.url,
  'song.detail': result => !result || !result.song,
  album: result => !result || !result.album,
  lyric: result => !!(result && result.error && !result.lyric),
  comments: result => !!(result && result.error),
  'track.liked': result => !!(result && result.error),
  'track.like': result => !!(result && (result.ok === false || result.success === false)),
  'playlist.collect': result => !!(result && (result.ok === false || result.success === false)),
  'playlist.addSong': result => !!(result && (result.ok === false || result.success === false)),
  'album.collect': result => !!(result && (result.ok === false || result.success === false)),
  'report.play': result => !!(result && (result.ok === false || result.success === false)),
  'comment.create': result => !!(result && (result.ok === false || result.success === false)),
};

const QISHUI_OPERATIONS = Object.freeze([
  'status',
  'login.qr',
  'login.check',
  'login.logout',
  'search',
  'artist',
  'song.detail',
  'album',
  'lyric',
  'song.url',
  'feed',
  'user.playlists',
  'playlist.tracks',
  'track.liked',
  'track.like',
  'playlist.collect',
  'playlist.addSong',
  'album.collect',
  'report.play',
  'comments',
  'comment.create',
]);

// 抛出的桥级失败：qishuiCode 直接作为对外 error.code，避免被 Error.code（如 ENOENT）覆盖。
function qishuiBridgeFailure(code, message) {
  const error = new Error(String(message || code || 'Qishui request failed'));
  error.qishuiCode = qishuiErrorCode(code) || 'qishui-error';
  return error;
}

function qishuiResultMessage(result) {
  if (!result || typeof result !== 'object') return '';
  const candidates = [result.message, result.restriction && result.restriction.message, result.error];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function qishuiFailureFromResult(operation, result) {
  const category = result && (result.reason || (result.restriction && result.restriction.category));
  const raw = category || (result && (result.error || result.errorCode)) || '';
  return {
    ok: false,
    error: {
      code: qishuiErrorCode(raw) || 'qishui-error',
      message: qishuiResultMessage(result) || 'Qishui ' + operation + ' failed',
    },
  };
}

function qishuiFailureEnvelope(error, operation) {
  const raw = (error && (error.qishuiCode || error.code)) || '';
  const message = String((error && error.message) || ('Qishui ' + operation + ' failed'));
  // 登录态缺失是渲染层最常分支的失败；协议的 *_COOKIE_REQUIRED / login 文案统一归到 login-required。
  const code = qishuiErrorCode(raw) || (/COOKIE_REQUIRED|login|not logged/i.test(message) ? 'login-required' : 'qishui-error');
  return { ok: false, error: { code, message } };
}

function createQishuiApiBridge({ userDataDir, warn = console.warn } = {}) {
  const credentials = createQishuiCredentials({ userDataDir, warn });

  // 协议层与扫码桥都在模块加载期读这些环境变量来决定凭据文件位置，所以必须在 require 之前写入。
  // 已存在的非空值优先（便于开发期用环境变量指向别处）。
  const QISHUI_ENV_BINDINGS = {
    QISHUI_COOKIE_FILE: credentials.paths.cookie,
    QISHUI_TOKEN_FILE: credentials.paths.token,
    QISHUI_QR_CONFIG_FILE: credentials.paths.qrConfig,
    QISHUI_OAUTH_CONFIG_FILE: credentials.paths.oauthConfig,
  };
  for (const [key, value] of Object.entries(QISHUI_ENV_BINDINGS)) {
    if (!String(process.env[key] || '').trim()) process.env[key] = value;
  }

  // 三个重依赖全部惰性加载：qishui-auth-v6 一旦加载就会在 initialize() 里建隐藏窗口，
  // 启动期不应该为没被用到的 provider 付这个代价。
  let apiModule = null;
  function qishuiApi() {
    if (!apiModule) apiModule = require('./qishui/qishui-api.js');
    return apiModule;
  }

  let qrLoginModule = null;
  function qishuiQrLogin() {
    if (!qrLoginModule) qrLoginModule = require('./qishui/qishui-qr-login.js');
    return qrLoginModule;
  }

  let audioDecryptor = null;
  function qishuiDecryptor() {
    if (!audioDecryptor) {
      const { TrackDecryptor } = require('./qishui/qishui-audio-decryptor/track-decryptor.js');
      audioDecryptor = new TrackDecryptor();
    }
    return audioDecryptor;
  }

  // ---- 凭据：cookie 只由桥读写，token / qr / oauth 由协议层按环境变量路径自理 ----

  let cookieCache = { mtimeMs: -1, value: '' };

  // 按 mtime 惰性重读 cookie 文件（照 server.js 的 refreshConfiguredCookieStore 思路），
  // 外部改动（比如手动放一份 cookie）不需要重启就能生效。
  function readQishuiCookie() {
    try {
      const stat = fs.statSync(credentials.paths.cookie);
      if (stat.mtimeMs !== cookieCache.mtimeMs) {
        cookieCache = { mtimeMs: stat.mtimeMs, value: credentials.readCookie() };
      }
      return cookieCache.value;
    } catch (_) {
      cookieCache = { mtimeMs: -1, value: '' };
      return '';
    }
  }

  function saveQishuiCookie(value) {
    const normalized = qishuiApi().normalizeQishuiCookieInput(value) || String(value || '').replace(/\s+/g, ' ').trim();
    const saved = credentials.writeCookie(normalized);
    cookieCache = { mtimeMs: -1, value: saved };
    return saved;
  }

  // ---- loopback 音频代理：把汽水的加密直链解密成 <audio> 能吃的本地 URL ----

  const audioCache = new Map();
  let audioCacheBytes = 0;
  const audioToken = crypto.randomBytes(24).toString('hex');
  let audioServer = null;
  let audioServerPort = 0;
  let audioServerPromise = null;

  // LRU 淘汰：超上限时反复丢弃最久未访问的一条（照 server.js rememberQishuiDecryptedAudio）。
  function rememberDecryptedAudio(key, payload) {
    audioCache.set(key, Object.assign({ at: Date.now() }, payload));
    audioCacheBytes += payload.buffer.length;
    while (audioCacheBytes > QISHUI_AUDIO_DECRYPT_CACHE_MAX_BYTES && audioCache.size > 1) {
      let oldestKey = null;
      let oldestAt = Infinity;
      for (const [candidateKey, entry] of audioCache) {
        if (entry.at < oldestAt) {
          oldestAt = entry.at;
          oldestKey = candidateKey;
        }
      }
      if (oldestKey === null) break;
      const evicted = audioCache.get(oldestKey);
      audioCache.delete(oldestKey);
      audioCacheBytes -= evicted.buffer.length;
    }
  }

  // 解密一次并缓存；返回 null 表示这条 URL 本来就没有加密（无需代理）。
  async function getDecryptedAudio(audioUrl) {
    const parsed = qishuiAudioAuthFromUrl(audioUrl);
    if (!parsed.auth) return null;
    const key = qishuiAudioCacheKey(parsed.cleanUrl, parsed.auth);
    const cached = audioCache.get(key);
    if (cached) {
      cached.at = Date.now();
      return cached;
    }
    const upstream = await fetch(parsed.cleanUrl, { headers: qishuiAudioProxyHeadersFor(parsed.cleanUrl, '') });
    if (!upstream.ok) throw new Error('Qishui encrypted audio fetch failed: HTTP ' + upstream.status);
    const encryptedBuffer = Buffer.from(await upstream.arrayBuffer());
    const result = qishuiDecryptor().decrypt({ encryptedBuffer, spadeA: parsed.auth });
    const payload = {
      buffer: result.buffer,
      contentType: result.extension === '.flac' ? 'audio/flac' : 'audio/mp4',
      extension: result.extension,
    };
    rememberDecryptedAudio(key, payload);
    return payload;
  }

  // 只有持有随机 token 的本机请求才被受理，避免其它本地程序借这个端口读取汽水音频。
  function handleAudioProxyRequest(req, res) {
    let url;
    try {
      url = new URL(String(req.url || '/'), 'http://' + QISHUI_AUDIO_PROXY_HOST);
    } catch (_) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad request');
      return;
    }
    if (url.pathname !== '/' + audioToken + '/' + QISHUI_AUDIO_ROUTE) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Range' });
      res.end();
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Method not allowed');
      return;
    }
    const cleanUrl = url.searchParams.get('u') || '';
    const auth = url.searchParams.get('a') || '';
    if (!cleanUrl) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Missing audio url');
      return;
    }
    if (!auth) {
      // 未加密直链本来就不该走代理；真被请求就交给浏览器自己直连。
      res.writeHead(302, { Location: cleanUrl });
      res.end();
      return;
    }
    getDecryptedAudio(cleanUrl + '#auth=' + encodeURIComponent(auth))
      .then(payload => {
        if (req.method === 'HEAD') {
          res.writeHead(200, Object.assign(qishuiAudioCorsHeaders(payload.contentType), {
            'Content-Length': payload.buffer.length,
          }));
          res.end();
          return;
        }
        qishuiSendAudioBuffer(res, payload.buffer, payload.contentType, req.headers.range);
      })
      .catch(error => {
        if (warn) warn('[QishuiAudio] Decrypt proxy failed', error && error.message);
        if (res.headersSent) {
          res.end();
          return;
        }
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Qishui audio unavailable: ' + String((error && error.message) || error));
      });
  }

  // 端口固定为 0（内核分配），只绑回环地址。
  function ensureAudioServer() {
    if (audioServer && audioServerPort) return Promise.resolve(audioServerPort);
    if (audioServerPromise) return audioServerPromise;
    audioServerPromise = new Promise((resolve, reject) => {
      const server = http.createServer(handleAudioProxyRequest);
      server.once('error', error => {
        audioServerPromise = null;
        reject(error);
      });
      server.listen(0, QISHUI_AUDIO_PROXY_HOST, () => {
        audioServer = server;
        audioServerPort = server.address().port;
        resolve(audioServerPort);
      });
    });
    return audioServerPromise;
  }

  function buildAudioProxyUrl(cleanUrl, auth) {
    return 'http://' + QISHUI_AUDIO_PROXY_HOST + ':' + audioServerPort + '/' + audioToken + '/' + QISHUI_AUDIO_ROUTE
      + '?u=' + encodeURIComponent(cleanUrl)
      + (auth ? '&a=' + encodeURIComponent(auth) : '');
  }

  function disposeAudioServer() {
    if (!audioServer) return;
    try {
      audioServer.close();
    } catch (error) {
      if (warn) warn('[QishuiAudio] Failed to close the loopback audio proxy', error && error.message);
    }
    audioServer = null;
    audioServerPort = 0;
    audioServerPromise = null;
  }

  // 隐藏的签名窗口（qishui-auth-v6 里的 BrowserWindow）是一个真实窗口：只要它还开着，
  // Electron 就不会触发 'window-all-closed'，于是主窗口关掉后 app.quit() 永远不被调用，
  // 进程就留在后台（无窗口、只剩托盘）退不出去。
  // 注意：只在 auth 模块**已经被加载过**时销毁它 —— 绝不能为了让 dispose 有东西可销毁而
  // 主动 require，那反而会在退出路径上把签名宿主创建出来。
  function disposeAuthRuntime() {
    let authModule = null;
    try {
      const modulePath = require.resolve('./qishui/qishui-auth-v6.js');
      const cached = require.cache[modulePath];
      authModule = cached ? cached.exports : null;
    } catch (_) {
      authModule = null;
    }
    if (!authModule || typeof authModule.destroyWindow !== 'function') return;
    try {
      const pending = authModule.destroyWindow();
      if (pending && typeof pending.catch === 'function') {
        pending.catch(error => {
          if (warn) warn('[Qishui] Failed to destroy the hidden signing window', error && error.message);
        });
      }
    } catch (error) {
      if (warn) warn('[Qishui] Failed to destroy the hidden signing window', error && error.message);
    }
  }

  // 主窗口关闭 / before-quit 时调用：先收隐藏窗口（它挡着 'window-all-closed'），再释放端口。
  // 幂等，可重复调用。
  function dispose() {
    disposeAuthRuntime();
    disposeAudioServer();
  }

  // 提前起服务，让第一次 song.url 不必等监听完成。失败只降级为「无本地代理」，不影响其它 operation。
  ensureAudioServer().catch(error => {
    if (warn) warn('[QishuiAudio] Loopback audio proxy unavailable', error && error.message);
  });

  // ---- operation 派发（参数归一化照抄 server.js 的 qishui 路由段）----

  const handlers = {
    status: () => qishuiApi().handleQishuiStatus(readQishuiCookie()),

    'login.qr': async () => {
      const result = await qishuiQrLogin().createQrCode();
      const data = (result && result.data) || {};
      return {
        provider: 'qishui',
        token: String(data.token || ''),
        qrcode: String(data.qrcode || ''),
        qrcodeIndexUrl: String(data.qrcode_index_url || ''),
        expireTime: Number(data.expire_time || 0),
        message: '请使用抖音 App 扫码并确认登录',
      };
    },

    'login.check': async params => {
      const token = String((params && params.token) || '').trim();
      if (!token) throw qishuiBridgeFailure('missing-token', '二维码登录 token 缺失');
      const api = qishuiApi();
      const bridge = qishuiQrLogin();
      let result;
      try {
        result = await bridge.checkQrConnect(token);
      } catch (error) {
        if (error && error.code === 'QISHUI_MFA_CANCELLED') {
          throw qishuiBridgeFailure('mfa-cancelled', error.message || '汽水音乐登录已取消');
        }
        throw error;
      }
      const data = (result && result.data) || {};
      const errorCode = Number(data.error_code || 0);
      if (bridge.getStatus().loggedIn) {
        const cookie = bridge.getCookie();
        if (!api.qishuiCookieHasLogin(cookie)) {
          throw qishuiBridgeFailure('qishui-qr-session-cookie-missing', '二维码登录未返回有效的会话 Cookie');
        }
        saveQishuiCookie(cookie);
        const status = await api.handleQishuiStatus(readQishuiCookie());
        return Object.assign({}, status, {
          provider: 'qishui',
          ok: true,
          loggedIn: true,
          webSession: true,
          cookieReady: true,
          status: 'confirmed',
          errorCode: 0,
          error_code: 0,
          message: '登录成功',
        });
      }
      // 上游状态词（2026-10-07 实测）：**未扫码时** `/passport/web/check_qrconnect/` 返回
      // `status: 'new'` + `error_code: 0`。MRX 原来 server.js:7572-7576 的映射只认
      // ''/'1'（waiting）与 '2'（scanned），'new' 会被原样放过去 → 渲染层不认识这个状态
      // 就落进 default 分支显示「登录错误」，于是还没扫码就报错。这里补全词表并把默认值
      // 定为 waiting：未知状态宁可继续等，也不要凭空报错。
      const rawStatus = String(data.status || '').trim().toLowerCase();
      let status = 'waiting';
      if (errorCode === 2 || /^(4|5|expired|timeout)$/.test(rawStatus)) status = 'expired';
      else if (errorCode === 7) status = 'rate_limited';
      else if (/^(2|scanned|scan)$/.test(rawStatus)) status = 'scanned';
      else if (/^(3|confirmed|confirm)$/.test(rawStatus)) status = 'confirmed';
      return {
        provider: 'qishui',
        loggedIn: false,
        status,
        errorCode,
        error_code: errorCode,
        retryAfterMs: errorCode === 7 ? 60000 : 0,
        message: (result && result.message) || data.description || '',
      };
    },

    'login.logout': async () => {
      const api = qishuiApi();
      await qishuiQrLogin().clear();
      saveQishuiCookie('');
      const cleared = api.clearQishuiAccessToken();
      const empty = api.getQishuiStatus('');
      return Object.assign({}, cleared, {
        webSession: false,
        cookieReady: false,
        configured: empty.configured,
        loggedIn: empty.loggedIn,
      });
    },

    search: params => {
      const p = params || {};
      const keywords = String(p.keywords || '');
      const limit = qishuiClampInt(p.limit, 12, 4, 20);
      const offset = qishuiClampInt(p.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      return qishuiApi().handleQishuiSearch(keywords, limit, readQishuiCookie(), offset);
    },

    artist: params => {
      const p = params || {};
      const artistId = String(p.artistId || '');
      const artistName = String(p.artistName || '');
      const limit = qishuiClampInt(p.limit, 36, 10, 50);
      if (!artistId && !artistName) throw qishuiBridgeFailure('missing-artist-id-or-name', '汽水音乐需要艺人 ID 或名称');
      return qishuiApi().handleQishuiArtistDetail({ artistId, artistName, limit }, readQishuiCookie());
    },

    'song.detail': params => qishuiApi().handleQishuiSongDetail(String((params && params.id) || '')),

    album: params => {
      const p = params || {};
      const id = String(p.id || '');
      const trackId = String(p.trackId || '');
      const limit = qishuiClampInt(p.limit, 80, 10, 120);
      if (!id && !trackId) throw qishuiBridgeFailure('missing-album-id', '汽水音乐需要专辑 ID 或曲目 ID');
      return qishuiApi().handleQishuiAlbumDetail(id, readQishuiCookie(), limit, trackId);
    },

    lyric: params => qishuiApi().handleQishuiLyric(String((params && params.id) || ''), readQishuiCookie()),

    // 唯一的「改写返回值」operation：把带 #auth= 的加密直链换成 loopback 代理 URL，
    // 让渲染层可以把它直接交给 HTML5 <audio>。无 #auth= 的直链原样返回。
    'song.url': async params => {
      const p = params || {};
      const result = await qishuiApi().handleQishuiSongUrl({ id: String(p.id || ''), quality: String(p.quality || '') }, readQishuiCookie());
      if (!result || result.playable === false || !result.url) return result;
      const parsed = qishuiAudioAuthFromUrl(result.url);
      if (!parsed.auth) return result;
      await ensureAudioServer();
      return Object.assign({}, result, {
        url: buildAudioProxyUrl(parsed.cleanUrl, parsed.auth),
        upstreamUrl: parsed.cleanUrl,
        localProxy: true,
      });
    },

    feed: params => qishuiApi().handleQishuiFeed(qishuiClampInt((params || {}).limit, 8, 4, 12), readQishuiCookie()),

    'user.playlists': () => qishuiApi().handleQishuiUserPlaylists(readQishuiCookie()),

    'playlist.tracks': params => {
      const p = params || {};
      const id = String(p.id || '') || 'qishui-feed';
      const limit = qishuiClampInt(p.limit, 0, 0, Number.MAX_SAFE_INTEGER);
      const offset = qishuiClampInt(p.offset, 0, 0, Number.MAX_SAFE_INTEGER);
      // 只有显式给了分页参数才传 opts，否则让协议层走虚拟歌单的默认整包返回。
      return qishuiApi().handleQishuiPlaylistTracks(id, limit || offset ? { limit: limit || 50, offset } : {}, readQishuiCookie());
    },

    'track.liked': params => {
      const raw = Array.isArray((params || {}).ids) ? params.ids.join(',') : String((params || {}).ids || '');
      const ids = raw.split(',').map(value => value.trim()).filter(Boolean);
      return qishuiApi().handleQishuiCheckTracksLiked(ids, readQishuiCookie());
    },

    'track.like': async params => {
      const p = params || {};
      const liked = String(p.liked != null ? p.liked : 'true') !== 'false';
      const result = await qishuiApi().handleQishuiSetTrackLiked(String(p.id || ''), liked, readQishuiCookie());
      return Object.assign({ success: true }, result);
    },

    'playlist.collect': async params => {
      const p = params || {};
      const collected = String(p.collected != null ? p.collected : 'true') !== 'false';
      const result = await qishuiApi().handleQishuiSetPlaylistCollected(String(p.id || ''), collected, readQishuiCookie());
      return Object.assign({ success: true }, result);
    },

    'playlist.addSong': params => {
      const p = params || {};
      return qishuiApi().handleQishuiPlaylistAddSong(String(p.playlistId || ''), String(p.trackId || ''), readQishuiCookie());
    },

    'album.collect': async params => {
      const p = params || {};
      const collected = String(p.collected != null ? p.collected : 'true') !== 'false';
      const result = await qishuiApi().handleQishuiSetAlbumCollected(String(p.id || ''), collected, readQishuiCookie());
      return Object.assign({ success: true }, result);
    },

    // playedAt 由协议层在服务端补齐，这里只透传 trackId（与 server.js 一致）。
    'report.play': params => qishuiApi().handleQishuiReportRecentlyPlayed(String((params || {}).trackId || ''), readQishuiCookie()),

    comments: params => {
      const p = params || {};
      const limit = qishuiClampInt(p.limit, 18, 1, 50);
      const sort = String(p.sort || '') || 'latest';
      return qishuiApi().handleQishuiComments(String(p.id || ''), { limit, cursor: '', sort }, readQishuiCookie());
    },

    'comment.create': params => {
      const p = params || {};
      return qishuiApi().handleQishuiCreateComment(String(p.id || ''), String(p.content || ''), readQishuiCookie());
    },
  };

  // 唯一的对外入口：把协议层的任意返回值/异常收敛成 { ok, data } / { ok, error } 信封。
  async function request(operation, params = {}) {
    const name = String(operation || '');
    if (!Object.prototype.hasOwnProperty.call(handlers, name)) {
      return { ok: false, error: { code: 'unsupported', message: 'Unsupported qishui operation: ' + name } };
    }
    try {
      const data = await handlers[name](params && typeof params === 'object' ? params : {});
      const failed = QISHUI_RESULT_FAILURES[name];
      if (failed && failed(data)) return qishuiFailureFromResult(name, data);
      return { ok: true, data };
    } catch (error) {
      if (warn) warn('[QishuiBridge] ' + name + ' failed:', (error && error.message) || error);
      return qishuiFailureEnvelope(error, name);
    }
  }

  return {
    request,
    operations: QISHUI_OPERATIONS,
    credentialPaths: credentials.paths,
    // main.cjs 在主窗口 'closed' 与 before-quit 里调用：销毁隐藏签名窗口（否则
    // 'window-all-closed' 不会触发、进程退不出去）并立刻释放 loopback 端口。
    dispose,
  };
}

module.exports = {
  createQishuiApiBridge,
  QISHUI_OPERATIONS,
  // 与 qishui-api.js 的 _test 一致：只为本地冒烟脚本暴露纯函数，不参与运行时逻辑。
  _test: {
    qishuiErrorCode,
    qishuiClampInt,
    qishuiAudioAuthFromUrl,
    qishuiAudioCacheKey,
    qishuiAudioProxyHeadersFor,
    qishuiSendAudioBuffer,
    QISHUI_AUDIO_DECRYPT_CACHE_MAX_BYTES,
    QISHUI_AUDIO_ROUTE,
  },
};
