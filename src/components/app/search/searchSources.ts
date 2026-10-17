import type { SearchSource } from '../../../stores/useSearchNavigationStore';
import type { OmniProviderCapabilities, OmniProviderId, OmniProviderSummary } from '../../../types/onlineMusic';

// src/components/app/search/searchSources.ts
// 搜索页的数据源页签：每个已配置且支持搜索的在线音源都单独一项（不再只列当前平台），
// 后面才是本地库与 Navidrome。顺序沿用 provider 注册顺序，切换平台不会改变这排页签。

export const collectOnlineSearchSources = (
    providers: readonly OmniProviderSummary[],
    getCapabilities: (providerId: OmniProviderId) => OmniProviderCapabilities,
): OmniProviderId[] => providers
    .filter(provider => provider.availability.configured)
    .filter(provider => getCapabilities(provider.providerId).search)
    .map(provider => provider.providerId);

export const resolveSearchSources = (
    providers: readonly OmniProviderSummary[],
    getCapabilities: (providerId: OmniProviderId) => OmniProviderCapabilities,
): SearchSource[] => [
    'all',
    ...collectOnlineSearchSources(providers, getCapabilities),
    'local',
    'navidrome',
];
