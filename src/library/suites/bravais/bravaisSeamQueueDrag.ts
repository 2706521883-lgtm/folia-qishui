// src/library/suites/bravais/bravaisSeamQueueDrag.ts
// The queue tile in the Bravais seam is also a two-way gesture: dragging right opens the queue
// collage, dragging left opens music search. A press that does not travel far enough is a plain
// click (queue collage), and a mostly vertical drag is not this gesture at all.

export const QUEUE_TILE_DRAG_THRESHOLD_PX = 36;

export type QueueTileDragAction = 'lattice' | 'search' | null;

/**
 * Which action a pointer travelled from the queue tile asks for. `null` means the movement is
 * too small to be a drag, or is mostly vertical (the button's normal click still applies).
 */
export const resolveQueueTileDragAction = (
    dx: number,
    dy: number,
    threshold = QUEUE_TILE_DRAG_THRESHOLD_PX,
): QueueTileDragAction => {
    if (Math.hypot(dx, dy) < threshold) return null;
    if (Math.abs(dx) < Math.abs(dy)) return null;
    return dx > 0 ? 'lattice' : 'search';
};
