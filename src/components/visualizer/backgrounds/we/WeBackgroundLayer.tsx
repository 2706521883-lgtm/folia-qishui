import React, { useEffect, useRef, useState } from 'react';
import type { WeBackgroundTuning } from '../../../../types';
import {
    acquireWallpaperEngineCapture,
    hasLiveWallpaperEngineCapture,
    releaseWallpaperEngineCapture,
} from '../../../../services/wallpaperEngineCapture';

// src/components/visualizer/backgrounds/we/WeBackgroundLayer.tsx
// Renders the captured Wallpaper Engine playback window.
//
// The stream is opened once per session; the visual sliders (opacity / scale / offsets) are pure
// CSS, so they never restart the capture — only a frame-rate change re-acquires it, because the
// rate is a getUserMedia constraint. The <video> element is muted and playsInline: the scene's own
// audio comes from the engine window, never from this element.
//
// Switching lyric styles tears this component down and builds it again, so mounting must never
// present the low-resolution poster needlessly: when the capture service still holds the running
// stream, it is adopted as-is and the poster is skipped entirely (see wallpaperEngineCapture.ts).

interface WeBackgroundLayerProps {
    tuning: WeBackgroundTuning;
    /** Whether the runtime session is currently running; the capture only exists while it is. */
    active: boolean;
    /** Poster frame shown while the capture is starting or when it failed. */
    posterUrl?: string | null;
    /**
     * The app window is hidden/minimized: stop drawing capture frames until it returns.
     * Pausing the track is intentionally not part of this signal — the wallpaper stays live.
     */
    suspended?: boolean;
}

// The playback window is created by the engine, which returns from openWallpaper before Windows has
// finished creating the window — so the desktopCapturer source can be missing for a short while
// after the runtime reports "running". Poll instead of giving up on the first miss; the budget
// covers the window helper's own wait (8s) plus the scene load before that. While the loop runs the
// poster frame is already on screen, so waiting longer costs the user nothing but a still frame.
const CAPTURE_SOURCE_RETRIES = 26;
const CAPTURE_SOURCE_RETRY_DELAY_MS = 500;
// Opening a capture can fail while the parked window is still settling; retry before falling back
// to the poster for the rest of the session.
const CAPTURE_ACQUIRE_ATTEMPTS = 3;

const delay = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); });

const WeBackgroundLayer: React.FC<WeBackgroundLayerProps> = ({ tuning, active, posterUrl, suspended = false }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const suspendedRef = useRef(suspended);
    suspendedRef.current = suspended;
    const frameRate = tuning.frameRate;
    // Seeded from the service so a remount that can adopt the running capture never paints the
    // poster first (effects run after paint, which would be a visible blurry frame).
    const [streamReady, setStreamReady] = useState(() => hasLiveWallpaperEngineCapture(frameRate));
    // The poster covers a freshly attached stream until its first real frame. "Capture attached"
    // is not the same as "a frame is on screen": playing from a paused state used to reveal a
    // black <video> because the poster was already gone.
    const [hasFrame, setHasFrame] = useState(() => hasLiveWallpaperEngineCapture(frameRate));
    // Incremented when the live stream ends (engine window re-created / style repair). The effect
    // below then re-fetches the capture source instead of leaving the layer on the poster forever.
    const [captureEpoch, setCaptureEpoch] = useState(0);
    const retryCountRef = useRef(0);
    const retryItemRef = useRef('');
    const frameKeyRef = useRef(`${tuning.itemId}:${frameRate}:${captureEpoch}`);

    useEffect(() => {
        const frameKey = `${tuning.itemId}:${frameRate}:${captureEpoch}`;
        if (frameKeyRef.current !== frameKey) {
            frameKeyRef.current = frameKey;
            setHasFrame(false);
        }
        if (!active) {
            retryCountRef.current = 0;
            retryItemRef.current = '';
            setStreamReady(false);
            setHasFrame(false);
            return undefined;
        }
        if (retryItemRef.current !== tuning.itemId) {
            retryItemRef.current = tuning.itemId;
            retryCountRef.current = 0;
        }
        let disposed = false;
        let stream: MediaStream | null = null;
        let endedTrack: MediaStreamTrack | null = null;
        let endedHandler: (() => void) | null = null;
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        setStreamReady(hasLiveWallpaperEngineCapture(frameRate));

        // Attaches the capture, retrying the source lookup until the engine's window shows up.
        const attach = async () => {
            const api = typeof window !== 'undefined' ? window.electron : undefined;
            if (!api?.getWallpaperEngineCaptureSource) return;
            for (let attempt = 0; attempt < CAPTURE_SOURCE_RETRIES && !disposed; attempt += 1) {
                const source = await api.getWallpaperEngineCaptureSource();
                if (disposed) return;
                if (!source) {
                    await delay(CAPTURE_SOURCE_RETRY_DELAY_MS);
                    continue;
                }
                try {
                    stream = await acquireWallpaperEngineCapture({ sourceId: source.id, frameRate });
                } catch (error) {
                    // The engine window is recreated for every session, so a capture attempt can
                    // lose a race with it; retrying keeps the failure from stranding the poster on
                    // screen for the whole session.
                    if (attempt + 1 < CAPTURE_ACQUIRE_ATTEMPTS) {
                        await delay(CAPTURE_SOURCE_RETRY_DELAY_MS);
                        continue;
                    }
                    console.warn('[WallpaperEngine] Capture failed', error);
                    api.reportWallpaperEngineLog?.(
                        `Capture failed: ${error instanceof Error ? error.message : String(error)}`,
                        'capture-failed',
                    );
                    if (!disposed) setStreamReady(false);
                    // The main process moves the window to the primary-screen fallback when it
                    // receives 'capture-failed'; retry shortly so the capture can attach there.
                    if (!disposed && retryCountRef.current < 2) {
                        retryCountRef.current += 1;
                        retryTimer = setTimeout(() => {
                            if (!disposed) setCaptureEpoch(epoch => epoch + 1);
                        }, 1800);
                    }
                    return;
                }
                if (disposed) {
                    releaseWallpaperEngineCapture(stream);
                    return;
                }
                endedTrack = stream.getVideoTracks()[0] || null;
                endedHandler = () => {
                    if (disposed) return;
                    api.reportWallpaperEngineLog?.('Capture stream ended; re-acquiring', 'capture-ended');
                    setCaptureEpoch(epoch => epoch + 1);
                };
                endedTrack?.addEventListener('ended', endedHandler);
                const video = videoRef.current;
                if (video) {
                    video.srcObject = stream;
                    // A capture that lands while the window is minimized stays paused; the
                    // effect below starts it when the window returns. A paused track is not
                    // suspended, so the wallpaper keeps producing frames.
                    if (!suspendedRef.current) await video.play().catch(() => undefined);
                    if (!disposed) {
                        retryCountRef.current = 0;
                        setStreamReady(true);
                        // Only now is it safe for the main process to hide the playback window from
                        // the taskbar: those style bits make WGC refuse a new capture item.
                        api.reportWallpaperEngineCaptureLive?.();
                    }
                }
                return;
            }
        };

        void attach();

        return () => {
            disposed = true;
            if (retryTimer) clearTimeout(retryTimer);
            if (endedTrack && endedHandler) endedTrack.removeEventListener('ended', endedHandler);
            releaseWallpaperEngineCapture(stream);
            stream = null;
            const video = videoRef.current;
            if (video) video.srcObject = null;
        };
    }, [active, captureEpoch, frameRate, tuning.itemId]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        if (suspended) {
            video.pause();
            return;
        }
        if (video.srcObject) void video.play().catch(() => undefined);
    }, [active, streamReady, suspended]);

    if (!active && !posterUrl) return null;

    // Panning a scaled layer needs to stay inside the frame; the sliders are in percent of the
    // layer size and 0 keeps the wallpaper centred.
    // translateZ(0) 把采集画面固定成自己的合成层；配合外层的 isolation/contain，避免
    // 硬件视频层在个别 GPU/驱动上盖到歌词 DOM 上（表现为「歌词偶尔消失」）。
    const transform = [
        'translateZ(0)',
        `scale(${tuning.scale})`,
        `translate(${tuning.offsetX}%, ${tuning.offsetY}%)`,
    ].join(' ');

    return (
        <div
            className="absolute inset-0 z-0 overflow-hidden"
            style={{ pointerEvents: 'none', isolation: 'isolate', contain: 'paint' }}
        >
            {/* The poster stays until a real frame has been presented. A capture can be attached
                while the video is paused (window hidden) or before its first frame; revealing the
                video then would paint black, so it stays hidden behind the poster. A remount that
                adopts a live capture seeds `hasFrame`, preserving the no-blur switch path. */}
            {posterUrl && !hasFrame ? (
                <img
                    src={posterUrl}
                    alt=""
                    data-we-poster
                    className="absolute inset-0 h-full w-full object-cover"
                    style={{ opacity: tuning.opacity, transform }}
                />
            ) : null}
            {/* The video element stays mounted for the whole session, so the capture can attach to
                it at any point during the retry loop. */}
            {active ? (
                <video
                    ref={videoRef}
                    className="absolute inset-0 h-full w-full object-cover"
                    style={{
                        opacity: tuning.opacity,
                        transform,
                        visibility: hasFrame ? 'visible' : 'hidden',
                        willChange: 'transform',
                    }}
                    muted
                    playsInline
                    autoPlay
                    onLoadedData={() => setHasFrame(true)}
                    onPlaying={() => setHasFrame(true)}
                />
            ) : null}
        </div>
    );
};

export default WeBackgroundLayer;
