import React, { useEffect, useRef, useState } from 'react';
import type { WeBackgroundTuning } from '../../../../types';

// src/components/visualizer/backgrounds/we/WeBuiltinVideoLayer.tsx
// Native playback for Wallpaper Engine *video* projects. The video file is streamed from the local
// project through folia-we://media/<itemId>; Wallpaper Engine is not started and no window is
// captured. Scene projects still use WeBackgroundLayer (engine capture).

interface WeBuiltinVideoLayerProps {
    tuning: WeBackgroundTuning;
    /** The background mode is currently present in the player. */
    active: boolean;
    /** Window hidden/minimized: pause playback instead of decoding frames nobody sees. */
    suspended?: boolean;
    posterUrl?: string | null;
}

const WeBuiltinVideoLayer: React.FC<WeBuiltinVideoLayerProps> = ({
    tuning,
    active,
    suspended = false,
    posterUrl,
}) => {
    const videoRef = useRef<HTMLVideoElement>(null);
    // Keyed by item id so changing the wallpaper resets the poster/error state during the same
    // render, instead of showing the previous video for a frame.
    const [loadedItemId, setLoadedItemId] = useState('');
    const [failedItemId, setFailedItemId] = useState('');
    const ready = loadedItemId === tuning.itemId;
    const failed = failedItemId === tuning.itemId;

    // Returning to the player (or clearing the selection) remounts the <video>; show the poster
    // again until the new element reaches canplay instead of revealing a blank frame.
    useEffect(() => {
        if (active && tuning.itemId) return;
        setLoadedItemId('');
        setFailedItemId('');
    }, [active, tuning.itemId]);

    useEffect(() => {
        const video = videoRef.current;
        if (!video) return;
        video.muted = tuning.muteAudio;
        video.loop = true;
        if (!active || suspended) {
            video.pause();
            return;
        }
        void video.play().catch(() => undefined);
    }, [active, suspended, tuning.muteAudio, tuning.itemId]);

    if (!active || !tuning.itemId) return null;

    // Panning a scaled layer needs to stay inside the frame; the sliders are in percent of the
    // layer size and 0 keeps the wallpaper centred. translateZ(0) pins the video to its own
    // compositing layer, matching the capture layer's behaviour on some GPU drivers.
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
            {failed && posterUrl ? (
                <img
                    src={posterUrl}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover"
                    style={{ opacity: tuning.opacity, transform }}
                />
            ) : (
                <>
                    {/* The poster sits behind the video while the first frame decodes. */}
                    {posterUrl && !ready ? (
                        <img
                            src={posterUrl}
                            alt=""
                            className="absolute inset-0 h-full w-full object-cover"
                            style={{ opacity: tuning.opacity, transform }}
                        />
                    ) : null}
                    <video
                        ref={videoRef}
                        src={`folia-we://media/${encodeURIComponent(tuning.itemId)}`}
                        className="absolute inset-0 h-full w-full object-cover"
                        style={{
                            opacity: tuning.opacity,
                            transform,
                            willChange: 'transform',
                            visibility: ready ? 'visible' : 'hidden',
                        }}
                        autoPlay
                        loop
                        muted={tuning.muteAudio}
                        playsInline
                        preload="auto"
                        controls={false}
                        disablePictureInPicture
                        onCanPlay={() => setLoadedItemId(tuning.itemId)}
                        onError={() => setFailedItemId(tuning.itemId)}
                    />
                </>
            )}
        </div>
    );
};

export default WeBuiltinVideoLayer;
