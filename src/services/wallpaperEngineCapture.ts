// src/services/wallpaperEngineCapture.ts
// Turns the parked Wallpaper Engine playback window into a MediaStream the background layer can
// render. Uses the same legacy `chromeMediaSource: 'desktop'` path as the video exporter, so no
// display-capture permission needs to be granted to the renderer.
//
// Switching lyric styles rebuilds the whole visualizer subtree — every mode renders its own shell
// and is a separate lazy chunk — so the background layer unmounts and mounts again on every switch.
// Stopping the capture there would force a fresh getUserMedia, and until that lands the layer can
// only show the low-resolution workshop poster: the wallpaper visibly goes blurry for a moment.
// The live capture is therefore held open for a short grace period, so a remount adopts the very
// same stream instead of reopening it.

const MIN_CAPTURE_FRAME_RATE = 10;

// How long a released capture stays open waiting for a remount to adopt it. Long enough to cover a
// visualizer-mode switch (unmount + lazy chunk + mount), short enough that leaving the mode really
// does stop capturing the engine window.
const RELEASE_GRACE_MS = 2500;

export interface WallpaperEngineCaptureOptions {
    sourceId: string;
    frameRate?: number;
}

interface LiveWallpaperEngineCapture {
    sourceId: string;
    maxFrameRate: number;
    stream: MediaStream;
    /** Background layers currently presenting the stream; the last one to leave starts the grace. */
    consumers: number;
    releaseTimer: ReturnType<typeof setTimeout> | null;
}

let liveCapture: LiveWallpaperEngineCapture | null = null;

const normalizeFrameRate = (frameRate: number | undefined) => Math.min(60, Math.max(MIN_CAPTURE_FRAME_RATE, Math.round(frameRate ?? 30)));

const isLive = (stream: MediaStream) => stream.getVideoTracks().some(track => track.readyState === 'live');

// The main process keeps the parked window out of the taskbar with WS_EX_TOOLWINDOW /
// WS_EX_NOACTIVATE. WGC refuses to create a capture item for a window carrying those bits, so a
// fresh getUserMedia must ask the main process to clear them first. Older builds do not expose the
// bridge; the capture-failed retry path still recovers in that case.
const releaseWindowStyle = async () => {
    try {
        await window.electron?.releaseWallpaperEngineCapture?.();
    } catch {
        // The main process may already have torn the session down.
    }
};

const stopStream = (stream: MediaStream) => {
    stream.getTracks().forEach(track => track.stop());
};

/** Drops the cached capture, cancelling any pending grace release. */
const forget = (capture: LiveWallpaperEngineCapture) => {
    if (capture.releaseTimer) clearTimeout(capture.releaseTimer);
    capture.releaseTimer = null;
    if (liveCapture === capture) liveCapture = null;
};

/**
 * Whether a capture is still open that a mounting background layer could adopt. The optional frame
 * rate narrows it to a capture it could actually reuse: the rate is a getUserMedia constraint, so a
 * different value always needs a new stream.
 */
export const hasLiveWallpaperEngineCapture = (frameRate?: number): boolean => {
    if (!liveCapture || !isLive(liveCapture.stream)) return false;
    if (frameRate === undefined) return true;
    return liveCapture.maxFrameRate === normalizeFrameRate(frameRate);
};

/** Finds the parked playback window and opens a window-capture stream on it. */
export const acquireWallpaperEngineCapture = async ({
    sourceId,
    frameRate = 30,
}: WallpaperEngineCaptureOptions): Promise<MediaStream> => {
    const maxFrameRate = normalizeFrameRate(frameRate);
    const current = liveCapture;
    if (current && current.sourceId === sourceId && current.maxFrameRate === maxFrameRate && isLive(current.stream)) {
        // A remount adopting the running capture — also the path React's double-invoked dev effects
        // take, where the release below is scheduled and cancelled again immediately.
        if (current.releaseTimer) {
            clearTimeout(current.releaseTimer);
            current.releaseTimer = null;
        }
        current.consumers += 1;
        return current.stream;
    }
    if (current) {
        // A different source or frame rate supersedes the cached capture: it has no consumer left.
        forget(current);
        stopStream(current.stream);
        // The window is still in its taskbar-hidden shape; clear it before the new capture item.
        await releaseWindowStyle();
    }

    let stream: MediaStream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: sourceId,
                    minFrameRate: MIN_CAPTURE_FRAME_RATE,
                    maxFrameRate,
                },
            } as unknown as MediaTrackConstraints,
        });
    } catch (error) {
        const name = error instanceof Error ? error.name : '';
        // Some Windows 10/NVIDIA combinations refuse the legacy chromeMediaSource path with
        // NotReadableError even though the window exists. The main process installs a
        // getDisplayMedia handler that selects the same Folia playback window through the modern
        // capturer, so retry once through that path before surfacing the failure.
        if (name !== 'NotReadableError' && name !== 'NotFoundError') throw error;
        window.electron?.reportWallpaperEngineLog?.(
            `Legacy capture unavailable (${name}); trying getDisplayMedia`,
            'capture-fallback',
        );
        stream = await navigator.mediaDevices.getDisplayMedia({
            audio: false,
            video: { frameRate: { max: maxFrameRate } },
        });
    }

    if (stream.getVideoTracks().length === 0) {
        stopStream(stream);
        throw new Error('Wallpaper Engine capture produced no video track.');
    }

    const capture: LiveWallpaperEngineCapture = { sourceId, maxFrameRate, stream, consumers: 1, releaseTimer: null };
    liveCapture = capture;
    // The engine window closing ends the stream on its own; drop the cache so the layer falls back
    // to its poster instead of holding a stream that can never produce another frame.
    stream.getVideoTracks()[0].addEventListener('ended', () => forget(capture));
    return stream;
};

/**
 * Releases a capture. The cached one stays open for a grace period so a remount within it (a lyric
 * style switch) can adopt the stream; it is really stopped once the last consumer lets go and
 * nobody reappears in time. Streams outside the cache — a second viewer, a page reload — are
 * stopped straight away.
 */
export const releaseWallpaperEngineCapture = (stream: MediaStream | null | undefined) => {
    if (!stream) return;
    const capture = liveCapture;
    if (capture && capture.stream === stream) {
        capture.consumers = Math.max(0, capture.consumers - 1);
        if (capture.consumers > 0 || capture.releaseTimer) return;
        capture.releaseTimer = setTimeout(() => {
            capture.releaseTimer = null;
            if (capture.consumers > 0) return;
            forget(capture);
            stopStream(capture.stream);
            // No remount adopted the stream: the next mount needs a fresh capture item, which the
            // taskbar-hiding bits would block.
            void releaseWindowStyle();
        }, RELEASE_GRACE_MS);
        return;
    }
    stopStream(stream);
};
