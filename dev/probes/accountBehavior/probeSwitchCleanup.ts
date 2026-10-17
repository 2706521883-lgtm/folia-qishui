import type { LibraryProviderSwitchCleanupPort } from '../../../src/library/core/contracts/account';
import { createLibraryAccountSwitchCleanupPort } from '../../../src/library/app/createLibraryAccountPort';
import { recordAccountCall } from './fakeAuthProviders';

// dev/probes/accountBehavior/probeSwitchCleanup.ts
// 账户探针的切换清理端口：就是应用的那一个（createLibraryAccountSwitchCleanupPort，只重置搜索运行态与集合导航，
// 播放队列与 Lattice 拼贴保留），外面包一层记账（switch-cleanup，带目标平台）。

const realCleanup = createLibraryAccountSwitchCleanupPort();

export const probeSwitchCleanup: LibraryProviderSwitchCleanupPort = {
    resetForProviderSwitch: (nextProviderId, previousProviderId) => {
        recordAccountCall({ op: 'switch-cleanup', providerId: nextProviderId });
        return realCleanup.resetForProviderSwitch(nextProviderId, previousProviderId);
    },
};
