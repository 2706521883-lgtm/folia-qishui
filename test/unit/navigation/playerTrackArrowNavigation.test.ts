import { describe, expect, it } from 'vitest';
import { resolvePlayerTrackKeyAction } from '@/hooks/usePlaybackInteractionBridge';

// test/unit/navigation/playerTrackArrowNavigation.test.ts

const resolveAction = (overrides: Partial<Parameters<typeof resolvePlayerTrackKeyAction>[0]> = {}) => (
    resolvePlayerTrackKeyAction({
        keyCode: 'ArrowUp',
        currentView: 'player',
        hasCurrentSong: true,
        isNowPlayingStageActive: false,
        hasBlockingWindow: false,
        isRepeat: false,
        ...overrides,
    })
);

describe('player up/down track navigation', () => {
    it('maps ArrowUp to the previous track', () => {
        expect(resolveAction()).toBe('prev');
    });

    it('maps ArrowDown to the next track', () => {
        expect(resolveAction({ keyCode: 'ArrowDown' })).toBe('next');
    });

    it('ignores other keys', () => {
        expect(resolveAction({ keyCode: 'ArrowLeft' })).toBeNull();
        expect(resolveAction({ keyCode: 'KeyH' })).toBeNull();
    });

    it('ignores the keys outside the player page', () => {
        expect(resolveAction({ currentView: 'home' })).toBeNull();
    });

    it('ignores the keys without a current song', () => {
        expect(resolveAction({ hasCurrentSong: false })).toBeNull();
    });

    it('ignores the keys while the now-playing stage is active', () => {
        expect(resolveAction({ isNowPlayingStageActive: true })).toBeNull();
    });

    it('ignores the keys behind a blocking window', () => {
        expect(resolveAction({ hasBlockingWindow: true })).toBeNull();
    });

    it('ignores auto-repeat so a held key changes one track only', () => {
        expect(resolveAction({ isRepeat: true })).toBeNull();
    });
});
