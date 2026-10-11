import { describe, expect, it } from 'vitest';
import { getBlockSlots } from '@/components/wall/wallSlots';
import { resolveFocusReflow } from '@/library/suites/bravais/bravaisDisplay';
import { BRAVAIS_REFLOW_MS } from '@/library/suites/bravais/bravaisReflowMotion';
import { planReflowTracks, sampleReflowTrack } from '@/library/suites/bravais/useBravaisReflowDriver';

// test/unit/library/bravais/bravaisReflowDriver.test.ts
// 聚焦卡块内让位的逐帧驱动（2026-10-09 起，磁贴外框与透光底板同一帧写）：每个动的 slot 一条轨迹，起点是它此刻画着的
// 矩形（被打断时是实时矩形），终点是落定矩形；没动的不进表；另一块还没放完的归位照旧。

const metrics = { cellSize: 128, gap: 8 };
const NONE = new Map();
const slots = getBlockSlots(0, 0, metrics);
const expandA = resolveFocusReflow(slots[0]!.key);
const expandB = resolveFocusReflow(slots[5]!.key);
const otherBlock = resolveFocusReflow(getBlockSlots(1, 0, metrics)[0]!.key);

describe('planReflowTracks', () => {
    it('expanding moves each re-geared slot from its resting rect to its reflowed rect', () => {
        const tracks = planReflowTracks(new Map(), NONE, expandA, 0);
        expect(tracks.size).toBeGreaterThan(0);
        for (const slot of slots) {
            const to = expandA.get(slot.key)!;
            const moved = to.x !== slot.x || to.y !== slot.y || to.width !== slot.width || to.height !== slot.height;
            expect(tracks.has(slot.key)).toBe(moved);
            if (!moved) continue;
            const track = tracks.get(slot.key)!;
            expect(track.from).toEqual({ x: slot.x, y: slot.y, width: slot.width, height: slot.height });
            expect(sampleReflowTrack(track, 0)).toEqual(track.from);
            expect(sampleReflowTrack(track, BRAVAIS_REFLOW_MS)).toEqual(track.to);
        }
    });

    it('an interruption starts from where the tile is drawn right now', () => {
        const first = planReflowTracks(new Map(), NONE, expandA, 0);
        const half = BRAVAIS_REFLOW_MS / 2;
        const second = planReflowTracks(first, expandA, expandB, half);
        for (const [key, track] of second) {
            const running = first.get(key);
            if (running) expect(track.from).toEqual(sampleReflowTrack(running, half));
            expect(expandB.get(key)).toMatchObject(track.to);
            expect(track.start).toBe(half);
        }
    });

    it('switching blocks keeps the old block returning while the new one opens; finished tracks drop out', () => {
        const opened = planReflowTracks(new Map(), NONE, expandA, 0);
        const switched = planReflowTracks(opened, expandA, otherBlock, BRAVAIS_REFLOW_MS * 2);
        const keys = [...switched.keys()];
        expect(keys.some(key => key.startsWith('0,0,'))).toBe(true);
        expect(keys.some(key => key.startsWith('1,0,'))).toBe(true);
        // 0,0 那一块归位的起点是它的让位矩形（第一段早已放完）。
        for (const key of keys.filter(name => name.startsWith('0,0,'))) expect(expandA.get(key)).toMatchObject(switched.get(key)!.from);
        expect(planReflowTracks(switched, otherBlock, otherBlock, BRAVAIS_REFLOW_MS * 4).size).toBe(0);
    });

    it('stays within the start and end rects (the spring never overshoots)', () => {
        const [track] = planReflowTracks(new Map(), NONE, expandA, 0).values();
        for (let t = 0; t <= BRAVAIS_REFLOW_MS; t += BRAVAIS_REFLOW_MS / 50) {
            const rect = sampleReflowTrack(track!, t);
            expect(rect.x).toBeGreaterThanOrEqual(Math.min(track!.from.x, track!.to.x) - 1e-9);
            expect(rect.x).toBeLessThanOrEqual(Math.max(track!.from.x, track!.to.x) + 1e-9);
            expect(rect.width).toBeGreaterThanOrEqual(Math.min(track!.from.width, track!.to.width) - 1e-9);
            expect(rect.width).toBeLessThanOrEqual(Math.max(track!.from.width, track!.to.width) + 1e-9);
        }
    });
});
