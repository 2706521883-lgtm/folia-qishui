// src/utils/mobileShellLayout.ts
// 移动壳（宽度 <1024 的浏览器/手机形态）的共享几何：底部 Tab 栏高度，以及壳可见时
// 贴底一族统一要抬升的量。与 Tailwind 的 lg（1024）对齐：壳只在 lg 以下出现，
// ≥1024 的桌面/Electron 上这些数字不参与任何计算（抬升量恒为 0）。

/**
 * 桌面档的宽度下限，与 Tailwind 的 `lg` 对齐（默认 64rem = 1024px，本仓库没有改过 breakpoint）。
 * 壳只在它以下出现。
 */
export const MOBILE_SHELL_MIN_DESKTOP_WIDTH_PX = 1024;

/** Tab 栏内容高度（安全区另由 padding 承担）。56 ≥ 44pt 触控下限，iOS 上 Tab 栏的常见高度。 */
export const MOBILE_TAB_BAR_HEIGHT_PX = 56;

/**
 * 抬升量参考的基准底距：手机壳下胶囊的实际底距。
 * 桌面基线 32，窄屏上胶囊自己又压低 8（`max-sm:mb-[calc(var(--safe-bottom)-8px)]`），
 * 所以手机上它离屏幕底边的净底距是 24。贴底一族在壳里统一按这个基准上抬。
 */
const NARROW_CAPSULE_BASE_PX = 24;

/** 抬升后贴底元素与 Tab 栏之间的净空。 */
export const MOBILE_TAB_BAR_GAP_PX = 8;

/**
 * 壳可见时，贴底一族额外抬升的量（直接加在各自的 bottom 值上；安全区仍由各自的 margin 承担）。
 *
 * = 栏高 + 净空 − 基准底距 = 56 + 8 − 24 = 40。加完之后：
 * - 胶囊底距 = 24 + 40 = 64 = 栏顶（safe + 56）+ 8 净空；
 * - 表里其余贴底元素（墙面工具、面板开关、侧栏、列表搜索钮、toast）都经同一个出口
 *   `usePlayerBottomBarBottomPx` 取值，同步上抬，彼此相对关系不变。
 *
 * 桌面档（≥1024）与壳不可见时（播放页、OBS / 远程控制窗口）抬升量为 0，原有像素一个不动。
 */
export const MOBILE_SHELL_BOTTOM_LIFT_PX = MOBILE_TAB_BAR_HEIGHT_PX + MOBILE_TAB_BAR_GAP_PX - NARROW_CAPSULE_BASE_PX;
