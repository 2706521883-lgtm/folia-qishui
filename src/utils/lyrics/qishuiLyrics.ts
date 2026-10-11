import type { ProviderLyricsResult } from '../../types/onlineMusic';
import { parseLyricsByFormat } from './parserCore';
import { isPureMusicLyricText } from './pureMusic';

// src/utils/lyrics/qishuiLyrics.ts

export interface QishuiLyricsPayload {
    lyric?: unknown;
    tlyric?: unknown;
    yrc?: unknown;
    ytlrc?: unknown;
}

const text = (value: unknown) => value == null ? '' : String(value);

// 汽水同时给出 lrc 文本与逐字 yrc（`[start,dur](wStart,wDur,flag)word`），
// 逐字能解析出行时以它为准，与波点的处理方式一致。
export function parseQishuiLyrics(payload: QishuiLyricsPayload): ProviderLyricsResult {
    const mainText = text(payload.lyric);
    const wordByWordText = text(payload.yrc);
    const translationText = text(payload.tlyric);
    const romanizationText = text(payload.ytlrc);
    const wordLyrics = wordByWordText
        ? parseLyricsByFormat('yrc', wordByWordText, translationText, {}, romanizationText) : null;
    const lyrics = wordLyrics?.lines.length ? wordLyrics : parseLyricsByFormat('lrc', mainText, translationText);
    return {
        lyrics: lyrics.lines.length ? lyrics : null,
        mainText,
        wordByWordText: wordLyrics?.lines.length ? wordByWordText : undefined,
        translationText: translationText || undefined,
        romanizationText: romanizationText || undefined,
        isPureMusic: isPureMusicLyricText(mainText),
    };
}
