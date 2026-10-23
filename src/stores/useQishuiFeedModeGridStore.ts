import { create } from 'zustand';

// src/stores/useQishuiFeedModeGridStore.ts
// Open/close state for the Qishui listening-mode grid. Kept outside the player panel so the
// portal overlay can be mounted once at app level and opened from the FM tab.

type QishuiFeedModeGridState = {
    isOpen: boolean;
    open: () => void;
    close: () => void;
};

export const useQishuiFeedModeGridStore = create<QishuiFeedModeGridState>((set) => ({
    isOpen: false,
    open: () => set({ isOpen: true }),
    close: () => set({ isOpen: false }),
}));

export const openQishuiFeedModeGrid = () => useQishuiFeedModeGridStore.getState().open();
