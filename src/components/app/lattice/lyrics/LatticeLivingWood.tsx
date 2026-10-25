import React, { useMemo } from 'react';
import type { LatticeLyricInput } from './types';
import LivingWoodStage from '../../../visualizer/livingwood/LivingWoodStage';
import type { LabLyricData } from '../../../visualizer/livingwood/labTypes';

// src/components/app/lattice/lyrics/LatticeLivingWood.tsx
// Material lyric card for the main lattice lyric view. The host is already the
// inset lyric box, so the stage gets zero insets; layout/timing stay the same.
export default function LatticeLivingWood({ input }: { input: LatticeLyricInput }) {
    const subtitleEnabled = input.showSubtitleTranslation !== false
        && !input.hideTranslationSubtitle
        && input.subtitleContentMode !== 'none';
    const subtitleMode = input.subtitleContentMode ?? 'translation';

    const lyrics = useMemo<LabLyricData>(() => ({
        lines: input.lines.map(line => ({
            text: line.fullText,
            startTime: line.startTime,
            endTime: line.endTime,
            words: line.words.map(word => ({
                text: word.text,
                startTime: word.startTime,
                endTime: word.endTime,
            })),
            translation: subtitleEnabled && subtitleMode !== 'romanization' ? line.translation : undefined,
            romanization: subtitleEnabled && subtitleMode !== 'translation' ? line.romanization : undefined,
        })),
    }), [input.lines, subtitleEnabled, subtitleMode]);

    return (
        <LivingWoodStage
            lyrics={lyrics}
            clock={input.currentTime}
            staticMode={Boolean(input.staticMode || input.reducedMotion)}
            layoutInset={{ top: 0, bottom: 0, side: 0 }}
            scrim="solid"
        />
    );
}
