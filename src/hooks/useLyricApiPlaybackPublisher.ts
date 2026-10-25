import { useEffect } from 'react';
import type { MotionValue } from 'framer-motion';
import type { PlayerState, SongResult } from '../types';
import { getSongArtistLabel } from '../services/onlineMusic/songMetadata';

// src/hooks/useLyricApiPlaybackPublisher.ts
// Publishes a low-rate playback clock to the desktop-local lyrics API. The lab (and any external
// lyric client) combines it with /v1/lyric to follow the song without capturing a fixture.
// `currentTime` advances at audio rate; sampling it at 10 Hz keeps the IPC cheap while the client
// interpolates between samples.

const PUBLISH_INTERVAL_MS = 100;

export const useLyricApiPlaybackPublisher = ({
    isElectronWindow,
    enabled,
    currentTime,
    lyricCurrentTime,
    duration,
    playerState,
    song,
}: {
    isElectronWindow: boolean;
    enabled: boolean;
    currentTime: MotionValue<number>;
    lyricCurrentTime: MotionValue<number>;
    duration: number;
    playerState: PlayerState;
    song: SongResult | null;
}) => {
    useEffect(() => {
        const bridge = window.electron;
        if (!isElectronWindow || !enabled || !bridge?.publishLyricApiPlayback) {
            return undefined;
        }

        const publish = () => {
            const audioTime = currentTime.get();
            void bridge.publishLyricApiPlayback!({
                currentTime: audioTime,
                // The visualizer bridge already keeps lyricCurrentTime at `audioTime - offset`;
                // this is exactly the value the lyric timeline compares against.
                lyricTime: lyricCurrentTime.get(),
                duration,
                playerState,
                title: song?.name ?? null,
                artist: getSongArtistLabel(song) || null,
            }).catch(() => undefined);
        };

        publish();
        const timer = window.setInterval(publish, PUBLISH_INTERVAL_MS);
        return () => window.clearInterval(timer);
    }, [currentTime, duration, enabled, isElectronWindow, lyricCurrentTime, playerState, song]);
};
