import React, { useEffect } from 'react';
import type { WeBackgroundTuning } from '../../../../types';
import { subscribeWallpaperEngineStatus, useWallpaperEngineStore } from '../../../../stores/useWallpaperEngineStore';
import WeBackgroundLayer from './WeBackgroundLayer';

// src/components/visualizer/backgrounds/we/WeBackground.tsx
// Container for the Wallpaper Engine background: owns the main-process status subscription and the
// auto-start trigger, and hands the pure tuning down to the presentational layer.

interface WeBackgroundProps {
    tuning: WeBackgroundTuning;
    /** The visualizer is in a state where a live wallpaper should be playing. */
    enabled: boolean;
}

// Leaving the mode without a remount — another background type, the player page going away — never
// runs the stop effect below, so the parked engine window would keep playing behind the player
// forever. A remount is the norm though: every lyric style renders its own shell, and switching
// styles rebuilds the whole visualizer subtree. So the stop is deferred, and a remount inside the
// delay cancels it: changing the lyric style must not restart the engine (or its capture).
const IDLE_STOP_DELAY_MS = 3000;
let mountedBackgrounds = 0;
let idleStopTimer: ReturnType<typeof setTimeout> | null = null;

const cancelIdleStop = () => {
    if (!idleStopTimer) return;
    clearTimeout(idleStopTimer);
    idleStopTimer = null;
};

const scheduleIdleStop = () => {
    cancelIdleStop();
    idleStopTimer = setTimeout(() => {
        idleStopTimer = null;
        if (mountedBackgrounds > 0) return;
        const store = useWallpaperEngineStore.getState();
        // The last status the main process pushed is still on the store after the unmount, so an
        // idle phase here means there is nothing to stop.
        if (store.phase === 'idle') return;
        void store.stopSession();
    }, IDLE_STOP_DELAY_MS);
};

const WeBackground: React.FC<WeBackgroundProps> = ({ tuning, enabled }) => {
    const phase = useWallpaperEngineStore(state => state.phase);
    const activeItemId = useWallpaperEngineStore(state => state.activeItemId);
    const supported = useWallpaperEngineStore(state => state.supported);
    const startSession = useWallpaperEngineStore(state => state.startSession);
    const stopSession = useWallpaperEngineStore(state => state.stopSession);

    useEffect(() => subscribeWallpaperEngineStatus(), []);

    // Tracks this background's presence for the deferred stop above (see IDLE_STOP_DELAY_MS).
    useEffect(() => {
        mountedBackgrounds += 1;
        cancelIdleStop();
        return () => {
            mountedBackgrounds = Math.max(0, mountedBackgrounds - 1);
            if (mountedBackgrounds === 0) scheduleIdleStop();
        };
    }, []);

    const sessionRunning = phase === 'running' && activeItemId === tuning.itemId && Boolean(tuning.itemId);

    // Auto-start is opt-in and only fires once per (mode, wallpaper) pair: the phase leaves 'idle'
    // as soon as the main process acknowledges, so this cannot loop on a failing wallpaper.
    useEffect(() => {
        if (!enabled || !supported || !tuning.autoStart || !tuning.itemId) return;
        if (phase !== 'idle') return;
        void startSession(tuning.itemId, tuning.muteAudio);
    }, [enabled, supported, tuning.autoStart, tuning.itemId, tuning.muteAudio, phase, startSession]);

    // Leaving the mode (or hiding the background) closes the playback window so no captured
    // wallpaper keeps rendering behind the player.
    useEffect(() => {
        if (enabled || phase === 'idle' || phase === 'stopping') return;
        void stopSession();
    }, [enabled, phase, stopSession]);

    if (!enabled || !tuning.itemId) return null;

    return (
        <WeBackgroundLayer
            tuning={tuning}
            active={sessionRunning}
            posterUrl={`folia-we://preview/${tuning.itemId}`}
        />
    );
};

export default WeBackground;
