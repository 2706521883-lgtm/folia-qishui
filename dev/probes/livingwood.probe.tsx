import { useMemo } from 'react';
import { useMotionValue } from 'framer-motion';
import VisualizerLivingWood from '../../src/components/visualizer/livingwood/VisualizerLivingWood';
import { DEFAULT_THEME } from '../../src/services/baseThemes';
import type { Line } from '../../src/types';
import type { ProbeDefinition } from './definition';

// dev/probes/livingwood.probe.tsx
// Isolated mount of the private material-lyric visualizer. The background is
// transparent so the probe shows the lyric card itself, not the player skin.

const makeWords = (text: string, start: number, end: number) => {
    const chars = Array.from(text);
    const unit = (end - start) / Math.max(1, chars.length);
    return chars.map((char, index) => ({
        text: char,
        startTime: start + unit * index,
        endTime: start + unit * (index + 1),
    }));
};

const lines: Line[] = [
    {
        fullText: '前一句示例歌词',
        startTime: 0,
        endTime: 1.8,
        words: makeWords('前一句示例歌词', 0, 1.8),
    },
    {
        fullText: '露珠正陷入一场伟大的爱情',
        startTime: 2.2,
        endTime: 7.4,
        words: makeWords('露珠正陷入一场伟大的爱情', 2.2, 7.4),
        translation: 'Dewdrops falling into a great love',
    },
    {
        fullText: '下一句示例歌词',
        startTime: 7.6,
        endTime: 10,
        words: makeWords('下一句示例歌词', 7.6, 10),
    },
];

function LivingWoodProbe() {
    const initialTime = Number(new URLSearchParams(window.location.search).get('time'));
    const time = useMotionValue(Number.isFinite(initialTime) && initialTime > 0 ? initialTime : 4.4);
    const audioPower = useMotionValue(0.4);
    const bass = useMotionValue(0.3);
    const lowMid = useMotionValue(0.3);
    const mid = useMotionValue(0.3);
    const vocal = useMotionValue(0.3);
    const treble = useMotionValue(0.3);
    const audioBands = useMemo(() => ({ bass, lowMid, mid, vocal, treble }), [bass, lowMid, mid, vocal, treble]);

    return (
        <div style={{ height: '100vh' }}>
            <VisualizerLivingWood
                currentTime={time}
                currentLineIndex={1}
                lines={lines}
                theme={DEFAULT_THEME}
                audioPower={audioPower}
                audioBands={audioBands}
                showText
                showSubtitleTranslation
                subtitleContentMode="translation"
                isDaylight={false}
                background={{ transparent: true }}
            />
        </div>
    );
}

const probe: ProbeDefinition = {
    id: 'livingwood',
    title: 'Living Wood lyric',
    description: 'Private material lyric preset: trunk base + per-grapheme plant growth, with translation row.',
    Component: LivingWoodProbe,
};

export default probe;
