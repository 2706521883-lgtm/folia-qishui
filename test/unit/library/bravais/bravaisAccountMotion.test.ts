import { describe, expect, it } from 'vitest';
import { resolveBravaisAccountPopMotion } from '@/library/suites/bravais/bravaisAccountMotion';

// test/unit/library/bravais/bravaisAccountMotion.test.ts
// fb4：首页窄缝底部账户入口的平台列表往上弹出——正常是从按钮那一侧放大 + 往上位移 + 渐显，降低动态效果时只渐变。

describe('resolveBravaisAccountPopMotion', () => {
    it('grows the list out of the button below it: scaled down, pushed towards the button, transparent at first', () => {
        const pop = resolveBravaisAccountPopMotion(false);
        expect(pop.transformOrigin).toBe('50% 100%');
        expect(pop.initial.opacity).toBe(0);
        expect(pop.initial.scale).toBeLessThan(1);
        // 往下偏（朝着下面的按钮），弹出时往上移到原位。
        expect(pop.initial.y).toBeGreaterThan(0);
        expect(pop.animate).toEqual({ opacity: 1, scale: 1, y: 0 });
        expect(pop.exit.opacity).toBe(0);
        expect(pop.exit.scale).toBeLessThan(1);
        expect(pop.exit.y).toBeGreaterThan(0);
    });

    it('closes faster than it opens', () => {
        const pop = resolveBravaisAccountPopMotion(false);
        expect(pop.exit.transition.duration).toBeLessThan(pop.transition.duration as number);
    });

    it('only fades with reduced motion: no scale, no offset', () => {
        const pop = resolveBravaisAccountPopMotion(true);
        for (const frame of [pop.initial, pop.animate, pop.exit]) {
            expect(frame.scale).toBeUndefined();
            expect(frame.y).toBeUndefined();
        }
        expect(pop.initial.opacity).toBe(0);
        expect(pop.animate.opacity).toBe(1);
        expect(pop.exit.opacity).toBe(0);
        expect(pop.transition.duration).toBeLessThanOrEqual(0.15);
    });
});
