import { create } from 'zustand';

// src/stores/useExploreOverlayStore.ts
// 「探索」浮层的开合：首页头部、Bravais 工具格与命令面板共用。

type ExploreOverlayState = {
    isOpen: boolean;
    open: () => void;
    close: () => void;
    toggle: () => void;
};

export const useExploreOverlayStore = create<ExploreOverlayState>(set => ({
    isOpen: false,
    open: () => set({ isOpen: true }),
    close: () => set({ isOpen: false }),
    toggle: () => set(state => ({ isOpen: !state.isOpen })),
}));
