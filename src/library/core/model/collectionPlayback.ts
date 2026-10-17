import type { LibraryCollectionDescriptor } from '../contracts/collection';

// src/library/core/model/collectionPlayback.ts
// 从合并歌单墙打开的在线歌单：播放时把歌单曲目并入现有队列，拼贴墙因此能保持跨平台混排。
// 专辑、歌手、本地与 Navidrome 集合仍按「替换」语义播放。

export const shouldMergeCollectionQueue = (collection: LibraryCollectionDescriptor): boolean => (
    collection.source === 'online' && collection.type === 'playlist'
);
