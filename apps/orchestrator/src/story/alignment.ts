import type { SceneWordTimestamp } from "./types.js";

/**
 * Script-to-audio alignment (brief S7).
 *
 * Subtitle TEXT always comes from the script; only TIMING comes from the
 * transcriber. A monotonic LCS alignment maps script tokens onto ASR words so
 * dropped or extra ASR words shift nothing, and unmatched script tokens are
 * interpolated between their matched neighbours. A proportional fallback
 * (words distributed across the scene window) is used when a scene's match
 * ratio is poor.
 */

export interface AsrWord {
  word: string;
  start: number;
  end: number;
}

export interface AlignedWord {
  token: string;
  start: number;
  end: number;
  matched: boolean;
}

export interface AlignmentResult {
  words: AlignedWord[];
  matched: number;
  total: number;
  matchRatio: number;
  method: "aligned" | "proportional";
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
};

/** Lowercase, strip diacritics and punctuation, normalize quotes/hyphens. */
export function normalizeToken(token: string): string {
  return token
    .normalize("NFD")
    .replace(/[\u0300-\u036f\u{1ab0}-\u{1aff}\u{1dc0}-\u{1dff}]/gu, "")
    .replace(/[’‘`´]/g, "'")
    .replace(/[–—−]/g, "-")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'-]/gu, "")
    .replace(/^['-]+|['-]+$/g, "");
}

/**
 * Canonical numeric value of a token, or undefined when it is not a number.
 * Handles digits with separators ("1,492", "1492") and number words including
 * compounds ("ninety-two", "four hundred").
 */
export function numberValue(token: string): number | undefined {
  // Read the digits off the RAW token first: `normalizeToken` strips the
  // decimal point, which would silently turn "3.14" into 314.
  const numeric = token.replace(/[^\d.,]/g, "").replace(/,/g, "");
  if (/^\d+\.\d+$/.test(numeric) || /^\d+$/.test(numeric)) {
    return Number(numeric);
  }

  const cleaned = normalizeToken(token);
  if (!cleaned) return undefined;

  if (/^\d+(?:\.\d+)?$/.test(cleaned.replace(/,/g, ""))) {
    return Number(cleaned.replace(/,/g, ""));
  }

  const parts = token
    .replace(/[^\p{L}\s-]/gu, " ")
    .replace(/[–—−]/g, "-")
    .split(/[-\s]+/)
    .filter(Boolean)
    .map((part) => part.toLowerCase());
  if (parts.length === 0) return undefined;
  let total = 0;
  let current = 0;
  let sawWord = false;
  for (const part of parts) {
    const value = NUMBER_WORDS[part];
    if (value !== undefined) {
      current += value;
      sawWord = true;
      continue;
    }
    if (part === "hundred") {
      current = (current === 0 ? 1 : current) * 100;
      sawWord = true;
      continue;
    }
    if (part === "thousand") {
      total += (current === 0 ? 1 : current) * 1000;
      current = 0;
      sawWord = true;
      continue;
    }
    return undefined;
  }
  return sawWord ? total + current : undefined;
}

const SCRIPT_TOKEN = /[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu;
/**
 * Punctuation that belongs to the END of the token it follows. Only taken when
 * it is followed by whitespace or the end of the text, so a decimal such as
 * "3.14" is never split into "3." and "14".
 */
const TRAILING_PUNCTUATION = /^[.!?…,;:。！？۔؟।]["'”’»)\]]*(?=\s|$)/;
/**
 * An opening quote/bracket belongs to the token it precedes. Subtitles are
 * rebuilt from these tokens, so dropping it would print `said stop."` instead
 * of `said "stop."`.
 */
const LEADING_OPENERS = /["'“‘«([]+$/;

/**
 * Split the script into the tokens that become subtitle text.
 *
 * Trailing sentence punctuation is KEPT: the subtitle builder breaks cues at
 * sentence ends, and the alignment matcher strips punctuation anyway
 * (`normalizeToken`), so keeping it is free for matching and essential for
 * readable subtitles.
 */
export function tokenizeScript(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(SCRIPT_TOKEN)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const leading = LEADING_OPENERS.exec(text.slice(0, start))?.[0] ?? "";
    const punctuation = TRAILING_PUNCTUATION.exec(text.slice(end))?.[0] ?? "";
    tokens.push(`${leading}${match[0]}${punctuation}`);
  }
  return tokens;
}

function tokensMatch(a: string, b: string): boolean {
  const left = normalizeToken(a);
  const right = normalizeToken(b);
  if (left.length === 0 || right.length === 0) return false;
  if (left === right) return true;
  const leftNumber = numberValue(left);
  const rightNumber = numberValue(right);
  return (
    leftNumber !== undefined &&
    rightNumber !== undefined &&
    leftNumber === rightNumber
  );
}

/**
 * Longest-common-subsequence alignment of script tokens onto ASR words.
 * Returns, for every script token, its ASR partner index (or -1).
 */
export function lcsAlignment(
  scriptTokens: string[],
  asrWords: AsrWord[],
): number[] {
  const n = scriptTokens.length;
  const m = asrWords.length;
  const partner = Array.from({ length: n }, (): number => -1);
  if (n === 0 || m === 0) return partner;

  const normalizedAsr = asrWords.map((word) => normalizeToken(word.word));
  const normalizedScript = scriptTokens.map((token) => normalizeToken(token));

  // Similarity by normalized equality or numeric equivalence.
  const similar = (i: number, j: number): boolean =>
    tokensMatch(normalizedScript[i] ?? "", normalizedAsr[j] ?? "");

  const width = m + 1;
  const dp = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const index = i * width + j;
      if (similar(i, j)) {
        dp[index] = dp[(i + 1) * width + (j + 1)] + 1;
      } else {
        dp[index] = Math.max(dp[(i + 1) * width + j], dp[i * width + (j + 1)]);
      }
    }
  }

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (similar(i, j)) {
      partner[i] = j;
      i++;
      j++;
      continue;
    }
    const skipScript = dp[(i + 1) * width + j];
    const skipAsr = dp[i * width + (j + 1)];
    if (skipScript >= skipAsr) i++;
    else j++;
  }

  return partner;
}

/**
 * Second-chance matching for numeric tokens: a script year such as "1492" is
 * often spoken as a token pair ("fourteen ninety-two"), which never matches
 * token-for-token. Consume a short run of unmatched numeric ASR words when
 * their values recombine into the script number.
 */
function matchNumericSpans(
  scriptTokens: string[],
  asrWords: AsrWord[],
  partner: number[],
): void {
  const consumed = new Set<number>(partner.filter((index) => index >= 0));
  for (let i = 0; i < scriptTokens.length; i++) {
    if (partner[i] >= 0) continue;
    const target = numberValue(scriptTokens[i]);
    if (target === undefined || target < 100 || target > 9999) continue;

    for (let start = 0; start < asrWords.length; start++) {
      if (consumed.has(start)) continue;
      let value = 0;
      let count = 0;
      for (let end = start; end < asrWords.length && count < 3; end++) {
        if (consumed.has(end)) break;
        const part = numberValue(asrWords[end].word);
        if (part === undefined) break;
        // Two two-digit groups read as a year: 14 * 100 + 92 === 1492.
        value = count === 0 ? part : value * 100 + part;
        count++;
        if (value === target) {
          partner[i] = start;
          for (let k = start; k <= end; k++) consumed.add(k);
          break;
        }
      }
      if (partner[i] >= 0) break;
    }
  }
}

function interpolateUnmatched(
  scriptTokens: string[],
  partner: number[],
  asrWords: AsrWord[],
  bounds: { start: number; end: number },
): AlignedWord[] {
  const words: AlignedWord[] = scriptTokens.map((token) => ({
    token,
    start: 0,
    end: 0,
    matched: false,
  }));

  for (let index = 0; index < scriptTokens.length; index++) {
    const asrIndex = partner[index];
    if (asrIndex < 0) continue;
    const asr = asrWords[asrIndex];
    words[index] = {
      token: scriptTokens[index],
      start: clamp(asr.start, bounds),
      end: Math.max(clamp(asr.end, bounds), clamp(asr.start, bounds)),
      matched: true,
    };
  }

  const matchedIndexes: number[] = [];
  for (let index = 0; index < words.length; index++) {
    if (words[index].matched) matchedIndexes.push(index);
  }
  if (matchedIndexes.length === 0) return words;

  const fill = (
    from: number,
    to: number,
    startTime: number,
    endTime: number,
  ): void => {
    const count = to - from;
    if (count <= 0) return;
    const width = Math.max(0, endTime - startTime);
    const slice = count > 0 ? width / count : 0;
    for (let k = from; k < to; k++) {
      const slot = k - from;
      words[k] = {
        token: words[k].token,
        start: startTime + slot * slice,
        end: startTime + (slot + 1) * slice,
        matched: false,
      };
    }
  };

  const first = matchedIndexes[0];
  fill(0, first, bounds.start, words[first].start);
  for (let m = 0; m < matchedIndexes.length - 1; m++) {
    const a = matchedIndexes[m];
    const b = matchedIndexes[m + 1];
    fill(a + 1, b, words[a].end, words[b].start);
  }
  const last = matchedIndexes[matchedIndexes.length - 1];
  fill(last + 1, words.length, words[last].end, bounds.end);

  return words;
}

function clamp(time: number, bounds: { start: number; end: number }): number {
  if (!Number.isFinite(time)) return bounds.start;
  return Math.min(Math.max(time, bounds.start), bounds.end);
}

/**
 * Distribute script tokens across the scene window in proportion to token
 * length. Used when alignment quality is below the gate, so subtitles stay in
 * the right scene and roughly in step instead of being dropped.
 */
export function proportionalAlignment(
  scriptTokens: string[],
  bounds: { start: number; end: number },
): AlignedWord[] {
  const weights = scriptTokens.map((token) => Math.max(1, token.length));
  const total = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  const window = Math.max(0, bounds.end - bounds.start);
  let cursor = bounds.start;
  return scriptTokens.map((token, index) => {
    const width = (weights[index] / total) * window;
    const word = { token, start: cursor, end: cursor + width, matched: false };
    cursor += width;
    return word;
  });
}

export const SCENE_ALIGNMENT_GATE = 0.9;
export const OVERALL_ALIGNMENT_GATE = 0.75;

/**
 * Align one scene's script text against its transcribed chunk. Falls back to
 * proportional timing when the match ratio is below the per-scene gate.
 */
export function alignScene(options: {
  scriptText: string;
  asrWords: AsrWord[];
  bounds: { start: number; end: number };
}): AlignmentResult {
  const tokens = tokenizeScript(options.scriptText);
  if (tokens.length === 0) {
    return {
      words: [],
      matched: 0,
      total: 0,
      matchRatio: 1,
      method: "proportional",
    };
  }

  const partner = lcsAlignment(tokens, options.asrWords);
  matchNumericSpans(tokens, options.asrWords, partner);
  const matched = partner.filter((index) => index >= 0).length;
  const matchRatio = matched / tokens.length;

  if (matchRatio < SCENE_ALIGNMENT_GATE) {
    return {
      words: proportionalAlignment(tokens, options.bounds),
      matched,
      total: tokens.length,
      matchRatio,
      method: "proportional",
    };
  }

  return {
    words: interpolateUnmatched(
      tokens,
      partner,
      options.asrWords,
      options.bounds,
    ),
    matched,
    total: tokens.length,
    matchRatio,
    method: "aligned",
  };
}

/** Flatten aligned words into the persisted per-scene word timestamps. */
export function toWordTimestamps(words: AlignedWord[]): SceneWordTimestamp[] {
  return words.map((word) => ({
    word: word.token,
    start: Math.round(word.start * 1000) / 1000,
    end: Math.round(word.end * 1000) / 1000,
  }));
}
