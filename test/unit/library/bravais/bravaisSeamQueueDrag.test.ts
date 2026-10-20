import { describe, expect, it } from 'vitest';
import {
    QUEUE_TILE_DRAG_THRESHOLD_PX,
    resolveQueueTileDragAction,
} from '../../../../src/library/suites/bravais/bravaisSeamQueueDrag';

// test/unit/library/bravais/bravaisSeamQueueDrag.test.ts
// The queue tile's horizontal gesture: right = queue collage, left = music search; a tap or a
// mostly vertical movement is not this gesture and stays a click.

describe('Bravais seam queue tile drag', () => {
    it('opens the queue collage when dragged right', () => {
        expect(resolveQueueTileDragAction(QUEUE_TILE_DRAG_THRESHOLD_PX + 1, 0)).toBe('lattice');
        expect(resolveQueueTileDragAction(120, 18)).toBe('lattice');
        expect(resolveQueueTileDragAction(-1, 0)).toBeNull();
    });

    it('opens music search when dragged left', () => {
        expect(resolveQueueTileDragAction(-(QUEUE_TILE_DRAG_THRESHOLD_PX + 1), 0)).toBe('search');
        expect(resolveQueueTileDragAction(-120, -18)).toBe('search');
    });

    it('keeps a short press as a click', () => {
        expect(resolveQueueTileDragAction(0, 0)).toBeNull();
        expect(resolveQueueTileDragAction(20, 20)).toBeNull();
        expect(resolveQueueTileDragAction(-20, 5)).toBeNull();
    });

    it('ignores a mostly vertical drag even when it is long', () => {
        expect(resolveQueueTileDragAction(20, 120)).toBeNull();
        expect(resolveQueueTileDragAction(-20, -120)).toBeNull();
    });
});
