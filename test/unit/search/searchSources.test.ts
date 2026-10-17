import { describe, expect, it } from 'vitest';
import type { OmniProviderCapabilities, OmniProviderId, OmniProviderSummary } from '@/types/onlineMusic';
import { collectOnlineSearchSources, resolveSearchSources } from '@/components/app/search/searchSources';
import type { SearchSource } from '@/stores/useSearchNavigationStore';

// test/unit/search/searchSources.test.ts
// 搜索页的页签：所有已配置且支持搜索的在线音源各占一项，顺序跟随 provider 注册顺序，
// 未配置（Web 端的 Electron-only 音源）或不支持搜索的音源不出现。

const provider = (providerId: OmniProviderId, configured = true): OmniProviderSummary => ({
    providerId,
    displayName: providerId,
    shortName: providerId,
    availability: { configured },
    requiresAccount: true,
    status: 'unknown',
    user: null,
    collections: [],
});

const capabilities = (search: boolean): OmniProviderCapabilities => ({ search } as OmniProviderCapabilities);

describe('search sources', () => {
    it('lists every configured online provider before local and Navidrome', () => {
        const providers = ['netease', 'kugou', 'qq', 'bodian', 'qishui'].map(id => provider(id));
        expect(resolveSearchSources(providers, () => capabilities(true))).toEqual<SearchSource[]>([
            'all',
            'netease',
            'kugou',
            'qq',
            'bodian',
            'qishui',
            'local',
            'navidrome',
        ]);
    });

    it('skips providers that are unconfigured or cannot search, keeping registry order', () => {
        const providers = [
            provider('netease', false),
            provider('kugou'),
            provider('qq'),
            provider('qishui'),
        ];
        const searchable: Record<string, boolean> = {
            netease: true,
            kugou: false,
            qq: true,
            qishui: true,
        };
        expect(collectOnlineSearchSources(providers, id => capabilities(searchable[id] ?? false))).toEqual([
            'qq',
            'qishui',
        ]);
        expect(resolveSearchSources(providers, id => capabilities(searchable[id] ?? false))).toEqual<SearchSource[]>([
            'all',
            'qq',
            'qishui',
            'local',
            'navidrome',
        ]);
    });
});
