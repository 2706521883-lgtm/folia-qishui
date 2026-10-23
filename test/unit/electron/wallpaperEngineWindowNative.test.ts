import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

// test/unit/electron/wallpaperEngineWindowNative.test.ts
// Locks the pure style/geometry contract of the native Wallpaper Engine window manager. Nothing
// here loads user32 or opens a real window, so the suite runs on any host.

const require = createRequire(import.meta.url);
const {
  FRAMELESS_STYLE,
  GWL_STYLE,
  PARK_TOLERANCE_PX,
  PARK_VISIBLE_INSET_PX,
  WALLPAPER_ENGINE_PROCESS_NAMES,
  WS_EX_APPWINDOW,
  WS_EX_NOACTIVATE,
  WS_EX_TOOLWINDOW,
  computeFramelessExStyle,
  computeHiddenExStyle,
  computeManagedExStyle,
  hasHiddenExStyle,
  hasManagedExStyle,
  isRectAtTarget,
  primaryScreenCorner,
  rectHeight,
  rectWidth,
  virtualDesktopCorner,
} = require('../../../electron/wallpaperEngineWindowNative.cjs') as {
  FRAMELESS_STYLE: number;
  GWL_STYLE: number;
  PARK_TOLERANCE_PX: number;
  PARK_VISIBLE_INSET_PX: number;
  WALLPAPER_ENGINE_PROCESS_NAMES: string[];
  WS_EX_APPWINDOW: number;
  WS_EX_NOACTIVATE: number;
  WS_EX_TOOLWINDOW: number;
  computeFramelessExStyle: (exStyle: unknown) => number;
  computeHiddenExStyle: (exStyle: unknown) => number;
  computeManagedExStyle: (exStyle: unknown) => number;
  hasHiddenExStyle: (exStyle: unknown) => boolean;
  hasManagedExStyle: (exStyle: unknown) => boolean;
  isRectAtTarget: (rect: { left: number; top: number } | null, target: { x: number; y: number } | null, tolerance?: number) => boolean;
  primaryScreenCorner: (bounds: { width: number; height: number }) => { x: number; y: number };
  rectHeight: (rect: { top: number; bottom: number }) => number;
  rectWidth: (rect: { left: number; right: number }) => number;
  virtualDesktopCorner: (bounds: { x: number; y: number; width: number; height: number }) => { x: number; y: number };
};

const {
  WALLPAPER_ENGINE_PROCESS_NAMES: POWERSHELL_PROCESS_NAMES,
} = require('../../../electron/wallpaperEngineWindow.cjs') as {
  WALLPAPER_ENGINE_PROCESS_NAMES: string[];
};

describe('wallpaperEngineWindowNative', () => {
  describe('capture style phases', () => {
    it('keeps the capture-time shape free of the bits WGC rejects', () => {
      expect(GWL_STYLE).toBe(-16);
      expect(FRAMELESS_STYLE).toBe(0x94000000);
      expect(computeFramelessExStyle(0)).toBe(0);
      expect(computeFramelessExStyle(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_APPWINDOW)).toBe(0);
      // WS_EX_WINDOWEDGE (0x100) was present on the framed window and survives the strip.
      expect(computeFramelessExStyle(0x00000100)).toBe(0x00000100);
    });

    it('adds the taskbar-hiding bits only for the post-capture phase', () => {
      expect(computeHiddenExStyle(0)).toBe(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);
      expect(computeHiddenExStyle(WS_EX_APPWINDOW)).toBe(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);
      expect(computeHiddenExStyle(WS_EX_TOOLWINDOW)).toBe(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);
      expect(computeHiddenExStyle(0x00000100)).toBe(0x08000080 | 0x00000100);
    });

    it('is idempotent and preserves unrelated style bits in both phases', () => {
      const unrelated = 0x00010000; // WS_EX_CONTROLPARENT
      const hidden = computeHiddenExStyle(unrelated);
      expect(computeHiddenExStyle(hidden)).toBe(hidden);
      expect(hidden & unrelated).toBe(unrelated);

      const frameless = computeFramelessExStyle(hidden);
      expect(frameless & unrelated).toBe(unrelated);
      expect(computeFramelessExStyle(frameless)).toBe(frameless);
    });

    it('never lets the app-window bit survive either phase', () => {
      expect(computeFramelessExStyle(WS_EX_APPWINDOW | WS_EX_TOOLWINDOW)).toBe(0);
      expect(computeHiddenExStyle(WS_EX_APPWINDOW | WS_EX_TOOLWINDOW) & WS_EX_APPWINDOW).toBe(0);
    });

    it('keeps the pre-0.6.7 export names as aliases of the hidden phase', () => {
      expect(computeManagedExStyle).toBe(computeHiddenExStyle);
      expect(hasManagedExStyle).toBe(hasHiddenExStyle);
    });
  });

  describe('hasHiddenExStyle', () => {
    it('accepts only the fully hidden combination', () => {
      expect(hasHiddenExStyle(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)).toBe(true);
      expect(hasHiddenExStyle(WS_EX_TOOLWINDOW)).toBe(false);
      expect(hasHiddenExStyle(WS_EX_NOACTIVATE)).toBe(false);
      expect(hasHiddenExStyle(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_APPWINDOW)).toBe(false);
      expect(hasHiddenExStyle(0)).toBe(false);
    });
  });

  describe('parking corners', () => {
    it('defaults to the virtual desktop corner with a small inset, so the body stays outside every monitor', () => {
      expect(PARK_VISIBLE_INSET_PX).toBe(4);
      expect(virtualDesktopCorner({ x: 0, y: 0, width: 2560, height: 1440 })).toEqual({ x: 2556, y: 1436 });
      expect(virtualDesktopCorner({ x: -1920, y: 0, width: 3840, height: 1080 })).toEqual({ x: 1916, y: 1076 });
    });

    it('keeps a primary-screen fallback for capture failures', () => {
      expect(primaryScreenCorner({ width: 2560, height: 1440 })).toEqual({ x: 2556, y: 1436 });
      expect(primaryScreenCorner({ width: 1920, height: 1080 })).toEqual({ x: 1916, y: 1076 });
    });

    it('never produces a negative primary corner for tiny screens', () => {
      expect(primaryScreenCorner({ width: 2, height: 2 })).toEqual({ x: 0, y: 0 });
      expect(primaryScreenCorner({ width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
    });
  });

  describe('isRectAtTarget', () => {
    const target = { x: 3711, y: 1524 };

    it('accepts a window inside the tolerance and rejects a visible drift', () => {
      expect(isRectAtTarget({ left: 3711, top: 1524 }, target)).toBe(true);
      expect(isRectAtTarget({ left: 3711 + PARK_TOLERANCE_PX, top: 1524 - PARK_TOLERANCE_PX }, target)).toBe(true);
      expect(isRectAtTarget({ left: 3711 + PARK_TOLERANCE_PX + 1, top: 1524 }, target)).toBe(false);
      expect(isRectAtTarget({ left: 10, top: 10 }, target)).toBe(false);
    });

    it('rejects missing geometry', () => {
      expect(isRectAtTarget(null, target)).toBe(false);
      expect(isRectAtTarget({ left: 0, top: 0 }, null)).toBe(false);
    });
  });

  it('measures rects without ever returning zero', () => {
    expect(rectWidth({ left: 10, right: 810 })).toBe(800);
    expect(rectHeight({ top: 10, bottom: 610 })).toBe(600);
    expect(rectWidth({ left: 10, right: 10 })).toBe(1);
    expect(rectHeight({ top: 10, bottom: 5 })).toBe(1);
  });

  it('uses the same process-name list as the PowerShell fallback', () => {
    expect(WALLPAPER_ENGINE_PROCESS_NAMES).toEqual(POWERSHELL_PROCESS_NAMES);
    expect(WALLPAPER_ENGINE_PROCESS_NAMES).toEqual(['wallpaper64', 'wallpaper32']);
  });
});
