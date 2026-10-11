import type { OnlineMutationProvider, MediaId, ProviderCollection } from '../../types/onlineMusic';
import type { SongResult } from '../../types';
import { OnlineProviderError } from '../../types/onlineMusic';
import { getPlaybackSourceRef } from '../../utils/appPlaybackGuards';
import { requestQishui } from './qishuiTransport';
import { clearQishuiLibraryCache } from './qishuiLibrary';

// src/services/onlineMusic/qishuiMutations.ts

function songId(song: MediaId | SongResult): string {
    if (typeof song !== 'object') return String(song);
    const source = getPlaybackSourceRef(song);
    if (source?.kind !== 'online' || source.providerId !== 'qishui') {
        throw new OnlineProviderError('unsupported', 'Song does not belong to Qishui Music', 'qishui');
    }
    return String(source.mediaId);
}

function playlistId(playlist: MediaId | ProviderCollection): string {
    if (typeof playlist !== 'object') return String(playlist);
    if (playlist.providerId !== 'qishui' || playlist.type !== 'playlist' || !playlist.isOwned) {
        throw new OnlineProviderError('unsupported', 'Playlist is not an owned Qishui Music playlist', 'qishui');
    }
    return String(playlist.id);
}

const likeSong = async (song: MediaId | SongResult, liked: boolean): Promise<void> => {
    try { await requestQishui('track.like', { id: songId(song), liked }); }
    finally { clearQishuiLibraryCache(); }
};

export const qishuiMutations: OnlineMutationProvider = {
    canAddToPlaylist: playlist => playlist.providerId === 'qishui' && playlist.type === 'playlist' && playlist.isOwned === true,
    likeSong,
    async updatePlaylistTracks(operation, playlist, tracks) {
        if (!tracks.length) return;
        // 冻结契约只暴露了单曲一次的 `playlist.addSong`，没有删除 operation：
        // 删除请求直接拒绝，而不是报一个其实没落到账号上的成功。
        if (operation !== 'add') {
            throw new OnlineProviderError('unsupported', 'Qishui Music playlists cannot remove tracks through this bridge', 'qishui');
        }
        if (tracks.length > 100) throw new OnlineProviderError('unsupported', 'Select at most 100 tracks per operation', 'qishui');
        const id = playlistId(playlist);
        try {
            for (const track of tracks) await requestQishui('playlist.addSong', { playlistId: id, trackId: songId(track) });
        } finally { clearQishuiLibraryCache(); }
    },
    async subscribePlaylist(playlist, subscribed) {
        const id = typeof playlist === 'object' ? String(playlist.id) : String(playlist);
        try { await requestQishui('playlist.collect', { id, collected: subscribed }); }
        finally { clearQishuiLibraryCache(); }
    },
    async subscribeAlbum(id, subscribed) {
        try { await requestQishui('album.collect', { id: String(id), collected: subscribed }); }
        finally { clearQishuiLibraryCache(); }
    },
};
