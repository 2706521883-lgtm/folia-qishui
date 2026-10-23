import React, { useMemo, useState } from 'react';
import WeBackground from '../../src/components/visualizer/backgrounds/we/WeBackground';
import { useWallpaperEngineStore } from '../../src/stores/useWallpaperEngineStore';
import { DEFAULT_WE_BACKGROUND_TUNING } from '../../src/types';
import type { ProbeDefinition } from './definition';

// dev/probes/weSessionUnmountStop.probe.tsx
// 背景层卸载之后会话会不会一直挂着：切走背景类型、离开播放页时 WeBackground 是被卸载的，停会话的
// effect 根本没机会跑，parked 的引擎窗口就会一直在后台播。这里验证「卸载后 3 秒没重新挂载就停」，
// 以及「3 秒内重新挂载（= 切歌词样式）必须取消这次停」。

const RUNNING_STATUS: ElectronWallpaperEngineStatus = {
    phase: 'running',
    engineReady: true,
    executable: 'C:/probe/wallpaper64.exe',
    locationTitle: 'probe',
    hwnd: '',
    // 故意和 tuning.itemId 不同：背景层就不会去开采集（探针只关心会话生命周期）。
    itemId: 'probe-host-session',
    title: 'Probe session',
    width: 0,
    height: 0,
    parkX: 0,
    parkY: 0,
    muted: true,
    audioPropertyCount: 0,
    mutedPropertyCount: 0,
    startedAt: 0,
    error: '',
    windowManaged: true,
    windowWatchActive: true,
    windowLost: false,
};

interface ProbeHooks {
    starts: number;
    stops: number;
}

declare global {
    interface Window {
        __weSessionProbe?: ProbeHooks;
    }
}

let stubsInstalled = false;

/** 主进程那侧的会话接口全部换成记账桩：探针要数的是「有没有人调 stopSession」。 */
const installStubs = () => {
    if (stubsInstalled) return;
    stubsInstalled = true;
    const hooks: ProbeHooks = { starts: 0, stops: 0 };
    window.__weSessionProbe = hooks;
    (window as unknown as { electron: unknown }).electron = {
        platform: 'win32',
        startWallpaperEngine: async () => {
            hooks.starts += 1;
            return { ok: true };
        },
        stopWallpaperEngine: async () => {
            hooks.stops += 1;
        },
        onWallpaperEngineChanged: () => () => undefined,
        getWallpaperEngineStatus: async () => ({ status: RUNNING_STATUS }),
        getWallpaperEngineCaptureSource: async () => null,
    };
    // 会话从「已经在跑」开始：卸载后该停的就是它。
    useWallpaperEngineStore.getState().applyStatus(RUNNING_STATUS);
};

const WeSessionUnmountStopProbe: React.FC = () => {
    useMemo(installStubs, []);
    const [mounted, setMounted] = useState(false);

    return (
        <div className="relative h-screen w-screen overflow-hidden bg-zinc-900">
            {mounted ? (
                <WeBackground
                    tuning={{ ...DEFAULT_WE_BACKGROUND_TUNING, itemId: 'probe-item', autoStart: false }}
                    enabled
                />
            ) : null}
            <div className="absolute left-4 top-4 z-10 flex gap-2">
                <button
                    type="button"
                    className="rounded-full bg-white px-4 py-2 text-sm text-black"
                    onClick={() => setMounted(true)}
                >
                    Mount background
                </button>
                <button
                    type="button"
                    className="rounded-full bg-white px-4 py-2 text-sm text-black"
                    onClick={() => setMounted(false)}
                >
                    Unmount background
                </button>
            </div>
        </div>
    );
};

const definition: ProbeDefinition = {
    id: 'weSessionUnmountStop',
    title: 'Wallpaper Engine · 卸载后停会话',
    description: '背景层被卸载（切走背景类型 / 离开播放页）后，3 秒内没有重新挂载就停掉会话，不留 parked 引擎窗口；3 秒内重新挂载（切歌词样式会重建整棵子树）则取消这次停。',
    Component: WeSessionUnmountStopProbe,
};

export default definition;
