export interface LabLyricSyllable {
  text: string;
  startTime: number;
  endTime: number;
}

export interface LabLyricWord {
  text: string;
  startTime: number;
  endTime: number;
  syllables?: LabLyricSyllable[];
}

export interface LabLyricLine {
  text: string;
  startTime: number;
  endTime: number;
  words: LabLyricWord[];
  translation?: string;
  romanization?: string;
  wordRevealMode?: 'normal' | 'fast' | 'instant';
  lineTransitionMode?: 'normal' | 'fast' | 'none';
  lineRenderEndTime?: number;
  isChorus?: boolean;
}

export interface LabLyricData {
  lines: LabLyricLine[];
  title?: string;
  artist?: string;
}
