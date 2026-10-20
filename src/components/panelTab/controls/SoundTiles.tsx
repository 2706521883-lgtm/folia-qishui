import React from 'react';
import { Blend, Repeat, Repeat1, RepeatOff, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAutomixSettingsStore } from '../../../stores/useAutomixSettingsStore';
import { useAudioSettingsStore } from '../../../stores/useAudioSettingsStore';

// src/components/panelTab/controls/SoundTiles.tsx
// 控制页音量下面的三块：循环（名字就是当前状态）、智能过渡、均衡器。
// 这三项原来分散在上一排的大按钮、设置和命令面板里，现在一眼可见。

type TileProps = {
    icon: React.ReactNode;
    label: string;
    lit: boolean;
    isDaylight: boolean;
    onClick: () => void;
    disabled?: boolean;
};

const Tile: React.FC<TileProps> = ({ icon, label, lit, isDaylight, onClick, disabled }) => (
    <button
        type="button"
        aria-pressed={lit}
        onClick={onClick}
        disabled={disabled}
        className={`flex min-h-16 min-w-0 flex-col justify-between gap-2 rounded-[10px] px-2.5 pb-[9px] pt-2.5 text-left text-xs leading-4 transition-[background-color,color,box-shadow,scale] enabled:active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40 ${lit
            ? isDaylight
                ? 'bg-zinc-900 text-white shadow-sm'
                : 'bg-white/15 text-white shadow-sm'
            : isDaylight
                ? 'bg-black/5 text-zinc-600 enabled:hover:bg-black/10'
                : 'bg-white/5 text-zinc-300 enabled:hover:bg-white/10'}`}
    >
        <span className={lit ? 'text-orange-300' : isDaylight ? 'text-zinc-500' : 'text-zinc-400'}>{icon}</span>
        <span className="w-full truncate font-semibold leading-tight">{label}</span>
    </button>
);

interface SoundTilesProps {
    isDaylight: boolean;
    loopMode: 'off' | 'all' | 'one';
    onToggleLoop: () => void;
    loopToggleDisabled?: boolean;
}

const SoundTiles: React.FC<SoundTilesProps> = ({ isDaylight, loopMode, onToggleLoop, loopToggleDisabled = false }) => {
    const { t } = useTranslation();
    const automixEnabled = useAutomixSettingsStore(state => state.automixEnabled);
    const handleToggleAutomix = useAutomixSettingsStore(state => state.handleToggleAutomix);
    const isEqualizerOn = useAudioSettingsStore(state => state.audioEqualizerSettings.enabled);
    const openAudioEqualizer = useAudioSettingsStore(state => state.openAudioEqualizer);
    const loopLabel = loopMode === 'off' ? t('player.loopOff') : loopMode === 'one' ? t('player.loopOne') : t('player.loopAll');

    return (
        <div className="mt-2 grid grid-cols-3 gap-2">
            <Tile
                icon={loopMode === 'off' ? <RepeatOff size={18} /> : loopMode === 'one' ? <Repeat1 size={18} /> : <Repeat size={18} />}
                label={loopLabel}
                lit={loopMode !== 'off'}
                isDaylight={isDaylight}
                disabled={loopToggleDisabled}
                onClick={onToggleLoop}
            />
            <Tile
                icon={<Blend size={18} />}
                label={t('ui.automix')}
                lit={automixEnabled}
                isDaylight={isDaylight}
                onClick={() => handleToggleAutomix(!automixEnabled)}
            />
            <Tile
                icon={<SlidersHorizontal size={18} />}
                label={t('ui.equalizerTitle')}
                lit={isEqualizerOn}
                isDaylight={isDaylight}
                onClick={openAudioEqualizer}
            />
        </div>
    );
};

export default SoundTiles;
