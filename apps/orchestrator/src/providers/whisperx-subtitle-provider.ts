import type {
  SubtitleProvider,
  GenerateSubtitlesResult,
  WordTimestamp,
} from "./subtitle-provider.js";
import type { WhisperXProvider } from "./whisperx-provider.js";
import { formatSrtTime, formatAssTime } from "../utils/subtitle-format.js";

const MIN_WORDS_PER_CUE = 3;
const MAX_WORDS_PER_CUE = 5;
const BOUNDARY_GAP_SECONDS = 0.5;
const PUNCTUATION_RE = /[.,!?;:…]$/;

/**
 * Real-provider subtitle generator. Aligns the actual narration WAV via
 * WhisperX and builds subtitle cues from the returned word timestamps. The
 * WhisperX timestamps are authoritative — no duration/word-count heuristics.
 *
 * Cue boundaries are chosen in priority order:
 *   punctuation boundary -> natural timing gap -> 3-5 words -> max 5 words.
 * Each cue spans first-word start to last-word end, so cues are contiguous
 * and never overlap.
 */
export class WhisperXSubtitleProvider implements SubtitleProvider {
  constructor(private readonly whisperx: WhisperXProvider) {}

  async generateSubtitles(
    audioUrl: string,
    narration: string,
    _durationMs?: number,
  ): Promise<GenerateSubtitlesResult> {
    const { wordTimestamps } = await this.whisperx.align(audioUrl, narration);
    if (wordTimestamps.length === 0) {
      throw new Error(
        "WhisperX returned no word timestamps for the narration WAV",
      );
    }

    const groups = groupWords(wordTimestamps);
    const cues = groups.map((group, index) => ({
      index: index + 1,
      startMs: Math.round(group[0].start * 1000),
      endMs: Math.round(group[group.length - 1].end * 1000),
      text: group.map((w) => w.word).join(" "),
    }));

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

    return { srt, ass, wordTimestamps };
  }
}

export function groupWords(words: WordTimestamp[]): WordTimestamp[][] {
  const groups: WordTimestamp[][] = [];
  let current: WordTimestamp[] = [];

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    current.push(word);

    if (i === words.length - 1) continue;

    const next = words[i + 1];
    const shouldCut =
      current.length >= MIN_WORDS_PER_CUE &&
      (isPunctuationBoundary(word) ||
        hasTimingGap(word, next) ||
        current.length >= MAX_WORDS_PER_CUE);

    if (shouldCut) {
      groups.push(current);
      current = [];
    }
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

function isPunctuationBoundary(word: WordTimestamp): boolean {
  return PUNCTUATION_RE.test(word.word.trim());
}

function hasTimingGap(prev: WordTimestamp, next: WordTimestamp): boolean {
  return next.start - prev.end >= BOUNDARY_GAP_SECONDS;
}
