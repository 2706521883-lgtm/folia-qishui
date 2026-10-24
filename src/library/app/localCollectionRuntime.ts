import type { HomeSurfaceProps } from '../../components/app/home/homeSurfaceTypes';
import {
    refreshLocalGridViewCollection,
    type LocalGridViewCollectionDescriptor,
} from '../../components/app/home/gridViewCollectionAdapters';
import type { LocalLibraryCatalogSnapshot } from '../../hooks/useLocalLibraryCatalog';

// src/library/app/localCollectionRuntime.ts
// 本地集合在打开 / 刷新时读取最新的曲库与歌单（收藏歌单的 songIds 可能已经变了）。
// 首页宿主与播放器侧栏共用这一份，避免两处对“当前本地歌单是什么”给出不同答案。
export const resolveLiveLocalCollection = (
    collection: LocalGridViewCollectionDescriptor,
    surfaceProps: HomeSurfaceProps,
    catalog: LocalLibraryCatalogSnapshot,
): LocalGridViewCollectionDescriptor | null => {
    if (!collection.playlistId) {
        return refreshLocalGridViewCollection(
            collection,
            surfaceProps.localSongs,
            catalog.ready ? catalog : undefined,
        );
    }

    const playlist = surfaceProps.localPlaylists.find(item => item.id === collection.playlistId);
    if (!playlist) {
        return null;
    }

    const validSongIds = new Set(surfaceProps.localSongs.map(song => song.id));
    const songIds = playlist.songIds.filter(songId => validSongIds.has(songId));

    return {
        ...collection,
        name: playlist.name,
        songIds,
        trackCount: songIds.length,
        isVirtual: playlist.isFavorite,
    };
};
