#!/usr/bin/env node
'use strict';

/**
 * 汽水 /luna/pc/track_v2 原生签名冒烟（不带 cookie）。
 *
 * 目的：验证一个 bdms.node 二进制能否在普通 Node 下加载，并生成服务端接受的
 * X-Helios / X-Medusa。判据不是「拿到播放地址」，而是「响应不是空 body」：
 * 未签名的同一请求稳定返回 HTTP 200 + content-length 0；签名一旦被接受，
 * 即使没有登录态也会返回结构化 JSON（可能带 status_code，但不再是空 body）。
 *
 * 用法：
 *   node dev/mobile/qishui-sign-smoke.cjs /path/to/bdms.node
 *
 * macOS 上如果 libMetaSecML.dylib 不在默认搜索路径，运行前设置：
 *   DYLD_LIBRARY_PATH=/path/to/dir-containing-libMetaSecML.dylib
 *
 * 不读取、不打印、不发送任何用户 cookie。
 */

const crypto = require('crypto');
const fs = require('fs');
const https = require('https');
const path = require('path');

const TRACK_ID = process.env.QISHUI_SMOKE_TRACK_ID || '7485660908549720080';
const UA = 'LunaPC/3.5.2';
const API_BASE = 'https://api.qishui.com';

function fail(message) {
  console.error('[FAIL] ' + message);
  process.exit(1);
}

function loadAddon(addonPath) {
  if (!fs.existsSync(addonPath)) fail('bdms.node not found: ' + addonPath);
  let addon;
  try {
    addon = require(addonPath);
  } catch (error) {
    fail('require(bdms.node) failed: ' + (error && error.stack || error));
  }
  if (!addon || typeof addon.generateHttpSignatureHeaders !== 'function') {
    fail('generateHttpSignatureHeaders missing; exports=' + Object.keys(addon || {}).join(','));
  }
  return addon;
}

function buildUrl() {
  const now = Date.now();
  const deviceId = String(now);
  // 与 electron/qishui/qishui-api.js 的 qishuiPcAppParams() 保持一致。
  const params = {
    aid: '386088',
    app_name: 'luna_pc',
    region: 'cn',
    geo_region: 'cn',
    os_region: 'cn',
    sim_region: '',
    device_id: deviceId,
    cdid: '',
    iid: String(now + 1),
    version_name: '3.3.0',
    version_code: '30030000',
    channel: 'official',
    build_mode: 'master',
    network_carrier: '',
    ac: 'wifi',
    tz_name: 'Asia/Shanghai',
    resolution: '',
    device_platform: 'windows',
    device_type: 'Windows',
    os_version: 'Windows 11',
    fp: deviceId,
  };
  const url = new URL('/luna/pc/track_v2', API_BASE);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return { url: url.toString(), deviceId };
}

function normalizeSignature(raw) {
  if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) return { ...raw };
  const lines = String(raw || '').split(/\r?\n/).filter((line) => line.trim() !== '');
  if (lines.length < 2) fail('signature output is empty or malformed: ' + JSON.stringify(raw));
  const headers = {};
  for (let index = 0; index + 1 < lines.length; index += 2) {
    headers[lines[index].trim()] = lines[index + 1];
  }
  return headers;
}

function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const request = https.request({
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
    });
    request.on('error', reject);
    request.setTimeout(20000, () => request.destroy(new Error('native http timeout')));
    request.write(body);
    request.end();
  });
}

(async () => {
  const addonPath = process.argv[2] || process.env.QISHUI_BDMS_NODE || path.join(__dirname, 'bdms.node');
  console.log('[env] node=' + process.version + ' arch=' + process.arch + ' platform=' + process.platform);
  const addon = loadAddon(path.resolve(addonPath));
  console.log('[addon] loaded exports=' + Object.keys(addon).join(','));

  const { url, deviceId } = buildUrl();
  if (typeof addon.init === 'function') {
    try {
      const result = addon.init({ deviceId });
      console.log('[addon] init ok' + (result === undefined ? '' : ' result=' + JSON.stringify(result)));
    } catch (error) {
      // Windows 版在部分环境下 init 会抛错但签名仍可用；这里只记录，不中断。
      console.warn('[addon] init threw (continuing): ' + (error && error.message || error));
    }
  }

  // 与 electron/qishui/qishui-api.js 的 fetchQishuiPcTrackV2Post() 使用同一 body。
  const body = JSON.stringify({
    track_id: TRACK_ID,
    media_type: 'track',
    queue_type: 'favorite_track_playlist',
    scene_name: 'library',
  });
  const stub = crypto.createHash('md5').update(body).digest('hex').toUpperCase();
  const headerLines = ['user-agent\r\n' + UA, 'X-SS-STUB\r\n' + stub].join('\r\n');
  const signature = addon.generateHttpSignatureHeaders(url, headerLines);
  const signatureHeaders = normalizeSignature(signature);
  const signatureNames = Object.keys(signatureHeaders);
  console.log('[sign] headers=' + signatureNames.join(',') +
    ' lens=' + signatureNames.map((name) => name + ':' + String(signatureHeaders[name]).length).join(' '));

  const headers = {
    'user-agent': UA,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-SS-STUB': stub,
    ...signatureHeaders,
  };

  const response = await postJson(url, headers, body);
  const text = response.body.toString('utf8');
  console.log('[http] status=' + response.status +
    ' content-type=' + (response.headers['content-type'] || '') +
    ' content-length=' + (response.headers['content-length'] || '') +
    ' body-bytes=' + response.body.length);

  if (!text.trim()) {
    fail('empty response body: the signature was rejected (this is the unsigned-request symptom)');
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    fail('response is not JSON (first 200 chars): ' + text.slice(0, 200));
  }

  console.log('[json] top-level keys=' + Object.keys(json).join(','));
  for (const key of ['status_code', 'status', 'message', 'code']) {
    if (json[key] !== undefined) console.log('[json] ' + key + '=' + JSON.stringify(json[key]));
  }
  if (json.status_info && typeof json.status_info === 'object') {
    console.log('[json] status_info=' + JSON.stringify(json.status_info).slice(0, 300));
  }

  if (response.status !== 200) {
    fail('unexpected HTTP status: ' + response.status);
  }

  // 空 body 才是签名被拒；任何结构化 JSON（包括未登录/无版权错误）都说明签名层已通过。
  console.log('[PASS] signed track_v2 returned structured JSON (signature accepted; no cookie sent)');
  process.exit(0);
})().catch((error) => fail(error && error.stack || String(error)));
