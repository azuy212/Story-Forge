import { endsWithTokens, wordCount } from "./narration-contract.js";
import { logger } from "./logger.js";

/**
 * Unit-based scene segmentation for the VisualDirector.
 *
 * The narration is pre-split by code into *units* — whole sentences, or clause
 * pieces of an over-long sentence. The model never outputs narration text;
 * each scene lists the unit ids it covers and the narration is derived by
 * joining those units. Because units are built from the narration itself, the
 * model can no longer paraphrase, drop, or reorder a single word: covering
 * every unit exactly once reproduces the narration exactly.
 */

export interface NarrationUnit {
  /** 1-based sequential id used by the model in `unitIds`. */
  id: number;
  text: string;
  wordCount: number;
}

/** Sentence terminal punctuation that also counts for the split rules. */
const CLOSERS = "\"'”’)】]»";

/**
 * Abbreviations whose trailing period never ends a sentence — titles and the
 * few forms that are safe to mask. Sentence-final-prone forms ("us", "no",
 * "nasa", "inc", …) are deliberately absent: a period after them is treated as
 * a sentence end.
 */
const ALWAYS_MASK = new Set([
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

/** Coordinating conjunctions — the only word-boundary splits permitted. */
const COORD_CONJUNCTIONS = new Set([
  "for",
  "and",
  "nor",
  "but",
  "or",
  "yet",
  "so",
]);

/** Units that must never be separated from the number they quantify. */
const NUMBER_UNITS = new Set([
  "second",
  "seconds",
  "minute",
  "minutes",
  "hour",
  "hours",
  "day",
  "days",
  "week",
  "weeks",
  "month",
  "months",
  "year",
  "years",
  "mile",
  "miles",
  "meter",
  "meters",
  "metre",
  "metres",
  "kilometer",
  "kilometers",
  "kilometre",
  "kilometres",
  "km",
  "foot",
  "feet",
  "yard",
  "yards",
  "inch",
  "inches",
  "pound",
  "pounds",
  "lbs",
  "kg",
  "gram",
  "grams",
  "ton",
  "tons",
  "tonne",
  "tonnes",
  "degree",
  "degrees",
  "celsius",
  "fahrenheit",
  "kw",
  "watt",
  "watts",
  "percent",
  "times",
  "cubed",
  "squared",
]);

const MONTHS = new Set([
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
]);

function isDashToken(token: string): boolean {
  return /^[-–—]+$/.test(token);
}

/** Characters that may form (part of) a sentence-terminal punctuation run. */
function isTerminal(c: string | undefined): boolean {
  return c === "." || c === "!" || c === "?" || c === "…";
}

function stripPunct(token: string): string {
  return token.replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * The sentence splitter, provided as a drop-in replacement for the previous
 * `isAbbreviationPeriod`/`isMaskedPeriod` helpers.
 *
 * Rules (in order):
 * - a run of terminal punctuation plus glued closers ("?!", "…", `."`) forms
 *   one terminal;
 * - a terminal followed by something other than whitespace is never a
 *   sentence end ("3.14", "e.g.", "U.S.A");
 * - a terminal followed by a lowercase word continues the sentence ("…"
 *   then "then vanished.", dialogue tags after a closing quote);
 * - a single period preceded by a masked title ("Dr.", "vs.") or by a
 *   single-letter initial in front of another capitalized word ("J. K.")
 *   does not end the sentence. Only `ALWAYS_MASK` titles are masked —
 *   sentence-final-prone forms ("NASA.", "us.", "no.") end sentences.
 */
export function splitNarrationSentences(narration: string): string[] {
  const text = narration.replace(/\s+/g, " ").trim();
  if (!text) return [];
  const out: string[] = [];
  let from = 0;
  let i = 0;
  while (i < text.length) {
    if (!isTerminal(text[i])) {
      i++;
      continue;
    }
    const start = i;
    while (i < text.length && isTerminal(text[i])) i++;
    while (i < text.length && (CLOSERS as string).includes(text[i] ?? "")) i++;
    const glued = text[i];
    if (glued !== undefined && glued !== " ") continue; // 3.14, e.g., U.S.A
    let k = i;
    while (text[k] === " ") k++;
    const next = text[k];
    if (next !== undefined) {
      if (/\p{Ll}/u.test(next)) continue; // lowercase continues
      if (text[start] === "." && i - start === 1) {
        let s = start;
        while (s > 0 && /\p{L}/u.test(text[s - 1] ?? "")) s--;
        const token = text.slice(s, start);
        if (ALWAYS_MASK.has(token.toLowerCase())) continue; // Dr. Smith
        if (
          /^\p{Lu}$/u.test(token) &&
          text[s - 1] !== "." &&
          /\p{Lu}/u.test(next)
        ) {
          continue; // J. K. Rowling
        }
      }
    }
    out.push(text.slice(from, i).trim());
    from = k;
    i = k;
  }
  if (from < text.length) out.push(text.slice(from).trim());
  return out;
}

/**
 * Index through which all cuts are forbidden when the sentence opens with a
 * leading date phrase ("In 1753,", "On January 3, 1919,"). A scene should not
 * open on a dangling date preposition, so the boundary immediately after the
 * leading phrase — and everything inside it — is refused. -1 when the sentence
 * does not open with "In <year>"/"On <date>".
 */
function leadingDateCutThrough(tokens: string[]): number {
  const first = stripPunct(tokens[0] ?? "").toLowerCase();
  if (first !== "in" && first !== "on") return -1;
  if (tokens.length < 3) return -1;
  const second = stripPunct(tokens[1] ?? "");
  if (/^\d{3,4}[,.]?$/.test(second)) {
    // "In 1753," — the comma rides the year token; the cut sits before the
    // token after it (index 2).
    return /[,.]$/.test(tokens[1] ?? "") ? 2 : -1;
  }
  if (!MONTHS.has(second.toLowerCase())) return -1;
  // "On January 3, 1919," — refuse every cut up to and including the year's
  // closing comma.
  for (let k = 2; k < Math.min(tokens.length, 6); k++) {
    if (/^\d{3,4}[,.]?$/.test(stripPunct(tokens[k] ?? ""))) {
      return /[,.]$/.test(tokens[k] ?? "") ? k + 1 : k;
    }
  }
  return -1;
}

/**
 * Clause boundaries inside a sentence: only commas, dashes, semicolons, and a
 * coordinating conjunction following terminal punctuation. Returns the token
 * index a cut is allowed BEFORE (i.e. the cut sits between tokens[i-1] and
 * tokens[i]); empty when the sentence must stay whole.
 *
 * Two quality guards:
 * - each resulting piece must hold at least four words;
 * - a cut directly after a leading "In <year>," / "On <date>," is refused.
 */
function clauseBoundaries(tokens: string[]): number[] {
  const candidates: number[] = [];
  const minWords = 4;
  const forbiddenThrough = leadingDateCutThrough(tokens);
  // Capitalized tokens glued into a run of two or more form a proper name.
  const inNameRun = tokens.map(() => false);
  {
    const isCap = tokens.map((t) => {
      const letters = stripPunct(t);
      return letters.length > 0 && /^[\p{Lu}]/u.test(letters);
    });
    let runStart = -1;
    for (let i = 0; i < tokens.length; i++) {
      if (isCap[i]) {
        if (runStart < 0) runStart = i;
      } else {
        if (runStart >= 0 && i - runStart >= 3) {
          for (let k = runStart; k < i; k++) inNameRun[k] = true;
        }
        runStart = -1;
      }
    }
    if (runStart >= 0 && tokens.length - runStart >= 3) {
      for (let k = runStart; k < tokens.length; k++) inNameRun[k] = true;
    }
  }

  for (let i = 1; i < tokens.length; i++) {
    const prev = tokens[i - 1] ?? "";
    const next = tokens[i] ?? "";
    const prevStripped = stripPunct(prev);
    const nextStripped = stripPunct(next);
    const nextLower = nextStripped.toLowerCase();

    // The cut would sit right at/inside the leading date phrase.
    if (i <= forbiddenThrough) continue;
    // Both pieces must be substantial clauses (> minWords-1 words each).
    if (i < minWords || tokens.length - i < minWords) continue;

    // Never split inside a proper name ("Georg | Richmann").
    if (inNameRun[i - 1] && inNameRun[i]) continue;
    // Never split inside a date ("January | 3, | 1919" — month to digits, or
    // two adjacent numeric tokens such as "3, | 1919"; a 4-digit year run).
    if (MONTHS.has(prevStripped.toLowerCase()) && /^\d/.test(nextStripped)) {
      continue;
    }
    if (/^\d{3,}[.,]?$/.test(prevStripped) && /^\d{3,}[.,]?$/.test(nextLower)) {
      continue;
    }
    // Never split a number away from its unit ("25 | feet").
    if (/^\d/.test(prevStripped) && NUMBER_UNITS.has(nextLower)) continue;
    if (/^\d/.test(prevStripped) && next === "%") continue;

    const allowed =
      /[;,]$/.test(prev) ||
      isDashToken(prev) ||
      /[-–—]$/.test(prev) ||
      (COORD_CONJUNCTIONS.has(nextLower) && /[;,.!?"'…]$/.test(prev));
    if (allowed) candidates.push(i);
  }
  return candidates;
}

/**
 * Split an over-long sentence at the clause boundary nearest the middle, never
 * inside a proper name, a date, or a number with its unit. When no safe
 * boundary exists the sentence is kept whole.
 */
function splitLongSentence(sentence: string, maxWords: number): string[] {
  const tokens = sentence.split(" ").filter((t) => t.length > 0);
  if (tokens.length <= maxWords) return [sentence];

  const candidates = clauseBoundaries(tokens);
  if (candidates.length === 0) return [sentence];

  const midpoint = tokens.length / 2;
  let best = candidates[0] ?? tokens.length;
  for (const c of candidates) {
    const deltaBest = Math.abs((best ?? 0) - midpoint);
    const deltaC = Math.abs(c - midpoint);
    if (deltaC < deltaBest) best = c;
  }

  const first = tokens.slice(0, best).join(" ").trim();
  const rest = tokens.slice(best).join(" ").trim();
  if (!first || !rest) return [sentence];
  // Each piece may itself still be over the cap — recurse, but a piece with no
  // remaining safe boundary stays whole instead of looping forever.
  return [
    ...splitLongSentence(first, maxWords),
    ...splitLongSentence(rest, maxWords),
  ];
}

/**
 * Narration-unit pipeline version: unit ids, derived narrations, and the
 * deterministic repair pass are all meaningless across versions, so the cache
 * key includes this one.
 */
export const UNIT_PIPELINE_VERSION = 3;

/**
 * Pre-segment the narration into units: one unit per sentence, and one unit
 * per clause piece when a sentence exceeds `maxSceneWords` words. Ids are
 * 1-based and consecutive across the whole narration.
 *
 * Invariant: the units' joined text must reproduce the whitespace-normalized
 * narration exactly. If a unit boundary would ever lose or duplicate text,
 * the builder logs the violation and falls back to whole sentences without
 * clause splitting (which reproduces the narration by construction).
 */
export function buildNarrationUnits(
  narration: string,
  maxSceneWords: number,
): NarrationUnit[] {
  const cap = Math.max(1, Math.floor(maxSceneWords));
  const sentences = splitNarrationSentences(narration);
  const pieces: string[] = [];
  for (const sentence of sentences) {
    pieces.push(...splitLongSentence(sentence, cap));
  }

  const normalized = narration.replace(/\s+/g, " ").trim();
  const joined = pieces
    .map((piece) => piece.replace(/\s+/g, " ").trim())
    .join(" ");
  let units = pieces;
  if (pieces.length > 0 && joined !== normalized) {
    logger.error(
      "narration unit invariant violated — rebuilding units as whole sentences without clause splits",
      {
        expectedChars: normalized.length,
        receivedChars: joined.length,
      },
    );
    units = sentences;
  }

  return units.map((text, index) => ({
    id: index + 1,
    text,
    wordCount: wordCount(text),
  }));
}

/** Prompt rendering for [[narrationUnits]]: one line per unit — "[id] text". */
export function formatUnits(units: NarrationUnit[]): string {
  return units.map((u) => `[${u.id}] ${u.text}`).join("\n");
}

// ---------------------------------------------------------------------------
// Unit coverage: repair, derive, validate
// ---------------------------------------------------------------------------

export interface SceneUnitsOptions {
  maxSceneWords: number;
  minScenes: number;
  maxScenes: number | null;
  endingNarration?: string;
  /**
   * The script's retention pivot sentence, matched (case- and whitespace-
   * normalized) against the joined unit text: units it spans get marker-
   * level protection in every merge decision, no model marker required.
   */
  pivotSentence?: string;
  /**
   * True on the salvage path (a schema-rejected payload being recovered):
   * a repair that cannot proceed — e.g. a protected scene blocking the
   * ending absorb — degrades to a skipped repair with a warning instead of
   * pushing a hard issue, because a recovered payload exists to finish a
   * run that would otherwise die and must not re-introduce a content veto.
   */
  recovering?: boolean;
}

export interface SceneUnitsResult<T> {
  scenes: Array<
    T & { unitIds: number[]; narration: string; modelSceneIds: number[] }
  >;
  issues: string[];
  warnings: string[];
  /** True when any deterministic repair changed the model's segmentation. */
  repairRan: boolean;
  unitCount: number;
}

interface Work<T> {
  scene: T;
  ids: number[];
  modelSceneIds: number[];
}

/**
 * List fields the merged scene must carry after a merge: union both scenes'
 * values winner-first, deduplicating. `entities` deduplicates by reference —
 * both sides carry the same objects from one model payload.
 */
const MERGED_LIST_FIELDS = ["sourceBeatIds", "references", "entities"] as const;

/**
 * Create the protection scorer for one `finalizeSceneUnits` call, bound to
 * the call's content marks: the unit-id sets covered by the script's pivot
 * sentence and the declared ending.
 *
 * Tiers: 3 when the scene is marker-protected (high emphasis, or a structural
 * `Pivot:`/`Bookend:` goal) or spans the pivot sentence — a model marker or
 * a script pivot outranks position; 2 when only its position protects it
 * (first or last scene of the current work list) or it spans the declared
 * ending; else 0.
 */
/** Lowercase and collapse whitespace runs to single spaces, trimming ends —
 * the normalization shared by narration-unit text about to be joined, and by
 * the pivot/ending fragments located inside that join. */
function normalizeSearch(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function createProtectionScore(
  pivotUnitSet: Set<number>,
  endingUnitSet: Set<number>,
): (
  scene: unknown,
  unitIds: number[],
  isFirst: boolean,
  isLast: boolean,
) => number {
  return function protectionScore(
    scene: unknown,
    unitIds: number[],
    isFirst: boolean,
    isLast: boolean,
  ): number {
    const s = scene as Record<string, unknown>;
    const touchesPivot =
      pivotUnitSet.size > 0 &&
      unitIds.some((id: number) => pivotUnitSet.has(id));
    if (s.emphasis === "high" || touchesPivot) return 3;
    const goal = s.sceneGoal;
    if (
      typeof goal === "string" &&
      ["Pivot:", "Bookend:"].some((prefix) => goal.startsWith(prefix))
    ) {
      return 3;
    }
    const touchesEnding =
      endingUnitSet.size > 0 &&
      unitIds.some((id: number) => endingUnitSet.has(id));
    if (isFirst || isLast || touchesEnding) return 2;
    return 0;
  };
}

/**
 * Merge `removed` into `target`. The higher protection tier wins: the merged
 * scene is a clone of the winner's scene — its whole identity (emphasis, goal,
 * anchor, camera, emotional beat) carries over — with the list fields unioned
 * winner-first, and the winner's model scene ids leading in `modelSceneIds`.
 * Callers pass the winner explicitly: protection plus reading order decides
 * everywhere except the ending absorb, where the final scene always wins.
 */
function foldSceneInto<T>(
  target: Work<T>,
  removed: Work<T>,
  winner: "target" | "removed",
): void {
  const targetScene = target.scene as Record<string, unknown>;
  const removedScene = removed.scene as Record<string, unknown>;
  const winnerScene = winner === "target" ? targetScene : removedScene;
  const loserScene = winner === "target" ? removedScene : targetScene;
  const lists: Record<string, unknown[]> = {};
  for (const key of MERGED_LIST_FIELDS) {
    const winnerVal = winnerScene[key];
    const loserVal = loserScene[key];
    if (winnerVal === undefined && loserVal === undefined) continue;
    if (!Array.isArray(winnerVal) && !Array.isArray(loserVal)) continue;
    const list: unknown[] = [
      ...(Array.isArray(winnerVal) ? winnerVal : []),
      ...(Array.isArray(loserVal) ? loserVal : []),
    ];
    const seen = new Set<unknown>();
    lists[key] = list.filter((value) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  }
  target.scene = { ...winnerScene, ...lists } as T;
  target.modelSceneIds =
    winner === "target"
      ? [...target.modelSceneIds, ...removed.modelSceneIds]
      : [...removed.modelSceneIds, ...target.modelSceneIds];
}

const GOAL_CONTINUATION_PREFIXES = ["New beat:", "Pivot:", "Bookend:"];

function keepsOriginalGoal(goal: string): boolean {
  return GOAL_CONTINUATION_PREFIXES.some((prefix) => goal.startsWith(prefix));
}

/**
 * The camera treatment for a piece carved out of the previous piece. Wide/
 * medium/close-up swap to a nearer/adjacent shot; aerial, top-down, isometric
 * and extreme-close keep their shot (an angle swap would read as a new
 * subject) and instead change the camera motion, rotating static → push-in →
 * pull-back and parking anything else on static.
 */
const SPLIT_SHOT_SWAP: Record<string, string> = {
  wide: "medium",
  medium: "close-up",
  "close-up": "medium",
};

const KEEP_SHOT_MOTION_ROTATION: Record<string, string> = {
  static: "push-in",
  "push-in": "pull-back",
};

function nextPieceCamera(
  prevShot: unknown,
  prevMotion: unknown,
): { cameraShot: unknown; cameraMotion: unknown } {
  const swapped = SPLIT_SHOT_SWAP[typeof prevShot === "string" ? prevShot : ""];
  if (swapped !== undefined) {
    return { cameraShot: swapped, cameraMotion: prevMotion };
  }
  // Keep-shot branch (aerial, top-down, isometric, extreme-close — and any
  // unrecognized value): the motion carries the change instead.
  return {
    cameraShot: prevShot,
    cameraMotion:
      KEEP_SHOT_MOTION_ROTATION[
        typeof prevMotion === "string" ? prevMotion : ""
      ] ?? "static",
  };
}

/** Field adjustments applied to every scene carved out of a split parent. */
function applySplitPieceFields<T>(scene: T): void {
  const piece = scene as Record<string, unknown>;
  piece.transition = "cut";
  if (piece.emphasis === "high") piece.emphasis = "medium";
  // The parent's narrative goal already reads as a continuation when it is a
  // structural marker (new beat, pivot, bookend); otherwise the piece says so.
  if (typeof piece.sceneGoal === "string") {
    if (!keepsOriginalGoal(piece.sceneGoal)) {
      piece.sceneGoal = `Continues: ${piece.sceneGoal}`;
    }
  } else {
    piece.sceneGoal = "Continues:";
  }
  // visualAnchor is deliberately untouched: split pieces describe the same
  // visual subject as their parent.
}

/**
 * Validate and repair the model's unit grouping, then derive each scene's
 * narration by joining its units.
 *
 * Repair (in order, deterministic):
 *  1. drop out-of-range/duplicate unit ids and empty scenes;
 *  2. merge overlaps — the first scene in reading order keeps a unit, and a
 *     scene left without unique units is folded into its predecessor;
 *  3. assign orphan units to the adjacent scene (the neighbour that stays
 *     under the word cap when one side fits and the other does not);
 *  4. restore reading order;
 *  5. split any multi-unit scene past the word cap at a unit boundary (the
 *     split-off piece inherits the parent's identity so its visual plan is
 *     duplicated by the caller's plan mapping);
 *  6. merge the smallest adjacent pair when the scene count exceeds the band;
 *  7. absorb trailing units into the final scene when a declared ending is
 *     otherwise cut across two scenes.
 *
 * After repair the remaining violations are reported as `issues` — those are
 * not repairable in code and the caller should retry the model instead.
 */
export function finalizeSceneUnits<T>(
  scenes: T[],
  units: NarrationUnit[],
  options: SceneUnitsOptions,
): SceneUnitsResult<T> {
  const unitCount = units.length;
  const unitWords = new Map(units.map((u) => [u.id, u.wordCount]));
  const unitById = new Map(units.map((u) => [u.id, u]));
  const warnings: string[] = [];
  const issues: string[] = [];
  let repairRan = false;

  const wordSum = (ids: number[]): number =>
    ids.reduce((sum, id) => sum + (unitWords.get(id) ?? 0), 0);

  // Content-based protection marks: build a whitespace- and case-normalized
  // join of all unit texts with per-unit character offsets, so a pivot
  // sentence or a declared ending can be located in the narration and mapped
  // back onto the unit ids it spans.
  let joinText = "";
  const unitSpans: Array<{ id: number; start: number; end: number }> = [];
  for (const u of units) {
    const piece = normalizeSearch(u.text);
    if (piece === "") continue;
    const start = joinText.length;
    joinText += piece;
    unitSpans.push({ id: u.id, start, end: joinText.length });
    joinText += " ";
  }
  const findUnitIds = (raw: string | undefined): number[] | null => {
    if (!raw) return null;
    const needle = normalizeSearch(raw);
    if (needle === "") return null;
    const at = joinText.indexOf(needle);
    if (at < 0) return [];
    return unitSpans
      .filter((span) => span.end > at && span.start < at + needle.length)
      .map((span) => span.id);
  };
  const pivotMatch = findUnitIds(options.pivotSentence);
  let pivotUnitIds: number[] | null = null;
  if (pivotMatch !== null) {
    if (pivotMatch.length === 0) {
      logger.warn(
        "pivot sentence not found in any narration unit — pivot protection disabled",
        { pivotSentence: options.pivotSentence },
      );
    } else {
      pivotUnitIds = pivotMatch;
    }
  }
  const pivotUnitSet = new Set(pivotUnitIds ?? []);
  const endingUnitSet = new Set(findUnitIds(options.endingNarration) ?? []);
  const protectionScore = createProtectionScore(pivotUnitSet, endingUnitSet);

  if (scenes.length === 0) {
    issues.push("no scenes were produced");
    return { scenes: [], issues, warnings, repairRan, unitCount };
  }

  // 1. Sanitize ids: keep valid 1..unitCount ints, deduplicate in order.
  const work: Work<T>[] = [];
  for (const scene of scenes) {
    const raw = Array.isArray((scene as { unitIds?: unknown }).unitIds)
      ? ((scene as { unitIds: unknown[] }).unitIds as unknown[])
      : [];
    const ids: number[] = [];
    for (const value of raw) {
      const id = typeof value === "number" ? value : Number(value);
      if (!Number.isInteger(id) || id < 1 || id > unitCount) {
        warnings.push(
          `scene ${String((scene as { sceneId?: unknown }).sceneId)}: dropped invalid unit id ${JSON.stringify(value)}`,
        );
        repairRan = true;
        continue;
      }
      if (!ids.includes(id)) ids.push(id);
      else {
        warnings.push(
          `scene ${String((scene as { sceneId?: unknown }).sceneId)}: removed duplicate unit id ${id}`,
        );
        repairRan = true;
      }
    }
    if (ids.length === 0) {
      warnings.push(
        `scene ${String((scene as { sceneId?: unknown }).sceneId)}: no valid unit ids — scene dropped`,
      );
      repairRan = true;
      continue;
    }
    work.push({
      // Own a shallow clone so merge/fold repairs below never mutate the
      // caller's object (the raw model payload is kept untouched so callers
      // can re-parse it for salvage).
      scene: { ...scene },
      ids,
      modelSceneIds: [
        Number((scene as { sceneId?: unknown }).sceneId) || work.length + 1,
      ],
    });
  }
  if (work.length === 0) {
    issues.push("every scene had invalid unit ids");
    return { scenes: [], issues, warnings, repairRan, unitCount };
  }

  // 2. Merge overlaps: the FIRST scene in reading order keeps a unit.
  {
    const seen = new Set<number>();
    for (const w of work) {
      const kept: number[] = [];
      for (const id of w.ids) {
        if (seen.has(id)) {
          warnings.push(
            `unit ${id} was claimed by multiple scenes — kept its first scene`,
          );
          repairRan = true;
        } else {
          seen.add(id);
          kept.push(id);
        }
      }
      w.ids = kept;
    }
    // A scene left without unique units merges into its predecessor. Scores
    // read the position each scene held in the work list (first and last are
    // always protected); ties go to the earlier scene by reading order.
    const merged: Work<T>[] = [];
    const mergedOriginalIndex: number[] = [];
    for (let i = 0; i < work.length; i++) {
      const w = work[i];
      if (w.ids.length === 0 && merged.length > 0) {
        const prevAt = merged.length - 1;
        const prev = merged[prevAt]!;
        const prevOriginalIndex = mergedOriginalIndex[prevAt]!;
        const targetScore = protectionScore(
          prev.scene,
          prev.ids,
          prevOriginalIndex === 0,
          prevOriginalIndex === work.length - 1,
        );
        const removedScore = protectionScore(
          w.scene,
          w.ids,
          i === 0,
          i === work.length - 1,
        );
        const removedLabel = String(
          (w.scene as { sceneId?: unknown }).sceneId ?? w.modelSceneIds[0],
        );
        const targetLabel = String(
          (prev.scene as { sceneId?: unknown }).sceneId ??
            prev.modelSceneIds[0],
        );
        foldSceneInto(
          prev,
          w,
          targetScore >= removedScore ? "target" : "removed",
        );
        warnings.push(
          `scene ${removedLabel}: duplicated another scene's units and merged into scene ${targetLabel}`,
        );
        repairRan = true;
        continue;
      }
      merged.push(w);
      mergedOriginalIndex.push(i);
    }
    work.length = 0;
    work.push(...merged);
  }

  // 2.5 Fill gaps whose missing unit ids are orphans: a scene listing [1, 3]
  // obviously meant to cover unit 2 as well, so re-insert it here rather than
  // letting the orphan pass decide where it belongs.
  {
    const covered = new Set(work.flatMap((w) => w.ids));
    for (const w of work) {
      if (w.ids.length < 2) continue;
      const first = Math.min(...w.ids);
      const last = Math.max(...w.ids);
      const missing: number[] = [];
      for (let id = first + 1; id < last; id++) {
        if (!covered.has(id)) missing.push(id);
      }
      if (missing.length === 0) continue;
      w.ids = [...w.ids, ...missing].sort((a, b) => a - b);
      repairRan = true;
      warnings.push(
        `scene ${String((w.scene as { sceneId?: unknown }).sceneId ?? w.modelSceneIds[0])} skipped units ${missing.join(", ")} — inserted them into the gap`,
      );
    }
  }

  // 3. Orphan units join their nearest covered neighbour.
  {
    const covered = new Set(work.flatMap((w) => w.ids));
    const orphans: number[] = [];
    for (let id = 1; id <= unitCount; id++)
      if (!covered.has(id)) orphans.push(id);
    if (orphans.length > 0) {
      repairRan = true;
      const sums = new Map(work.map((w) => [w, wordSum(w.ids)]));
      for (const id of orphans) {
        // Neighbours = the last scene whose units are all < id (prev) and the
        // first scene whose units are all > id (next).
        let prev: Work<T> | null = null;
        let next: Work<T> | null = null;
        for (const w of work) {
          if (w.ids.length === 0) continue;
          const maxId = Math.max(...w.ids);
          const minId = Math.min(...w.ids);
          if (maxId < id && (prev === null || Math.max(...prev.ids) < maxId))
            prev = w;
          if (minId > id && (next === null || Math.min(...next.ids) > minId))
            next = w;
        }
        const prevFits =
          prev !== null &&
          (sums.get(prev) ?? 0) + (unitWords.get(id) ?? 0) <=
            options.maxSceneWords;
        const nextFits =
          next !== null &&
          (sums.get(next) ?? 0) + (unitWords.get(id) ?? 0) <=
            options.maxSceneWords;
        // When neither sibling exists at all, fall back to the far end.
        let target: Work<T> | null = null;
        if (prev !== null && next !== null) {
          if (prevFits) target = prev;
          else if (nextFits) target = next;
          else target = prev;
        } else target = prev ?? next;
        if (target === null) {
          issues.push(`no scene exists to hold unit ${id}`);
          continue;
        }
        target.ids.push(id);
        target.ids.sort((a, b) => a - b);
        sums.set(target, wordSum(target.ids));
        warnings.push(
          `unit ${id} was not assigned to any scene — placed in the adjacent scene ${String((target.scene as { sceneId?: unknown }).sceneId ?? target.modelSceneIds[0])}`,
        );
      }
    }
  }

  // 4. Restore reading order.
  {
    const ordered = [...work].sort((a, b) => {
      const aMin =
        a.ids.length > 0 ? Math.min(...a.ids) : Number.MAX_SAFE_INTEGER;
      const bMin =
        b.ids.length > 0 ? Math.min(...b.ids) : Number.MAX_SAFE_INTEGER;
      return aMin - bMin;
    });
    for (let i = 0; i < work.length; i++) {
      if (work[i] !== ordered[i]) {
        repairRan = true;
        break;
      }
    }
    work.length = 0;
    work.push(...ordered);
  }

  // 5. Split any multi-unit scene past the word cap at a unit boundary.
  {
    const out: Work<T>[] = [];
    for (const w of work) {
      if (w.ids.length <= 1 || wordSum(w.ids) <= options.maxSceneWords) {
        out.push(w);
        continue;
      }
      repairRan = true;
      warnings.push(
        `scene ${String((w.scene as { sceneId?: unknown }).sceneId ?? w.modelSceneIds[0])} exceeded ${options.maxSceneWords} words — split at a unit boundary`,
      );
      let chunk: number[] = [];
      let chunkWords = 0;
      const chunks: number[][] = [];
      for (const id of w.ids) {
        const w0 = unitWords.get(id) ?? 0;
        if (chunk.length > 0 && chunkWords + w0 > options.maxSceneWords) {
          chunks.push(chunk);
          chunk = [];
          chunkWords = 0;
        }
        chunk.push(id);
        chunkWords += w0;
      }
      if (chunk.length > 0) chunks.push(chunk);
      // The first piece keeps the scene's identity (and its visual-plan
      // linkage); the split-off pieces are clones sharing the parent id so the
      // caller's plan mapping duplicates the parent's plan for them. Each
      // clone is adjusted so it reads as a continuation (cut transition,
      // downgraded emphasis, prefixed goal) and the camera chains off the
      // previous piece — piece 2 derives from the parent, piece 3 from piece
      // 2 — so consecutive pieces never share the same shot/motion pair.
      w.ids = chunks[0]!;
      out.push(w);
      let chainShot: unknown = (w.scene as Record<string, unknown>).cameraShot;
      let chainMotion: unknown = (w.scene as Record<string, unknown>)
        .cameraMotion;
      for (let k = 1; k < chunks.length; k++) {
        const camera = nextPieceCamera(chainShot, chainMotion);
        const pieceScene = {
          ...w.scene,
          cameraShot: camera.cameraShot,
          cameraMotion: camera.cameraMotion,
        };
        applySplitPieceFields(pieceScene);
        chainShot = camera.cameraShot;
        chainMotion = camera.cameraMotion;
        out.push({
          scene: pieceScene as T,
          ids: chunks[k]!,
          modelSceneIds: [w.modelSceneIds[0]!],
        });
      }
    }
    work.length = 0;
    work.push(...out);
  }

  // 6. Fit the scene-count band: merge the smallest adjacent pair that stays
  // under the cap until the count is inside the band. Merging is fail-closed
  // on markers: a pair may only merge when neither scene is marker-protected
  // (high emphasis / `Pivot:` / `Bookend:`, tier 3); fully unprotected pairs
  // (both tier 0) are preferred over pairs where only an edge position
  // protects a scene. When every fitting pair holds a marker, the scene
  // count stays over the band and the run reports a repairable issue the
  // caller turns into model-retry feedback.
  {
    const maxScenes = options.maxScenes ?? Number.POSITIVE_INFINITY;
    while (work.length > maxScenes) {
      let bestSafeIndex = -1;
      let bestSafeSum = Number.POSITIVE_INFINITY;
      let bestMarkerFreeIndex = -1;
      let bestMarkerFreeSum = Number.POSITIVE_INFINITY;
      let sawFittingPair = false;
      for (let i = 0; i + 1 < work.length; i++) {
        const sum = wordSum([...work[i].ids, ...work[i + 1].ids]);
        if (sum > options.maxSceneWords) continue;
        sawFittingPair = true;
        const scoreA = protectionScore(
          work[i].scene,
          work[i].ids,
          i === 0,
          i === work.length - 1,
        );
        const scoreB = protectionScore(
          work[i + 1].scene,
          work[i + 1].ids,
          i + 1 === 0,
          i + 1 === work.length - 1,
        );
        // A pair may merge only when neither scene is marker-protected.
        if (scoreA < 3 && scoreB < 3 && sum < bestMarkerFreeSum) {
          bestMarkerFreeIndex = i;
          bestMarkerFreeSum = sum;
        }
        if (scoreA === 0 && scoreB === 0 && sum < bestSafeSum) {
          bestSafeIndex = i;
          bestSafeSum = sum;
        }
      }
      const bestIndex =
        bestSafeIndex >= 0 ? bestSafeIndex : bestMarkerFreeIndex;
      if (bestIndex < 0) {
        if (sawFittingPair) {
          issues.push(
            `scene count ${work.length} is above the maximum of ${options.maxScenes} and no unprotected scenes can be merged`,
          );
        }
        break;
      }
      const a = work[bestIndex]!;
      const b = work[bestIndex + 1]!;
      const removedLabel = String(
        (b.scene as { sceneId?: unknown }).sceneId ?? b.modelSceneIds[0],
      );
      const targetLabel = String(
        (a.scene as { sceneId?: unknown }).sceneId ?? a.modelSceneIds[0],
      );
      a.ids = [...a.ids, ...b.ids];
      // The higher protection tier wins; ties go to the earlier scene (a).
      // Scores use the CURRENT unit ids: a and b just merged, so a pivot- or
      // ending-spanning scenario is evaluated on the merged coverage.
      const aScore = protectionScore(
        a.scene,
        a.ids,
        bestIndex === 0,
        bestIndex === work.length - 1,
      );
      const bScore = protectionScore(
        b.scene,
        b.ids,
        bestIndex + 1 === 0,
        bestIndex + 1 === work.length - 1,
      );
      foldSceneInto(a, b, aScore >= bScore ? "target" : "removed");
      work.splice(bestIndex + 1, 1);
      repairRan = true;
      warnings.push(
        `scene count exceeded ${options.maxScenes} — merged scene ${removedLabel} into scene ${targetLabel}`,
      );
    }
  }

  // 7. A declared ending must live inside the final scene.
  function narrationTail(w: Work<T>): string {
    return w.ids
      .map((id) => unitById.get(id)?.text ?? "")
      .join(" ")
      .trim();
  }
  function joinNarration(): string {
    return work
      .flatMap((w) => w.ids)
      .map((id) => unitById.get(id)?.text ?? "")
      .join(" ")
      .trim();
  }

  if (options.endingNarration && work.length > 1) {
    const ending = options.endingNarration;
    // The ScriptQA contract requires the narration itself to end with the
    // declared ending; when it does, walk trailing units into the final scene
    // so the ending is not cut across two scenes.
    if (endsWithTokens(joinNarration(), ending)) {
      let guard = 0;
      while (
        work.length > 1 &&
        !endsWithTokens(narrationTail(work[work.length - 1]), ending) &&
        guard++ < unitCount
      ) {
        const last = work[work.length - 1];
        const prev = work[work.length - 2];
        if (prev.ids.length === 0) {
          issues.push("Could not place the ending inside the final scene");
          break;
        }
        // A tier-3-protected previous scene is never absorbed into the final
        // scene (wholesale or unit-wise): its identity would vanish by
        // construction. A clean run reports a repairable issue so the model
        // regroups; on a recovered payload the absorb is simply skipped —
        // the ending contract is downgraded to a warning at node level, and
        // pushing a hard issue here would discard the only usable storyboard.
        const prevLabel = String(
          (prev.scene as { sceneId?: unknown }).sceneId ??
            prev.modelSceneIds[0],
        );
        const lastLabel = String(
          (last.scene as { sceneId?: unknown }).sceneId ??
            last.modelSceneIds[0],
        );
        const prevScore = protectionScore(
          prev.scene,
          prev.ids,
          prev === work[0],
          false,
        );
        if (prevScore === 3) {
          if (options.recovering) {
            warnings.push(
              `declared ending "${ending}" not absorbed into the final scene: scene ${prevLabel} is protected and cannot be absorbed into scene ${lastLabel}`,
            );
          } else {
            issues.push(
              `declared ending "${ending}" crosses scene ${prevLabel} and scene ${lastLabel}, but scene ${prevLabel} is protected and cannot be absorbed — cannot place the ending inside the final scene`,
            );
          }
          break;
        }
        if (prev.ids.length === 1) {
          // The previous scene becomes empty — merge it wholesale. The final
          // scene always wins the fold: the declared ending runs on the final
          // scene's identity, so the winner is forced regardless of markers or
          // tie preferences.
          last.ids = [...prev.ids, ...last.ids];
          foldSceneInto(last, prev, "target");
          warnings.push(
            `final scene absorbed scene ${String((prev.scene as { sceneId?: unknown }).sceneId ?? prev.modelSceneIds[0])} to keep the declared ending whole`,
          );
          work.splice(work.length - 2, 1);
        } else {
          const moved = prev.ids[prev.ids.length - 1];
          prev.ids.pop();
          last.ids.unshift(moved);
          warnings.push(
            `final scene absorbed unit ${moved} from the previous scene to keep the declared ending whole`,
          );
        }
        repairRan = true;
      }
    }
  }

  // Final validation.
  {
    const flat: number[] = [];
    work.forEach((w) => flat.push(...w.ids));
    const expected = Array.from({ length: unitCount }, (_, k) => k + 1);
    if (flat.length !== unitCount) {
      issues.push(`scenes cover ${flat.length} of ${unitCount} units`);
    } else {
      for (let k = 0; k < flat.length; k++) {
        if (flat[k] !== expected[k]) {
          issues.push(
            `units are not covered exactly once in order (expected unit ${expected[k]} at position ${k + 1}, got ${flat[k]})`,
          );
          break;
        }
      }
    }
    work.forEach((w) => {
      for (let k = 1; k < w.ids.length; k++) {
        if (w.ids[k] !== w.ids[k - 1] + 1) {
          issues.push(
            `scene ${String((w.scene as { sceneId?: unknown }).sceneId ?? w.modelSceneIds[0])} has non-consecutive unit ids [${w.ids.join(", ")}]`,
          );
          break;
        }
      }
      const sum = wordSum(w.ids);
      if (sum > options.maxSceneWords) {
        // Deterministically unfixable: a single oversized unit has no safe
        // clause split to cut at (the builder kept it whole), and a multi-unit
        // overshoot can only come from absorbing the declared ending, which a
        // split would re-break. Both stay visible as warnings, not issues.
        warnings.push(
          `scene ${String((w.scene as { sceneId?: unknown }).sceneId ?? w.modelSceneIds[0])} has ${sum} words, over the ${options.maxSceneWords}-word cap${w.ids.length === 1 ? " (single unit with no safe clause split)" : " (kept whole to hold the declared ending)"}`,
        );
      }
    });
    if (work.length < options.minScenes) {
      issues.push(
        `scene count ${work.length} is below the minimum of ${options.minScenes}`,
      );
    }
    if (options.maxScenes !== null && work.length > options.maxScenes) {
      issues.push(
        `scene count ${work.length} is above the maximum of ${options.maxScenes}`,
      );
    }
  }

  const finalScenes = work.map((w) => ({
    ...w.scene,
    unitIds: w.ids,
    narration: w.ids
      .map((id) => unitById.get(id)?.text ?? "")
      .join(" ")
      .trim(),
    modelSceneIds: [...w.modelSceneIds],
  }));

  return { scenes: finalScenes, issues, warnings, repairRan, unitCount };
}
