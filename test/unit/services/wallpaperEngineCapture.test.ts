import { afterEach, describe, expect, it, vi } from 'vitest';

// 当前文件：验证壁纸引擎采集流在「切换歌词样式导致背景层重挂载」时不会被关掉重开——
// 重挂载必须复用原流（否则会退回低清预览图，画面模糊一下）；最后一个消费者放手后才在宽限期结束后真正停止。

interface FakeTrack {
    kind: string;
    readyState: 'live' | 'ended';
    stop: () => void;
    addEventListener: (type: string, listener: () => void) => void;
}

interface FakeStream {
    id: number;
    getTracks: () => FakeTrack[];
    getVideoTracks: () => FakeTrack[];
}

let streamSeq = 0;
const created: FakeStream[] = [];

const makeStream = (): FakeStream => {
    const track: FakeTrack = {
        kind: 'video',
        readyState: 'live',
        stop: vi.fn(() => { track.readyState = 'ended'; }),
        addEventListener: vi.fn(),
    };
    const stream: FakeStream = {
        id: (streamSeq += 1),
        getTracks: () => [track],
        getVideoTracks: () => [track],
    };
    created.push(stream);
    return stream;
};

const getUserMedia = vi.fn(async () => makeStream());

const loadService = async () => {
    vi.resetModules();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    return import('../../../src/services/wallpaperEngineCapture');
};

const trackOf = (stream: unknown) => (stream as FakeStream).getVideoTracks()[0];

describe('wallpaperEngineCapture', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
        created.length = 0;
    });

    it('opens one stream and hands it back unchanged while it is still cached', async () => {
        const service = await loadService();

        const first = await service.acquireWallpaperEngineCapture({ sourceId: 'window:42:0', frameRate: 30 });
        expect(getUserMedia).toHaveBeenCalledTimes(1);
        expect(service.hasLiveWallpaperEngineCapture(30)).toBe(true);

        service.releaseWallpaperEngineCapture(first);
        // A lyric style switch: the layer unmounts and mounts again within the grace period.
        const second = await service.acquireWallpaperEngineCapture({ sourceId: 'window:42:0', frameRate: 30 });

        expect(second).toBe(first);
        expect(getUserMedia).toHaveBeenCalledTimes(1);
        expect(trackOf(first).readyState).toBe('live');
    });

    it('keeps the stream open through the grace period and stops it afterwards', async () => {
        vi.useFakeTimers();
        const service = await loadService();

        const stream = await service.acquireWallpaperEngineCapture({ sourceId: 'window:42:0', frameRate: 30 });
        service.releaseWallpaperEngineCapture(stream);

        // Leaving the mode must not keep capturing forever: nothing adopted it, so the grace runs out.
        expect(trackOf(stream).readyState).toBe('live');
        await vi.advanceTimersByTimeAsync(3000);
        expect(trackOf(stream).readyState).toBe('ended');
        expect(service.hasLiveWallpaperEngineCapture(30)).toBe(false);
    });

    it('keeps the capture alive while another consumer still presents it', async () => {
        vi.useFakeTimers();
        const service = await loadService();

        const stream = await service.acquireWallpaperEngineCapture({ sourceId: 'window:42:0', frameRate: 30 });
        // Two layers can show the same session (main player + settings preview); one leaving is not
        // the end of the capture.
        const shared = await service.acquireWallpaperEngineCapture({ sourceId: 'window:42:0', frameRate: 30 });
        expect(shared).toBe(stream);

        service.releaseWallpaperEngineCapture(stream);
        await vi.advanceTimersByTimeAsync(3000);
        expect(trackOf(stream).readyState).toBe('live');

        service.releaseWallpaperEngineCapture(shared);
        await vi.advanceTimersByTimeAsync(3000);
        expect(trackOf(stream).readyState).toBe('ended');
    });

    it('reopens the capture when the frame rate changes (it is a getUserMedia constraint)', async () => {
        const service = await loadService();

        const stream = await service.acquireWallpaperEngineCapture({ sourceId: 'window:42:0', frameRate: 30 });
        const faster = await service.acquireWallpaperEngineCapture({ sourceId: 'window:42:0', frameRate: 60 });

        expect(faster).not.toBe(stream);
        expect(getUserMedia).toHaveBeenCalledTimes(2);
        expect(trackOf(stream).readyState).toBe('ended');
        expect(service.hasLiveWallpaperEngineCapture(30)).toBe(false);
        expect(service.hasLiveWallpaperEngineCapture(60)).toBe(true);
    });

    it('stops a stream that is not the cached one straight away', async () => {
        const service = await loadService();

        await service.acquireWallpaperEngineCapture({ sourceId: 'window:42:0', frameRate: 30 });
        const foreign = makeStream() as unknown as MediaStream;
        service.releaseWallpaperEngineCapture(foreign);

        expect(trackOf(foreign).readyState).toBe('ended');
        expect(service.hasLiveWallpaperEngineCapture(30)).toBe(true);
    });

    it('tolerates a null release and reports no capture before the first acquire', async () => {
        const service = await loadService();

        expect(service.hasLiveWallpaperEngineCapture()).toBe(false);
        expect(service.hasLiveWallpaperEngineCapture(30)).toBe(false);
        expect(() => service.releaseWallpaperEngineCapture(null)).not.toThrow();
    });
});
