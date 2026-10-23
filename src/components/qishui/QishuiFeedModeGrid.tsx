import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Check, HeartHandshake, Loader2, Music2, Sparkles, Wand2, X } from 'lucide-react';
import { omni } from '../../services/onlineMusic/omni';
import type { PersonalFmModeCatalog, PersonalFmModeEntry } from '../../types/onlineMusic';
import type { QishuiFeedModeSelection } from '../../services/onlineMusic/qishuiFeedModes';
import { useQishuiFeedModeStore } from '../../stores/useQishuiFeedModeStore';
import { useQishuiFeedModeGridStore } from '../../stores/useQishuiFeedModeGridStore';

// src/components/qishui/QishuiFeedModeGrid.tsx
// Qishui's "听歌模式" grid: the scene catalogue is fetched from /luna/pc/feed/mode (45 scenes
// today) and rendered with the icons the API ships. Selecting a mode writes the independent
// Qishui feed-mode store; App reacts to that store change and restarts Personal FM immediately.

const PREFERENCE_ICONS: Record<string, React.ComponentType<{ size?: number; className?: string }>> = {
    default: Sparkles,
    familiar: HeartHandshake,
    fresh: Wand2,
};

const toSelection = (entry: PersonalFmModeEntry): QishuiFeedModeSelection => (
    entry.kind === 'scene'
        ? {
            id: entry.id,
            kind: 'scene',
            text: entry.text,
            sceneModeId: entry.sceneModeId,
            subQueueType: entry.subQueueType,
            iconUrl: entry.iconUrl,
        }
        : {
            id: entry.id,
            kind: 'preference',
            text: entry.text,
            preferenceMode: entry.preferenceMode,
        }
);

const isSelected = (entry: PersonalFmModeEntry, selection: QishuiFeedModeSelection | null): boolean => {
    if (entry.preferenceMode === 'default') return !selection;
    return Boolean(selection && selection.id === entry.id);
};

const QishuiFeedModeGrid: React.FC = () => {
    const { t } = useTranslation();
    const isOpen = useQishuiFeedModeGridStore(state => state.isOpen);
    const close = useQishuiFeedModeGridStore(state => state.close);
    const selection = useQishuiFeedModeStore(state => state.selection);
    const setSelection = useQishuiFeedModeStore(state => state.setSelection);
    const [catalog, setCatalog] = useState<PersonalFmModeCatalog | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const load = useCallback(async () => {
        setLoading(true);
        setError('');
        try {
            const data = await omni.getPersonalFmModes();
            setCatalog(data);
            if (!data.configured) setError(data.message || t('qishuiMode.unavailable', '汽水音乐未登录或不可用'));
            else if (data.error && !data.modes.length) setError(data.message || data.error);
        } catch (loadError) {
            setError(loadError instanceof Error ? loadError.message : String(loadError));
        } finally {
            setLoading(false);
        }
    }, [t]);

    useEffect(() => {
        if (isOpen) void load();
    }, [isOpen, load]);

    useEffect(() => {
        if (!isOpen) return undefined;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') close();
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [isOpen, close]);

    const preferences = useMemo(
        () => (catalog?.modes ?? []).filter(entry => entry.kind === 'preference'),
        [catalog],
    );
    const scenes = useMemo(
        () => (catalog?.modes ?? []).filter(entry => entry.kind === 'scene'),
        [catalog],
    );

    const choose = (entry: PersonalFmModeEntry | null) => {
        if (!entry || entry.preferenceMode === 'default') {
            setSelection(null);
        } else {
            setSelection(toSelection(entry));
        }
        close();
    };

    if (!isOpen || typeof document === 'undefined') return null;

    const panel = (
        <div
            className="fixed inset-0 z-[240] flex items-center justify-center bg-black/65 px-3 py-6 backdrop-blur-md"
            role="presentation"
            onClick={close}
        >
            <div
                className="flex max-h-[90vh] w-full max-w-[1080px] flex-col overflow-hidden rounded-3xl border border-white/10 bg-[#101012]/95 text-white shadow-[0_30px_90px_rgba(0,0,0,0.55)]"
                role="dialog"
                aria-modal="true"
                aria-label={t('qishuiMode.title', '听歌模式')}
                onClick={event => event.stopPropagation()}
            >
                <div className="flex items-start justify-between gap-4 border-b border-white/10 px-6 py-5">
                    <div>
                        <h2 className="text-xl font-semibold tracking-tight">{t('qishuiMode.title', '听歌模式')}</h2>
                        <p className="mt-1 text-xs text-white/50">
                            {t('qishuiMode.subtitle', '选择汽水音乐的推荐模式，立即切换 Personal FM')}
                        </p>
                    </div>
                    <button
                        type="button"
                        onClick={close}
                        className="rounded-full p-2 text-white/60 transition-colors hover:bg-white/10 hover:text-white"
                        aria-label={t('common.close', '关闭')}
                    >
                        <X size={18} />
                    </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                    {loading && !catalog ? (
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
                            {Array.from({ length: 12 }).map((_, index) => (
                                <div key={index} className="h-28 animate-pulse rounded-2xl bg-white/[0.05]" />
                            ))}
                        </div>
                    ) : error && !catalog ? (
                        <div className="flex flex-col items-center gap-3 py-12 text-center">
                            <Music2 size={28} className="text-white/40" />
                            <p className="text-sm text-white/70">{error}</p>
                            <button
                                type="button"
                                onClick={() => { void load(); }}
                                className="rounded-full border border-white/15 px-4 py-1.5 text-xs text-white/80 transition-colors hover:bg-white/10"
                            >
                                {t('qishuiMode.retry', '重试')}
                            </button>
                        </div>
                    ) : (
                        <>
                            <section>
                                <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-white/45">
                                    {t('qishuiMode.preference', '常用模式')}
                                </h3>
                                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                                    {preferences.map(entry => {
                                        const Icon = PREFERENCE_ICONS[entry.preferenceMode || ''] || Sparkles;
                                        const selected = isSelected(entry, selection);
                                        return (
                                            <button
                                                key={entry.id}
                                                type="button"
                                                onClick={() => choose(entry)}
                                                className={`group flex items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors ${
                                                    selected
                                                        ? 'border-white/60 bg-white/15'
                                                        : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.08]'
                                                }`}
                                            >
                                                <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full ${
                                                    selected ? 'bg-white text-black' : 'bg-white/10 text-white/80'
                                                }`}>
                                                    <Icon size={20} />
                                                </span>
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate text-sm font-medium">{entry.text}</span>
                                                    <span className="block text-[11px] text-white/45">
                                                        {entry.preferenceMode === 'familiar'
                                                            ? t('qishuiMode.familiarHint', '更熟悉的口味')
                                                            : entry.preferenceMode === 'fresh'
                                                                ? t('qishuiMode.freshHint', '更多没听过的歌')
                                                                : t('qishuiMode.defaultHint', '默认推荐')}
                                                    </span>
                                                </span>
                                                {selected ? <Check size={16} className="shrink-0 text-white" /> : null}
                                            </button>
                                        );
                                    })}
                                </div>
                            </section>

                            <section className="mt-7">
                                <h3 className="mb-3 text-xs font-semibold uppercase tracking-[0.18em] text-white/45">
                                    {t('qishuiMode.scenes', '全部场景')}
                                </h3>
                                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
                                    {scenes.map(entry => {
                                        const selected = isSelected(entry, selection);
                                        return (
                                            <button
                                                key={entry.id}
                                                type="button"
                                                onClick={() => choose(entry)}
                                                className={`group relative flex min-h-[122px] flex-col items-center justify-center gap-2 rounded-2xl border p-3 text-center transition-colors ${
                                                    selected
                                                        ? 'border-white/60 bg-white/15'
                                                        : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.08]'
                                                }`}
                                            >
                                                {entry.iconUrl ? (
                                                    <img
                                                        src={entry.iconUrl}
                                                        alt=""
                                                        loading="lazy"
                                                        decoding="async"
                                                        referrerPolicy="no-referrer"
                                                        className="h-14 w-14 rounded-full object-cover"
                                                    />
                                                ) : (
                                                    <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white/10 text-white/60">
                                                        <Music2 size={22} />
                                                    </span>
                                                )}
                                                <span className="line-clamp-2 text-xs font-medium leading-tight">{entry.text}</span>
                                                {selected ? (
                                                    <span className="absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-white text-black">
                                                        <Check size={12} />
                                                    </span>
                                                ) : null}
                                            </button>
                                        );
                                    })}
                                </div>
                                {!scenes.length ? (
                                    <p className="py-8 text-center text-sm text-white/50">
                                        {t('qishuiMode.empty', '暂无可选模式')}
                                    </p>
                                ) : null}
                            </section>

                            <p className="mt-6 text-[11px] leading-relaxed text-white/35">
                                {t('qishuiMode.note', '选择后会立即切换当前 Personal FM；不在 FM 模式下则会在下次开始时生效。')}
                            </p>
                        </>
                    )}
                </div>
            </div>
        </div>
    );

    return createPortal(panel, document.body);
};

export default QishuiFeedModeGrid;
