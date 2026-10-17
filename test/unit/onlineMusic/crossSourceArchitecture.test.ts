import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

// test/unit/onlineMusic/crossSourceArchitecture.test.ts

const CROSS_SOURCE_SERVICES = [
    'src/services/onlineMusic/federatedSearch.ts',
    'src/services/onlineMusic/crossSourceFallback.ts',
];

const FORBIDDEN_IMPORT = /from\s+['"][^'"]*(providerRegistry|kugouTransport|qqTransport|qishuiTransport|bodianTransport|neteaseProvider|kugouProvider|qqProvider|qishuiProvider|bodianProvider|services\/netease|services\/kugou)['"]/;

describe('cross-source architecture boundaries', () => {
    it('keeps provider internals out of the cross-source orchestrators', async () => {
        const violations: string[] = [];

        for (const file of CROSS_SOURCE_SERVICES) {
            const source = await readFile(file, 'utf8');
            if (FORBIDDEN_IMPORT.test(source)) {
                violations.push(file);
            }
        }

        expect(violations).toEqual([]);
    });

    it('uses Omni provider-explicit search instead of the active-provider search API', async () => {
        const source = await readFile('src/services/onlineMusic/federatedSearch.ts', 'utf8');

        expect(source).toMatch(/from '\.\/omni'/);
        expect(source).toMatch(/omni\.searchProviderSongs\(/);
        expect(source).not.toMatch(/omni\.searchSongs\(/);
        expect(source).not.toMatch(/getProviderRegistry|listOnlineMusicProviders/);
    });

    it('evaluates fallback candidates only through Omni availability checks', async () => {
        const source = await readFile('src/services/onlineMusic/crossSourceFallback.ts', 'utf8');

        expect(source).toMatch(/from '\.\/omni'/);
        expect(source).toMatch(/omni\.getSongAvailability\(/);
        expect(source).not.toMatch(/from '\.\/providerRegistry'/);
    });
});
