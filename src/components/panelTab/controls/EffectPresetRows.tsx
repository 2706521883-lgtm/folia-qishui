import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Theme, VisualizerBackgroundMode, VisualizerMode } from '../../../types';
import { getVisualizerModeLabel, getVisualizerRegistryEntry, VISUALIZER_REGISTRY } from '../../visualizer/registry';
import {
    getVisualizerBackgroundModeLabel,
    getVisualizerBackgroundRegistryEntry,
    VISUALIZER_BACKGROUND_REGISTRY,
} from '../../visualizer/backgrounds/registry';
import { resolveVisualizerBackgroundMode } from '../../../stores/visualizerSettingsPersistence';
import { useVisualizerModeStepper } from '../../../hooks/useVisualizerModeStepper';
import { QuickControlChip, QuickControlToggle } from '../../shared/QuickControlChip';
import { WholeWord } from 'lucide-react';
import { openCommandPaletteCommand } from '../../../stores/useAppViewStore';
import { useLyricSegmentationStore } from '../../../stores/useLyricSegmentationStore';
import { LYRIC_SEGMENTATION_COMMAND_ID } from '../../command-palette/commands/lyricSegmentationCommand';
import ModeStepperRow from './ModeStepperRow';
import { BackgroundModeGlyph, VisualizerModeGlyph } from '../../visualizer/modeGlyphs';
import { useVisualizerSettingsStore } from '../../../stores/useVisualizerSettingsStore';
import { useThemeSettingsStore } from '../../../stores/useThemeSettingsStore';
import { useSettingsModalStore } from '../../../stores/useSettingsModalStore';

// src/components/panelTab/controls/EffectPresetRows.tsx
// The two appearance quick pickers (lyrics style + background) extracted for the compact Qishui
// player sidebar. The player panel keeps its fuller AppearanceSection; both read the same stores,
// so changing a mode here is immediately reflected in the panel and the live player.
type EffectPresetRowsProps = {
    theme: Theme;
    onThemeChange: (theme: Theme) => void;
    isDaylight: boolean;
    visualizerMode: VisualizerMode;
    onVisualizerModeChange: (mode: VisualizerMode) => void;
    onClosePanel?: () => void;
};

const ANIMATION_INTENSITIES: Theme['animationIntensity'][] = ['calm', 'normal', 'chaotic'];

const EffectPresetRows: React.FC<EffectPresetRowsProps> = ({
    theme,
    onThemeChange,
    isDaylight,
    visualizerMode,
    onVisualizerModeChange,
    onClosePanel,
}) => {
    const { t } = useTranslation();
    const openSettings = useSettingsModalStore(state => state.openSettings);
    const useCoverColorBg = useThemeSettingsStore(state => state.useCoverColorBg);
    const onToggleCoverColorBg = useThemeSettingsStore(state => state.handleToggleCoverColorBg);
    const usesWordSegmentation = Boolean(getVisualizerRegistryEntry(visualizerMode).usesWordSegmentation);
    const hasSavedSegmentation = useLyricSegmentationStore(state => Boolean(state.record));
    const visualizerBackgroundMode = useVisualizerSettingsStore(state => state.visualizerBackgroundMode);
    const setVisualizerBackgroundMode = useVisualizerSettingsStore(state => state.handleSetVisualizerBackgroundMode);
    const monetBackgroundTuning = useVisualizerSettingsStore(state => state.monetBackgroundTuning);
    const setMonetBackgroundTuning = useVisualizerSettingsStore(state => state.handleSetMonetBackgroundTuning);
    const nomandBackgroundTuning = useVisualizerSettingsStore(state => state.nomandBackgroundTuning);
    const setNomandBackgroundTuning = useVisualizerSettingsStore(state => state.handleSetNomandBackgroundTuning);
    const latentBackgroundTuning = useVisualizerSettingsStore(state => state.latentBackgroundTuning);
    const setLatentBackgroundTuning = useVisualizerSettingsStore(state => state.handleSetLatentBackgroundTuning);
    const soraBackgroundTuning = useVisualizerSettingsStore(state => state.soraBackgroundTuning);
    const setSoraBackgroundTuning = useVisualizerSettingsStore(state => state.handleSetSoraBackgroundTuning);
    const weBackgroundTuning = useVisualizerSettingsStore(state => state.weBackgroundTuning);
    const setWeBackgroundTuning = useVisualizerSettingsStore(state => state.handleSetWeBackgroundTuning);

    const visualizerOptions = useMemo(
        () => VISUALIZER_REGISTRY.map(entry => ({
            value: entry.mode,
            label: getVisualizerModeLabel(entry.mode, t),
        })),
        [t],
    );
    const visualizerModes = useMemo(() => visualizerOptions.map(option => option.value), [visualizerOptions]);
    const stepVisualizerMode = useVisualizerModeStepper(visualizerModes);

    const backgroundOptions = useMemo(
        () => VISUALIZER_BACKGROUND_REGISTRY.map(entry => ({
            value: entry.mode,
            label: getVisualizerBackgroundModeLabel(entry.mode, t),
        })),
        [t],
    );
    const resolvedBackgroundMode = resolveVisualizerBackgroundMode(visualizerBackgroundMode, visualizerMode);
    const steppableBackgroundOptions = backgroundOptions.filter(option => option.value !== 'we');

    const stepBackgroundMode = (direction: -1 | 1) => {
        if (steppableBackgroundOptions.length < 2) return;
        const index = steppableBackgroundOptions.findIndex(option => option.value === resolvedBackgroundMode);
        const anchor = index < 0 ? (direction === 1 ? -1 : 0) : index;
        const nextIndex = (anchor + direction + steppableBackgroundOptions.length) % steppableBackgroundOptions.length;
        setVisualizerBackgroundMode(steppableBackgroundOptions[nextIndex].value);
    };

    const openVisualizerSettings = () => {
        openSettings('options', 'visualizer', 'visualizer');
        onClosePanel?.();
    };
    const openBackgroundSettings = () => {
        openSettings('options', 'visualizer', 'background');
        onClosePanel?.();
    };
    const cycleAnimationIntensity = () => {
        const currentIndex = ANIMATION_INTENSITIES.indexOf(theme.animationIntensity);
        onThemeChange({
            ...theme,
            animationIntensity: ANIMATION_INTENSITIES[(currentIndex + 1) % ANIMATION_INTENSITIES.length],
        });
    };

    const backgroundQuickControls = getVisualizerBackgroundRegistryEntry(resolvedBackgroundMode).renderQuickControls?.({
        config: {
            common: { useCoverColorBg },
            monet: { tuning: monetBackgroundTuning },
            nomand: { tuning: nomandBackgroundTuning },
            latent: { tuning: latentBackgroundTuning },
            sora: { tuning: soraBackgroundTuning },
            we: { tuning: weBackgroundTuning },
        },
        actions: {
            common: { onCoverColorChange: onToggleCoverColorBg },
            monet: { onTuningChange: setMonetBackgroundTuning },
            nomand: { onTuningChange: setNomandBackgroundTuning },
            latent: { onTuningChange: setLatentBackgroundTuning },
            sora: { onTuningChange: setSoraBackgroundTuning },
            we: { onTuningChange: setWeBackgroundTuning },
        },
        t,
        isDaylight,
        theme,
    });

    return (
        <div data-ponder="lyric-style" className="space-y-1">
            <ModeStepperRow<VisualizerMode>
                value={visualizerMode}
                options={visualizerOptions}
                onSelect={onVisualizerModeChange}
                onStep={stepVisualizerMode}
                renderGlyph={mode => <VisualizerModeGlyph mode={mode} />}
                ariaLabel={t('ui.animationMode')}
                moreLabel={t('ui.moreSettings')}
                onOpenMore={openVisualizerSettings}
                isDaylight={isDaylight}
                primaryColor={theme.primaryColor}
                trailing={(
                    <>
                        <QuickControlChip
                            isDaylight={isDaylight}
                            label={t(`animation.${theme.animationIntensity}`)}
                            title={`${t('ui.animationIntensity')}: ${t(`animation.${theme.animationIntensity}`)}`}
                            onClick={cycleAnimationIntensity}
                        />
                        {usesWordSegmentation && (
                            <QuickControlToggle
                                active={hasSavedSegmentation}
                                theme={theme}
                                label={t('commandPalette.commands.lyric-segmentation.title')}
                                onToggle={() => {
                                    openCommandPaletteCommand(LYRIC_SEGMENTATION_COMMAND_ID);
                                    onClosePanel?.();
                                }}
                            >
                                <WholeWord size={14} />
                            </QuickControlToggle>
                        )}
                    </>
                )}
            />
            <ModeStepperRow<VisualizerBackgroundMode>
                value={resolvedBackgroundMode}
                options={backgroundOptions}
                hiddenValues={['we']}
                onSelect={setVisualizerBackgroundMode}
                onStep={stepBackgroundMode}
                renderGlyph={mode => <BackgroundModeGlyph mode={mode} />}
                ariaLabel={t('options.visualizerBackgroundMode')}
                moreLabel={t('ui.moreSettings')}
                onOpenMore={openBackgroundSettings}
                isDaylight={isDaylight}
                primaryColor={theme.primaryColor}
                trailing={backgroundQuickControls}
            />
        </div>
    );
};

export default EffectPresetRows;
