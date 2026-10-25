import { useMemo, useRef } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useFontsEpoch } from '../../../../hooks/useFontsEpoch';
import { useVisualizerSettingsStore } from '../../../../stores/useVisualizerSettingsStore';
import LatticeLivingWood from './LatticeLivingWood';
import { useLatticeLyrics } from './LatticeLyricsProvider';
import { useLatticeLyricCanvas } from './useLatticeLyricCanvas';
import type { LatticeTile } from '../latticeModel';
import './LatticeLyrics.css';

// src/components/app/lattice/lyrics/LatticeLyrics.tsx
export default function LatticeLyrics({ tile, reducedMotion }: { tile: LatticeTile; reducedMotion: boolean }) {
    const source = useLatticeLyrics();
    const fontsEpoch = useFontsEpoch();
    const host = useRef<HTMLDivElement>(null);
    const livingWood = useVisualizerSettingsStore(state => state.visualizerMode === 'livingwood');
    const input = useMemo(() => source && source.songKey === tile.id
        ? { ...source, fontsEpoch, reducedMotion } : null, [source, tile.id, fontsEpoch, reducedMotion]);
    const ready = useLatticeLyricCanvas(host, livingWood ? null : input);
    const materialReady = livingWood && Boolean(input);
    const line = input?.lines[input.currentLineIndex];
    return <>
        <AnimatePresence initial={false}>
            <motion.span
                key={ready || materialReady ? 'lyrics-ready' : 'lyrics-loading'}
                className={`lattice-poster-copy ${ready || materialReady ? 'lattice-lyric-metadata' : ''}`}
                initial={{ opacity: reducedMotion ? 1 : 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: reducedMotion ? 1 : 0 }}
                transition={{ duration: reducedMotion ? 0 : 0.24, ease: 'easeInOut' }}
            >
                <strong>{tile.title}</strong><small>{tile.artist}</small>
            </motion.span>
        </AnimatePresence>
        <div className={`lattice-lyrics ${ready || materialReady ? 'is-ready' : ''}`}>
            <div ref={host} className="lattice-lyrics-canvas" aria-hidden="true">
                {materialReady && input ? <LatticeLivingWood input={input} /> : null}
            </div>
            {(ready || materialReady) && <span className="sr-only">{line?.fullText}</span>}
        </div>
    </>;
}
