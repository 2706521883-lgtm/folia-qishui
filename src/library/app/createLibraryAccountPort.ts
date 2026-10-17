import type { OnlineProviderId } from '../../types/onlineMusic';
import type { LibraryProviderSwitchCleanupPort } from '../core/contracts/account';
import { useSearchNavigationStore } from '../../stores/useSearchNavigationStore';
import { useCollectionNavigationStore } from '../../stores/useCollectionNavigationStore';

// src/library/app/createLibraryAccountPort.ts
// 在线账户 controller 的切换端口（原 App.tsx 的 handleConfirmProviderSwitch）。
// 切换平台只改变「正在浏览 / 默认搜索」的平台：播放队列、当前歌曲、歌词与 Lattice 拼贴都保留。
// 在线歌曲按各自 sourceRef 里的 provider 播放，不依赖 active provider，所以这里不再停播、清空队列或丢弃预取缓存；
// 已混入的其他平台歌曲会继续留在拼贴墙上，下一次播放/切歌仍从原音源取流（失败时照旧跨源兜底）。

export const createLibraryAccountSwitchCleanupPort = (): LibraryProviderSwitchCleanupPort => ({
    resetForProviderSwitch: (nextProviderId: OnlineProviderId) => {
        useSearchNavigationStore.getState().resetRuntime(nextProviderId);
        useCollectionNavigationStore.getState().clear();
    },
});
