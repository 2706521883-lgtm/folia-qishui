import { describe, expect, it } from 'vitest';
import {
    QISHUI_FEED_PLAYLIST_ID,
    QISHUI_LIKED_PLAYLIST_ID,
    QISHUI_RECENT_PLAYLIST_ID,
} from '@/services/onlineMusic/qishuiCatalog';
import { buildQishuiPlayerNavModel } from '@/components/qishui/qishuiPlayerNavModel';
import type { ProviderCollection } from '@/types/onlineMusic';

// test/unit/onlineMusic/qishuiPlayerNavModel.test.ts

const collection = (
    id: string,
    name: string,
    extra: Partial<ProviderCollection> = {},
): ProviderCollection => ({
    providerId: 'qishui',
    id,
    name,
    type: 'playlist',
    ...extra,
});

describe('buildQishuiPlayerNavModel', () => {
    it('separates liked, Douyin favourites, history and self-created playlists', () => {
        const model = buildQishuiPlayerNavModel([
            collection(QISHUI_FEED_PLAYLIST_ID, '汽水推荐流', { providerData: { virtual: true } }),
            collection(QISHUI_LIKED_PLAYLIST_ID, '汽水我的喜欢', { isOwned: true }),
            collection(QISHUI_RECENT_PLAYLIST_ID, '汽水最近播放', { isOwned: true }),
            collection('douyin-1', '抖音收藏的音乐', { providerData: { qishuiPlaylistType: 4 } }),
            collection('created-1', '我的歌单', { providerData: { qishuiPlaylistType: 2 } }),
            collection('created-2', '另一个歌单', { isOwned: true }),
            collection('saved-1', '收藏的歌单', { providerData: { shelfPane: 'fav' } }),
        ]);

        expect(model.feed?.id).toBe(QISHUI_FEED_PLAYLIST_ID);
        expect(model.liked?.id).toBe(QISHUI_LIKED_PLAYLIST_ID);
        expect(model.recent?.id).toBe(QISHUI_RECENT_PLAYLIST_ID);
        expect(model.douyin?.id).toBe('douyin-1');
        expect(model.created.map(item => item.id)).toEqual(['created-1', 'created-2']);
    });

    it('recognizes the official numeric playlist types without relying on names', () => {
        const model = buildQishuiPlayerNavModel([
            collection('liked-1', '喜欢的音乐', { providerData: { qishuiPlaylistType: 1 } }),
            collection('douyin-1', '抖音收藏', { providerData: { qishuiPlaylistType: 4 } }),
            collection('owned-1', '私人歌单', { providerData: { qishuiPlaylistType: 11 } }),
            collection('owned-2', '另一个私人歌单', { providerData: { qishuiPlaylistType: 3 } }),
        ]);

        expect(model.liked?.id).toBe('liked-1');
        expect(model.douyin?.id).toBe('douyin-1');
        expect(model.created.map(item => item.id)).toEqual(['owned-1', 'owned-2']);
    });

    it('deduplicates by id and does not put special collections in the created list', () => {
        const model = buildQishuiPlayerNavModel([
            collection('created-1', '我的歌单', { isOwned: true }),
            collection('created-1', '我的歌单（快照）', { isOwned: true }),
            collection(QISHUI_LIKED_PLAYLIST_ID, '汽水我的喜欢', { isOwned: true }),
        ]);

        expect(model.created).toHaveLength(1);
        expect(model.created[0].id).toBe('created-1');
    });
});
