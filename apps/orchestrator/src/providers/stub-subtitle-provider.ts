import type {
  SubtitleProvider,
  GenerateSubtitlesResult,
  WordTimestamp,
} from "./subtitle-provider.js";
import { formatSrtTime, formatAssTime } from "../utils/subtitle-format.js";

const WORDS_PER_CUE = 3;
const FALLBACK_MS_PER_WORD = 300;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export class StubSubtitleProvider implements SubtitleProvider {
  async generateSubtitles(
    _audioUrl: string,
    narration: string,
    durationMs?: number,
  ): Promise<GenerateSubtitlesResult> {
    const words = narration.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      return { srt: "", ass: "", wordTimestamps: [] };
    }

    const totalMs =
      durationMs && durationMs > 0
        ? durationMs
        : words.length * FALLBACK_MS_PER_WORD;

    const cues: {
      index: number;
      startMs: number;
      endMs: number;
      text: string;
    }[] = [];
    const cueCount = Math.ceil(words.length / WORDS_PER_CUE);
    const msPerCue = totalMs / cueCount;

    for (let i = 0; i < words.length; i += WORDS_PER_CUE) {
      const chunk = words.slice(i, i + WORDS_PER_CUE).join(" ");
      const index = cues.length + 1;
      const startMs = Math.round((index - 1) * msPerCue);
      const endMs = index === cueCount ? totalMs : Math.round(index * msPerCue);
      cues.push({ index, startMs, endMs, text: chunk });
    }

    const srt = cues
      .map(
        (c) =>
          `${c.index}\n${formatSrtTime(c.startMs)} --> ${formatSrtTime(c.endMs)}\n${c.text}`,
      )
      .join("\n\n");

    const ass = cues
      .map(
        (c) =>
          `Dialogue: 0,${formatAssTime(c.startMs)},${formatAssTime(c.endMs)},Default,,0,0,0,,${c.text}`,
      )
      .join("\n");

    const wordTimestamps: WordTimestamp[] = words.map((word, i) => {
      const startSec = (totalMs / 1000) * (i / words.length);
      const endSec = (totalMs / 1000) * ((i + 1) / words.length);
      return { word, start: round2(startSec), end: round2(endSec) };
    });

    return { srt, ass, wordTimestamps };
  }
}
