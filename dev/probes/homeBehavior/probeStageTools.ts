import type { LibraryStageToolsPort, LibraryStageToolsSnapshot } from '../../../src/library/core/contracts/ports';
import { recordProbeCall } from '../libraryBehavior/probeLog';

// dev/probes/homeBehavior/probeStageTools.ts
// 首页探针给 stage 工具面板的「假宿主端口」（真 App 是 library/app/useLibraryStageToolsPort，走命令面板的命令）：
// 生成主题、队列洗牌、音量预览都只记账；可用性由用例经 __homeProbe.setStageTools 摆（缺省：没有歌——主题不可生成、不能洗牌）。

const DEFAULT_SNAPSHOT: LibraryStageToolsSnapshot = { themeGeneration: 'unavailable', canShuffleQueue: false };

let snapshot = DEFAULT_SNAPSHOT;
const listeners = new Set<() => void>();

/** 模块级常量（身份稳定，与真 App 的端口一样不随可用性重建首页模型）。 */
export const PROBE_STAGE_TOOLS: LibraryStageToolsPort = {
    getSnapshot: () => snapshot,
    subscribe: listener => {
        listeners.add(listener);
        return () => listeners.delete(listener);
    },
    generateTheme: () => recordProbeCall({ kind: 'generateTheme', ids: [] }),
    shuffleQueue: () => recordProbeCall({ kind: 'shuffleQueue', ids: [] }),
    previewVolume: volume => recordProbeCall({ kind: 'previewVolume', ids: [], detail: volume }),
};

/** 摆可用性（合并进当前快照）；null 复位成缺省。 */
export const setProbeStageTools = (next: Partial<LibraryStageToolsSnapshot> | null): void => {
    snapshot = next ? { ...snapshot, ...next } : DEFAULT_SNAPSHOT;
    for (const listener of listeners) listener();
};
