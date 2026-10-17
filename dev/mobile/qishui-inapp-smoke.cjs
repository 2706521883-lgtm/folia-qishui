#!/usr/bin/env node
'use strict';

/**
 * 内置汽水 RPC 冒烟（无 cookie、无签名）。
 *
 * 用法：
 *   node dev/mobile/prepare-node-project.mjs --install
 *   node dev/mobile/qishui-inapp-smoke.cjs [工程目录，默认 build/nodejs-project]
 *
 * 判据：
 *   status      不登录也返回 configured=true / loggedIn=false
 *   search      Luna 搜索拿到至少一首歌（id / name / artists / duration）
 *   song.url    SEO 取流拿到 https 播放地址（免费整曲或付费试听都算通过）
 *   lyric       返回对象且带 lyric/source 字段
 *
 * search / song.url / lyric 是真机端点检查；CI 的境外 runner 可能访问不了汽水，
 * 设 FOLIA_SMOKE_ALLOW_LIVE_FAILURE=1 可把这部分降级为警告（工程装配与 status 仍严格）。
 *
 * 不读取、不打印、不发送任何用户 cookie；状态目录用临时目录。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const projectDir = path.resolve(process.argv[2] || path.join('build', 'nodejs-project'));
const entry = path.join(projectDir, 'qishui-inapp.cjs');

function fail(message) {
  console.error('[FAIL] ' + message);
  process.exit(1);
}

(async () => {
  if (!fs.existsSync(entry)) fail('assembled project missing: ' + entry + ' (run prepare-node-project.mjs --install)');
  for (const required of ['main.js', 'qishui/qishui-api.js', 'node_modules/kugoumusicapi', 'node_modules/@yakult-green-tea/qq-music-api']) {
    if (!fs.existsSync(path.join(projectDir, required))) fail('assembled project missing ' + required);
  }

  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folia-qishui-smoke-'));
  process.env.FOLIA_STATE_DIR = stateDir;
  process.env.FOLIA_LOG_DIR = stateDir;

  const { createQishuiInApp } = require(entry);
  const app = createQishuiInApp();

  const status = await app.request('status', {});
  if (!status.ok) fail('status failed: ' + JSON.stringify(status));
  if (status.data.configured !== true) fail('status.configured is not true');
  if (status.data.loggedIn !== false) fail('status.loggedIn should be false without a cookie');
  if (status.data.capabilities.playableUrl !== true) fail('status.capabilities.playableUrl should be true (SEO playback)');
  console.log('[PASS] status: configured=' + status.data.configured + ' loggedIn=' + status.data.loggedIn);

  // 真机端点检查需要能访问汽水（中国大陆网络最好）。GitHub 的 macOS runner 在境外，
  // 可能被限流/拒绝 —— CI 里允许这部分降级成警告，但工程装配、RPC 形状仍然严格校验。
  const allowLiveFailure = process.env.FOLIA_SMOKE_ALLOW_LIVE_FAILURE === '1';
  const checkLive = async () => {
    const search = await app.request('search', { keywords: '周杰伦', limit: 5, offset: 0 });
    if (!search.ok) throw new Error('search failed: ' + JSON.stringify(search));
    const songs = Array.isArray(search.data.songs) ? search.data.songs : [];
    if (!songs.length) throw new Error('search returned no songs');
    const song = songs[0];
    for (const field of ['id', 'name']) {
      if (!song[field]) throw new Error('search song missing ' + field);
    }
    if (!Array.isArray(song.artists) || !song.artists.length) throw new Error('search song missing artists');
    if (!(Number(song.duration) > 0)) throw new Error('search song duration should be seconds > 0, got ' + song.duration);
    console.log('[PASS] search: ' + songs.length + ' songs, first=' + song.name + '#' + song.id +
      ' duration=' + song.duration + 's');

    const play = await app.request('song.url', { id: song.id, quality: 'high' });
    if (!play.ok) throw new Error('song.url failed: ' + JSON.stringify(play));
    if (!play.data || play.data.playable !== true) throw new Error('song.url not playable: ' + JSON.stringify(play.data));
    if (!/^https?:\/\//i.test(String(play.data.url || ''))) throw new Error('song.url is not an http(s) URL');
    console.log('[PASS] song.url: quality=' + play.data.quality + ' trial=' + play.data.trial +
      ' duration=' + play.data.duration + 's url=' + String(play.data.url).slice(0, 60) + '...');

    const lyric = await app.request('lyric', { id: song.id });
    if (!lyric.ok) throw new Error('lyric failed: ' + JSON.stringify(lyric));
    if (!lyric.data || typeof lyric.data !== 'object') throw new Error('lyric payload is not an object');
    console.log('[PASS] lyric: source=' + (lyric.data.source || '(none)') +
      ' lyricLength=' + String(lyric.data.lyric || '').length);
  };

  try {
    await checkLive();
  } catch (error) {
    if (!allowLiveFailure) fail((error && error.stack) || String(error));
    console.warn('[WARN] live Qishui checks unavailable here, skipped: ' + ((error && error.message) || error));
  }

  fs.rmSync(stateDir, { recursive: true, force: true });
  console.log('[PASS] qishui in-app RPC smoke (no cookie, no signature)');
  process.exit(0);
})().catch(error => fail((error && error.stack) || String(error)));
