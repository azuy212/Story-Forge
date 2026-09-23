/**
 * Canonical narration text utilities shared by the deterministic retention
 * contract in ScriptQA and the VisualDirector's scene-narration checks.
 *
 * There is exactly one tokenizer: a "word" is a run of letters/digits after
 * whitespace normalization and lowercasing, with non-alphanumeric characters
 * treated as separators. Both sides of every comparison — the declared
 * sentence and the narration it is matched against — go through the same
 * function, so punctuation can never shift a position between producer and
 * verifier.
 */

export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export function tokenizeText(s: string): string[] {
  return normalizeWhitespace(s)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function wordCount(s: string): number {
  return tokenizeText(s).length;
}

export function endsWithTokens(source: string, suffix: string): boolean {
  const sourceTokens = tokenizeText(source);
  const suffixTokens = tokenizeText(suffix);
  if (suffixTokens.length === 0 || suffixTokens.length > sourceTokens.length) {
    return false;
  }
  return suffixTokens.every(
    (word, index) =>
      sourceTokens[sourceTokens.length - suffixTokens.length + index] === word,
  );
}

/** First token index of `needle` inside `tokens` (contiguous), or -1. */
export function findTokenSequenceIndex(
  tokens: string[],
  needle: string[],
): number {
  if (needle.length === 0) return -1;
  for (let start = 0; start + needle.length <= tokens.length; start++) {
    let match = true;
    for (let i = 0; i < needle.length; i++) {
      if (tokens[start + i] !== needle[i]) {
        match = false;
        break;
      }
    }
    if (match) return start;
  }
  return -1;
}

/** Best-effort sentence split on sentence-ending punctuation + whitespace. */
export function splitSentences(s: string): string[] {
  return normalizeWhitespace(s)
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export function firstSentence(s: string): string {
  const parts = splitSentences(s);
  return parts[0] ?? normalizeWhitespace(s);
}

export interface BeatWordSpan {
  beatId: number;
  startWord: number;
  endWord: number;
}

/** Cumulative token spans over ordered beat narrations. */
export function beatWordSpans(
  beats: { beatId: number; narration: string }[],
): BeatWordSpan[] {
  let cursor = 0;
  return beats.map((b) => {
    const words = wordCount(b.narration);
    const span = {
      beatId: b.beatId,
      startWord: cursor,
      endWord: cursor + words,
    };
    cursor += words;
    return span;
  });
}
