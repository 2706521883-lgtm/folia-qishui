import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    AUTO_CROSS_SOURCE_FALLBACK_KEY,
    selectAudioSettingsSnapshot,
    useAudioSettingsStore,
} from '@/stores/useAudioSettingsStore';

// test/unit/settings/crossSourceFallbackSetting.test.ts

const mocks = vi.hoisted(() => ({
    storedValues: new Map<string, string>(),
    statusSetter: vi.fn(),
}));

vi.mock('@/stores/storagePrimitives', () => ({
    getStoredBoolean: (key: string, fallback: boolean) => (
        mocks.storedValues.has(key)
            ? mocks.storedValues.get(key) === 'true'
            : fallback
    ),
    setStoredBoolean: (key: string, value: boolean) => {
        mocks.storedValues.set(key, String(value));
    },
}));

vi.mock('@/stores/useStatusMessageStore', () => ({
    setStatusMessage: mocks.statusSetter,
}));

const initialAutoCrossSourceFallback = useAudioSettingsStore.getState().autoCrossSourceFallback;

describe('cross-source fallback setting', () => {
    beforeEach(() => {
        mocks.storedValues.clear();
        mocks.statusSetter.mockReset();
        useAudioSettingsStore.setState({ autoCrossSourceFallback: true });
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('defaults to enabled', () => {
        expect(initialAutoCrossSourceFallback).toBe(true);
    });

    it('persists the toggle and notifies the user', () => {
        useAudioSettingsStore.getState().handleToggleAutoCrossSourceFallback(false);

        expect(mocks.storedValues.get(AUTO_CROSS_SOURCE_FALLBACK_KEY)).toBe('false');
        expect(useAudioSettingsStore.getState().autoCrossSourceFallback).toBe(false);
        expect(mocks.statusSetter).toHaveBeenCalledWith({
            type: 'info',
            text: expect.any(String),
        });

        useAudioSettingsStore.getState().handleToggleAutoCrossSourceFallback(true);

        expect(mocks.storedValues.get(AUTO_CROSS_SOURCE_FALLBACK_KEY)).toBe('true');
        expect(useAudioSettingsStore.getState().autoCrossSourceFallback).toBe(true);
    });

    it('exposes the value and toggle through the audio settings snapshot', () => {
        const snapshot = selectAudioSettingsSnapshot(useAudioSettingsStore.getState());

        expect(snapshot.autoCrossSourceFallback).toBe(true);
        expect(snapshot.handleToggleAutoCrossSourceFallback)
            .toBe(useAudioSettingsStore.getState().handleToggleAutoCrossSourceFallback);
    });
});
