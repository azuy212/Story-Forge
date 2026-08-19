export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

export interface GenerateSubtitlesResult {
  srt: string;
  ass: string;
  wordTimestamps: WordTimestamp[];
}

export interface SubtitleProvider {
  generateSubtitles(
    audioUrl: string,
    narration: string,
    durationMs?: number,
  ): Promise<GenerateSubtitlesResult>;
}
