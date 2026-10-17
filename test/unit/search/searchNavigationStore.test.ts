import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveCommandPaletteSearchSource, useSearchNavigationStore } from '@/stores/useSearchNavigationStore';
import { neteaseApi } from '@/services/netease';
import { getNavidromeConfig, navidromeApi } from '@/services/navidromeService';
import {
    mergeFederatedSearchSongs,
    searchAllSources,
    type FederatedSearchCursorMap,
    type FederatedSearchPage,
} from '@/services/onlineMusic/federatedSearch';
import type { UnifiedSong } from '@/types';
import type { LocalLibraryAssignment, LocalLibraryEntity } from '@/types/localLibrary';

vi.mock('@/services/onlineMusic/federatedSearch', () => ({
    searchAllSources: vi.fn(),
    mergeFederatedSearchSongs: vi.fn((existing: UnifiedSong[], incoming: UnifiedSong[]) => [
        ...existing,
        ...incoming,
    ]),
}));

vi.mock('@/services/netease', () => ({
    neteaseApi: {
        cloudSearch: vi.fn(),
        normalizeSongResult: vi.fn((raw: unknown) => raw),
    },
}));

vi.mock('@/services/navidromeService', () => ({
    getNavidromeConfig: vi.fn(() => null),
    navidromeApi: {
        search: vi.fn(),
        toNavidromeSong: vi.fn(),
    },
}));

describe('useSearchNavigationStore', () => {
    const cloudSearchMock = vi.mocked(neteaseApi.cloudSearch);
    const getNavidromeConfigMock = vi.mocked(getNavidromeConfig);
    const navidromeSearchMock = vi.mocked(navidromeApi.search);
    const toNavidromeSongMock = vi.mocked(navidromeApi.toNavidromeSong);
    const searchAllSourcesMock = vi.mocked(searchAllSources);
    const mergeFederatedSearchSongsMock = vi.mocked(mergeFederatedSearchSongs);
    const deps = {
        localSongs: [],
        t: (_key: string, fallback?: string) => fallback || '',
    };

    const onlineSong = (providerId: 'netease' | 'kugou', mediaId: string): UnifiedSong => ({
        id: mediaId,
        name: `${providerId}-${mediaId}`,
        artists: [],
        album: { id: 0, name: '' },
        durationMs: 1000,
        sourceRef: { kind: 'online', providerId, mediaId },
    });

    const cursor = (
        providerId: 'netease' | 'kugou',
        nextOffset: number,
        exhausted = false,
    ) => ({
        providerId,
        limit: 15,
        nextOffset,
        hasMore: !exhausted,
        exhausted,
        consecutiveFailures: 0,
    });

    const federatedPage = (
        items: UnifiedSong[],
        cursors: FederatedSearchCursorMap,
        overrides: Partial<FederatedSearchPage> = {},
    ): FederatedSearchPage => ({
        items,
        cursors,
        hasMore: Object.values(cursors).some(entry => !entry.exhausted),
        errors: [],
        providerIds: ['netease', 'kugou'],
        attemptedProviderCount: 2,
        succeededProviderCount: 2,
        ...overrides,
    });

    beforeEach(() => {
        cloudSearchMock.mockReset();
        getNavidromeConfigMock.mockReset();
        getNavidromeConfigMock.mockReturnValue(null);
        navidromeSearchMock.mockReset();
        toNavidromeSongMock.mockReset();
        searchAllSourcesMock.mockReset();
        mergeFederatedSearchSongsMock.mockClear();
        useSearchNavigationStore.setState({
            homeViewTab: 'playlist',
            searchQuery: '',
            searchSourceTab: 'netease',
            searchResults: null,
            searchReturnView: 'home',
            isSearchOpen: false,
            isSearching: false,
            isLoadingMore: false,
            searchError: null,
            requestId: 0,
            offset: 0,
            limit: 30,
            hasMore: false,
            scrollTop: 0,
            searchCache: {},
            searchProviderCursors: null,
            searchProviderIds: null,
        });
    });

    it('uses the active online provider for command palette searches', () => {
        expect(resolveCommandPaletteSearchSource({
            id: 1,
            name: 'NetEase track still playing',
            artists: [],
            album: { id: 1, name: '' },
            durationMs: 1,
        }, 'netease', 'kugou')).toBe('kugou');
        expect(resolveCommandPaletteSearchSource(null, 'netease', 'kugou')).toBe('kugou');
    });

    it('keeps the all-source tab for command palette searches regardless of the playing song', () => {
        expect(resolveCommandPaletteSearchSource({
            id: 1,
            name: 'NetEase track still playing',
            artists: [],
            album: { id: 1, name: '' },
            durationMs: 1,
        }, 'all', 'kugou')).toBe('all');
        expect(resolveCommandPaletteSearchSource(null, 'all', 'kugou')).toBe('all');
    });

    it('keeps the all-source tab when runtime state resets', () => {
        useSearchNavigationStore.setState({ searchSourceTab: 'all' });
        useSearchNavigationStore.getState().resetRuntime('kugou');

        expect(useSearchNavigationStore.getState().searchSourceTab).toBe('all');
        expect(useSearchNavigationStore.getState().searchProviderCursors).toBeNull();
        expect(useSearchNavigationStore.getState().searchProviderIds).toBeNull();
    });

    it('searches every configured source through the federated orchestrator', async () => {
        const netease = onlineSong('netease', '1');
        const kugou = onlineSong('kugou', '2');
        const cursors = {
            netease: cursor('netease', 1),
            kugou: cursor('kugou', 1),
        };
        searchAllSourcesMock.mockResolvedValueOnce(federatedPage([netease, kugou], cursors));

        await useSearchNavigationStore.getState().submitSearch({
            query: 'unified',
            sourceTab: 'all',
            deps,
        });

        expect(searchAllSourcesMock).toHaveBeenCalledWith(expect.objectContaining({
            query: 'unified',
            limit: 30,
            providerIds: undefined,
            cursors: undefined,
        }));
        expect(cloudSearchMock).not.toHaveBeenCalled();
        expect(useSearchNavigationStore.getState()).toMatchObject({
            searchSourceTab: 'all',
            searchResults: [netease, kugou],
            searchProviderCursors: cursors,
            searchProviderIds: ['netease', 'kugou'],
            searchError: null,
        });
    });

    it('keeps successful all-source results when another provider fails', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const netease = onlineSong('netease', '1');
        const error = { providerId: 'kugou' as const, message: 'kugou down', timedOut: false };
        searchAllSourcesMock.mockResolvedValueOnce(federatedPage(
            [netease],
            { netease: cursor('netease', 1), kugou: cursor('kugou', 0, true) },
            { errors: [error], attemptedProviderCount: 2, succeededProviderCount: 1 },
        ));

        try {
            await useSearchNavigationStore.getState().submitSearch({
                query: 'partial',
                sourceTab: 'all',
                deps,
            });

            expect(useSearchNavigationStore.getState().searchError).toBeNull();
            expect(useSearchNavigationStore.getState().searchResults).toEqual([netease]);
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('shows a localized error only when every online source fails', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        searchAllSourcesMock.mockResolvedValueOnce(federatedPage(
            [],
            { netease: cursor('netease', 0, true), kugou: cursor('kugou', 0, true) },
            {
                attemptedProviderCount: 2,
                succeededProviderCount: 0,
                errors: [
                    { providerId: 'netease', message: 'netease down', timedOut: false },
                    { providerId: 'kugou', message: 'kugou down', timedOut: false },
                ],
            },
        ));

        try {
            await useSearchNavigationStore.getState().submitSearch({
                query: 'failed',
                sourceTab: 'all',
                deps,
            });

            expect(useSearchNavigationStore.getState().searchError).toBe('All online sources failed to search');
        } finally {
            warnSpy.mockRestore();
        }
    });

    it('loads the next all-source page with the saved provider cursors', async () => {
        const first = onlineSong('netease', '1');
        const second = onlineSong('kugou', '2');
        const third = onlineSong('netease', '3');
        const fourth = onlineSong('kugou', '4');
        const firstCursors = {
            netease: cursor('netease', 1),
            kugou: cursor('kugou', 1),
        };
        const secondCursors = {
            netease: cursor('netease', 2, true),
            kugou: cursor('kugou', 2, true),
        };
        searchAllSourcesMock
            .mockResolvedValueOnce(federatedPage([first, second], firstCursors))
            .mockResolvedValueOnce(federatedPage([third, fourth], secondCursors, { hasMore: false }));

        await useSearchNavigationStore.getState().submitSearch({
            query: 'paged all',
            sourceTab: 'all',
            deps,
        });
        await useSearchNavigationStore.getState().loadMoreSearchResults({ deps });

        expect(searchAllSourcesMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
            query: 'paged all',
            providerIds: ['netease', 'kugou'],
            cursors: firstCursors,
        }));
        expect(mergeFederatedSearchSongsMock).toHaveBeenCalledWith(
            [first, second],
            [third, fourth],
        );
        expect(useSearchNavigationStore.getState()).toMatchObject({
            searchResults: [first, second, third, fourth],
            searchProviderCursors: secondCursors,
            hasMore: false,
        });
    });

    it('does not restart an all-source search without cursors when loading more', async () => {
        useSearchNavigationStore.setState({
            searchQuery: 'all no cursors',
            searchSourceTab: 'all',
            searchResults: [onlineSong('netease', '1')],
            hasMore: true,
            searchProviderCursors: null,
            offset: 1,
        });

        await useSearchNavigationStore.getState().loadMoreSearchResults({ deps });

        expect(searchAllSourcesMock).not.toHaveBeenCalled();
    });

    it('submits a local search and opens the overlay', async () => {
        const didSearch = await useSearchNavigationStore.getState().submitSearch({
            query: 'world',
            sourceTab: 'local',
            deps: {
                ...deps,
                localSongs: [
                    {
                        id: '1',
                        fileName: 'hello.mp3',
                        filePath: '/tmp/hello.mp3',
                        duration: 120000,
                        fileSize: 10,
                        mimeType: 'audio/mpeg',
                        addedAt: 1,
                        title: 'Hello World',
                        titleOrigin: 'import',
                        importedMetadata: { title: 'Hello World', titleSource: 'filename', artistNames: ['Singer'], albumName: 'Album' },
                    },
                ],
            },
        });

        const state = useSearchNavigationStore.getState();

        expect(didSearch).toBe(true);
        expect(state.isSearchOpen).toBe(true);
        expect(state.searchQuery).toBe('world');
        expect(state.searchSourceTab).toBe('local');
        expect(state.searchResults).toHaveLength(1);
        expect(state.hasMore).toBe(false);
    });

    it('appends more netease results when loading the next page', async () => {
        cloudSearchMock
            .mockResolvedValueOnce({
                result: {
                    songs: [
                        { id: 1, name: 'Track 1', artists: [], album: { id: 1, name: 'Album 1' }, durationMs: 1000 },
                        { id: 2, name: 'Track 2', artists: [], album: { id: 2, name: 'Album 2' }, durationMs: 1000 },
                    ],
                    songCount: 4,
                },
            } as any)
            .mockResolvedValueOnce({
                result: {
                    songs: [
                        { id: 3, name: 'Track 3', artists: [], album: { id: 3, name: 'Album 3' }, durationMs: 1000 },
                        { id: 4, name: 'Track 4', artists: [], album: { id: 4, name: 'Album 4' }, durationMs: 1000 },
                    ],
                    songCount: 4,
                },
            } as any);

        await useSearchNavigationStore.getState().submitSearch({
            query: 'folio',
            sourceTab: 'netease',
            deps,
        });

        await useSearchNavigationStore.getState().loadMoreSearchResults({ deps });

        const state = useSearchNavigationStore.getState();

        expect(cloudSearchMock).toHaveBeenNthCalledWith(1, 'folio', 30, 0);
        expect(cloudSearchMock).toHaveBeenNthCalledWith(2, 'folio', 30, 2);
        expect(state.searchResults).toHaveLength(4);
        expect(state.hasMore).toBe(false);
        expect(state.offset).toBe(4);
    });

    it('restores the matching cached search results and scroll position', async () => {
        cloudSearchMock.mockResolvedValueOnce({
            result: {
                songs: [{ id: 9, name: 'Cached', artists: [], album: { id: 1, name: 'Album' }, durationMs: 1000 }],
                songCount: 1,
            },
        } as any);
        await useSearchNavigationStore.getState().submitSearch({
            query: 'cached',
            sourceTab: 'netease',
            deps,
        });
        useSearchNavigationStore.getState().setSearchScrollTop(240);
        useSearchNavigationStore.setState({ isSearchOpen: false, searchResults: null, scrollTop: 0 });

        useSearchNavigationStore.getState().restoreSearch({
            query: 'cached',
            sourceTab: 'netease',
        });

        const state = useSearchNavigationStore.getState();
        expect(state.isSearchOpen).toBe(true);
        expect(state.searchQuery).toBe('cached');
        expect(state.searchResults).toHaveLength(1);
        expect(state.scrollTop).toBe(240);
    });

    it('does not reuse cached results from a different query', async () => {
        cloudSearchMock.mockResolvedValueOnce({
            result: {
                songs: [{ id: 9, name: 'Cached', artists: [], album: { id: 1, name: 'Album' }, durationMs: 1000 }],
                songCount: 1,
            },
        } as any);
        await useSearchNavigationStore.getState().submitSearch({
            query: 'cached',
            sourceTab: 'netease',
            deps,
        });

        useSearchNavigationStore.getState().restoreSearch({
            query: 'different',
            sourceTab: 'netease',
        });

        expect(useSearchNavigationStore.getState().searchResults).toBeNull();
    });

    it('searches Navidrome songs through the configured source adapter', async () => {
        getNavidromeConfigMock.mockReturnValue({ baseUrl: 'https://navi.test' } as any);
        navidromeSearchMock.mockResolvedValue({
            song: [{ id: 'song-1', title: 'Navidrome Track' }],
        } as any);
        toNavidromeSongMock.mockReturnValue({
            id: 'song-1',
            name: 'Navidrome Track',
            artists: [{ id: 0, name: 'Artist' }],
            album: { id: 0, name: 'Album' },
            durationMs: 1000,
            isNavidrome: true,
        } as any);

        await useSearchNavigationStore.getState().submitSearch({
            query: 'navi',
            sourceTab: 'navidrome',
            deps,
        });

        expect(navidromeSearchMock).toHaveBeenCalled();
        expect(useSearchNavigationStore.getState().searchResults?.[0]).toEqual(expect.objectContaining({
            name: 'Navidrome Track',
            isNavidrome: true,
        }));
    });

    it('attaches stable local artist and album entity ids to local results', async () => {
        const entities: LocalLibraryEntity[] = [
            {
                id: 'artist-1',
                kind: 'artist',
                displayName: 'Singer',
                aliases: ['Singer'],
                normalizedAliases: ['singer'],
                createdAt: 1,
                updatedAt: 1,
            },
            {
                id: 'album-1',
                kind: 'album',
                displayName: 'Album',
                aliases: ['Album'],
                normalizedAliases: ['album'],
                createdAt: 1,
                updatedAt: 1,
            },
        ];
        const assignments: LocalLibraryAssignment[] = [{
            songId: 'local-1',
            artistEntityIds: ['artist-1'],
            albumEntityId: 'album-1',
            artistOrigin: 'import',
            albumOrigin: 'import',
            updatedAt: 1,
        }];

        await useSearchNavigationStore.getState().submitSearch({
            query: 'local',
            sourceTab: 'local',
            deps: {
                ...deps,
                localSongs: [{
                    id: 'local-1',
                    fileName: 'local.mp3',
                    filePath: '/local.mp3',
                    duration: 1000,
                    fileSize: 1,
                    mimeType: 'audio/mpeg',
                    addedAt: 1,
                    title: 'Local',
                    titleOrigin: 'import',
                    importedMetadata: { title: 'Local', titleSource: 'filename', artistNames: ['Singer'], albumName: 'Album' },
                }],
                localLibraryCatalog: { entities, assignments },
            },
        });

        const [result] = useSearchNavigationStore.getState().searchResults || [];
        expect(result.artists[0]).toEqual(expect.objectContaining({ entityId: 'artist-1' }));
        expect(result.album).toEqual(expect.objectContaining({ entityId: 'album-1' }));
    });

    it('keeps the newest result when an older request resolves later', async () => {
        let resolveFirst: ((value: any) => void) | undefined;
        cloudSearchMock
            .mockImplementationOnce(() => new Promise(resolve => {
                resolveFirst = resolve;
            }))
            .mockResolvedValueOnce({
                result: {
                    songs: [{ id: 2, name: 'Newest', artists: [], album: { id: 2, name: 'Album' }, durationMs: 1000 }],
                    songCount: 1,
                },
            } as any);

        const firstRequest = useSearchNavigationStore.getState().submitSearch({
            query: 'old',
            sourceTab: 'netease',
            deps,
        });
        await useSearchNavigationStore.getState().submitSearch({
            query: 'new',
            sourceTab: 'netease',
            deps,
        });
        resolveFirst?.({
            result: {
                songs: [{ id: 1, name: 'Old', artists: [], album: { id: 1, name: 'Album' }, durationMs: 1000 }],
                songCount: 1,
            },
        });
        await firstRequest;

        expect(useSearchNavigationStore.getState().searchQuery).toBe('new');
        expect(useSearchNavigationStore.getState().searchResults?.[0]?.name).toBe('Newest');
    });

    it('exposes a recoverable error state after a failed search', async () => {
        cloudSearchMock.mockRejectedValueOnce(new Error('network'));

        await useSearchNavigationStore.getState().submitSearch({
            query: 'failure',
            sourceTab: 'netease',
            deps,
        });

        expect(useSearchNavigationStore.getState()).toMatchObject({
            isSearching: false,
            searchResults: [],
            searchError: 'network',
        });
    });

    it('retains paged results and can retry after a load-more error', async () => {
        cloudSearchMock
            .mockResolvedValueOnce({
                result: {
                    songs: [{ id: 1, name: 'First', artists: [], album: { id: 1, name: 'Album' }, durationMs: 1000 }],
                    songCount: 2,
                },
            } as any)
            .mockRejectedValueOnce(new Error('page failed'))
            .mockResolvedValueOnce({
                result: {
                    songs: [{ id: 2, name: 'Second', artists: [], album: { id: 1, name: 'Album' }, durationMs: 1000 }],
                    songCount: 2,
                },
            } as any);

        await useSearchNavigationStore.getState().submitSearch({
            query: 'paged',
            sourceTab: 'netease',
            deps,
        });
        await useSearchNavigationStore.getState().loadMoreSearchResults({ deps });

        expect(useSearchNavigationStore.getState()).toMatchObject({
            searchError: 'page failed',
            hasMore: true,
        });
        expect(useSearchNavigationStore.getState().searchResults).toHaveLength(1);

        await useSearchNavigationStore.getState().loadMoreSearchResults({ deps });

        expect(useSearchNavigationStore.getState().searchError).toBeNull();
        expect(useSearchNavigationStore.getState().searchResults).toHaveLength(2);
        expect(useSearchNavigationStore.getState().hasMore).toBe(false);
    });

    it('moves the online source to the active provider without clearing results', () => {
        const results = [{ id: 1, name: 'Kept' }] as any;
        useSearchNavigationStore.setState({ searchSourceTab: 'netease', searchResults: results, searchQuery: 'q' });

        useSearchNavigationStore.getState().followOnlineProvider('folium.mod-a.source');

        expect(useSearchNavigationStore.getState()).toMatchObject({
            searchSourceTab: 'folium.mod-a.source',
            searchResults: results,
            searchQuery: 'q',
        });
    });

    it('leaves a local or Navidrome source alone when the active provider changes', () => {
        useSearchNavigationStore.setState({ searchSourceTab: 'local' });
        useSearchNavigationStore.getState().followOnlineProvider('kugou');
        expect(useSearchNavigationStore.getState().searchSourceTab).toBe('local');

        useSearchNavigationStore.setState({ searchSourceTab: 'navidrome' });
        useSearchNavigationStore.getState().followOnlineProvider('kugou');
        expect(useSearchNavigationStore.getState().searchSourceTab).toBe('navidrome');
    });
});
