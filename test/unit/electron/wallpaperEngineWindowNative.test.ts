import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

// test/unit/electron/wallpaperEngineWindowNative.test.ts
// Locks the pure style/geometry contract of the native Wallpaper Engine window manager. Nothing
// here loads user32 or opens a real window, so the suite runs on any host.

const require = createRequire(import.meta.url);
const {
  PARK_TOLERANCE_PX,
  PARK_VISIBLE_INSET_PX,
  WALLPAPER_ENGINE_PROCESS_NAMES,
  WS_EX_APPWINDOW,
  WS_EX_NOACTIVATE,
  WS_EX_TOOLWINDOW,
  computeManagedExStyle,
  hasManagedExStyle,
  isRectAtTarget,
  primaryScreenCorner,
  rectHeight,
  rectWidth,
  virtualDesktopCorner,
} = require('../../../electron/wallpaperEngineWindowNative.cjs') as {
  PARK_TOLERANCE_PX: number;
  PARK_VISIBLE_INSET_PX: number;
  WALLPAPER_ENGINE_PROCESS_NAMES: string[];
  WS_EX_APPWINDOW: number;
  WS_EX_NOACTIVATE: number;
  WS_EX_TOOLWINDOW: number;
  computeManagedExStyle: (exStyle: unknown) => number;
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
  describe('computeManagedExStyle', () => {
    it('adds the tool-window and no-activate bits and clears app-window', () => {
      expect(computeManagedExStyle(0)).toBe(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);
      expect(computeManagedExStyle(WS_EX_APPWINDOW)).toBe(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);
      expect(computeManagedExStyle(WS_EX_TOOLWINDOW)).toBe(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);
    });

    it('is idempotent and preserves unrelated style bits', () => {
      const unrelated = 0x00010000; // WS_EX_CONTROLPARENT
      const once = computeManagedExStyle(unrelated);
      const twice = computeManagedExStyle(once);
      expect(twice).toBe(once);
      expect(once & unrelated).toBe(unrelated);
    });

    it('never lets the app-window bit survive', () => {
      const style = computeManagedExStyle(WS_EX_APPWINDOW | WS_EX_TOOLWINDOW | 0x00010000);
      expect(style & WS_EX_APPWINDOW).toBe(0);
    });
  });

  describe('hasManagedExStyle', () => {
    it('accepts only the fully managed combination', () => {
      expect(hasManagedExStyle(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)).toBe(true);
      expect(hasManagedExStyle(WS_EX_TOOLWINDOW)).toBe(false);
      expect(hasManagedExStyle(WS_EX_NOACTIVATE)).toBe(false);
      expect(hasManagedExStyle(WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_APPWINDOW)).toBe(false);
      expect(hasManagedExStyle(0)).toBe(false);
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
