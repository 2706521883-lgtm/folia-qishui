// src/utils/lyrics/providers/qqLyricProvider.ts

/**
 * QQ Music lyrics provider module.
 * Provides search and download/decryption capabilities for QQ Music lyrics.
 */

import { SongResult } from '../../../types';
import { parseLyricsByFormat } from '../parserCore';
import { detectTimedLyricFormat } from '../formatDetection';
import { qrcDecrypt } from './qrcDecrypt';
import { applyDetectedChorusEffects, applyNeteaseChorusByTime } from '../chorusEffects';
import type { NeteaseChorusRange } from '../chorusEffects';
import { getOriginalCoverUrl } from '../../coverUrl';

const isElectron = typeof window !== 'undefined' && (window as any).electron;

/**
 * QQ answers throttled/refused requests with HTTP 200 and an inner business code
 * (2001 = search refused) while the body stays an empty result skeleton, so the
 * inner code has to be inspected instead of the HTTP status.
 */
const QQ_RETRYABLE_CODES = new Set([2001]);

/** Backoff between retries of a throttled request. */
const QQ_RETRY_DELAY_MS = 400;

/** Search module plus the method names tried in order; both answer with `body.item_song`. */
const QQ_SEARCH_MODULE = "music.search.SearchCgiService";
const QQ_SEARCH_METHODS = ["DoSearchForQQMusicMobile", "DoSearchForQQMusicLite"];

/** Error carrying QQ's business code so callers can tell a throttle from a hard failure. */
class QQMusicApiError extends Error {
  readonly code: number;
  readonly method: string;
  readonly retryable: boolean;

  constructor(code: number, method: string) {
    super(`QQ Music API error: code ${code}`);
    this.name = 'QQMusicApiError';
    this.code = code;
    this.method = method;
    this.retryable = QQ_RETRYABLE_CODES.has(code);
  }
}

/**
 * Sends a POST request to u.y.qq.com via proxy or directly in Electron.
 */
async function requestQQ(method: string, module: string, param: any): Promise<any> {
  const payload = {
    comm: {
      ct: 11,
      cv: "1003006",
      v: "1003006",
      os_ver: "15",
      phonetype: "24122RKC7C",
      rom: "Redmi/miro/miro:15/AE3A.240806.005/OS2.0.102.0.VOMCNXM:user/release-keys",
      tmeAppID: "qqmusiclight",
      nettype: "NETWORK_WIFI",
      udid: "0",
      uid: "0",
    },
    request: {
      method,
      module,
      param,
    },
  };

  const targetUrl = 'https://u.y.qq.com/cgi-bin/musicu.fcg';
  const url = isElectron ? targetUrl : `/api/lyric-proxy?url=${encodeURIComponent(targetUrl)}`;

  const response = await fetch(url, {
    method: 'POST',
    credentials: isElectron ? 'omit' : 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': 'tmeLoginType=-1;',
      'User-Agent': 'okhttp/3.14.9',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`QQ Music API request failed: ${response.status}`);
  }

  const data = await response.json();
  const businessCode = Number(data.code || data.request?.code || 0);
  if (data.code !== 0 || data.request?.code !== 0) {
    throw new QQMusicApiError(businessCode, method);
  }

  return data.request.data;
}

/** Resolves after `ms` — spaces out retries of a throttled request. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Calls one QQ method, retrying throttled (2001) envelopes with a short backoff. */
async function requestQQWithRetry(
  method: string,
  module: string,
  param: any,
  attempts = 2
): Promise<any> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestQQ(method, module, param);
    } catch (error) {
      lastError = error;
      if (!(error instanceof QQMusicApiError) || !error.retryable || attempt === attempts) {
        break;
      }
      await sleep(QQ_RETRY_DELAY_MS * attempt);
    }
  }

  throw lastError;
}

/** Searches with the first method that answers; QQ throttles methods individually. */
async function requestQQSearch(param: any): Promise<any> {
  let lastError: unknown;

  for (const method of QQ_SEARCH_METHODS) {
    try {
      return await requestQQWithRetry(method, QQ_SEARCH_MODULE, param);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

/**
 * Encodes string to Base64 in UTF-8.
 */
function toBase64(str: string): string {
  try {
    return btoa(unescape(encodeURIComponent(str)));
  } catch {
    return btoa(
      encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_, p1) =>
        String.fromCharCode(parseInt(p1, 16))
      )
    );
  }
}

/**
 * Detects if a lyric string is in QRC format.
 */
function detectIsQrc(content: string): boolean {
  return content.includes('(') && content.includes(')') && /\[\d+,\d+\]/.test(content);
}

/**
 * Searches songs on QQ Music.
 */
export async function searchQQLyrics(keyword: string, page = 1, pageSize = 20): Promise<SongResult[]> {
  const safeKeyword = keyword.trim();
  if (!safeKeyword) return [];

  const pagesize = pageSize;
  const param = {
    search_id: String(
      Math.floor(
        Math.random() * 100000000000000 + Date.now() % 86400000
      )
    ),
    remoteplace: "search.android.keyboard",
    query: safeKeyword.length > 60 ? safeKeyword.slice(0, 60) : safeKeyword,
    search_type: 0, // 0 = SONG
    num_per_page: pagesize,
    page_num: page,
    highlight: 0,
    nqc_flag: 0,
    page_id: 1,
    grp: 1,
  };

  try {
    const data = await requestQQSearch(param);
    const songs = data?.body?.item_song || [];
    
    return songs.map((info: any) => {
      const artists = (info.singer || []).map((s: any, idx: number) => ({
        id: s.id || idx,
        name: s.name || 'Unknown Artist',
      }));
      
      const albumMid = info.album?.mid;
      const picUrl = albumMid
        ? getOriginalCoverUrl(`https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg?max_age=2592000`)
        : undefined;

      return {
        id: Number(info.id || 0),
        name: info.title || 'Unknown Song',
        artists,
        album: {
          id: Number(info.album?.id || 0),
          name: info.album?.name || 'Unknown Album',
          coverUrl: picUrl,
        },
        durationMs: (info.interval || 0) * 1000,
        qqMid: info.mid,
      };
    });
  } catch (error) {
    if (error instanceof QQMusicApiError && error.retryable) {
      console.warn('[QQMusic] Search refused by QQ (code 2001) after every retry.');
    }
    console.error('[QQMusic] Search failed:', error);
    return [];
  }
}

/**
 * Fetches and decrypts QQ Music lyrics.
 */
export async function fetchQQLyrics(
  song: SongResult,
  options: { chorusRanges?: NeteaseChorusRange[] } = {}
): Promise<any | null> {
  if (!song.id || !song.qqMid) {
    throw new Error('Missing song ID or mid');
  }

  const artistsStr = song.artists?.map(a => a.name).join(', ') || '';
  
  const param = {
    albumName: toBase64(song.album?.name || ''),
    crypt: 1,
    ct: 19,
    cv: 2111,
    interval: Math.floor(song.durationMs / 1000),
    lrc_t: 0,
    qrc: 1,
    qrc_t: 0,
    roma: 1,
    roma_t: 0,
    singerName: toBase64(artistsStr),
    songID: Number(song.id),
    songName: toBase64(song.name),
    trans: 1,
    trans_t: 0,
    type: 0,
  };

  try {
    const data = await requestQQ("GetPlayLyricInfo", "music.musichallSong.PlayLyricInfo", param);
    const encryptedLyricHex = data?.lyric;
    const encryptedTransHex = data?.trans;
    const encryptedRomanizationHex = data?.roma;

    if (!encryptedLyricHex) {
      return null;
    }

    const decryptedLyric = await qrcDecrypt(encryptedLyricHex);
    const decryptedTrans = encryptedTransHex ? await qrcDecrypt(encryptedTransHex) : '';
    const decryptedRomanization = encryptedRomanizationHex ? await qrcDecrypt(encryptedRomanizationHex) : '';

    const isQrc = detectIsQrc(decryptedLyric);
    const format = isQrc ? 'qrc' : detectTimedLyricFormat(decryptedLyric);

    const parsed = parseLyricsByFormat(format, decryptedLyric, decryptedTrans, {}, decryptedRomanization);
    if (!parsed) {
      return null;
    }
    parsed.isWordByWord = isQrc;
    if (options.chorusRanges && options.chorusRanges.length > 0) {
      return applyNeteaseChorusByTime(parsed, options.chorusRanges);
    }
    return applyDetectedChorusEffects(parsed, decryptedLyric);
  } catch (error) {
    console.error('[QQMusic] Fetch lyrics failed:', error);
    return null;
  }
}
