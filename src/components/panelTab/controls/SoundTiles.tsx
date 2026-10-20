import React from 'react';
import { Blend, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useAutomixSettingsStore } from '../../../stores/useAutomixSettingsStore';
import { useAudioSettingsStore } from '../../../stores/useAudioSettingsStore';

// src/components/panelTab/controls/SoundTiles.tsx
// 控制页的第二排快捷块：智能过渡与均衡器。循环/喜欢/AI 主题仍在上一排的大按钮里；
// 这两项原来只能去设置或命令面板找，放到面板里一眼可见。

type TileProps = {
    icon: React.ReactNode;
    label: string;
    lit: boolean;
    isDaylight: boolean;
    onClick: () => void;
};

const Tile: React.FC<TileProps> = ({ icon, label, lit, isDaylight, onClick }) => (
    <button
        type="button"
        aria-pressed={lit}
        onClick={onClick}
        className={`flex min-h-[54px] min-w-0 flex-col items-start justify-between gap-1.5 rounded-xl px-3 py-2 text-left transition-all active:scale-[0.97] ${lit
            ? isDaylight
                ? 'bg-zinc-900 text-white shadow-sm'
                : 'bg-white/15 text-white shadow-sm'
            : isDaylight
                ? 'bg-black/5 text-zinc-600 hover:bg-black/10'
                : 'bg-white/5 text-zinc-300 hover:bg-white/10'}`}
    >
        <span className={lit ? 'text-orange-300' : isDaylight ? 'text-zinc-500' : 'text-zinc-400'}>{icon}</span>
        <span className="w-full truncate text-[11px] font-semibold leading-tight">{label}</span>
    </button>
);

const SoundTiles: React.FC<{ isDaylight: boolean }> = ({ isDaylight }) => {
    const { t } = useTranslation();
    const automixEnabled = useAutomixSettingsStore(state => state.automixEnabled);
    const handleToggleAutomix = useAutomixSettingsStore(state => state.handleToggleAutomix);
    const isEqualizerOn = useAudioSettingsStore(state => state.audioEqualizerSettings.enabled);
    const openAudioEqualizer = useAudioSettingsStore(state => state.openAudioEqualizer);

    return (
        <div className="mt-2 grid grid-cols-2 gap-2">
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
