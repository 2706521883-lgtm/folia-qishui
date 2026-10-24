import React from 'react';
import type { Theme } from '../../../types';
import type { ThemeSourceModel } from '../../../hooks/themeControllerState';
import SongActionRow from './SongActionRow';
import SoundTiles from './SoundTiles';
import VolumeRow from './VolumeRow';

// src/components/panelTab/controls/PlayerQuickControls.tsx
// The song actions, sound tiles and volume strip from the controls tab. The Qishui player
// sidebar reuses it so its quick-control popover offers the same playback actions as the panel.
export type PlayerQuickControlsProps = {
    isDaylight: boolean;
    loopMode: 'off' | 'all' | 'one';
    onToggleLoop: (event?: React.MouseEvent) => void;
    loopToggleDisabled?: boolean;
    onLike: () => void;
    isLiked: boolean;
    likeDisabled?: boolean;
    likeDisabledReason?: string;
    onGenerateAITheme: () => void;
    isGeneratingTheme: boolean;
    canGenerateAITheme: boolean;
    themeSourceModel: ThemeSourceModel;
    theme: Theme;
    volume: number;
    isMuted: boolean;
    onVolumePreview: (val: number) => void;
    onVolumeChange: (val: number) => void;
    onToggleMute: () => void;
};

const PlayerQuickControls: React.FC<PlayerQuickControlsProps> = ({
    isDaylight,
    loopMode,
    onToggleLoop,
    loopToggleDisabled = false,
    onLike,
    isLiked,
    likeDisabled = false,
    likeDisabledReason,
    onGenerateAITheme,
    isGeneratingTheme,
    canGenerateAITheme,
    themeSourceModel,
    theme,
    volume,
    isMuted,
    onVolumePreview,
    onVolumeChange,
    onToggleMute,
}) => (
    <div className="space-y-4">
        <SongActionRow
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
            isDaylight={isDaylight}
        />

        <SoundTiles
            isDaylight={isDaylight}
            loopMode={loopMode}
            onToggleLoop={onToggleLoop}
            loopToggleDisabled={loopToggleDisabled}
        />

        <div className={`mx-1 my-3 h-px ${isDaylight ? 'bg-black/10' : 'bg-white/10'}`} />

        <VolumeRow
            volume={volume}
            isMuted={isMuted}
            onVolumePreview={onVolumePreview}
            onVolumeChange={onVolumeChange}
            onToggleMute={onToggleMute}
            theme={theme}
            isDaylight={isDaylight}
        />
    </div>
);

export default PlayerQuickControls;
