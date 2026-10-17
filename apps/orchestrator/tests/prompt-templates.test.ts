import { describe, it, expect } from "@jest/globals";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadPrompt } from "../src/utils/load-prompt.js";
import { renderPrompt } from "../src/utils/render-prompt.js";
import { PromptPaths } from "../src/models/prompt-paths.js";
import { ResearchOutputSchema } from "../src/schemas/research-output.js";
import { ResearchQAOutputSchema } from "../src/schemas/research-qa-output.js";
import { ScriptPlannerOutputSchema } from "../src/schemas/script-planner-output.js";
import { ScriptWriterOutputSchema } from "../src/schemas/script-writer-output.js";
import { ScriptQAOutputSchema } from "../src/schemas/script-qa-output.js";
import { VisualDirectorOutputSchema } from "../src/schemas/visual-director-output.js";
import { ImagePromptOutputSchema } from "../src/schemas/image-prompt-output.js";
import { PromptQAOutputSchema } from "../src/schemas/prompt-qa-output.js";
import { ImagePromptRepairOutputSchema } from "../src/schemas/image-prompt-repair-output.js";
import { ReleaseValidationOutputSchema } from "../src/schemas/release-validation-output.js";
import { ThumbnailOutputSchema } from "../src/schemas/thumbnail-output.js";
import { ThumbnailQaSchema } from "../src/schemas/thumbnail-qa.js";
import { z } from "zod";

/**
 * Contract-level tests for the prompt templates themselves:
 *
 * 1. every template the pipeline loads actually loads and interpolates with
 *    the variables its producing node supplies — no unresolved {{placeholder}}
 *    can reach the LLM;
 * 2. the JSON examples embedded in QA/production prompts parse and validate
 *    against the production Zod schemas, so prompt and code contracts cannot
 *    drift apart silently;
 * 3. the placeholder NAME SET per template is pinned. Renaming or adding an
 *    interpolation token is only safe when coordinated with the node's
 *    render call — this snapshot makes drift a test failure rather than an
 *    empty {{var}} silently hitting the model.
 */

const EDITORIAL_GUIDELINES = "shared/editorial-guidelines.md";

/** The exact placeholder name sets of the current (installed) templates. */
const BASELINE_PLACEHOLDERS: Record<string, string[]> = {
  [PromptPaths.ResearchAgent]: [
    "pillar",
    "previousResearch",
    "qaFeedback",
    "topic",
  ],
  [PromptPaths.ResearchQA]: ["facts", "pillar", "summary", "topic"],
  [PromptPaths.ScriptPlanner]: [
    "approvedFacts",
    "beatCountRange",
    "canvasGuidance",
    "channel",
    "estimatedDurationSeconds",
    "formatLabel",
    "pillar",
    "researchSummary",
    "speakingRateWordsPerSecond",
    "targetDurationSeconds",
    "targetWordRange",
    "topic",
  ],
  [PromptPaths.ScriptWriter]: [
    "audienceTrigger",
    "audienceTriggerFactIds",
    "audienceTriggerStatement",
    "channel",
    "endingType",
    "formatLabel",
    "hook",
    "pivotBeatId",
    "previousScript",
    "qaFeedback",
    "researchFacts",
    "researchSummary",
    "speakingRateWordsPerSecond",
    "storyBeatCount",
    "storyBeats",
    "storySummary",
    "storyType",
    "targetDurationSeconds",
    "targetWordRange",
    "title",
  ],
  [PromptPaths.ScriptQA]: [
    "audienceTrigger",
    "audienceTriggerFactIds",
    "audienceTriggerStatement",
    "beatBoundaries",
    "beatWordCounts",
    "canvasGuidance",
    "complexityReport",
    "contractWarnings",
    "cta",
    "derivedHookSentence",
    "derivedPivotWordPosition",
    "endingType",
    "estimatedDurationSeconds",
    "narration",
    "openLoops",
    "pivotBeatId",
    "pivotFactId",
    "researchFacts",
    "script",
    "speakingRateWordsPerSecond",
    "storyBeats",
    "targetDurationSeconds",
    "targetWordRange",
  ],
  [PromptPaths.VisualDirector]: [
    "approvedFacts",
    "aspectGuidance",
    "audienceTrigger",
    "audienceTriggerFactIds",
    "audienceTriggerStatement",
    "canvasGuidance",
    "channel",
    "endingNarration",
    "endingType",
    "endingVisualDirection",
    "estimatedDurationSeconds",
    "formatLabel",
    "maxSceneWords",
    "narration",
    "pivotBeatId",
    "pivotSentence",
    "previousVisualPlan",
    "qaFeedback",
    "researchSummary",
    "sceneCountRange",
    "speakingRateWordsPerSecond",
    "storyBeats",
    "targetDurationSeconds",
    "targetSceneCount",
    "title",
  ],
  [PromptPaths.ImagePromptGenerator]: [
    "aspectLabel",
    "audienceTrigger",
    "audienceTriggerFactIds",
    "audienceTriggerStatement",
    "canvasGuidance",
    "channel",
    "colorPalette",
    "formatGuidance",
    "logo",
    "pillar",
    "previousPrompts",
    "qaFeedback",
    "scenes",
    "style",
    "topic",
  ],
  [PromptPaths.PromptQA]: [
    "audienceTrigger",
    "audienceTriggerFactIds",
    "audienceTriggerStatement",
    "endingType",
    "formatGuidance",
    "pivotSentence",
    "scenes",
    "storyBeats",
    "visualPlan",
  ],
  [PromptPaths.ImagePromptRepair]: [
    "assetMode",
    "entities",
    "narration",
    "originalPrompt",
    "previousAttempts",
    "providerError",
    "sceneId",
    "sceneType",
    "visualDescription",
    "visualPlan",
  ],
  [PromptPaths.ReleaseReview]: [
    "audienceTrigger",
    "audienceTriggerFactIds",
    "audienceTriggerStatement",
    "channel",
    "formatLabel",
    "hook",
    "metadata",
    "narration",
    "targetDurationSeconds",
    "thumbnailText",
    "title",
  ],
  [PromptPaths.MetadataGenerator]: [
    "audienceTrigger",
    "audienceTriggerFactIds",
    "audienceTriggerStatement",
    "channel",
    "formatLabel",
    "hook",
    "script",
    "title",
  ],
  [PromptPaths.ThumbnailGenerator]: [
    "aspectGuidance",
    "aspectLabel",
    "aspectRatio",
    "audienceTrigger",
    "audienceTriggerFactIds",
    "audienceTriggerStatement",
    "channel",
    "colorPalette",
    "formatLabel",
    "hook",
    "narration",
    "otherAspectRatio",
    "style",
    "thumbnailHeight",
    "thumbnailWidth",
    "title",
  ],
  [PromptPaths.ThumbnailQA]: ["thumbnailText"],
};

/**
 * Realistic-enough render values. Lengths matter for the example-JSON checks:
 * several schemas enforce minimum lengths (e.g. generationPrompt >= 40), so
 * synthetic variables must satisfy them to make the embedded example parse
 * as a valid response once interpolated.
 */
function valueFor(name: string): string {
  const numericish: Record<string, string> = {
    targetDurationSeconds: "88",
    estimatedDurationSeconds: "88",
    targetWordRange: "110-140",
    beatCountRange: "6-10",
    sceneCountRange: "6-8",
    targetSceneCount: "7",
    maxSceneWords: "18",
    speakingRateWordsPerSecond: "2.2",
    pivotBeatId: "3",
    derivedPivotWordPosition: "42",
    storyBeatCount: "6",
    thumbnailWidth: "1080",
    thumbnailHeight: "1920",
    sceneId: "2",
  };
  if (name in numericish) return numericish[name];
  const filler: Record<string, string> = {
    pillar: "science-and-mystery documentary channel pillar",
    channel: "Story Forge",
    topic: "unrecognized countries and the maps that ignore them",
    formatLabel: "vertical",
    formatGuidance:
      "vertical 9:16 canvas with the main subject centered in the top third",
    canvasGuidance:
      "vertical 9:16 canvas, keep the letterbox-free full-bleed composition, safe-area margins of 5 percent on all sides",
    aspectLabel: "9:16 vertical",
    aspectRatio: "9:16",
    aspectGuidance: "the platform never re-crops",
    otherAspectRatio: "16:9",
    colorPalette: "muted documentary palette with a single accent color",
    style: "photorealistic documentary style",
    logo: "Story Forge wordmark, drawn at the top-right corner of the thumbnail canvas",
    hook: "The 25-foot wave that hit Boston was not actually made of water.",
    title:
      "The 25-foot wave that crashed through Boston was not water at all here is why",
    audienceTrigger: "shock",
    audienceTriggerStatement:
      "The measured pressure is three times what was predicted.",
    audienceTriggerFactIds: "fact-001, fact-003",
    endingType: "unresolved_mystery",
    endingNarration:
      "Remember that wave from Boston, because we still cannot explain it.",
    endingVisualDirection:
      "Hold on the wave photograph while the unresolved implication lands with weight.",
    pivotSentence:
      "The measured pressure is now three times larger than predicted.",
    pivotFactId: "fact-003",
    scenes:
      "Scene 1: giant wave over the harbor; Scene 2: the flooded street view",
    visualPlan:
      "Scene 1: harbor wave, 9:16, dark blue-grey; Scene 2: street flood, same palette",
    storyBeats:
      "Beat 1 hook: the wave question. Beat 2 context. Beat 3 escalation.",
    storyType: "mystery",
    storySummary:
      "The strange wave that flooded Boston and its unexplained cause.",
    researchSummary:
      "Researchers disagree about the pressure behind the flood.",
    approvedFacts:
      "fact-001: The measured pressure is three times what was predicted.\nfact-003: The wave reached four stories of height.",
    researchFacts:
      "fact-001 (confidence: high): The measured pressure is three times what was predicted.\nfact-003 (confidence: medium): The wave reached four stories of height.",
    previousResearch: "No previous research.",
    previousScript: "No previous script.",
    previousPrompts: "No previous prompts.",
    previousVisualPlan: "No previous visual plan.",
    previousAttempts: "No previous attempts.",
    qaFeedback: "Fix the flagged items and preserve everything else.",
    script:
      "A 25-foot wave crashed through Boston. The terrifying part is that it was not water. That wave rolled through the streets seconds later and nobody had time to react.",
    narration:
      "A 25-foot wave crashed through Boston. The terrifying part is that it was not water.",
    storyBeatsRef: "",
    cta: "",
    /**
     * Deterministic script-QA derivation values; scenes and visual plan
     * variables are JSON-shaped for prompts whose examples embed them as
     * payload fragments.
     */
    derivedHookSentence:
      "A 25-foot wave crashed through Boston. The terrifying part is that it was not water.",
    openLoops: "Beat 1 opens loop: Why was the wave not water?",
    beatWordCounts: "Beat 1: 15 words (target 18).",
    beatBoundaries:
      "Beat 1 -> Beat 2: ends 'was not water.' starts 'That wave'.",
    contractWarnings: "",
    complexityReport: "Passed.",
    metadata: "Sample video metadata bundle.",
    thumbnailText: "THE DEADLY WAVE",
    facts:
      "- fact-001 (confidence: high): The pressure was three times higher.",
    summary: "The mysterious Boston wave and its disputed pressure.",
    entities: "the harbor promenade, the wave, the flooded street",
    originalPrompt:
      "A volumetric documentary shot of the harbor wave towering over the flooded promenade, low angle, dramatic backlight, muted documentary palette with a single accent color, vertical 9:16 canvas, full-bleed composition",
    providerError: "The image provider rejected the prompt for safety reasons.",
    visualDescription:
      "The giant wave towering over the harbor promenade seen from the street below",
    sceneType: "landscape",
    assetMode: "generated",
    colorMoodRef: "",
  };
  if (name in filler) return filler[name];
  // Any not-annotated placeholder still gets a long, descriptive value so
  // minimum-length schema checks on rendered examples stay satisfiable.
  return `${name}: a descriptive movable placeholder value long enough to pass generation prompt minimum length checks for pipeline templates.`;
}

function varsFor(names: string[]): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const name of names) vars[name] = valueFor(name);
  return vars;
}

async function readTemplate(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), "prompts", path), "utf-8");
}

function placeholdersIn(text: string): string[] {
  return [...new Set([...text.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))];
}

/**
 * Balanced-brace extractor: every `{\n...}` block that parses as JSON.
 * Single-line fragments (e.g. {"beatId": 1, ...}) are ignored: real response
 * examples are multi-line and multi-field.
 */
function extractJsonExamples(text: string): { json: unknown; raw: string }[] {
  const found: { json: unknown; raw: string }[] = [];
  let index = text.indexOf("{\n");
  while (index !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = index; i < text.length; i++) {
      const ch = text[i];
      if (escaped) {
        escaped = false;
      } else if (inString && ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = !inString;
      } else if (inString) {
        // still inside the string
      } else if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const raw = text.slice(index, i + 1);
          try {
            found.push({ json: JSON.parse(raw), raw });
          } catch {
            // Not JSON (prose fragment); fine.
          }
          break;
        }
      }
    }
    index = text.indexOf("{\n", index + 1);
  }
  return found;
}

interface TemplateCase {
  path: string;
  /** Validate every embedded example block against this schema. */
  schema?: z.ZodSchema<unknown>;
  /**
   * A candidate example must carry at least one of these top-level keys so
   * nested fragments inside the example (e.g. factVerdicts items) are not
   * mistaken for the full response.
   */
  keys?: string[];
  /** Examples annotated as abridged / unreachable never validate directly. */
  skipExampleValidation?: boolean;
}

const TEMPLATE_CASES: TemplateCase[] = [
  { path: PromptPaths.ResearchAgent, skipExampleValidation: true },
  {
    path: PromptPaths.ResearchQA,
    schema: ResearchQAOutputSchema,
    keys: ["status", "factVerdicts"],
  },
  { path: PromptPaths.ScriptPlanner, skipExampleValidation: true },
  { path: PromptPaths.ScriptWriter, skipExampleValidation: true },
  {
    path: PromptPaths.ScriptQA,
    schema: ScriptQAOutputSchema,
    keys: ["status", "feedback"],
  },
  { path: PromptPaths.VisualDirector, skipExampleValidation: true },
  {
    path: PromptPaths.ImagePromptGenerator,
    schema: ImagePromptOutputSchema,
    keys: ["assets"],
  },
  {
    path: PromptPaths.PromptQA,
    schema: PromptQAOutputSchema,
    keys: ["status", "sceneResults"],
  },
  {
    path: PromptPaths.ImagePromptRepair,
    schema: ImagePromptRepairOutputSchema,
    keys: ["repairedPrompt"],
  },
  {
    path: PromptPaths.ReleaseReview,
    schema: ReleaseValidationOutputSchema,
    keys: ["status", "issues"],
  },
  { path: PromptPaths.MetadataGenerator, skipExampleValidation: true },
  {
    path: PromptPaths.ThumbnailGenerator,
    schema: ThumbnailOutputSchema,
    keys: ["thumbnailPrompt", "thumbnailText"],
  },
  {
    path: PromptPaths.ThumbnailQA,
    schema: ThumbnailQaSchema,
    keys: ["status", "issues"],
  },
];

describe("prompt templates", () => {
  it("every pipeline prompt + shared guidelines exists and is nonempty", async () => {
    for (const path of [
      ...TEMPLATE_CASES.map((c) => c.path),
      EDITORIAL_GUIDELINES,
    ]) {
      const content = await loadPrompt(path);
      expect(/\S/.test(content) && content.trim().length > 100).toBe(true);
    }
  });

  describe("placeholder sets are unchanged", () => {
    for (const [path, baseline] of Object.entries(BASELINE_PLACEHOLDERS)) {
      it(`pins the interpolations of prompts/${path}`, async () => {
        const content = await readTemplate(path);
        const current = [...new Set(placeholdersIn(content))].sort();
        const base = [...baseline].sort();
        expect(`${path}: ${current.join(",")}`).toBe(
          `${path}: ${base.join(",")}`,
        );
      });
    }

    it("the shared editorial guidelines declare no placeholders", async () => {
      expect(placeholdersIn(await readTemplate(EDITORIAL_GUIDELINES))).toEqual(
        [],
      );
    });
  });

  describe("templates render with their supplied variables", () => {
    for (const [path, baseline] of Object.entries(BASELINE_PLACEHOLDERS)) {
      it(`interpolates prompts/${path} completely`, async () => {
        const rendered = renderPrompt(
          await readTemplate(path),
          varsFor(baseline),
        );
        const leftover = placeholdersIn(rendered);
        expect(
          leftover.length === 0 ? "none" : `${path}: ${leftover.join(", ")}`,
        ).toBe("none");
      });
    }
  });

  describe("embedded JSON examples match the production schemas", () => {
    it("the shared guidelines document the true classification enums", async () => {
      const guidelines = await readTemplate(EDITORIAL_GUIDELINES);
      // The enum list must not include the historic `unresolved_popular_theory`
      // typo, and the corrective footnote must keep steering collectors right.
      expect(guidelines).toContain(
        'There is no "unresolved_popular_theory" value; use popular_theory.',
      );
      expect(guidelines.match(/unresolved_popular_theory/g)?.length).toBe(1);
    });

    for (const templateCase of TEMPLATE_CASES) {
      if (!templateCase.schema) continue;
      it(`validates every JSON example in prompts/${templateCase.path}`, async () => {
        const rendered = renderPrompt(
          await readTemplate(templateCase.path),
          varsFor(BASELINE_PLACEHOLDERS[templateCase.path]),
        );
        const examples = extractJsonExamples(rendered);
        const shaped = examples.filter(
          ({ json }) =>
            typeof json === "object" &&
            json !== null &&
            templateCase.keys!.some((key) =>
              Object.prototype.hasOwnProperty.call(json, key),
            ),
        );
        expect(
          `${templateCase.path}: found ${shaped.length} example blocks`,
        ).toBe(`${templateCase.path}: found ${shaped.length} example blocks`);
        expect(shaped.length).toBeGreaterThan(0);
        for (const { json, raw } of shaped) {
          const parsed = templateCase.schema!.safeParse(json);
          if (!parsed.success) {
            throw new Error(
              `${templateCase.path} example fails schema:\n${raw.slice(0, 400)}\n` +
                parsed.error.issues
                  .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
                  .join("; "),
            );
          }
        }
      });
    }

    it("metadata-generator's schema block matches the production metadata keys", async () => {
      // The metadata prompt ships a type skeleton, not a filled example, so
      // pin the declared key set to the production schema instead of parsing.
      const metadata = await readTemplate(PromptPaths.MetadataGenerator);
      const schemaStart = metadata.lastIndexOf("Required JSON schema:");
      const block = metadata.slice(schemaStart, schemaStart + 400);
      for (const key of [
        "title",
        "description",
        "tags",
        "hashtags",
        "category",
        "pinnedComment",
      ]) {
        expect(block.includes(`"${key}"`)).toBe(true);
      }
      expect(block).not.toContain("callToAction");
    });

    it("script-writer's ending example parameterizes the plan's ending type", async () => {
      // Regression guard: a hardcoded example ending type invites the writer
      // to contradict the plan's endingType (scripts contract-block on that).
      const writer = await readTemplate(PromptPaths.ScriptWriter);
      expect(writer).toContain('"type": "{{endingType}}"');
      expect(writer).not.toContain('"type": "unresolved_mystery"');
    });

    it("research-qa treats trigger absence as advisory, not a revision", async () => {
      const qa = await readTemplate(PromptPaths.ResearchQA);
      expect(qa).toContain(
        "It must not change status or trigger another QA round",
      );
      expect(qa).toContain(
        "Do NOT use minor_revision for trigger material alone",
      );
    });

    it("prompt-qa's anchor continuity rule survives merges", async () => {
      const qa = await readTemplate(PromptPaths.PromptQA);
      expect(qa).toContain(
        "continuity of subject/mechanism, not pixel-identical framing",
      );
    });

    it("script-qa scope loop checks to the declared ledger", async () => {
      const qa = await readTemplate(PromptPaths.ScriptQA);
      expect(qa).toContain("Do not invent additional loop obligations");
    });

    it("thumbnail text respects the 30-character schema cap", async () => {
      const prompt = await readTemplate(PromptPaths.ThumbnailGenerator);
      expect(prompt).toContain("at most 30 characters");
    });

    it("editorial guidelines keep the trigger duty advisory", async () => {
      const guidelines = await readTemplate(EDITORIAL_GUIDELINES);
      expect(guidelines).toContain("preferred, not mandatory");
      expect(guidelines).not.toMatch(/must activate at least one audience/);
    });
  });
});
