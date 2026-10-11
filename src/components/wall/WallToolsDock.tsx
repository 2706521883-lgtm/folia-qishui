import { useState, useSyncExternalStore, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { WallToolsDockContext, WallToolsSurface, type WallToolsButtonProps, type WallToolsDockRegistry } from './WallToolsButton';

// src/components/wall/WallToolsDock.tsx
// 墙面右下角工具按钮的 dock（翻牌交接，设计稿 §7「进入队列」）：App 用 WallToolsDockHost 包住首页层与 Lattice 两个挂载点，
// 两面墙的 WallToolsButton 不再各画各的，而是把 props 认领进这里，dock 只画「最后认领的那一份」。进 Lattice 时 Lattice
// 后挂上、后认领，按钮换成 Lattice 的条目；回资料库墙时资料库墙后挂上、后认领。两面墙同时挂着的那一段里按钮始终是同一个
// DOM 节点、同一个位置，不重建、不闪。没人认领时淡出（0.25s，与首页层的淡出同长）；第一次出现不淡入。
// dock 自己在首页层与 Lattice 之上（同为 z-10，DOM 顺序在后），不接指针，只有按钮本身接。

type DockClaims = {
    registry: WallToolsDockRegistry;
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => WallToolsButtonProps | null;
};

/** 认领表：按认领的先后排，最后认领的在最上面；撤回后再认领算新的一次（排到最后）。 */
const createDockClaims = (): DockClaims => {
    const claims = new Map<string, WallToolsButtonProps>();
    const listeners = new Set<() => void>();
    let top: WallToolsButtonProps | null = null;
    const refresh = () => {
        let next: WallToolsButtonProps | null = null;
        for (const props of claims.values()) next = props;
        if (next === top) return;
        top = next;
        for (const listener of listeners) listener();
    };
    return {
        registry: {
            claim: (id, props) => {
                claims.set(id, props);
                refresh();
            },
            release: id => {
                if (!claims.delete(id)) return;
                refresh();
            },
        },
        subscribe: listener => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        getSnapshot: () => top,
    };
};

function WallToolsDock({ claims }: { claims: DockClaims }) {
    const props = useSyncExternalStore(claims.subscribe, claims.getSnapshot, claims.getSnapshot);
    return (
        <div className="wall-tools-dock absolute inset-0 z-10 pointer-events-none" data-wall-tools-dock="">
            <AnimatePresence initial={false}>
                {props && (
                    <motion.div
                        key="wall-tools"
                        className="absolute inset-0"
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.25, ease: 'easeInOut' }}
                    >
                        <WallToolsSurface {...props} />
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

/** 包住要共用一颗工具按钮的墙（首页层与 Lattice），dock 画在它们后面。 */
export default function WallToolsDockHost({ children }: { children: ReactNode }) {
    const [claims] = useState(createDockClaims);
    return (
        <WallToolsDockContext.Provider value={claims.registry}>
            {children}
            <WallToolsDock claims={claims} />
        </WallToolsDockContext.Provider>
    );
}
