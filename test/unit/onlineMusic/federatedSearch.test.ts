import { beforeEach, describe, expect, it, vi } from 'vitest';
import { omni } from '@/services/onlineMusic/omni';
import {
    getFederatedSearchProviderIds,
    interleaveFederatedSearchSongs,
    mergeFederatedSearchSongs,
    searchAllSources,
} from '@/services/onlineMusic/federatedSearch';
import type { UnifiedSong } from '@/types';
import type {
    OnlineProviderId,
    ProviderAccountSummary,
    ProviderCapabilities,
} from '@/types/onlineMusic';

// test/unit/onlineMusic/federatedSearch.test.ts

vi.mock('@/services/onlineMusic/omni', () => ({
    omni: {
        getProviderSummaries: vi.fn(),
        getProviderCapabilities: vi.fn(),
        getActiveProviderSummary: vi.fn(),
        searchProviderSongs: vi.fn(),
    },
}));

const capabilities = (patch: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
    search: false,
    playback: false,
    lyrics: false,
    auth: false,
    userLibrary: false,
    playlists: false,
    albums: false,
    artists: false,
    recommendations: false,
    mutations: false,
    wordByWordLyrics: false,
    ...patch,
});

const summary = (providerId: OnlineProviderId, configured = true): ProviderAccountSummary => ({
    providerId,
    displayName: providerId,
    shortName: providerId,
    availability: { configured },
    status: 'unknown',
    user: null,
    collections: [],
});

const song = (providerId: OnlineProviderId, mediaId: string, name = `${providerId}:${mediaId}`): UnifiedSong => ({
    id: mediaId,
    name,
    artists: [],
    album: { id: 0, name: '' },
    durationMs: 1000,
    sourceRef: { kind: 'online', providerId, mediaId },
});

const providerPage = (
    items: UnifiedSong[],
    options: { hasMore?: boolean; nextOffset?: number } = {},
) => ({
    items,
    hasMore: options.hasMore ?? false,
    nextOffset: options.nextOffset ?? items.length,
});

describe('federated search', () => {
    const getSummariesMock = vi.mocked(omni.getProviderSummaries);
    const getCapabilitiesMock = vi.mocked(omni.getProviderCapabilities);
    const getActiveProviderSummaryMock = vi.mocked(omni.getActiveProviderSummary);
    const searchProviderSongsMock = vi.mocked(omni.searchProviderSongs);

    beforeEach(() => {
        getSummariesMock.mockReset();
        getCapabilitiesMock.mockReset();
        getActiveProviderSummaryMock.mockReset();
        searchProviderSongsMock.mockReset();

        getSummariesMock.mockReturnValue([]);
        getCapabilitiesMock.mockReturnValue(capabilities({ search: true, playback: true }));
        getActiveProviderSummaryMock.mockReturnValue(undefined);
    });

    it('discovers only configured providers with the required capabilities and puts the active provider first', () => {
        getSummariesMock.mockReturnValue([
            summary('netease'),
            summary('kugou'),
            summary('disabled', false),
            summary('lyrics-only'),
        ]);
        getCapabilitiesMock.mockImplementation(providerId => (
            providerId === 'lyrics-only'
                ? capabilities({ search: true })
                : capabilities({ search: true, playback: true })
        ));
        getActiveProviderSummaryMock.mockReturnValue({ providerId: 'kugou' } as any);

        expect(getFederatedSearchProviderIds()).toEqual(['kugou', 'netease']);
        expect(getFederatedSearchProviderIds({ requirePlayback: false })).toEqual([
            'kugou',
            'netease',
            'lyrics-only',
        ]);
        expect(getFederatedSearchProviderIds({ activeProviderId: 'netease' })).toEqual([
            'netease',
            'kugou',
        ]);
    });

    it('skips providers whose capability lookup fails', () => {
        getSummariesMock.mockReturnValue([summary('netease'), summary('broken')]);
        getCapabilitiesMock.mockImplementation(providerId => {
            if (providerId === 'broken') throw new Error('not available');
            return capabilities({ search: true, playback: true });
        });

        expect(getFederatedSearchProviderIds()).toEqual(['netease']);
    });

    it('round-robins provider buckets and deduplicates exact playback identities', () => {
        const neteaseFirst = song('netease', '1');
        const neteaseSecond = song('netease', '2');
        const kugouFirst = song('kugou', '1');
        const duplicateKugouSong = song('kugou', '9');

        const interleaved = interleaveFederatedSearchSongs([
            { providerId: 'netease', items: [neteaseFirst, neteaseSecond, song('kugou', '9')] },
            { providerId: 'kugou', items: [kugouFirst, duplicateKugouSong] },
        ], ['netease', 'kugou']);

        expect(interleaved).toEqual([neteaseFirst, kugouFirst, neteaseSecond, song('kugou', '9')]);
        expect(interleaved).toHaveLength(4);
    });

    it('keeps the same media id from different providers as separate rows', () => {
        const neteaseSong = song('netease', '1', 'Same Song');
        const kugouSong = song('kugou', '1', 'Same Song');

        const merged = mergeFederatedSearchSongs([neteaseSong], [neteaseSong, kugouSong]);

        expect(merged).toEqual([neteaseSong, kugouSong]);
        expect(new Set(merged.map(item => item.sourceRef?.kind === 'online'
            ? `${item.sourceRef.providerId}:${item.sourceRef.mediaId}`
            : '')).size).toBe(2);
    });

    it('returns an empty page without requesting providers when none are configured', async () => {
        const result = await searchAllSources({ query: 'anything', limit: 30 });

        expect(searchProviderSongsMock).not.toHaveBeenCalled();
        expect(result).toMatchObject({
            items: [],
            hasMore: false,
            errors: [],
            providerIds: [],
            attemptedProviderCount: 0,
            succeededProviderCount: 0,
        });
    });

    it('searches every provider concurrently with a fixed per-provider limit and interleaves the results', async () => {
        getSummariesMock.mockReturnValue([summary('netease'), summary('kugou')]);
        const neteaseFirst = song('netease', '1');
        const neteaseSecond = song('netease', '2');
        const kugouFirst = song('kugou', '1');
        searchProviderSongsMock.mockImplementation(async providerId => (
            providerId === 'netease'
                ? providerPage([neteaseFirst, neteaseSecond])
                : providerPage([kugouFirst])
        ));

        const result = await searchAllSources({ query: 'query', limit: 30 });

        expect(searchProviderSongsMock).toHaveBeenNthCalledWith(1, 'netease', 'query', { limit: 15, offset: 0 });
        expect(searchProviderSongsMock).toHaveBeenNthCalledWith(2, 'kugou', 'query', { limit: 15, offset: 0 });
        expect(result.items).toEqual([neteaseFirst, kugouFirst, neteaseSecond]);
        expect(result.providerIds).toEqual(['netease', 'kugou']);
        expect(result.attemptedProviderCount).toBe(2);
        expect(result.succeededProviderCount).toBe(2);
        expect(result.hasMore).toBe(false);
        expect(result.cursors.netease).toMatchObject({ limit: 15, nextOffset: 2, exhausted: true });
        expect(result.cursors.kugou).toMatchObject({ limit: 15, nextOffset: 1, exhausted: true });
    });

    it('advances provider cursors and reuses the fixed per-provider limit', async () => {
        getSummariesMock.mockReturnValue([summary('netease'), summary('kugou')]);
        searchProviderSongsMock.mockImplementation(async (providerId, _query, options) => (
            options?.offset === 0
                ? providerPage([song(providerId, 'first')], { hasMore: true, nextOffset: 1 })
                : providerPage([song(providerId, 'second')], { hasMore: false, nextOffset: 2 })
        ));

        const firstPage = await searchAllSources({ query: 'paged', limit: 30 });
        const secondPage = await searchAllSources({
            query: 'paged',
            limit: 30,
            cursors: firstPage.cursors,
            providerIds: firstPage.providerIds,
        });

        expect(searchProviderSongsMock).toHaveBeenNthCalledWith(3, 'netease', 'paged', { limit: 15, offset: 1 });
        expect(searchProviderSongsMock).toHaveBeenNthCalledWith(4, 'kugou', 'paged', { limit: 15, offset: 1 });
        expect(firstPage.hasMore).toBe(true);
        expect(secondPage.items).toEqual([song('netease', 'second'), song('kugou', 'second')]);
        expect(secondPage.hasMore).toBe(false);
        expect(secondPage.cursors.netease).toMatchObject({ nextOffset: 2, exhausted: true });
        expect(secondPage.cursors.kugou).toMatchObject({ nextOffset: 2, exhausted: true });
    });

    it('does not request providers that are already exhausted', async () => {
        getSummariesMock.mockReturnValue([summary('netease')]);
        searchProviderSongsMock.mockResolvedValue(providerPage([song('netease', 'only')]));

        const firstPage = await searchAllSources({ query: 'done', limit: 30 });
        const secondPage = await searchAllSources({
            query: 'done',
            limit: 30,
            cursors: firstPage.cursors,
            providerIds: firstPage.providerIds,
        });

        expect(searchProviderSongsMock).toHaveBeenCalledTimes(1);
        expect(secondPage.items).toEqual([]);
        expect(secondPage.attemptedProviderCount).toBe(0);
        expect(secondPage.hasMore).toBe(false);
    });

    it('marks a provider exhausted when its offset stops advancing', async () => {
        getSummariesMock.mockReturnValue([summary('netease')]);
        searchProviderSongsMock.mockResolvedValue(providerPage([], { hasMore: true, nextOffset: 0 }));

        const firstPage = await searchAllSources({ query: 'stuck', limit: 30 });
        const secondPage = await searchAllSources({
            query: 'stuck',
            limit: 30,
            cursors: firstPage.cursors,
            providerIds: firstPage.providerIds,
        });

        expect(searchProviderSongsMock).toHaveBeenCalledTimes(1);
        expect(firstPage.cursors.netease).toMatchObject({
            nextOffset: 0,
            hasMore: false,
            exhausted: true,
        });
        expect(firstPage.hasMore).toBe(false);
        expect(secondPage.attemptedProviderCount).toBe(0);
    });

    it('keeps other provider results when one provider fails, then exhausts it after two failures', async () => {
        getSummariesMock.mockReturnValue([summary('netease'), summary('kugou')]);
        const neteaseSong = song('netease', '1');
        searchProviderSongsMock.mockImplementation(async providerId => {
            if (providerId === 'kugou') throw new Error('kugou down');
            return providerPage([neteaseSong]);
        });

        const firstPage = await searchAllSources({ query: 'partial', limit: 30 });

        expect(firstPage.items).toEqual([neteaseSong]);
        expect(firstPage.errors).toEqual([{
            providerId: 'kugou',
            message: 'kugou down',
            timedOut: false,
        }]);
        expect(firstPage.cursors.kugou).toMatchObject({
            consecutiveFailures: 1,
            exhausted: false,
        });
        expect(firstPage.hasMore).toBe(true);

        const secondPage = await searchAllSources({
            query: 'partial',
            limit: 30,
            cursors: firstPage.cursors,
            providerIds: firstPage.providerIds,
        });

        expect(secondPage.cursors.kugou).toMatchObject({
            consecutiveFailures: 2,
            exhausted: true,
        });
        expect(secondPage.hasMore).toBe(false);
        expect(secondPage.attemptedProviderCount).toBe(1);
    });

    it('reports a timed-out provider without discarding successful results', async () => {
        getSummariesMock.mockReturnValue([summary('netease'), summary('kugou')]);
        const neteaseSong = song('netease', '1');
        searchProviderSongsMock.mockImplementation(async providerId => {
            if (providerId === 'kugou') return new Promise(() => undefined);
            return providerPage([neteaseSong]);
        });

        const page = await searchAllSources({ query: 'timeout', limit: 30, timeoutMs: 5 });

        expect(page.items).toEqual([neteaseSong]);
        expect(page.succeededProviderCount).toBe(1);
        expect(page.errors).toEqual([{
            providerId: 'kugou',
            message: 'Online source search timed out',
            timedOut: true,
        }]);
    });

    it('intersects requested provider ids with the configured provider set', async () => {
        getSummariesMock.mockReturnValue([summary('netease'), summary('kugou')]);
        searchProviderSongsMock.mockResolvedValue(providerPage([]));

        const page = await searchAllSources({
            query: 'selected',
            limit: 30,
            providerIds: ['kugou'],
        });

        expect(searchProviderSongsMock).toHaveBeenCalledTimes(1);
        expect(searchProviderSongsMock).toHaveBeenCalledWith('kugou', 'selected', { limit: 30, offset: 0 });
        expect(page.providerIds).toEqual(['kugou']);
    });
});
