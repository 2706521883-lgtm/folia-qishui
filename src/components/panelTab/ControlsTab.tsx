import React from 'react';
import { motion } from 'framer-motion';
import { Theme, ThemeMode, VisualizerMode } from '../../types';
import type { ThemeSourceModel } from '../../hooks/themeControllerState';
import AudioEqualizerDialog from './AudioEqualizerDialog';
import AppearanceSection from './controls/AppearanceSection';
import PlayerQuickControls from './controls/PlayerQuickControls';
import ThemeQuickRow from './controls/ThemeQuickRow';

// src/components/panelTab/ControlsTab.tsx
// 控制标签页只负责装配：歌曲动作、音量、外观区，以及底部的当前主题行。

interface ControlsTabProps {
    loopMode: 'off' | 'all' | 'one';
    onToggleLoop: () => void;
    onLike: () => void;
    isLiked: boolean;
    likeDisabled?: boolean;
    likeDisabledReason?: string;
    onGenerateAITheme: () => void;
    isGeneratingTheme: boolean;
    canGenerateAITheme: boolean;
    theme: Theme;
    onThemeChange: (theme: Theme) => void;
    bgMode: ThemeMode;
    onBgModeChange: (mode: ThemeMode) => void;
    hasCustomTheme: boolean;
    themeSourceModel: ThemeSourceModel;
    defaultTheme: Theme;
    daylightTheme: Theme;
    visualizerMode: VisualizerMode;
    onVisualizerModeChange: (mode: VisualizerMode) => void;
    useCoverColorBg: boolean;
    onToggleCoverColorBg: (enable: boolean) => void;
    isDaylight: boolean;
    onToggleDaylight: () => void;
    volume: number;
    isMuted: boolean;
    onVolumePreview: (val: number) => void;
    onVolumeChange: (val: number) => void;
    onToggleMute: () => void;
    loopToggleDisabled?: boolean;
    onClosePanel?: () => void;
}

const ControlsTab: React.FC<ControlsTabProps> = ({
    loopMode,
    onToggleLoop,
    onLike,
    isLiked,
    likeDisabled = false,
    likeDisabledReason,
    onGenerateAITheme,
    isGeneratingTheme,
    canGenerateAITheme,
    theme,
    onThemeChange,
    onBgModeChange,
    hasCustomTheme,
    themeSourceModel,
    defaultTheme,
    daylightTheme,
    visualizerMode,
    onVisualizerModeChange,
    useCoverColorBg,
    onToggleCoverColorBg,
    isDaylight,
    onToggleDaylight,
    volume,
    isMuted,
    onVolumePreview,
    onVolumeChange,
    onToggleMute,
    loopToggleDisabled = false,
    onClosePanel,
}) => {
    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="relative"
        >
            <div className="space-y-4">
                <PlayerQuickControls
                    isDaylight={isDaylight}
                    loopMode={loopMode}
                    onToggleLoop={onToggleLoop}
                    loopToggleDisabled={loopToggleDisabled}
                    onLike={onLike}
                    isLiked={isLiked}
                    likeDisabled={likeDisabled}
                    likeDisabledReason={likeDisabledReason}
                    onGenerateAITheme={onGenerateAITheme}
                    isGeneratingTheme={isGeneratingTheme}
                    canGenerateAITheme={canGenerateAITheme}
                    themeSourceModel={themeSourceModel}
                    theme={theme}
                    volume={volume}
                    isMuted={isMuted}
                    onVolumePreview={onVolumePreview}
                    onVolumeChange={onVolumeChange}
                    onToggleMute={onToggleMute}
                />

                <div className="space-y-3">
                    <AppearanceSection
                        theme={theme}
                        onThemeChange={onThemeChange}
                        isDaylight={isDaylight}
                        visualizerMode={visualizerMode}
                        onVisualizerModeChange={onVisualizerModeChange}
                        useCoverColorBg={useCoverColorBg}
                        onToggleCoverColorBg={onToggleCoverColorBg}
                        themeSourceModel={themeSourceModel}
                        onBgModeChange={onBgModeChange}
                        hasCustomTheme={hasCustomTheme}
                        defaultTheme={defaultTheme}
                        daylightTheme={daylightTheme}
                        onClosePanel={onClosePanel}
                    />
                </div>

                <div className={`mx-1 my-3 h-px ${isDaylight ? 'bg-black/10' : 'bg-white/10'}`} />

                <ThemeQuickRow
                    theme={theme}
                    themeSourceModel={themeSourceModel}
                    defaultTheme={defaultTheme}
                    daylightTheme={daylightTheme}
                    isDaylight={isDaylight}
                    onToggleDaylight={onToggleDaylight}
                />

            </div>

            <AudioEqualizerDialog isDaylight={isDaylight} theme={theme} />

        </motion.div>
    );
};

export default ControlsTab;
