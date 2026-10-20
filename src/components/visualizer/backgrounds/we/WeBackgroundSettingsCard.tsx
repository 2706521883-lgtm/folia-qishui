import React, { useEffect } from 'react';
import { Play, RefreshCw, Square } from 'lucide-react';
import type { Theme, WeBackgroundTuning } from '../../../../types';
import { colorWithAlpha } from '../../colorMix';
import BackgroundToggleRow from '../BackgroundToggleRow';
import { subscribeWallpaperEngineStatus, useWallpaperEngineStore } from '../../../../stores/useWallpaperEngineStore';
import WeWallpaperPicker from './WeWallpaperPicker';

// src/components/visualizer/backgrounds/we/WeBackgroundSettingsCard.tsx
// Wallpaper Engine background settings: library scanning, wallpaper selection, session control and
// the capture transform sliders.

interface WeBackgroundSettingsCardProps {
    t: (key: string) => string;
    isDaylight: boolean;
    theme: Theme;
    controlCardBg: string;
    rangeInputClass: string;
    tuning: WeBackgroundTuning;
    onTuningChange?: (patch: Partial<WeBackgroundTuning>) => void;
    onSliderPointerDown?: () => void;
    onSliderCommit?: () => void;
}

interface SliderRowProps {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    format: (value: number) => string;
    theme: Theme;
    rangeInputClass: string;
    onChange: (value: number) => void;
    onPointerDown?: () => void;
    onPointerUp?: () => void;
}

const SliderRow: React.FC<SliderRowProps> = ({
    label,
    value,
    min,
    max,
    step,
    format,
    theme,
    rangeInputClass,
    onChange,
    onPointerDown,
    onPointerUp,
}) => (
    <label className="block space-y-2">
        <span className="flex justify-between gap-3 text-sm" style={{ color: theme.primaryColor }}>
            <span>{label}</span>
            <span className="font-mono opacity-70">{format(value)}</span>
        </span>
        <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={event => onChange(Number(event.target.value))}
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
            className={rangeInputClass}
        />
    </label>
);

const WeBackgroundSettingsCard: React.FC<WeBackgroundSettingsCardProps> = ({
    t,
    isDaylight,
    theme,
    controlCardBg,
    rangeInputClass,
    tuning,
    onTuningChange,
    onSliderPointerDown,
    onSliderCommit,
}) => {
    const supported = useWallpaperEngineStore(state => state.supported);
    const phase = useWallpaperEngineStore(state => state.phase);
    const engineReady = useWallpaperEngineStore(state => state.engineReady);
    const executable = useWallpaperEngineStore(state => state.executable);
    const runtimeError = useWallpaperEngineStore(state => state.runtimeError);
    const hasScanned = useWallpaperEngineStore(state => state.hasScanned);
    const total = useWallpaperEngineStore(state => state.total);
    const steamRoots = useWallpaperEngineStore(state => state.steamRoots);
    const isLoadingLibrary = useWallpaperEngineStore(state => state.isLoadingLibrary);
    const refreshLibrary = useWallpaperEngineStore(state => state.refreshLibrary);
    const startSession = useWallpaperEngineStore(state => state.startSession);
    const stopSession = useWallpaperEngineStore(state => state.stopSession);

    useEffect(() => subscribeWallpaperEngineStatus(), []);

    // Opening the panel is the user asking "what do I have?" — scan once, then let them refresh.
    useEffect(() => {
        if (supported && !hasScanned && !isLoadingLibrary) void refreshLibrary(false);
    }, [supported, hasScanned, isLoadingLibrary, refreshLibrary]);

    const borderColor = colorWithAlpha(theme.secondaryColor, isDaylight ? 0.18 : 0.16);
    const sessionRunning = phase === 'running' && Boolean(tuning.itemId);
    const busy = phase === 'starting' || phase === 'stopping';
    const statusText = !supported
        ? t('options.weUnsupported')
        : runtimeError
            ? t('options.weError').replace('{error}', runtimeError)
            : sessionRunning
                ? (tuning.muteAudio ? t('options.weStatusMuted') : t('options.weStatusPlaying'))
                : engineReady
                    ? t('options.weStatusReady')
                    : hasScanned && steamRoots.length === 0
                        ? t('options.weStatusNoSteam')
                        : t('options.weStatusIdle');

    const actionButton = (label: string, onClick: () => void, icon: React.ReactNode, disabled: boolean) => (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className="flex h-8 items-center gap-1.5 rounded-lg border px-3 text-xs font-medium transition-opacity disabled:opacity-40"
            style={{ borderColor, color: theme.primaryColor }}
        >
            {icon}
            {label}
        </button>
    );

    return (
        <div className="rounded-[24px] border p-4 space-y-5" style={{ backgroundColor: controlCardBg, borderColor }}>
            <div className="space-y-1">
                <div className="text-sm font-medium" style={{ color: theme.primaryColor }}>
                    {t('options.weBackgroundSettings')}
                </div>
                <div className="text-xs opacity-70" style={{ color: theme.secondaryColor }}>
                    {t('options.weBackgroundSettingsDesc')}
                </div>
                <div className="pt-1 text-xs" style={{ color: theme.secondaryColor }} title={executable || undefined}>
                    {statusText}
                </div>
            </div>

            <div className="flex flex-wrap gap-2">
                {actionButton(
                    hasScanned ? t('options.weRescan') : t('options.weScan'),
                    () => void refreshLibrary(hasScanned),
                    <RefreshCw size={13} />,
                    !supported,
                )}
                {sessionRunning
                    ? actionButton(t('options.weStop'), () => void stopSession(), <Square size={13} />, busy)
                    : actionButton(
                        t('options.weStart'),
                        () => void startSession(tuning.itemId, tuning.muteAudio),
                        <Play size={13} />,
                        !supported || !tuning.itemId || busy,
                    )}
                <button
                    type="button"
                    onClick={() => {
                        void stopSession();
                        onTuningChange?.({ itemId: '', itemTitle: '' });
                    }}
                    disabled={!tuning.itemId && phase === 'idle'}
                    className="h-8 rounded-lg border px-3 text-xs transition-opacity disabled:opacity-40"
                    style={{ borderColor, color: theme.secondaryColor }}
                >
                    {t('options.weClear')}
                </button>
            </div>

            {tuning.itemId ? (
                <div className="flex items-center gap-3 rounded-xl border p-2" style={{ borderColor }}>
                    <img
                        src={`folia-we://preview/${tuning.itemId}`}
                        alt=""
                        className="h-12 w-20 shrink-0 rounded-md object-cover bg-black/20"
                    />
                    <div className="min-w-0 flex-1">
                        <div className="truncate text-sm" style={{ color: theme.primaryColor }}>
                            {tuning.itemTitle || tuning.itemId}
                        </div>
                        <div className="text-[11px] opacity-60" style={{ color: theme.secondaryColor }}>
                            {t('options.weSceneType')}
                        </div>
                    </div>
                </div>
            ) : null}

            {/* The library sits directly under the current wallpaper, before the capture sliders:
                choosing a wallpaper is the reason this card was opened. */}
            {supported && hasScanned && total > 0 ? (
                <WeWallpaperPicker
                    t={t}
                    theme={theme}
                    isDaylight={isDaylight}
                    selectedId={tuning.itemId}
                    onSelect={(itemId, itemTitle) => {
                        onTuningChange?.({ itemId, itemTitle });
                        void startSession(itemId, tuning.muteAudio);
                    }}
                />
            ) : null}

            <BackgroundToggleRow
                label={t('options.weAutoStart')}
                description={t('options.weAutoStartDesc')}
                checked={tuning.autoStart}
                onChange={autoStart => onTuningChange?.({ autoStart })}
                theme={theme}
            />
            <BackgroundToggleRow
                label={t('options.weMuteAudio')}
                description={t('options.weMuteAudioDesc')}
                checked={tuning.muteAudio}
                onChange={muteAudio => onTuningChange?.({ muteAudio })}
                theme={theme}
            />

            <div className="space-y-4">
                <SliderRow
                    label={t('options.weOpacity')}
                    value={tuning.opacity}
                    min={0.15}
                    max={1}
                    step={0.01}
                    format={value => `${Math.round(value * 100)}%`}
                    theme={theme}
                    rangeInputClass={rangeInputClass}
                    onChange={opacity => onTuningChange?.({ opacity })}
                    onPointerDown={onSliderPointerDown}
                    onPointerUp={onSliderCommit}
                />
                <SliderRow
                    label={t('options.weScale')}
                    value={tuning.scale}
                    min={1}
                    max={1.6}
                    step={0.01}
                    format={value => `${value.toFixed(2)}x`}
                    theme={theme}
                    rangeInputClass={rangeInputClass}
                    onChange={scale => onTuningChange?.({ scale })}
                    onPointerDown={onSliderPointerDown}
                    onPointerUp={onSliderCommit}
                />
                <SliderRow
                    label={t('options.weOffsetX')}
                    value={tuning.offsetX}
                    min={-50}
                    max={50}
                    step={1}
                    format={value => `${value}%`}
                    theme={theme}
                    rangeInputClass={rangeInputClass}
                    onChange={offsetX => onTuningChange?.({ offsetX })}
                    onPointerDown={onSliderPointerDown}
                    onPointerUp={onSliderCommit}
                />
                <SliderRow
                    label={t('options.weOffsetY')}
                    value={tuning.offsetY}
                    min={-50}
                    max={50}
                    step={1}
                    format={value => `${value}%`}
                    theme={theme}
                    rangeInputClass={rangeInputClass}
                    onChange={offsetY => onTuningChange?.({ offsetY })}
                    onPointerDown={onSliderPointerDown}
                    onPointerUp={onSliderCommit}
                />
                <SliderRow
                    label={t('options.weFrameRate')}
                    value={tuning.frameRate}
                    min={15}
                    max={60}
                    step={5}
                    format={value => `${value} fps`}
                    theme={theme}
                    rangeInputClass={rangeInputClass}
                    onChange={frameRate => onTuningChange?.({ frameRate })}
                    onPointerDown={onSliderPointerDown}
                    onPointerUp={onSliderCommit}
                />
            </div>

        </div>
    );
};

export default WeBackgroundSettingsCard;
