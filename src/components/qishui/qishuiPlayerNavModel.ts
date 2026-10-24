import type { ProviderCollection } from '../../types/onlineMusic';
import {
    QISHUI_FEED_PLAYLIST_ID,
    QISHUI_LIKED_PLAYLIST_ID,
    QISHUI_RECENT_PLAYLIST_ID,
} from '../../services/onlineMusic/qishuiCatalog';

// src/components/qishui/qishuiPlayerNavModel.ts
// Mirrors the official Qishui PC sidebar: liked / Douyin favourites / history are special
// playlists, while the rest of the self-created playlists form the "创建的歌单" list.
export type QishuiPlayerNavModel = {
    feed: ProviderCollection | null;
    liked: ProviderCollection | null;
    recent: ProviderCollection | null;
    douyin: ProviderCollection | null;
    created: ProviderCollection[];
    /** 非汽水平台：全部非特殊歌单；汽水仍用 created 的严格分类。 */
    playlists: ProviderCollection[];
};

const SELF_CREATED_TYPES = new Set([2, 3, 11]);

const playlistType = (collection: ProviderCollection): number => {
    const value = Number(collection.providerData?.qishuiPlaylistType);
    return Number.isFinite(value) ? value : 0;
};

// 各平台的内置「喜欢」歌单都有自己的标记（netEase/QQ/Bodian 都给 isLiked），名字只做兜底；
// 用整名匹配，避免把用户自建的「My Favorite Songs」误收进我的音乐。
const LIKED_NAMES = /^(我喜欢|我喜欢的音乐|我的喜欢|喜欢的音乐|favorites?|liked songs?)$/i;
const RECENT_NAMES = /^(最近播放|最近收听|recent(ly)? played)$/i;

const isLiked = (collection: ProviderCollection): boolean => (
    collection.isLiked === true
    || String(collection.id) === QISHUI_LIKED_PLAYLIST_ID
    || playlistType(collection) === 1
    || LIKED_NAMES.test(collection.name.trim())
);

const isRecent = (collection: ProviderCollection): boolean => (
    String(collection.id) === QISHUI_RECENT_PLAYLIST_ID
    || RECENT_NAMES.test(collection.name.trim())
);

const isDouyin = (collection: ProviderCollection): boolean => (
    playlistType(collection) === 4
    || (collection.providerId === 'qishui' && /抖音|douyin/i.test(collection.name))
);

const isFeed = (collection: ProviderCollection): boolean => (
    String(collection.id) === QISHUI_FEED_PLAYLIST_ID
    || /汽水推荐流/i.test(collection.name)
);

const isCreated = (collection: ProviderCollection): boolean => (
    SELF_CREATED_TYPES.has(playlistType(collection))
    || collection.isOwned === true
    || collection.providerData?.owned === true
    || collection.providerData?.shelfPane === 'mine'
);

const uniqueById = (collections: readonly ProviderCollection[]): ProviderCollection[] => {
    const seen = new Set<string>();
    const unique: ProviderCollection[] = [];
    for (const collection of collections) {
        const id = String(collection.id);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        unique.push(collection);
    }
    return unique;
};

export const buildQishuiPlayerNavModel = (
    collections: readonly ProviderCollection[],
): QishuiPlayerNavModel => {
    const unique = uniqueById(collections);
    const feed = unique.find(isFeed) || null;
    const liked = unique.find(isLiked) || null;
    const recent = unique.find(isRecent) || null;
    const douyin = unique.find(isDouyin) || null;
    const specialIds = new Set(
        [feed, liked, recent, douyin]
            .filter((collection): collection is ProviderCollection => Boolean(collection))
            .map(collection => String(collection.id)),
    );

    const leftover = unique.filter(collection => (
        !specialIds.has(String(collection.id))
        && !isFeed(collection)
        && !isLiked(collection)
        && !isRecent(collection)
        && !isDouyin(collection)
    ));

    return {
        feed,
        liked,
        recent,
        douyin,
        created: leftover.filter(isCreated),
        // 其它平台的 playlist 列表不再依赖各 provider 是否标了 isOwned；能列出来的歌单都归到「我的歌单」。
        playlists: leftover.filter(collection => collection.type === 'playlist'),
    };
};

export const isQishuiSelfCreatedPlaylist = (collection: ProviderCollection): boolean => (
    !isFeed(collection)
    && !isLiked(collection)
    && !isRecent(collection)
    && !isDouyin(collection)
    && isCreated(collection)
);
