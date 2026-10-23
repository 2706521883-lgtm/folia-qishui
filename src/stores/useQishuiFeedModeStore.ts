import { create } from 'zustand';
import {
    getQishuiModePreference,
    type QishuiFeedModeSelection,
    type QishuiFeedPreference,
} from '../services/onlineMusic/qishuiFeedModes';

// src/stores/useQishuiFeedModeStore.ts
// The selected Qishui "listening mode". The provider reads it through getQishuiFeedPreference()
// on every feed call, so queue refills and the home preview stay on the same mode without
// threading the selection through each caller. null means the default recommendation feed.

const STORAGE_KEY = 'folia.qishui.feedMode';

const normalizeStoredMode = (raw: unknown): QishuiFeedModeSelection | null => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const candidate = raw as Record<string, unknown>;
    const id = typeof candidate.id === 'string' ? candidate.id : '';
    const kind = candidate.kind === 'scene' ? 'scene' : candidate.kind === 'preference' ? 'preference' : '';
    const text = typeof candidate.text === 'string' ? candidate.text : '';
    if (!id || !kind || !text) return null;
    if (kind === 'scene') {
        const sceneModeId = Number(candidate.sceneModeId);
        if (!Number.isFinite(sceneModeId) || sceneModeId <= 0) return null;
        return {
            id,
            kind,
            text,
            sceneModeId: Math.trunc(sceneModeId),
            subQueueType: typeof candidate.subQueueType === 'string' ? candidate.subQueueType : '',
            iconUrl: typeof candidate.iconUrl === 'string' ? candidate.iconUrl : '',
        };
    }
    const preferenceMode = typeof candidate.preferenceMode === 'string' ? candidate.preferenceMode : '';
    if (!/^(familiar|fresh)$/.test(preferenceMode)) return null;
    return { id, kind, text, preferenceMode };
};

const readStoredMode = (): QishuiFeedModeSelection | null => {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? normalizeStoredMode(JSON.parse(raw)) : null;
    } catch {
        return null;
    }
};

const writeStoredMode = (selection: QishuiFeedModeSelection | null) => {
    try {
        if (selection) localStorage.setItem(STORAGE_KEY, JSON.stringify(selection));
        else localStorage.removeItem(STORAGE_KEY);
    } catch {
        // Persistence is best effort; the picker still changes the current session.
    }
};

type QishuiFeedModeState = {
    selection: QishuiFeedModeSelection | null;
    setSelection: (selection: QishuiFeedModeSelection | null) => QishuiFeedModeSelection | null;
};

export const useQishuiFeedModeStore = create<QishuiFeedModeState>((set) => ({
    selection: readStoredMode(),
    setSelection: (selection) => {
        const normalized = normalizeStoredMode(selection);
        set({ selection: normalized });
        writeStoredMode(normalized);
        return normalized;
    },
}));

export const getQishuiFeedMode = (): QishuiFeedModeSelection | null => (
    useQishuiFeedModeStore.getState().selection
);

export const getQishuiFeedPreference = (): QishuiFeedPreference | null => (
    getQishuiModePreference(getQishuiFeedMode())
);
