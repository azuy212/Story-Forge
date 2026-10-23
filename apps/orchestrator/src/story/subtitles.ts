import { formatAssTime, formatSrtTime } from "../utils/subtitle-format.js";
import type { SceneTiming, SceneWordTimestamp } from "./types.js";

/**
 * Subtitle construction (brief S7).
 *
 * Text comes from the script (the words passed in are the script's own
 * tokens), timing comes from the aligned audio. Cues never cross a scene
 * boundary, never overlap, and never fall below the minimum on-screen time.
 */

export interface SubtitleCue {
  index: number;
  startMs: number;
  endMs: number;
  lines: string[];
}

export interface SceneSubtitleInput {
  sceneId: number;
  timing: SceneTiming;
  words: SceneWordTimestamp[];
}

/**
 * Sentence terminators, including the non-Latin ones the story pipeline
 * supports. A cue may also close on a trailing quote/bracket after one.
 */
const CLAUSE_END = /[.!?…。！？۔؟।]["'”’»)\]]*$/;

interface DraftCue {
  words: SceneWordTimestamp[];
  startMs: number;
  endMs: number;
}

export function buildSubtitleCues(options: {
  scenes: SceneSubtitleInput[];
  maxCharsPerLine: number;
  minDurationMs: number;
  maxLines?: number;
}): SubtitleCue[] {
  const { scenes, maxCharsPerLine, minDurationMs } = options;
  const maxLines = options.maxLines ?? 2;
  const maxCueChars = maxCharsPerLine * maxLines;

  const drafts: DraftCue[] = [];

  for (const scene of scenes) {
    const words = scene.words.filter(
      (word) => word.end > word.start && word.end > scene.timing.start,
    );
    let current: SceneWordTimestamp[] = [];

    const flush = (): void => {
      if (current.length === 0) return;
      drafts.push({
        words: current,
        startMs: Math.round(current[0].start * 1000),
        endMs: Math.round(current[current.length - 1].end * 1000),
      });
      current = [];
    };

    for (const word of words) {
      const candidate = [...current, word];
      const text = candidate.map((entry) => entry.word).join(" ");
      // A sentence end closes the cue WITH that word, so cues do not shed a
      // stray trailing word into a sub-second cue of its own.
      const endsSentence =
        CLAUSE_END.test(word.word) && text.length >= maxCharsPerLine * 0.5;
      if (endsSentence) {
        current = candidate;
        flush();
        continue;
      }
      if (text.length > maxCueChars && current.length > 0) {
        flush();
        current = [word];
        continue;
      }
      current = candidate;
    }
    flush();
  }

  const cues: SubtitleCue[] = drafts.map((draft, index) => ({
    index: index + 1,
    startMs: draft.startMs,
    endMs: draft.endMs,
    lines: wrapLines(draft.words, maxCharsPerLine, maxLines),
  }));

  for (let index = 0; index < cues.length; index++) {
    const cue = cues[index];
    const next = cues[index + 1];
    let endMs = cue.endMs;
    if (endMs < cue.startMs + minDurationMs) {
      endMs = cue.startMs + minDurationMs;
    }
    if (next && endMs > next.startMs) endMs = next.startMs;
    if (endMs <= cue.startMs) endMs = cue.startMs + 1;
    cue.endMs = endMs;
  }

  return cues.filter((cue) => cue.lines.length > 0);
}

/** Balance words across at most `maxLines` lines of `maxChars` characters. */
export function wrapLines(
  words: SceneWordTimestamp[],
  maxChars: number,
  maxLines = 2,
): string[] {
  const text = words
    .map((word) => word.word)
    .join(" ")
    .trim();
  if (text.length === 0) return [];
  if (text.length <= maxChars || maxLines <= 1) return [text];

  const tokens = text.split(" ");
  if (tokens.length <= 1) return [text];

  const lines: string[] = [];
  let remaining = tokens;
  let remainingLines = maxLines;

  while (remainingLines > 1 && remaining.length > 1) {
    const target = Math.ceil(remaining.join(" ").length / remainingLines);
    let bestIndex = 1;
    let bestScore = Number.POSITIVE_INFINITY;
    let accumulated = 0;
    for (let index = 0; index < remaining.length - 1; index++) {
      accumulated += remaining[index].length + 1;
      if (accumulated > maxChars) break;
      const score = Math.abs(accumulated - target);
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index + 1;
      }
    }
    lines.push(remaining.slice(0, bestIndex).join(" "));
    remaining = remaining.slice(bestIndex);
    remainingLines--;
  }

  // The loop emits at most `maxLines - 1` lines, so the remainder is the final
  // line. Every remaining word is kept: dropping the tail of a cue would leave
  // narration out of the subtitles entirely.
  if (remaining.length > 0) lines.push(remaining.join(" "));

  return lines;
}

function escapeAssText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/[{}]/g, "").trim();
}

export interface AssStyleConfig {
  fontName: string;
  fontSize: number;
  primaryColor: string;
  outlineColor: string;
  outline: number;
  marginV: number;
  playResX: number;
  playResY: number;
}

/** Build an ASS document with the configured style and no karaoke effects. */
export function buildStoryAss(
  cues: SubtitleCue[],
  style: AssStyleConfig,
): string {
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${style.playResX}`,
    `PlayResY: ${style.playResY}`,
    "WrapStyle: 0",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${style.fontName},${style.fontSize},${style.primaryColor},${style.primaryColor},${style.outlineColor},&H00000000,1,0,0,0,100,100,0,0,1,${style.outline},0,2,40,40,${style.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const dialogues = cues.map((cue) => {
    const text = cue.lines.map(escapeAssText).join("\\N");
    return `Dialogue: 0,${formatAssTime(cue.startMs)},${formatAssTime(cue.endMs)},Default,,0,0,0,,${text}`;
  });

  return [header, ...dialogues].join("\n");
}

export function buildStorySrt(cues: SubtitleCue[]): string {
  return (
    cues
      .map((cue) =>
        [
          String(cue.index),
          `${formatSrtTime(cue.startMs)} --> ${formatSrtTime(cue.endMs)}`,
          ...cue.lines,
        ].join("\n"),
      )
      .join("\n\n") + "\n"
  );
}
