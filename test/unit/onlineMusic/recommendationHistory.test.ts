import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SongResult } from '@/types';
import {
    RECOMMENDATION_HISTORY_LIMIT,
    RECOMMENDATION_HISTORY_TTL_MS,
    clearRecommendationHistoryForSongs,
    filterUnseenRecommendations,
    getRecommendationHistorySize,
    markRecommendationsSeen,
} from '@/services/onlineMusic/recommendationHistory';

// test/unit/onlineMusic/recommendationHistory.test.ts
// The ledger is deliberately small and forgiving: it must dedupe across batches, survive a
// restart, age out, and never make the feed fail because storage is full or missing.

const createStorage = (initial: Record<string, string> = {}) => {
    const values = new Map(Object.entries(initial));
    return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
    };
};

const song = (id: string, providerId = 'qishui'): SongResult => ({
    id,
    sourceRef: { kind: 'online', providerId, mediaId: id },
} as unknown as SongResult);

const clear = (providerId = 'qishui') => clearRecommendationHistoryForSongs([song('seed', providerId)]);

describe('recommendationHistory', () => {
    beforeEach(() => {
        vi.stubGlobal('window', { localStorage: createStorage() });
        clear();
    });

    afterEach(() => {
        clear();
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('filters songs seen in earlier batches and within the same batch', () => {
        const first = song('a');
        const second = song('b');
        markRecommendationsSeen([first]);

        expect(filterUnseenRecommendations([first, second, second]).map(item => item.id)).toEqual(['b']);
    });

    it('persists across a new module call and clears on demand', () => {
        markRecommendationsSeen([song('a')]);
        expect(filterUnseenRecommendations([song('a')])).toEqual([]);
        expect(getRecommendationHistorySize('qishui')).toBe(1);

        clear();
        expect(filterUnseenRecommendations([song('a')]).map(item => item.id)).toEqual(['a']);
    });

    it('keeps providers separate', () => {
        markRecommendationsSeen([song('a', 'qishui')]);
        expect(filterUnseenRecommendations([song('a', 'qq')]).map(item => item.id)).toEqual(['a']);

        clear('qishui');
        clear('qq');
    });

    it('expires entries after the TTL', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-18T00:00:00Z'));
        markRecommendationsSeen([song('a')]);

        vi.setSystemTime(new Date(Date.now() + RECOMMENDATION_HISTORY_TTL_MS + 1));
        expect(filterUnseenRecommendations([song('a')]).map(item => item.id)).toEqual(['a']);
    });

    it('keeps only the newest entries up to the limit', () => {
        const songs = Array.from({ length: RECOMMENDATION_HISTORY_LIMIT + 5 }, (_, index) => song(`s-${index}`));
        markRecommendationsSeen(songs);
        expect(getRecommendationHistorySize('qishui')).toBe(RECOMMENDATION_HISTORY_LIMIT);

        // The oldest five have been evicted, the newest one is still remembered.
        expect(filterUnseenRecommendations([song('s-0')])).toHaveLength(1);
        expect(filterUnseenRecommendations([song(`s-${songs.length - 1}`)])).toEqual([]);
    });

    it('falls back to memory when localStorage throws', () => {
        vi.stubGlobal('window', {
            localStorage: {
                getItem: () => { throw new Error('denied'); },
                setItem: () => { throw new Error('quota'); },
                removeItem: () => { throw new Error('denied'); },
            },
        });

        markRecommendationsSeen([song('a')]);
        expect(filterUnseenRecommendations([song('a')])).toEqual([]);
        expect(getRecommendationHistorySize('qishui')).toBe(1);
    });
});
