import { useSyncExternalStore } from 'react';
import { useAppViewStore } from '../stores/useAppViewStore';
import { isObsBrowserSourceSurface, isRemoteControlSurface } from '../utils/appSurface';
import {
    MOBILE_SHELL_BOTTOM_LIFT_PX,
    MOBILE_SHELL_MIN_DESKTOP_WIDTH_PX,
} from '../utils/mobileShellLayout';

// src/hooks/useMobileShellLayout.ts
// 移动壳布局的单一判定来源。壳级切分与 Tailwind 的 lg（1024）对齐：≥1024 的桌面/Electron
// 一切照旧；<1024 时底部会长出 Tab 栏，贴底一族随之整体上抬。
//
// 区分两个概念，别混：
// - `useIsDesktopLayout`：纯宽度 —— 「是不是桌面档」。播放页强制显示返回键用它
//   （触屏没有 mousemove，跟 Tab 栏在不在场无关）。
// - `useIsMobileTabBarVisible`：Tab 栏此刻是否在场 —— 宽度 + 页面 + 窗口形态共同决定。
//   贴底元素的抬升量必须跟它走，否则播放页里 Tab 栏不在场、贴底元素却凭空悬高一截。

const subscribeViewportWidth = (onStoreChange: () => void): (() => void) => {
    if (typeof window === 'undefined') return () => {};
    window.addEventListener('resize', onStoreChange);
    return () => window.removeEventListener('resize', onStoreChange);
};

const readIsDesktopLayout = (): boolean => (
    typeof window === 'undefined'
        ? false
        : window.innerWidth >= MOBILE_SHELL_MIN_DESKTOP_WIDTH_PX
);

/**
 * 桌面档（≥1024，Tailwind `lg`）。壳只在它以下出现。
 *
 * 读 `window.innerWidth` 而不是 `matchMedia('(min-width: 1024px)')`，因为这条判定必须和
 * Tailwind 的 `lg:`（浏览器原生 CSS 媒体查询）永远同一答案，而 matchMedia 在 e2e 里被换掉了：
 * `installBaseState` 会把它替成一个只回答 light 的桩（test/ui/helpers/appFixtures.ts:217），
 * 宽度查询在那底下恒 false —— JS 以为自己在手机壳里，CSS 却按 1440 判桌面，两边当场打架：
 * 贴底元素整排上抬 40px，窗口里却没有 Tab 栏，截图基线立刻红。
 *
 * innerWidth 和那条媒体查询在本应用的浏览器里逐像素等价（滚动条为 0 时实测：innerWidth=1440
 * 时 `min-width:1440` 匹配、`1441` 不匹配），所以这只是换个读数口，判定结果不变；跨过 1024
 * 由 resize 事件驱动重算，转屏同样走它。OBS 源窗口本来也是改写 innerWidth 来自报宽度。
 */
export const useIsDesktopLayout = (): boolean => useSyncExternalStore(
    subscribeViewportWidth,
    readIsDesktopLayout,
    () => false,
);

/**
 * 底部 Tab 栏此刻是否在场。
 * - 只在壳级宽度以下（≥1024 的桌面窗口没有它）；
 * - 播放页（view === 'player'）不渲染：全屏播放页是沉浸场景，出口是左上角返回键；
 * - OBS 浏览器源 / 远程控制窗口不渲染：它们不是「应用窗口」形态。
 *
 * 壁纸模式刻意不在这个判定里：`wallpaper_mode` 只住在 useDesktopSettingsStore，而那个模块图里
 * 有 i18n/config（模块级 `initReactI18next`）。本 hook 被 lib 组件静态导入
 * （OnlineProviderSwitcher、useVisualizerRendererModel），把 i18n 拖进它们的模块图会让「部分
 * mock react-i18next」的单测在 import 期就炸（test/unit/onlineMusic/providerVisibility.test.ts）。
 * 壁纸模式是 Electron 桌面专属，窄窗口里多一根 Tab 栏不违背设计，不值得为它加门。
 */
export const useIsMobileTabBarVisible = (): boolean => {
    const isDesktop = useIsDesktopLayout();
    const view = useAppViewStore(state => state.view);
    return !isDesktop
        && !isObsBrowserSourceSurface
        && !isRemoteControlSurface
        && view !== 'player';
};

/**
 * 贴底一族在壳可见时要额外抬升的像素数（加进各自的 bottom）。壳不可见时恒为 0，
 * 所以桌面档与播放页上的数值全部保持原样。见 `MOBILE_SHELL_BOTTOM_LIFT_PX`。
 */
export const useMobileShellBottomLiftPx = (): number => (
    useIsMobileTabBarVisible() ? MOBILE_SHELL_BOTTOM_LIFT_PX : 0
);
