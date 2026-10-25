// src/types/lyricApi.ts
// Renderer-facing status contract for the desktop-local lyrics endpoint.

export interface LyricApiStatus {
    enabled: boolean;
    running: boolean;
    port: number;
    url: string | null;
    playbackUrl: string | null;
    error: string | null;
}

export interface LyricPlaybackSnapshot {
    currentTime: number;
    lyricTime: number;
    duration: number;
    playerState: string;
    title: string | null;
    artist: string | null;
}
