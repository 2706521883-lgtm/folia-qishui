import React, { useEffect, useRef, useState } from 'react';
import type { MotionValue } from 'framer-motion';
import type { ClassicTuning, Theme } from '../../../types';
import { buildWordGraphemeTimings, splitLyricGraphemes } from '../../../utils/lyrics/graphemeTiming';
import { resolveWordColor } from '../wordColoring';
import type { LabLyricData, LabLyricLine, LabLyricWord } from './labTypes';

// Relative to dist/index.html; packaged Folia runs from file://.
const BARK_SURFACE = 'textures/bark-surface.png';
const PLANT_SURFACE = 'textures/plant-surface.png';

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
const easeSmooth = (value: number) => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};
const colorWithAlpha = (color: string, alpha: number): string => {
  const value = color.trim();
  if (value.startsWith('#')) {
    let hex = value.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      hex = hex.slice(0, 3).split('').map(char => char + char).join('');
    }
    if (hex.length === 6 || hex.length === 8) {
      const numeric = Number.parseInt(hex.slice(0, 6), 16);
      if (Number.isFinite(numeric)) {
        return `rgba(${(numeric >> 16) & 255}, ${(numeric >> 8) & 255}, ${numeric & 255}, ${alpha})`;
      }
    }
  }
  const rgb = value.match(/^rgba?\(([^)]+)\)$/i);
  if (rgb) {
    const parts = rgb[1].split(/[,\s/]+/).map(Number);
    if (parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite)) {
      return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${alpha})`;
    }
  }
  return alpha > 0 ? value : 'transparent';
};
const resolveWordTimings = (word: LabLyricWord): GraphemeTiming[] => {
  if (word.syllables?.length) {
    return buildWordGraphemeTimings({
      text: word.text,
      startTime: word.startTime,
      endTime: word.endTime,
      syllables: word.syllables,
    }).map(timing => ({ startTime: timing.startTime, endTime: timing.endTime }));
  }
  return evenTimings(word.text, word.startTime, word.endTime);
};

const springStep = (
  value: number,
  velocity: number,
  target: number,
  delta: number,
  stiffness = 200,
  damping = 20,
) => {
  const steps = Math.max(1, Math.ceil(delta * 120));
  const dt = delta / steps;
  let next = value;
  let nextVelocity = velocity;
  for (let index = 0; index < steps; index += 1) {
    nextVelocity += ((target - next) * stiffness - nextVelocity * damping) * dt;
    next += nextVelocity * dt;
  }
  const settled = Math.abs(next - target) < 0.01 && Math.abs(nextVelocity) < 0.01;
  return {
    value: settled ? target : next,
    velocity: settled ? 0 : nextVelocity,
  };
};

const createCanvas = (width: number, height: number) => {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(width));
  canvas.height = Math.max(1, Math.ceil(height));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D is not available');
  return { canvas, context };
};

const drawImageCover = (
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  x: number,
  y: number,
  width: number,
  height: number,
) => {
  const iw = image.naturalWidth || image.width;
  const ih = image.naturalHeight || image.height;
  if (iw <= 0 || ih <= 0) return;
  const scale = Math.max(width / iw, height / ih);
  const sw = width / scale;
  const sh = height / scale;
  context.drawImage(image, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, width, height);
};

type GraphemeTiming = { startTime: number; endTime: number };

const getLineRenderEndTime = (line: LabLyricLine): number => {
  const raw = Math.max(line.endTime - line.startTime, 0);
  const micro = raw < 0.1;
  const short = !micro && raw < 0.18;
  if (micro) return Math.max(line.endTime, line.startTime + 0.067);
  const enter = short
    ? clamp(raw * 0.45, 0.045, 0.06)
    : Math.min(0.42, Math.max(0.22, Math.max(raw, 0.12) * 0.34));
  const exit = short
    ? clamp(raw * 0.22, 0.03, 0.04)
    : Math.min(0.32, Math.max(0.18, Math.max(raw, 0.12) * 0.18));
  const hold = short ? 0.03 : 0.06;
  const lastWordEnd = line.words.length
    ? line.words[line.words.length - 1].endTime
    : line.endTime;
  const passStart = Math.max(lastWordEnd, line.startTime) + hold;
  const exitStart = short
    ? Math.max(line.startTime + enter + 0.01, passStart, line.endTime - exit)
    : Math.max(passStart, line.endTime - exit);
  return Math.max(line.endTime, exitStart + exit);
};

const findActiveLineIndex = (lines: LabLyricLine[], time: number): number => {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (time < line.startTime) continue;
    if (time <= getLineRenderEndTime(line)) return index;
  }
  return -1;
};

const evenTimings = (text: string, start: number, end: number): GraphemeTiming[] => {
  const graphemes = splitLyricGraphemes(text);
  if (graphemes.length === 0) return [];
  const duration = Math.max(end - start, 0);
  const unit = duration / graphemes.length;
  return graphemes.map((_, index) => ({
    startTime: start + unit * index,
    endTime: index === graphemes.length - 1 ? end : start + unit * (index + 1),
  }));
};

const resolveFillWidth = (
  time: number,
  start: number,
  end: number,
  offsets: number[],
  timings: GraphemeTiming[],
): number => {
  const width = offsets[offsets.length - 1] ?? 0;
  if (time <= start) return 0;
  if (time >= end) return width;
  const count = Math.min(timings.length, offsets.length - 1);
  if (count > 0) {
    for (let index = 0; index < count; index += 1) {
      const timing = timings[index];
      const timingStart = Math.max(start, timing.startTime);
      const timingEnd = Math.max(timingStart, timing.endTime);
      if (time < timingStart) return offsets[index];
      if (time <= timingEnd) {
        const progress = (time - timingStart) / Math.max(0.001, timingEnd - timingStart);
        return offsets[index] + (offsets[index + 1] - offsets[index]) * progress;
      }
    }
    return offsets[count] ?? width;
  }
  const index = clamp((time - start) / Math.max(0.001, end - start), 0, 1) * (offsets.length - 1);
  const whole = Math.floor(index);
  return (
    (offsets[whole] ?? width) +
    ((offsets[whole + 1] ?? width) - (offsets[whole] ?? width)) * (index - whole)
  );
};

const materialLayer = (
  width: number,
  height: number,
  dpr: number,
  mask: HTMLCanvasElement,
  image: HTMLImageElement,
  filter: string,
) => {
  const { canvas, context } = createCanvas(width * dpr, height * dpr);
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.drawImage(mask, 0, 0, width, height);
  context.globalCompositeOperation = 'source-in';
  context.filter = filter;
  drawImageCover(context, image, 0, 0, width, height);
  context.filter = 'none';
  context.globalCompositeOperation = 'source-over';
  return canvas;
};

const measureCache = new Map<string, Map<string, number>>();
const measureText = (text: string, font: string): number => {
  let byFont = measureCache.get(font);
  if (!byFont) {
    byFont = new Map();
    measureCache.set(font, byFont);
  }
  const cached = byFont.get(text);
  if (cached !== undefined) return cached;
  const { context } = createCanvas(4, 4);
  context.font = font;
  const width = context.measureText(text).width;
  byFont.set(text, width);
  return width;
};

type WordConfig = {
  x: number;
  y: number;
  rotate: number;
  passedRotate: number;
  scale: number;
  marginRight: number;
};

type WordAsset = {
  index: number;
  text: string;
  startTime: number;
  endTime: number;
  width: number;
  canvasW: number;
  canvasH: number;
  pad: number;
  trunkLayer: HTMLCanvasElement;
  plantLayer: HTMLCanvasElement;
  offsets: number[];
  timings: GraphemeTiming[];
  config: WordConfig;
  baseX: number;
  baseY: number;
};

type LineWordAssets = {
  key: string;
  lineKey: string;
  fontPx: number;
  lineHeight: number;
  maxWidth: number;
  blockHeight: number;
  words: WordAsset[];
};

type WordState = {
  scale: number;
  scaleV: number;
  rotation: number;
  rotationV: number;
  alpha: number;
  ox: number;
  oxV: number;
  oy: number;
  oyV: number;
  initialized: boolean;
};

const resolveConfigs = (
  line: LabLyricLine,
  widths: number[],
  fontPx: number,
  tuning: ClassicTuning,
  intensity: Theme['animationIntensity'],
): WordConfig[] => {
  const seed = line.startTime;
  const chaotic = intensity === 'chaotic';
  const calm = intensity === 'calm';
  const baseSpread = chaotic ? 60 : calm ? 0 : 20;
  const baseRotate = chaotic ? 30 : calm ? 0 : 5;
  const spacing = clamp(tuning.wordSpacing ?? 0.7, 0, 2);
  const configs = widths.map((_, index) => {
    const wordSeed = seed + index;
    const random = (offset: number) => {
      const x = Math.sin(wordSeed + offset) * 10000;
      return x - Math.floor(x);
    };
    const scale = chaotic ? 0.8 + random(4) * 0.6 : 1.1 + random(4) * 0.2;
    const x = (random(1) - 0.5) * baseSpread * 2;
    const y = (random(2) - 0.5) * baseSpread * 2;
    const rotate = tuning.enableWordRotation
      ? (random(3) - 0.5) * baseRotate * 2
      : 0;
    const passedRotate = tuning.enableWordRotation
      ? (random(8) - 0.5) * 45
      : 0;
    // Legacy layout uses the classic's fixed rem margins verbatim.
    const marginRight = tuning.useLegacyLayout
      ? chaotic
        ? random(5) * 1.5 * 16
        : 0.8 * 16
      : 0;
    return { x, y, rotate, passedRotate, scale, marginRight };
  });

  configs.forEach((config, index) => {
    if (tuning.useLegacyLayout) {
      return;
    }
    const width = widths[index] ?? 0;
    const scale = config.scale * 1.4;
    const next = configs[index + 1];
    const nextWidth = widths[index + 1] ?? 0;
    const nextScale = next ? next.scale * 1.4 : 1;
    const halfOverflow = width * (scale - 1) / 2;
    const nextHalfOverflow = nextWidth * (nextScale - 1) / 2;
    const xOffsetDiff = config.x - (next?.x ?? 0);
    const gap = 0.05 * fontPx;
    const calculated = (halfOverflow + nextHalfOverflow + xOffsetDiff + gap) * spacing;
    const minMargin = (chaotic ? 0.08 * fontPx : 0.12 * fontPx) * spacing;
    config.marginRight = Math.max(minMargin, calculated);
  });
  return configs;
};

const buildLineAssets = (
  line: LabLyricLine,
  width: number,
  dpr: number,
  fontScale: number,
  fontStack: string,
  fontWeight: number,
  tuning: ClassicTuning,
  intensity: Theme['animationIntensity'],
  bark: HTMLImageElement,
  plant: HTMLImageElement,
): LineWordAssets => {
  // Use the actual stage width. In the full player this equals the classic's
  // viewport-based clamp; in an embedded preview it keeps the same formula from
  // overflowing the smaller card (which otherwise stacked rows into each other).
  const layoutWidth = Math.max(1, width);
  const fontPx = Math.max(
    2.25 * 16 * fontScale,
    Math.min((6 * layoutWidth / 100) * fontScale, 4.5 * 16 * fontScale),
  );
  const font = `${fontWeight} ${fontPx}px ${fontStack}`;
  const lineHeight = fontPx * 1.22;
  // Extra side inset over the classic 32px padding: an active/passed word can
  // scale 1.4x and rotate past the glyph box, clipping the first character on
  // narrower player windows.
  const maxWidth = Math.max(240, Math.min(1152, width - 128));
  const pad = Math.ceil(fontPx * 0.75);
  const rawWords = line.words.length > 0
    ? line.words
    : [{ text: line.text, startTime: line.startTime, endTime: line.endTime }];
  const widths = rawWords.map((word) => measureText(word.text, font));
  const configs = resolveConfigs(line, widths, fontPx, tuning, intensity);

  // Mirror the classic flex line exactly: wrap on the same outer widths, then
  // distribute each wrapped row with the same deterministic justify option.
  const isCalm = intensity === 'calm';
  const justifyOptions = isCalm
    ? ['center']
    : ['start', 'center', 'end', 'around', 'between'];
  const justify = justifyOptions[Math.floor(line.startTime % justifyOptions.length)];
  const rowItems: Array<Array<{ index: number; width: number; marginRight: number }>> = [[]];
  rawWords.forEach((_, index) => {
    const width = widths[index] ?? 0;
    const marginRight = configs[index].marginRight;
    const slot = width + marginRight;
    let currentRow = rowItems[rowItems.length - 1];
    const currentOuter = currentRow.reduce(
      (sum, item) => sum + item.width + item.marginRight,
      0,
    );
    if (currentRow.length > 0 && currentOuter + slot > maxWidth) {
      currentRow = [];
      rowItems.push(currentRow);
    }
    currentRow.push({ index, width, marginRight });
  });
  const placements: Array<{ row: number; x: number }> = [];
  rowItems.forEach((items, rowIndex) => {
    const outer = items.reduce((sum, item) => sum + item.width + item.marginRight, 0);
    const free = Math.max(0, maxWidth - outer);
    let leading = 0;
    let between = 0;
    if (justify === 'center') {
      leading = free / 2;
    } else if (justify === 'end') {
      leading = free;
    } else if (justify === 'around') {
      leading = free / (items.length * 2);
      between = free / items.length;
    } else if (justify === 'between') {
      between = items.length > 1 ? free / (items.length - 1) : 0;
    }
    let cursor = leading;
    items.forEach((item, itemIndex) => {
      placements[item.index] = { row: rowIndex, x: cursor };
      cursor += item.width + item.marginRight;
      if (itemIndex < items.length - 1) cursor += between;
    });
  });
  const rows = Math.max(1, rowItems.length);
  const blockHeight = rows * lineHeight;
  const key = `${line.startTime}|${line.endTime}|${line.text}|${Math.round(width)}|${fontPx}|${font}|${intensity}|${tuning.enableWordRotation}|${tuning.breathingFloatMultiplier}|${tuning.useLegacyLayout}|${tuning.wordSpacing}|${dpr}`;

  const words: WordAsset[] = rawWords.map((word, index) => {
    const glyphs = splitLyricGraphemes(word.text);
    const offsets = [0];
    for (let i = 1; i <= glyphs.length; i += 1) {
      offsets.push(measureText(glyphs.slice(0, i).join(''), font));
    }
    const wordWidth = offsets[offsets.length - 1] ?? 0;
    const canvasW = wordWidth + pad * 2;
    const canvasH = lineHeight + pad * 2;
    const { canvas: mask, context: maskContext } = createCanvas(canvasW * dpr, canvasH * dpr);
    maskContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    maskContext.font = font;
    maskContext.fillStyle = '#ffffff';
    maskContext.textAlign = 'left';
    maskContext.textBaseline = 'alphabetic';
    maskContext.fillText(word.text, pad, pad + fontPx * 0.92);

    const placement = placements[index] ?? { row: 0, x: 0 };
    return {
      index,
      text: word.text,
      startTime: word.startTime,
      endTime: word.endTime,
      width: wordWidth,
      canvasW,
      canvasH,
      pad,
      trunkLayer: materialLayer(
        canvasW,
        canvasH,
        dpr,
        mask,
        bark,
        'brightness(1.8) contrast(1.05) saturate(1.6)',
      ),
      plantLayer: materialLayer(
        canvasW,
        canvasH,
        dpr,
        mask,
        plant,
        'brightness(1.25) saturate(1.15)',
      ),
      offsets,
      timings: resolveWordTimings(word),
      config: configs[index],
      baseX: placement.x + wordWidth / 2,
      baseY: placement.row * lineHeight + lineHeight / 2,
    };
  });

  return {
    key,
    lineKey: `${line.startTime}|${line.text}`,
    fontPx,
    lineHeight,
    maxWidth,
    blockHeight,
    words,
  };
};

type LivingWoodWordStageProps = {
  lyrics: LabLyricData | null;
  clock: MotionValue<number>;
  staticMode?: boolean;
  fontScale?: number;
  fontStack: string;
  fontWeight: number;
  intensity: Theme['animationIntensity'];
  accentColor: string;
  wordColors?: Theme['wordColors'];
  tuning: ClassicTuning;
  activeLineKey?: string | null;
  previewLine?: boolean;
  restLine?: boolean;
};

const LivingWoodWordStage = ({
  lyrics,
  clock,
  staticMode = false,
  fontScale = 1,
  fontStack,
  fontWeight,
  intensity,
  accentColor,
  wordColors,
  tuning,
  activeLineKey = null,
  previewLine = false,
  restLine = false,
}: LivingWoodWordStageProps) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const barkRef = useRef<HTMLImageElement | null>(null);
  const plantRef = useRef<HTMLImageElement | null>(null);
  const [ready, setReady] = useState(false);
  const stateRef = useRef({
    lyrics,
    staticMode,
    fontScale,
    fontStack,
    fontWeight,
    intensity,
    accentColor,
    wordColors,
    tuning,
    activeLineKey,
    previewLine,
    restLine,
  });
  const assetsRef = useRef<LineWordAssets | null>(null);
  const wordStatesRef = useRef<Map<string, WordState>>(new Map());
  const entryRef = useRef<{ key: string; startedAt: number } | null>(null);

  stateRef.current = {
    lyrics,
    staticMode,
    fontScale,
    fontStack,
    fontWeight,
    intensity,
    accentColor,
    wordColors,
    tuning,
    activeLineKey,
    previewLine,
    restLine,
  };

  useEffect(() => {
    let cancelled = false;
    const bark = new Image();
    const plant = new Image();
    let loaded = 0;
    const onLoad = () => {
      loaded += 1;
      if (loaded < 2 || cancelled) return;
      barkRef.current = bark;
      plantRef.current = plant;
      setReady(true);
    };
    bark.onload = onLoad;
    plant.onload = onLoad;
    bark.src = BARK_SURFACE;
    plant.src = PLANT_SURFACE;
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    let frame = 0;
    let lastFrame = performance.now();
    const feather = document.createElement('canvas');
    const featherContext = feather.getContext('2d');

    const render = () => {
      const wrap = wrapRef.current;
      const canvas = canvasRef.current;
      const bark = barkRef.current;
      const plant = plantRef.current;
      if (!wrap || !canvas || !bark || !plant) {
        frame = requestAnimationFrame(render);
        return;
      }
      const width = Math.max(1, wrap.clientWidth);
      const height = Math.max(1, wrap.clientHeight);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const pixelWidth = Math.round(width * dpr);
      const pixelHeight = Math.round(height * dpr);
      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }
      const context = canvas.getContext('2d');
      if (!context) {
        frame = requestAnimationFrame(render);
        return;
      }

      const now = performance.now();
      const delta = clamp((now - lastFrame) / 1000, 0.001, 0.05);
      lastFrame = now;
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);

      const current = stateRef.current;
      const lines = current.lyrics?.lines ?? [];
      const time = clockRef.current.get();
      let line: LabLyricLine | null = null;
      if (current.activeLineKey) {
        line = lines.find((item) => `${item.startTime}|${item.text}` === current.activeLineKey) ?? null;
      }
      if (!line) {
        const activeIndex = findActiveLineIndex(lines, time);
        line = activeIndex >= 0 ? lines[activeIndex] : null;
      }
      if (!line) {
        assetsRef.current = null;
        wordStatesRef.current.clear();
        frame = requestAnimationFrame(render);
        return;
      }

      const lineKey = `${line.startTime}|${line.text}`;
      const expectedFontPx = Math.max(
        2.25 * 16 * current.fontScale,
        Math.min((6 * width / 100) * current.fontScale, 4.5 * 16 * current.fontScale),
      );
      const expectedFont = `${current.fontWeight} ${expectedFontPx}px ${current.fontStack}`;
      const expectedKey = `${line.startTime}|${line.endTime}|${line.text}|${Math.round(width)}|${expectedFontPx}|${expectedFont}|${current.intensity}|${current.tuning.enableWordRotation}|${current.tuning.breathingFloatMultiplier}|${current.tuning.useLegacyLayout}|${current.tuning.wordSpacing}|${dpr}`;
      if (assetsRef.current?.key !== expectedKey) {
        assetsRef.current = buildLineAssets(
          line,
          width,
          dpr,
          current.fontScale,
          current.fontStack,
          current.fontWeight,
          current.tuning,
          current.intensity,
          bark,
          plant,
        );
        wordStatesRef.current.clear();
      }
      const assets = assetsRef.current;
      if (!assets) {
        frame = requestAnimationFrame(render);
        return;
      }

      if (entryRef.current?.key !== lineKey) {
        entryRef.current = { key: lineKey, startedAt: now };
      }
      const quiet = Boolean(current.staticMode);
      // Same three line-entry profiles as the classic visualizer.
      const transitionMode = line.lineTransitionMode ?? 'normal';
      const entryDuration = quiet || transitionMode === 'none'
        ? 0
        : transitionMode === 'fast'
          ? 160
          : 300;
      const entryRaw = entryDuration <= 0
        ? 1
        : clamp((now - (entryRef.current?.startedAt ?? now)) / entryDuration, 0, 1);
      const entry = quiet || transitionMode === 'none'
        ? 1
        : transitionMode === 'fast'
          ? 1 - (1 - entryRaw) ** 3
          : easeSmooth(entryRaw);
      const initialOpacity = transitionMode === 'fast' ? 0.35 : transitionMode === 'normal' ? 0 : 1;
      const initialScale = transitionMode === 'fast' ? 0.96 : transitionMode === 'normal' ? 0.9 : 1;
      const initialBlur = transitionMode === 'fast' ? 4 : transitionMode === 'normal' ? 10 : 0;
      const lineAlpha = (initialOpacity + (1 - initialOpacity) * entry) * (current.restLine ? 0.5 : 1);
      const lineScale = initialScale + (1 - initialScale) * entry;
      const lineBlur = initialBlur * (1 - entry);

      const blockLeft = (width - assets.maxWidth) / 2;
      const blockTop = (height - assets.blockHeight) / 2;
      const floatMultiplier = clamp(current.tuning.breathingFloatMultiplier ?? 1, 0, 2);
      const floatConfig = current.intensity === 'calm'
        ? { distance: 10, duration: 8.5 }
        : current.intensity === 'chaotic'
          ? { distance: 18, duration: 5.8 }
          : { distance: 14, duration: 7 };
      // Classic breathing keyframes: [0, -d, 0, d*0.45, 0] with a gentle scale.
      const floatPhase = ((now / 1000) % floatConfig.duration) / floatConfig.duration;
      const floatPoints = [0, 0.25, 0.5, 0.75, 1];
      const floatYValues = [0, -floatConfig.distance * floatMultiplier, 0, floatConfig.distance * floatMultiplier * 0.45, 0];
      const floatScaleValues = [1, 1 + 0.01 * floatMultiplier, 1, 1 - 0.005 * floatMultiplier, 1];
      let floatSegment = 0;
      while (floatSegment < floatPoints.length - 2 && floatPhase > floatPoints[floatSegment + 1]) {
        floatSegment += 1;
      }
      const floatSegmentSpan = floatPoints[floatSegment + 1] - floatPoints[floatSegment];
      const floatLocal = floatSegmentSpan > 0
        ? clamp((floatPhase - floatPoints[floatSegment]) / floatSegmentSpan, 0, 1)
        : 0;
      const floatEase = easeSmooth(floatLocal);
      const floatY = quiet || floatMultiplier <= 0
        ? 0
        : floatYValues[floatSegment] + (floatYValues[floatSegment + 1] - floatYValues[floatSegment]) * floatEase;
      const floatScale = quiet || floatMultiplier <= 0
        ? 1
        : floatScaleValues[floatSegment] + (floatScaleValues[floatSegment + 1] - floatScaleValues[floatSegment]) * floatEase;
      const centerX = width / 2;
      const centerY = height / 2;

      context.save();
      context.translate(centerX, centerY + floatY);
      context.scale(lineScale * floatScale, lineScale * floatScale);
      context.translate(-centerX, -centerY);
      context.globalAlpha = lineAlpha;
      context.filter = lineBlur > 0.05 ? `blur(${lineBlur}px)` : 'none';

      const wordRevealMode = line.wordRevealMode ?? 'normal';
      const lineRenderEnd = line.lineRenderEndTime ?? getLineRenderEndTime(line);
      const wordLookahead = wordRevealMode === 'instant' ? 0.03 : wordRevealMode === 'fast' ? 0.08 : 0.15;
      const resolveActiveEnd = (word: WordAsset) => (
        wordRevealMode === 'instant'
          ? lineRenderEnd
          : wordRevealMode === 'fast'
            ? Math.min(lineRenderEnd, Math.max(word.endTime, word.startTime + 0.12))
            : word.endTime
      );
      const resolveWordStatus = (word: WordAsset): 'waiting' | 'active' | 'passed' => {
        const activeEnd = resolveActiveEnd(word);
        if (time >= word.startTime - wordLookahead && time <= activeEnd) return 'active';
        return time > activeEnd ? 'passed' : 'waiting';
      };

      // Only use the dead-wood preview ahead of a real line during a punctuation
      // interlude. On a normal line, waiting words stay invisible like the
      // classic mode; drawing them here would show a second, dimmer copy of the
      // same line behind the growing glyphs.
      if (current.previewLine) {
        const baseAlpha = lineAlpha * 0.4;
        assets.words.forEach((word) => {
          if (resolveWordStatus(word) !== 'waiting') return;
          context.save();
          context.translate(
            blockLeft + word.baseX + word.config.x,
            blockTop + word.baseY + word.config.y,
          );
          context.rotate((word.config.rotate * Math.PI) / 180);
          context.scale(word.config.scale || 1, word.config.scale || 1);
          context.globalAlpha = baseAlpha;
          context.translate(-word.canvasW / 2, -word.canvasH / 2);
          context.drawImage(word.trunkLayer, 0, 0, word.canvasW, word.canvasH);
          context.restore();
        });
      }

      assets.words.forEach((word) => {
        // Same active-end math as the classic visualizer's render profile.
        const activeEnd = resolveActiveEnd(word);
        const status = resolveWordStatus(word);
        const stateKey = `${assets.key}|${word.index}`;
        let state = wordStatesRef.current.get(stateKey);
        // Classic waiting pose: hidden, half scale, pulled into the line from
        // outboard by the deterministic sin/cos offsets. The full dead-wood
        // plate below is the material layer that keeps the line readable.
        const waitingTarget = {
          scale: 0.5,
          rotation: current.tuning.enableWordRotation ? word.config.rotate + 20 : 0,
          alpha: 0,
          ox: word.config.x + Math.sin(word.config.y) * 100,
          oy: word.config.y + Math.cos(word.config.x) * 50,
        };
        if (!state) {
          state = {
            scale: waitingTarget.scale,
            scaleV: 0,
            rotation: waitingTarget.rotation,
            rotationV: 0,
            alpha: waitingTarget.alpha,
            ox: waitingTarget.ox,
            oxV: 0,
            oy: waitingTarget.oy,
            oyV: 0,
            initialized: false,
          };
          wordStatesRef.current.set(stateKey, state);
        }
        const target = status === 'active'
          ? {
              scale: Number.isNaN(word.config.scale) ? 1.5 : word.config.scale * 1.4,
              rotation: word.config.rotate,
              alpha: 1,
              ox: word.config.x,
              oy: word.config.y,
            }
          : status === 'passed'
            ? {
                scale: word.config.scale || 1,
                rotation: word.config.rotate + word.config.passedRotate,
                alpha: current.intensity === 'chaotic' ? 0.9 : 0.82,
                ox: word.config.x,
                oy: word.config.y,
              }
            : waitingTarget;
        if (quiet) {
          state.scale = target.scale;
          state.scaleV = 0;
          state.rotation = target.rotation;
          state.rotationV = 0;
          state.alpha = target.alpha;
          state.ox = target.ox;
          state.oxV = 0;
          state.oy = target.oy;
          state.oyV = 0;
          state.initialized = true;
        } else {
          const stiffness = status === 'active' ? 200 : 140;
          const damping = status === 'active' ? 20 : 24;
          const scale = springStep(state.scale, state.scaleV, target.scale, delta, stiffness, damping);
          const rotation = springStep(state.rotation, state.rotationV, target.rotation, delta, stiffness, damping);
          const ox = springStep(state.ox, state.oxV, target.ox, delta, stiffness, damping);
          const oy = springStep(state.oy, state.oyV, target.oy, delta, stiffness, damping);
          state.scale = scale.value;
          state.scaleV = scale.velocity;
          state.rotation = rotation.value;
          state.rotationV = rotation.velocity;
          state.ox = ox.value;
          state.oxV = ox.velocity;
          state.oy = oy.value;
          state.oyV = oy.velocity;
          // Classic opacity transitions: .1s active, .4s waiting, .5s passed.
          const alphaRate = status === 'active' ? 10 : status === 'waiting' ? 2.5 : 2;
          state.alpha += (target.alpha - state.alpha) * (1 - Math.exp(-delta * alphaRate));
        }
        if (state.alpha <= 0.01) return;

        const drawX = blockLeft + word.baseX + state.ox;
        const drawY = blockTop + word.baseY + state.oy;
        context.save();
        context.translate(drawX, drawY);
        context.rotate((state.rotation * Math.PI) / 180);
        context.scale(state.scale, state.scale);
        context.globalAlpha = state.alpha;
        context.translate(-word.canvasW / 2, -word.canvasH / 2);
        if (status === 'active') {
          context.shadowColor = 'transparent';
          context.shadowBlur = 0;
        }
        context.drawImage(word.trunkLayer, 0, 0, word.canvasW, word.canvasH);
        const isPassed = status === 'passed';
        const isActive = status === 'active';
        const activeColor = resolveWordColor(word.text, current.wordColors ?? [], current.accentColor);
        if (isPassed) {
          context.drawImage(word.plantLayer, 0, 0, word.canvasW, word.canvasH);
        } else if (isActive) {
          // The material growth also follows the classic active-end timing, so
          // fast / instant reveal lines finish their plant fill on the same beat
          // as the classic color transition.
          const fillDuration = Math.max(activeEnd - word.startTime, 0.001);
          const rawDuration = Math.max(word.endTime - word.startTime, 0.001);
          const fillTimings = activeEnd === word.endTime
            ? word.timings
            : word.timings.map(timing => ({
                startTime: word.startTime + (timing.startTime - word.startTime) * fillDuration / rawDuration,
                endTime: word.startTime + (timing.endTime - word.startTime) * fillDuration / rawDuration,
              }));
          const fillWidth = resolveFillWidth(time, word.startTime, activeEnd, word.offsets, fillTimings);
          const progress = clamp((time - word.startTime) / fillDuration, 0, 1);
          const softness = clamp(assets.fontPx * 0.45, 6, 16);
          const front = fillWidth + softness * progress;
          const pieceFront = clamp(front, 0, word.width);
          if (pieceFront > 0) {
            const frontX = word.pad + pieceFront;
            const hardEnd = Math.max(word.pad, frontX - softness);
            if (hardEnd > word.pad) {
              context.save();
              context.beginPath();
              context.rect(word.pad - 2, 0, hardEnd - word.pad + 2, word.canvasH);
              context.clip();
              context.drawImage(word.plantLayer, 0, 0, word.canvasW, word.canvasH);
              context.restore();
            }
            const featherWidth = frontX - hardEnd;
            if (featherContext && featherWidth > 0.5) {
              const fw = Math.ceil(featherWidth);
              const fh = Math.ceil(word.canvasH);
              if (feather.width !== Math.ceil(fw * dpr) || feather.height !== Math.ceil(fh * dpr)) {
                feather.width = Math.max(1, Math.ceil(fw * dpr));
                feather.height = Math.max(1, Math.ceil(fh * dpr));
              }
              featherContext.setTransform(dpr, 0, 0, dpr, 0, 0);
              featherContext.clearRect(0, 0, fw, fh);
              featherContext.drawImage(word.plantLayer, -hardEnd, 0, word.canvasW, word.canvasH);
              const gradient = featherContext.createLinearGradient(0, 0, fw, 0);
              gradient.addColorStop(0, 'rgba(255,255,255,1)');
              gradient.addColorStop(1, 'rgba(255,255,255,0)');
              featherContext.globalCompositeOperation = 'destination-in';
              featherContext.fillStyle = gradient;
              featherContext.fillRect(0, 0, fw, fh);
              featherContext.globalCompositeOperation = 'source-over';
              context.drawImage(feather, hardEnd, 0, fw, fh);
            }
            const glowX = word.pad + pieceFront;
            const glowY = word.pad + assets.fontPx * 0.92;
            const radius = assets.fontPx * 0.22;
            const gradient = context.createRadialGradient(glowX, glowY, 0, glowX, glowY, radius);
            gradient.addColorStop(0, colorWithAlpha(activeColor, 0.05));
            gradient.addColorStop(0.5, colorWithAlpha(activeColor, 0.02));
            gradient.addColorStop(1, colorWithAlpha(activeColor, 0));
            context.save();
            context.globalCompositeOperation = 'lighter';
            context.fillStyle = gradient;
            context.fillRect(glowX - radius, glowY - radius, radius * 2, radius * 2);
            context.restore();
          }
          context.shadowBlur = 0;
          context.save();
          context.globalCompositeOperation = 'source-atop';
          context.globalAlpha = state.alpha * 0.12;
          context.fillStyle = activeColor;
          context.fillRect(0, 0, word.canvasW, word.canvasH);
          context.restore();

          if (line.isChorus) {
            // Thin chorus ring, deliberately much smaller than the classic glow.
            const rippleProgress = clamp((time - word.startTime) / 0.5, 0, 1);
            if (rippleProgress < 1) {
              const rippleSeed = Math.sin(word.startTime + word.index * 7.3) * 10000;
              const rippleRandom = rippleSeed - Math.floor(rippleSeed);
              const rippleTarget = 1.2 + rippleRandom * 0.8;
              const rippleScale = 0.2 + (rippleTarget - 0.2) * (1 - (1 - rippleProgress) ** 2);
              context.save();
              context.globalCompositeOperation = 'lighter';
              context.globalAlpha = state.alpha * 0.45 * (1 - rippleProgress);
              context.strokeStyle = activeColor;
              context.lineWidth = 1;
              context.shadowColor = activeColor;
              context.shadowBlur = 1.5;
              context.beginPath();
              context.arc(
                word.canvasW / 2,
                word.canvasH / 2,
                assets.fontPx * 0.55 * rippleScale,
                0,
                Math.PI * 2,
              );
              context.stroke();
              context.restore();
            }
          }
        }
        context.restore();
      });
      context.restore();

      frame = requestAnimationFrame(render);
    };

    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [ready]);

  return (
    <div ref={wrapRef} className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_50%_50%,rgba(5,5,6,0.22),transparent_68%)]" />
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
};

export default LivingWoodWordStage;
