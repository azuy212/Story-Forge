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
  /**
   * The story topic. A hard word the topic names ("mutiny" for "The mutiny on
   * the Bounty") must appear in the story AND be explained by its sentence; a
   * draft cannot dodge the topic's own vocabulary by only writing
   * "mutineers".
   */
  topic?: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match a hard word and its ordinary inflections. A topic such as "the mutiny
 * on the Bounty" is told through "mutineers", and "navigator" through
 * "navigators"; an exact `\bmutiny\b` check let both slip past the reading
 * gate. The suffix families stay tied to the word's own stem, so "mutiny"
 * never matches "mutation" and "navigator" never matches "navigable".
 */
export function hardWordPattern(hardWord: string): RegExp {
  const word = hardWord.trim().toLowerCase();
  let stem = word;
  let suffixes: string;
  if (/[^aeiou]y$/.test(word)) {
    // mutiny → mutin-: mutiny, mutinies, mutinied, mutineer(s), mutinous.
    stem = word.slice(0, -1);
    suffixes = "(?:y|ies|ied|ier|iers|eer|eers|eering|ous|ously|ousness)?";
  } else if (word.endsWith("e")) {
    // organise → organis-: organise, organised, organising, organisation.
    stem = word.slice(0, -1);
    suffixes = "(?:e|es|ed|ing|er|ers|ion|ions|ive|ively)?";
  } else if (/(?:or|er)$/.test(word)) {
    // navigator → navigator(s), sailor → sailor(s).
    suffixes = "(?:s|'s)?";
  } else {
    suffixes = "(?:s|es|ed|ing|er|ers)?";
  }
  return new RegExp(`\\b${escapeRegExp(stem)}${suffixes}\\b`, "i");
}

/** Hard words whose stem the topic itself names. */
export function topicHardWords(topic: string, hardWords: string[]): string[] {
  if (!topic.trim()) return [];
  return hardWords.filter((hardWord) => hardWordPattern(hardWord).test(topic));
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
  options: { requiredWords?: string[] } = {},
): string[] {
  if (hardWords.length === 0) return [];
  const cues = compileCues(explanationCues);
  const sentences = splitSentences(story);
  const required = new Set(
    (options.requiredWords ?? []).map((word) => word.toLowerCase()),
  );
  const issues: string[] = [];

  for (const hardWord of hardWords) {
    const wordRe = hardWordPattern(hardWord);
    const sentence = sentences.find((entry) => wordRe.test(entry));
    const isRequired = required.has(hardWord.toLowerCase());
    if (!sentence) {
      if (isRequired) {
        issues.push(
          `Hard word "${hardWord}" is the story's topic word but the story never uses it; name it once and explain it in the same sentence`,
        );
      }
      continue;
    }
    if (cues.some((cue) => cue.test(sentence))) continue;
    const usedAs = wordRe.exec(sentence)?.[0];
    const form =
      usedAs && usedAs.toLowerCase() !== hardWord.toLowerCase()
        ? ` (used as "${usedAs}")`
        : "";
    issues.push(
      `Hard word "${hardWord}"${form} is used without an in-sentence explanation: "${sentence.slice(0, 90)}"`,
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
    ...findHardWordIssues(story, options.hardWords, options.explanationCues, {
      requiredWords: topicHardWords(options.topic ?? "", options.hardWords),
    }),
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
/** Five distinct silhouettes is the most a viewer can carry across scenes. */
export const CHARACTER_MAX_INDIVIDUALS = 5;

/**
 * The lead's one cue is the story's visual identifier. A hat cue must not drift
 * into a tricorn/bicorne/three-cornered/pointed silhouette, but a lead may carry
 * a non-hat cue, and a non-historical lead may wear a non-flat hat. The lint
 * therefore rejects those shapes only when the lead's cue is a hat.
 */
const NON_FLAT_HAT =
  /\b(?:tricorn(?:e)?|bicorn(?:e)?|three[- ]cornered|pointed)\b/iu;
const NEGATED_HAT = /\b(?:no|not|without|never|avoid)\b[^.;:]{0,24}$/iu;

/** A named non-flat hat, unless the description explicitly rules it out. */
function nonFlatHatName(description: string): string | undefined {
  const match = NON_FLAT_HAT.exec(description);
  if (!match) return undefined;
  const before = description.slice(0, match.index);
  return NEGATED_HAT.test(before) ? undefined : match[0];
}

const COSTUME_CUE =
  /\b(hat|cap|hood|helmet|coat|cloak|cape|doublet|tunic|shirt|blouse|robe|dress|gown|skirt|breeches|trousers|pants|hose|stockings|boots|shoes|sandals|sash|belt|bandana|scarf|gloves|armour|armor|armband|necklace|crown|veil|apron|uniform|jacket|vest|waistcoat|kilt|poncho|headband|earring|beard|moustache|mustache|eyepatch|scar|tattoo|braid|topknot)s?\b/gi;

const COLOUR_CUE =
  /\b(black|white|red|crimson|blue|navy|green|olive|yellow|gold|orange|purple|pink|brown|tan|beige|grey|gray|silver|teal)\b/gi;

/**
 * Neutral colours disappear against the pale paper background and the white
 * round heads, so a group drawn in one reads as a shapeless smear rather than
 * a body. Groups need a saturated base colour that stays distinct from every
 * individual's.
 */
export const NEUTRAL_GROUP_COLOURS = new Set(["grey", "white", "beige"]);

/** Distinct basic colours named in a description (gray folds into grey). */
export function characterColours(description: string): string[] {
  const seen = new Set<string>();
  for (const match of description.matchAll(COLOUR_CUE)) {
    const colour = match[1].toLowerCase();
    seen.add(colour === "gray" ? "grey" : colour);
  }
  return [...seen];
}

/** Distinct clothing or silhouette cues named in a description. */
export function characterCues(description: string): string[] {
  const seen = new Set<string>();
  for (const match of description.matchAll(COSTUME_CUE)) {
    const word = match[1].toLowerCase();
    seen.add(word);
  }
  return [...seen];
}

/**
 * A registry entry describes a body, not a moment. A place or an action in
 * `visualDescription` is pasted into every scene the character appears in, so
 * "on a deck" puts them on a deck in the palace, and "holding a chart" gives
 * them the chart in scenes where the narration needs their hands empty.
 */
const PLACE_NOUN =
  "deck|ship|boat|cabin|room|hall|palace|throne|table|beach|shore|island|sea|ocean|forest|jungle|village|town|city|street|market|harbou?r|port|tent|cave|mountain|river|field|rail|mast|wheel|door|window|stairs|steps";
const LOCATION_PHRASE = new RegExp(
  `\\b(?:on|in|at|aboard|beside|near|behind|under|inside|outside|by|through|across)\\s+(?:the|a|an)\\s+(?:[a-z-]+\\s+){0,2}(?:${PLACE_NOUN})\\b`,
  "i",
);
const ACTION_VERB =
  /\b(standing|stands|sitting|sits|walking|walks|holding|holds|carrying|carries|pointing|points|writing|writes|reading|reads|rowing|rows|waving|waves|fighting|fights|kneeling|kneels|lying|lies|looking|looks|gazing|gazes|watching|watches|raising|raised|gripping|grips|leaning|leans)\b/i;

/** Staging words that belong in the scene slots, not in a reusable registry. */
export function characterStagingIssues(description: string): string[] {
  const issues: string[] = [];
  const location = description.match(LOCATION_PHRASE);
  if (location) issues.push(`names a place ("${location[0]}")`);
  const action = description.match(ACTION_VERB);
  if (action) issues.push(`names an action ("${action[0]}")`);
  return issues;
}

/**
 * Gate the character registry before it is injected verbatim into every scene
 * prompt. Returns one message per offending character, plus one per duplicated
 * cue.
 *
 * - an individual carries exactly one cue and (v2) exactly one colour,
 *   because that is what makes them recognisable as the same person in the
 *   next scene, including the story's lead; at most one entry may be the lead,
 *   and if that lead's cue is a hat it may not name a tricorn, bicorne,
 *   three-cornered or pointed shape;
 * - individuals share neither item nor colour;
 * - a group may carry none (an anonymous crowd) or up to the shared limit,
 *   but may not reuse an individual's cue;
 * - two individuals, or two groups, may not share a cue.
 *
 * Stored v1 registries (no version) skip the colour and cross-kind rules so a
 * resume keeps working; new registries are planned as v2.
 */
export function lintCharacterRegistry(
  characters: {
    id: string;
    kind?: "individual" | "group";
    lead?: boolean;
    visualDescription: string;
  }[],
  options: { version?: number } = {},
): string[] {
  const version = options.version ?? 1;
  const issues: string[] = [];
  const cueOwners = new Map<
    string,
    { id: string; kind: "individual" | "group" }[]
  >();
  const colourOwners = new Map<string, string[]>();
  const groupColourOwners = new Map<string, string[]>();
  const individuals = characters.filter(
    (character) => (character.kind ?? "individual") === "individual",
  );
  if (individuals.length > CHARACTER_MAX_INDIVIDUALS) {
    issues.push(
      `${individuals.length} individuals (max ${CHARACTER_MAX_INDIVIDUALS}); fold the least important ones into a group`,
    );
  }
  const leads = characters.filter((character) => character.lead === true);
  if (leads.length > 1) {
    issues.push(
      `${leads.length} leads (${leads.map((lead) => lead.id).join(", ")}); a registry may mark at most one lead`,
    );
  }
  for (const lead of leads) {
    if ((lead.kind ?? "individual") !== "individual") {
      issues.push(
        `character "${lead.id}" is marked lead but is a group; only an individual can be the lead`,
      );
      continue;
    }
    const description = lead.visualDescription.trim();
    const cues = characterCues(description);
    const hatCue = cues.some((cue) => cue === "hat" || cue === "cap");
    const nonFlatHat = hatCue ? nonFlatHatName(description) : undefined;
    if (nonFlatHat) {
      issues.push(
        `character "${lead.id}" is the lead but its hat names "${nonFlatHat}"; no tricorn, no three-cornered or pointed hat`,
      );
    }
  }

  for (const character of characters) {
    const kind = character.kind ?? "individual";
    const description = character.visualDescription.trim();
    const words = countWords(description);
    const cues = characterCues(description);
    const problems: string[] = [];
    const staging = characterStagingIssues(description);
    if (staging.length > 0) problems.push(...staging);
    if (words > CHARACTER_MAX_WORDS) {
      problems.push(`${words} words (max ${CHARACTER_MAX_WORDS})`);
    }
    if (kind === "individual" && cues.length !== 1) {
      problems.push(
        cues.length === 0
          ? "no silhouette cue (an individual needs exactly one)"
          : `${cues.length} cues (${cues.join(", ")}; an individual needs exactly one)`,
      );
    }
    if (kind === "group" && cues.length > CHARACTER_MAX_CUES) {
      problems.push(
        `${cues.length} cues (${cues.join(", ")}; a group may name ${CHARACTER_MAX_CUES})`,
      );
    }
    if (version >= 2) {
      const colours = characterColours(description);
      if (colours.length !== 1) {
        problems.push(
          colours.length === 0
            ? `no base colour (a v2 ${kind} needs exactly one)`
            : `${colours.length} colours (${colours.join(", ")}; a v2 ${kind} needs exactly one)`,
        );
      }
      if (kind === "group") {
        for (const colour of colours) {
          if (NEUTRAL_GROUP_COLOURS.has(colour)) {
            problems.push(
              `uses the neutral colour "${colour}"; grey, white and beige bleed into the figure bodies — give a group a distinct saturated colour`,
            );
          }
        }
      }
      const owners = kind === "individual" ? colourOwners : groupColourOwners;
      for (const colour of colours) {
        const ids = owners.get(colour) ?? [];
        ids.push(character.id);
        owners.set(colour, ids);
      }
    }
    if (problems.length > 0) {
      issues.push(`character "${character.id}": ${problems.join("; ")}`);
    }
    for (const cue of cues) {
      const owners = cueOwners.get(cue) ?? [];
      owners.push({ id: character.id, kind });
      cueOwners.set(cue, owners);
    }
  }

  for (const [cue, owners] of cueOwners) {
    for (let left = 0; left < owners.length; left += 1) {
      for (let right = left + 1; right < owners.length; right += 1) {
        const first = owners[left];
        const second = owners[right];
        if (first.kind !== second.kind) {
          if (version < 2) continue;
          issues.push(
            `characters "${first.id}" and "${second.id}" share the cue "${cue}"; a group may not reuse an individual's cue`,
          );
          continue;
        }
        issues.push(
          `characters "${first.id}" and "${second.id}" share the cue "${cue}"; ` +
            (first.kind === "individual"
              ? "each individual needs a distinct cue"
              : "each group needs a distinct cue"),
        );
      }
    }
  }

  for (const [colour, ids] of colourOwners) {
    if (ids.length > 1) {
      issues.push(
        `individuals ${ids.map((id) => `"${id}"`).join(" and ")} share the colour "${colour}"; each individual needs a distinct colour`,
      );
    }
  }
  for (const [colour, ids] of groupColourOwners) {
    if (ids.length > 1) {
      issues.push(
        `groups ${ids.map((id) => `"${id}"`).join(" and ")} share the colour "${colour}"; each group needs a distinct base colour`,
      );
    }
    const individuals = colourOwners.get(colour);
    if (individuals && individuals.length > 0) {
      issues.push(
        `group ${ids.map((id) => `"${id}"`).join(" and ")} shares the colour "${colour}" with individual ${individuals.map((id) => `"${id}"`).join(" and ")}; a group's base colour must differ from every individual's colour`,
      );
    }
  }

  return issues;
}
