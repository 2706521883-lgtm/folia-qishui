import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

// test/unit/electron/wallpaperEngineLibrary.test.ts
// Locks the Wallpaper Engine library indexer: libraryfolders.vdf parsing, reg query parsing,
// project type normalisation, scene-package header validation and the scene audio-property
// heuristics that decide which properties get muted.

const require = createRequire(import.meta.url);
const {
  analyzeSceneProperties,
  deriveSceneMuteProperties,
  findScenePackageMagicOffset,
  isScenePackageHeaderBuffer,
  normalizeWallpaperProjectType,
  parseLibraryFoldersVdf,
  parseRegQueryValue,
  resolveSteamLibraryRoots,
  workspaceIdForPath,
} = require('../../../electron/wallpaperEngineLibrary.cjs') as {
  analyzeSceneProperties: (project: unknown) => {
    properties: Array<Record<string, unknown>>;
    muteProperties: Record<string, unknown>;
    audioPropertyCount: number;
  };
  deriveSceneMuteProperties: (project: unknown) => Record<string, unknown>;
  findScenePackageMagicOffset: (buffer: unknown) => number;
  isScenePackageHeaderBuffer: (buffer: unknown) => boolean;
  normalizeWallpaperProjectType: (value: unknown) => string;
  parseLibraryFoldersVdf: (text: unknown) => string[];
  parseRegQueryValue: (stdout: unknown, valueName: string) => string;
  resolveSteamLibraryRoots: (input: unknown) => Promise<{ steamRoots: string[]; libraryRoots: string[] }>;
  workspaceIdForPath: (projectDir: string) => string;
};

describe('wallpaperEngineLibrary', () => {
    describe('parseLibraryFoldersVdf', () => {
        it('collects every library path and drops duplicates', () => {
            const vdf = [
                '"libraryfolders"',
                '{',
                '\t"0"',
                '\t{',
                '\t\t"path"\t\t"e:\\\\steam"',
                '\t\t"label"\t\t""',
                '\t}',
                '\t"1"',
                '\t{',
                '\t\t"path"\t\t"d:\\\\games\\\\steam"',
                '\t}',
                '\t"2"',
                '\t{',
                '\t\t"path"\t\t"e:\\\\steam"',
                '\t}',
                '}',
            ].join('\n');

            expect(parseLibraryFoldersVdf(vdf)).toEqual(['e:\\steam', 'd:\\games\\steam']);
        });

        it('returns nothing for a missing or non-string body', () => {
            expect(parseLibraryFoldersVdf('')).toEqual([]);
            expect(parseLibraryFoldersVdf(null)).toEqual([]);
        });
    });

    describe('parseRegQueryValue', () => {
        it('reads the requested value out of reg query output', () => {
            const stdout = [
                '',
                'HKEY_CURRENT_USER\\Software\\Valve\\Steam',
                '    SteamPath    REG_SZ    e:/steam',
                '',
            ].join('\r\n');

            expect(parseRegQueryValue(stdout, 'SteamPath')).toBe('e:/steam');
        });

        it('ignores a different value name and an empty result', () => {
            const stdout = '    InstallPath    REG_SZ    c:/steam';
            expect(parseRegQueryValue(stdout, 'SteamPath')).toBe('');
            expect(parseRegQueryValue('', 'SteamPath')).toBe('');
        });
    });

    describe('normalizeWallpaperProjectType', () => {
        it('lowercases the type so "Scene" and "scene" behave identically', () => {
            expect(normalizeWallpaperProjectType('Scene')).toBe('scene');
            expect(normalizeWallpaperProjectType('scene')).toBe('scene');
            expect(normalizeWallpaperProjectType('Video')).toBe('video');
        });

        it('falls back to unknown for a missing type', () => {
            expect(normalizeWallpaperProjectType('')).toBe('unknown');
            expect(normalizeWallpaperProjectType(undefined)).toBe('unknown');
        });
    });

    describe('scene package headers', () => {
        it('accepts the real layout: 4-byte length prefix, then the versioned magic', () => {
            // Copied from a workshop package: `08 00 00 00` then "PKGV0005".
            const realHeader = Buffer.concat([
                Buffer.from([0x08, 0x00, 0x00, 0x00]),
                Buffer.from('PKGV0005'),
                Buffer.from([0x12, 0x00, 0x00, 0x00]),
            ]);

            expect(isScenePackageHeaderBuffer(realHeader)).toBe(true);
            expect(findScenePackageMagicOffset(realHeader)).toBe(4);
        });

        it('also tolerates the magic at offset 0, in either case', () => {
            expect(isScenePackageHeaderBuffer(Buffer.from('PKGV0001____'))).toBe(true);
            expect(isScenePackageHeaderBuffer(Buffer.from('pkgv0025____'))).toBe(true);
            expect(findScenePackageMagicOffset(Buffer.from('PKGV0001____'))).toBe(0);
        });

        it('rejects short, wrong-magic and non-buffer input', () => {
            expect(isScenePackageHeaderBuffer(Buffer.from('PKG'))).toBe(false);
            expect(isScenePackageHeaderBuffer(Buffer.from('PKGX0001____'))).toBe(false);
            expect(isScenePackageHeaderBuffer(Buffer.from('\x08\x00\x00\x00PKGV00'))).toBe(false);
            expect(isScenePackageHeaderBuffer('PKGV0001____')).toBe(false);
            expect(findScenePackageMagicOffset(null)).toBe(-1);
        });
    });

    describe('workspaceIdForPath', () => {
        it('is stable across separators and casing', () => {
            const first = workspaceIdForPath('E:\\Steam\\steamapps\\common\\x');
            const second = workspaceIdForPath('e:/steam/steamapps/common/x');
            expect(first).toBe(second);
            expect(first).toHaveLength(16);
        });
    });

    describe('resolveSteamLibraryRoots', () => {
        it('collapses spellings of the same root so nothing is scanned twice', async () => {
            const registry: Record<string, string> = {
                'HKCU\\Software\\Valve\\Steam': 'e:/steam',
                'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam': 'E:\\steam',
            };
            const execFile = (_cmd: string, args: string[], _options: unknown, callback: (error: Error | null, out: string) => void) => {
                const value = registry[args[1]];
                callback(value ? null : new Error('not found'), value ? `    ${args[3]}    REG_SZ    ${value}` : '');
            };
            const fsp = {
                readFile: async () => '"libraryfolders"\n{\n"0"\n{\n"path"\t\t"e:\\\\steam"\n}\n"1"\n{\n"path"\t\t"F:\\\\library"\n}\n}',
            };

            const { steamRoots, libraryRoots } = await resolveSteamLibraryRoots({
                fsp,
                path: require('path'),
                execFile,
            });

            expect(steamRoots).toEqual(['e:/steam']);
            expect(libraryRoots).toEqual(['e:/steam', 'F:\\library']);
        });
    });

    describe('analyzeSceneProperties', () => {
        it('always pins the generic volume property to zero', () => {
            expect(deriveSceneMuteProperties({}).volume).toBe(0);
            expect(deriveSceneMuteProperties(null).volume).toBe(0);
        });

        it('mutes an audio slider to its minimum and a decibel slider below zero', () => {
            const { muteProperties } = analyzeSceneProperties({
                general: {
                    properties: {
                        volume: { type: 'slider', text: 'Volume', value: 0.8, min: 0, max: 1 },
                        audioDb: { type: 'slider', text: '音量 (dB)', value: -12, min: -60, max: 0 },
                    },
                },
            });

            expect(muteProperties.volume).toBe(0);
            expect(muteProperties.audioDb).toBe(-60);
        });

        it('switches a mute toggle off and picks the off option of a combo', () => {
            const { muteProperties } = analyzeSceneProperties({
                general: {
                    properties: {
                        muteaudio: { type: 'bool', text: 'Mute audio', value: false },
                        music: {
                            type: 'combo',
                            text: 'Background music',
                            value: '1',
                            options: [
                                { label: 'None', value: '0' },
                                { label: 'Track 1', value: '1' },
                            ],
                        },
                    },
                },
            });

            expect(muteProperties.muteaudio).toBe(true);
            expect(muteProperties.music).toBe('0');
        });

        it('never mutes a visual property that merely mentions sound', () => {
            const { muteProperties, audioPropertyCount } = analyzeSceneProperties({
                general: {
                    properties: {
                        visualizerBars: { type: 'slider', text: 'Audio visualizer bars', value: 5, min: 0, max: 10 },
                        musicColor: { type: 'slider', text: 'Music color opacity', value: 0.5, min: 0, max: 1 },
                    },
                },
            });

            expect(audioPropertyCount).toBe(0);
            expect(muteProperties).toEqual({ volume: 0 });
        });

        it('drops unsafe property keys and out-of-shape entries', () => {
            // JSON.parse keeps `__proto__` an own key, which is the shape a hostile project.json
            // would actually produce.
            const properties = JSON.parse(`{
                "not a key": { "type": "slider", "text": "bad", "value": 1 },
                "__proto__": { "type": "slider", "text": "bad", "value": 1 },
                "constructor": { "type": "slider", "text": "bad", "value": 1 },
                "good": { "type": "slider", "text": "Good", "value": 1, "min": 0, "max": 2 },
                "no-object": "plain string"
            }`);

            const { properties: descriptors } = analyzeSceneProperties({ general: { properties } });

            expect(descriptors.map(entry => entry.key)).toEqual(['good']);
        });
    });
});
