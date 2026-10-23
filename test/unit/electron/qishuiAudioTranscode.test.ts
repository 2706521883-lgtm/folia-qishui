import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';
import { createServer } from 'http';
import { EventEmitter } from 'events';
import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(import.meta.url);
const {
    buildCacheKey,
    createAudioTranscoder,
    hasEncoder,
    looksLikeMp3,
    parseRangeHeader,
    resolveMp3Ffmpeg,
} = require('../../../electron/qishui-audio-transcode.cjs') as typeof import('../../../electron/qishui-audio-transcode.cjs');

const dirs: string[] = [];
const makeDir = () => {
    const dir = mkdtempSync(join(tmpdir(), 'qishui-transcode-'));
    dirs.push(dir);
    return dir;
};

afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

// ---------------------------------------------------------------- 缓存 key

describe('buildCacheKey', () => {
    const base = 'https://v11-luna.douyinvod.com/cc69/6ad2/video/tos/oMiWAS/';

    it('同一首歌同一质量的重复请求落在同一个 key 上', () => {
        // 直链 query 里的 a/qs/btag 每次都会换，带上就永远不命中——这正是 key 只看 host+path 的原因。
        const first = buildCacheKey(base + '?a=1111&qs=aaaa&btag=x');
        const second = buildCacheKey(base + '?a=2222&qs=bbbb&btag=y');
        expect(second).toBe(first);
        expect(first).toMatch(/^[0-9a-f]{64}$/);
    });

    it('不同路径、不同主机各算各的', () => {
        expect(buildCacheKey(base + '?a=1')).not.toBe(buildCacheKey('https://v11-luna.douyinvod.com/other/?a=1'));
        expect(buildCacheKey(base + '?a=1')).not.toBe(buildCacheKey('https://v26-luna.douyinvod.com/cc69/6ad2/video/tos/oMiWAS/?a=1'));
    });

    it('换码率/换格式要换 key，否则会把 128k 的缓存当成 320k 的用', () => {
        const other = buildCacheKey(base, { bitrate: '320k' });
        expect(other).not.toBe(buildCacheKey(base));
    });
});

// ---------------------------------------------------------------- Range

describe('parseRangeHeader', () => {
    const size = 1000;

    it('没带 Range 或不是单区间就整段 200', () => {
        for (const header of ['', undefined, 'items=0-10', 'bytes=0-1,5-6', 'bytes=abc-def']) {
            expect(parseRangeHeader(header as never, size)).toBeNull();
        }
    });

    it('bytes=0- 一直到最后，bytes=10-19 就是那十个字节', () => {
        expect(parseRangeHeader('bytes=0-', size)).toEqual({ start: 0, end: 999 });
        expect(parseRangeHeader('bytes=10-19', size)).toEqual({ start: 10, end: 19 });
    });

    it('bytes=-200 是最后两百字节', () => {
        expect(parseRangeHeader('bytes=-200', size)).toEqual({ start: 800, end: 999 });
        // 比整个文件还长的后缀 = 整段
        expect(parseRangeHeader('bytes=-5000', size)).toEqual({ start: 0, end: 999 });
    });

    it('尾巴超出文件就夹到末尾，起点越界才 416', () => {
        expect(parseRangeHeader('bytes=990-5000', size)).toEqual({ start: 990, end: 999 });
        expect(parseRangeHeader('bytes=1000-', size)).toEqual({ invalid: true });
        expect(parseRangeHeader('bytes=500-100', size)).toEqual({ invalid: true });
        expect(parseRangeHeader('bytes=-0', size)).toEqual({ invalid: true });
        expect(parseRangeHeader('bytes=0-', 0)).toEqual({ invalid: true });
    });
});

// ---------------------------------------------------------------- ffmpeg 探测

const ENCODERS_OUTPUT = [
    'Encoders:',
    ' V..... = Video',
    ' A....D flac                 FLAC (Free Lossless Audio Codec)',
    ' A....D libmp3lame           libmp3lame MP3 (MPEG audio layer 3)',
].join('\n');

describe('hasEncoder', () => {
    it('按词边界认，别让名字只沾了个边的东西混进来', () => {
        expect(hasEncoder(ENCODERS_OUTPUT, 'libmp3lame')).toBe(true);
        expect(hasEncoder(ENCODERS_OUTPUT, 'flac')).toBe(true);
        expect(hasEncoder(ENCODERS_OUTPUT, 'libmp3lame2')).toBe(false);
        expect(hasEncoder(' A....D mp3_mf  MP3 via MediaFoundation', 'libmp3lame')).toBe(false);
    });
});

describe('resolveMp3Ffmpeg', () => {
    // The resolver probes the platform's PATH command name; keep the stub and expectation in sync.
    const pathFfmpeg = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
    const execFileStub = (table: Record<string, string | null>) => (
        command: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout?: string, stderr?: string) => void,
    ) => {
        const output = table[command];
        if (output === undefined || output === null) callback(new Error('ENOENT'), '', '');
        else callback(null, output, '');
    };

    it('QISHUI_SERVER_FFMPEG 指的那台能用就用它', async () => {
        const resolved = await resolveMp3Ffmpeg({
            env: { QISHUI_SERVER_FFMPEG: 'D:/tools/ffmpeg.exe' },
            execFileImpl: execFileStub({ 'D:/tools/ffmpeg.exe': ENCODERS_OUTPUT, [pathFfmpeg]: ENCODERS_OUTPUT }),
        });
        expect(resolved).toEqual({ path: 'D:/tools/ffmpeg.exe', source: 'QISHUI_SERVER_FFMPEG' });
    });

    it('指定的那台编不了 MP3 就退到 PATH 上的 ffmpeg', async () => {
        // 仓库随包的 ffmpeg-audio 就是这种：只编 FLAC/WAV，只探 -version 的话看着完全健康。
        const flacOnly = ' A....D flac  FLAC';
        const resolved = await resolveMp3Ffmpeg({
            env: { QISHUI_SERVER_FFMPEG: 'D:/bundled/ffmpeg.exe' },
            execFileImpl: execFileStub({ 'D:/bundled/ffmpeg.exe': flacOnly, [pathFfmpeg]: ENCODERS_OUTPUT }),
        });
        expect(resolved).toEqual({ path: pathFfmpeg, source: 'PATH' });
    });

    it('都编不了就老实返回 null（调用方原样回退 AAC）', async () => {
        const resolved = await resolveMp3Ffmpeg({
            env: {},
            execFileImpl: execFileStub({ [pathFfmpeg]: ' A....D flac  FLAC' }),
        });
        expect(resolved).toBeNull();
    });
});

describe('looksLikeMp3', () => {
    it('认 ID3 头，也认裸帧同步', () => {
        expect(looksLikeMp3(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200)]))).toBe(true);
        expect(looksLikeMp3(Buffer.concat([Buffer.from([0xff, 0xfb, 0x90]), Buffer.alloc(200)]))).toBe(true);
    });

    it('不是 mp3 的一律不认', () => {
        expect(looksLikeMp3(Buffer.from('00000'))).toBe(false);
        expect(looksLikeMp3(Buffer.alloc(0))).toBe(false);
        expect(looksLikeMp3(undefined as never)).toBe(false);
    });
});

// ---------------------------------------------------------------- 端到端（本地 http + 假 ffmpeg）

const MP3_BYTES = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4096, 0x11)]);
const SOURCE_BYTES = Buffer.alloc(2048, 0x22);

const startSourceServer = async () => {
    const server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'audio/mp4', 'Content-Length': String(SOURCE_BYTES.length) });
        res.end(SOURCE_BYTES);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    return { url: `http://127.0.0.1:${port}/decrypted?token=1`, close: () => new Promise<void>(r => server.close(() => r())) };
};

const makeTranscoder = (cacheDir: string, spawnCount: { value: number }, extra: Record<string, unknown> = {}) => createAudioTranscoder({
    cacheDir,
    maxBytes: 1024 * 1024,
    log: () => {},
    execFileImpl: (_command: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout?: string) => void) => {
        callback(null, ' A....D libmp3lame  MP3');
    },
    spawnImpl: (command: string, args: string[]) => {
        spawnCount.value += 1;
        const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => void };
        child.stderr = new EventEmitter();
        child.kill = () => {};
        // 真 ffmpeg 的职责：把输出文件写出来再以 0 退出。
        setImmediate(() => {
            const outputPath = args[args.length - 1];
            writeFileSync(outputPath, MP3_BYTES);
            child.emit('close', 0);
        });
        return child;
    },
    ...extra,
});

describe('createAudioTranscoder', () => {
    it('转一次、落缓存，第二次直接命中且不再叫 ffmpeg', async () => {
        const cacheDir = makeDir();
        const source = await startSourceServer();
        const spawnCount = { value: 0 };
        const transcoder = makeTranscoder(cacheDir, spawnCount);
        try {
            await transcoder.init();
            expect(transcoder.isEnabled()).toBe(true);
            const first = await transcoder.ensure(source.url, source.url);
            expect(first.cached).toBe(false);
            expect(readFileSync(first.path).equals(MP3_BYTES)).toBe(true);

            const second = await transcoder.ensure(source.url, source.url);
            expect(second).toEqual({ path: first.path, size: MP3_BYTES.length, cached: true });
            expect(spawnCount.value).toBe(1);
            // 中间产物（.part.*）不许留在缓存目录里
            expect(readdirSync(cacheDir).filter(name => name.includes('.part'))).toEqual([]);
        } finally {
            await source.close();
        }
    });

    it('同时来两个请求也只转一次', async () => {
        const cacheDir = makeDir();
        const source = await startSourceServer();
        const spawnCount = { value: 0 };
        const transcoder = makeTranscoder(cacheDir, spawnCount);
        try {
            await transcoder.init();
            const [left, right] = await Promise.all([
                transcoder.ensure(source.url, source.url),
                transcoder.ensure(source.url, source.url),
            ]);
            expect(spawnCount.value).toBe(1);
            expect(left.path).toBe(right.path);
        } finally {
            await source.close();
        }
    });

    it('ffmpeg 挂了就抛错（服务器据此回退原样 AAC），缓存目录不留垃圾', async () => {
        const cacheDir = makeDir();
        const source = await startSourceServer();
        const spawnCount = { value: 0 };
        const transcoder = createAudioTranscoder({
            cacheDir,
            log: () => {},
            execFileImpl: (_c: string, _a: string[], _o: unknown, cb: (error: Error | null, stdout?: string) => void) => cb(null, ' A....D libmp3lame  MP3'),
            spawnImpl: () => {
                spawnCount.value += 1;
                const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => void };
                child.stderr = new EventEmitter();
                child.kill = () => {};
                setImmediate(() => {
                    child.stderr.emit('data', 'Invalid data found when processing input');
                    child.emit('close', 1);
                });
                return child;
            },
        });
        try {
            await transcoder.init();
            await expect(transcoder.ensure(source.url, source.url)).rejects.toThrow(/退出码 1/);
            expect(readdirSync(cacheDir)).toEqual([]);
        } finally {
            await source.close();
        }
    });

    it('产物太小（半截文件）当失败，不缓存', async () => {
        const cacheDir = makeDir();
        const source = await startSourceServer();
        const transcoder = createAudioTranscoder({
            cacheDir,
            log: () => {},
            execFileImpl: (_c: string, _a: string[], _o: unknown, cb: (error: Error | null, stdout?: string) => void) => cb(null, ' A....D libmp3lame  MP3'),
            spawnImpl: (_c: string, args: string[]) => {
                const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => void };
                child.stderr = new EventEmitter();
                child.kill = () => {};
                setImmediate(() => {
                    writeFileSync(args[args.length - 1], Buffer.from('ID3'));
                    child.emit('close', 0);
                });
                return child;
            },
        });
        try {
            await transcoder.init();
            await expect(transcoder.ensure(source.url, source.url)).rejects.toThrow(/不像 MP3/);
            expect(readdirSync(cacheDir)).toEqual([]);
        } finally {
            await source.close();
        }
    });

    it('缓存超上限时按最近播放时间淘汰', async () => {
        const cacheDir = makeDir();
        const source = await startSourceServer();
        const spawnCount = { value: 0 };
        // 上限只够放一条：第二条进来时，第一条（更久没被碰过）要被淘汰。
        const transcoder = makeTranscoder(cacheDir, spawnCount, { maxBytes: MP3_BYTES.length + 10 });
        try {
            await transcoder.init();
            const older = await transcoder.ensure(source.url, 'https://v11-luna.douyinvod.com/a/?t=1');
            await transcoder.ensure(source.url, 'https://v11-luna.douyinvod.com/b/?t=1');
            await vi.waitFor(() => {
                expect(existsSync(older.path)).toBe(false);
            });
            expect(readdirSync(cacheDir).length).toBe(1);
        } finally {
            await source.close();
        }
    });

    it('isEnabled 在没探到 ffmpeg 时为 false，ensure 直接抛（服务器据此走原样直通）', async () => {
        const cacheDir = makeDir();
        const transcoder = createAudioTranscoder({
            cacheDir,
            log: () => {},
            execFileImpl: (_c: string, _a: string[], _o: unknown, cb: (error: Error | null, stdout?: string) => void) => cb(new Error('ENOENT'), ''),
        });
        await transcoder.init();
        expect(transcoder.isEnabled()).toBe(false);
        await expect(transcoder.ensure('http://127.0.0.1:1/x', 'http://127.0.0.1:1/x')).rejects.toThrow(/不可用/);
    });
});

describe('transcoder.serve', () => {
    const withServer = async (handler: (req: unknown, res: unknown) => void) => {
        const server = createServer(handler as never);
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const { port } = server.address() as { port: number };
        return { url: `http://127.0.0.1:${port}/x`, close: () => new Promise<void>(r => server.close(() => r())) };
    };

    it('整段 200、带 Range 206、越界 416、HEAD 有长度没 body，全都 audio/mpeg', async () => {
        const cacheDir = makeDir();
        const source = await startSourceServer();
        const spawnCount = { value: 0 };
        const transcoder = makeTranscoder(cacheDir, spawnCount);
        try {
            await transcoder.init();
            const entry = await transcoder.ensure(source.url, source.url);
            const server = await withServer((req, res) => { void transcoder.serve(req, res, entry.path, {}); });

            const full = await fetch(server.url);
            expect(full.status).toBe(200);
            expect(full.headers.get('content-type')).toBe('audio/mpeg');
            expect(full.headers.get('accept-ranges')).toBe('bytes');
            expect(full.headers.get('content-length')).toBe(String(MP3_BYTES.length));
            expect(Buffer.from(await full.arrayBuffer()).equals(MP3_BYTES)).toBe(true);

            const partial = await fetch(server.url, { headers: { Range: 'bytes=100-199' } });
            expect(partial.status).toBe(206);
            expect(partial.headers.get('content-range')).toBe(`bytes 100-199/${MP3_BYTES.length}`);
            expect((await partial.arrayBuffer()).byteLength).toBe(100);

            const bad = await fetch(server.url, { headers: { Range: 'bytes=999999-' } });
            expect(bad.status).toBe(416);
            expect(bad.headers.get('content-range')).toBe(`bytes */${MP3_BYTES.length}`);

            const head = await fetch(server.url, { method: 'HEAD' });
            expect(head.status).toBe(200);
            expect(head.headers.get('content-length')).toBe(String(MP3_BYTES.length));
            expect((await head.arrayBuffer()).byteLength).toBe(0);

            await server.close();
        } finally {
            await source.close();
        }
    });
});
