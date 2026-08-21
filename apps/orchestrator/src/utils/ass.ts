import { formatAssTime } from "./subtitle-format.js";
import type { WordTimestamp } from "../providers/subtitle-provider.js";
import { config } from "./config.js";

export interface AssStyle {
  fontName: string;
  fontSize: number;
  primaryColor: string;
  accentColor: string;
  outlineColor: string;
  outline: number;
  marginV: number;
  playResX: number;
  playResY: number;
}

export const DEFAULT_ASS_STYLE: AssStyle = {
  fontName: "Noto Sans",
  fontSize: 48,
  primaryColor: "&H00FFFFFF",
  accentColor: "&H0000E0FF",
  outlineColor: "&H00000000",
  outline: 2,
  marginV: 70,
  playResX: 1080,
  playResY: 1920,
};

/** Map app config to an ASS style so subtitle appearance is configurable. */
export function appAssStyle(): AssStyle {
  return {
    fontName: config.subtitleFontName(),
    fontSize: config.subtitleFontSize(),
    primaryColor: config.subtitlePrimaryColor(),
    accentColor: config.subtitleAccentColor(),
    outlineColor: "&H00000000",
    outline: config.subtitleOutline(),
    marginV: config.subtitleMarginV(),
    playResX: 1080,
    playResY: 1920,
  };
}

/**
 * Escape ASS control-code characters in plain word text so user/narration
 * content cannot inject styling or break out of an override block.
 */
function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}");
}

/**
 * Split a group of words into at most 2 readable lines. Prefers balanced
 * lengths and avoids leaving a single orphan word on its own line.
 */
export function splitIntoLines(words: WordTimestamp[]): WordTimestamp[][] {
  if (words.length <= 4) return [words];

  const mid = Math.floor(words.length / 2);
  const candidates: Array<{ split: number; balance: number }> = [];
  for (
    let s = Math.max(1, mid - 1);
    s <= Math.min(words.length - 1, mid + 1);
    s++
  ) {
    const first = s;
    const second = words.length - s;
    if (first === 1 || second === 1) continue;
    candidates.push({ split: s, balance: Math.abs(first - second) });
  }
  if (candidates.length === 0) return [words];

  candidates.sort((a, b) => a.balance - b.balance);
  const split = candidates[0].split;
  return [words.slice(0, split), words.slice(split)];
}

/**
 * Render a single word-highlighted phrase: the whole phrase stays on screen
 * and only the active word carries the accent color. All other words remain
 * the primary color, so the subtitle layout is identical across events.
 */
function renderPhrase(
  lines: WordTimestamp[][],
  activeIndex: number,
  style: AssStyle,
): string {
  const linesText = lines.map((line) => {
    return line
      .map((word) => {
        const isActive = activeIndex === 0;
        activeIndex -= 1;
        if (isActive) {
          const text = escapeAssText(word.word.trim());
          return `{\\c${style.accentColor}}${text}{\\c${style.primaryColor}}`;
        }
        return escapeAssText(word.word.trim());
      })
      .join(" ");
  });
  return linesText.join("\\N");
}

/**
 * Build a karaoke ASS document from grouped word timestamps. Each group is one
 * on-screen subtitle (up to a few words, at most 2 lines). For every word in a
 * group one Dialogue event is emitted spanning that word's active interval; the
 * event renders the full phrase with the active word in the accent color. This
 * produces a stable, discrete "white sentence + one accented word" highlight
 * that follows spoken timing with no movement or scaling.
 */
export function buildKaraokeAss(
  groups: WordTimestamp[][],
  style: Partial<AssStyle> = {},
): string {
  const s: AssStyle = { ...DEFAULT_ASS_STYLE, ...style };

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${s.playResX}`,
    `PlayResY: ${s.playResY}`,
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Default,${s.fontName},${s.fontSize},${s.primaryColor},${s.accentColor},${s.outlineColor},&H00000000,1,0,0,0,100,100,0,0,1,${s.outline},0,2,20,20,${s.marginV},1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ].join("\n");

  const dialogues: string[] = [];
  for (const group of groups) {
    if (group.length === 0) continue;
    const lines = splitIntoLines(group);

    for (let i = 0; i < group.length; i++) {
      // Each event shows the full phrase with word i accented. It spans from
      // this word's start to the next word's start (or the group end), so the
      // phrase stays visible and the accent switches exactly at word
      // boundaries — no gaps from float rounding.
      const eventEnd =
        i < group.length - 1 ? group[i + 1].start : group[group.length - 1].end;
      const wordStart = formatAssTime(Math.round(group[i].start * 1000));
      const wordEnd = formatAssTime(Math.round(eventEnd * 1000));
      const text = renderPhrase(lines, i, s);
      dialogues.push(
        `Dialogue: 0,${wordStart},${wordEnd},Default,,0,0,0,,${text}`,
      );
    }
  }

  return [header, ...dialogues].join("\n");
}
