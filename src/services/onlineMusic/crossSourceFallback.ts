import type { SongResult, UnifiedSong } from '../../types';
import type { OnlineProviderId } from '../../types/onlineMusic';
import { getOnlineProviderIdForSong, getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import {
    calculateMatchScoreDetails,
    type MatchScoreDetails,
} from '../../utils/lyrics/matchScore';
import {
    buildLyricSearchQuery,
    normalizeSongTitleForLyricSearch,
} from '../../utils/lyrics/searchQuery';
import {
    getFederatedSearchProviderIds,
    searchAllSources,
} from './federatedSearch';
import { omni } from './omni';
import { getProviderSongMetadata } from './songMetadata';

// src/services/onlineMusic/crossSourceFallback.ts
// Explicit cross-provider fallback. Candidates stay provider-scoped and keep their own sourceRef.

export const MAX_CROSS_SOURCE_FALLBACK_ATTEMPTS = 2;
export const CROSS_SOURCE_MIN_SCORE = 75;

export type CrossSourceMatchTarget = {
    title: string;
    artist: string;
    album?: string;
    durationMs: number;
};

export type CrossSourceMatchDecision = {
    accepted: boolean;
    reason: 'accepted'
        | 'provider-excluded'
        | 'unavailable'
        | 'identity-mismatch'
        | 'version-mismatch'
        | 'duration-mismatch'
        | 'low-score';
    details: MatchScoreDetails;
};

export type CrossSourceFallbackMatch = {
    song: UnifiedSong;
    providerId: OnlineProviderId;
    details: MatchScoreDetails;
};

export type CrossSourceFallbackResult = {
    match: CrossSourceFallbackMatch | null;
    searchedProviderIds: OnlineProviderId[];
    errors: Array<{ providerId: OnlineProviderId; message: string }>;
};

type VersionMarker = string;

const VERSION_MARKER_DEFINITIONS: Array<{ marker: VersionMarker; pattern: RegExp }> = [
    {
        marker: 'live',
        // "Live Forever" is a title, so only standalone live/version phrases count.
        pattern: /(?:^|[\s(（[【])(?:live|现场版?|ライブ)(?=$|[\s)）\]】]|版|version|ver\.?|at\b|@|[-–—]\s*\d{4}|\d{4})/iu,
    },
    { marker: 'remix', pattern: /\b(?:remix|rmx)\b/iu },
    { marker: 'instrumental', pattern: /\binstrumental\b|\binst\.?\b|off\s*vocal|伴奏|纯音乐|インスト/iu },
    { marker: 'karaoke', pattern: /\bkaraoke\b|カラオケ/iu },
    { marker: 'cover', pattern: /\bcover\b|翻唱|カバー/iu },
    { marker: 'acoustic', pattern: /\bacoustic\b|\bunplugged\b|不插电|アコースティック/iu },
    { marker: 'demo', pattern: /\bdemo\b/iu },
    { marker: 'nightcore', pattern: /\bnightcore\b/iu },
    { marker: 'speed', pattern: /\bsped\s*up\b|\bspeed\s*up\b|\bslowed\b|\bslow(?:ed)?\s*down\b|加速|降速|减速|スピードアップ/iu },
    { marker: 'edit', pattern: /\b(?:radio\s*)?edit\b/iu },
    { marker: 'arrange', pattern: /\barran(?:ge|ged|gement)\b|改编|編曲/iu },
];

// Neutral release labels describe the same recording, so they must not lower the title score.
const NEUTRAL_BRACKET_LABEL = /[(（[【]\s*(?:remaster(?:ed)?(?:\s*\d{4})?|album\s+version|single\s+version|deluxe(?:\s+edition)?|bonus(?:\s+track)?|explicit|clean)\s*[)）\]】]/giu;
const NEUTRAL_TRAILING_LABEL = /\s+[-–—]\s*(?:remaster(?:ed)?(?:\s*\d{4})?|album\s+version|single\s+version|deluxe(?:\s+edition)?|bonus(?:\s+track)?|explicit|clean)\s*$/iu;

const stripNeutralVersionLabels = (title: string): string => (
    title.replace(NEUTRAL_BRACKET_LABEL, '').replace(NEUTRAL_TRAILING_LABEL, '').trim()
);

const addMarkersFromSegment = (segment: string, markers: Set<VersionMarker>): void => {
    const trimmedSegment = segment.trim();
    if (!trimmedSegment) return;

    for (const definition of VERSION_MARKER_DEFINITIONS) {
        if (definition.pattern.test(trimmedSegment)) {
            markers.add(definition.marker);
        }
    }
};

// Extracts only bracketed and trailing " - ..." version hints, never markers inside the base title.
export function getSongVersionMarkers(title: string): VersionMarker[] {
    const markers = new Set<VersionMarker>();
    const normalizedTitle = title.trim();
    if (!normalizedTitle) return [];

    const bracketPattern = /[(（[【]([^)）\]】]+)[)）\]】]/gu;
    for (const match of normalizedTitle.matchAll(bracketPattern)) {
        addMarkersFromSegment(match[1], markers);
    }

    const trailingSegments = normalizedTitle.split(/\s+[-–—]\s+/u).slice(1);
    for (const segment of trailingSegments) {
        addMarkersFromSegment(segment, markers);
    }

    return [...markers].sort();
}

// Exact marker-set equality keeps live/remix/instrumental variants from being auto-substituted.
export function areSongVersionsCompatible(targetTitle: string, candidateTitle: string): boolean {
    const targetMarkers = getSongVersionMarkers(targetTitle);
    const candidateMarkers = getSongVersionMarkers(candidateTitle);
    return targetMarkers.length === candidateMarkers.length
        && targetMarkers.every((marker, index) => marker === candidateMarkers[index]);
}

export function buildCrossSourceMatchTarget(song: SongResult): CrossSourceMatchTarget {
    const metadata = getProviderSongMetadata(song);
    const artist = metadata.artists.map(item => item.name).filter(Boolean).join(', ');
    const normalizedTitle = normalizeSongTitleForLyricSearch(song.name, artist) || song.name.trim();
    const album = metadata.album?.name?.trim();

    return {
        title: normalizedTitle,
        artist,
        ...(album ? { album } : {}),
        durationMs: metadata.durationMs || song.durationMs || 0,
    };
}

// Cross-provider albums usually differ, so they are ranking metadata rather than part of the query.
export function buildCrossSourceSearchQuery(song: SongResult): string {
    const target = buildCrossSourceMatchTarget(song);
    return buildLyricSearchQuery(target.title, target.artist);
}

const getCandidateDurationMs = (candidate: SongResult): number => (
    getProviderSongMetadata(candidate).durationMs || candidate.durationMs || 0
);

const getCandidateAvailabilityState = (candidate: SongResult): string => {
    try {
        return omni.getSongAvailability(candidate).state;
    } catch {
        return 'unknown';
    }
};

export function evaluateCrossSourceCandidate(
    target: CrossSourceMatchTarget,
    candidate: SongResult,
    options: { excludedProviderIds?: Iterable<OnlineProviderId> } = {},
): CrossSourceMatchDecision {
    const scoringTarget = {
        ...target,
        title: stripNeutralVersionLabels(target.title),
    };
    const scoringCandidate = {
        ...candidate,
        name: stripNeutralVersionLabels(candidate.name || ''),
    };
    const details = calculateMatchScoreDetails(scoringTarget, scoringCandidate);
    const identityDetails = calculateMatchScoreDetails(
        { ...scoringTarget, album: undefined },
        scoringCandidate,
    );
    const providerId = getOnlineProviderIdForSong(candidate);
    const excludedProviderIds = new Set(options.excludedProviderIds ?? []);

    if (providerId && excludedProviderIds.has(providerId)) {
        return { accepted: false, reason: 'provider-excluded', details };
    }
    if (getCandidateAvailabilityState(candidate) === 'unavailable') {
        return { accepted: false, reason: 'unavailable', details };
    }
    if (!areSongVersionsCompatible(target.title, candidate.name || '')) {
        return { accepted: false, reason: 'version-mismatch', details };
    }
    if (!details.titleMatched || !(details.artistMatched || details.albumMatched === true)) {
        return { accepted: false, reason: 'identity-mismatch', details };
    }
    if (details.durationMatched === false) {
        return { accepted: false, reason: 'duration-mismatch', details };
    }
    // Album differences must not block playback; the identity score neutralizes album weight.
    if (identityDetails.score < CROSS_SOURCE_MIN_SCORE) {
        return { accepted: false, reason: 'low-score', details };
    }

    return { accepted: true, reason: 'accepted', details };
}

const durationDifference = (targetDurationMs: number, candidate: SongResult): number => {
    const candidateDurationMs = getCandidateDurationMs(candidate);
    return targetDurationMs > 0 && candidateDurationMs > 0
        ? Math.abs(targetDurationMs - candidateDurationMs)
        : Number.POSITIVE_INFINITY;
};

const finiteDurationDifference = (value: number): number => (
    Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER
);

export async function findCrossSourceFallback(
    song: SongResult,
    options: {
        excludedProviderIds?: Iterable<OnlineProviderId>;
        query?: string;
        perProviderLimit?: number;
        timeoutMs?: number;
        activeProviderId?: OnlineProviderId;
    } = {},
): Promise<CrossSourceFallbackResult> {
    const originProviderId = getOnlineProviderIdForSong(song);
    if (!originProviderId) {
        return { match: null, searchedProviderIds: [], errors: [] };
    }

    const excludedProviderIds = new Set<OnlineProviderId>([
        originProviderId,
        ...(options.excludedProviderIds ?? []),
    ]);
    const candidateProviderIds = getFederatedSearchProviderIds({
        activeProviderId: options.activeProviderId,
        requirePlayback: true,
    }).filter(providerId => !excludedProviderIds.has(providerId));

    if (candidateProviderIds.length === 0) {
        return { match: null, searchedProviderIds: [], errors: [] };
    }

    const target = buildCrossSourceMatchTarget(song);
    const query = options.query?.trim() || buildCrossSourceSearchQuery(song);
    if (!query) {
        return { match: null, searchedProviderIds: [], errors: [] };
    }

    const perProviderLimit = options.perProviderLimit ?? 10;
    const page = await searchAllSources({
        query,
        limit: perProviderLimit,
        activeProviderId: options.activeProviderId,
        providerIds: candidateProviderIds,
        perProviderLimit,
        timeoutMs: options.timeoutMs,
    });
    const originalKey = getPlaybackSongKey(song);
    const candidateProviderIdSet = new Set(candidateProviderIds);
    const acceptedMatches: Array<{
        match: CrossSourceFallbackMatch;
        order: number;
        durationDiffMs: number;
    }> = [];

    page.items.forEach((candidate, order) => {
        const providerId = getOnlineProviderIdForSong(candidate);
        if (!providerId || !candidateProviderIdSet.has(providerId)) {
            return;
        }
        if (providerId === originProviderId || excludedProviderIds.has(providerId)) {
            return;
        }
        if (getPlaybackSongKey(candidate) === originalKey) {
            return;
        }

        const decision = evaluateCrossSourceCandidate(target, candidate, { excludedProviderIds });
        if (!decision.accepted) {
            return;
        }

        acceptedMatches.push({
            match: {
                song: candidate,
                providerId,
                details: decision.details,
            },
            order,
            durationDiffMs: durationDifference(target.durationMs, candidate),
        });
    });

    acceptedMatches.sort((left, right) => (
        right.match.details.score - left.match.details.score
        || Number(right.match.details.durationMatched === true)
            - Number(left.match.details.durationMatched === true)
        || finiteDurationDifference(left.durationDiffMs) - finiteDurationDifference(right.durationDiffMs)
        || left.order - right.order
    ));

    return {
        match: acceptedMatches[0]?.match ?? null,
        searchedProviderIds: page.providerIds,
        errors: page.errors.map(error => ({
            providerId: error.providerId,
            message: error.message,
        })),
    };
}
