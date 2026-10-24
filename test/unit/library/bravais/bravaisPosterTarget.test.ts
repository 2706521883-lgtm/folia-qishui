import { describe, expect, it } from 'vitest';
import { resolvePosterWidth, resolveSeamTarget } from '@/library/suites/bravais/bravaisSeamTarget';

// test/unit/library/bravais/bravaisPosterTarget.test.ts
// 歌手页完整等级画成海报；过滤、面板、表单和用户选的书脊仍然走原来的缝。

describe('Bravais artist poster target', () => {
    it('uses the poster variant for a full-level artist page', () => {
        expect(resolveSeamTarget({
            surface: 'artist',
            level: 'full',
            viewportWidth: 1440,
            poster: true,
        })).toEqual({ width: resolvePosterWidth(1440), variant: 'poster' });
    });

    it('uses the same poster variant for a full-level album collection', () => {
        expect(resolveSeamTarget({
            surface: 'collection',
            level: 'full',
            viewportWidth: 1440,
            poster: true,
        })).toEqual({ width: resolvePosterWidth(1440), variant: 'poster' });
    });

    it('keeps the normal seam when the layer has no poster or the user chose the spine', () => {
        expect(resolveSeamTarget({ surface: 'artist', level: 'full', viewportWidth: 1440 }).variant).toBe('full');
        expect(resolveSeamTarget({ surface: 'artist', level: 'spine', viewportWidth: 1440, poster: true }).variant).toBe('spine');
    });

    it('falls back to the full seam while the filter field is open', () => {
        expect(resolveSeamTarget({
            surface: 'artist',
            level: 'full',
            viewportWidth: 1440,
            poster: true,
            filterOpen: true,
        }).variant).toBe('full');
    });

    it('clamps the poster width to its readable range', () => {
        expect(resolvePosterWidth(800)).toBe(520);
        expect(resolvePosterWidth(3000)).toBe(680);
    });

    it('keeps playlist collections wall-only, but still allows their forms', () => {
        expect(resolveSeamTarget({
            surface: 'collection',
            level: 'full',
            viewportWidth: 1440,
            forceHidden: true,
        })).toEqual({ width: 0, variant: 'none' });

        expect(resolveSeamTarget({
            surface: 'collection',
            level: 'full',
            viewportWidth: 1440,
            forceHidden: true,
            panelOpen: true,
            filterOpen: true,
        })).toEqual({ width: 0, variant: 'none' });

        expect(resolveSeamTarget({
            surface: 'collection',
            level: 'full',
            viewportWidth: 1440,
            forceHidden: true,
            formOpen: true,
        }).variant).toBe('form');
    });
});
