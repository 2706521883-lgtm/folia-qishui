import React from 'react';
import { Power } from 'lucide-react';
import type { Theme, WeBackgroundTuning } from '../../../../types';
import { QuickControlToggle } from '../../../shared/QuickControlChip';
import { useWallpaperEngineStore } from '../../../../stores/useWallpaperEngineStore';

// src/components/visualizer/backgrounds/we/WeQuickControls.tsx
// Player-console shortcut for the Wallpaper Engine background: starts or stops the parked playback
// window without opening the settings panel.

interface WeQuickControlsProps {
    tuning: WeBackgroundTuning;
    theme: Theme;
    t: (key: string) => string;
}

const WeQuickControls: React.FC<WeQuickControlsProps> = ({ tuning, theme, t }) => {
    const phase = useWallpaperEngineStore(state => state.phase);
    const activeItemId = useWallpaperEngineStore(state => state.activeItemId);
    const startSession = useWallpaperEngineStore(state => state.startSession);
    const stopSession = useWallpaperEngineStore(state => state.stopSession);

    if (!tuning.itemId) return null;

    const running = phase === 'running' && activeItemId === tuning.itemId;
    const busy = phase === 'starting' || phase === 'stopping';
    const label = running ? t('options.weQuickStop') : t('options.weQuickStart');

    return (
        <QuickControlToggle
            active={running}
            theme={theme}
            label={label}
            onToggle={() => {
                if (busy) return;
                if (running) {
                    void stopSession();
                } else {
                    void startSession(tuning.itemId, tuning.muteAudio);
                }
            }}
        >
            <Power size={14} />
        </QuickControlToggle>
    );
};

export default WeQuickControls;
