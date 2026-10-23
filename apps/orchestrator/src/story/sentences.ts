import type { SceneGrouping, Sentence } from "./types.js";

/**
 * Sentence segmentation for the story pipeline.
 *
 * The shared `splitNarrationSentences` utility handles the Latin punctuation
 * the Shorts pipeline needs. Story mode additionally has to honour non-Latin
 * terminators (Urdu `۔`/`؟`, Devanagari `।`, CJK `。`/`！`/`？`), so this is a
 * script-aware superset of the same rules. It is deliberately NOT a change to
 * the shared utility — the Shorts pipeline keeps byte-identical behaviour.
 *
 * Handled: titles (Dr., Mr., St.), decimals (3.14), thousands separators
 * (1,492), closing quotes/brackets after the terminal, ellipses, and the
 * script terminators listed above.
 */

const TERMINALS = new Set([
  ".",
  "!",
  "?",
  "…",
  "۔", // Urdu full stop
  "؟", // Arabic/Urdu question mark
  "！", // fullwidth !
  "？", // fullwidth ?
  "。", // ideographic full stop
  "।", // Devanagari danda
]);

const CLOSERS = new Set(['"', "'", "”", "’", ")", "]", "}", "»", "】", "」"]);

/** Abbreviations whose trailing period never ends a sentence. */
const MASKED_ABBREVIATIONS = new Set([
  "dr",
  "mr",
  "mrs",
  "ms",
  "messrs",
  "prof",
  "gen",
  "col",
  "capt",
  "lt",
  "sgt",
  "gov",
  "sen",
  "rep",
  "rev",
  "hon",
  "st",
  "mt",
  "vs",
  "fig",
  "approx",
]);

/**
 * Terminators used by scripts that do not put a space after the end of a
 * sentence. For these the "a following letter means the sentence continues"
 * guard does not apply, otherwise CJK and Urdu text would never split.
 * "…" is deliberately NOT here: in Latin text it is followed by a space and
 * mid-sentence ellipses are common ("Wait… and then").
 */
const SPACELESS_TERMINALS = new Set(["。", "！", "？", "।", "۔", "؟"]);

export function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return [];

  const out: string[] = [];
  let from = 0;
  let i = 0;

  while (i < normalized.length) {
    if (!TERMINALS.has(normalized[i])) {
      i++;
      continue;
    }
    const start = i;
    while (i < normalized.length && TERMINALS.has(normalized[i])) i++;
    while (i < normalized.length && CLOSERS.has(normalized[i])) i++;

    const spaceless = SPACELESS_TERMINALS.has(normalized[start]);

    // A terminal glued to a following character is not a boundary
    // ("3.14", "e.g.", "U.S.A").
    if (!spaceless) {
      const glued = normalized[i];
      if (glued !== undefined && glued !== " ") continue;
    }

    let k = i;
    while (normalized[k] === " ") k++;
    const next = normalized[k];
    if (!spaceless && next !== undefined) {
      // A lowercase word after the terminal continues the sentence.
      if (/\p{Ll}/u.test(next)) continue;
      if (normalized[start] === "." && i - start === 1) {
        let s = start;
        while (s > 0 && /\p{L}/u.test(normalized[s - 1] ?? "")) s--;
        const token = normalized.slice(s, start);
        if (MASKED_ABBREVIATIONS.has(token.toLowerCase())) continue;
        // Single-letter initial before another capitalized word ("J. K.").
        if (
          /^\p{Lu}$/u.test(token) &&
          normalized[s - 1] !== "." &&
          /\p{Lu}/u.test(next)
        ) {
          continue;
        }
      }
    }

    const sentence = normalized.slice(from, i).trim();
    if (sentence) out.push(sentence);
    from = k;
    i = k;
  }

  const tail = normalized.slice(from).trim();
  if (tail) out.push(tail);
  return out;
}

export function countWords(text: string): number {
  return (text.match(/[\p{L}\p{N}]+(?:['’\u2019-][\p{L}\p{N}]+)*/gu) ?? [])
    .length;
}

/**
 * Segment the story into sentences with stable code-assigned ids (`s1`..`sN`).
 * IDs are what the model references; the text is never re-typed by the model.
 * The language parameter is accepted for API symmetry and future script
 * overrides — terminators are already script-aware.
 */
export function segmentSentences(story: string, _language = "en"): Sentence[] {
  void _language;
  return splitSentences(story).map((text, index) => ({
    id: `s${index + 1}`,
    text,
    wordCount: countWords(text),
  }));
}

/** Narration text assembled from sentence ids — never model-copied. */
export function assembleNarration(
  sentenceIds: string[],
  byId: Map<string, Sentence>,
): string {
  return sentenceIds
    .map((id) => byId.get(id)?.text ?? "")
    .filter((text) => text.length > 0)
    .join(" ");
}

export function estimatedDurationSec(
  sentences: Sentence[],
  wpm: number,
): number {
  const words = sentences.reduce(
    (sum, sentence) => sum + sentence.wordCount,
    0,
  );
  return (words / wpm) * 60;
}

export interface GroupingIssue {
  message: string;
}

/**
 * Validate the model's scene grouping:
 * every sentence used exactly once, in order, contiguously; ids unique and
 * ordered; no empty scenes (brief S3 step 3).
 */
export function validateGrouping(
  scenes: SceneGrouping["scenes"],
  sentences: Sentence[],
): GroupingIssue[] {
  const issues: GroupingIssue[] = [];
  const known = new Set(sentences.map((sentence) => sentence.id));
  const seen = new Map<string, number>();

  if (scenes.length === 0) {
    issues.push({ message: "grouping must contain at least one scene" });
    return issues;
  }

  let cursor = 0;
  scenes.forEach((scene, index) => {
    if (scene.sceneId !== index + 1) {
      issues.push({
        message: `scene ${index + 1} must have sceneId ${index + 1}, received ${scene.sceneId}`,
      });
    }
    if (scene.sentenceIds.length === 0) {
      issues.push({ message: `scene ${scene.sceneId} covers no sentences` });
    }
    scene.sentenceIds.forEach((id) => {
      if (!known.has(id)) {
        issues.push({
          message: `scene ${scene.sceneId} references unknown sentence id ${id}`,
        });
        return;
      }
      if (seen.has(id)) {
        issues.push({
          message: `sentence ${id} is used by both scene ${seen.get(id)} and scene ${scene.sceneId}`,
        });
        return;
      }
      seen.set(id, scene.sceneId);
      const position = sentences.findIndex((sentence) => sentence.id === id);
      if (position !== cursor) {
        issues.push({
          message: `scene ${scene.sceneId} starts at sentence ${id} but sentences must be covered in order (expected ${sentences[cursor]?.id ?? "<end>"})`,
        });
      }
      cursor = position + 1;
    });
  });

  const missing = sentences.filter((sentence) => !seen.has(sentence.id));
  if (missing.length > 0) {
    issues.push({
      message: `sentences not covered by any scene: ${missing
        .map((sentence) => sentence.id)
        .join(", ")}`,
    });
  }

  return issues;
}

export interface GroupingOptions {
  wpm: number;
  sceneMinSec: number;
  sceneTargetMinSec: number;
  sceneTargetMaxSec: number;
}

/**
 * Deterministic greedy grouping used when the model's grouping fails
 * validation twice (brief S3 step 5). Sentences are appended until the scene
 * reaches the middle of the target band, so no sentence is ever split.
 */
export function fallbackGrouping(
  sentences: Sentence[],
  options: GroupingOptions,
): SceneGrouping["scenes"] {
  const midpoint = (options.sceneTargetMinSec + options.sceneTargetMaxSec) / 2;
  const perWordSec = 60 / Math.max(1, options.wpm);

  const groups: Sentence[][] = [];
  let current: Sentence[] = [];
  let currentSec = 0;

  for (const sentence of sentences) {
    current.push(sentence);
    currentSec += sentence.wordCount * perWordSec;
    if (currentSec >= midpoint) {
      groups.push(current);
      current = [];
      currentSec = 0;
    }
  }
  if (current.length > 0) groups.push(current);

  // Fold a too-short trailing scene back into its predecessor so the last
  // visual is not a one-word flash.
  if (groups.length > 1) {
    const last = groups[groups.length - 1];
    const lastSec = last.reduce(
      (sum, sentence) => sum + sentence.wordCount * perWordSec,
      0,
    );
    if (lastSec < options.sceneMinSec) {
      groups[groups.length - 2].push(...last);
      groups.pop();
    }
  }

  return groups.map((group, index) => ({
    sceneId: index + 1,
    sentenceIds: group.map((sentence) => sentence.id),
    visualPurpose: `Scene ${index + 1}`,
  }));
}
