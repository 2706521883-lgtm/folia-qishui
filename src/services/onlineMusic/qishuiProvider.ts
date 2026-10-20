import type { UnifiedSong } from '../../types';
import type { OnlineMusicProvider, ProviderAudioSource, ProviderCollection } from '../../types/onlineMusic';
import { OnlineProviderError } from '../../types/onlineMusic';
import { createProviderSongMetadata } from '../../utils/songMetadata';
import { parseQishuiLyrics } from '../../utils/lyrics/qishuiLyrics';
import { getQishuiTransportAvailability, requestQishui, throwQishuiDataError } from './qishuiTransport';
import { normalizeQishuiCollection, normalizeQishuiSong, normalizeQishuiUser, qishuiPage, qishuiText } from './qishuiNormalize';
import { QISHUI_FEED_PLAYLIST_ID, QISHUI_FEED_TOTAL_CAP, qishuiCatalog } from './qishuiCatalog';
import { clearQishuiLibraryCache, qishuiLibrary } from './qishuiLibrary';
import { qishuiMutations } from './qishuiMutations';

// src/services/onlineMusic/qishuiProvider.ts

// 搜索接口把 limit 收在 18 以内，请求再大也只拿得到这么多。
const QISHUI_PAGE_MAX = 18;
// Personal FM 每批补多少首；桥接层 feed.recommend 的上限是 50。
const QISHUI_FEED_PAGE_SIZE = 20;
// 主进程没给二维码有效期时的兜底：汽水二维码按 5 分钟算。
const QISHUI_QR_TTL_MS = 5 * 60 * 1000;

// 汽水扫码登录一步就返回 token 与二维码，而 Omni 走的是 getQrKey -> createQr 两步，
// 所以这里用 token 记住这一次会话的二维码，再由 createQr 取出来。
const qrSessions = new Map<string, string>();
let qrTtlMs = QISHUI_QR_TTL_MS;

function qishuiNotOurs(): OnlineProviderError {
    return new OnlineProviderError('unsupported', 'Song does not belong to Qishui Music', 'qishui');
}

export const qishuiProvider: OnlineMusicProvider = {
    id: 'qishui', displayName: '汽水音乐', shortName: '汽水',
    getAvailability: getQishuiTransportAvailability,
    capabilities: {
        search: true, playback: true, lyrics: true, wordByWordLyrics: true, auth: true,
        playlists: true, albums: true, artists: true, recommendations: true, personalFm: true,
        userLibrary: true, likes: true, mutations: true, playlistTrackMutations: true,
    },
    normalizeSong: normalizeQishuiSong, normalizeUser: normalizeQishuiUser, normalizeCollection: normalizeQishuiCollection,
    songMetadata: { getSongMetadata: createProviderSongMetadata },
    search: {
        async searchSongs(query, limit, offset) {
            if (!query.trim()) return qishuiPage([], 0, offset, limit);
            const data = await requestQishui<any>('search', { keywords: query, limit: Math.min(limit, QISHUI_PAGE_MAX), offset });
            throwQishuiDataError(data);
            if (!Array.isArray(data.songs)) throw new OnlineProviderError('invalid-response', 'Qishui search list is missing', 'qishui');
            return qishuiPage(data.songs.map(normalizeQishuiSong), data.total, offset, limit, data);
        },
    },
    playback: {
        async getSongDetail(id) {
            const data = await requestQishui<any>('song.detail', { id });
            throwQishuiDataError(data);
            return data.song ? normalizeQishuiSong(data.song) : null;
        },
        async getAudioSource(song, quality) {
            const source = song.sourceRef;
            if (source?.kind !== 'online' || source.providerId !== 'qishui') throw qishuiNotOurs();
            const data = await requestQishui<any>('song.url', { id: source.mediaId, quality });
            // 试听段不能当成整曲进缓存与时长统计，与波点保持同一判断。
            if (data?.trial === true) {
                throw new OnlineProviderError('preview-only', 'Qishui Music only offers a preview for this account', 'qishui');
            }
            const url = qishuiText(data?.url);
            if (url && data?.playable !== false) {
                const audio: ProviderAudioSource = { url, fetchedAt: Date.now(), quality };
                return audio;
            }
            const category = qishuiText(data?.restriction?.category || data?.reason).toLowerCase();
            const message = qishuiText(data?.message);
            if (category === 'login_required' || category === 'cookie_required') {
                throw new OnlineProviderError('auth-required',
                    message || 'Sign in to Qishui Music to play this track', 'qishui');
            }
            if (/vip|member|subscription|paid|paywall|会员|付费/.test(category)) {
                throw new OnlineProviderError('subscription-required',
                    message || 'Qishui Music requires a paid account for this track', 'qishui',
                    undefined, undefined, undefined, { case: 'subscription-required', message });
            }
            if (/region|area|geo|地区/.test(category)) {
                throw new OnlineProviderError('region-restricted',
                    message || 'Qishui Music restricts this track in your region', 'qishui',
                    undefined, undefined, undefined, { case: 'region-restricted', message });
            }
            if (/trial|preview|试听/.test(category)) {
                throw new OnlineProviderError('preview-only',
                    message || 'Qishui Music only offers a preview for this account', 'qishui',
                    undefined, undefined, undefined, { case: 'preview-only', message });
            }
            // 拿不到直连 URL 时协议层把这首歌退回「推荐/匹配源」，交给上层换源。
            throw new OnlineProviderError('not-playable',
                message || 'Qishui Music has no direct audio URL for this track', 'qishui',
                undefined, undefined, undefined, { case: 'no-audio', message });
        },
        getAvailability(song) {
            return song.sourceRef?.kind === 'online' && song.sourceRef.providerData?.unavailable
                ? { state: 'unavailable' } : { state: 'unknown' };
        },
    },
    lyrics: {
        async getLyrics(song) {
            const source = song.sourceRef;
            if (source?.kind !== 'online' || source.providerId !== 'qishui') throw qishuiNotOurs();
            const data = await requestQishui<any>('lyric', { id: source.mediaId });
            // 找不到歌词时协议层回空文本 + source: 'none'，这是合法答案而不是请求失败。
            return parseQishuiLyrics(data ?? {});
        },
    },
    auth: {
        async getLoginStatus() {
            const data = await requestQishui<any>('status', {});
            if (!data?.loggedIn) return null;
            const user = normalizeQishuiUser(data);
            // 登录态只有 status 这一处能读，缺 id 也不能当作未登录，否则整库会被清空。
            return { ...user, id: user.id || 'qishui-account' };
        },
        async logout() { clearQishuiLibraryCache(); await requestQishui('login.logout', {}); },
        async getQrKey() {
            const data = await requestQishui<any>('login.qr', {});
            const token = qishuiText(data?.token);
            const imageUrl = qishuiText(data?.qrDataUrl || data?.qrcode || data?.qrCodeUrl);
            if (!token || !imageUrl) {
                throw new OnlineProviderError('invalid-response', 'Qishui QR login payload is incomplete', 'qishui');
            }
            const ttl = Number(data?.ttlMs);
            const expiresAt = Number(data?.expiresAt);
            // 主进程把协议返回的 expire_time 原样带出来（当前版本通常为 0，即用默认 5 分钟），
            // 它可能是秒级时长，也可能是秒/毫秒时间戳，所以按数值量级判定。
            const expireTime = Number(data?.expireTime);
            if (Number.isFinite(ttl) && ttl > 0) qrTtlMs = ttl;
            else if (Number.isFinite(expiresAt) && expiresAt > Date.now()) qrTtlMs = expiresAt - Date.now();
            else if (Number.isFinite(expireTime) && expireTime > 0) {
                const resolved = expireTime >= 1e12 ? expireTime - Date.now()
                    : expireTime >= 1e9 ? expireTime * 1000 - Date.now() : expireTime * 1000;
                qrTtlMs = resolved > 0 ? resolved : QISHUI_QR_TTL_MS;
            }
            qrSessions.set(token, imageUrl);
            return token;
        },
        async createQr(key) {
            const imageUrl = qrSessions.get(key);
            if (!imageUrl) {
                throw new OnlineProviderError('invalid-response', 'Qishui QR session is no longer available', 'qishui');
            }
            return imageUrl;
        },
        async checkQr(key) {
            let data: any;
            try {
                data = await requestQishui<any>('login.check', { token: key });
            } catch (error) {
                const message = error instanceof Error ? error.message : undefined;
                // 主进程把「设备侧取消验证」抛成 `mfa-cancelled`（映射后会变成 auth-required，
                // 所以这里读 transport 带下来的原始码），还原成 UI 能立刻重试的错误态。
                const rawCode = error instanceof OnlineProviderError ? String(error.cause ?? '') : '';
                if (rawCode.toLowerCase().replace(/[_\s]+/g, '-') === 'mfa-cancelled') {
                    return { state: 'error', reason: 'canceled-on-device', message };
                }
                return { state: 'error', message };
            }
            const message = qishuiText(data?.message) || undefined;
            const retryAfter = Number(data?.retryAfterMs);
            const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : undefined;
            const errorCode = Number(data?.errorCode ?? 0);
            switch (qishuiText(data?.status)) {
                case 'waiting': return { state: 'waiting' };
                case 'scanned': return { state: 'scanned' };
                case 'confirmed': return { state: 'confirmed' };
                case 'expired': return { state: 'expired' };
                // 设备侧取消要给 UI 一个可以立刻重试的理由，其余错误（含 rate_limited）只带文字。
                case 'mfa_cancelled': return { state: 'error', reason: 'canceled-on-device', message, retryAfterMs };
                // 上游的状态词会变：未扫码时实测返回 `status: 'new'`，主进程已归一成 waiting；
                // 万一将来又出现新词，只要没有非零 errorCode 就继续等，不要把它当登录失败 ——
                // 否则 UI 会在用户还没扫码时就显示「登录错误」。
                default: return errorCode !== 0
                    ? { state: 'error', message, retryAfterMs }
                    : { state: 'waiting' };
            }
        },
        async cancelQr(key) { qrSessions.delete(key); },
        getQrTtlMs: () => qrTtlMs,
    },
    catalog: qishuiCatalog,
    library: qishuiLibrary,
    mutations: qishuiMutations,
    recommendations: {
        async getRecommendedCollections(limit) {
            // 预览只读 playlist 会话，不推进 Personal FM；临时失败也保留入口，
            // 只有明确未登录时才隐藏（否则一次 feed 抖动就会让「汽水推荐流」消失）。
            let songs: UnifiedSong[] = [];
            let available = true;
            try {
                const data = await requestQishui<any>('feed.recommend', {
                    limit: Math.max(1, Math.min(limit, 8)), offset: 0, flow: 'playlist', advance: false,
                });
                songs = Array.isArray(data?.songs) ? data.songs.map(normalizeQishuiSong) : [];
            } catch (error) {
                if (error instanceof OnlineProviderError && error.code === 'auth-required') available = false;
                else console.warn('[Qishui] Recommendation preview failed:', error);
            }
            if (!available) return [];
            const collection: ProviderCollection = {
                providerId: 'qishui', id: QISHUI_FEED_PLAYLIST_ID, type: 'playlist', name: '汽水推荐流',
                coverUrl: songs[0]?.album.coverUrl, trackCount: QISHUI_FEED_TOTAL_CAP, isOwned: false,
                providerData: { virtual: true, playbackMode: 'recommend-match' },
            };
            return [collection].slice(0, limit);
        },
        async getPersonalFm() {
            // 每次调用推进 FM 会话的一批；播放队列剩两首时会自动用新批次续歌。
            try {
                const data = await requestQishui<any>('feed.recommend', {
                    limit: QISHUI_FEED_PAGE_SIZE, flow: 'fm', advance: true,
                });
                return Array.isArray(data?.songs) ? data.songs.map(normalizeQishuiSong) : [];
            } catch (error) {
                console.warn('[Qishui] Personal FM fetch failed:', error);
                return [];
            }
        },
        async getPersonalFmPreview() {
            // 首页封面用的只读 peek：不消费 FM 的下一批，避免进一次电台页就少一批歌。
            try {
                const data = await requestQishui<any>('feed.recommend', {
                    limit: 1, flow: 'fm', advance: false,
                });
                return Array.isArray(data?.songs) ? data.songs.map(normalizeQishuiSong) : [];
            } catch {
                return [];
            }
        },
    },
};
