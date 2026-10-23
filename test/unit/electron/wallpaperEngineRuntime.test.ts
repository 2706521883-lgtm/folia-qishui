import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

// test/unit/electron/wallpaperEngineRuntime.test.ts
// Locks the Wallpaper Engine side-car runtime's pure surface: the openWallpaper / applyProperties
// argument builders, the mute-property sanitiser, playback-size clamping, the window title seed and
// the mute retry schedule. Nothing here spawns wallpaper64.exe, so it runs on any host.

const require = createRequire(import.meta.url);
const {
  CONTROL_PROBE_ARGS,
  ENGINE_SIGNER_PATTERN,
  MUTE_SCHEDULE_MS,
  ORPHAN_WATCH_INTERVAL_MS,
  WALLPAPER_ENGINE_LOCATION_PREFIX,
  WINDOW_LOST_GRACE_MS,
  WINDOW_WATCH_INTERVAL_MS,
  buildApplyPropertiesArgs,
  buildLocationTitle,
  buildOpenWallpaperArgs,
  buildVerbatimControlInvocation,
  buildWallpaperEngineCaptureSource,
  clampPlaybackSize,
  quoteWindowsArgument,
  sanitizeMuteProperties,
} = require('../../../electron/wallpaperEngineRuntime.cjs') as {
  CONTROL_PROBE_ARGS: string[];
  ENGINE_SIGNER_PATTERN: RegExp;
  MUTE_SCHEDULE_MS: number[];
  ORPHAN_WATCH_INTERVAL_MS: number;
  WALLPAPER_ENGINE_LOCATION_PREFIX: string;
  WINDOW_LOST_GRACE_MS: number;
  WINDOW_WATCH_INTERVAL_MS: number;
  buildApplyPropertiesArgs: (input: { locationTitle: string; properties: unknown }) => string[];
  buildLocationTitle: (seed: unknown) => string;
  buildOpenWallpaperArgs: (input: Record<string, unknown>) => string[];
  buildWallpaperEngineCaptureSource: (input?: { hwnd?: unknown; title?: unknown }) => { id: string; name: string } | null;
  buildVerbatimControlInvocation: (executable: string, args: string[]) => {
    file: string;
    args: string[];
    cwd: string;
  } | null;
  clampPlaybackSize: (value: unknown, fallback: number) => number;
  quoteWindowsArgument: (value: unknown) => string;
  sanitizeMuteProperties: (properties: unknown) => Record<string, unknown>;
};

const {
  PARK_TOLERANCE_PX,
  SWP_FLAGS,
  WALLPAPER_ENGINE_PROCESS_NAMES,
  WINDOW_HELPER_SCRIPT,
  WINDOW_WAIT_DEFAULT_MS,
  encodePowerShellCommand,
  parseWindowHelperOutput,
} = require('../../../electron/wallpaperEngineWindow.cjs') as {
  PARK_TOLERANCE_PX: number;
  SWP_FLAGS: number;
  WALLPAPER_ENGINE_PROCESS_NAMES: string[];
  WINDOW_HELPER_SCRIPT: string;
  WINDOW_WAIT_DEFAULT_MS: number;
  encodePowerShellCommand: (script: unknown) => string;
  parseWindowHelperOutput: (stdout: unknown) => Record<string, unknown> | null;
};

describe('wallpaperEngineRuntime', () => {
    describe('buildLocationTitle', () => {
        it('keeps the seed alphanumeric and never repeats a title', () => {
            const first = buildLocationTitle('3F2A-bc91 xx');
            expect(first.startsWith('Folia Wallpaper 3f2abc91xx')).toBe(true);
            expect(first).toBe(first.replace(/[^A-Za-z0-9 ]/g, ''));

            const titles = new Set(Array.from({ length: 32 }, () => buildLocationTitle('seed')));
            expect(titles.size).toBe(32);
        });

        it('falls back to a session token for a missing seed', () => {
            expect(buildLocationTitle('')).toContain('Folia Wallpaper session');
            expect(buildLocationTitle(undefined)).toContain('Folia Wallpaper session');
        });

        it('uses the shared prefix that orphan cleanup scans for', () => {
            const title = buildLocationTitle('3F2A-bc91 xx');
            expect(title.startsWith(WALLPAPER_ENGINE_LOCATION_PREFIX)).toBe(true);
            expect(WALLPAPER_ENGINE_LOCATION_PREFIX).toBe('Folia Wallpaper ');
        });
    });

    describe('window watch contract', () => {
        it('polls well before the lost grace period', () => {
            expect(WINDOW_WATCH_INTERVAL_MS).toBeGreaterThanOrEqual(250);
            expect(WINDOW_WATCH_INTERVAL_MS).toBeLessThanOrEqual(2000);
            expect(WINDOW_LOST_GRACE_MS).toBeGreaterThanOrEqual(WINDOW_WATCH_INTERVAL_MS * 4);
        });

        it('keeps the session-independent orphan scan cheap but responsive', () => {
            expect(ORPHAN_WATCH_INTERVAL_MS).toBeGreaterThanOrEqual(2000);
            expect(ORPHAN_WATCH_INTERVAL_MS).toBeLessThanOrEqual(15000);
        });
    });

    describe('clampPlaybackSize', () => {
        it('keeps sane sizes and clamps out-of-range ones', () => {
            expect(clampPlaybackSize(1920, 1080)).toBe(1920);
            expect(clampPlaybackSize(120, 1080)).toBe(480);
            expect(clampPlaybackSize(9000, 1080)).toBe(3840);
            expect(clampPlaybackSize(1919.6, 1080)).toBe(1920);
        });

        it('uses the fallback for unparsable sizes', () => {
            expect(clampPlaybackSize(0, 1080)).toBe(1080);
            expect(clampPlaybackSize(-20, 1080)).toBe(1080);
            expect(clampPlaybackSize('abc', 1080)).toBe(1080);
            expect(clampPlaybackSize(NaN, 1080)).toBe(1080);
        });
    });

    describe('buildOpenWallpaperArgs', () => {
        it('addresses the project by file and the window by its unique title', () => {
            const args = buildOpenWallpaperArgs({
                file: 'E:\\Steam\\steamapps\\workshop\\content\\431960\\123\\project.json',
                locationTitle: 'Folia Wallpaper abc123def456',
                width: 1920.4,
                height: 1080,
                x: -1919,
                y: 0,
            });

            expect(args.slice(0, 2)).toEqual(['-control', 'openWallpaper']);
            // The engine must create a framed window: WGC refuses a window created borderless.
            // The window manager strips the frame right after creation instead.
            expect(args).not.toContain('-borderless');
            expect(args[args.indexOf('-playInWindow') + 1]).toBe('Folia Wallpaper abc123def456');
            expect(args[args.indexOf('-width') + 1]).toBe('1920');
            expect(args[args.indexOf('-height') + 1]).toBe('1080');
            expect(args[args.indexOf('-x') + 1]).toBe('-1919');
            expect(args[args.indexOf('-y') + 1]).toBe('0');
        });
    });

    describe('buildWallpaperEngineCaptureSource', () => {
        it('addresses the parked window by handle, without desktopCapturer enumeration', () => {
            expect(buildWallpaperEngineCaptureSource({ hwnd: '656038', title: 'Folia Wallpaper abc' }))
                .toEqual({ id: 'window:656038:0', name: 'Folia Wallpaper abc' });
            expect(buildWallpaperEngineCaptureSource({ hwnd: 1900906, title: 't' }))
                .toEqual({ id: 'window:1900906:0', name: 't' });
        });

        it('returns null until a real handle is known, so the caller can enumerate by title', () => {
            expect(buildWallpaperEngineCaptureSource({ hwnd: '', title: 't' })).toBeNull();
            expect(buildWallpaperEngineCaptureSource({ hwnd: 0, title: 't' })).toBeNull();
            expect(buildWallpaperEngineCaptureSource({ hwnd: -1, title: 't' })).toBeNull();
            expect(buildWallpaperEngineCaptureSource({ hwnd: 'abc', title: 't' })).toBeNull();
            expect(buildWallpaperEngineCaptureSource()).toBeNull();
        });
    });

    describe('sanitizeMuteProperties', () => {
        it('keeps finite numbers, booleans and short strings only', () => {
            expect(sanitizeMuteProperties({
                volume: 0,
                muteaudio: true,
                music: '0',
                nested: { deep: 1 },
                list: [1, 2],
                infinite: Number.POSITIVE_INFINITY,
                empty: null,
                long: 'x'.repeat(300),
            })).toEqual({ volume: 0, muteaudio: true, music: '0' });
        });

        it('drops unsafe keys even when they arrive as own properties', () => {
            const properties = JSON.parse('{"__proto__": 0, "con": 1, "not a key": 2, "constructor": 3}');
            expect(sanitizeMuteProperties(properties)).toEqual({ con: 1 });
            expect(Object.getPrototypeOf(sanitizeMuteProperties(properties))).toBe(Object.prototype);
        });

        it('returns an empty patch for non-object input', () => {
            expect(sanitizeMuteProperties(null)).toEqual({});
            expect(sanitizeMuteProperties([])).toEqual({});
            expect(sanitizeMuteProperties('volume=0')).toEqual({});
        });
    });

    describe('buildApplyPropertiesArgs', () => {
        it('wraps the patch in the engine RAW envelope', () => {
            const args = buildApplyPropertiesArgs({
                locationTitle: 'Folia Wallpaper abc123',
                properties: { volume: 0, muteaudio: true },
            });

            expect(args.slice(0, 2)).toEqual(['-control', 'applyProperties']);
            expect(args[args.indexOf('-properties') + 1]).toBe('RAW~({"volume":0,"muteaudio":true})~END');
            expect(args[args.indexOf('-location') + 1]).toBe('Folia Wallpaper abc123');
        });

        it('still emits a valid envelope when every property is rejected', () => {
            const args = buildApplyPropertiesArgs({ locationTitle: 't', properties: { 'bad key': 1 } });
            expect(args[args.indexOf('-properties') + 1]).toBe('RAW~({})~END');
        });
    });

    describe('quoteWindowsArgument', () => {
        it('leaves bare words alone and quotes anything with a space or a quote', () => {
            expect(quoteWindowsArgument('-control')).toBe('-control');
            expect(quoteWindowsArgument('RAW~({"volume":0})~END')).toBe('"RAW~({\\"volume\\":0})~END"');
            expect(quoteWindowsArgument('Folia Wallpaper abc123')).toBe('"Folia Wallpaper abc123"');
            expect(quoteWindowsArgument(undefined)).toBe('""');
            expect(quoteWindowsArgument('unquoted\\path\\')).toBe('unquoted\\path\\');
            expect(quoteWindowsArgument('C:\\dir with space\\')).toBe('"C:\\dir with space\\\\"');
        });
    });

    describe('buildVerbatimControlInvocation', () => {
        const executable = 'E:\\steam\\steamapps\\common\\wallpaper_engine\\wallpaper64.exe';

        it('hands the RAW payload through untouched and quotes every other argument', () => {
            // The engine parses the payload out of the raw command line: Node's default escaping
            // turns its quotes into \" and the engine answers with exit code 4.
            const payload = 'RAW~({"volume":0,"muteaudio":true})~END';
            const args = ['-control', 'applyProperties', '-properties', payload, '-location', 'Folia Wallpaper abc123'];

            expect(buildVerbatimControlInvocation(executable, args)).toEqual({
                file: executable,
                args: ['-control', 'applyProperties', '-properties', payload, '-location', '"Folia Wallpaper abc123"'],
                cwd: 'E:\\steam\\steamapps\\common\\wallpaper_engine',
            });
        });

        it('leaves commands without a payload on the ordinary encoding', () => {
            expect(buildVerbatimControlInvocation(executable, ['-control', 'closeWallpaper', '-location', 't'])).toBeNull();
            expect(buildVerbatimControlInvocation(executable, CONTROL_PROBE_ARGS)).toBeNull();
            expect(buildVerbatimControlInvocation(executable, ['-control', 'applyProperties', '-properties', '{"volume":0}'])).toBeNull();
            expect(buildVerbatimControlInvocation(executable, ['-control', 'applyProperties', '-properties', 'RAW~({"volume":0})'])).toBeNull();
        });
    });

    describe('engine contract constants', () => {
        it('probes the control channel with getWallpaper', () => {
            expect(CONTROL_PROBE_ARGS).toEqual(['-control', 'getWallpaper', '-monitor', '0']);
        });

        it('recognises the Skutta Software signer', () => {
            expect(ENGINE_SIGNER_PATTERN.test('CN="Skutta Software GmbH", O="Skutta Software GmbH"')).toBe(true);
            expect(ENGINE_SIGNER_PATTERN.test('CN=Someone Else')).toBe(false);
        });

        it('re-asserts the mute in a monotonically spreading schedule', () => {
            expect(MUTE_SCHEDULE_MS[0]).toBe(0);
            expect(MUTE_SCHEDULE_MS.at(-1)).toBe(12200);
            expect(MUTE_SCHEDULE_MS.length).toBe(13);
            for (let index = 1; index < MUTE_SCHEDULE_MS.length; index += 1) {
                expect(MUTE_SCHEDULE_MS[index]).toBeGreaterThan(MUTE_SCHEDULE_MS[index - 1]);
            }
        });
    });
});

describe('wallpaperEngineWindow', () => {
    describe('park recipe', () => {
        it('keeps the window size, order and activation untouched', () => {
            expect(SWP_FLAGS).toBe(0x0004 | 0x0010 | 0x0200 | 0x0400);
            // SWP_NOSIZE would be a no-op here, but passing 0×0 without it shrinks the window and the
            // capture would come back empty — the call has to keep the size it measured.
            expect(SWP_FLAGS & 0x0001).toBe(0);
            expect(WINDOW_HELPER_SCRIPT).toMatch(/SetWindowPos\(\$hwnd, \[IntPtr\]::Zero, \$targetX, \$targetY, \$before\.width, \$before\.height, \d+\)/);
            expect(WINDOW_HELPER_SCRIPT).toContain('GetSystemMetrics(76)');
            expect(WINDOW_HELPER_SCRIPT).toContain('GetSystemMetrics(79)');
        });

        it('polls for the window the engine creates asynchronously', () => {
            // openWallpaper returns before the popout window exists: a one-shot lookup loses the race.
            expect(WINDOW_WAIT_DEFAULT_MS).toBeGreaterThan(1000);
            expect(WINDOW_HELPER_SCRIPT).toContain('FindByExactTitle');
            expect(WINDOW_HELPER_SCRIPT).toContain('$env:FOLIA_WE_WINDOW_WAIT_MS');
            expect(WINDOW_HELPER_SCRIPT).toContain('Start-Sleep -Milliseconds');
            // The lookup must enumerate and compare ordinally, never fall back to FindWindow.
            expect(WINDOW_HELPER_SCRIPT).not.toContain('FindWindow(');
            expect(PARK_TOLERANCE_PX).toBe(2);
        });

        it('only ever moves a window owned by the engine', () => {
            expect(WALLPAPER_ENGINE_PROCESS_NAMES).toEqual(['wallpaper64', 'wallpaper32']);
            expect(WINDOW_HELPER_SCRIPT).toContain('foreign-process');
        });
    });

    describe('encodePowerShellCommand', () => {
        it('round-trips a script through UTF-16LE base64', () => {
            const script = "$x = 'a \"quoted\" title 音量'\r\nWrite-Output $x";
            const encoded = encodePowerShellCommand(script);
            expect(encoded).not.toMatch(/[^A-Za-z0-9+/=]/);
            expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe(script);
        });
    });

    describe('parseWindowHelperOutput', () => {
        it('reads the last JSON object and ignores surrounding noise', () => {
            const stdout = [
                'Add-Type: warning',
                '{"ok":false,"reason":"not-found"}',
                '{"ok":true,"hwnd":66012,"moved":true,"target":{"x":3839,"y":1079}}',
                '',
            ].join('\r\n');

            expect(parseWindowHelperOutput(stdout)).toEqual({
                ok: true,
                hwnd: 66012,
                moved: true,
                target: { x: 3839, y: 1079 },
            });
        });

        it('skips malformed lines and returns null when nothing parses', () => {
            expect(parseWindowHelperOutput('{"ok":true,')).toBeNull();
            expect(parseWindowHelperOutput('noise\n[1,2,3]')).toBeNull();
            expect(parseWindowHelperOutput('')).toBeNull();
            expect(parseWindowHelperOutput(undefined)).toBeNull();
        });
    });
});
