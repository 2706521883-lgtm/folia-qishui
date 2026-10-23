import type { PersonalFmModeCatalog, PersonalFmModeEntry } from '../../types/onlineMusic';

// src/services/onlineMusic/qishuiFeedModes.ts
// Qishui's "listening mode" catalogue and the feed_preference payload the official PC client
// sends. Scene modes use scene_mode_id; familiar/fresh use preference_mode. The default mode is
// the absence of a preference, so it sends nothing.
//
// The catalogue is fetched from /luna/pc/feed/mode at runtime; nothing here hardcodes the 45
// scenes, so a scene added upstream appears without a client release.

export type QishuiFeedPreference = {
    scene_mode_id?: number;
    preference_mode?: 'familiar' | 'fresh';
};

export type QishuiFeedModeSelection = Pick<PersonalFmModeEntry, 'id' | 'kind' | 'text'> & {
    preferenceMode?: string;
    sceneModeId?: number;
    subQueueType?: string;
    iconUrl?: string;
};

export const getQishuiModePreference = (
    mode: QishuiFeedModeSelection | null | undefined,
): QishuiFeedPreference | null => {
    if (!mode) return null;
    if (mode.kind === 'scene' && Number.isFinite(Number(mode.sceneModeId)) && Number(mode.sceneModeId) > 0) {
        return { scene_mode_id: Math.trunc(Number(mode.sceneModeId)) };
    }
    return /^(familiar|fresh)$/.test(String(mode.preferenceMode || ''))
        ? { preference_mode: mode.preferenceMode as 'familiar' | 'fresh' }
        : null;
};

export const isSameQishuiFeedMode = (
    left: QishuiFeedModeSelection | null | undefined,
    right: QishuiFeedModeSelection | null | undefined,
): boolean => {
    if (!left || !right) return left === right;
    return left.id === right.id;
};

export const getQishuiModeLabel = (mode: QishuiFeedModeSelection | null | undefined): string => (
    mode && mode.text ? mode.text : '推荐'
);

export const splitQishuiModeCatalog = (catalog: PersonalFmModeCatalog | null | undefined) => {
    const modes = Array.isArray(catalog?.modes) ? catalog.modes : [];
    return {
        preferences: modes.filter(entry => entry.kind === 'preference'),
        scenes: modes.filter(entry => entry.kind === 'scene'),
    };
};

export type { PersonalFmModeCatalog, PersonalFmModeEntry };
