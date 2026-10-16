// src/stores/useWallpaperEngineStore.ts
// Wallpaper Engine background mode: the scanned local library (Steam workshop 431960 +
// myprojects) and the side-car runtime session status reported by the main process.
//
// The library catalogue is deliberately kept out of the visualizer settings store: it is a
// scanned, refreshable list of hundreds of entries, not a setting, and putting it there would
// re-render every settings consumer on each scan.

import { create } from 'zustand';

// ElectronWallpaperEngineItem / ElectronWallpaperEngineStatus are ambient globals declared in
// src/vite-env.d.ts, so they must not be imported.
type WallpaperEnginePhase = ElectronWallpaperEngineStatus['phase'];

export type WallpaperEngineState = {
    supported: boolean;
    items: ElectronWallpaperEngineItem[];
    total: number;
    isLoadingLibrary: boolean;
    hasScanned: boolean;
    libraryError: string;
    /** Steam install roots the scan actually used; empty when Steam was not found. */
    steamRoots: string[];
    phase: WallpaperEnginePhase;
    engineReady: boolean;
    executable: string;
    activeItemId: string;
    activeTitle: string;
    muted: boolean;
    audioPropertyCount: number;
    runtimeError: string;
    refreshLibrary: (force?: boolean) => Promise<void>;
    startSession: (itemId: string, muteAudio: boolean) => Promise<{ ok: boolean; error?: string }>;
    stopSession: () => Promise<void>;
    applyStatus: (status: ElectronWallpaperEngineStatus) => void;
    reset: () => void;
};

const EMPTY_RUNTIME = {
    phase: 'idle' as WallpaperEnginePhase,
    engineReady: false,
    activeItemId: '',
    activeTitle: '',
    muted: false,
    audioPropertyCount: 0,
    runtimeError: '',
};

export const useWallpaperEngineStore = create<WallpaperEngineState>((set, get) => ({
    supported: typeof window !== 'undefined' && window.electron?.platform === 'win32',
    items: [],
    total: 0,
    isLoadingLibrary: false,
    hasScanned: false,
    libraryError: '',
    steamRoots: [],
    executable: '',
    ...EMPTY_RUNTIME,

    refreshLibrary: async (force = false) => {
        const api = typeof window !== 'undefined' ? window.electron : undefined;
        if (!api?.scanWallpaperEngineLibrary || get().isLoadingLibrary) return;
        set({ isLoadingLibrary: true, libraryError: '' });
        try {
            const result = await api.scanWallpaperEngineLibrary(force);
            set({
                items: result.items || [],
                total: result.total || 0,
                steamRoots: result.steamRoots || [],
                hasScanned: true,
                libraryError: result.ok ? '' : (result.error || 'scan-failed'),
            });
        } catch (error) {
            set({ hasScanned: true, libraryError: error instanceof Error ? error.message : 'scan-failed' });
        } finally {
            set({ isLoadingLibrary: false });
        }
    },

    startSession: async (itemId, muteAudio) => {
        const api = typeof window !== 'undefined' ? window.electron : undefined;
        if (!api?.startWallpaperEngine) return { ok: false, error: 'unsupported-platform' };
        const result = await api.startWallpaperEngine({ itemId, muteAudio });
        if (!result.ok) {
            set({ runtimeError: result.error || 'start-failed' });
        }
        return { ok: result.ok, error: result.error };
    },

    stopSession: async () => {
        const api = typeof window !== 'undefined' ? window.electron : undefined;
        if (!api?.stopWallpaperEngine) return;
        await api.stopWallpaperEngine();
    },

    applyStatus: (status) => {
        set({
            phase: status.phase,
            engineReady: status.engineReady,
            executable: status.executable || get().executable,
            activeItemId: status.itemId,
            activeTitle: status.title,
            muted: status.muted,
            audioPropertyCount: status.audioPropertyCount,
            runtimeError: status.phase === 'error' ? status.error : '',
        });
    },

    reset: () => set({ ...EMPTY_RUNTIME }),
}));

// Subscribes the store to the main process status pushes and returns an unsubscribe function.
// The settings card and the background layer each call this while they are mounted; every push is
// an immutable snapshot of the same status, so a duplicate listener is harmless.
export const subscribeWallpaperEngineStatus = () => {
    const api = typeof window !== 'undefined' ? window.electron : undefined;
    if (!api?.getWallpaperEngineStatus || !api.onWallpaperEngineChanged) {
        return () => undefined;
    }
    let disposed = false;
    const unsubscribe = api.onWallpaperEngineChanged((status) => {
        if (!disposed) useWallpaperEngineStore.getState().applyStatus(status);
    });
    void api.getWallpaperEngineStatus().then((result) => {
        if (!disposed && result) {
            useWallpaperEngineStore.getState().applyStatus(result.status);
        }
    }).catch(() => undefined);
    return () => {
        disposed = true;
        unsubscribe();
    };
};
