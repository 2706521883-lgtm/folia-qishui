import React, { useMemo, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { Theme } from '../../../../types';
import { colorWithAlpha } from '../../colorMix';
import { useWallpaperEngineStore } from '../../../../stores/useWallpaperEngineStore';

// src/components/visualizer/backgrounds/we/WeWallpaperPicker.tsx
// Searchable grid over the scanned Wallpaper Engine library. Only projects the engine can actually
// play (scene type with a valid PKGV package) are listed.

interface WeWallpaperPickerProps {
    t: (key: string) => string;
    theme: Theme;
    isDaylight: boolean;
    selectedId: string;
    onSelect: (itemId: string, title: string) => void;
}

const WeWallpaperPicker: React.FC<WeWallpaperPickerProps> = ({ t, theme, isDaylight, selectedId, onSelect }) => {
    const items = useWallpaperEngineStore(state => state.items);
    const hasScanned = useWallpaperEngineStore(state => state.hasScanned);
    const isLoadingLibrary = useWallpaperEngineStore(state => state.isLoadingLibrary);
    const refreshLibrary = useWallpaperEngineStore(state => state.refreshLibrary);
    const [query, setQuery] = useState('');

    const playable = useMemo(() => {
        const keyword = query.trim().toLowerCase();
        return items
            .filter(item => item.enginePlayable)
            .filter(item => !keyword || item.title.toLowerCase().includes(keyword));
    }, [items, query]);

    const skipped = useMemo(() => items.filter(item => !item.enginePlayable).length, [items]);
    const borderColor = colorWithAlpha(theme.secondaryColor, isDaylight ? 0.18 : 0.16);

    return (
        <div className="space-y-3">
            <div className="flex items-center gap-2">
                <input
                    value={query}
                    onChange={event => setQuery(event.target.value)}
                    placeholder={t('options.weSearchPlaceholder')}
                    className="h-8 min-w-0 flex-1 rounded-lg border px-2 text-xs outline-none"
                    style={{
                        backgroundColor: colorWithAlpha(theme.backgroundColor, 0.5),
                        borderColor,
                        color: theme.primaryColor,
                    }}
                />
                <button
                    type="button"
                    onClick={() => void refreshLibrary(true)}
                    disabled={isLoadingLibrary}
                    title={t('options.weRefresh')}
                    aria-label={t('options.weRefresh')}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-opacity disabled:opacity-40"
                    style={{ borderColor, color: theme.secondaryColor }}
                >
                    <RefreshCw size={14} className={isLoadingLibrary ? 'animate-spin' : undefined} />
                </button>
            </div>

            {playable.length === 0 ? (
                <div className="rounded-xl border px-3 py-6 text-center text-xs opacity-70" style={{ borderColor, color: theme.secondaryColor }}>
                    {hasScanned ? t('options.weEmpty') : t('options.weScanHint')}
                </div>
            ) : (
                <div className="grid max-h-64 grid-cols-3 gap-2 overflow-y-auto pr-1">
                    {playable.map(item => {
                        const selected = item.id === selectedId;
                        return (
                            <button
                                key={item.id}
                                type="button"
                                onClick={() => onSelect(item.id, item.title)}
                                className="group overflow-hidden rounded-lg border text-left transition-transform hover:scale-[1.02]"
                                style={{
                                    borderColor: selected ? theme.accentColor : borderColor,
                                    backgroundColor: colorWithAlpha(theme.backgroundColor, 0.5),
                                }}
                                title={item.title}
                            >
                                <div className="aspect-video w-full overflow-hidden bg-black/30">
                                    {item.hasPreview ? (
                                        <img
                                            src={`folia-we://preview/${item.id}`}
                                            alt=""
                                            loading="lazy"
                                            className="h-full w-full object-cover"
                                        />
                                    ) : null}
                                </div>
                                <div className="truncate px-2 py-1 text-[11px]" style={{ color: theme.primaryColor }}>
                                    {item.title}
                                </div>
                            </button>
                        );
                    })}
                </div>
            )}

            {skipped > 0 && (
                <div className="text-[11px] opacity-60" style={{ color: theme.secondaryColor }}>
                    {t('options.weSkipped').replace('{count}', String(skipped))}
                </div>
            )}
        </div>
    );
};

export default WeWallpaperPicker;
