import { useSyncExternalStore } from 'react';

// src/hooks/useDocumentVisibility.ts
// Chromium throttles rAF for a hidden window, but WebGL/Pixi tickers and a desktop-capture video
// keep consuming GPU time until they are explicitly stopped. Visualizers use this to pause while
// the window is minimized/on another desktop; wallpaper mode opts out because the wallpaper is the
// thing the user expects to keep running.

const subscribe = (onChange: () => void): (() => void) => {
    if (typeof document === 'undefined') return () => {};
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
};

const getSnapshot = (): boolean => (
    typeof document !== 'undefined' && document.visibilityState === 'hidden'
);

const getServerSnapshot = (): boolean => false;

export const useDocumentHidden = (): boolean => useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
);
