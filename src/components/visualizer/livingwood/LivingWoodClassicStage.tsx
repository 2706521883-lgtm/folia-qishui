import { useEffect, useRef, useState } from 'react';
import type { MotionValue } from 'framer-motion';
import type { LabLyricData, LabLyricLine, LabLyricWord } from './labTypes';

// Relative to dist/index.html; packaged Folia runs from file://.
const BARK_SURFACE = 'textures/bark-surface.png';
const PLANT_SURFACE = 'textures/plant-surface.png';
const LYRIC_FONT_STACK =
  "'Noto Serif SC', 'Source Han Serif SC', 'Songti SC', 'STSong', 'SimSun', serif";
const LYRIC_FONT_WEIGHT = 500;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));
const easeSmooth = (value: number) => {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
};
const splitGraphemes = (text: string): string[] => Array.from(text);

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
type DisplayToken = {
  text: string;
  startTime: number | null;
  endTime: number | null;
  timed: boolean;
  graphemeTimings: GraphemeTiming[];
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
type ClassicAssets = {
  key: string;
  width: number;
  layerHeight: number;
  textHeight: number;
  fontPx: number;
  pad: number;
  pieces: Piece[];
  trunkLayer: HTMLCanvasElement;
  plantLayer: HTMLCanvasElement;
};

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
  const graphemes = splitGraphemes(text);
  if (graphemes.length === 0) return [];
  const duration = Math.max(end - start, 0);
  const unit = duration / graphemes.length;
  return graphemes.map((_, index) => ({
    startTime: start + unit * index,
    endTime: index === graphemes.length - 1 ? end : start + unit * (index + 1),
  }));
};

const buildDisplayTokens = (line: LabLyricLine): DisplayToken[] => {
  const fullText = line.text;
  const words = line.words;
  if (words.length === 0) {
    return [{
      text: fullText,
      startTime: line.startTime,
      endTime: line.endTime,
      timed: true,
      graphemeTimings: evenTimings(fullText, line.startTime, line.endTime),
    }];
  }
  const tokens: DisplayToken[] = [];
  let cursor = 0;
  words.forEach((word) => {
    const match = fullText.indexOf(word.text, cursor);
    if (match < 0) return;
    if (match > cursor) {
      tokens.push({
        text: fullText.slice(cursor, match),
        startTime: null,
        endTime: null,
        timed: false,
        graphemeTimings: [],
      });
    }
    tokens.push({
      text: word.text,
      startTime: word.startTime,
      endTime: word.endTime,
      timed: true,
      graphemeTimings: evenTimings(word.text, word.startTime, word.endTime),
    });
    cursor = match + word.text.length;
  });
  if (cursor < fullText.length) {
    tokens.push({
      text: fullText.slice(cursor),
      startTime: null,
      endTime: null,
      timed: false,
      graphemeTimings: [],
    });
  }
  return tokens.length > 0 ? tokens : [{
    text: fullText,
    startTime: line.startTime,
    endTime: line.endTime,
    timed: true,
    graphemeTimings: evenTimings(fullText, line.startTime, line.endTime),
  }];
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

const buildClassicAssets = (
  line: LabLyricLine,
  width: number,
  height: number,
  dpr: number,
  fontScale: number,
  bark: HTMLImageElement,
  plant: HTMLImageElement,
): ClassicAssets => {
  const fontPx = Math.max(36 * fontScale, Math.min(width * 0.06 * fontScale, 72 * fontScale));
  const font = `${LYRIC_FONT_WEIGHT} ${fontPx}px ${LYRIC_FONT_STACK}`;
  const lineHeight = fontPx * 1.22;
  const maxWidth = Math.max(240, Math.min(1152, width - 64));
  const pad = Math.ceil(fontPx * 0.35);
  const tokens = buildDisplayTokens(line);
  const pieces: Piece[] = [];
  const rowWidths: number[] = [];
  let row = 0;
  let x = 0;

  tokens.forEach((token) => {
    const graphemes = splitGraphemes(token.text);
    const offsets = [0];
    for (let index = 1; index <= graphemes.length; index += 1) {
      offsets.push(measureText(graphemes.slice(0, index).join(''), font));
    }
    let first = 0;
    while (first < graphemes.length) {
      if (graphemes[first] === '\n') {
        row += 1;
        x = 0;
        first += 1;
        continue;
      }
      if (x > 0 && x + (offsets[graphemes.length] - offsets[first]) > maxWidth) {
        row += 1;
        x = 0;
      }
      let last = first + 1;
      while (
        last < graphemes.length &&
        graphemes[last] !== '\n' &&
        x + (offsets[last + 1] - offsets[first]) <= maxWidth
      ) {
        last += 1;
      }
      const pieceWidth = offsets[last] - offsets[first];
      pieces.push({
        text: graphemes.slice(first, last).join(''),
        x,
        y: row * lineHeight,
        width: pieceWidth,
        row,
        token,
        offsets,
        tokenOffset: offsets[first],
      });
      rowWidths[row] = Math.max(rowWidths[row] ?? 0, x + pieceWidth);
      x += pieceWidth;
      first = last;
      if (first < graphemes.length && graphemes[first] !== '\n') {
        row += 1;
        x = 0;
      }
    }
  });

  const rows = Math.max(1, Math.max(0, ...pieces.map((piece) => piece.row)) + 1);
  const textHeight = rows * lineHeight;
  const layerWidth = maxWidth + pad * 2;
  const layerHeight = textHeight + pad * 2;
  const { canvas: mask, context: maskContext } = createCanvas(
    layerWidth * dpr,
    layerHeight * dpr,
  );
  maskContext.setTransform(dpr, 0, 0, dpr, 0, 0);
  maskContext.font = font;
  maskContext.fillStyle = '#ffffff';
  maskContext.textAlign = 'left';
  maskContext.textBaseline = 'alphabetic';

  pieces.forEach((piece) => {
    const rowOffset = (maxWidth - (rowWidths[piece.row] ?? 0)) / 2;
    piece.x = pad + rowOffset + piece.x;
    maskContext.fillText(piece.text, piece.x, pad + piece.y + fontPx * 0.92);
  });

  return {
    key: `${line.startTime}|${line.endTime}|${line.text}|${Math.round(width)}x${Math.round(height)}|${fontScale}|${dpr}`,
    width: layerWidth,
    layerHeight,
    textHeight,
    fontPx,
    pad,
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
};

type LivingWoodClassicStageProps = {
  lyrics: LabLyricData | null;
  clock: MotionValue<number>;
  staticMode?: boolean;
  fontScale?: number;
};

const LivingWoodClassicStage = ({
  lyrics,
  clock,
  staticMode = false,
  fontScale = 1,
}: LivingWoodClassicStageProps) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const clockRef = useRef(clock);
  clockRef.current = clock;
  const barkRef = useRef<HTMLImageElement | null>(null);
  const plantRef = useRef<HTMLImageElement | null>(null);
  const [ready, setReady] = useState(false);
  const stateRef = useRef({ lyrics, staticMode, fontScale });
  const assetsRef = useRef<ClassicAssets | null>(null);
  const entryRef = useRef<{ key: string; startedAt: number } | null>(null);

  stateRef.current = { lyrics, staticMode, fontScale };

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
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      context.clearRect(0, 0, width, height);

      const current = stateRef.current;
      const lines = current.lyrics?.lines ?? [];
      const time = clockRef.current.get();
      const activeIndex = findActiveLineIndex(lines, time);
      const line = activeIndex >= 0 ? lines[activeIndex] : null;
      if (!line) {
        assetsRef.current = null;
        frame = requestAnimationFrame(render);
        return;
      }

      const key = `${line.startTime}|${line.endTime}|${line.text}|${Math.round(width)}x${Math.round(height)}|${current.fontScale}|${dpr}`;
      if (assetsRef.current?.key !== key) {
        assetsRef.current = buildClassicAssets(
          line,
          width,
          height,
          dpr,
          current.fontScale,
          bark,
          plant,
        );
      }
      const assets = assetsRef.current;
      if (!assets) {
        frame = requestAnimationFrame(render);
        return;
      }

      if (entryRef.current?.key !== key) {
        entryRef.current = { key, startedAt: performance.now() };
      }
      const quiet = Boolean(current.staticMode);
      const entry = quiet
        ? 1
        : easeSmooth((performance.now() - (entryRef.current?.startedAt ?? performance.now())) / 300);
      const scale = quiet ? 1 : 0.9 + 0.1 * entry;
      const alpha = quiet ? 1 : entry;
      const blur = quiet ? 0 : 10 * (1 - entry);

      const centerX = width / 2;
      const centerY = height * 0.5;
      const originX = centerX - assets.width / 2;
      const originY = centerY - assets.textHeight / 2 - assets.pad;

      context.save();
      context.translate(centerX, centerY);
      context.scale(scale, scale);
      context.translate(-centerX, -centerY);
      context.globalAlpha = alpha;
      context.filter = blur > 0.05 ? `blur(${blur}px)` : 'none';
      context.drawImage(assets.trunkLayer, originX, originY, assets.width, assets.layerHeight);

      assets.pieces.forEach((piece) => {
        if (!piece.token.timed || piece.token.startTime === null || piece.token.endTime === null) {
          return;
        }
        const start = piece.token.startTime;
        const end = piece.token.endTime;
        const fillWidth = resolveFillWidth(
          time,
          start,
          end,
          piece.offsets,
          piece.token.graphemeTimings,
        );
        const progress = clamp((time - start) / Math.max(0.001, end - start), 0, 1);
        const softness = clamp(assets.fontPx * 0.45, 6, 16);
        const front = fillWidth + softness * progress;
        const pieceFront = clamp(front - piece.tokenOffset, 0, piece.width);
        if (pieceFront <= 0) return;
        const pieceX = originX + piece.x;
        const pieceY = originY + piece.y;
        const frontX = pieceX + pieceFront;
        const hardEnd = Math.max(pieceX, frontX - softness);

        if (hardEnd > pieceX) {
          context.save();
          context.beginPath();
          context.rect(pieceX - 2, originY, hardEnd - pieceX + 2, assets.layerHeight);
          context.clip();
          context.drawImage(assets.plantLayer, originX, originY, assets.width, assets.layerHeight);
          context.restore();
        }

        const featherWidth = frontX - hardEnd;
        if (featherContext && featherWidth > 0.5) {
          const fw = Math.ceil(featherWidth);
          const fh = Math.ceil(assets.layerHeight);
          if (feather.width !== Math.ceil(fw * dpr) || feather.height !== Math.ceil(fh * dpr)) {
            feather.width = Math.max(1, Math.ceil(fw * dpr));
            feather.height = Math.max(1, Math.ceil(fh * dpr));
          }
          featherContext.setTransform(dpr, 0, 0, dpr, 0, 0);
          featherContext.clearRect(0, 0, fw, fh);
          featherContext.drawImage(
            assets.plantLayer,
            originX - hardEnd,
            0,
            assets.width,
            assets.layerHeight,
          );
          const gradient = featherContext.createLinearGradient(0, 0, fw, 0);
          gradient.addColorStop(0, 'rgba(255,255,255,1)');
          gradient.addColorStop(1, 'rgba(255,255,255,0)');
          featherContext.globalCompositeOperation = 'destination-in';
          featherContext.fillStyle = gradient;
          featherContext.fillRect(0, 0, fw, fh);
          featherContext.globalCompositeOperation = 'source-over';
          context.drawImage(feather, hardEnd, originY, fw, fh);
        }

        if (time >= start && time <= end) {
          const glowX = pieceX + Math.min(piece.width, pieceFront);
          const glowY = pieceY + assets.pad + assets.fontPx * 0.92;
          const radius = assets.fontPx * 0.9;
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

export default LivingWoodClassicStage;
