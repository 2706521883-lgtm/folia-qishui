import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, Reorder, motion } from 'framer-motion';
import { GripVertical, ListEnd, ListPlus, ListMusic, Shuffle, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { SongResult } from '../../../types';
import { getSongArtistLabel, getSongCoverUrl } from '../../../services/onlineMusic/songMetadata';
import { getSizedCoverUrl } from '../../../utils/coverUrl';
import { getPlaybackSongKey } from '../../../utils/appPlaybackGuards';
import { canSaveQueueAsLocalPlaylist } from '../../../utils/queueReorder';
import { isTextEntryTarget } from '../../../utils/keyboardTargets';
import TextInputDialog from '../../shared/TextInputDialog';

// src/components/app/wall-queue/WallQueuePanel.tsx
// 墙面工具里的「播放队列」浮岛。与上游 0.7.18 的队列浮岛同一件事：不离开墙就能点歌、拖动排序、
// 下一首 / 移到末尾 / 移除、清空与存为本地歌单。这里用 framer-motion 的 Reorder 做拖拽，不引入
// react-window；队列一般只有几十首，普通滚动足够。

interface WallQueuePanelProps {
    isOpen: boolean;
    playQueue: SongResult[];
    currentSong: SongResult | null;
    isDaylight: boolean;
    onClose: () => void;
    onPlaySong: (song: SongResult, queue: SongResult[]) => void;
    onRemoveSong: (index: number) => void;
    onMoveSongToNext: (index: number) => void;
    onMoveSongToEnd: (index: number) => void;
    onMoveSong: (from: number, to: number) => void;
    onClearQueue: () => void;
    onShuffle: () => void;
    onSaveCurrentQueueAsPlaylist?: (name: string) => Promise<void>;
}

const WallQueuePanel: React.FC<WallQueuePanelProps> = ({
    isOpen,
    playQueue,
    currentSong,
    isDaylight,
    onClose,
    onPlaySong,
    onRemoveSong,
    onMoveSongToNext,
    onMoveSongToEnd,
    onMoveSong,
    onClearQueue,
    onShuffle,
    onSaveCurrentQueueAsPlaylist,
}) => {
    const { t } = useTranslation();
    const listRef = useRef<HTMLDivElement>(null);
    const currentKey = currentSong ? getPlaybackSongKey(currentSong) : null;
    const [saveOpen, setSaveOpen] = useState(false);
    const [clearArmed, setClearArmed] = useState(false);

    useEffect(() => {
        if (!isOpen) return undefined;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.repeat || event.isComposing || isTextEntryTarget(event.target)) return;
            if (saveOpen) {
                setSaveOpen(false);
                return;
            }
            if (clearArmed) {
                setClearArmed(false);
                return;
            }
            event.preventDefault();
            onClose();
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [clearArmed, isOpen, onClose, saveOpen]);

    useEffect(() => {
        if (!isOpen || !currentKey) return;
        const frame = requestAnimationFrame(() => {
            listRef.current?.querySelector<HTMLElement>('[data-wall-queue-current="true"]')
                ?.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });
        });
        return () => cancelAnimationFrame(frame);
    }, [currentKey, isOpen]);

    const currentIndex = useMemo(
        () => (currentKey ? playQueue.findIndex(song => getPlaybackSongKey(song) === currentKey) : -1),
        [currentKey, playQueue],
    );

    const handleReorder = (nextQueue: SongResult[]) => {
        const moved = nextQueue.find((song, index) => song !== playQueue[index]);
        if (!moved) return;
        const from = playQueue.indexOf(moved);
        const to = nextQueue.indexOf(moved);
        if (from >= 0 && to >= 0) onMoveSong(from, to);
    };

    const rowChrome = isDaylight
        ? 'border-black/8 bg-white/80 text-zinc-900'
        : 'border-white/10 bg-zinc-900/90 text-zinc-100';
    const softText = isDaylight ? 'text-zinc-500' : 'text-zinc-400';

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0, y: 14, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: 10, scale: 0.98 }}
                    transition={{ type: 'spring', bounce: 0, duration: 0.38 }}
                    className={`fixed bottom-24 right-4 z-[95] flex max-h-[min(60vh,620px)] w-[360px] max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-3xl border shadow-2xl backdrop-blur-xl ${rowChrome}`}
                    role="dialog"
                    aria-label={t('wallQueue.title')}
                    data-wall-queue-panel="open"
                >
                    <div className={`flex items-center gap-2 border-b px-4 py-3 ${isDaylight ? 'border-black/8' : 'border-white/10'}`}>
                        <ListMusic size={16} className="shrink-0 opacity-70" />
                        <span className="text-sm font-bold">{t('wallQueue.title')}</span>
                        <span className={`text-[11px] ${softText}`}>{playQueue.length}</span>
                        <div className="ml-auto flex items-center gap-0.5">
                            <button
                                type="button"
                                onClick={onShuffle}
                                disabled={playQueue.length < 2}
                                title={t('wallQueue.shuffle')}
                                aria-label={t('wallQueue.shuffle')}
                                className={`rounded-lg p-1.5 transition-colors disabled:opacity-30 ${isDaylight ? 'hover:bg-black/5' : 'hover:bg-white/10'}`}
                            >
                                <Shuffle size={14} />
                            </button>
                            <button
                                type="button"
                                onClick={() => {
                                    if (!clearArmed) {
                                        setClearArmed(true);
                                        window.setTimeout(() => setClearArmed(false), 3000);
                                        return;
                                    }
                                    setClearArmed(false);
                                    onClearQueue();
                                }}
                                disabled={playQueue.length === 0}
                                title={clearArmed ? t('wallQueue.clearConfirm') : t('wallQueue.clear')}
                                aria-label={clearArmed ? t('wallQueue.clearConfirm') : t('wallQueue.clear')}
                                className={`rounded-lg px-2 py-1.5 text-[11px] font-semibold transition-colors disabled:opacity-30 ${clearArmed
                                    ? 'bg-red-500/15 text-red-400'
                                    : isDaylight ? 'hover:bg-black/5' : 'hover:bg-white/10'}`}
                            >
                                {clearArmed ? t('wallQueue.clearConfirm') : <Trash2 size={14} />}
                            </button>
                            <button
                                type="button"
                                onClick={onClose}
                                title={t('wallQueue.close')}
                                aria-label={t('wallQueue.close')}
                                className={`rounded-lg p-1.5 transition-colors ${isDaylight ? 'hover:bg-black/5' : 'hover:bg-white/10'}`}
                            >
                                <X size={15} />
                            </button>
                        </div>
                    </div>

                    <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
                        {playQueue.length === 0 ? (
                            <div className={`flex h-32 flex-col items-center justify-center gap-1 text-xs ${softText}`}>
                                <ListMusic size={22} className="opacity-40" />
                                <span>{t('wallQueue.empty')}</span>
                            </div>
                        ) : (
                            <Reorder.Group axis="y" values={playQueue} onReorder={handleReorder} className="flex flex-col gap-0.5">
                                {playQueue.map((song, index) => {
                                    const isCurrent = getPlaybackSongKey(song) === currentKey;
                                    const cover = getSizedCoverUrl(getSongCoverUrl(song), 64);
                                    return (
                                        <Reorder.Item
                                            key={`${getPlaybackSongKey(song)}-${index}`}
                                            value={song}
                                            data-wall-queue-current={isCurrent ? 'true' : 'false'}
                                            className={`group flex cursor-pointer items-center gap-2 rounded-xl px-2 py-1.5 transition-colors ${isCurrent
                                                ? isDaylight ? 'bg-black/[0.08]' : 'bg-white/[0.12]'
                                                : isDaylight ? 'hover:bg-black/[0.04]' : 'hover:bg-white/[0.06]'}`}
                                            onClick={() => onPlaySong(song, playQueue)}
                                        >
                                            <span className={`cursor-grab active:cursor-grabbing opacity-25 group-hover:opacity-60 ${softText}`} aria-hidden>
                                                <GripVertical size={13} />
                                            </span>
                                            <span className="relative h-8 w-8 shrink-0 overflow-hidden rounded-md bg-white/10">
                                                {cover ? <img src={cover} alt="" className="h-full w-full object-cover" draggable={false} /> : null}
                                            </span>
                                            <span className="min-w-0 flex-1">
                                                <span className={`block truncate text-xs font-semibold ${isCurrent ? 'text-[color:var(--text-accent,#fb923c)]' : ''}`}>
                                                    {song.name}
                                                </span>
                                                <span className={`block truncate text-[10px] ${softText}`}>{getSongArtistLabel(song)}</span>
                                            </span>
                                            <span className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                                                <button
                                                    type="button"
                                                    title={t('wallQueue.playNext')}
                                                    aria-label={t('wallQueue.playNext')}
                                                    onClick={event => { event.stopPropagation(); onMoveSongToNext(index); }}
                                                    className={`rounded-md p-1 transition-colors ${isDaylight ? 'hover:bg-black/10' : 'hover:bg-white/15'}`}
                                                >
                                                    <ListPlus size={13} />
                                                </button>
                                                <button
                                                    type="button"
                                                    title={t('wallQueue.moveToEnd')}
                                                    aria-label={t('wallQueue.moveToEnd')}
                                                    onClick={event => { event.stopPropagation(); onMoveSongToEnd(index); }}
                                                    className={`rounded-md p-1 transition-colors ${isDaylight ? 'hover:bg-black/10' : 'hover:bg-white/15'}`}
                                                >
                                                    <ListEnd size={13} />
                                                </button>
                                                <button
                                                    type="button"
                                                    title={t('wallQueue.remove')}
                                                    aria-label={t('wallQueue.remove')}
                                                    disabled={index === currentIndex}
                                                    onClick={event => { event.stopPropagation(); onRemoveSong(index); }}
                                                    className={`rounded-md p-1 transition-colors disabled:opacity-25 ${isDaylight ? 'hover:bg-black/10' : 'hover:bg-white/15'}`}
                                                >
                                                    <Trash2 size={13} />
                                                </button>
                                            </span>
                                        </Reorder.Item>
                                    );
                                })}
                            </Reorder.Group>
                        )}
                    </div>

                    <div className={`flex items-center justify-between border-t px-4 py-2 text-[10px] ${isDaylight ? 'border-black/8' : 'border-white/10'} ${softText}`}>
                        <span>{t('wallQueue.hint')}</span>
                        {canSaveQueueAsLocalPlaylist(currentSong, playQueue) && onSaveCurrentQueueAsPlaylist && (
                            <button
                                type="button"
                                onClick={() => setSaveOpen(true)}
                                className={`rounded-full px-2.5 py-1 text-[10px] font-semibold transition-colors ${isDaylight ? 'hover:bg-black/5' : 'hover:bg-white/10'}`}
                            >
                                {t('localMusic.saveQueueAsPlaylist')}
                            </button>
                        )}
                    </div>
                </motion.div>
            )}
            {isOpen && (
                <TextInputDialog
                    isOpen={saveOpen}
                    title={t('localMusic.saveQueueAsPlaylist')}
                    placeholder={t('localMusic.saveQueueAsPlaylist')}
                    isDaylight={isDaylight}
                    onClose={() => setSaveOpen(false)}
                    onConfirm={name => {
                        setSaveOpen(false);
                        void onSaveCurrentQueueAsPlaylist?.(name);
                    }}
                />
            )}
        </AnimatePresence>
    );
};

export default WallQueuePanel;
