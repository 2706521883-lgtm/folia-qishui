import React from 'react';
import { DEFAULT_WE_BACKGROUND_TUNING } from '../../../../types';
import WeBackground from './WeBackground';
import WeBackgroundSettingsCard from './WeBackgroundSettingsCard';
import WeQuickControls from './WeQuickControls';
import { defineVisualizerBackground } from '../definition';

// src/components/visualizer/backgrounds/we/entry.tsx
// Registers the Wallpaper Engine scene background: a parked engine window captured by the main
// process and drawn behind the player. See docs/wallpaper-engine-background.md.

export default defineVisualizerBackground({
    mode: 'we',
    order: 60,
    labelKey: 'options.visualizerBackgroundModeWe',
    labelFallback: 'Wallpaper Engine',
    render: ({ config, staticMode, windowHidden }) => (
        <WeBackground
            tuning={config?.we?.tuning ?? DEFAULT_WE_BACKGROUND_TUNING}
            // Static mode is the OBS/export path: a captured window there would be a second live
            // surface fighting the exported frame, so the layer stays off.
            enabled={!staticMode}
            // Pausing the track must not freeze the wallpaper: only a hidden window suspends it.
            suspended={windowHidden}
        />
    ),
    renderSettingsPanel: props => (
        <WeBackgroundSettingsCard
            {...props}
            tuning={props.config?.we?.tuning ?? DEFAULT_WE_BACKGROUND_TUNING}
            onTuningChange={props.actions?.we?.onTuningChange}
        />
    ),
    renderQuickControls: ({ config, t, theme }) => (
        <WeQuickControls
            tuning={config?.we?.tuning ?? DEFAULT_WE_BACKGROUND_TUNING}
            theme={theme}
            t={t}
        />
    ),
    resetSettings: actions => actions?.we?.onResetTuning?.(),
});
