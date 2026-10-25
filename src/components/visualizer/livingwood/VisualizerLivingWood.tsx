import React, { useMemo } from 'react';
import { DEFAULT_CLASSIC_TUNING, type ClassicTuning, type Line } from '../../../types';
import { buildPostLyricLayoutUnits, buildDisplayWordsFromLayoutUnits } from '../../../utils/lyrics/cjkSemanticLayout';
import type { LabLyricData, LabLyricWord } from './labTypes';
import type { VisualizerSharedProps } from '../definition';
import { useVisualizerRuntime } from '../runtime';
import VisualizerShell from '../VisualizerShell';
import VisualizerSubtitleOverlay from '../VisualizerSubtitleOverlay';
import { resolveSubtitleFontSizes } from '../subtitleFontSizes';
import { getLineRenderEndTime, getLineRenderHints } from '../../../utils/lyrics/renderHints';
import LivingWoodWordStage from './LivingWoodWordStage';

// src/components/visualizer/livingwood/VisualizerLivingWood.tsx
// Private "Living Wood" preset. The layout follows the classic / Luminous
// visualizer: one large centered wrapped lyric block, word timing drives the
// material growth, and the standard subtitle overlay sits at the bottom.
const LYRIC_FONT_STACK =
    "'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'STSong', 'SimSun', serif";
const LYRIC_FONT_WEIGHT = 500;

const isReadableLine = (line: Line) => /[\p{L}\p{N}]/u.test(line.fullText);

/** Keep the material card on real words during "......" interludes. */
const resolveDisplayLine = (lines: Line[], activeLine: Line | null): Line | null => {
    if (!activeLine) return null;
    if (isReadableLine(activeLine)) return activeLine;
    const index = lines.indexOf(activeLine) >= 0
        ? lines.indexOf(activeLine)
        : lines.findIndex(line => line.startTime === activeLine.startTime && line.fullText === activeLine.fullText);
    if (index >= 0) {
        for (let next = index + 1; next < lines.length; next += 1) {
            if (isReadableLine(lines[next])) return lines[next];
        }
        for (let previous = index - 1; previous >= 0; previous -= 1) {
            if (isReadableLine(lines[previous])) return lines[previous];
        }
    }
    return activeLine;
};

const resolveClassicTuning = (tuning?: ClassicTuning): ClassicTuning => ({
    enableWordRotation: tuning?.enableWordRotation ?? DEFAULT_CLASSIC_TUNING.enableWordRotation,
    breathingFloatMultiplier: Math.min(2, Math.max(0,
        tuning?.breathingFloatMultiplier ?? DEFAULT_CLASSIC_TUNING.breathingFloatMultiplier,
    )),
    useLegacyLayout: tuning?.useLegacyLayout ?? DEFAULT_CLASSIC_TUNING.useLegacyLayout,
    wordSpacing: Math.min(2, Math.max(0,
        tuning?.wordSpacing ?? DEFAULT_CLASSIC_TUNING.wordSpacing ?? 0.7,
    )),
});

const toLabWord = (word: Line['words'][number]): LabLyricWord => ({
    text: word.text,
    startTime: word.startTime,
    endTime: word.endTime,
    ...(word.syllables?.length ? { syllables: word.syllables } : {}),
});

// Same display-word contract as the classic visualizer:
// semantic CJK units keep their original per-character words so the shared
// margin/timing math behaves identically; only non-semantic sticky units merge.
const buildDisplayWords = (line: Line, useLegacyLayout: boolean): LabLyricWord[] => {
    if (useLegacyLayout) {
        return line.words.map(toLabWord);
    }
    const units = buildPostLyricLayoutUnits(line, { semantic: true, sticky: true });
    return buildDisplayWordsFromLayoutUnits(units).map(toLabWord);
};
const VisualizerLivingWood: React.FC<VisualizerSharedProps> = (props) => {
    const {
        currentTime,
        currentLineIndex,
        lines,
        theme,
        audioPower,
        audioBands,
        showText = true,
        staticMode = false,
        lyricsFontScale = 1,
    } = props;
    const { activeLine, recentCompletedLine, nextLines } = useVisualizerRuntime({
        currentTime,
        currentLineIndex,
        lines,
        getLineEndTime: getLineRenderEndTime,
    });
    const { translationFontSize, upcomingFontSize } = resolveSubtitleFontSizes(lyricsFontScale);
    const tuning = useMemo(() => resolveClassicTuning(props.classicTuning), [props.classicTuning]);
    const displayLine = resolveDisplayLine(lines, activeLine);
    // When a line has fully handed off, the classic keeps the just-finished
    // line on stage at half opacity instead of clearing the lyric layer.
    const materialLine = displayLine ?? (!activeLine ? recentCompletedLine : null);
    const activeLineKey = materialLine ? `${materialLine.startTime}|${materialLine.fullText}` : null;
    // The classic mode renders "......" as its own centered interlude. In the
    // material version we keep the next real line as a faint bark preview so an
    // intro/instrumental does not leave the stage empty.
    const previewLine = Boolean(activeLine && displayLine && displayLine !== activeLine);
    const restLine = Boolean(!activeLine && materialLine);
    const lyricFontStack = LYRIC_FONT_STACK;
    const lyricFontWeight = LYRIC_FONT_WEIGHT;

    const lyrics = useMemo<LabLyricData>(() => ({
        lines: lines.map(line => {
            const renderHints = getLineRenderHints(line);
            return {
                text: line.fullText,
                startTime: line.startTime,
                endTime: line.endTime,
                words: buildDisplayWords(line, tuning.useLegacyLayout ?? false),
                // Preserve the real render profile so the material stage can use
                // the same lookahead / active-end / entry timing as the classic mode.
                wordRevealMode: renderHints?.wordRevealMode ?? 'normal',
                lineTransitionMode: renderHints?.lineTransitionMode ?? 'normal',
                lineRenderEndTime: getLineRenderEndTime(line),
                isChorus: Boolean(line.isChorus),
            };
        }),
    }), [lines, tuning.useLegacyLayout]);

    return (
        <VisualizerShell
            theme={theme}
            audioPower={audioPower}
            audioBands={audioBands}
            sharedProps={{
                coverUrl: props.coverUrl,
                isDaylight: props.isDaylight,
                seed: props.seed,
                visualizerOpacity: props.visualizerOpacity,
                background: props.background,
                staticMode: props.staticMode,
                backgroundStaticMode: props.backgroundStaticMode,
                paused: props.paused,
                windowHidden: props.windowHidden,
                onBack: props.onBack,
                isPanelOpen: props.isPanelOpen,
                alwaysShowBackButton: props.alwaysShowBackButton,
                onPlayerPanelGuideHotspotChange: props.onPlayerPanelGuideHotspotChange,
                isPreviewMode: props.isPreviewMode,
            }}
            className="visualizer-livingwood"
        >
            {showText && (
                <LivingWoodWordStage
                    lyrics={lyrics}
                    clock={currentTime}
                    staticMode={staticMode}
                    fontScale={lyricsFontScale}
                    intensity={theme.animationIntensity}
                    accentColor={theme.accentColor}
                    wordColors={theme.wordColors}
                    tuning={tuning}
                    activeLineKey={activeLineKey}
                    previewLine={previewLine}
                    restLine={restLine}
                    fontStack={lyricFontStack}
                    fontWeight={lyricFontWeight}
                />
            )}
            {showText && !activeLineKey && (
                <div className="pointer-events-none absolute inset-0 z-10 flex flex-col items-center justify-center px-8 text-center">
                    <div
                        style={{
                            color: theme.primaryColor,
                            fontFamily: lyricFontStack,
                            fontWeight: lyricFontWeight,
                            fontSize: `clamp(${(1.5 * lyricsFontScale).toFixed(3)}rem, ${(3.5 * lyricsFontScale).toFixed(3)}vw, ${(2.25 * lyricsFontScale).toFixed(3)}rem)`,
                            opacity: 0.5,
                        }}
                    >
                        {props.songTitle}
                    </div>
                    {props.songTitle && props.songArtist && (
                        <div
                            className="mt-2"
                            style={{
                                color: theme.secondaryColor,
                                fontFamily: lyricFontStack,
                                fontSize: `clamp(${(0.9 * lyricsFontScale).toFixed(3)}rem, ${(1.7 * lyricsFontScale).toFixed(3)}vw, ${(1.15 * lyricsFontScale).toFixed(3)}rem)`,
                                opacity: 0.55,
                            }}
                        >
                            {props.songArtist}
                        </div>
                    )}
                </div>
            )}
            <VisualizerSubtitleOverlay
                showText={showText}
                activeLine={activeLine}
                recentCompletedLine={recentCompletedLine}
                nextLines={nextLines}
                theme={theme}
                subtitleTheme={props.subtitleTheme}
                translationFontSize={translationFontSize}
                upcomingFontSize={upcomingFontSize}
                subtitleOverlayOpacity={props.subtitleOverlayOpacity}
                subtitleOverlayBackground={props.subtitleOverlayBackground}
                subtitleUpcomingLyricsBlur={props.subtitleUpcomingLyricsBlur}
                subtitleFontScale={props.subtitleFontScale}
                isPlayerChromeHidden={props.isPlayerChromeHidden}
                hideTranslationSubtitle={props.hideTranslationSubtitle}
                showSubtitleTranslation={props.showSubtitleTranslation}
                subtitleContentMode={props.subtitleContentMode}
            />
        </VisualizerShell>
    );
};

export default VisualizerLivingWood;
