'use strict';

/**
 * 汽水服务器的按需转码：客户端放不了 AAC 时（`/a?fmt=mp3`），在服务器上把解密后的整轨转成 MP3
 * 落缓存，再用 Range 供片。只服务 electron/qishui-server.cjs，桌面 Electron 那条路完全不经过这里。
 *
 * 为什么是 MP3：仓库随包的 ffmpeg-audio 运行时只会编 FLAC 和 WAV（见 modSystem/ffmpeg.cjs 头注释），
 * 而「放不了 AAC」的客户端未必接得住 FLAC；MP3 是唯一到处都能放的格式。因此本模块**不复用**
 * modSystem 的 resolver —— 那头明写了两个 slot 的候选不许共享，而且它只探 `-version`，
 * 分不出「能转码」和「只能转 FLAC」。这里自己解析，并用 `-encoders` 实探 libmp3lame。
 *
 * 缓存按「主机 + 路径」寻址：直链 query 里的 a/qs/btag 是会轮换的签名，带上就永远不命中；
 * 实测同曲同质量多次请求，host+pathname 稳定。淘汰走 electron/audioCachePrune.cjs（纯函数、已有单测）。
 */

/**
 * @typedef {(command: string, args: string[], options: object,
 *   callback: (error: Error | null, stdout?: string, stderr?: string) => void) => void} FfmpegProbe
 * @typedef {(...args: any[]) => any} ProcessStub
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { execFile, spawn } = require('child_process');

const { resolveCacheLimit, selectEvictions } = require('./audioCachePrune.cjs');

/** 换格式/换编码参数时改这个，老缓存自然作废。 */
const CACHE_VERSION = 'qishui-mp3-v1';
const MP3_ENCODER = 'libmp3lame';
const DEFAULT_BITRATE = '192k';
/** 默认上限 2GB ≈ 三百来首歌；0 表示不设上限（见 resolveCacheLimit 的语义）。 */
const DEFAULT_CACHE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
const PROBE_TIMEOUT_MS = 10 * 1000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const TRANSCODE_TIMEOUT_MS = 5 * 60 * 1000;
/** 上游整轨理论上就几 MB；给个上限，免得白名单里的域被挂了个超大文件把盘写满。 */
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
/** 比这还小的产物一定不是一首歌（最短的歌也远不止 1KB），当失败处理，别缓存。 */
const MIN_MP3_BYTES = 1024;

// ---------------------------------------------------------------- 纯函数（单测覆盖）

/**
 * 缓存 key = 版本 + 主机 + 路径 + 目标格式 + 码率。
 * 刻意不含 query：那是会轮换的签名；同一首歌同一质量的 host+pathname 实测稳定。
 */
function buildCacheKey(upstreamUrl, { format = 'mp3', bitrate = DEFAULT_BITRATE } = {}) {
  const url = new URL(String(upstreamUrl));
  return crypto.createHash('sha256')
    .update(JSON.stringify({ version: CACHE_VERSION, host: url.host, pathname: url.pathname, format, bitrate }))
    .digest('hex');
}

/**
 * 单区间 Range 解析。返回：
 *   null             没有 Range（或不是单区间）→ 整段 200
 *   { invalid: true } 越界 → 416
 *   { start, end }    206
 * 多区间（`bytes=0-1,5-6`）不实现：媒体元素只会发单区间，硬凑 multipart 只会多一条出错的路。
 */
function parseRangeHeader(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  if (!Number.isSafeInteger(size) || size <= 0) return { invalid: true };

  let start;
  let end;
  if (rawStart === '') {
    // `bytes=-500`：最后 500 字节。
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { invalid: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return { invalid: true };
    if (end > size - 1) end = size - 1;
  }
  if (start > end || start >= size) return { invalid: true };
  return { start, end };
}

/** `ffmpeg -encoders` 的输出里有没有这个编码器（按词边界，别让 libmp3lame2 这类蒙混过去）。 */
function hasEncoder(encodersOutput, name) {
  return new RegExp('(^|[^A-Za-z0-9_])' + name + '([^A-Za-z0-9_]|$)').test(String(encodersOutput || ''));
}

/** 开头是 ID3 标签或 MPEG 帧同步头，才算一个像样的 mp3（只看签名，长度由调用方另外把关）。 */
function looksLikeMp3(buffer) {
  if (!buffer || buffer.length < 3) return false;
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return true;
  return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return String(bytes);
  if (bytes >= 1024 * 1024 * 1024) return (bytes / 1024 / 1024 / 1024).toFixed(1) + 'GB';
  if (bytes >= 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + 'MB';
  if (bytes >= 1024) return (bytes / 1024).toFixed(0) + 'KB';
  return bytes + 'B';
}

/** 日志里只出现 host+path，不带 query（query 里是签名）。 */
function describeSource(upstreamUrl) {
  try {
    const url = new URL(String(upstreamUrl));
    return url.host + url.pathname;
  } catch (_) {
    return String(upstreamUrl || '').slice(0, 80);
  }
}

/**
 * 找到一台**能编 MP3** 的 ffmpeg：`QISHUI_SERVER_FFMPEG` 显式指定 → PATH 上的 ffmpeg。
 * 每台都要过 `-encoders` 里有没有 libmp3lame：只探 `-version` 的话，只会编 FLAC/WAV 的精简版
 * 看着也很健康（modSystem 那头注释里的原话）。找不到就返回 null，调用方原样回退 AAC。
 *
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {FfmpegProbe} [options.execFileImpl]
 */
async function resolveMp3Ffmpeg({ env = process.env, execFileImpl = execFile } = {}) {
  const override = String(env.QISHUI_SERVER_FFMPEG || '').trim();
  const candidates = [];
  if (override) candidates.push({ command: override, source: 'QISHUI_SERVER_FFMPEG' });
  candidates.push({ command: process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg', source: 'PATH' });

  for (const candidate of candidates) {
    const output = await new Promise(resolve => {
      execFileImpl(candidate.command, ['-hide_banner', '-encoders'], {
        timeout: PROBE_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
      }, (error, stdout, stderr) => {
        if (error) { resolve(null); return; }
        resolve(String(stdout || '') + String(stderr || ''));
      });
    });
    if (output && hasEncoder(output, MP3_ENCODER)) return { path: candidate.command, source: candidate.source };
  }
  return null;
}

function buildEncodeArgs(inputPath, outputPath, bitrate) {
  return [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-y',
    '-i', inputPath,
    '-vn',
    '-c:a', MP3_ENCODER,
    '-b:a', bitrate,
    '-f', 'mp3',
    outputPath,
  ];
}

/** 把上游整轨下到本地；上游是桥的 loopback 音频路由（出来的已是解密后的字节）。 */
async function downloadToFile(url, outPath, { fetchImpl = fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response || !response.ok || !response.body) {
      throw new Error('上游 HTTP ' + ((response && response.status) || '?'));
    }
    const declared = Number(response.headers?.get?.('content-length') || 0);
    if (declared && declared > MAX_SOURCE_BYTES) throw new Error('上游文件过大: ' + declared);
    let written = 0;
    const source = Readable.fromWeb(response.body);
    source.on('data', chunk => {
      written += chunk.length;
      if (written > MAX_SOURCE_BYTES) source.destroy(new Error('上游文件超过 ' + formatBytes(MAX_SOURCE_BYTES)));
    });
    await pipeline(source, fs.createWriteStream(outPath));
    if (written === 0) throw new Error('上游返回了空响应');
    return written;
  } finally {
    clearTimeout(timer);
  }
}

function runFfmpeg(executable, args, { spawnImpl = spawn, timeoutMs = TRANSCODE_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(executable, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) { /* 已经退了 */ }
      finish(new Error('ffmpeg 超时（' + Math.round(timeoutMs / 1000) + 's）'));
    }, timeoutMs);
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('data', chunk => {
        if (stderr.length < 8192) stderr += String(chunk);
      });
    }
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (code === 0) { finish(null); return; }
      const tail = stderr.trim().split('\n').filter(Boolean).pop() || '';
      finish(new Error('ffmpeg 退出码 ' + code + (tail ? ': ' + tail.slice(0, 300) : '')));
    });
  });
}

// ---------------------------------------------------------------- 转码器

/**
 * @param {object} options
 * @param {string} options.cacheDir            缓存目录（服务器传 <userData>/qishui-audio-cache）
 * @param {boolean} [options.enabled]          配置总闸（audio.transcode）
 * @param {number} [options.maxBytes]          缓存上限，0 = 不设上限
 * @param {string} [options.bitrate]           MP3 码率
 * @param {(line: string) => void} [options.log]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {FfmpegProbe} [options.execFileImpl]   ffmpeg 解析与 `-encoders` 探测（单测注入）
 * @param {ProcessStub} [options.spawnImpl]      ffmpeg 进程（单测注入）
 * @param {ProcessStub} [options.fetchImpl]      上游下载（单测注入）
 */
function createAudioTranscoder({
  cacheDir,
  enabled = true,
  maxBytes = DEFAULT_CACHE_LIMIT_BYTES,
  bitrate = DEFAULT_BITRATE,
  log = () => {},
  env = process.env,
  execFileImpl,
  spawnImpl,
  fetchImpl,
} = {}) {
  const limitBytes = resolveCacheLimit(maxBytes);
  const inFlight = new Map();
  let ffmpeg = null;
  let ready = null;
  let pruning = false;

  const init = () => {
    if (ready) return ready;
    ready = (async () => {
      if (!cacheDir) { log('不可用：没给缓存目录'); return; }
      if (!enabled) { log('已关闭（配置 audio.transcode=false）'); return; }
      ffmpeg = await resolveMp3Ffmpeg({ env, execFileImpl });
      if (!ffmpeg) {
        log('不可用：没找到能编 MP3 的 ffmpeg（装一个，或用 QISHUI_SERVER_FFMPEG 指路径）。'
          + '/a?fmt=mp3 会原样回退 AAC，不会有别的坏处。');
        return;
      }
      await fsp.mkdir(cacheDir, { recursive: true });
      log('已启用：' + ffmpeg.path + '（' + ffmpeg.source + '） · 缓存 ' + cacheDir
        + ' · 上限 ' + (limitBytes === Infinity ? '不限' : formatBytes(limitBytes)) + ' · ' + bitrate);
    })().catch(error => {
      ffmpeg = null;
      log('初始化失败（转码不可用）: ' + ((error && error.message) || error));
    });
    return ready;
  };

  const isEnabled = () => Boolean(enabled && ffmpeg);

  const touch = filePath => {
    const now = new Date();
    fsp.utimes(filePath, now, now).catch(() => { /* 只是 LRU 时钟，失败无所谓 */ });
  };

  // 淘汰：mtime 当「最后播放时间」（audioCachePrune 的约定）。正在被读的文件在 Windows 上
  // 可能删不掉，删不掉就跳过 —— 宁可多占一会儿，也不要把正在播的那首先删了。
  const prune = async () => {
    if (pruning || limitBytes === Infinity) return;
    pruning = true;
    try {
      // 只看已完成的条目：`.part.mp3` 也是 .mp3 结尾，正在写的半成品既不该算容量也不该被删。
      const names = (await fsp.readdir(cacheDir)).filter(name => name.endsWith('.mp3') && !name.includes('.part.'));
      const entries = [];
      for (const name of names) {
        const stat = await fsp.stat(path.join(cacheDir, name)).catch(() => null);
        if (stat && stat.isFile()) entries.push({ name, size: stat.size, usedAt: stat.mtimeMs });
      }
      const doomed = selectEvictions(entries, limitBytes);
      for (const name of doomed) {
        await fsp.rm(path.join(cacheDir, name), { force: true })
          .then(() => log('淘汰缓存 ' + name.slice(0, 12) + '…'))
          .catch(() => { /* 正在被读：下一轮再说 */ });
      }
    } catch (error) {
      log('清缓存失败: ' + ((error && error.message) || error));
    } finally {
      pruning = false;
    }
  };

  /**
   * 保证某个直链对应的 MP3 在本地缓存里，返回 { path, size, cached }。
   * 同一 key 并发只转一次；失败会抛出，调用方负责回退。
   */
  const ensure = async (sourceUrl, cleanUrl) => {
    if (!ffmpeg) throw new Error('转码不可用（没找到能编 MP3 的 ffmpeg）');
    const key = buildCacheKey(cleanUrl, { format: 'mp3', bitrate });
    const finalPath = path.join(cacheDir, key + '.mp3');
    const existing = await fsp.stat(finalPath).catch(() => null);
    if (existing && existing.isFile() && existing.size > 0) {
      touch(finalPath);
      return { path: finalPath, size: existing.size, cached: true };
    }
    if (inFlight.has(key)) return inFlight.get(key);

    const job = (async () => {
      const startedAt = Date.now();
      const sourcePart = path.join(cacheDir, key + '.part.src');
      const outputPart = path.join(cacheDir, key + '.part.mp3');
      try {
        const downloaded = await downloadToFile(sourceUrl, sourcePart, { fetchImpl });
        await runFfmpeg(ffmpeg.path, buildEncodeArgs(sourcePart, outputPart, bitrate), { spawnImpl });
        const head = await readHead(outputPart, 16);
        const size = (await fsp.stat(outputPart)).size;
        // 签名对 + 大小过得了最小关：退到一半的产物也是「有签名的小文件」。
        if (size < MIN_MP3_BYTES || !looksLikeMp3(head)) throw new Error('转码产物不像 MP3（' + size + 'B）');
        await fsp.rm(finalPath, { force: true });
        await fsp.rename(outputPart, finalPath);
        log('转码 ' + describeSource(cleanUrl) + ' → ' + formatBytes(size) + ' · 源 '
          + formatBytes(downloaded) + ' · ' + (Date.now() - startedAt) + 'ms');
        void prune();
        return { path: finalPath, size, cached: false };
      } catch (error) {
        log('转码失败 ' + describeSource(cleanUrl) + ': ' + ((error && error.message) || error));
        throw error;
      } finally {
        inFlight.delete(key);
        await fsp.rm(sourcePart, { force: true }).catch(() => {});
        await fsp.rm(outputPart, { force: true }).catch(() => {});
      }
    })();
    inFlight.set(key, job);
    return job;
  };

  /** 本地 Range 供片（缓存文件不再经过桥的 loopback，得自己实现 206/416/HEAD）。 */
  const serve = async (req, res, filePath, extraHeaders = {}) => {
    const size = (await fsp.stat(filePath)).size;
    const headers = Object.assign({
      'Content-Type': 'audio/mpeg',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=3600',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
    }, extraHeaders);
    touch(filePath);

    const range = req.headers && req.headers.range ? parseRangeHeader(req.headers.range, size) : null;
    if (range && range.invalid) {
      res.writeHead(416, Object.assign({}, headers, { 'Content-Range': 'bytes */' + size }));
      res.end();
      return;
    }
    if (req.method === 'HEAD') {
      res.writeHead(200, Object.assign({}, headers, { 'Content-Length': String(size) }));
      res.end();
      return;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    res.writeHead(range ? 206 : 200, Object.assign({}, headers, {
      'Content-Length': String(end - start + 1),
      ...(range ? { 'Content-Range': 'bytes ' + start + '-' + end + '/' + size } : {}),
    }));
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  };

  return { init, isEnabled, ensure, serve };
}

async function readHead(filePath, length) {
  const handle = await fsp.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

module.exports = {
  CACHE_VERSION,
  DEFAULT_BITRATE,
  DEFAULT_CACHE_LIMIT_BYTES,
  MP3_ENCODER,
  buildCacheKey,
  buildEncodeArgs,
  createAudioTranscoder,
  hasEncoder,
  looksLikeMp3,
  parseRangeHeader,
  resolveMp3Ffmpeg,
};
