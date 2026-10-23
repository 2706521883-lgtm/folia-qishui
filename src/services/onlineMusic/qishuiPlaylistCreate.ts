import { clearQishuiLibraryCache } from './qishuiLibrary';
import { requestQishui } from './qishuiTransport';

// src/services/onlineMusic/qishuiPlaylistCreate.ts
// UI components must not import the provider transport directly (Omni architecture boundary);
// keep the one-off "create an empty Qishui playlist" write here.
export type CreatedQishuiPlaylist = {
    id: string;
    name: string;
    cover?: string;
};

export const createQishuiPlaylist = async (name: string): Promise<CreatedQishuiPlaylist | null> => {
    const data = await requestQishui<{
        playlist?: { id?: unknown; name?: unknown; cover?: unknown };
    }>('playlist.create', { name });
    clearQishuiLibraryCache();
    const playlist = data?.playlist;
    if (!playlist?.id) return null;
    return {
        id: String(playlist.id),
        name: String(playlist.name || name),
        ...(playlist.cover ? { cover: String(playlist.cover) } : {}),
    };
};
