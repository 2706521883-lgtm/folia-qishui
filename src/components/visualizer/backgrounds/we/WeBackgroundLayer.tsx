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

const WeBackgroundLayer: React.FC<WeBackgroundLayerProps> = ({ tuning, active, posterUrl }) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    const frameRate = tuning.frameRate;
    // Seeded from the service so a remount that can adopt the running capture never paints the
    // poster first (effects run after paint, which would be a visible blurry frame).
    const [streamReady, setStreamReady] = useState(() => hasLiveWallpaperEngineCapture(frameRate));

    useEffect(() => {
        if (!active) {
            setStreamReady(false);
            return undefined;
        }
        let disposed = false;
        let stream: MediaStream | null = null;
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
                    if (!disposed) setStreamReady(false);
                    return;
                }
                if (disposed) {
                    releaseWallpaperEngineCapture(stream);
                    return;
                }
                const video = videoRef.current;
                if (video) {
                    video.srcObject = stream;
                    await video.play().catch(() => undefined);
                    if (!disposed) setStreamReady(true);
                }
                return;
            }
        };

        void attach();

        return () => {
            disposed = true;
            releaseWallpaperEngineCapture(stream);
            stream = null;
            const video = videoRef.current;
            if (video) video.srcObject = null;
        };
    }, [active, frameRate]);

    if (!active && !posterUrl) return null;

    // Panning a scaled layer needs to stay inside the frame; the sliders are in percent of the
    // layer size and 0 keeps the wallpaper centred.
    const transform = [
        `scale(${tuning.scale})`,
        `translate(${tuning.offsetX}%, ${tuning.offsetY}%)`,
    ].join(' ');

    return (
        <div className="absolute inset-0 z-0 overflow-hidden" style={{ pointerEvents: 'none' }}>
            {/* The poster sits *behind* the video: while no frames flow the (transparent) video
                shows it through, and as soon as the capture paints, the live wallpaper covers it. */}
            {posterUrl && !streamReady ? (
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
                    style={{ opacity: tuning.opacity, transform }}
                    muted
                    playsInline
                    autoPlay
                />
            ) : null}
        </div>
    );
};

export default WeBackgroundLayer;
