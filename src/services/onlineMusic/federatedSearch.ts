import type { UnifiedSong } from '../../types';
import type { OnlineProviderId } from '../../types/onlineMusic';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';
import { omni } from './omni';

// src/services/onlineMusic/federatedSearch.ts
// Explicit cross-provider search orchestration. Every request stays provider-scoped through Omni.

export type FederatedSearchCursor = {
    providerId: OnlineProviderId;
    limit: number;
    nextOffset: number;
    hasMore: boolean;
    exhausted: boolean;
    consecutiveFailures: number;
    lastError?: string;
};

export type FederatedSearchCursorMap = Record<string, FederatedSearchCursor>;

export type FederatedSearchProviderError = {
    providerId: OnlineProviderId;
    message: string;
    timedOut: boolean;
};

export type FederatedSearchRequest = {
    query: string;
    limit: number;
    activeProviderId?: OnlineProviderId;
    providerIds?: OnlineProviderId[];
    cursors?: FederatedSearchCursorMap;
    perProviderLimit?: number;
    timeoutMs?: number;
};

export type FederatedSearchPage = {
    items: UnifiedSong[];
    cursors: FederatedSearchCursorMap;
    hasMore: boolean;
    errors: FederatedSearchProviderError[];
    providerIds: OnlineProviderId[];
    attemptedProviderCount: number;
    succeededProviderCount: number;
};

const DEFAULT_SEARCH_TIMEOUT_MS = 8000;
const MIN_PER_PROVIDER_LIMIT = 10;

class FederatedSearchTimeoutError extends Error {
    constructor() {
        super('Online source search timed out');
        this.name = 'FederatedSearchTimeoutError';
    }
}

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
        return promise;
    }

    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new FederatedSearchTimeoutError()), timeoutMs);
        promise.then(
            value => {
                clearTimeout(timer);
                resolve(value);
            },
            error => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
};

const toErrorMessage = (error: unknown): string => (
    error instanceof Error ? error.message : 'provider_search_failed'
);

const cloneCursors = (cursors?: FederatedSearchCursorMap): FederatedSearchCursorMap => (
    cursors ? Object.fromEntries(Object.entries(cursors).map(([id, cursor]) => [id, { ...cursor }])) : {}
);

// Discovers configured providers that can both search and play, keeping the active provider first.
export function getFederatedSearchProviderIds(options: {
    activeProviderId?: OnlineProviderId;
    requirePlayback?: boolean;
} = {}): OnlineProviderId[] {
    const requirePlayback = options.requirePlayback ?? true;
    const providerIds: OnlineProviderId[] = [];

    for (const summary of omni.getProviderSummaries()) {
        if (!summary.availability.configured) {
            continue;
        }

        try {
            const capabilities = omni.getProviderCapabilities(summary.providerId);
            if (!capabilities.search || (requirePlayback && !capabilities.playback)) {
                continue;
            }
            providerIds.push(summary.providerId);
        } catch {
            // A provider can disappear between the summary and capability lookups.
        }
    }

    const activeProviderId = options.activeProviderId ?? omni.getActiveProviderSummary()?.providerId;
    if (!activeProviderId || !providerIds.includes(activeProviderId)) {
        return providerIds;
    }

    return [activeProviderId, ...providerIds.filter(providerId => providerId !== activeProviderId)];
}

// Round-robins provider buckets so one source cannot monopolize the first page.
export function interleaveFederatedSearchSongs(
    buckets: Array<{ providerId: OnlineProviderId; items: UnifiedSong[] }>,
    providerOrder: OnlineProviderId[],
): UnifiedSong[] {
    const bucketMap = new Map(buckets.map(bucket => [bucket.providerId, bucket.items]));
    const orderedProviderIds = [
        ...providerOrder,
        ...buckets.map(bucket => bucket.providerId).filter(providerId => !providerOrder.includes(providerId)),
    ];
    const maxBucketLength = Math.max(0, ...buckets.map(bucket => bucket.items.length));
    const seenKeys = new Set<string>();
    const items: UnifiedSong[] = [];

    for (let index = 0; index < maxBucketLength; index += 1) {
        for (const providerId of orderedProviderIds) {
            const song = bucketMap.get(providerId)?.[index];
            if (!song) {
                continue;
            }
            const key = getPlaybackSongKey(song);
            if (seenKeys.has(key)) {
                continue;
            }
            seenKeys.add(key);
            items.push(song);
        }
    }

    return items;
}

// Deduplicates only exact playback identities; the same song on another provider remains a separate row.
export function mergeFederatedSearchSongs(
    existing: UnifiedSong[],
    incoming: UnifiedSong[],
): UnifiedSong[] {
    const seenKeys = new Set(existing.map(getPlaybackSongKey));
    const merged = [...existing];

    for (const song of incoming) {
        const key = getPlaybackSongKey(song);
        if (seenKeys.has(key)) {
            continue;
        }
        seenKeys.add(key);
        merged.push(song);
    }

    return merged;
}

export async function searchAllSources(request: FederatedSearchRequest): Promise<FederatedSearchPage> {
    const query = request.query.trim();
    const providerOrder = getFederatedSearchProviderIds({
        activeProviderId: request.activeProviderId,
        requirePlayback: true,
    });
    const requestedProviderIds = request.providerIds ? new Set(request.providerIds) : null;
    const providerIds = requestedProviderIds
        ? providerOrder.filter(providerId => requestedProviderIds.has(providerId))
        : providerOrder;
    const cursors = cloneCursors(request.cursors);

    if (!query || providerIds.length === 0) {
        return {
            items: [],
            cursors,
            hasMore: false,
            errors: [],
            providerIds,
            attemptedProviderCount: 0,
            succeededProviderCount: 0,
        };
    }

    const defaultPerProviderLimit = Math.max(
        MIN_PER_PROVIDER_LIMIT,
        Math.ceil(request.limit / providerIds.length),
    );
    const timeoutMs = request.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS;

    const results = await Promise.all(providerIds.map(async providerId => {
        const previousCursor = cursors[providerId];
        if (previousCursor?.exhausted) {
            return {
                providerId,
                items: [] as UnifiedSong[],
                cursor: previousCursor,
                error: null as FederatedSearchProviderError | null,
                attempted: false,
                succeeded: false,
            };
        }

        const limit = previousCursor?.limit
            ?? request.perProviderLimit
            ?? defaultPerProviderLimit;
        const offset = previousCursor?.nextOffset ?? 0;

        try {
            const page = await withTimeout(
                omni.searchProviderSongs(providerId, query, { limit, offset }),
                timeoutMs,
            );
            const pageNextOffset = Number.isFinite(page.nextOffset)
                ? page.nextOffset
                : offset + page.items.length;
            const nextOffset = pageNextOffset > offset
                ? pageNextOffset
                : offset + page.items.length;
            const canAdvance = nextOffset > offset;
            const exhausted = !page.hasMore || !canAdvance;
            const cursor: FederatedSearchCursor = {
                providerId,
                limit,
                nextOffset: canAdvance ? nextOffset : offset,
                hasMore: page.hasMore && canAdvance,
                exhausted,
                consecutiveFailures: 0,
            };

            return {
                providerId,
                items: page.items,
                cursor,
                error: null as FederatedSearchProviderError | null,
                attempted: true,
                succeeded: true,
            };
        } catch (error) {
            const consecutiveFailures = (previousCursor?.consecutiveFailures ?? 0) + 1;
            const cursor: FederatedSearchCursor = {
                providerId,
                limit,
                nextOffset: offset,
                hasMore: true,
                exhausted: consecutiveFailures >= 2,
                consecutiveFailures,
                lastError: toErrorMessage(error),
            };
            const providerError: FederatedSearchProviderError = {
                providerId,
                message: cursor.lastError || 'provider_search_failed',
                timedOut: error instanceof FederatedSearchTimeoutError,
            };

            return {
                providerId,
                items: [] as UnifiedSong[],
                cursor,
                error: providerError,
                attempted: true,
                succeeded: false,
            };
        }
    }));

    const nextCursors: FederatedSearchCursorMap = { ...cursors };
    const errors: FederatedSearchProviderError[] = [];
    const buckets: Array<{ providerId: OnlineProviderId; items: UnifiedSong[] }> = [];

    for (const result of results) {
        nextCursors[result.providerId] = result.cursor;
        if (result.error) {
            errors.push(result.error);
        }
        if (result.succeeded) {
            buckets.push({ providerId: result.providerId, items: result.items });
        }
    }

    return {
        items: interleaveFederatedSearchSongs(buckets, providerIds),
        cursors: nextCursors,
        hasMore: providerIds.some(providerId => !nextCursors[providerId]?.exhausted),
        errors,
        providerIds,
        attemptedProviderCount: results.filter(result => result.attempted).length,
        succeededProviderCount: results.filter(result => result.succeeded).length,
    };
}
