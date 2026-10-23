import type { Artist, UnifiedSong } from '../../types';
import type { JsonValue, ProviderCollection, ProviderPage, ProviderUser } from '../../types/onlineMusic';
import { OnlineProviderError } from '../../types/onlineMusic';

// src/services/onlineMusic/qishuiNormalize.ts

export type QishuiRecord = Record<string, any>;
export const qishuiRecord = (value: unknown): QishuiRecord => (
    value && typeof value === 'object' && !Array.isArray(value) ? value : {}
);
const text = (value: unknown) => value == null ? '' : String(value);
export const qishuiText = text;
// 上游封面已是绝对 https 地址，且自带 `~c5_<w>x<h>.jpg` 后缀，这里只补协议相对链接。
const cover = (value: unknown) => {
    const url = text(value);
    return url.startsWith('//') ? `https:${url}` : url;
};
const ref = (kind: 'album' | 'artist', id: unknown) => (
    id ? { providerId: 'qishui', kind, id: text(id) } : undefined
);

// 汽水的 `artist` 操作必须同时给出 artistId 与 artistName（只给 id 会回 MISSING_ARTIST_NAME），
// 所以归一化时见过的歌手都记下来，供之后按 id 打开歌手页时复用。
const artistNames = new Map<string, string>();
export const rememberQishuiArtist = (id: unknown, name: unknown) => {
    const key = text(id);
    const label = text(name);
    if (key && label) artistNames.set(key, label);
};
export const qishuiArtistName = (id: unknown): string => artistNames.get(text(id)) || '';

const artistsOf = (item: QishuiRecord): Artist[] => {
    const artists = Array.isArray(item.artists) ? item.artists : [{ id: item.artistId, name: item.artist }];
    return artists.filter((artist: QishuiRecord) => artist?.name).map((artist: QishuiRecord) => {
        rememberQishuiArtist(artist.id, artist.name);
        return { id: text(artist.id), name: text(artist.name), catalogRef: ref('artist', artist.id) };
    });
};

// 已归一化的歌曲原样返回，避免二次换算它已经是毫秒的时长。
export const normalizeQishuiSong = (raw: unknown): UnifiedSong => {
    const item = qishuiRecord(raw);
    if (item.sourceRef?.kind === 'online' && item.sourceRef.providerId === 'qishui') return item as UnifiedSong;
    if (!item.id) throw new OnlineProviderError('invalid-response', 'Qishui song has no id', 'qishui');
    const albumId = item.albumId ?? item.album_id;
    const data: Record<string, JsonValue> = {};
    if (item.fee !== undefined) data.fee = Number(item.fee) || 0;
    if (item.playbackMode) data.playbackMode = text(item.playbackMode);
    if (item.restriction?.category) data.restrictionCategory = text(item.restriction.category);
    // `playable: false` 只说明这次没有直连 URL（推荐/匹配源会另找版本），而 `source_unavailable`
    // 才是这一首在汽水侧确实取不到音频，只有后者算不可用。
    if (item.restriction?.category === 'source_unavailable') data.unavailable = true;
    return {
        id: text(item.id), name: text(item.name || item.title), artists: artistsOf(item),
        album: { id: text(albumId), name: text(item.album), coverUrl: cover(item.cover), catalogRef: ref('album', albumId) },
        durationMs: Math.max(0, Number(item.duration) || 0) * 1000,
        sourceRef: { kind: 'online', providerId: 'qishui', mediaId: text(item.id), providerData: data },
    };
};

export const normalizeQishuiUser = (raw: unknown): ProviderUser => {
    const item = qishuiRecord(raw);
    const profile = qishuiRecord(item.profile || item.user || item.me || item);
    const vipType = Number(profile.vipType ?? item.vipType);
    return {
        id: text(profile.id ?? profile.userId ?? profile.uid ?? item.userId ?? item.uid ?? item.id),
        nickname: text(profile.nickname || profile.nickName || profile.name),
        avatarUrl: cover(profile.avatarUrl || profile.avatar || profile.avatar_url),
        ...(Number.isFinite(vipType) ? { vipType } : {}),
    };
};

export const normalizeQishuiCollection = (raw: unknown, type = 'playlist'): ProviderCollection => {
    const item = qishuiRecord(raw);
    if (item.providerId === 'qishui') return item as ProviderCollection;
    const id = type === 'album' ? (item.albumId ?? item.id) : item.id;
    if (!id) throw new OnlineProviderError('invalid-response', 'Qishui collection has no id', 'qishui');
    // 虚拟歌单的 creator 是字符串（例如「汽水音乐」），真实歌单才会给对象。
    const creator = typeof item.creator === 'string'
        ? (item.creator ? { id: '', nickname: item.creator } : undefined)
        : (item.creator ? normalizeQishuiUser(item.creator) : undefined);
    const owned = item.owned ?? item.virtual;
    return {
        providerId: 'qishui', id: text(id), type, name: text(item.name || item.title),
        coverUrl: cover(item.cover || item.avatar),
        description: text(item.description || item.desc),
        trackCount: Number(item.trackCount) || 0,
        ...(item.playCount == null ? {} : { playCount: Number(item.playCount) || 0 }),
        ...(creator ? { creator } : {}),
        artists: artistsOf(item),
        ...(owned === undefined ? {} : { isOwned: Boolean(owned) }),
        ...(item.subscribed === undefined ? {} : { isLiked: Boolean(item.subscribed) }),
        providerData: {
            ...(item.virtual === undefined ? {} : { virtual: Boolean(item.virtual) }),
            ...(item.subscribed === undefined ? {} : { subscribed: Boolean(item.subscribed) }),
            ...(item.owned === undefined ? {} : { owned: Boolean(item.owned) }),
            ...(item.shelfPane ? { shelfPane: text(item.shelfPane) } : {}),
            ...(item.qishuiPlaylistType ? { qishuiPlaylistType: Number(item.qishuiPlaylistType) } : {}),
            ...(item.playbackMode ? { playbackMode: text(item.playbackMode) } : {}),
        },
    };
};

// 汽水分页字段来自协议层，但 token 搜索路径的 nextOffset 忘了加上自身 offset，
// 所以游标不可信时只丢弃步长、保留上游的 hasMore 判断。
export const qishuiPage = <T>(items: T[], total: unknown, offset: number, limit: number,
    cursor?: { nextOffset?: unknown; hasMore?: unknown }): ProviderPage<T> => {
    const count = Number(total);
    const knownTotal = total != null && Number.isFinite(count) && count >= 0;
    const rawNextOffset = Number(cursor?.nextOffset);
    const nextOffset = Number.isSafeInteger(rawNextOffset) && rawNextOffset >= offset + items.length
        ? rawNextOffset : offset + items.length;
    const hasMore = typeof cursor?.hasMore === 'boolean'
        ? Boolean(cursor.hasMore) && nextOffset > offset
        : items.length > 0 && (knownTotal ? nextOffset < count : items.length >= limit);
    return { items, ...(knownTotal ? { total: count } : {}), nextOffset, hasMore };
};
