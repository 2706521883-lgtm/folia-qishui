import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { motion } from 'framer-motion';
import {
    AudioLines,
    Bookmark,
    Check,
    ChevronDown,
    Heart,
    HeartHandshake,
    History,
    ListMusic,
    Loader2,
    LogIn,
    Music2,
    Palette,
    Plus,
    Play,
    SlidersHorizontal,
    Sparkles,
    User,
    Video,
    Wand2,
    X,
    type LucideIcon,
} from 'lucide-react';
import type { StatusMessage, Theme, ThemeMode, VisualizerMode } from '../../types';
import type { ProviderAccountSummary, ProviderCollection, ProviderUser } from '../../types/onlineMusic';
import type { ThemeSourceModel } from '../../hooks/themeControllerState';
import EffectPresetRows from '../panelTab/controls/EffectPresetRows';
import PlayerQuickControls, { type PlayerQuickControlsProps } from '../panelTab/controls/PlayerQuickControls';
import ThemeQuickRow from '../panelTab/controls/ThemeQuickRow';
import ThemeSourceRow from '../panelTab/controls/ThemeSourceRow';
import {
    QISHUI_LIKED_PLAYLIST_ID,
    QISHUI_RECENT_PLAYLIST_ID,
} from '../../services/onlineMusic/qishuiCatalog';
import { createQishuiPlaylist } from '../../services/onlineMusic/qishuiPlaylistCreate';
import { openSettings } from '../../stores/useSettingsModalStore';
import { useQishuiFeedModeStore } from '../../stores/useQishuiFeedModeStore';
import { getQishuiModeLabel } from '../../services/onlineMusic/qishuiFeedModes';
import { buildQishuiPlayerNavModel } from './qishuiPlayerNavModel';

// src/components/qishui/QishuiPlayerNav.tsx
// The player-page sidebar. It now renders for every online provider: the Qishui-only rows
// (recommendation / listening mode) disappear elsewhere, while collections, account switching
// and quick controls remain. Rows open the same collections the library already knows, so
// playback, search and the queue stay on Folia's existing paths.
type QishuiPlayerNavProps = {
    collections: readonly ProviderCollection[];
    user: ProviderUser | null;
    providers: readonly ProviderAccountSummary[];
    activeProviderId: string;
    theme: Theme;
    onThemeChange: (theme: Theme) => void;
    themeSourceModel: ThemeSourceModel;
    onThemeSourceChange: (mode: ThemeMode) => void;
    hasCustomTheme: boolean;
    defaultTheme: Theme;
    daylightTheme: Theme;
    onToggleDaylight: () => void;
    visualizerMode: VisualizerMode;
    onVisualizerModeChange: (mode: VisualizerMode) => void;
    isDaylight: boolean;
    isVisible: boolean;
    isPlaying: boolean;
    isFeedLoading: boolean;
    quickControls: PlayerQuickControlsProps;
    onOpenCollection: (collection: ProviderCollection) => void;
    /** 汽水专属；其它平台不显示推荐行。 */
    onPlayFeed?: () => void;
    onSelectProvider: (providerId: string) => void;
    /** 汽水专属；其它平台不显示听歌模式行。 */
    onOpenModeGrid?: () => void;
    onRefresh: () => Promise<unknown>;
    onStatusMessage: (message: StatusMessage) => void;
};

type NavRowProps = {
    icon: LucideIcon;
    iconUrl?: string;
    label: string;
    isDaylight: boolean;
    isLoading?: boolean;
    loadingLabel?: string;
    onClick: () => void;
};

const NavRow: React.FC<NavRowProps> = ({
    icon: Icon,
    iconUrl,
    label,
    isDaylight,
    isLoading = false,
    loadingLabel,
    onClick,
}) => (
    <button
        type="button"
        onClick={onClick}
        disabled={isLoading}
        aria-busy={isLoading || undefined}
        className={`flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] transition-colors ${
            isDaylight
                ? 'text-zinc-700 hover:bg-black/[0.05] hover:text-zinc-950'
                : 'text-white/80 hover:bg-white/[0.07] hover:text-white'
        } ${isLoading ? 'cursor-wait' : ''}`}
        title={isLoading ? loadingLabel ?? label : label}
    >
        {isLoading ? (
            <Loader2 size={15} className="shrink-0 animate-spin opacity-80" />
        ) : iconUrl ? (
            <img
                src={iconUrl}
                alt=""
                draggable={false}
                decoding="async"
                referrerPolicy="no-referrer"
                className="h-4 w-4 shrink-0 rounded-full object-cover opacity-90"
            />
        ) : (
            <Icon size={15} className="shrink-0 opacity-80" />
        )}
        <span className="truncate">{label}</span>
        {isLoading && loadingLabel && (
            <span className={`ml-auto shrink-0 text-[10px] ${isDaylight ? 'text-zinc-400' : 'text-white/45'}`}>
                {loadingLabel}
            </span>
        )}
    </button>
);

const SectionLabel: React.FC<{ isDaylight: boolean; children: React.ReactNode }> = ({ isDaylight, children }) => (
    <div className={`px-3 pb-1 pt-1 text-[10px] font-medium uppercase tracking-[0.12em] ${isDaylight ? 'text-zinc-400' : 'text-white/35'}`}>
        {children}
    </div>
);

const virtualCollection = (
    id: string,
    name: string,
    extra: Partial<ProviderCollection> = {},
): ProviderCollection => ({
    providerId: 'qishui',
    id,
    name,
    type: 'playlist',
    ...extra,
});

const PROVIDER_BADGES: Record<string, { label: string; color: string }> = {
    netease: { label: '云', color: '#dc2626' },
    kugou: { label: 'K', color: '#2563eb' },
    qq: { label: 'Q', color: '#16a34a' },
    bodian: { label: '波', color: '#0d9488' },
    qishui: { label: '汽', color: '#0891b2' },
};

const providerBadge = (provider: ProviderAccountSummary) => (
    PROVIDER_BADGES[provider.providerId]
    ?? {
        label: Array.from(provider.shortName || provider.displayName || '?')[0] ?? '?',
        color: '#52525b',
    }
);

const providerStatusLabel = (provider: ProviderAccountSummary): string => {
    if (provider.availability.reason === 'runtime-unavailable') return '不可用';
    if (!provider.availability.configured) return '未配置';
    if (provider.requiresAccount === false) return '无需登录';
    if (provider.status === 'authenticated') return '已登录';
    if (provider.hydration === 'loading' || provider.status === 'unknown') return '解析中';
    return '未登录';
};

const QishuiPlayerNav: React.FC<QishuiPlayerNavProps> = ({
    collections,
    user,
    providers,
    activeProviderId,
    theme,
    onThemeChange,
    themeSourceModel,
    onThemeSourceChange,
    hasCustomTheme,
    defaultTheme,
    daylightTheme,
    onToggleDaylight,
    visualizerMode,
    onVisualizerModeChange,
    isDaylight,
    isVisible,
    isPlaying,
    isFeedLoading,
    quickControls,
    onOpenCollection,
    onPlayFeed,
    onSelectProvider,
    onOpenModeGrid,
    onRefresh,
    onStatusMessage,
}) => {
    const { t } = useTranslation();
    const model = useMemo(() => buildQishuiPlayerNavModel(collections), [collections]);
    const qishuiFeedModeSelection = useQishuiFeedModeStore(state => state.selection);
    const recommendationIcon = qishuiFeedModeSelection?.kind === 'preference'
        ? (qishuiFeedModeSelection.preferenceMode === 'familiar'
            ? HeartHandshake
            : qishuiFeedModeSelection.preferenceMode === 'fresh'
                ? Wand2
                : Sparkles)
        : qishuiFeedModeSelection?.kind === 'scene'
            ? Sparkles
            : Play;
    const recommendationIconUrl = qishuiFeedModeSelection?.kind === 'scene'
        ? qishuiFeedModeSelection.iconUrl
        : undefined;
    const recommendationLabel = getQishuiModeLabel(qishuiFeedModeSelection);
    const isQishuiProvider = activeProviderId === 'qishui';
    const activeProvider = providers.find(provider => provider.providerId === activeProviderId);
    const activeProviderLabel = activeProvider?.shortName || activeProvider?.displayName || '在线音乐';
    const activeProviderStatus = activeProvider ? providerStatusLabel(activeProvider) : '在线音乐';
    // 汽水按官方分类只列自己创建的歌单；其它平台列出当前 provider 能拿到的全部歌单。
    const listedPlaylists = isQishuiProvider ? model.created : model.playlists;
    const [isSwitcherOpen, setIsSwitcherOpen] = useState(false);
    const [isEffectPresetOpen, setIsEffectPresetOpen] = useState(false);
    const [isCreating, setIsCreating] = useState(false);
    const [createName, setCreateName] = useState('');
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [createError, setCreateError] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (isCreating) inputRef.current?.focus();
    }, [isCreating]);

    // 新建歌单只属于汽水；切到别的平台时把没提交的输入收掉，免得切回来还留着。
    useEffect(() => {
        setIsCreating(false);
        setCreateName('');
        setCreateError('');
    }, [activeProviderId]);

    // While a track is playing the panel stays out of the lyrics; moving the pointer into its
    // top-right footprint (or focusing the create form) reveals it. Pausing pins it open.
    const [isRevealed, setIsRevealed] = useState(() => !isPlaying);
    const isPointerInsideRef = useRef(false);
    const hideTimerRef = useRef<number | null>(null);

    const clearHideTimer = useCallback(() => {
        if (hideTimerRef.current !== null) {
            window.clearTimeout(hideTimerRef.current);
            hideTimerRef.current = null;
        }
    }, []);

    const reveal = useCallback(() => {
        isPointerInsideRef.current = true;
        clearHideTimer();
        setIsRevealed(true);
    }, [clearHideTimer]);

    const scheduleHide = useCallback(() => {
        isPointerInsideRef.current = false;
        clearHideTimer();
        if (!isPlaying || isCreating) return;
        hideTimerRef.current = window.setTimeout(() => {
            hideTimerRef.current = null;
            setIsRevealed(false);
        }, 650);
    }, [clearHideTimer, isCreating, isPlaying]);

    useEffect(() => {
        if (!isPlaying) {
            clearHideTimer();
            setIsRevealed(true);
            return;
        }
        if (!isPointerInsideRef.current) setIsRevealed(false);
    }, [isPlaying, isVisible, clearHideTimer]);

    useEffect(() => {
        if (isCreating) {
            clearHideTimer();
            setIsRevealed(true);
        }
    }, [isCreating, clearHideTimer]);

    useEffect(() => {
        if (isCreating || !isPlaying || isPointerInsideRef.current) return;
        scheduleHide();
    }, [isCreating, isPlaying, scheduleHide]);

    useEffect(() => () => clearHideTimer(), [clearHideTimer]);

    useEffect(() => {
        if (!isRevealed) {
            setIsSwitcherOpen(false);
            setIsEffectPresetOpen(false);
        }
    }, [isRevealed]);

    const openLiked = useCallback(() => {
        if (model.liked) {
            onOpenCollection(model.liked);
            return;
        }
        if (isQishuiProvider) {
            onOpenCollection(virtualCollection(QISHUI_LIKED_PLAYLIST_ID, t('qishuiNav.liked', '我喜欢的音乐'), {
                isOwned: true,
            }));
            return;
        }
        onStatusMessage({ type: 'info', text: t('qishuiNav.likedEmpty', '当前平台没有可用的收藏歌单') });
    }, [isQishuiProvider, model.liked, onOpenCollection, onStatusMessage, t]);

    const openRecent = useCallback(() => {
        if (model.recent) {
            onOpenCollection(model.recent);
            return;
        }
        if (isQishuiProvider) {
            onOpenCollection(virtualCollection(QISHUI_RECENT_PLAYLIST_ID, t('qishuiNav.recent', '汽水最近播放'), {
                isOwned: true,
            }));
            return;
        }
        onStatusMessage({ type: 'info', text: t('qishuiNav.recentEmpty', '当前平台没有历史播放歌单') });
    }, [isQishuiProvider, model.recent, onOpenCollection, onStatusMessage, t]);

    const openDouyin = useCallback(() => {
        if (model.douyin) {
            onOpenCollection(model.douyin);
            return;
        }
        onStatusMessage({
            type: 'info',
            text: t('qishuiNav.douyinEmpty', '当前账号没有抖音收藏的音乐'),
        });
    }, [model.douyin, onOpenCollection, onStatusMessage, t]);

    const submitCreate = useCallback(async (event: React.FormEvent) => {
        event.preventDefault();
        // 新建歌单只有汽水有对应的接口；其它平台不显示入口，这里再兜一层。
        if (!isQishuiProvider) return;
        const name = createName.trim();
        if (!name || isSubmitting) return;
        setIsSubmitting(true);
        setCreateError('');
        try {
            const created = await createQishuiPlaylist(name);
            await onRefresh().catch(() => undefined);
            setIsCreating(false);
            setCreateName('');
            if (created) {
                onOpenCollection({
                    providerId: 'qishui',
                    id: created.id,
                    name: created.name,
                    type: 'playlist',
                    isOwned: true,
                    trackCount: 0,
                    ...(created.cover ? { coverUrl: created.cover } : {}),
                });
            } else {
                onStatusMessage({ type: 'success', text: t('qishuiNav.created', '歌单已创建') });
            }
        } catch (error) {
            setCreateError(error instanceof Error ? error.message : t('qishuiNav.createFailed', '创建失败'));
        } finally {
            setIsSubmitting(false);
        }
    }, [createName, isQishuiProvider, isSubmitting, onOpenCollection, onRefresh, onStatusMessage, t]);

    if (!isVisible) return null;

    const surface = isDaylight
        ? 'border-black/10 bg-white/70 text-zinc-800'
        : 'border-white/10 bg-[#0c0d10]/55 text-white/90';
    const divider = isDaylight ? 'border-black/10' : 'border-white/10';
    const muted = isDaylight ? 'text-zinc-400' : 'text-white/35';
    const subtleRow = isDaylight
        ? 'text-zinc-600 hover:bg-black/[0.05] hover:text-zinc-950'
        : 'text-white/70 hover:bg-white/[0.07] hover:text-white';

    return (
        <div className="pointer-events-none fixed right-4 top-12 z-40 hidden w-[248px] md:block">
            <motion.aside
                initial={false}
                animate={{
                    opacity: isRevealed ? 1 : 0,
                    x: isRevealed ? 0 : 18,
                    scale: isRevealed ? 1 : 0.98,
                }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                onPointerEnter={reveal}
                onPointerMove={reveal}
                onPointerLeave={scheduleHide}
                onFocusCapture={reveal}
                onBlurCapture={scheduleHide}
                className={`relative flex max-h-[calc(100vh-7.5rem)] w-full flex-col rounded-2xl border shadow-[0_24px_64px_rgba(0,0,0,0.35)] backdrop-blur-2xl ${isEffectPresetOpen ? 'overflow-visible' : 'overflow-hidden'} ${surface} ${isRevealed ? 'pointer-events-auto' : 'pointer-events-none'}`}
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                onClick={event => event.stopPropagation()}
                aria-label={isQishuiProvider
                    ? t('qishuiNav.label', '汽水音乐导航')
                    : t('qishuiNav.labelGeneric', '在线音乐导航')}
                aria-hidden={!isRevealed}
            >
            <div className="flex shrink-0 items-center gap-2.5 px-4 pb-3 pt-4">
                <div className={`flex h-8 w-8 items-center justify-center rounded-xl ${isDaylight ? 'bg-zinc-900 text-white' : 'bg-white text-black'}`}>
                    <AudioLines size={16} />
                </div>
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-semibold tracking-tight">{t('qishuiNav.brand', 'Folia')}</div>
                    <div className={`truncate text-[10px] ${muted}`}>{user?.nickname || t('qishuiNav.brandSub', activeProviderLabel)}</div>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                    <button
                        type="button"
                        onClick={() => openSettings('options', 'visualizer', 'background')}
                        className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${isDaylight ? 'text-zinc-500 hover:bg-black/[0.06] hover:text-zinc-900' : 'text-white/55 hover:bg-white/[0.08] hover:text-white'}`}
                        title={t('options.openLyricsStyleSettings', '打开歌词样式设置')}
                        aria-label={t('options.openLyricsStyleSettings', '打开歌词样式设置')}
                    >
                        <Palette size={14} />
                    </button>
                    <button
                        type="button"
                        onClick={() => onStatusMessage({
                            type: 'info',
                            text: t('qishuiNav.presetPending', '预设功能稍后接入'),
                        })}
                        className={`flex h-7 w-7 items-center justify-center rounded-full transition-colors ${isDaylight ? 'text-zinc-500 hover:bg-black/[0.06] hover:text-zinc-900' : 'text-white/55 hover:bg-white/[0.08] hover:text-white'}`}
                        title={t('qishuiNav.preset', '预设')}
                        aria-label={t('qishuiNav.preset', '预设')}
                    >
                        <Bookmark size={14} />
                    </button>
                </div>
            </div>

            <div className="relative shrink-0 px-2">
                {isQishuiProvider ? (
                    <>
                        <div className="flex items-center gap-1">
                            <div className="min-w-0 flex-1">
                                <NavRow
                                    icon={recommendationIcon}
                                    iconUrl={recommendationIconUrl}
                                    label={recommendationLabel}
                                    isDaylight={isDaylight}
                                    isLoading={isFeedLoading}
                                    loadingLabel={t('qishuiNav.feedRefreshing', '刷新中…')}
                                    onClick={() => onPlayFeed?.()}
                                />
                            </div>
                            <button
                                type="button"
                                onClick={() => {
                                    setIsSwitcherOpen(false);
                                    setIsEffectPresetOpen(value => !value);
                                }}
                                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition-colors ${
                                    isEffectPresetOpen
                                        ? isDaylight
                                            ? 'border-black/15 bg-black/[0.08] text-zinc-900'
                                            : 'border-white/15 bg-white/[0.12] text-white'
                                        : isDaylight
                                            ? 'border-black/10 bg-white/50 text-zinc-500 hover:bg-white/80 hover:text-zinc-900'
                                            : 'border-white/10 bg-white/[0.04] text-white/55 hover:bg-white/[0.1] hover:text-white'
                                }`}
                                title={t('qishuiNav.effectPreset', '效果预设')}
                                aria-label={t('qishuiNav.effectPreset', '效果预设')}
                                aria-expanded={isEffectPresetOpen}
                            >
                                <Sparkles size={14} />
                            </button>
                        </div>
                        <NavRow
                            icon={SlidersHorizontal}
                            label={t('qishuiNav.mode', '听歌模式')}
                            isDaylight={isDaylight}
                            onClick={() => onOpenModeGrid?.()}
                        />
                    </>
                ) : (
                    <NavRow
                        icon={Sparkles}
                        label={t('qishuiNav.quickControls', '快捷控制')}
                        isDaylight={isDaylight}
                        onClick={() => {
                            setIsSwitcherOpen(false);
                            setIsEffectPresetOpen(value => !value);
                        }}
                    />
                )}

                {isEffectPresetOpen && (
                    <div className={`absolute right-2 top-9 z-30 max-h-[calc(100vh-18rem)] w-[292px] overflow-y-auto overscroll-contain rounded-2xl border p-2 shadow-2xl backdrop-blur-2xl ${
                        isDaylight ? 'border-black/10 bg-white/95 text-zinc-800' : 'border-white/10 bg-[#141519]/95 text-white/90'
                    }`}>
                        <div className="flex items-center justify-between px-1 pb-1.5">
                            <span className={`text-[10px] font-medium uppercase tracking-[0.12em] ${muted}`}>
                                {t('qishuiNav.quickControls', '快捷控制')}
                            </span>
                            <button
                                type="button"
                                onClick={() => setIsEffectPresetOpen(false)}
                                className={`flex h-5 w-5 items-center justify-center rounded-full transition-colors ${subtleRow}`}
                                title={t('ui.close', '关闭')}
                                aria-label={t('ui.close', '关闭')}
                            >
                                <X size={11} />
                            </button>
                        </div>
                        <PlayerQuickControls {...quickControls} />
                        <div className={`mx-1 my-1.5 h-px ${isDaylight ? 'bg-black/10' : 'bg-white/10'}`} />
                        <div className={`px-1 pb-1.5 text-[10px] font-medium uppercase tracking-[0.12em] ${muted}`}>
                            {t('qishuiNav.effectPreset', '效果预设')}
                        </div>
                        <EffectPresetRows
                            theme={theme}
                            onThemeChange={onThemeChange}
                            isDaylight={isDaylight}
                            visualizerMode={visualizerMode}
                            onVisualizerModeChange={onVisualizerModeChange}
                            onClosePanel={() => setIsEffectPresetOpen(false)}
                        />
                        <div className={`mx-1 my-2 h-px ${isDaylight ? 'bg-black/10' : 'bg-white/10'}`} />
                        <div className={`px-1 pb-1.5 text-[10px] font-medium uppercase tracking-[0.12em] ${muted}`}>
                            {t('qishuiNav.themeSettings', '主题设置')}
                        </div>
                        <ThemeSourceRow
                            themeSourceModel={themeSourceModel}
                            onBgModeChange={onThemeSourceChange}
                            hasCustomTheme={hasCustomTheme}
                            defaultTheme={defaultTheme}
                            daylightTheme={daylightTheme}
                            isDaylight={isDaylight}
                        />
                        <div className="mt-2">
                            <ThemeQuickRow
                                theme={theme}
                                themeSourceModel={themeSourceModel}
                                defaultTheme={defaultTheme}
                                daylightTheme={daylightTheme}
                                isDaylight={isDaylight}
                                onToggleDaylight={onToggleDaylight}
                            />
                        </div>
                    </div>
                )}
            </div>

            {(isQishuiProvider || model.liked || model.recent || model.douyin) && (
                <div className={`mt-2 shrink-0 border-t px-2 pt-2 ${divider}`}>
                    <SectionLabel isDaylight={isDaylight}>{t('qishuiNav.myMusic', '我的音乐')}</SectionLabel>
                    {(isQishuiProvider || model.liked) && (
                        <NavRow
                            icon={Heart}
                            label={isQishuiProvider ? t('qishuiNav.liked', '我喜欢的音乐') : model.liked?.name || t('qishuiNav.liked', '我喜欢的音乐')}
                            isDaylight={isDaylight}
                            onClick={openLiked}
                        />
                    )}
                    {model.douyin && (
                        <NavRow
                            icon={Video}
                            label={isQishuiProvider ? t('qishuiNav.douyin', '抖音收藏的音乐') : model.douyin.name}
                            isDaylight={isDaylight}
                            onClick={openDouyin}
                        />
                    )}
                    {(isQishuiProvider || model.recent) && (
                        <NavRow
                            icon={History}
                            label={isQishuiProvider ? t('qishuiNav.history', '历史播放') : model.recent?.name || t('qishuiNav.history', '历史播放')}
                            isDaylight={isDaylight}
                            onClick={openRecent}
                        />
                    )}
                </div>
            )}

            <div className={`mt-2 flex min-h-0 flex-1 flex-col border-t pt-2 ${divider}`}>
                <div className="flex shrink-0 items-center justify-between px-4 pb-1">
                    <span className={`text-[10px] font-medium uppercase tracking-[0.12em] ${muted}`}>
                        {isQishuiProvider
                            ? t('qishuiNav.created', '创建的歌单')
                            : t('qishuiNav.playlists', '我的歌单')}
                    </span>
                    {isQishuiProvider && (
                        <button
                            type="button"
                            onClick={() => {
                                setIsCreating(value => !value);
                                setCreateError('');
                            }}
                            className={`flex h-6 w-6 items-center justify-center rounded-full transition-colors ${subtleRow}`}
                            title={isCreating ? t('common.cancel', '取消') : t('qishuiNav.createPlaylist', '新建歌单')}
                            aria-label={isCreating ? t('common.cancel', '取消') : t('qishuiNav.createPlaylist', '新建歌单')}
                        >
                            {isCreating ? <X size={13} /> : <Plus size={13} />}
                        </button>
                    )}
                </div>

                {isQishuiProvider && isCreating && (
                    <form onSubmit={submitCreate} className="shrink-0 px-3 pb-2">
                        <input
                            ref={inputRef}
                            value={createName}
                            onChange={event => {
                                setCreateName(event.target.value);
                                if (createError) setCreateError('');
                            }}
                            onKeyDown={event => {
                                if (event.key === 'Escape') {
                                    setIsCreating(false);
                                    setCreateName('');
                                    setCreateError('');
                                }
                            }}
                            placeholder={t('qishuiNav.playlistName', '歌单名称')}
                            maxLength={80}
                            disabled={isSubmitting}
                            className={`w-full rounded-lg border px-2.5 py-1.5 text-xs outline-none transition-colors ${
                                isDaylight
                                    ? 'border-black/10 bg-white/70 text-zinc-800 placeholder:text-zinc-400 focus:border-black/25'
                                    : 'border-white/10 bg-white/[0.06] text-white placeholder:text-white/30 focus:border-white/25'
                            }`}
                        />
                        <div className="mt-1.5 flex items-center gap-2">
                            <button
                                type="submit"
                                disabled={!createName.trim() || isSubmitting}
                                className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-opacity disabled:cursor-default disabled:opacity-40 ${
                                    isDaylight ? 'bg-zinc-900 text-white' : 'bg-white text-black'
                                }`}
                            >
                                {isSubmitting && <Loader2 size={12} className="animate-spin" />}
                                {t('qishuiNav.create', '创建')}
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    setIsCreating(false);
                                    setCreateName('');
                                    setCreateError('');
                                }}
                                disabled={isSubmitting}
                                className={`rounded-lg px-1.5 py-1 text-[11px] transition-opacity hover:opacity-100 disabled:opacity-40 ${isDaylight ? 'text-zinc-500' : 'text-white/50'}`}
                            >
                                {t('common.cancel', '取消')}
                            </button>
                        </div>
                        {createError && <div className="mt-1 text-[11px] text-red-400">{createError}</div>}
                    </form>
                )}

                <div className="hide-scrollbar min-h-0 flex-1 overflow-y-auto px-2 pb-2">
                    {listedPlaylists.length > 0 ? listedPlaylists.map(collection => (
                        <button
                            key={String(collection.id)}
                            type="button"
                            onClick={() => onOpenCollection(collection)}
                            className={`flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-left text-[12px] transition-colors ${subtleRow}`}
                            title={collection.name}
                        >
                            <ListMusic size={13} className="shrink-0 opacity-70" />
                            <span className="truncate">{collection.name}</span>
                        </button>
                    )) : (
                        <div className={`px-3 py-2 text-[11px] ${muted}`}>
                            {isQishuiProvider
                                ? t('qishuiNav.noCreated', '暂无创建的歌单')
                                : t('qishuiNav.noPlaylists', '暂无歌单')}
                        </div>
                    )}
                </div>
            </div>

            {isSwitcherOpen && (
                <div className={`absolute bottom-14 left-2 right-2 z-20 overflow-hidden rounded-2xl border shadow-2xl backdrop-blur-2xl ${isDaylight ? 'border-black/10 bg-white/95 text-zinc-800' : 'border-white/10 bg-[#141519]/95 text-white/90'}`}>
                    <div className={`px-3 pb-1 pt-2.5 text-[10px] font-medium uppercase tracking-[0.12em] ${muted}`}>
                        {t('qishuiNav.switchPlatform', '切换平台')}
                    </div>
                    <div className="hide-scrollbar max-h-56 overflow-y-auto px-1.5 pb-1.5">
                        {providers.map(provider => {
                            const active = provider.providerId === activeProviderId;
                            const configured = provider.availability.configured;
                            const unavailable = provider.availability.reason === 'runtime-unavailable';
                            const label = provider.shortName || provider.displayName || provider.providerId;
                            const badge = providerBadge(provider);
                            const authenticated = provider.status === 'authenticated';
                            return (
                                <button
                                    key={provider.providerId}
                                    type="button"
                                    role="menuitemradio"
                                    aria-checked={active}
                                    disabled={!configured || unavailable}
                                    onClick={() => {
                                        setIsSwitcherOpen(false);
                                        if (!active) onSelectProvider(provider.providerId);
                                    }}
                                    className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-[12px] transition-colors disabled:cursor-default disabled:opacity-40 ${
                                        active
                                            ? isDaylight ? 'bg-black/[0.06]' : 'bg-white/[0.08]'
                                            : isDaylight ? 'hover:bg-black/[0.05]' : 'hover:bg-white/[0.07]'
                                    }`}
                                    title={`${label} · ${providerStatusLabel(provider)}`}
                                >
                                    {provider.user?.avatarUrl ? (
                                        <img src={provider.user.avatarUrl} alt="" className="h-6 w-6 shrink-0 rounded-full object-cover" />
                                    ) : (
                                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-black text-white" style={{ backgroundColor: badge.color }}>
                                            {badge.label}
                                        </span>
                                    )}
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate">{label}</span>
                                        <span className={`block truncate text-[10px] ${muted}`}>{providerStatusLabel(provider)}</span>
                                    </span>
                                    {active && <Check size={13} className="shrink-0 opacity-70" />}
                                    {!active && !authenticated && configured && !unavailable && <LogIn size={12} className="shrink-0 opacity-45" />}
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            <button
                type="button"
                onClick={() => {
                    setIsEffectPresetOpen(false);
                    setIsSwitcherOpen(value => !value);
                }}
                className={`flex w-full shrink-0 items-center gap-2 border-t px-4 py-2.5 text-left transition-colors ${divider} ${isDaylight ? 'hover:bg-black/[0.04]' : 'hover:bg-white/[0.05]'}`}
                aria-haspopup="menu"
                aria-expanded={isSwitcherOpen}
                title={t('qishuiNav.switchAccount', '切换平台 / 账号')}
            >
                {user?.avatarUrl ? (
                    <img src={user.avatarUrl} alt="" className="h-7 w-7 rounded-full object-cover" />
                ) : (
                    <div className={`flex h-7 w-7 items-center justify-center rounded-full ${isDaylight ? 'bg-black/[0.06] text-zinc-500' : 'bg-white/[0.08] text-white/50'}`}>
                        <User size={13} />
                    </div>
                )}
                <div className="min-w-0 flex-1">
                    <div className="truncate text-[11px] font-medium">{user?.nickname || t('qishuiNav.notLoggedIn', '未登录')}</div>
                    <div className={`truncate text-[10px] ${muted}`}>{activeProviderLabel} · {activeProviderStatus}</div>
                </div>
                <ChevronDown size={14} className={`shrink-0 opacity-45 transition-transform ${isSwitcherOpen ? 'rotate-180' : ''}`} />
            </button>
            </motion.aside>
            {!isRevealed && (
                <button
                    type="button"
                    className={`pointer-events-auto absolute right-0 top-0 flex h-8 w-8 items-center justify-center rounded-full border shadow-[0_8px_24px_rgba(0,0,0,0.28)] backdrop-blur-md transition-all hover:scale-105 ${isDaylight ? 'border-black/15 bg-white/80 text-zinc-600 hover:bg-white' : 'border-white/20 bg-black/55 text-white/75 hover:bg-black/75 hover:text-white'}`}
                    onPointerEnter={reveal}
                    onFocus={reveal}
                    onClick={reveal}
                    title={isQishuiProvider
                        ? t('qishuiNav.show', '展开汽水音乐导航')
                        : t('qishuiNav.showGeneric', '展开在线音乐导航')}
                    aria-label={isQishuiProvider
                        ? t('qishuiNav.show', '展开汽水音乐导航')
                        : t('qishuiNav.showGeneric', '展开在线音乐导航')}
                >
                    <Music2 size={14} />
                </button>
            )}
        </div>
    );
};

export default QishuiPlayerNav;
