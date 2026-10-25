import React from 'react';
import { defineVisualizer } from '../definition';
import { ClassicSettingsPanel } from '../settingsPanels';

const VisualizerLivingWood = React.lazy(() => import('./VisualizerLivingWood'));

// src/components/visualizer/livingwood/entry.tsx
// Registers the private material-lyric preset. Existing modes are untouched.
export default defineVisualizer({
    mode: 'livingwood',
    order: 140,
    labelKey: 'ui.visualizerLivingWood',
    labelFallback: '枯木生花',
    previewSeed: 'livingwood',
    previewStartOffset: 0,
    tuningKind: 'classic',
    render: props => <VisualizerLivingWood {...props} />,
    renderSettingsPanel: props => <ClassicSettingsPanel {...props} />,
    resetSettings: ({ resetClassicTuning }) => {
        resetClassicTuning?.();
    },
});
