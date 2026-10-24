import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { SongResult } from '../../types';
import type { HomeSurfaceProps } from '../../components/app/home/homeSurfaceTypes';
import {
    isLocalGridViewCollection,
    resolveLocalGridViewTracks,
    type GridViewCollectionDescriptor,
} from '../../components/app/home/gridViewCollectionAdapters';
import { createCollectionResource, resolveCollectionResourceKey } from '../core/services/createCollectionResource';
import { collectionResourceRegistry } from '../core/services/collectionResourceRegistry';
import { setStatusMessage } from '../../stores/useStatusMessageStore';
import { resolveLiveLocalCollection } from './localCollectionRuntime';

// src/library/app/usePlaylistLatticeOpener.ts
// 歌单的统一点击语义：解析歌单 → 把整张列表写成播放队列（静默起播）→ 显式进入 Lattice 队列拼贴。
// 不走集合层，所以不会先压栈再异步退回（那条路会把 Lattice 退掉），也不依赖「播放后进入的视图」这个全局偏好。
// 首页（GridViewOverlayHost 的 openGridView）与播放器侧栏共用这一份，专辑 / 歌手 / 文件夹仍走集合页。

export type PlaylistLatticeOpener = {
    open: (collection: GridViewCollectionDescriptor) => void;
    cancel: () => void;
};

export const usePlaylistLatticeOpener = (surfaceProps: HomeSurfaceProps): PlaylistLatticeOpener => {
    const { t } = useTranslation();
    const { localLibraryCatalog } = surfaceProps;
    const openTokenRef = useRef(0);
    const toastNonceRef = useRef(0);
    const cancelOpenRef = useRef<(() => void) | null>(null);

    const cancel = useCallback(() => {
        cancelOpenRef.current?.();
        cancelOpenRef.current = null;
    }, []);

    const open = useCallback((collection: GridViewCollectionDescriptor) => {
        cancelOpenRef.current?.();
        const token = ++openTokenRef.current;
        const isLatest = () => token === openTokenRef.current;
        const toastNonce = ++toastNonceRef.current;
        // 250ms 内能打开的缓存歌单不闪一下「加载中」；超过 300ms 才出现提示。
        let toastTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
            toastTimer = null;
            setStatusMessage({
                type: 'info',
                text: t('playlist.loading'),
                nonce: toastNonce,
                durationMs: 30_000,
            });
        }, 300);
        const clearLoadingToast = () => {
            if (toastTimer !== null) {
                clearTimeout(toastTimer);
                toastTimer = null;
            }
            setStatusMessage(prev => (prev?.nonce === toastNonce ? null : prev));
        };

        const startedAt = Date.now();
        let settled = false;
        let finishTimer: ReturnType<typeof setTimeout> | null = null;
        let resourceCleanup: (() => void) | null = null;
        const cancelCurrent = () => {
            if (settled) return;
            settled = true;
            if (finishTimer !== null) clearTimeout(finishTimer);
            resourceCleanup?.();
            clearLoadingToast();
        };
        cancelOpenRef.current = cancelCurrent;

        const finish = (tracks: SongResult[]) => {
            if (settled || !isLatest()) return;
            if (tracks.length === 0) {
                settled = true;
                clearLoadingToast();
                surfaceProps.onStatusMessage?.({ type: 'error', text: t('status.noPlayableSongs') });
                resourceCleanup?.();
                return;
            }
            settled = true;
            clearLoadingToast();
            if (surfaceProps.onPlayAllSilent) surfaceProps.onPlayAllSilent(tracks);
            else surfaceProps.onPlayAll?.(tracks);
            surfaceProps.onOpenLattice?.();
            resourceCleanup?.();
        };
        // 资源并行开始加载；只把「发声 + 进 Lattice」推迟 250ms 合并连点。
        // 这样单次点击不会白等一个防抖窗口，连续点击也不会让第一张先开声。
        const scheduleFinish = (tracks: SongResult[]) => {
            if (settled || !isLatest() || finishTimer !== null) return;
            const wait = Math.max(0, 250 - (Date.now() - startedAt));
            if (wait === 0) {
                finish(tracks);
                return;
            }
            finishTimer = setTimeout(() => {
                finishTimer = null;
                finish(tracks);
            }, wait);
        };

        if (isLocalGridViewCollection(collection)) {
            const live = resolveLiveLocalCollection(collection, surfaceProps, localLibraryCatalog);
            if (!live) {
                settled = true;
                clearLoadingToast();
                surfaceProps.onStatusMessage?.({ type: 'error', text: t('playlist.loadFailedPlain') });
                return;
            }
            scheduleFinish(resolveLocalGridViewTracks(live, surfaceProps.localSongs, localLibraryCatalog) as SongResult[]);
            return;
        }

        const key = resolveCollectionResourceKey(collection, surfaceProps.user?.id);
        const reusable = collection.source === 'online'
            ? collectionResourceRegistry.peekOrCreate(key, collection, () => createCollectionResource(key, collection))
            : null;
        const release = reusable ? collectionResourceRegistry.retain(reusable) : null;
        const resource = reusable && release ? reusable : createCollectionResource(key, collection);
        let resourceTimer: ReturnType<typeof setTimeout> | null = null;
        let unsubscribe: (() => void) | null = null;
        resourceCleanup = () => {
            if (resourceTimer !== null) clearTimeout(resourceTimer);
            unsubscribe?.();
            release?.();
            if (!release) resource.dispose();
        };
        const settleFromSnapshot = () => {
            if (settled) return;
            if (!isLatest()) {
                cancelCurrent();
                return;
            }
            const snapshot = resource.getSnapshot();
            if (snapshot.status === 'error') {
                settled = true;
                clearLoadingToast();
                surfaceProps.onStatusMessage?.({ type: 'error', text: t('playlist.loadFailedPlain') });
                resourceCleanup?.();
                return;
            }
            if (snapshot.status !== 'ready') return;
            // 大歌单先等后台补页，避免队列只装了第一页；中断时用已加载部分。
            if (snapshot.sync.status === 'syncing') return;
            if (snapshot.tracks.length === 0) {
                settled = true;
                clearLoadingToast();
                surfaceProps.onStatusMessage?.({ type: 'error', text: t('status.noPlayableSongs') });
                resourceCleanup?.();
                return;
            }
            scheduleFinish(snapshot.tracks);
        };
        unsubscribe = resource.subscribe(settleFromSnapshot);
        // 补页异常慢时不让点击一直悬着：12 秒后先用已加载的曲目进入 Lattice。
        resourceTimer = setTimeout(() => {
            if (settled) return;
            const snapshot = resource.getSnapshot();
            if (snapshot.tracks.length > 0) {
                scheduleFinish(snapshot.tracks);
            } else if (isLatest()) {
                settled = true;
                clearLoadingToast();
                surfaceProps.onStatusMessage?.({ type: 'error', text: t('playlist.loadFailedPlain') });
                resourceCleanup?.();
            }
        }, 12_000);
        resource.ensure(collection, { currentUserId: surfaceProps.user?.id });
        settleFromSnapshot();
    }, [localLibraryCatalog, surfaceProps, t]);

    useEffect(() => () => cancel(), [cancel]);

    return useMemo(() => ({ open, cancel }), [cancel, open]);
};
