'use strict';

/**
 * 汽水音乐 App 内 RPC 服务（纯 Node）。
 *
 * 形态对齐官方/第三方内置服务端：App 启动后在 127.0.0.1 上提供与桌面桥完全相同的
 * `POST /rpc/<operation>` 信封协议，前端 qishuiTransport 不需要任何改动。
 *
 * 这里只走**不签名**的公开链路（与参考 IPA 一致）：
 *   - Luna 搜索       https://api.qishui.com/luna/search/track
 *   - SEO 曲目/播放    https://beta-luna.douyin.com/luna/h5/seo_track
 *   - 扫码登录         passport get_qrcode / check_qrconnect（Cookie 由本进程自己收）
 *   - 我的资料         https://api.qishui.com/luna/pc/me
 *
 * 免费曲目 SEO 会返回整曲；付费曲目只返回试听段。和第三方内置服务端 IPA 的行为一致：
 * 受限曲目由用户改在酷狗 / QQ 源里搜索完整版（前端把 preview-only 显示为「仅可试听」）。
 * 登录 Cookie 只落在 FOLIA_STATE_DIR，不写日志。
 *
 * 其余 operation（歌单、喜欢、评论等）委托给桌面版同一份 qishui-api.js，保证字段形状一致。
 */

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const HOST = '127.0.0.1';
const PORT = Math.max(1, Number(process.env.FOLIA_QISHUI_PORT || 3302) || 3302);
const STATE_DIR = process.env.FOLIA_STATE_DIR || process.env.FOLIA_LOG_DIR || path.join(__dirname, '..', 'state');
const COOKIE_FILE = path.join(STATE_DIR, 'qishui-cookie.json');
const DEVICE_FILE = path.join(STATE_DIR, 'qishui-device.json');
const QR_FILE = path.join(STATE_DIR, 'qishui-qr.json');
const USER_AGENT_WEB = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36';
const USER_AGENT_SODA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) SodaMusic/3.1.0 Chrome/136.0.7103.59 Electron/36.4.0-rs.22.release.main.1 TTElectron/36.4.0-rs.22.release.main.1 Safari/537.36';
const USER_AGENT_PC = 'LunaPC/3.4.0(388267242)';
const SEARCH_URL = 'https://api.qishui.com/luna/search/track';
const SEO_URL = 'https://beta-luna.douyin.com/luna/h5/seo_track';
const QR_CREATE_URL = 'https://api.qishui.com/passport/web/get_qrcode/';
const QR_CHECK_URL = 'https://api.qishui.com/passport/web/check_qrconnect/';
const PC_ME_URL = 'https://api.qishui.com/luna/pc/me';
const SCAN_BASE = 'https://bff-pc.qishui.com/light/invoke/scan_login';
const SESSION_COOKIES = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard'];
const QR_TTL_MS = 5 * 60 * 1000;
const QR_CACHE_MS = 160 * 1000;
const CHECK_INTERVAL_MS = 2500;

// 与参考实现相同的 Android 客户端参数：Luna 搜索只认这一套。
const ANDROID_PARAMS = {
  aid: '386088',
  app_name: 'luna',
  device_platform: 'android',
  os: 'android',
  channel: 'xiaomi_8478_64',
  version_code: '100198030',
  version_name: '19.8.0',
  manifest_version_code: '100198030',
  update_version_code: '100198030',
  device_type: 'ABR-AL80',
  device_brand: 'HUAWEI',
  device_model: 'ABR-AL80',
  os_api: '35',
  os_version: '15',
  tz_name: 'Asia/Shanghai',
};

const QUALITY_PREF = {
  standard: ['medium', 'higher', 'highest'],
  high: ['higher', 'highest', 'medium'],
  exhigh: ['higher', 'highest', 'medium'],
  lossless: ['highest', 'higher', 'medium'],
  hires: ['highest', 'higher', 'medium'],
};

// 与 electron/qishuiApiBridge.cjs 的 QISHUI_RESULT_FAILURES 保持一致。
const RESULT_FAILURES = {
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

function ensureStateDir() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch (_) { /* 设备上失败也不能影响服务 */ }
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function writeJsonFile(file, value) {
  try { fs.writeFileSync(file, JSON.stringify(value)); } catch (_) { /* 忽略：状态落盘失败不能拖垮播放 */ }
}

function withParams(target, params) {
  const url = new URL(target);
  Object.keys(params || {}).forEach(key => {
    const value = params[key];
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
  });
  return url.toString();
}

/**
 * 最小 HTTP 客户端：超时、最多 3 次 30x、返回原始 headers（登录要靠 Set-Cookie）。
 */
function requestJson(target, opts, body) {
  opts = opts || {};
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 10000;
  const method = String(opts.method || 'GET').toUpperCase();
  return new Promise((resolve, reject) => {
    let redirects = 0;
    const go = (currentUrl, currentMethod) => {
      let parsed;
      try { parsed = new URL(currentUrl); } catch (_) { reject(new Error('QISHUI_BAD_URL')); return; }
      const lib = parsed.protocol === 'https:' ? https : http;
      const headers = Object.assign({}, opts.headers || {});
      if (body && headers['Content-Length'] == null && headers['content-length'] == null) {
        headers['Content-Length'] = Buffer.byteLength(String(body));
      }
      const request = lib.request({
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: currentMethod,
        headers,
      }, response => {
        const status = Number(response.statusCode) || 0;
        if (opts.followRedirects !== false && [301, 302, 303, 307, 308].includes(status)
          && response.headers.location && redirects < 3) {
          redirects += 1;
          const nextUrl = new URL(response.headers.location, currentUrl).toString();
          response.resume();
          go(nextUrl, status === 303 ? 'GET' : currentMethod);
          return;
        }
        const chunks = [];
        response.on('data', chunk => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = text ? JSON.parse(text) : null; } catch (_) { /* 非 JSON 由调用方按 text 判断 */ }
          resolve({ status, headers: response.headers, text, json });
        });
      });
      request.on('error', reject);
      request.setTimeout(timeoutMs, () => request.destroy(new Error('QISHUI_TIMEOUT')));
      if (body) request.write(String(body));
      request.end();
    };
    go(target, method);
  });
}

// ── Cookie 罐 ────────────────────────────────────────────────────────────────
// 只按 name=value 存，domain/path 一律忽略（这些 Passport cookie 全都发给 qishui.com）。
class CookieJar {
  constructor(file) {
    this.file = file;
    this.values = {};
    const stored = readJsonFile(file);
    if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
      Object.keys(stored).forEach(key => {
        if (typeof stored[key] === 'string') this.values[key] = stored[key];
      });
    }
  }

  header() {
    return Object.keys(this.values).map(key => key + '=' + this.values[key]).join('; ');
  }

  save() {
    writeJsonFile(this.file, this.values);
  }

  absorb(headers) {
    const raw = headers && headers['set-cookie'];
    if (!raw) return false;
    const lines = Array.isArray(raw) ? raw : [String(raw)];
    let changed = false;
    lines.forEach(line => {
      const first = String(line || '').split(';')[0];
      const index = first.indexOf('=');
      if (index <= 0) return;
      const name = first.slice(0, index).trim();
      const value = first.slice(index + 1).trim();
      if (!name) return;
      const lower = String(line).toLowerCase();
      const expired = /max-age=0(;|$)/.test(lower) || /expires=thu, 01 jan 1970/.test(lower);
      if (expired) {
        if (Object.prototype.hasOwnProperty.call(this.values, name)) {
          delete this.values[name];
          changed = true;
        }
        return;
      }
      if (this.values[name] !== value) {
        this.values[name] = value;
        changed = true;
      }
    });
    if (changed) this.save();
    return changed;
  }

  hasSession() {
    return SESSION_COOKIES.some(name => String(this.values[name] || '').trim() !== '');
  }

  clear() {
    this.values = {};
    this.save();
  }
}

// ── 设备指纹（与参考实现同构；只用于 Passport 参数，不是账号凭据）────────────────
function loadDevice() {
  const stored = readJsonFile(DEVICE_FILE);
  if (stored && stored.deviceId && stored.iid) {
    return { deviceId: String(stored.deviceId), iid: String(stored.iid) };
  }
  const deviceId = String(Date.now()) + String(Math.floor(Math.random() * 1e6));
  const iid = deviceId + String(Math.floor(Math.random() * 1e3));
  const device = { deviceId, iid };
  writeJsonFile(DEVICE_FILE, device);
  return device;
}

function normalizeErrorCode(value) {
  return String(value == null ? '' : value)
    .trim().toLowerCase()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function clampInt(value, fallback, min, max) {
  const raw = value === undefined || value === null || value === '' ? String(fallback) : String(value);
  const parsed = parseInt(raw, 10) || fallback;
  return Math.max(min, Math.min(max, parsed));
}

function resultMessage(result) {
  if (!result || typeof result !== 'object') return '';
  const candidates = [result.message, result.restriction && result.restriction.message, result.error];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function failureFromResult(operation, result) {
  const category = result && (result.reason || (result.restriction && result.restriction.category));
  const raw = category || (result && (result.error || result.errorCode)) || '';
  return {
    ok: false,
    error: {
      code: normalizeErrorCode(raw) || 'qishui-error',
      message: resultMessage(result) || ('Qishui ' + operation + ' failed'),
    },
  };
}

function failureEnvelope(error, operation) {
  const raw = (error && (error.qishuiCode || error.code)) || '';
  const message = String((error && error.message) || ('Qishui ' + operation + ' failed'));
  const code = normalizeErrorCode(raw) || (/COOKIE_REQUIRED|login|not logged/i.test(message) ? 'login-required' : 'qishui-error');
  return { ok: false, error: { code, message } };
}

// ── 汽水协议实现 ─────────────────────────────────────────────────────────────
function createQishuiInApp() {
  ensureStateDir();
  const jar = new CookieJar(COOKIE_FILE);
  const device = loadDevice();
  let api = null;
  let apiLoadError = '';
  let qrSession = readJsonFile(QR_FILE);
  if (!qrSession || !qrSession.token || !qrSession.at) qrSession = null;
  let lastCheckAt = 0;
  let profileCache = { at: 0, value: null };
  const seoCache = new Map();

  function apiModule() {
    if (api) return api;
    try {
      // qishui-api 里唯一的懒加载 require('./qishui-qr-login') 在 App 内不可用，
      // 但 getQishuiOfficialBridge() 会吞掉 require 失败并回退到无签名请求，所以可以安全复用。
      process.env.QISHUI_TOKEN_FILE = process.env.QISHUI_TOKEN_FILE || path.join(STATE_DIR, 'qishui-token');
      api = require('./qishui/qishui-api.js');
    } catch (error) {
      apiLoadError = String((error && error.message) || error);
      console.log('[folia-node] ERROR qishui-api load failed: ' + apiLoadError);
      api = null;
    }
    return api;
  }

  function passportParams() {
    const seed = Math.floor(Math.random() * 4294967295) >>> 0;
    return {
      passport_jssdk_version: '2.4.13',
      passport_jssdk_type: 'normal',
      is_from_ttaccountsdk: '1',
      aid: '386088',
      language: 'zh',
      is_new_login: '1',
      is_from_iesaccountsaas: '1',
      device_id: device.deviceId,
      install_id: device.iid,
      did: device.deviceId,
      iid: device.iid,
      device_platform: 'PC',
      version_code: '3.3.0',
      biz_trace_id: seed.toString(16).padStart(8, '0'),
      account_sdk_source: 'web',
      p_js_v: '2.4.13',
      p_js_t: 'normal',
      p_zt: '3.3.5',
      p_ver: '1.0.29',
      request_host: 'app://resources',
      p_bd: '1.0.0.41',
    };
  }

  function cookieHeaders(base) {
    const headers = Object.assign({}, base || {});
    const cookie = jar.header();
    if (cookie) headers.Cookie = cookie;
    return headers;
  }

  function qrScanUrl(token) {
    const params = new URLSearchParams({ token, os: 'Mac', computer_name: 'Folia' });
    return SCAN_BASE + '?' + params.toString().replace(/\+/g, '%20');
  }

  async function makeQrDataUrl(token, upstreamQr) {
    const target = qrScanUrl(token);
    try {
      const QRCode = require('qrcode');
      const dataUrl = await QRCode.toDataURL(target, { margin: 1, width: 320 });
      if (dataUrl) return dataUrl;
    } catch (error) {
      // qrcode 依赖没打进去时退回上游给的图；扫码目标仍是同一个 token。
      console.log('[folia-node] ERROR qrcode generate failed: ' + String((error && error.message) || error));
    }
    return typeof upstreamQr === 'string' ? upstreamQr : '';
  }

  async function createQr() {
    const now = Date.now();
    if (qrSession && now - Number(qrSession.at || 0) < QR_CACHE_MS && qrSession.token && qrSession.qrcode) {
      return {
        provider: 'qishui',
        token: qrSession.token,
        qrcode: qrSession.qrcode,
        qrDataUrl: qrSession.qrcode,
        qrCodeUrl: qrSession.qrcode,
        expireTime: qrSession.expireTime || 0,
        ttlMs: Math.max(30000, QR_TTL_MS - (now - Number(qrSession.at || 0))),
        expiresAt: now + Math.max(30000, QR_TTL_MS - (now - Number(qrSession.at || 0))),
        message: '请使用抖音 App 扫码并确认登录',
      };
    }
    const url = withParams(QR_CREATE_URL, Object.assign(passportParams(), {
      next: 'https://api.qishui.com',
      need_logo: 'false',
      need_short_url: 'false',
      is_frontier: 'true',
    }));
    const response = await requestJson(url, {
      headers: { 'User-Agent': USER_AGENT_SODA, Accept: 'application/json, text/javascript' },
      timeoutMs: 10000,
    });
    jar.absorb(response.headers);
    const data = (response.json && (response.json.data || response.json)) || {};
    const token = String(data.token || '');
    if (!token) {
      const errorCode = Number(data.error_code || 0);
      if (errorCode === 7) {
        const retryAfterMs = Number(data.retry_after_ms) || 60000;
        const error = new Error('汽水登录接口限流，请 ' + Math.ceil(retryAfterMs / 1000) + ' 秒后再试');
        error.qishuiCode = 'rate-limited';
        throw error;
      }
      throw new Error('汽水要求登录失败：' + (data.description || (response.json && response.json.message) || '没有拿到 token'));
    }
    const qrcode = await makeQrDataUrl(token, data.qrcode);
    const expireTime = Number(data.expire_time || 0);
    let ttlMs = QR_TTL_MS;
    if (expireTime > 1e12) ttlMs = Math.max(30000, expireTime - now);
    else if (expireTime > 1e9) ttlMs = Math.max(30000, expireTime * 1000 - now);
    qrSession = { token, qrcode, at: now, expireTime, ttlMs };
    writeJsonFile(QR_FILE, qrSession);
    return {
      provider: 'qishui',
      token,
      qrcode,
      qrDataUrl: qrcode,
      qrCodeUrl: qrcode,
      expireTime,
      ttlMs,
      expiresAt: now + ttlMs,
      message: '请使用抖音 App 扫码并确认登录',
    };
  }

  async function checkQr(token) {
    const key = String(token || '').trim();
    if (!key) return { provider: 'qishui', status: 'error', loggedIn: false, errorCode: 0, message: '二维码已失效，请重新获取' };
    const now = Date.now();
    if (now - lastCheckAt < CHECK_INTERVAL_MS) return { provider: 'qishui', status: 'waiting', loggedIn: false, errorCode: 0, retryAfterMs: CHECK_INTERVAL_MS, message: '' };
    lastCheckAt = now;

    const body = new URLSearchParams({
      need_logo: 'false',
      need_short_url: 'false',
      is_frontier: 'true',
      token: key,
      is_new_login: '1',
      next: 'https://api.qishui.com',
    }).toString();
    const url = withParams(QR_CHECK_URL, passportParams());
    const response = await requestJson(url, {
      method: 'POST',
      headers: cookieHeaders({
        'User-Agent': USER_AGENT_SODA,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json, text/javascript',
        'sec-ch-ua': '"Not.A/Brand";v="99", "Chromium";v="136"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
        'bd-ticket-guard-version': '2',
        'bd-ticket-guard-iteration-version': '2',
        'bd-ticket-guard-ree-public-key': 'BAnIxKL96Jby5x+Um9i7HZ2c8O6lfZJRxm6yk73Mqcr06l2qIw2iqu2Mtm3U/6OI98usukA9dqxUlsctVWK9rKA=',
        'bd-ticket-guard-server-cert-sn': '0',
      }),
      timeoutMs: 8000,
    }, body);
    jar.absorb(response.headers);

    if (jar.hasSession()) {
      profileCache = { at: 0, value: null };
      return { provider: 'qishui', status: 'confirmed', loggedIn: true, errorCode: 0, error_code: 0, message: '登录成功' };
    }

    const data = (response.json && (response.json.data || response.json)) || {};
    const errorCode = Number(data.error_code || 0);
    if (errorCode === 7) {
      return { provider: 'qishui', status: 'waiting', loggedIn: false, errorCode, error_code: errorCode, retryAfterMs: 60000, message: '登录接口限流，稍后自动继续' };
    }
    if (errorCode === 2046 || String(data.account_flow || '').toLowerCase() === 'verify') {
      return { provider: 'qishui', status: 'error', loggedIn: false, errorCode, error_code: errorCode, message: data.description || '需要在手机端完成二次验证' };
    }
    const rawStatus = String(data.status || '').trim().toLowerCase();
    let status = 'waiting';
    if (/^(4|5|expired|timeout)$/.test(rawStatus)) status = 'expired';
    else if (rawStatus === 'confirmed') status = 'scanned'; // 上游说 confirmed 但还没下发 Cookie：继续轮询
    else if (/^(2|scanned|scan)$/.test(rawStatus)) status = 'scanned';
    else if (rawStatus === 'error' || rawStatus === 'failed') status = 'error';
    else if (errorCode !== 0) status = 'error';
    return {
      provider: 'qishui',
      status,
      loggedIn: false,
      errorCode,
      error_code: errorCode,
      retryAfterMs: status === 'waiting' ? CHECK_INTERVAL_MS : 0,
      message: data.description || (response.json && response.json.message) || (status === 'error' ? '扫码登录失败' : ''),
    };
  }

  async function fetchPcMe() {
    if (!jar.hasSession()) return null;
    if (profileCache.value && Date.now() - profileCache.at < 60 * 1000) return profileCache.value;
    const url = withParams(PC_ME_URL, {
      aid: '386088',
      app_name: 'luna_pc',
      region: 'cn',
      geo_region: 'cn',
      os_region: 'cn',
      sim_region: '',
      device_id: device.deviceId,
      cdid: '',
      iid: device.iid,
      version_name: '3.4.0',
      version_code: '30040000',
      channel: 'official',
      build_mode: 'master',
      network_carrier: '',
      ac: 'wifi',
      tz_name: 'Asia/Shanghai',
      resolution: '',
      device_platform: 'windows',
      device_type: 'Windows',
      os_version: 'Windows 10',
      fp: device.deviceId,
    });
    try {
      const response = await requestJson(url, {
        headers: cookieHeaders({ 'User-Agent': USER_AGENT_PC }),
        timeoutMs: 5000,
      });
      jar.absorb(response.headers);
      const info = (response.json && (response.json.my_info || (response.json.data && response.json.data.my_info))) || null;
      if (!info) return null;
      const value = {
        id: String(info.id || ''),
        nickname: String(info.nickname || info.public_name || ''),
        avatarUrl: String((info.larger_avatar_url && info.larger_avatar_url.urls && info.larger_avatar_url.urls[0]) || ''),
        vipType: Number(info.vip_type || info.vipType || 0) || 0,
      };
      profileCache = { at: Date.now(), value };
      return value;
    } catch (_) {
      return null;
    }
  }

  async function handleStatus() {
    const cookie = jar.header();
    const module = apiModule();
    let base;
    try {
      base = module ? module.getQishuiStatus(cookie) : { provider: 'qishui' };
    } catch (_) {
      base = { provider: 'qishui' };
    }
    const loggedIn = jar.hasSession();
    const profile = loggedIn ? await fetchPcMe() : null;
    const status = Object.assign({}, base, {
      provider: 'qishui',
      configured: true,
      webSession: loggedIn,
      cookieReady: loggedIn,
      loggedIn,
      playbackMode: 'direct-url',
      ...(profile ? {
        userId: profile.id || base.userId || '',
        nickname: profile.nickname || base.nickname || '',
        avatar: profile.avatarUrl || base.avatar || '',
        vipType: profile.vipType || 0,
      } : {}),
      capabilities: Object.assign({}, base.capabilities, {
        search: true,
        lyric: true,
        playableUrl: true,
        login: true,
        webSession: loggedIn,
        userPlaylists: true,
        playlistTracks: true,
      }),
      message: loggedIn
        ? '汽水音乐已登录：可同步歌单与我的喜欢；公开曲目直接播放，受限曲目仅提供试听。'
        : '未登录：可搜索并直接播放汽水公开曲目；受限曲目仅提供试听，可在酷狗 / QQ 源搜索完整版。',
    });
    if (!status.nickname) status.nickname = loggedIn ? '汽水音乐账号' : '';
    if (!status.vipLabel) status.vipLabel = '无VIP';
    return status;
  }

  function coverFromAlbum(album) {
    if (!album || typeof album !== 'object') return '';
    const cover = album.url_cover || album.cover || album.cover_url || null;
    const urls = cover && Array.isArray(cover.urls) ? cover.urls : [];
    const base = urls.find(item => typeof item === 'string' && item);
    const uri = String((cover && cover.uri) || '');
    return base && uri ? base + uri + '~c5_500x500.jpg' : '';
  }

  function lunaTrackToSong(track) {
    if (!track || typeof track !== 'object') return null;
    const id = String(track.id || '');
    const name = String(track.name || track.title || '');
    if (!id || !name) return null;
    const album = track.album && typeof track.album === 'object' ? track.album : {};
    const artists = (Array.isArray(track.artists) ? track.artists : [])
      .map(artist => ({ id: String((artist && artist.id) || ''), name: String((artist && artist.name) || '') }))
      .filter(artist => artist.name);
    return {
      provider: 'qishui',
      id,
      name,
      artists,
      artist: artists.map(artist => artist.name).join(' / '),
      album: String(album.name || ''),
      albumId: String(album.id || ''),
      cover: coverFromAlbum(album),
      duration: Number(track.duration) > 0 ? Math.round(Number(track.duration) / 1000) : 0,
      source: 'qishui-luna-search',
    };
  }

  async function lunaSearch(keywords, limit, offset) {
    const url = withParams(SEARCH_URL, Object.assign({}, ANDROID_PARAMS, {
      q: keywords,
      cursor: Math.max(0, offset),
      count: Math.max(1, Math.min(30, limit)),
    }));
    const response = await requestJson(url, {
      headers: { 'User-Agent': USER_AGENT_WEB, Accept: 'application/json, text/plain, */*' },
      timeoutMs: 10000,
    });
    if (response.status !== 200 || !response.json) throw new Error('Luna search HTTP ' + response.status);
    const groups = Array.isArray(response.json.result_groups) ? response.json.result_groups : [];
    const group = groups.find(item => item && Array.isArray(item.data)) || groups[0] || {};
    const raw = Array.isArray(group.data) ? group.data : [];
    const songs = raw.map(item => lunaTrackToSong(item && item.entity && item.entity.track)).filter(Boolean);
    const page = songs.slice(0, limit);
    return {
      provider: 'qishui',
      songs: page,
      offset,
      limit,
      nextOffset: offset + page.length,
      hasMore: !!group.has_more && page.length > 0,
      source: 'qishui-luna-search',
    };
  }

  async function handleSearch(keywords, limit, offset) {
    const query = String(keywords || '').trim();
    if (!query) return { provider: 'qishui', songs: [], offset, limit, nextOffset: offset, hasMore: false };
    try {
      return await lunaSearch(query, limit, offset);
    } catch (error) {
      const module = apiModule();
      if (!module) throw error;
      return module.handleQishuiSearch(query, limit, jar.header(), offset);
    }
  }

  async function fetchSeo(trackId) {
    const id = String(trackId || '');
    const cached = seoCache.get(id);
    if (cached && Date.now() - cached.at < 60 * 1000) return cached.value;
    const url = withParams(SEO_URL, { track_id: id, device_platform: 'web' });
    const response = await requestJson(url, {
      headers: {
        'User-Agent': USER_AGENT_WEB,
        Accept: 'application/json, text/plain, */*',
        Referer: 'https://www.douyin.com/',
      },
      timeoutMs: 10000,
    });
    if (response.status !== 200 || !response.json) throw new Error('SEO track HTTP ' + response.status);
    const track = response.json.seo_track && response.json.seo_track.track;
    if (!track) throw new Error('SEO track missing');
    const lyric = String(
      (response.json.lyric && response.json.lyric.content)
      || (response.json.seo_track && response.json.seo_track.lyric && response.json.seo_track.lyric.content)
      || ''
    );
    let playInfos = [];
    let playError = '';
    const infoUrl = response.json.track_player && response.json.track_player.url_player_info;
    if (infoUrl) {
      try {
        const infoResponse = await requestJson(infoUrl, { headers: { 'User-Agent': USER_AGENT_WEB }, timeoutMs: 10000 });
        const list = infoResponse.json && infoResponse.json.Result && infoResponse.json.Result.Data
          && infoResponse.json.Result.Data.PlayInfoList;
        if (Array.isArray(list)) playInfos = list;
      } catch (error) {
        playError = String((error && error.message) || error);
      }
    }
    const value = { track, lyric, playInfos, playError };
    seoCache.set(id, { at: Date.now(), value });
    if (seoCache.size > 200) {
      const oldest = seoCache.keys().next().value;
      if (oldest !== undefined) seoCache.delete(oldest);
    }
    return value;
  }

  function streamSeconds(info) {
    const size = Number(info && info.Size);
    const bitrate = Number(info && info.Bitrate);
    if (size > 0 && bitrate > 0) return size * 8 / bitrate;
    const duration = Number(info && info.Duration);
    return duration > 0 ? duration : 0;
  }

  function pickPlayInfo(playInfos, quality) {
    const preference = QUALITY_PREF[String(quality || '').toLowerCase()] || QUALITY_PREF.high;
    const usable = playInfos.filter(info => info && (info.MainPlayUrl || info.BackupPlayUrl));
    for (const name of preference) {
      const match = usable.find(info => String(info.Quality || '').toLowerCase() === name);
      if (match) return match;
    }
    return usable[0] || null;
  }

  function isPreviewStream(track, info, preview) {
    const trackSeconds = Number(track && track.duration) / 1000;
    const stream = streamSeconds(info);
    if (trackSeconds > 0 && stream > 0) return stream + 10 < trackSeconds;
    return Number(preview && preview.duration) > 0;
  }

  async function handleSongUrl(id, quality) {
    const trackId = String(id || '').trim();
    if (!trackId) return { provider: 'qishui', playable: false, url: '', restriction: { category: 'missing_id' }, message: 'Missing Qishui track id' };
    let seo;
    try {
      seo = await fetchSeo(trackId);
    } catch (error) {
      return {
        provider: 'qishui', playable: false, url: '', loggedIn: jar.hasSession(),
        restriction: { category: 'source_unavailable' },
        message: '汽水取流失败：' + String((error && error.message) || error),
      };
    }
    const info = pickPlayInfo(seo.playInfos, quality);
    if (!info) {
      return {
        provider: 'qishui', playable: false, url: '', loggedIn: jar.hasSession(),
        restriction: { category: 'source_unavailable' },
        message: seo.playError ? ('汽水取流失败：' + seo.playError) : '汽水没有返回可用的播放地址',
      };
    }
    const url = String(info.MainPlayUrl || info.BackupPlayUrl || '');
    const duration = Math.round(streamSeconds(info));
    const trial = isPreviewStream(seo.track, info, seo.track.preview);
    const bitrate = Number(info.Bitrate) > 0 ? Math.round(Number(info.Bitrate) / 1000) : 0;
    return {
      provider: 'qishui',
      playbackMode: 'direct-url',
      url,
      playable: true,
      trial,
      loggedIn: jar.hasSession(),
      quality: String(info.Quality || ''),
      level: String(info.Quality || ''),
      codec: String(info.Codec || '') + '/' + String(info.Format || ''),
      br: bitrate,
      size: Number(info.Size) || 0,
      duration,
      expiresAt: Number(info.UrlExpire) > 0 ? Number(info.UrlExpire) * 1000 : undefined,
      previewStartMs: Number(seo.track.preview && seo.track.preview.start) || 0,
      previewDurationMs: Number(seo.track.preview && seo.track.preview.duration) || 0,
      requestedQuality: String(quality || ''),
      source: 'qishui-seo-playinfo',
      message: trial ? '汽水仅返回试听片段，可在酷狗 / QQ 源搜索完整版。' : '',
    };
  }

  async function handleFeed(limit) {
    const module = apiModule();
    let fallback = null;
    if (module) {
      try {
        fallback = await module.handleQishuiFeed(limit, jar.header());
        if (fallback && Array.isArray(fallback.songs) && fallback.songs.length) return fallback;
      } catch (_) { /* 未登录时本来就没有推荐流 */ }
    }
    try {
      return await lunaSearch(process.env.FOLIA_QISHUI_FEED_KEYWORD || '热歌', limit, 0);
    } catch (_) {
      return fallback || { provider: 'qishui', songs: [], error: 'QISHUI_FEED_UNAVAILABLE' };
    }
  }

  function delegated(operation, params) {
    const module = apiModule();
    if (!module) throw new Error('qishui-api unavailable: ' + apiLoadError);
    const cookie = jar.header();
    switch (operation) {
      case 'artist': {
        const artistId = String(params.artistId || '');
        const artistName = String(params.artistName || '');
        if (!artistId && !artistName) throw new Error('汽水音乐需要艺人 ID 或名称');
        return module.handleQishuiArtistDetail({ artistId, artistName, limit: clampInt(params.limit, 36, 10, 50) }, cookie);
      }
      case 'song.detail':
        return module.handleQishuiSongDetail(String(params.id || ''));
      case 'album': {
        const id = String(params.id || '');
        const trackId = String(params.trackId || '');
        if (!id && !trackId) throw new Error('汽水音乐需要专辑 ID 或曲目 ID');
        return module.handleQishuiAlbumDetail(id, cookie, clampInt(params.limit, 80, 10, 120), trackId);
      }
      case 'lyric':
        return module.handleQishuiLyric(String(params.id || ''), cookie);
      case 'user.playlists':
        return module.handleQishuiUserPlaylists(cookie);
      case 'playlist.tracks': {
        const id = String(params.id || '') || 'qishui-feed';
        const limit = clampInt(params.limit, 0, 0, Number.MAX_SAFE_INTEGER);
        const offset = clampInt(params.offset, 0, 0, Number.MAX_SAFE_INTEGER);
        return module.handleQishuiPlaylistTracks(id, limit || offset ? { limit: limit || 50, offset } : {}, cookie);
      }
      case 'track.liked': {
        const raw = Array.isArray(params.ids) ? params.ids.join(',') : String(params.ids || '');
        const ids = raw.split(',').map(value => value.trim()).filter(Boolean);
        return module.handleQishuiCheckTracksLiked(ids, cookie);
      }
      case 'track.like': {
        const liked = String(params.liked != null ? params.liked : 'true') !== 'false';
        return module.handleQishuiSetTrackLiked(String(params.id || ''), liked, cookie).then(result => Object.assign({ success: true }, result));
      }
      case 'playlist.collect': {
        const collected = String(params.collected != null ? params.collected : 'true') !== 'false';
        return module.handleQishuiSetPlaylistCollected(String(params.id || ''), collected, cookie).then(result => Object.assign({ success: true }, result));
      }
      case 'playlist.addSong':
        return module.handleQishuiPlaylistAddSong(String(params.playlistId || ''), String(params.trackId || ''), cookie);
      case 'album.collect': {
        const collected = String(params.collected != null ? params.collected : 'true') !== 'false';
        return module.handleQishuiSetAlbumCollected(String(params.id || ''), collected, cookie).then(result => Object.assign({ success: true }, result));
      }
      case 'report.play':
        return module.handleQishuiReportRecentlyPlayed(String(params.trackId || ''), cookie);
      case 'comments':
        return module.handleQishuiComments(String(params.id || ''), {
          limit: clampInt(params.limit, 18, 1, 50),
          cursor: '',
          sort: String(params.sort || '') || 'latest',
        }, cookie);
      case 'comment.create':
        return module.handleQishuiCreateComment(String(params.id || ''), String(params.content || ''), cookie);
      default:
        throw new Error('Unsupported qishui operation: ' + operation);
    }
  }

  const handlers = {
    status: () => handleStatus(),
    'login.qr': () => createQr(),
    'login.check': params => checkQr(String((params && params.token) || '')),
    'login.logout': async () => {
      jar.clear();
      qrSession = null;
      try { fs.unlinkSync(QR_FILE); } catch (_) { /* 不存在就算了 */ }
      profileCache = { at: 0, value: null };
      return Object.assign({}, await handleStatus(), { webSession: false, cookieReady: false, loggedIn: false });
    },
    search: params => handleSearch(
      String((params && params.keywords) || ''),
      clampInt(params && params.limit, 12, 4, 18),
      clampInt(params && params.offset, 0, 0, Number.MAX_SAFE_INTEGER)
    ),
    feed: params => handleFeed(clampInt((params || {}).limit, 8, 4, 12)),
    'song.url': params => handleSongUrl(String((params && params.id) || ''), String((params && params.quality) || '')),
  };

  const knownOperations = [
    'status', 'login.qr', 'login.check', 'login.logout', 'search', 'artist', 'song.detail', 'album',
    'lyric', 'song.url', 'feed', 'user.playlists', 'playlist.tracks', 'track.liked', 'track.like',
    'playlist.collect', 'playlist.addSong', 'album.collect', 'report.play', 'comments', 'comment.create',
  ];

  async function request(operation, params) {
    const name = String(operation || '');
    if (knownOperations.indexOf(name) < 0) {
      return { ok: false, error: { code: 'unsupported', message: 'Unsupported qishui operation: ' + name } };
    }
    try {
      const data = handlers[name]
        ? await handlers[name](params && typeof params === 'object' ? params : {})
        : await delegated(name, params && typeof params === 'object' ? params : {});
      const failed = RESULT_FAILURES[name];
      if (failed && failed(data)) return failureFromResult(name, data);
      return { ok: true, data };
    } catch (error) {
      return failureEnvelope(error, name);
    }
  }

  return { request, operations: knownOperations, status: () => ({ loggedIn: jar.hasSession() }) };
}

function startServer(log) {
  const inApp = createQishuiInApp();
  const server = http.createServer((req, res) => {
    const origin = String((req.headers && req.headers.origin) || '');
    const cors = {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const reply = (status, payload) => {
      try {
        res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, cors));
        res.end(JSON.stringify(payload));
      } catch (_) { /* 连接已断 */ }
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    const pathname = String(req.url || '').split('?')[0];
    if (req.method === 'GET' && pathname === '/healthz') {
      reply(200, { ok: true, provider: 'qishui-inapp', operations: inApp.operations, loggedIn: inApp.status().loggedIn });
      return;
    }
    if (req.method !== 'POST' || !pathname.startsWith('/rpc/')) {
      reply(404, { ok: false, error: { code: 'not-found', message: 'Not found' } });
      return;
    }
    let raw = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) { req.destroy(); return; }
      raw += chunk;
    });
    req.on('end', async () => {
      let params = {};
      try { params = raw ? JSON.parse(raw) : {}; } catch (_) {
        reply(200, { ok: false, error: { code: 'invalid-json', message: 'Request body is not valid JSON' } });
        return;
      }
      let operation = '';
      try { operation = decodeURIComponent(pathname.slice('/rpc/'.length)); } catch (_) {
        reply(200, { ok: false, error: { code: 'invalid-operation', message: 'Operation name is not valid URL encoding' } });
        return;
      }
      try {
        const payload = await inApp.request(operation, params);
        reply(200, payload);
      } catch (error) {
        reply(200, { ok: false, error: { code: 'qishui-error', message: String((error && error.message) || error) } });
      }
    });
  });
  server.on('error', error => {
    log('[folia-node] ERROR qishui server failed: ' + String((error && error.stack) || error));
  });
  server.listen(PORT, HOST, () => log('[folia-node] qishui listening on http://' + HOST + ':' + PORT));
  return server;
}

module.exports = { createQishuiInApp, startServer };

// 直接 `node qishui-inapp.cjs` 时作为独立服务启动（开发期与 CI 冒烟用）。
if (require.main === module) {
  startServer(line => console.log(line));
}
