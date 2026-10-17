import { beforeEach, describe, expect, it, vi } from 'vitest';
import { omni } from '@/services/onlineMusic/omni';
import {
    getFederatedSearchProviderIds,
    searchAllSources,
    type FederatedSearchPage,
} from '@/services/onlineMusic/federatedSearch';
import {
    areSongVersionsCompatible,
    buildCrossSourceMatchTarget,
    buildCrossSourceSearchQuery,
    evaluateCrossSourceCandidate,
    findCrossSourceFallback,
    getSongVersionMarkers,
} from '@/services/onlineMusic/crossSourceFallback';
import type { SongResult, UnifiedSong } from '@/types';
import type { OnlineProviderId } from '@/types/onlineMusic';

// test/unit/onlineMusic/crossSourceFallback.test.ts

vi.mock('@/services/onlineMusic/federatedSearch', () => ({
    getFederatedSearchProviderIds: vi.fn(),
    searchAllSources: vi.fn(),
}));

vi.mock('@/services/onlineMusic/omni', () => ({
    omni: {
        getSongAvailability: vi.fn(),
    },
}));

const ORIGIN_PROVIDER: OnlineProviderId = 'origin-source';
const PEER_A: OnlineProviderId = 'peer-a';
const PEER_B: OnlineProviderId = 'peer-b';
const PEER_C: OnlineProviderId = 'peer-c';

const makeSong = (options: {
    providerId?: OnlineProviderId;
    mediaId?: string;
    title?: string;
    artist?: string;
    album?: string;
    durationMs?: number;
} = {}): UnifiedSong => {
    const {
        providerId = ORIGIN_PROVIDER,
        mediaId = 'origin-1',
        title = 'Song Title',
        artist = 'Main Artist',
        album = 'Album One',
        durationMs = 200_000,
    } = options;

    return {
        id: mediaId,
        name: title,
        artists: [{ id: 1, name: artist }],
        album: { id: 1, name: album },
        durationMs,
        sourceRef: { kind: 'online', providerId, mediaId },
    };
};

const federatedPage = (
    items: UnifiedSong[],
    options: Partial<FederatedSearchPage> = {},
): FederatedSearchPage => ({
    items,
    cursors: {},
    hasMore: false,
    errors: [],
    providerIds: [PEER_A, PEER_B],
    attemptedProviderCount: 2,
    succeededProviderCount: 2,
    ...options,
});

describe('cross-source version matching', () => {
    it('extracts version markers only from bracketed and trailing segments', () => {
        expect(getSongVersionMarkers('Live Forever')).toEqual([]);
        expect(getSongVersionMarkers('Song Title (Live)')).toEqual(['live']);
        expect(getSongVersionMarkers('Song Title - Live at Wembley')).toEqual(['live']);
        expect(getSongVersionMarkers('Song Title [Instrumental]')).toEqual(['instrumental']);
        expect(getSongVersionMarkers('Song Title（伴奏）')).toEqual(['instrumental']);
        expect(getSongVersionMarkers('Song Title (Sped Up)')).toEqual(['speed']);
    });

    it('ignores neutral remaster and release labels', () => {
        expect(getSongVersionMarkers('Song Title (Remastered 2011)')).toEqual([]);
        expect(getSongVersionMarkers('Song Title (Deluxe Edition)')).toEqual([]);
        expect(getSongVersionMarkers('Song Title (Explicit)')).toEqual([]);
    });

    it('requires identical version marker sets', () => {
        expect(areSongVersionsCompatible('Song Title', 'Song Title (Live)')).toBe(false);
        expect(areSongVersionsCompatible('Song Title', 'Song Title (Remix)')).toBe(false);
        expect(areSongVersionsCompatible('Song Title (Live)', 'Song Title - Live at Wembley')).toBe(true);
        expect(areSongVersionsCompatible('Song Title', 'Song Title (Remastered 2011)')).toBe(true);
    });
});

describe('cross-source candidate evaluation', () => {
    const target = buildCrossSourceMatchTarget(makeSong());

    beforeEach(() => {
        vi.mocked(omni.getSongAvailability).mockReset();
        vi.mocked(omni.getSongAvailability).mockReturnValue({ state: 'playable' });
    });

    it('accepts an identical song with matching duration', () => {
        const decision = evaluateCrossSourceCandidate(target, makeSong({
            providerId: PEER_A,
            mediaId: 'peer-1',
        }));

        expect(decision.accepted).toBe(true);
        expect(decision.reason).toBe('accepted');
        expect(decision.details.score).toBe(100);
    });

    it('builds a title-and-artist search query without the album', () => {
        expect(buildCrossSourceSearchQuery(makeSong())).toBe('Song Title - Main Artist');
    });

    it('rejects live, remix and instrumental variants of a studio song', () => {
        const live = evaluateCrossSourceCandidate(target, makeSong({
            providerId: PEER_A,
            mediaId: 'live',
            title: 'Song Title (Live)',
        }));
        const remix = evaluateCrossSourceCandidate(target, makeSong({
            providerId: PEER_A,
            mediaId: 'remix',
            title: 'Song Title (Remix)',
        }));
        const instrumental = evaluateCrossSourceCandidate(target, makeSong({
            providerId: PEER_A,
            mediaId: 'instrumental',
            title: 'Song Title (Instrumental)',
        }));

        expect(live).toMatchObject({ accepted: false, reason: 'version-mismatch' });
        expect(remix).toMatchObject({ accepted: false, reason: 'version-mismatch' });
        expect(instrumental).toMatchObject({ accepted: false, reason: 'version-mismatch' });
    });

    it('accepts a remastered candidate when the original has no version marker', () => {
        const decision = evaluateCrossSourceCandidate(target, makeSong({
            providerId: PEER_A,
            mediaId: 'remaster',
            title: 'Song Title (Remastered 2011)',
        }));

        expect(decision.accepted).toBe(true);
    });

    it('rejects a duration mismatch even when the identity matches', () => {
        const decision = evaluateCrossSourceCandidate(target, makeSong({
            providerId: PEER_A,
            mediaId: 'long',
            durationMs: 205_000,
        }));

        expect(decision).toMatchObject({
            accepted: false,
            reason: 'duration-mismatch',
        });
        expect(decision.details.durationMatched).toBe(false);
    });

    it('accepts unknown durations', () => {
        const decision = evaluateCrossSourceCandidate(target, makeSong({
            providerId: PEER_A,
            mediaId: 'unknown-duration',
            durationMs: 0,
        }));

        expect(decision.accepted).toBe(true);
        expect(decision.details.durationMatched).toBeNull();
    });

    it('rejects a candidate with a weak identity score', () => {
        const weakTarget = {
            title: 'Alpha Beta Gamma',
            artist: 'Artist One',
            album: 'Shared Album',
            durationMs: 200_000,
        };
        const decision = evaluateCrossSourceCandidate(weakTarget, makeSong({
            providerId: PEER_A,
            mediaId: 'weak',
            title: 'Alpha Beta Gamma Delta',
            artist: 'Zed Quux',
            album: 'Shared Album',
        }));

        expect(decision).toMatchObject({ accepted: false, reason: 'low-score' });
        expect(decision.details.titleMatched).toBe(true);
    });

    it('does not reject a match only because the album differs', () => {
        const decision = evaluateCrossSourceCandidate(
            { ...target, album: 'Album One' },
            makeSong({
                providerId: PEER_A,
                mediaId: 'other-album',
                album: 'Different Album',
            }),
        );

        expect(decision.accepted).toBe(true);
    });

    it('rejects candidates from excluded providers and unavailable candidates', () => {
        const candidate = makeSong({ providerId: PEER_A, mediaId: 'excluded' });

        const excluded = evaluateCrossSourceCandidate(target, candidate, {
            excludedProviderIds: [PEER_A],
        });
        vi.mocked(omni.getSongAvailability).mockReturnValueOnce({ state: 'unavailable' });
        const unavailable = evaluateCrossSourceCandidate(target, candidate);

        expect(excluded).toMatchObject({ accepted: false, reason: 'provider-excluded' });
        expect(unavailable).toMatchObject({ accepted: false, reason: 'unavailable' });
    });
});

describe('findCrossSourceFallback', () => {
    const getProviderIdsMock = vi.mocked(getFederatedSearchProviderIds);
    const searchAllSourcesMock = vi.mocked(searchAllSources);

    beforeEach(() => {
        getProviderIdsMock.mockReset();
        getProviderIdsMock.mockReturnValue([ORIGIN_PROVIDER, PEER_A, PEER_B]);
        searchAllSourcesMock.mockReset();
        vi.mocked(omni.getSongAvailability).mockReset();
        vi.mocked(omni.getSongAvailability).mockReturnValue({ state: 'playable' });
    });

    it('excludes the origin and previously tried providers before searching', async () => {
        getProviderIdsMock.mockReturnValue([ORIGIN_PROVIDER, PEER_A, PEER_B, PEER_C]);
        searchAllSourcesMock.mockResolvedValue(federatedPage([], {
            providerIds: [PEER_A, PEER_B],
        }));

        await findCrossSourceFallback(makeSong(), {
            excludedProviderIds: [PEER_C],
            activeProviderId: PEER_A,
        });

        expect(getProviderIdsMock).toHaveBeenCalledWith({
            activeProviderId: PEER_A,
            requirePlayback: true,
        });
        expect(searchAllSourcesMock).toHaveBeenCalledWith(expect.objectContaining({
            providerIds: [PEER_A, PEER_B],
            activeProviderId: PEER_A,
            limit: 10,
            perProviderLimit: 10,
        }));
    });

    it('returns no match without searching when every other provider was excluded', async () => {
        getProviderIdsMock.mockReturnValue([ORIGIN_PROVIDER]);

        const result = await findCrossSourceFallback(makeSong());

        expect(searchAllSourcesMock).not.toHaveBeenCalled();
        expect(result).toEqual({
            match: null,
            searchedProviderIds: [],
            errors: [],
        });
    });

    it('does not search for local or Navidrome playback', async () => {
        const localSong: SongResult = {
            ...makeSong(),
            sourceRef: { kind: 'local', mediaId: 'local-1' },
        };

        const result = await findCrossSourceFallback(localSong);

        expect(getProviderIdsMock).not.toHaveBeenCalled();
        expect(result.match).toBeNull();
    });

    it('selects the highest-scoring candidate and keeps its provider identity', async () => {
        const lowerScore = makeSong({
            providerId: PEER_A,
            mediaId: 'lower',
            durationMs: 202_000,
        });
        const best = makeSong({
            providerId: PEER_B,
            mediaId: 'best',
        });
        searchAllSourcesMock.mockResolvedValue(federatedPage([lowerScore, best]));

        const result = await findCrossSourceFallback(makeSong());

        expect(result.match?.song).toBe(best);
        expect(result.match?.providerId).toBe(PEER_B);
        expect(result.match?.song.sourceRef).toEqual({
            kind: 'online',
            providerId: PEER_B,
            mediaId: 'best',
        });
    });

    it('skips unavailable candidates and songs from the origin source', async () => {
        const unavailable = makeSong({ providerId: PEER_A, mediaId: 'unavailable' });
        const originCopy = makeSong({ providerId: ORIGIN_PROVIDER, mediaId: 'origin-1' });
        const playable = makeSong({ providerId: PEER_B, mediaId: 'playable' });
        vi.mocked(omni.getSongAvailability).mockImplementation(song => (
            song.sourceRef?.kind === 'online' && song.sourceRef.mediaId === 'unavailable'
                ? { state: 'unavailable' }
                : { state: 'playable' }
        ));
        searchAllSourcesMock.mockResolvedValue(federatedPage([unavailable, originCopy, playable]));

        const result = await findCrossSourceFallback(makeSong());

        expect(result.match?.song).toBe(playable);
    });

    it('returns the federated errors while keeping a successful match', async () => {
        const match = makeSong({ providerId: PEER_A, mediaId: 'match' });
        searchAllSourcesMock.mockResolvedValue(federatedPage([match], {
            errors: [{ providerId: PEER_B, message: 'provider down', timedOut: false }],
            attemptedProviderCount: 2,
            succeededProviderCount: 1,
        }));

        const result = await findCrossSourceFallback(makeSong());

        expect(result.match?.song).toBe(match);
        expect(result.errors).toEqual([{ providerId: PEER_B, message: 'provider down' }]);
        expect(result.searchedProviderIds).toEqual([PEER_A, PEER_B]);
    });
});
