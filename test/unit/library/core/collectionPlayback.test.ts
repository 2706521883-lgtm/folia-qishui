import { describe, expect, it } from 'vitest';
import type { LibraryCollectionDescriptor } from '@/library/core/contracts/collection';
import { shouldMergeCollectionQueue } from '@/library/core/model/collectionPlayback';

// test/unit/library/core/collectionPlayback.test.ts
// 只有从合并歌单墙打开的在线歌单并入现有队列；专辑、歌手、本地与 Navidrome 集合仍按替换语义播放。

const collection = (overrides: Partial<LibraryCollectionDescriptor>): LibraryCollectionDescriptor => ({
    source: 'online',
    type: 'playlist',
    id: 'c1',
    name: 'Collection',
    providerId: 'netease',
    ...overrides,
} as LibraryCollectionDescriptor);

describe('shouldMergeCollectionQueue', () => {
    it('merges online playlists', () => {
        expect(shouldMergeCollectionQueue(collection({ source: 'online', type: 'playlist' }))).toBe(true);
    });

    it('does not merge online albums or artist pages', () => {
        expect(shouldMergeCollectionQueue(collection({ source: 'online', type: 'album' }))).toBe(false);
        expect(shouldMergeCollectionQueue(collection({ source: 'online', type: 'artist' }))).toBe(false);
    });

    it('does not merge local or Navidrome collections', () => {
        expect(shouldMergeCollectionQueue(collection({ source: 'local', type: 'playlist' }))).toBe(false);
        expect(shouldMergeCollectionQueue(collection({ source: 'navidrome', type: 'playlist' }))).toBe(false);
    });
});
