import { beforeEach, describe, expect, it, vi } from 'vitest';

// test/unit/library/app/libraryAccountPort.test.ts
// 切换平台只重置浏览态（搜索运行态换到新平台、集合导航清空）；播放队列、当前歌曲、歌词、封面、
// FM 模式与播放状态都保留，Lattice 拼贴因此不会被切换平台清空。

import { createLibraryAccountSwitchCleanupPort } from '@/library/app/createLibraryAccountPort';
import { usePlaybackStore } from '@/stores/usePlaybackStore';
import { useSearchNavigationStore } from '@/stores/useSearchNavigationStore';
import { useCollectionNavigationStore } from '@/stores/useCollectionNavigationStore';
import { PlayerState, type SongResult } from '@/types';

const song = { id: 's1', name: 'Song', artists: [], album: { id: '', name: '' } } as unknown as SongResult;

describe('provider switch cleanup port', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        usePlaybackStore.setState({
            audioSrc: 'blob:old-track',
            currentSong: song,
            playQueue: [song],
            cachedCoverUrl: 'cover.png',
            isFmMode: true,
            playerState: PlayerState.PLAYING,
        });
    });

    it('resets only the browse state and leaves playback and the queue intact', () => {
        const resetRuntime = vi.spyOn(useSearchNavigationStore.getState(), 'resetRuntime');
        const clearNavigation = vi.spyOn(useCollectionNavigationStore.getState(), 'clear');

        createLibraryAccountSwitchCleanupPort().resetForProviderSwitch('kugou', 'netease');

        expect(resetRuntime).toHaveBeenCalledWith('kugou');
        expect(clearNavigation).toHaveBeenCalledTimes(1);
        expect(usePlaybackStore.getState()).toMatchObject({
            audioSrc: 'blob:old-track',
            currentSong: song,
            playQueue: [song],
            cachedCoverUrl: 'cover.png',
            isFmMode: true,
            playerState: PlayerState.PLAYING,
        });
    });

    it('does not revoke the playing audio when the platform changes', () => {
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});

        createLibraryAccountSwitchCleanupPort().resetForProviderSwitch('qq', 'netease');

        expect(revoke).not.toHaveBeenCalled();
        revoke.mockRestore();
    });
});
