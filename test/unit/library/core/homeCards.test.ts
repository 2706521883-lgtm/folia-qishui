import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import type { ProviderCollection } from '@/types/onlineMusic';
import {
    buildMergedPlaylistCards,
    buildOnlineAlbumCards,
    buildOnlinePlaylistCards,
    buildOnlineRadioCards,
    getProviderCollectionArtistLabel,
    isPersonalFmCard,
    onlineCardCollection,
    resolveOnlineCardProviderId,
} from '@/library/core/model/homeCards';

// test/unit/library/core/homeCards.test.ts
// 在线首页卡片的视图模型（原样搬自 Grid3D）：字段映射、电台页签的伪条目（私人 FM、每日推荐）、
// FM 卡的描述用当前 FM 模式、打开卡片时交给描述工厂的对象。

const t = ((key: string) => `t:${key}`) as unknown as TFunction;

const collection = (patch: Partial<ProviderCollection>): ProviderCollection => ({
    providerId: 'p',
    id: 'c1',
    name: 'Collection',
    type: 'playlist',
    ...patch,
});

describe('online home cards', () => {
    it('playlist cards show the creator, falling back to the tab name', () => {
        const owned = collection({ id: 'a', creator: { id: 1, nickname: 'Owner' }, description: 'About', trackCount: 3 });
        const cloud = collection({ id: 'cloud', type: 'cloud' });
        expect(buildOnlinePlaylistCards([owned, cloud], t)).toEqual([
            { id: 'a', name: 'Collection', coverUrl: undefined, trackCount: 3, description: 'Owner', summary: 'About', type: 'playlist', raw: owned },
            { id: 'cloud', name: 'Collection', coverUrl: undefined, trackCount: undefined, description: 't:home.playlists', summary: '', type: 'cloud', raw: cloud },
        ]);
    });

    it('merged playlist cards keep provider identity even when two platforms use the same collection id', () => {
        const netease = collection({ id: 'same', name: '网易歌单', creator: { id: 1, nickname: 'N' } });
        const kugou = collection({ providerId: 'kugou', id: 'same', name: '酷狗歌单' });
        const cards = buildMergedPlaylistCards([
            { providerId: 'netease', providerLabel: '网易云', collection: netease },
            { providerId: 'kugou', providerLabel: '酷狗', collection: kugou },
        ], t);
        expect(cards.map(card => [card.id, card.providerId, card.providerLabel, card.name])).toEqual([
            ['netease:playlist:same', 'netease', '网易云', '网易歌单'],
            ['kugou:playlist:same', 'kugou', '酷狗', '酷狗歌单'],
        ]);
        // raw 仍是原始集合：打开时按它自己的 providerId 路由，而不是卡片 id。
        expect(cards[1].raw).toBe(kugou);
        expect(cards[1].description).toBe('t:home.playlists');
    });

    it('opening a card uses its own provider, falling back to the active one for providerless cards', () => {
        expect(resolveOnlineCardProviderId({ raw: collection({ providerId: 'kugou', id: 'k' }) }, 'netease')).toBe('kugou');
        expect(resolveOnlineCardProviderId({ raw: { id: 'daily_recommendations' } }, 'netease')).toBe('netease');
        expect(resolveOnlineCardProviderId({}, 'netease')).toBe('netease');
    });

    it('album cards are typed album and show the artists or the unknown-artist label', () => {
        const withArtists = collection({ id: 'x', type: 'album', artists: [{ id: 1, name: ' A ' }, { id: 2, name: 'B' }] });
        const bare = collection({ id: 'y', type: 'album' });
        const cards = buildOnlineAlbumCards([withArtists, bare], t);
        expect(cards.map(card => [card.id, card.type, card.description])).toEqual([
            ['x', 'album', 'A, B'],
            ['y', 'album', 't:player.unknownArtist'],
        ]);
    });

    it('the artist label prefers artists over the creator', () => {
        expect(getProviderCollectionArtistLabel({ artists: [{ id: 1, name: 'A' }], creator: { id: 2, nickname: 'C' } })).toBe('A');
        expect(getProviderCollectionArtistLabel({ artists: [], creator: { id: 2, nickname: 'C' } })).toBe('C');
        expect(getProviderCollectionArtistLabel(null)).toBe('');
    });

    it('the radio tab puts Personal FM and Daily Recommendations ahead of the recommended playlists', () => {
        const recommended = collection({ id: 'r1', description: '', creator: { id: 1, nickname: 'Curator' } });
        const cards = buildOnlineRadioCards({ personalFmCoverUrl: 'fm.jpg', dailyCoverUrl: 'daily.jpg', dailyCount: 30, recommended: [recommended] }, { t });
        expect(cards.map(card => [card.id, card.type])).toEqual([
            ['personal_fm', 'radio'],
            ['daily_recommendations', 'daily_recommendations'],
            ['r1', 'playlist'],
        ]);
        expect(cards[0]).toMatchObject({ name: 't:home.personalFm', coverUrl: 'fm.jpg', description: 't:home.personalFm', summary: '' });
        expect(cards[1]).toMatchObject({
            coverUrl: 'daily.jpg',
            trackCount: 30,
            description: 't:home.dailyRecommendationsDescription',
            summary: 't:home.dailyRecommendationsSummary',
        });
        // 推荐歌单的描述是它自己的描述，没有就用创建者；summary 同描述。
        expect(cards[2]).toMatchObject({ description: 'Curator', summary: 'Curator' });
        expect(cards[2].raw).toMatchObject({ id: 'r1', description: 'Curator', summary: 'Curator' });
    });

    it('the FM card shows the current FM mode when the provider has modes', () => {
        const feed = { dailyCoverUrl: '', dailyCount: 0, recommended: [] };
        expect(buildOnlineRadioCards(feed, { t, personalFmModeLabel: 'Mode X' })[0].description).toBe('Mode X');
        expect(buildOnlineRadioCards(feed, { t, personalFmModeLabel: '' })[0].description).toBe('t:home.personalFm');
        expect(buildOnlineRadioCards(null, { t })).toEqual([]);
    });

    it('recognises the FM card and builds the collection handed to the descriptor factory', () => {
        const [fm, daily] = buildOnlineRadioCards({ dailyCoverUrl: '', dailyCount: 1, recommended: [] }, { t });
        expect(isPersonalFmCard(fm)).toBe(true);
        expect(isPersonalFmCard(daily)).toBe(false);
        expect(isPersonalFmCard({ id: 'other', raw: { id: 'personal_fm' } })).toBe(true);
        expect(onlineCardCollection(daily)).toMatchObject({ id: 'daily_recommendations', type: 'daily_recommendations', isDailyRecommendations: true });
        expect(onlineCardCollection({ id: 'bare', name: 'Bare', type: 'album' })).toEqual({ id: 'bare', name: 'Bare', type: 'album' });
    });
});
