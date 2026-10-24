import React, { useMemo, useState } from 'react';
import WeBackgroundLayer from '../../src/components/visualizer/backgrounds/we/WeBackgroundLayer';
import { DEFAULT_WE_BACKGROUND_TUNING } from '../../src/types';
import type { ProbeDefinition } from './definition';

// dev/probes/weBackgroundRemount.probe.tsx
// 壁纸引擎背景层在「切换歌词样式」时的表现：模式切换会把整个 visualizer 子树拆掉重建，背景层随之
// 重挂载。重挂载必须复用仍在运行的采集流（不得重开 getUserMedia），也不得退回低清预览图——那正是
// 用户看到的「切样式时壁纸模糊一下」。探针用真实浏览器宿主 + 假采集（canvas.captureStream）把它钉住。

const POSTER = 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg" width="16" height="9"%3E%3Crect width="16" height="9" fill="%23dc2626"/%3E%3C/svg%3E';

interface ProbeHooks {
    /** getUserMedia 被调用的次数：重挂载不该让它增加。 */
    getUserMediaCalls: number;
    /** 采集一开始就拿着的那条流（供 spec 比对身份）。 */
    firstStream: MediaStream | null;
}

declare global {
    interface Window {
        __weRemountProbe?: ProbeHooks;
    }
}

/** 假采集：一张持续重绘的 canvas 转成活着的视频流，行为与真实窗口采集一致（live track）。 */
const createFakeCapture = () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const context = canvas.getContext('2d')!;
    let frame = 0;
    const paint = () => {
        frame += 1;
        context.fillStyle = '#0f172a';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.fillStyle = `hsl(${frame % 360} 80% 55%)`;
        context.fillRect((frame * 6) % canvas.width, 160, 48, 48);
    };
    paint();
    setInterval(paint, 40);
    return canvas.captureStream(30);
};

let stubsInstalled = false;

/**
 * 桌面端才有的两处依赖：主进程给的采集源，和真正的取流。探针里都换成假的，形状保持与生产一致
 * （源是 `{ id, name }`，取流返回 MediaStream）——探针要验证的是重挂载路径，不是采集本身。
 */
const installStubs = () => {
    if (stubsInstalled) return;
    stubsInstalled = true;
    const hooks: ProbeHooks = { getUserMediaCalls: 0, firstStream: null };
    window.__weRemountProbe = hooks;
    (window as unknown as { electron: unknown }).electron = {
        getWallpaperEngineCaptureSource: async () => ({ id: 'window:we-probe:0', name: 'Folia WE probe' }),
    };
    Object.defineProperty(navigator, 'mediaDevices', {
        configurable: true,
        value: {
            getUserMedia: async () => {
                hooks.getUserMediaCalls += 1;
                return createFakeCapture();
            },
        },
    });
};

const WeBackgroundRemountProbe: React.FC = () => {
    // 探针的渲染发生在子树挂载之前，桩在这里装上就够早。
    useMemo(installStubs, []);
    // 换 key = 卸载再挂载，和切换歌词样式时 visualizer 子树被整体重建是同一条路径。
    const [epoch, setEpoch] = useState(0);
    const [paused, setPaused] = useState(false);

    return (
        <div className="relative h-screen w-screen overflow-hidden">
            <WeBackgroundLayer
                key={epoch}
                tuning={DEFAULT_WE_BACKGROUND_TUNING}
                active
                suspended={paused}
                posterUrl={POSTER}
            />
            <div className="absolute left-4 top-4 z-10 flex gap-2">
                <button
                    type="button"
                    className="rounded-full bg-white px-4 py-2 text-sm text-black"
                    onClick={() => setEpoch(value => value + 1)}
                >
                    Switch lyric style
                </button>
                <button
                    type="button"
                    className="rounded-full bg-white px-4 py-2 text-sm text-black"
                    onClick={() => setPaused(value => !value)}
                >
                    {paused ? 'Resume capture' : 'Pause capture'}
                </button>
            </div>
        </div>
    );
};

const definition: ProbeDefinition = {
    id: 'weBackgroundRemount',
    title: 'Wallpaper Engine · 切歌词样式不重开采集',
    description: '切换歌词样式会重建整个 visualizer 子树，背景层随之重挂载：必须复用仍在跑的采集流、不重开 getUserMedia，也不退回低清预览图（否则用户看到的壁纸会模糊一下）。',
    Component: WeBackgroundRemountProbe,
};

export default definition;
