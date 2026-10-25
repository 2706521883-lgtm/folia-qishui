import { useEffect, useRef, useState } from 'react';
import type { MotionValue } from 'framer-motion';
import type { LabLyricData, LabLyricLine } from './labTypes';

// Relative to dist/index.html: the packaged app runs from file://, where a
// leading slash points at the filesystem root instead of the app bundle.
const BARK_SURFACE = 'textures/bark-surface.png';
const PLANT_SURFACE = 'textures/plant-surface.png';

// Skin: our preset's serif. Layout/timing below follow the player's lattice
// lyric card, not a free-form lab layout.
const LYRIC_FONT_STACK =
  "'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'STSong', 'SimSun', serif";
const LYRIC_FONT_WEIGHT = 500;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

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
const SCROLL_SPRING = { stiffness: 142, damping: 28, mass: 0.82 };
const SCALE_SPRING = { stiffness: 150, damping: 30, mass: 0.78 };
const CARD_TOP = 128;
const CARD_BOTTOM = 110;
const CARD_SIDE = 24;
type StageInset = { top: number; bottom: number; side: number };
const DEFAULT_INSET: StageInset = { top: CARD_TOP, bottom: CARD_BOTTOM, side: CARD_SIDE };

type GraphemeTiming = { startTime: number; endTime: number };
type DisplayToken = {
  text: string;
  startTime: number | null;
  endTime: number | null;
  timed: boolean;
  startOffset: number;
  endOffset: number;
  graphemeTimings: GraphemeTiming[];
  key: string;
};
type Piece = {
  text: string;
  x: number;
  y: number;
  width: number;
  row: number;
  token: DisplayToken;
  offsets: number[];
  tokenOffset: number;
};
type LineAssets = {
  key: string;
  line: LabLyricLine;
  width: number;
  layerHeight: number;
  textHeight: number;
  layoutHeight: number;
  subtitleLayer: HTMLCanvasElement | null;
  subtitleHeight: number;
  subtitleGap: number;
  pieces: Piece[];
  trunkLayer: HTMLCanvasElement;
  plantLayer: HTMLCanvasElement;
};
type Typography = {
  fontPx: number;
  font: string;
  lineHeight: number;
  padding: number;
  maxWidth: number;
  key: string;
};
type Tone = { alpha: number; scale: number; blur: number };
type Track = {
  key: string;
  assets: LineAssets;
  status: 'active' | 'waiting' | 'passed';
  offset: number;
  y: number;
  vy: number;
  scale: number;
  vs: number;
  alpha: number;
  blur: number;
  fromAlpha: number;
  fromBlur: number;
  elapsed: number;
  leaving: boolean;
};

const splitGraphemes = (text: string): string[] => Array.from(text);

const evenGraphemeTimings = (text: string, start: number, end: number): GraphemeTiming[] => {
  const graphemes = splitGraphemes(text);
  if (graphemes.length === 0) return [];
  const duration = Math.max(end - start, 0);
  const unit = duration / graphemes.length;
  return graphemes.map((_, index) => ({
    startTime: start + unit * index,
    endTime: index === graphemes.length - 1 ? end : start + unit * (index + 1),
  }));
};

/** Mirrors utils/lyrics/renderHints.ts so the active-line window keeps the same hold/exit tails. */
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

const resolveLineStatus = (
  line: LabLyricLine,
  index: number,
  activeIndex: number,
  time: number,
): 'active' | 'waiting' | 'passed' => {
  if (index === activeIndex) return 'active';
  if (time > line.endTime || (activeIndex >= 0 && index < activeIndex)) return 'passed';
  return 'waiting';
};

const resolveTone = (
  status: 'active' | 'waiting' | 'passed',
  offset: number,
): Tone => {
  if (status === 'active') return { alpha: 1, scale: 1, blur: 0 };
  const distance = Math.max(Math.abs(offset), 1);
  const waiting = status === 'waiting';
  return {
    alpha: waiting
      ? Math.max(0.36, 0.72 - (distance - 1) * 0.18)
      : Math.max(0.28, 0.52 - (distance - 1) * 0.12),
    scale: Math.max(0.68, 0.72 * Math.pow(0.9, distance - 1)),
    blur: waiting
      ? distance === 1
        ? 0.7
        : 1.8 + (distance - 2) * 0.8
      : 1.1 + (distance - 1) * 0.7,
  };
};

const buildDisplayTokens = (line: LabLyricLine): DisplayToken[] => {
  const fullText = line.text;
  const words = line.words;
  if (words.length === 0) {
    return [
      {
        text: fullText,
        startTime: line.startTime,
        endTime: line.endTime,
        timed: true,
        startOffset: 0,
        endOffset: fullText.length,
        graphemeTimings: evenGraphemeTimings(fullText, line.startTime, line.endTime),
        key: `${line.startTime}-full`,
      },
    ];
  }

  const tokens: DisplayToken[] = [];
  let cursor = 0;
  words.forEach((word, index) => {
    const match = fullText.indexOf(word.text, cursor);
    if (match < 0) return;
    if (match > cursor) {
      tokens.push({
        text: fullText.slice(cursor, match),
        startTime: null,
        endTime: null,
        timed: false,
        startOffset: cursor,
        endOffset: match,
        graphemeTimings: [],
        key: `${line.startTime}-static-${cursor}`,
      });
    }
    tokens.push({
      text: word.text,
      startTime: word.startTime,
      endTime: word.endTime,
      timed: true,
      startOffset: match,
      endOffset: match + word.text.length,
      graphemeTimings: evenGraphemeTimings(word.text, word.startTime, word.endTime),
      key: `${line.startTime}-${index}-${word.startTime}`,
    });
    cursor = match + word.text.length;
  });

  if (cursor < fullText.length) {
    tokens.push({
      text: fullText.slice(cursor),
      startTime: null,
      endTime: null,
      timed: false,
      startOffset: cursor,
      endOffset: fullText.length,
      graphemeTimings: [],
      key: `${line.startTime}-tail-${cursor}`,
    });
  }

  return tokens.length > 0
    ? tokens
    : [
        {
          text: fullText,
          startTime: line.startTime,
          endTime: line.endTime,
          timed: true,
          startOffset: 0,
          endOffset: fullText.length,
          graphemeTimings: evenGraphemeTimings(fullText, line.startTime, line.endTime),
          key: `${line.startTime}-fallback`,
        },
      ];
};

/** Same interpolation the player uses for the sung width, per token / grapheme. */
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

const easeSmooth = (value: number) => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};

const stepSpring = (
  value: number,
  velocity: number,
  target: number,
  delta: number,
  spring: { stiffness: number; damping: number; mass: number },
) => {
  const steps = Math.max(1, Math.ceil(delta * 120));
  const dt = delta / steps;
  for (let index = 0; index < steps; index += 1) {
    velocity +=
      ((target - value) * spring.stiffness - velocity * spring.damping) / spring.mass * dt;
    value += velocity * dt;
  }
  const settled = Math.abs(value - target) < 0.01 && Math.abs(velocity) < 0.01;
  return { value: settled ? target : value, velocity: settled ? 0 : velocity };
};

const buildMaterialLayer = (
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

type LivingWoodStageProps = {
  lyrics: LabLyricData | null;
  clock: MotionValue<number>;
  staticMode?: boolean;
  layoutInset?: StageInset;
  scrim?: 'soft' | 'strong' | 'solid';
};

const LivingWoodStage = ({
  lyrics,
  clock,
  staticMode = false,
  layoutInset = DEFAULT_INSET,
  scrim = 'soft',
}: LivingWoodStageProps) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const barkRef = useRef<HTMLImageElement | null>(null);
  const plantRef = useRef<HTMLImageElement | null>(null);
  const assetCacheRef = useRef<Map<string, LineAssets>>(new Map());
  const typographyRef = useRef<{ key: string; value: Typography } | null>(null);
  const tracksRef = useRef<Map<string, Track>>(new Map());
  const lastSignatureRef = useRef('');
  const lastTypographyRef = useRef('');
  const measureRef = useRef<((text: string, font: string) => { width: number; height: number }) | null>(null);
  const stateRef = useRef({ lyrics, staticMode });
  const [ready, setReady] = useState(false);

  stateRef.current = { lyrics, staticMode };

  if (!measureRef.current) {
    const { context } = createCanvas(4, 4);
    measureRef.current = (text, font) => {
      context.font = font;
      const metrics = context.measureText(text);
      return {
        width: metrics.width,
        height: metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent,
      };
    };
  }

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
    const featherCanvas = document.createElement('canvas');
    const featherContext = featherCanvas.getContext('2d');

    const resolveTypography = (width: number, height: number): Typography => {
      const key = `${Math.round(width)}x${Math.round(height)}`;
      if (typographyRef.current?.key === key) return typographyRef.current.value;
      const measure = measureRef.current!;
      let fontPx = 24;
      for (let size = 64; size >= 24; size -= 1) {
        const font = `${LYRIC_FONT_WEIGHT} ${size}px ${LYRIC_FONT_STACK}`;
        const main = measure('国Agyp', font);
        const sub = measure('国Agyp', `500 ${size * 0.5}px ${LYRIC_FONT_STACK}`);
        const lineHeight = Math.max(size * 1.18, main.height + 2);
        const budget =
          lineHeight * (3 + 2 * 0.72) +
          size * 0.49 * 2 +
          size * 1.2 +
          Math.max(size * 0.5 * 1.35, sub.height + 2) * 2 +
          size * 0.3;
        if (budget <= height && main.width * 3 <= Math.max(0, width - size * 1.2)) {
          fontPx = size;
          break;
        }
      }
      const font = `${LYRIC_FONT_WEIGHT} ${fontPx}px ${LYRIC_FONT_STACK}`;
      const lineHeight = Math.max(fontPx * 1.18, measure('国Agyp', font).height + 2);
      const padding = Math.ceil(fontPx * 0.6);
      const value: Typography = {
        fontPx,
        font,
        lineHeight,
        padding,
        maxWidth: Math.max(1, width - padding * 2),
        key,
      };
      typographyRef.current = { key, value };
      assetCacheRef.current.clear();
      return value;
    };

    const buildLineAssets = (
      line: LabLyricLine,
      typography: Typography,
      dpr: number,
      bark: HTMLImageElement,
      plant: HTMLImageElement,
    ): LineAssets => {
      const key = `${line.startTime}|${line.endTime}|${line.text}|${line.translation ?? ''}|${line.romanization ?? ''}|${typography.key}|${dpr}`;
      const cached = assetCacheRef.current.get(key);
      if (cached) return cached;
      const measure = measureRef.current!;
      const pad = Math.ceil(typography.fontPx * 0.3);
      const tokens = buildDisplayTokens(line);
      const pieces: Piece[] = [];
      let x = 0;
      let row = 0;

      tokens.forEach((token) => {
        const graphemes = splitGraphemes(token.text);
        const offsets = [0];
        for (let index = 1; index <= graphemes.length; index += 1) {
          offsets.push(measure(graphemes.slice(0, index).join(''), typography.font).width);
        }
        let first = 0;
        while (first < graphemes.length) {
          if (graphemes[first] === '\n') {
            row += 1;
            x = 0;
            first += 1;
            continue;
          }
          if (x > 0 && x + (offsets[graphemes.length] - offsets[first]) > typography.maxWidth) {
            row += 1;
            x = 0;
          }
          let last = first + 1;
          while (
            last < graphemes.length &&
            graphemes[last] !== '\n' &&
            x + (offsets[last + 1] - offsets[first]) <= typography.maxWidth
          ) {
            last += 1;
          }
          const pieceWidth = offsets[last] - offsets[first];
          pieces.push({
            text: graphemes.slice(first, last).join(''),
            x: pad + x,
            y: pad + row * typography.lineHeight,
            width: pieceWidth,
            row,
            token,
            offsets,
            tokenOffset: offsets[first],
          });
          x += pieceWidth;
          first = last;
          if (first < graphemes.length && graphemes[first] !== '\n') {
            row += 1;
            x = 0;
          }
        }
      });

      const rows = Math.max(1, Math.max(0, ...pieces.map((piece) => piece.row)) + 1);
      const textHeight = rows * typography.lineHeight;
      const layerWidth = typography.maxWidth + pad * 2;
      const layerHeight = textHeight + pad * 2;

      // Subtitle: one track, regular text (not material), only on the active line.
      const subtitleText = (line.translation || line.romanization || '').trim();
      const subtitleGap = typography.fontPx * 0.3;
      const subtitlePx = typography.fontPx * 0.5;
      const subtitleFont = `500 ${subtitlePx}px ${LYRIC_FONT_STACK}`;
      const subtitleLineHeight = Math.max(
        subtitlePx * 1.35,
        measure('国Agyp', subtitleFont).height + 2,
      );
      let subtitleHeight = 0;
      let subtitleLayer: HTMLCanvasElement | null = null;

      if (subtitleText) {
        const rowsText: string[] = [];
        let current = '';
        let truncated = false;
        const chars = splitGraphemes(subtitleText);
        for (let index = 0; index < chars.length; index += 1) {
          const char = chars[index];
          if (char === '\n') {
            rowsText.push(current);
            current = '';
            if (rowsText.length >= 2) {
              truncated = index < chars.length - 1;
              break;
            }
            continue;
          }
          const next = current + char;
          if (current && measure(next, subtitleFont).width > typography.maxWidth) {
            rowsText.push(current);
            current = char.trim() ? char : '';
            if (rowsText.length >= 2) {
              truncated = index < chars.length - 1;
              break;
            }
          } else {
            current = next;
          }
        }
        if (rowsText.length < 2 && current) rowsText.push(current);
        if (truncated && rowsText.length > 0) {
          const lastIndex = rowsText.length - 1;
          let last = rowsText[lastIndex];
          while (last && measure(`${last}…`, subtitleFont).width > typography.maxWidth) {
            last = last.slice(0, -1);
          }
          rowsText[lastIndex] = `${last}…`;
        }
        subtitleHeight = rowsText.length * subtitleLineHeight;
        if (subtitleHeight > 0) {
          const { canvas: subCanvas, context: subContext } = createCanvas(
            typography.maxWidth * dpr,
            subtitleHeight * dpr,
          );
          subContext.setTransform(dpr, 0, 0, dpr, 0, 0);
          subContext.font = subtitleFont;
          subContext.fillStyle = 'rgba(222,212,194,0.68)';
          subContext.textAlign = 'left';
          subContext.textBaseline = 'alphabetic';
          rowsText.forEach((row, index) => {
            subContext.fillText(row, 0, index * subtitleLineHeight + subtitlePx * 0.92);
          });
          subtitleLayer = subCanvas;
        }
      }
      const layoutHeight = textHeight + (subtitleLayer ? subtitleGap + subtitleHeight : 0);
      const { canvas: mask, context: maskContext } = createCanvas(
        layerWidth * dpr,
        layerHeight * dpr,
      );
      maskContext.setTransform(dpr, 0, 0, dpr, 0, 0);
      maskContext.font = typography.font;
      maskContext.fillStyle = '#ffffff';
      maskContext.textAlign = 'left';
      maskContext.textBaseline = 'alphabetic';
      pieces.forEach((piece) => {
        maskContext.fillText(
          piece.text,
          piece.x,
          piece.y + typography.fontPx * 0.92,
        );
      });

      const assets: LineAssets = {
        key,
        line,
        width: layerWidth,
        layerHeight,
        textHeight,
        layoutHeight,
        subtitleLayer,
        subtitleHeight,
        subtitleGap,
        pieces,
        trunkLayer: buildMaterialLayer(
          layerWidth,
          layerHeight,
          dpr,
          mask,
          bark,
          'brightness(1.8) contrast(1.05) saturate(1.6)',
        ),
        plantLayer: buildMaterialLayer(
          layerWidth,
          layerHeight,
          dpr,
          mask,
          plant,
          'brightness(1.25) saturate(1.15)',
        ),
      };
      assetCacheRef.current.set(key, assets);
      if (assetCacheRef.current.size > 12) {
        const oldest = assetCacheRef.current.keys().next().value;
        if (oldest) assetCacheRef.current.delete(oldest);
      }
      return assets;
    };

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
      const effectiveTime = clockRef.current.get();
      const activeIndex = findActiveLineIndex(lines, effectiveTime);
      if (lines.length === 0) {
        frame = requestAnimationFrame(render);
        return;
      }

      let anchorIndex = activeIndex;
      if (anchorIndex < 0) {
        anchorIndex = lines.findIndex((line) => line.startTime > effectiveTime);
        if (anchorIndex < 0) anchorIndex = lines.length - 1;
      }
      const start = Math.max(0, anchorIndex - 1);
      const end = Math.min(lines.length - 1, anchorIndex + 1);

      const boxLeft = layoutInset.side;
      const boxTop = layoutInset.top;
      const boxWidth = Math.max(1, width - layoutInset.side * 2);
      const boxHeight = Math.max(1, height - layoutInset.top - layoutInset.bottom);
      const typography = resolveTypography(boxWidth, boxHeight);
      if (lastTypographyRef.current !== typography.key) {
        lastTypographyRef.current = typography.key;
        tracksRef.current.clear();
        lastSignatureRef.current = '';
      }

      const entries: Array<{
        key: string;
        line: LabLyricLine;
        index: number;
        offset: number;
        status: 'active' | 'waiting' | 'passed';
      }> = [];
      for (let index = start; index <= end; index += 1) {
        const line = lines[index];
        entries.push({
          key: `${index}-${line.startTime}-${line.text}`,
          line,
          index,
          offset: index - anchorIndex,
          status: resolveLineStatus(line, index, activeIndex, effectiveTime),
        });
      }

      const signature = entries
        .map(
          (entry) =>
            `${entry.key}:${entry.status}:${entry.offset}:${entry.line.translation ?? ''}:${
              entry.line.romanization ?? ''
            }`,
        )
        .join('|');
      const tracks = tracksRef.current;
      if (signature !== lastSignatureRef.current) {
        lastSignatureRef.current = signature;
        const existingKeys = new Set(entries.map((entry) => entry.key));
        for (const track of tracks.values()) {
          track.leaving = true;
          track.fromAlpha = track.alpha;
          track.fromBlur = track.blur;
          track.elapsed = 0;
        }
        entries.forEach((entry) => {
          const assets = buildLineAssets(entry.line, typography, dpr, bark, plant);
          let track = tracks.get(entry.key);
          if (!track) {
            track = {
              key: entry.key,
              assets,
              status: entry.status,
              offset: entry.offset,
              y: height * 0.46 + (entry.offset >= 0 ? 34 : -34),
              vy: 0,
              scale: 0.7,
              vs: 0,
              alpha: 0,
              blur: 5,
              fromAlpha: 0,
              fromBlur: 5,
              elapsed: 0,
              leaving: false,
            };
            tracks.set(entry.key, track);
          } else {
            track.assets = assets;
            track.status = entry.status;
            track.offset = entry.offset;
            track.leaving = false;
            track.fromAlpha = track.alpha;
            track.fromBlur = track.blur;
            track.elapsed = 0;
          }
        });
        // Tracks outside the new window keep fading from their current state.
        for (const [key, track] of tracks) {
          if (!existingKeys.has(key)) track.leaving = true;
        }
      }

      const activeEntry = entries.find((entry) => entry.offset === 0);
      const activeTrack = activeEntry ? tracks.get(activeEntry.key) : undefined;
      const activeTone = activeEntry
        ? resolveTone(activeEntry.status, 0)
        : { alpha: 0, scale: 1, blur: 0 };
      const activeHeight = activeTrack
        ? activeEntry?.status === 'active'
          ? activeTrack.assets.layoutHeight
          : Math.min(activeTrack.assets.textHeight, typography.lineHeight * 2) * activeTone.scale
        : 0;
      const anchorY = clamp(
        boxTop + boxHeight * 0.46 - activeHeight / 2,
        boxTop + typography.padding,
        Math.max(boxTop + typography.padding, height - layoutInset.bottom - typography.padding - activeHeight),
      );
      const gap = Math.max(18, typography.fontPx * 0.49);
      const quiet = Boolean(current.staticMode);

      for (const track of tracks.values()) {
        const tone = resolveTone(track.status, track.offset);
        const contextHeight = Math.min(track.assets.textHeight, typography.lineHeight * 2);
        let targetY =
          track.offset < 0
            ? anchorY - contextHeight * tone.scale - gap
            : track.offset > 0
              ? anchorY + activeHeight + gap
              : anchorY;
        if (track.leaving) {
          targetY += track.offset < 0 || track.status === 'passed' ? -38 : 38;
        }
        const targetAlpha = track.leaving ? 0 : tone.alpha;
        if (quiet) {
          track.y = targetY;
          track.vy = 0;
          track.scale = tone.scale;
          track.vs = 0;
          track.alpha = targetAlpha;
          track.blur = tone.blur;
          track.elapsed = 1;
          continue;
        }
        const sy = stepSpring(track.y, track.vy, targetY, delta, SCROLL_SPRING);
        const ss = stepSpring(track.scale, track.vs, tone.scale, delta, SCALE_SPRING);
        track.y = sy.value;
        track.vy = sy.value === targetY ? 0 : sy.velocity;
        track.scale = ss.value;
        track.vs = ss.value === tone.scale ? 0 : ss.velocity;
        track.elapsed += delta;
        const fade = easeSmooth(Math.min(1, track.elapsed / 0.28));
        const blurFade = easeSmooth(Math.min(1, track.elapsed / 0.32));
        track.alpha = track.fromAlpha + (targetAlpha - track.fromAlpha) * fade;
        track.blur = track.fromBlur + (tone.blur - track.fromBlur) * blurFade;
      }

      const ordered = [...tracks.values()]
        .filter((track) => track.alpha > 0.005 || track.leaving)
        .sort((a, b) => {
          const activeA = a.status === 'active' ? 1 : 0;
          const activeB = b.status === 'active' ? 1 : 0;
          if (activeA !== activeB) return activeA - activeB;
          return a.offset - b.offset;
        });

      for (const track of ordered) {
        const assets = track.assets;
        const pad = Math.ceil(typography.fontPx * 0.3);
        const room = Math.max(typography.lineHeight, boxHeight - typography.padding * 2);
        let longOffset = 0;
        if (track.status === 'active' && assets.layoutHeight > room) {
          const timedPieces = assets.pieces.filter((piece) => piece.token.timed);
          let activePiece = timedPieces[0];
          for (const piece of timedPieces) {
            const start = piece.token.startTime ?? Infinity;
            const end = piece.token.endTime ?? Infinity;
            if (effectiveTime < start) break;
            activePiece = piece;
            if (effectiveTime <= end) break;
          }
          longOffset = Math.min(
            Math.max(0, assets.layoutHeight - room),
            Math.max(
              0,
              (activePiece?.y ?? 0) - room * 0.46 + typography.lineHeight / 2,
            ),
          );
        }
        const drawY = track.y - longOffset;
        context.save();
        context.translate(boxLeft + typography.padding - pad, drawY - pad);
        context.scale(track.scale, track.scale);
        context.globalAlpha = track.alpha;
        context.filter = track.blur > 0.05 ? `blur(${track.blur}px)` : 'none';

        if (track.status === 'active') {
          context.drawImage(assets.trunkLayer, 0, 0, assets.width, assets.layerHeight);
          assets.pieces.forEach((piece) => {
            if (!piece.token.timed || piece.token.startTime === null || piece.token.endTime === null) {
              return;
            }
            const start = piece.token.startTime;
            const end = piece.token.endTime;
            const fillWidth = resolveFillWidth(
              effectiveTime,
              start,
              end,
              piece.offsets,
              piece.token.graphemeTimings,
            );
            const progress = clamp(
              (effectiveTime - start) / Math.max(0.001, end - start),
              0,
              1,
            );
            const softness = clamp(typography.fontPx * 0.45, 6, 16);
            const front = fillWidth + softness * progress;
            const pieceFront = clamp(front - piece.tokenOffset, 0, piece.width);
            if (pieceFront <= 0) return;
            const frontX = piece.x + pieceFront;
            const hardEnd = Math.max(piece.x, frontX - softness);

            if (hardEnd > piece.x) {
              context.save();
              context.beginPath();
              context.rect(piece.x - 2, 0, hardEnd - piece.x + 2, assets.layerHeight);
              context.clip();
              context.drawImage(assets.plantLayer, 0, 0, assets.width, assets.layerHeight);
              context.restore();
            }

            const featherWidth = frontX - hardEnd;
            if (featherContext && featherWidth > 0.5) {
              const fw = Math.ceil(featherWidth);
              const fh = Math.ceil(assets.layerHeight);
              if (featherCanvas.width !== Math.ceil(fw * dpr) || featherCanvas.height !== Math.ceil(fh * dpr)) {
                featherCanvas.width = Math.max(1, Math.ceil(fw * dpr));
                featherCanvas.height = Math.max(1, Math.ceil(fh * dpr));
              }
              featherContext.setTransform(dpr, 0, 0, dpr, 0, 0);
              featherContext.clearRect(0, 0, fw, fh);
              featherContext.drawImage(
                assets.plantLayer,
                -hardEnd,
                0,
                assets.width,
                assets.layerHeight,
              );
              const featherGradient = featherContext.createLinearGradient(0, 0, fw, 0);
              featherGradient.addColorStop(0, 'rgba(255,255,255,1)');
              featherGradient.addColorStop(1, 'rgba(255,255,255,0)');
              featherContext.globalCompositeOperation = 'destination-in';
              featherContext.fillStyle = featherGradient;
              featherContext.fillRect(0, 0, fw, fh);
              featherContext.globalCompositeOperation = 'source-over';
              context.drawImage(featherCanvas, hardEnd, 0, fw, fh);
            }

            if (effectiveTime >= start && effectiveTime <= end) {
              const glowX = piece.x + Math.min(piece.width, pieceFront);
              const glowY = piece.y + typography.fontPx * 0.92;
              const radius = typography.fontPx * 0.9;
              const gradient = context.createRadialGradient(glowX, glowY, 0, glowX, glowY, radius);
              gradient.addColorStop(0, 'rgba(255,150,80,0.22)');
              gradient.addColorStop(0.5, 'rgba(255,120,50,0.08)');
              gradient.addColorStop(1, 'rgba(255,100,40,0)');
              context.save();
              context.globalCompositeOperation = 'lighter';
              context.fillStyle = gradient;
              context.fillRect(glowX - radius, glowY - radius, radius * 2, radius * 2);
              context.restore();
            }
          });

          if (assets.subtitleLayer) {
            context.drawImage(
              assets.subtitleLayer,
              pad,
              pad + assets.textHeight + assets.subtitleGap,
              typography.maxWidth,
              assets.subtitleHeight,
            );
          }
        } else {
          const contextClip = Math.min(
            assets.layerHeight,
            pad + typography.lineHeight * 2,
          );
          context.save();
          context.beginPath();
          context.rect(0, 0, assets.width, contextClip);
          context.clip();
          context.drawImage(
            track.status === 'passed' ? assets.plantLayer : assets.trunkLayer,
            0,
            0,
            assets.width,
            assets.layerHeight,
          );
          context.restore();
        }
        context.restore();
      }

      // Drop tracks that have fully faded.
      for (const [key, track] of tracks) {
        if (track.leaving && track.alpha <= 0.01) {
          tracks.delete(key);
        }
      }

      frame = requestAnimationFrame(render);
    };

    frame = requestAnimationFrame(render);
    return () => cancelAnimationFrame(frame);
  }, [ready]);

  return (
    <div ref={wrapRef} className="pointer-events-none absolute inset-0 z-10 overflow-hidden">
      <div
        className={`pointer-events-none absolute inset-0 ${
          scrim === 'solid'
            ? 'bg-[rgba(5,5,6,0.9)]'
            : scrim === 'strong'
              ? 'bg-[radial-gradient(ellipse_at_40%_48%,rgba(5,5,6,0.82),rgba(5,5,6,0.45)_50%,rgba(5,5,6,0.12)_78%)]'
              : 'bg-[radial-gradient(ellipse_at_40%_48%,rgba(5,5,6,0.55),rgba(5,5,6,0.18)_48%,transparent_74%)]'
        }`}
      />
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />
    </div>
  );
};

export default LivingWoodStage;
