import React, { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Compass, Loader2, Play, Plus, RefreshCw, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SongResult } from '../../../types';
import type { OmniCollection, OnlineProviderId, ProviderAccountSummary } from '../../../types/onlineMusic';
import { omni } from '../../../services/onlineMusic/omni';
import { getSongArtistLabel, getSongCoverUrl } from '../../../services/onlineMusic/songMetadata';
import { getSizedCoverUrl } from '../../../utils/coverUrl';
import { createOnlineGridViewCollection, type GridViewCollectionDescriptor } from '../home/gridViewCollectionAdapters';

// src/components/app/explore/ExploreOverlay.tsx
// 首页「探索」浮层：把当前在线平台今天能给的推荐放在一页里——每日推荐歌曲、推荐歌单、私人 FM 预告。
// 不新增 provider 接口：直接复用 omni.getHomeFeed（首页卡片本来就用的那一份）。
// 点歌不离开探索页；点歌单沿用首页的集合导航；平台徽章切换当前在线平台并重新拉取。

interface ExploreOverlayProps {
    isOpen: boolean;
    isDaylight: boolean;
    providers: readonly ProviderAccountSummary[];
    activeProviderId: OnlineProviderId;
    onClose: () => void;
    onSelectProvider: (providerId: OnlineProviderId) => void;
    onPlaySong: (song: SongResult, queue: SongResult[]) => void;
    onAddToQueue: (song: SongResult) => void;
    onOpenCollection: (collection: GridViewCollectionDescriptor) => void;
}

type ExploreData = {
    dailySongs: SongResult[];
    personalFm: SongResult[];
    recommendedCollections: OmniCollection[];
};

const EMPTY: ExploreData = { dailySongs: [], personalFm: [], recommendedCollections: [] };

const SongCard: React.FC<{
    song: SongResult;
    isDaylight: boolean;
    onPlay: () => void;
    onAdd: () => void;
}> = ({ song, isDaylight, onPlay, onAdd }) => {
    const cover = getSizedCoverUrl(getSongCoverUrl(song), 160);
    return (
        <div className={`group relative w-36 shrink-0 overflow-hidden rounded-2xl border transition-colors ${isDaylight ? 'border-black/8 bg-white/70 hover:bg-white' : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.08]'}`}>
            <button type="button" onClick={onPlay} className="block w-full text-left" aria-label={song.name}>
                <span className="relative block aspect-square overflow-hidden bg-white/5">
                    {cover ? <img src={cover} alt="" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" draggable={false} /> : null}
                    <span className="absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition-all duration-200 group-hover:bg-black/30 group-hover:opacity-100">
                        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-white/90 text-black shadow-lg">
                            <Play size={17} fill="currentColor" />
                        </span>
                    </span>
                </span>
                <span className="block px-3 pb-2 pt-2">
                    <span className="block truncate text-xs font-semibold">{song.name}</span>
                    <span className={`mt-0.5 block truncate text-[10px] ${isDaylight ? 'text-zinc-500' : 'text-zinc-400'}`}>{getSongArtistLabel(song)}</span>
                </span>
            </button>
            <button
                type="button"
                onClick={event => { event.stopPropagation(); onAdd(); }}
                title="加入队列"
                aria-label="加入队列"
                className={`absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-full opacity-0 shadow transition-opacity group-hover:opacity-100 ${isDaylight ? 'bg-white/90 text-zinc-700 hover:bg-white' : 'bg-black/60 text-white hover:bg-black/80'}`}
            >
                <Plus size={14} />
            </button>
        </div>
    );
};

const ExploreOverlay: React.FC<ExploreOverlayProps> = ({
    isOpen,
    isDaylight,
    providers,
    activeProviderId,
    onClose,
    onSelectProvider,
    onPlaySong,
    onAddToQueue,
    onOpenCollection,
}) => {
    const { t } = useTranslation();
    const [data, setData] = useState<ExploreData>(EMPTY);
    const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [nonce, setNonce] = useState(0);
    const visibleProviders = providers.filter(provider => provider.availability.reason !== 'runtime-unavailable');
    const activeProvider = visibleProviders.find(provider => provider.providerId === activeProviderId);

    useEffect(() => {
        if (!isOpen) return undefined;
        let cancelled = false;
        setStatus('loading');
        void omni.getHomeFeed(30).then(feed => {
            if (cancelled) return;
            setData({
                dailySongs: feed.dailySongs as SongResult[],
                personalFm: feed.personalFm as SongResult[],
                recommendedCollections: feed.recommendedCollections ?? [],
            });
            setStatus('ready');
        }).catch(() => {
            if (cancelled) return;
            setData(EMPTY);
            setStatus('error');
        });
        return () => { cancelled = true; };
    }, [activeProviderId, isOpen, nonce]);

    useEffect(() => {
        if (!isOpen) return undefined;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.repeat) return;
            event.preventDefault();
            onClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [isOpen, onClose]);

    const play = useCallback((song: SongResult, queue: SongResult[]) => onPlaySong(song, queue), [onPlaySong]);
    const panelBg = isDaylight ? 'bg-zinc-50 text-zinc-900 border-black/10' : 'bg-[#111114]/95 text-zinc-100 border-white/10';
    const soft = isDaylight ? 'text-zinc-500' : 'text-zinc-400';
    const sectionTitle = 'text-sm font-bold tracking-tight';

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 p-4 backdrop-blur-xl"
                    role="dialog"
                    aria-modal="true"
                    aria-label={t('explore.title')}
                    data-explore-overlay="open"
                    onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}
                >
                    <motion.div
                        initial={{ opacity: 0, y: 18, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: 12, scale: 0.99 }}
                        transition={{ type: 'spring', bounce: 0, duration: 0.42 }}
                        className={`flex h-[min(780px,90vh)] w-[min(1120px,94vw)] flex-col overflow-hidden rounded-[2rem] border shadow-2xl ${panelBg}`}
                    >
                        <div className="flex items-center gap-3 px-6 pt-5 pb-3">
                            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-orange-500/15 text-orange-400">
                                <Compass size={18} />
                            </span>
                            <div className="min-w-0">
                                <h2 className="text-lg font-extrabold leading-tight">{t('explore.title')}</h2>
                                <p className={`truncate text-[11px] ${soft}`}>
                                    {activeProvider ? t('explore.subtitle', { provider: activeProvider.shortName || activeProvider.displayName }) : t('explore.subtitle', { provider: activeProviderId })}
                                </p>
                            </div>
                            <div className="ml-auto flex items-center gap-1.5">
                                <button
                                    type="button"
                                    onClick={() => setNonce(value => value + 1)}
                                    disabled={status === 'loading'}
                                    title={t('explore.refresh')}
                                    aria-label={t('explore.refresh')}
                                    className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:opacity-40 ${isDaylight ? 'hover:bg-black/5' : 'hover:bg-white/10'}`}
                                >
                                    <RefreshCw size={15} className={status === 'loading' ? 'animate-spin' : undefined} />
                                </button>
                                <button
                                    type="button"
                                    onClick={onClose}
                                    title={t('explore.close')}
                                    aria-label={t('explore.close')}
                                    className={`flex h-8 w-8 items-center justify-center rounded-full transition-colors ${isDaylight ? 'hover:bg-black/5' : 'hover:bg-white/10'}`}
                                >
                                    <X size={16} />
                                </button>
                            </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5 px-6 pb-4">
                            {visibleProviders.map(provider => {
                                const active = provider.providerId === activeProviderId;
                                const configured = provider.availability.configured;
                                return (
                                    <button
                                        key={provider.providerId}
                                        type="button"
                                        onClick={() => { if (!active) onSelectProvider(provider.providerId); }}
                                        disabled={active}
                                        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[11px] font-semibold transition-colors ${active
                                            ? 'border-orange-400/40 bg-orange-500/15 text-orange-300'
                                            : isDaylight ? 'border-black/8 bg-white/70 text-zinc-600 hover:bg-white' : 'border-white/10 bg-white/5 text-zinc-300 hover:bg-white/10'}`}
                                    >
                                        <span className={`h-1.5 w-1.5 rounded-full ${configured ? 'bg-green-400' : 'bg-white/30'}`} />
                                        {provider.shortName || provider.displayName}
                                    </button>
                                );
                            })}
                        </div>

                        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-8">
                            {status === 'loading' ? (
                                <div className={`flex h-64 flex-col items-center justify-center gap-3 text-sm ${soft}`}>
                                    <Loader2 className="animate-spin" size={26} />
                                    <span>{t('explore.loading')}</span>
                                </div>
                            ) : status === 'error' ? (
                                <div className={`flex h-64 flex-col items-center justify-center gap-3 text-sm ${soft}`}>
                                    <span>{t('explore.error')}</span>
                                    <button
                                        type="button"
                                        onClick={() => setNonce(value => value + 1)}
                                        className="rounded-full bg-white/10 px-4 py-2 text-xs font-semibold text-current transition-colors hover:bg-white/15"
                                    >
                                        {t('explore.retry')}
                                    </button>
                                </div>
                            ) : data.dailySongs.length === 0 && data.recommendedCollections.length === 0 && data.personalFm.length === 0 ? (
                                <div className={`flex h-64 items-center justify-center text-sm ${soft}`}>{t('explore.empty')}</div>
                            ) : (
                                <div className="space-y-8">
                                    {data.dailySongs.length > 0 && (
                                        <section>
                                            <div className="mb-3 flex items-end justify-between">
                                                <h3 className={sectionTitle}>{t('explore.daily')}</h3>
                                                <span className={`text-[10px] ${soft}`}>{data.dailySongs.length}</span>
                                            </div>
                                            <div className="flex gap-3 overflow-x-auto pb-2">
                                                {data.dailySongs.map(song => (
                                                    <SongCard
                                                        key={getPlaybackKey(song)}
                                                        song={song}
                                                        isDaylight={isDaylight}
                                                        onPlay={() => play(song, data.dailySongs)}
                                                        onAdd={() => onAddToQueue(song)}
                                                    />
                                                ))}
                                            </div>
                                        </section>
                                    )}

                                    {data.recommendedCollections.length > 0 && (
                                        <section>
                                            <div className="mb-3 flex items-end justify-between">
                                                <h3 className={sectionTitle}>{t('explore.playlists')}</h3>
                                                <span className={`text-[10px] ${soft}`}>{data.recommendedCollections.length}</span>
                                            </div>
                                            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                                                {data.recommendedCollections.map(collection => (
                                                    <button
                                                        key={`${collection.type}:${String(collection.id)}`}
                                                        type="button"
                                                        onClick={() => onOpenCollection(createOnlineGridViewCollection(collection, activeProviderId))}
                                                        className={`group overflow-hidden rounded-2xl border text-left transition-colors ${isDaylight ? 'border-black/8 bg-white/70 hover:bg-white' : 'border-white/10 bg-white/[0.04] hover:bg-white/[0.08]'}`}
                                                    >
                                                        <span className="block aspect-square overflow-hidden bg-white/5">
                                                            {collection.coverUrl ? (
                                                                <img src={getSizedCoverUrl(collection.coverUrl, 240)} alt="" className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105" draggable={false} />
                                                            ) : (
                                                                <span className="flex h-full items-center justify-center text-2xl opacity-30">♪</span>
                                                            )}
                                                        </span>
                                                        <span className="block px-3 py-2">
                                                            <span className="line-clamp-2 text-[11px] font-semibold leading-snug">{collection.name}</span>
                                                            {collection.playCount ? (
                                                                <span className={`mt-1 block text-[9px] ${soft}`}>{formatPlayCount(collection.playCount)}</span>
                                                            ) : null}
                                                        </span>
                                                    </button>
                                                ))}
                                            </div>
                                        </section>
                                    )}

                                    {data.personalFm.length > 0 && (
                                        <section>
                                            <div className="mb-3 flex items-end justify-between">
                                                <h3 className={sectionTitle}>{t('explore.personalFm')}</h3>
                                                <span className={`text-[10px] ${soft}`}>{data.personalFm.length}</span>
                                            </div>
                                            <div className="flex gap-3 overflow-x-auto pb-2">
                                                {data.personalFm.map(song => (
                                                    <SongCard
                                                        key={getPlaybackKey(song)}
                                                        song={song}
                                                        isDaylight={isDaylight}
                                                        onPlay={() => play(song, data.personalFm)}
                                                        onAdd={() => onAddToQueue(song)}
                                                    />
                                                ))}
                                            </div>
                                        </section>
                                    )}
                                </div>
                            )}
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

const getPlaybackKey = (song: SongResult): string => {
    const ref = song.sourceRef;
    if (ref && ref.kind === 'online') return `${ref.providerId}:${ref.mediaId}`;
    return String(song.id ?? song.name);
};

const formatPlayCount = (count: number): string => {
    if (count >= 100000000) return `${(count / 100000000).toFixed(1)}亿`;
    if (count >= 10000) return `${(count / 10000).toFixed(1)}万`;
    return String(count);
};

export default ExploreOverlay;
