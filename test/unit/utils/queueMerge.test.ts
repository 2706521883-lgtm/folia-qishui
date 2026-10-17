import { describe, expect, it } from 'vitest';
import type { SongResult } from '@/types';
import { appendUniqueQueueSongs } from '@/utils/queueMerge';

// test/unit/utils/queueMerge.test.ts
// 打开在线歌单时把曲目并入现有队列：保留顺序、按 sourceRef 去重，跨平台的同名数字 id 各算一首。

const song = (id: number, providerId: 'netease' | 'qq', mediaId: string): SongResult => ({
    id,
    name: `Song ${mediaId}`,
    artists: [],
    album: { id: 0, name: '' },
    durationMs: 1,
    sourceRef: { kind: 'online', providerId, mediaId },
});

describe('appendUniqueQueueSongs', () => {
    it('keeps the existing queue order and appends only new tracks', () => {
        const current = [song(1, 'netease', 'a')];
        const incoming = [song(2, 'qq', 'b'), song(1, 'netease', 'a'), song(3, 'netease', 'c')];

        const result = appendUniqueQueueSongs(current, incoming);

        expect(result.queue.map(entry => entry.name)).toEqual(['Song a', 'Song b', 'Song c']);
        expect(result.added.map(entry => entry.name)).toEqual(['Song b', 'Song c']);
    });

    it('treats the same numeric id from different providers as different songs', () => {
        const current = [song(1, 'netease', 'same')];
        const incoming = [song(1, 'qq', 'same')];

        const result = appendUniqueQueueSongs(current, incoming);

        expect(result.queue).toHaveLength(2);
        expect(result.added).toHaveLength(1);
        expect(result.added[0].sourceRef).toEqual({ kind: 'online', providerId: 'qq', mediaId: 'same' });
    });

    it('returns the same queue instance when nothing is new', () => {
        const current = [song(1, 'netease', 'a')];

        const result = appendUniqueQueueSongs(current, [song(1, 'netease', 'a')]);

        expect(result.queue).toBe(current);
        expect(result.added).toEqual([]);
    });
});
