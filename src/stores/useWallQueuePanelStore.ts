import { create } from 'zustand';

// src/stores/useWallQueuePanelStore.ts
// 墙面右下角工具面板里的「播放队列」浮岛：Lattice 与 Bravais 共用同一个开合状态，
// 面板本身渲染在 App 层，墙只负责开合，不直接依赖队列组件。

type WallQueuePanelState = {
    isOpen: boolean;
    setOpen: (open: boolean) => void;
    toggle: () => void;
    close: () => void;
};

export const useWallQueuePanelStore = create<WallQueuePanelState>(set => ({
    isOpen: false,
    setOpen: open => set({ isOpen: open }),
    toggle: () => set(state => ({ isOpen: !state.isOpen })),
    close: () => set({ isOpen: false }),
}));
