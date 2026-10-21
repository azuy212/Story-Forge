import { PipelineError } from "../utils/errors.js";
import {
  REQUIRED_PROMPT_PLACEHOLDERS,
  type StoryStyleProfile,
} from "./style-profile.js";
import type { Character, SceneVisualSlots } from "./types.js";

/** Provider request schema caps the prompt at 4000 characters. */
export const MAX_PROMPT_CHARS = 4000;

export interface ComposedImagePrompt {
  prompt: string;
  /** Character ids actually injected (registry order). */
  characterIds: string[];
}

/**
 * Compose the final image prompt from the style profile template, injecting
 * registry character descriptions VERBATIM (brief section 3: the model never
 * composes or copies the prompt string).
 *
 * A slot that references an unregistered character id is a hard error: that is
 * registry drift, and silently dropping the character would produce a scene
 * that contradicts its narration.
 */
export function composeImagePrompt(options: {
  style: StoryStyleProfile;
  slots: SceneVisualSlots;
  characters: Character[];
}): ComposedImagePrompt {
  const { style, slots, characters } = options;
  const registry = new Map(characters.map((entry) => [entry.id, entry]));

  const characterLines = slots.characters.map((slotCharacter) => {
    const entry = registry.get(slotCharacter.id);
    if (!entry) {
      throw new PipelineError(
        `Scene ${slots.sceneId} references unregistered character "${slotCharacter.id}"`,
        "STORY_CHARACTER_UNKNOWN",
      );
    }
    // Registry text is injected verbatim; only the sentence-final period is
    // normalized so appending "Pose:" never produces "..".
    const description = entry.visualDescription.trim().replace(/\.+$/, "");
    const pose = slotCharacter.pose.trim().replace(/\.+$/, "");
    const expression = slotCharacter.expression.trim().replace(/\.+$/, "");
    return `- ${entry.name}: ${description}. Pose: ${pose}.${
      expression ? ` Expression: ${expression}.` : ""
    }`;
  });

  const props = slots.props.filter((prop) => prop.trim().length > 0);

  const values: Record<(typeof REQUIRED_PROMPT_PLACEHOLDERS)[number], string> =
    {
      action: slots.action.trim(),
      characters: characterLines.join("\n"),
      setting: slots.setting.trim(),
      props: props.length > 0 ? props.join(", ") : "none beyond the setting",
      lighting: slots.lighting.trim(),
      composition: slots.composition.trim(),
    };

  let prompt = style.promptTemplate;
  for (const placeholder of REQUIRED_PROMPT_PLACEHOLDERS) {
    prompt = prompt.replaceAll(`{${placeholder}}`, values[placeholder]);
  }
  prompt = `${prompt.trim()}\n\n${style.aspectInstruction.trim()}`;

  return {
    prompt,
    characterIds: slots.characters.map((entry) => entry.id),
  };
}

export interface PromptLintIssue {
  message: string;
}

const SCRIPT_BY_LANGUAGE: Record<string, string> = {
  ur: "Arabic",
  ar: "Arabic",
  fa: "Arabic",
  sd: "Arabic",
  hi: "Devanagari",
  mr: "Devanagari",
  ne: "Devanagari",
  bn: "Bengali",
  zh: "Han",
  ja: "Han",
  ko: "Hangul",
  ru: "Cyrillic",
  uk: "Cyrillic",
  el: "Greek",
  he: "Hebrew",
  th: "Thai",
};

const scriptRegexCache = new Map<string, RegExp>();

function allowedScriptRegex(language: string): RegExp {
  const primary = language.split("-")[0]?.toLowerCase() ?? "en";
  const script = SCRIPT_BY_LANGUAGE[primary] ?? "Latin";
  let cached = scriptRegexCache.get(script);
  if (!cached) {
    cached = new RegExp(`\\p{Script=${script}}`, "u");
    scriptRegexCache.set(script, cached);
  }
  return cached;
}

/**
 * Requests to DRAW legible writing — the style forbids readable text.
 *
 * This must stay narrow. A story about printing, books or maps legitimately
 * mentions letters, type, pages and Bibles; those nouns are the SUBJECT of the
 * illustration, not a request for legibility. A first version matched the bare
 * nouns and hard-failed a real printing-press job in every scene ("a wooden
 * type frame filled with tiny metal letters"). Only legibility verbs and
 * quoted copy are rejected now; the style profile already instructs the model
 * to render any writing as abstract marks.
 */
const READABLE_TEXT_REQUESTS: RegExp[] = [
  /\b(?:readable|legible|decipherable)\b/iu,
  /\b(?:with|showing|bearing|displaying)\s+the\s+words?\b/iu,
  /\bthe\s+word\s+["“'A-Z]/u,
  /\b(?:text|title|caption|headline|sign|signage|label|lettering)\s+(?:that\s+)?(?:says|reads|spells|stating)\b/iu,
  /\bspell(?:s|ed|ing)?\s+out\b/iu,
  /\b(?:says|reads)\s*[:="“]/iu,
  /\b(?:caption(?:s|ed)?|title)\s*[:=]/iu,
  /\b(?:clearly|sharply|perfectly)\s+(?:visible|printed|rendered)\s+(?:text|words?|letters?)\b/iu,
  /\b(?:title|text|words?|letters?|caption|headline|label)\b[^.]{0,24}\b(?:is|are|be)\s+(?:clearly|sharply|perfectly)\s+(?:visible|legible)\b/iu,
];

/**
 * A negation in the same clause means the slot is *refusing* legibility
 * ("shown as abstract shapes with no readable letters"). The model writes that
 * phrasing on its own, so treating it as a violation punishes correct output.
 */
const NEGATED_READABILITY =
  /\b(?:no|not|never|without|avoid|nothing|free of|instead of)\b[^.;:]{0,40}$/iu;

/**
 * The phrase that actually asks for legible writing, or undefined.
 *
 * Reports the matching phrase rather than the first 60 characters of the slot:
 * a run once failed with a message that quoted only the harmless prefix, which
 * made the real cause invisible.
 */
function readableTextRequest(value: string): string | undefined {
  for (const pattern of READABLE_TEXT_REQUESTS) {
    const global = new RegExp(pattern.source, `${pattern.flags}g`);
    for (const match of value.matchAll(global)) {
      const before = value.slice(0, match.index ?? 0);
      if (NEGATED_READABILITY.test(before)) continue;
      return match[0].trim();
    }
  }
  return undefined;
}
const REPEATED_WORD = /\b([\p{L}][\p{L}'-]*)\s+\1\b/giu;

/**
 * Schema field names glued into free text ("StyleConstraints: clean line art").
 * A real visual-plan response echoed the field list instead of writing prose;
 * the string is not a placeholder and not a repeated word, so it slipped past
 * every other rule and reached the image model as a stray instruction.
 */
const LEAKED_FIELD_NAME =
  /\b(?:StyleConstraints|KeyProps|VisualPurpose|AspectInstruction|ImagePrompt|SceneId|HardWords|ExplanationCues)\b/u;

const UNFILLED_PLACEHOLDER = /\{[^{}]*\}|\[[^[\]]*\]/;

/**
 * Close framing breaks the stick-figure style. At close range the image model
 * draws a detailed face (nose, eyes, shading) and an oversized head, which the
 * 19-scene drift run showed on the four close-up scenes while wide and medium
 * shots stayed on style. The slot vocabulary is restricted to shot sizes that
 * keep the whole figure in frame.
 */
const CLOSE_FRAMING =
  /\b(?:close[ -]?ups?|extreme close|portrait|headshot|head and shoulders|bust shot|faces?|facial)\b/iu;

/**
 * "face to face" and "faces the horizon" are staging, not framing. Strip those
 * idioms before the framing scan so a valid action is not punished for using
 * the word.
 */
const FACE_IDIOM =
  /\bface[sd]?\s+(?:to\s+face|the|towards?|away|him|her|them|each\s+other)\b/giu;

/**
 * A group drawn as a line reads as a copied stamp, not a crowd. The slot
 * planner is told to stagger depth and vary poses; this keeps the old wording
 * from slipping back in.
 */
const CROWD_LINEUP =
  /\b(?:in\s+a\s+(?:straight\s+)?line|lined\s+up|row\s+of)\b/iu;

/**
 * Lint the composed prompt before any image call (brief section 6):
 * script check for the job language, no repeated adjacent words, no unfilled
 * placeholders, every required slot non-empty, registered characters only,
 * no request for readable text, and under the provider length limit.
 */
export function lintImagePrompt(options: {
  prompt: string;
  slots: SceneVisualSlots;
  characters: Character[];
  language: string;
}): PromptLintIssue[] {
  const { prompt, slots, characters, language } = options;
  const issues: PromptLintIssue[] = [];

  const allowed = allowedScriptRegex(language);
  const seenScripts = new Set<string>();
  for (const character of prompt) {
    if (!/\p{L}/u.test(character)) continue;
    if (allowed.test(character)) continue;
    seenScripts.add(character);
  }
  if (seenScripts.size > 0) {
    issues.push({
      message: `prompt contains characters outside the expected script for "${language}": ${[
        ...seenScripts,
      ]
        .slice(0, 8)
        .join(" ")}`,
    });
  }

  for (const match of prompt.matchAll(REPEATED_WORD)) {
    issues.push({
      message: `prompt repeats the adjacent word "${match[1]}"`,
    });
  }

  const unfilled = UNFILLED_PLACEHOLDER.exec(prompt);
  if (unfilled) {
    issues.push({
      message: `prompt has an unfilled placeholder: ${unfilled[0]}`,
    });
  }

  if (!slots.action.trim()) {
    issues.push({ message: "slot action is empty" });
  }
  if (!slots.setting.trim()) {
    issues.push({ message: "slot setting is empty" });
  }
  if (!slots.lighting.trim()) {
    issues.push({ message: "slot lighting is empty" });
  }
  if (!slots.composition.trim()) {
    issues.push({ message: "slot composition is empty" });
  }

  const registry = new Set(characters.map((entry) => entry.id));
  for (const slotCharacter of slots.characters) {
    if (!registry.has(slotCharacter.id)) {
      issues.push({
        message: `slot references unregistered character "${slotCharacter.id}"`,
      });
    }
  }

  // Readable-text requests are checked on the model-authored slots, not on the
  // whole prompt: the style constraints legitimately say "no text, no
  // lettering", which must not read as a request.
  for (const value of [
    slots.action,
    slots.setting,
    ...slots.props,
    slots.composition,
  ]) {
    const request = readableTextRequest(value);
    if (request) {
      issues.push({
        message: `slot asks for readable text ("…${request}…") — maps, signs, and documents must show abstract marks only`,
      });
    }
    const leaked = LEAKED_FIELD_NAME.exec(value);
    if (leaked) {
      issues.push({
        message: `slot contains the schema field name "${leaked[0]}" — write prose, not a field name`,
      });
    }
    const framing = CLOSE_FRAMING.exec(value.replace(FACE_IDIOM, " "));
    if (framing) {
      issues.push({
        message: `slot asks for "${framing[0]}" framing — close, portrait and face shots make the model draw a detailed oversized head; use wide, medium, over-the-shoulder, high-angle or low-angle framing`,
      });
    }
  }

  const groupIds = new Set(
    characters
      .filter((character) => character.kind === "group")
      .map((character) => character.id),
  );
  const hasGroup = slots.characters.some((entry) => groupIds.has(entry.id));
  if (hasGroup) {
    for (const value of [slots.action, slots.composition]) {
      const lineup = CROWD_LINEUP.exec(value);
      if (lineup) {
        issues.push({
          message: `slot arranges a group as "${lineup[0]}" — stagger the members in depth with at least two poses, and face opposing groups toward each other`,
        });
      }
    }
  }

  if (prompt.length > MAX_PROMPT_CHARS) {
    issues.push({
      message: `prompt is ${prompt.length} characters; provider limit is ${MAX_PROMPT_CHARS}`,
    });
  }

  return issues;
}
