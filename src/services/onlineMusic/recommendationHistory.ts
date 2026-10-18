import type { SongResult } from '../../types';
import { getPlaybackSongKey } from '../../utils/appPlaybackGuards';

// src/services/onlineMusic/recommendationHistory.ts
// A small, bounded "already recommended" ledger. The queue only dedupes against what is currently
// in it; once a song has played and left the queue the provider can hand it back on the next batch.
// Keeping the recent keys (per provider, seven days, 300 songs) keeps a recommendation stream from
// looping on the same handful of tracks without turning into a permanent ban list.

export const RECOMMENDATION_HISTORY_LIMIT = 300;
export const RECOMMENDATION_HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const STORAGE_PREFIX = 'folia.recommendation.seen.v1:';

type SeenEntry = { key: string; at: number };

const memoryHistory = new Map<string, SeenEntry[]>();

const providerIdOf = (song: SongResult): string => {
    const sourceRef = song.sourceRef;
    return sourceRef?.kind === 'online' && sourceRef.providerId ? sourceRef.providerId : 'unknown';
};

const storageKey = (providerId: string): string => `${STORAGE_PREFIX}${providerId}`;

const isStorageAvailable = (): boolean => {
    try {
        return typeof window !== 'undefined' && Boolean(window.localStorage);
    } catch {
        return false;
    }
};

const prune = (entries: SeenEntry[], now: number): SeenEntry[] => {
    const cutoff = now - RECOMMENDATION_HISTORY_TTL_MS;
    return entries
        .filter(entry => Number.isFinite(entry.at) && entry.at >= cutoff)
        .sort((left, right) => left.at - right.at)
        .slice(-RECOMMENDATION_HISTORY_LIMIT);
};

const read = (providerId: string, now = Date.now()): SeenEntry[] => {
    let entries: SeenEntry[] = [];
    if (isStorageAvailable()) {
        try {
            const raw = window.localStorage.getItem(storageKey(providerId));
            const parsed = raw ? JSON.parse(raw) : [];
            if (Array.isArray(parsed)) {
                entries = parsed.filter(entry => (
                    entry
                    && typeof entry.key === 'string'
                    && typeof entry.at === 'number'
                ));
            }
        } catch {
            // A corrupt or unavailable store should never make the feed fail.
            entries = memoryHistory.get(providerId) ?? [];
        }
    } else {
        entries = memoryHistory.get(providerId) ?? [];
    }
    const pruned = prune(entries, now);
    memoryHistory.set(providerId, pruned);
    return pruned;
};

const write = (providerId: string, entries: SeenEntry[]): void => {
    memoryHistory.set(providerId, entries);
    if (!isStorageAvailable()) return;
    try {
        window.localStorage.setItem(storageKey(providerId), JSON.stringify(entries));
    } catch {
        // Quota or private-mode failures fall back to the in-memory copy.
    }
};

const groupByProvider = (songs: readonly SongResult[]): Map<string, string[]> => {
    const grouped = new Map<string, string[]>();
    for (const song of songs) {
        const providerId = providerIdOf(song);
        const key = getPlaybackSongKey(song);
        const keys = grouped.get(providerId);
        if (keys) keys.push(key);
        else grouped.set(providerId, [key]);
    }
    return grouped;
};

/** Songs whose key has not appeared in this provider's recent recommendation history. */
export const filterUnseenRecommendations = (songs: readonly SongResult[]): SongResult[] => {
    const now = Date.now();
    const seenByProvider = new Map<string, Set<string>>();
    const seenInBatch = new Set<string>();
    return songs.filter(song => {
        const providerId = providerIdOf(song);
        const key = getPlaybackSongKey(song);
        const entryKey = `${providerId}\u0000${key}`;
        if (seenInBatch.has(entryKey)) return false;
        seenInBatch.add(entryKey);
        let seen = seenByProvider.get(providerId);
        if (!seen) {
            seen = new Set(read(providerId, now).map(entry => entry.key));
            seenByProvider.set(providerId, seen);
        }
        return !seen.has(key);
    });
};

/** Record songs after they have actually been handed to playback/queue. */
export const markRecommendationsSeen = (songs: readonly SongResult[]): void => {
    const now = Date.now();
    for (const [providerId, keys] of groupByProvider(songs)) {
        const entries = read(providerId, now).filter(entry => !keys.includes(entry.key));
        keys.forEach(key => entries.push({ key, at: now }));
        write(providerId, prune(entries, now));
    }
};

/** Forget the history for the providers represented in `songs` (used when a batch is exhausted). */
export const clearRecommendationHistoryForSongs = (songs: readonly SongResult[]): void => {
    for (const providerId of groupByProvider(songs).keys()) {
        memoryHistory.delete(providerId);
        if (!isStorageAvailable()) continue;
        try {
            window.localStorage.removeItem(storageKey(providerId));
        } catch {
            // Ignore storage failures; the in-memory copy is already cleared.
        }
    }
};

/** Test/debug helper: how many keys are currently remembered for a provider. */
export const getRecommendationHistorySize = (providerId: string): number => read(providerId).length;
