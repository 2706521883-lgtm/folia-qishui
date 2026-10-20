import React, { useEffect, useState } from 'react';
import { Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';

// src/components/modal/settings/WallpaperDisplayRow.tsx
// 壁纸模式使用哪块显示器。只在 Windows、且连接了不止一块屏时出现；「跟随应用窗口」是原来的规则。
// 选择保存在主进程的 wallpaper_display，下次进入壁纸模式时生效；正在壁纸模式里则立即重建会话。

const WallpaperDisplayRow: React.FC<{ wallpaperMode: boolean; isDaylight: boolean }> = ({ wallpaperMode, isDaylight }) => {
    const { t } = useTranslation();
    const [state, setState] = useState<ElectronWallpaperDisplays | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        let cancelled = false;
        void window.electron?.listWallpaperDisplays?.().then(next => {
            if (!cancelled) setState(next ?? null);
        }).catch(() => {
            if (!cancelled) setState(null);
        });
        return () => { cancelled = true; };
    }, [wallpaperMode]);

    if (!state || state.displays.length < 2) return null;

    const choose = async (value: string) => {
        if (busy) return;
        setBusy(true);
        try {
            const display = state.displays.find(item => String(item.id) === value);
            const next = await window.electron?.chooseWallpaperDisplay?.(
                display ? { id: display.id, bounds: display.bounds, label: display.label } : null,
            );
            if (next) setState(next);
        } finally {
            setBusy(false);
        }
    };

    const active = state.displays.find(display => display.id === state.activeId);
    const primary = state.displays.find(display => display.primary);
    const labelOf = (display: ElectronWallpaperDisplay, index: number) => (
        display.label || (display.primary ? t('options.wallpaperDisplayPrimary') : t('options.wallpaperDisplayNumber', { number: index + 1 }))
    );

    return (
        <div className={`px-4 py-3 border-t ${isDaylight ? 'border-black/8' : 'border-white/8'}`}>
            <div className="flex items-center justify-between gap-4">
                <div className="flex min-w-0 items-start gap-2.5">
                    <Monitor size={15} className="mt-0.5 shrink-0 opacity-55" />
                    <div className="min-w-0 space-y-1">
                        <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                            {t('options.wallpaperDisplay')}
                        </div>
                        <div className="text-xs opacity-50" style={{ color: 'var(--text-secondary)' }}>
                            {t('options.wallpaperDisplayDesc')}
                            {active ? ` · ${t('options.wallpaperDisplayActive', { display: active.label || primary?.label || '' })}` : ''}
                        </div>
                    </div>
                </div>
                <select
                    value={state.chosenId === null ? 'auto' : String(state.chosenId)}
                    disabled={busy}
                    onChange={event => void choose(event.target.value)}
                    aria-label={t('options.wallpaperDisplay')}
                    className={`h-9 max-w-[190px] shrink-0 rounded-lg border px-2 text-xs outline-none disabled:opacity-50 ${isDaylight ? 'border-black/10 bg-white text-zinc-800' : 'border-white/10 bg-white/5 text-zinc-200'}`}
                >
                    <option value="auto">{t('options.wallpaperDisplayAuto')}</option>
                    {state.displays.map((display, index) => (
                        <option key={display.id} value={String(display.id)}>
                            {labelOf(display, index)}{display.primary ? ` · ${t('options.wallpaperDisplayPrimary')}` : ''}
                        </option>
                    ))}
                </select>
            </div>
        </div>
    );
};

export default WallpaperDisplayRow;
