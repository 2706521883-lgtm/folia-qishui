import type { SongResult } from '../types';
import { getPlaybackSongKey } from './appPlaybackGuards';

// src/utils/queueMerge.ts
// 跨平台队列拼接：保留现有队列的顺序，只把尚未在队列里的歌按传入顺序接在尾部。
// 身份按 sourceRef（provider + mediaId）区分，不同平台的同名数字 id 不会被误判成重复。

export type QueueMergeResult = {
    queue: SongResult[];
    added: SongResult[];
};

export const appendUniqueQueueSongs = (queue: SongResult[], songs: SongResult[]): QueueMergeResult => {
    const seen = new Set(queue.map(getPlaybackSongKey));
    const added: SongResult[] = [];

    for (const song of songs) {
        const key = getPlaybackSongKey(song);
        if (seen.has(key)) continue;
        seen.add(key);
        added.push(song);
    }

    return {
        queue: added.length > 0 ? [...queue, ...added] : queue,
        added,
    };
};
