import {
  validateScriptComplexity,
  type ScriptComplexityThresholds,
} from "../utils/script-complexity.js";
import { countWords, splitSentences } from "./sentences.js";

/**
 * Measurable reading-level lint for the story pipeline (brief S2).
 *
 * The shared `validateScriptComplexity` provides sentence length, average
 * sentence length, language, and reading-grade checks. Story mode adds the two
 * requirements it does not cover:
 *   - a hard-word list, allowed only with an in-sentence explanation;
 *   - the ±15% word budget around `targetDurationSec × wpm / 60`.
 */
export const STORY_COMPLEXITY_THRESHOLDS: ScriptComplexityThresholds = {
  maxAverageSentenceWords: 12,
  maxSentenceWords: 22,
  // Warning only — the brief makes reading grade advisory for story mode.
  maxReadingGrade: 4,
  targetSentenceMinWords: 6,
  targetSentenceMaxWords: 14,
};

export const WORD_BUDGET_TOLERANCE = 0.15;

/**
 * The measurable limits stated to the writer *before* it writes.
 *
 * These are the same numbers the linter enforces; keeping one helper means the
 * prompt can never drift from the gate. A real first draft averaged 15.3 words
 * per sentence because the limits only reached the model as rewrite feedback.
 */
export interface StoryStyleLimits {
  averageSentenceWords: number;
  maxSentenceWords: number;
  minWords: number;
  maxWords: number;
}

export function storyStyleLimits(wordBudget: number): StoryStyleLimits {
  const tolerance = Math.round(wordBudget * WORD_BUDGET_TOLERANCE);
  return {
    averageSentenceWords: STORY_COMPLEXITY_THRESHOLDS.maxAverageSentenceWords,
    maxSentenceWords: STORY_COMPLEXITY_THRESHOLDS.maxSentenceWords,
    minWords: wordBudget - tolerance,
    maxWords: wordBudget + tolerance,
  };
}

/** Fallback explanation cues when a style profile supplies none. */
const DEFAULT_EXPLANATION_CUES = [
  "\\bmeans\\b",
  "\\bwhich (?:is|was|means)\\b",
  "\\bis (?:a|an|the)\\b",
  "\\bare (?:a|an|the)\\b",
  "\\bcalled\\b",
  "\\bknown as\\b",
  "\\ba kind of\\b",
  "\\ba type of\\b",
  "\\bsomeone who\\b",
  "\\ba person who\\b",
  "\\bpeople who\\b",
  "\\bin other words\\b",
  "\\bthat is\\b",
  "\\bfor example\\b",
  "\\bsuch as\\b",
  "\\blike a\\b",
  "\\bmade of\\b",
  "\\bused to\\b",
];

export interface StoryLintReport {
  passed: boolean;
  issues: string[];
  warnings: string[];
  sentenceCount: number;
  wordCount: number;
  averageSentenceWords: number;
  maximumSentenceWords: number;
  readingGrade: number;
  wordBudgetTarget: number;
  wordBudgetVariance: number;
}

export interface StoryLintOptions {
  wpm: number;
  targetDurationSec: number;
  hardWords: string[];
  explanationCues: string[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileCues(sources: string[]): RegExp[] {
  const effective = sources.length > 0 ? sources : DEFAULT_EXPLANATION_CUES;
  const compiled: RegExp[] = [];
  for (const source of effective) {
    try {
      compiled.push(new RegExp(source, "i"));
    } catch {
      // An invalid cue in a style profile is ignored rather than failing the
      // job; the word simply needs a clearer explanation.
    }
  }
  return compiled;
}

/**
 * A hard word is acceptable when the sentence that contains it also explains
 * it ("mutiny, which means the sailors took over the ship").
 */
export function findHardWordIssues(
  story: string,
  hardWords: string[],
  explanationCues: string[],
): string[] {
  if (hardWords.length === 0) return [];
  const cues = compileCues(explanationCues);
  const sentences = splitSentences(story);
  const issues: string[] = [];

  for (const hardWord of hardWords) {
    const wordRe = new RegExp(`\\b${escapeRegExp(hardWord)}\\b`, "i");
    const sentence = sentences.find((entry) => wordRe.test(entry));
    if (!sentence) continue;
    if (cues.some((cue) => cue.test(sentence))) continue;
    issues.push(
      `Hard word "${hardWord}" is used without an in-sentence explanation: "${sentence.slice(0, 90)}"`,
    );
  }
  return issues;
}

export function lintStory(
  story: string,
  options: StoryLintOptions,
  thresholds: ScriptComplexityThresholds = STORY_COMPLEXITY_THRESHOLDS,
): StoryLintReport {
  const complexity = validateScriptComplexity(story, thresholds);
  const issues = complexity.issues.map((issue) => issue.message);
  const warnings = complexity.warnings.map((warning) =>
    warning.replace(
      "target range is grade 6-8",
      `target is grade ${thresholds.maxReadingGrade} or lower`,
    ),
  );

  issues.push(
    ...findHardWordIssues(story, options.hardWords, options.explanationCues),
  );

  const wordCount = countWords(story);
  const wordBudgetTarget = Math.round(
    (options.targetDurationSec * options.wpm) / 60,
  );
  const wordBudgetVariance =
    wordBudgetTarget > 0
      ? (wordCount - wordBudgetTarget) / wordBudgetTarget
      : 0;

  if (
    wordBudgetTarget > 0 &&
    Math.abs(wordBudgetVariance) > WORD_BUDGET_TOLERANCE
  ) {
    const direction = wordBudgetVariance > 0 ? "over" : "under";
    issues.push(
      `Story is ${wordCount} words; the ${options.targetDurationSec}s budget at ${options.wpm} wpm is ${wordBudgetTarget} words (${Math.round(
        Math.abs(wordBudgetVariance) * 100,
      )}% ${direction}, tolerance ±${Math.round(WORD_BUDGET_TOLERANCE * 100)}%).`,
    );
  }

  return {
    passed: issues.length === 0,
    issues,
    warnings,
    sentenceCount: complexity.sentenceCount,
    wordCount,
    averageSentenceWords: complexity.averageSentenceWords,
    maximumSentenceWords: complexity.maximumSentenceWords,
    readingGrade: complexity.readingGrade,
    wordBudgetTarget,
    wordBudgetVariance: Math.round(wordBudgetVariance * 1000) / 1000,
  };
}

/** Human-readable violation list used as rewrite feedback. */
export function formatLintViolations(report: StoryLintReport): string {
  return report.issues.map((issue) => `- ${issue}`).join("\n");
}

// ---------------------------------------------------------------------------
// Character registry lint (S4)
// ---------------------------------------------------------------------------

/**
 * One silhouette cue per character is what keeps a stick figure recognisable
 * at 1080p; a costume list is what makes the image model draw a costume.
 * The style preamble loses that argument on its own, so the registry is gated.
 */
export const CHARACTER_MAX_WORDS = 16;
export const CHARACTER_MAX_CUES = 2;

const COSTUME_CUE =
  /\b(hat|cap|hood|helmet|coat|cloak|cape|doublet|tunic|shirt|blouse|robe|dress|gown|skirt|breeches|trousers|pants|hose|stockings|boots|shoes|sandals|sash|belt|bandana|scarf|gloves|armour|armor|armband|necklace|crown|veil|apron|uniform|jacket|vest|waistcoat|kilt|poncho|headband|earring)s?\b/gi;

/** Distinct clothing cues named in a description, lowercased and singular. */
export function characterCues(description: string): string[] {
  const seen = new Set<string>();
  for (const match of description.matchAll(COSTUME_CUE)) {
    const word = match[1].toLowerCase();
    seen.add(word);
  }
  return [...seen];
}

/**
 * Gate the character registry before it is injected verbatim into every scene
 * prompt. Returns one message per offending character.
 */
export function lintCharacterRegistry(
  characters: { id: string; visualDescription: string }[],
): string[] {
  const issues: string[] = [];
  for (const character of characters) {
    const description = character.visualDescription.trim();
    const words = countWords(description);
    const cues = characterCues(description);
    const problems: string[] = [];
    if (words > CHARACTER_MAX_WORDS) {
      problems.push(`${words} words (max ${CHARACTER_MAX_WORDS})`);
    }
    if (cues.length > CHARACTER_MAX_CUES) {
      problems.push(
        `${cues.length} clothing cues (${cues.join(", ")}; max ${CHARACTER_MAX_CUES})`,
      );
    }
    if (problems.length > 0) {
      issues.push(`character "${character.id}": ${problems.join("; ")}`);
    }
  }
  return issues;
}
