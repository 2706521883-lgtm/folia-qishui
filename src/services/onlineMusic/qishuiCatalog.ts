import type { UnifiedSong } from '../../types';
import type { MediaId, OnlineCatalogProvider, ProviderCollection, ProviderPage } from '../../types/onlineMusic';
import { OnlineProviderError } from '../../types/onlineMusic';
import { normalizeQishuiCollection, normalizeQishuiSong, qishuiArtistName, qishuiPage } from './qishuiNormalize';
import { requestQishui, throwQishuiDataError } from './qishuiTransport';

// src/services/onlineMusic/qishuiCatalog.ts

// 协议层的虚拟歌单 id：我的喜欢 / 最近播放 / 推荐流。
export const QISHUI_LIKED_PLAYLIST_ID = 'qishui-liked';
export const QISHUI_RECENT_PLAYLIST_ID = 'qishui-recent';
export const QISHUI_FEED_PLAYLIST_ID = 'qishui-feed';
// 与 electron/qishui/qishui-api.js 的 QISHUI_FEED_TOTAL_CAP 保持一致。
// Folia 首屏取 150、后台每页取 1000；必须给一个有限 total，后台补页才会自然停止。
export const QISHUI_FEED_TOTAL_CAP = 200;

// `artist` 与 `album` 两个操作每次都从第一页开始搜（协议层不接受 offset），
// 所以它们的结果一次取满、在内存里分页，已经取完就不能再声称 hasMore。
const QISHUI_ARTIST_TRACK_LIMIT = 50;
const QISHUI_ALBUM_TRACK_LIMIT = 120;

export async function qishuiTrackPage(id: MediaId, limit: number, offset: number): Promise<ProviderPage<UnifiedSong>> {
    const data = await requestQishui<any>('playlist.tracks', { id, limit, offset });
    throwQishuiDataError(data);
    const raw = Array.isArray(data.tracks) ? data.tracks : (Array.isArray(data.songs) ? data.songs : null);
    if (!raw) throw new OnlineProviderError('invalid-response', 'Qishui track page is missing its list', 'qishui');
    return qishuiPage(raw.map(normalizeQishuiSong), data.total, offset, limit, data);
}

// 歌单详情没有独立 operation，但 `playlist.tracks` 会把解析出的歌单卡片一并带回。
async function fetchQishuiPlaylistCard(id: MediaId) {
    const data = await requestQishui<any>('playlist.tracks', { id, limit: 1, offset: 0 });
    throwQishuiDataError(data);
    return data.playlist ?? null;
}

const qishuiFeedCollection = (id: MediaId): ProviderCollection => ({
    providerId: 'qishui', id, type: 'playlist', name: '汽水推荐流',
    trackCount: QISHUI_FEED_TOTAL_CAP, isOwned: false,
    providerData: { virtual: true, playbackMode: 'recommend-match' },
});

// 虚拟推荐流按 offset 切片：协议层维护会话缓冲与跨页去重，
// 返回的 nextOffset 是「本 flow 已服务的唯一歌曲数」，不是上游游标。
async function qishuiFeedPage(limit: number, offset: number): Promise<ProviderPage<UnifiedSong>> {
    if (offset >= QISHUI_FEED_TOTAL_CAP) {
        return { items: [], total: QISHUI_FEED_TOTAL_CAP, hasMore: false, nextOffset: offset };
    }
    const data = await requestQishui<any>('feed.recommend', {
        limit, offset, flow: 'playlist', advance: false,
    });
    throwQishuiDataError(data);
    const raw = Array.isArray(data?.tracks) ? data.tracks : (Array.isArray(data?.songs) ? data.songs : null);
    if (!raw) throw new OnlineProviderError('invalid-response', 'Qishui feed page is missing its list', 'qishui');
    const total = Number(data.total);
    return qishuiPage(raw.map(normalizeQishuiSong), Number.isFinite(total) && total > 0 ? total : QISHUI_FEED_TOTAL_CAP, offset, limit, {
        nextOffset: data.nextOffset,
        hasMore: data.hasMore,
    });
}

export const qishuiCatalog: OnlineCatalogProvider = {
    canResolveSongCatalogRefs: song => song.sourceRef?.kind === 'online' && song.sourceRef.providerId === 'qishui',
    resolveSongCatalogRefs: async song => song,
    getPlaylistTracks: (id, limit, offset) => (
        String(id) === QISHUI_FEED_PLAYLIST_ID
            ? qishuiFeedPage(limit, offset)
            : qishuiTrackPage(id, limit, offset)
    ),
    async getPlaylistDetail(id, collection) {
        // 虚拟推荐流没有真实歌单卡：不要去发 limit=1 的 playlist.tracks，否则会得到「只有 1 首」。
        // 即使调用方拿的是旧缓存卡片，也用规范字段覆盖名称/上限/只读标记。
        if (String(id) === QISHUI_FEED_PLAYLIST_ID) {
            return collection?.providerId === 'qishui'
                ? {
                    ...collection, name: '汽水推荐流', trackCount: QISHUI_FEED_TOTAL_CAP, isOwned: false,
                    providerData: { ...collection.providerData, virtual: true, playbackMode: 'recommend-match' },
                }
                : qishuiFeedCollection(id);
        }
        if (collection?.providerId === 'qishui') return collection;
        const card = await fetchQishuiPlaylistCard(id);
        return card ? normalizeQishuiCollection(card) : null;
    },
    async getAlbumTracks(id, limit = 50, offset = 0) {
        const data = await requestQishui<any>('album', { id, limit: QISHUI_ALBUM_TRACK_LIMIT });
        throwQishuiDataError(data);
        const raw = Array.isArray(data.songs) ? data.songs : [];
        const items = raw.slice(offset, offset + limit).map(normalizeQishuiSong);
        return qishuiPage(items, raw.length, offset, limit);
    },
    async getAlbumDetail(id) {
        const data = await requestQishui<any>('album', { id, limit: 1 });
        throwQishuiDataError(data);
        return data.album ? normalizeQishuiCollection(data.album, 'album') : null;
    },
    async getArtistSongs(id, limit, offset) {
        const { songs } = await requestQishuiArtist(id, QISHUI_ARTIST_TRACK_LIMIT);
        const items = songs.slice(offset, offset + limit).map(normalizeQishuiSong);
        return qishuiPage(items, songs.length, offset, limit);
    },
    async getArtistDetail(id) {
        const { artist } = await requestQishuiArtist(id, 10);
        return artist ? normalizeQishuiCollection(artist, 'artist') : null;
    },
};

// 歌手页在汽水侧没有主页接口，官方做法是用歌手名搜索再按 id/名字聚合，因此这里只能一次取满。
async function requestQishuiArtist(id: MediaId, limit: number): Promise<{ artist: unknown; songs: unknown[] }> {
    const artistName = qishuiArtistName(id);
    if (!artistName) {
        throw new OnlineProviderError('invalid-response', 'Qishui artist lookup needs the artist name from a search result', 'qishui');
    }
    const data = await requestQishui<any>('artist', { artistId: id, artistName, limit });
    // 搜不到匹配只是「这位歌手暂时没有可列出的歌」，不是请求失败。
    if (data?.error === 'QISHUI_ARTIST_SEARCH_FAILED') return { artist: null, songs: [] };
    throwQishuiDataError(data);
    return { artist: data.artist ?? null, songs: Array.isArray(data.songs) ? data.songs : [] };
}
