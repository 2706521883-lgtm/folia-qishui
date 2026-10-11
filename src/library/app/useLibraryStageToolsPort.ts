import { useLayoutEffect, useRef, useState } from 'react';
import { usePlaybackStore } from '../../stores/usePlaybackStore';
import type { LibraryStageToolsPort, LibraryStageToolsSnapshot } from '../core/contracts/ports';

// src/library/app/useLibraryStageToolsPort.ts
// 宿主给 stage 工具面板的端口（bravais 右下角工具面板，设计稿 §7.5）：生成主题、队列洗牌走命令面板的同一条命令
// （invokeCommandById，可用性是 canInvokeCommandById 的同一份判定），音量预览走应用的 handlePreviewVolume。
// 端口身份在应用的整个寿命里不变（首页模型不因可用性变化重建）；可用性变了就发一次通知，面板按 getSnapshot 重画。

/** 主题生成与队列洗牌的命令 id（命令面板 settingsCommands / playbackCommands）。 */
export const STAGE_TOOLS_THEME_COMMAND = 'theme-generate-current';
export const STAGE_TOOLS_SHUFFLE_COMMAND = 'playback-shuffle';

export type LibraryStageToolsDeps = {
    /** 命令面板的 invokeCommandById / canInvokeCommandById（播放条槽位用的同一对）。 */
    invokeCommandById: (commandId: string) => void;
    canInvokeCommandById: (commandId: string) => boolean;
    /** 主题正在生成（命令此刻不可用的一种，单独给出来面板才能显示「生成中」）。 */
    isGeneratingTheme: boolean;
    /** 应用的音量预览（只动输出增益）。 */
    previewVolume: (volume: number) => void;
};

/** 与洗牌本身（usePlaybackQueueController.shuffleQueue）同一个前提：队列至少两首、不是外部 Stage 播放。FM 由命令的可用性管。 */
const selectQueueShufflable = (state: ReturnType<typeof usePlaybackStore.getState>) => (
    state.playQueue.length > 1 && state.activePlaybackContext !== 'stage'
);

type StageToolsStore = {
    port: LibraryStageToolsPort;
    publish: (snapshot: LibraryStageToolsSnapshot) => void;
};

const createStageToolsStore = (latest: { current: LibraryStageToolsDeps }): StageToolsStore => {
    let snapshot: LibraryStageToolsSnapshot = { themeGeneration: 'unavailable', canShuffleQueue: false };
    const listeners = new Set<() => void>();
    return {
        port: {
            getSnapshot: () => snapshot,
            subscribe: listener => {
                listeners.add(listener);
                return () => listeners.delete(listener);
            },
            generateTheme: () => latest.current.invokeCommandById(STAGE_TOOLS_THEME_COMMAND),
            shuffleQueue: () => latest.current.invokeCommandById(STAGE_TOOLS_SHUFFLE_COMMAND),
            previewVolume: volume => latest.current.previewVolume(volume),
        },
        publish: next => {
            if (next.themeGeneration === snapshot.themeGeneration && next.canShuffleQueue === snapshot.canShuffleQueue) return;
            snapshot = next;
            for (const listener of listeners) listener();
        },
    };
};

/** App 里调一次：返回稳定的端口，交给首页模型（stageTools）。 */
export const useLibraryStageToolsPort = (deps: LibraryStageToolsDeps): LibraryStageToolsPort => {
    const latest = useRef(deps);
    latest.current = deps;
    const [store] = useState(() => createStageToolsStore(latest));
    const queueShufflable = usePlaybackStore(selectQueueShufflable);
    const themeGeneration: LibraryStageToolsSnapshot['themeGeneration'] = deps.isGeneratingTheme
        ? 'busy'
        : deps.canInvokeCommandById(STAGE_TOOLS_THEME_COMMAND) ? 'ready' : 'unavailable';
    const canShuffleQueue = queueShufflable && deps.canInvokeCommandById(STAGE_TOOLS_SHUFFLE_COMMAND);
    useLayoutEffect(() => {
        store.publish({ themeGeneration, canShuffleQueue });
    }, [store, themeGeneration, canShuffleQueue]);
    return store.port;
};
