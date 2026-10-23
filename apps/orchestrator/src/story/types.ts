import { z } from "zod";

/**
 * Data contracts for the Story-Forge stickman storytelling pipeline.
 *
 * Design rule (brief section 3): the model owns wording and visual slots, code
 * owns every invariant. Nothing the model returns is ever trusted for
 * narration text, prompt assembly, timing, frame counts, or render arguments —
 * those are all derived here and validated with the schemas below.
 */

// ---------------------------------------------------------------------------
// LLM-facing schemas (S2, S3, S4)
// ---------------------------------------------------------------------------

export const STORY_CLAIM_STATUSES = [
  "established",
  "disputed",
  "legend",
  "fiction",
] as const;

export const StoryClaimSchema = z.object({
  claim: z.string().min(1),
  status: z.enum(STORY_CLAIM_STATUSES),
  /** True when the narration hedges the claim ("People say…", "Some tell…"). */
  hedgeInNarration: z.boolean(),
  /** Derived by code: a claim about what a named person "later" did. */
  needsSource: z.boolean().optional(),
  /** Derived by code: the query a reviewer should search first. */
  searchQuery: z.string().optional(),
});

/**
 * A pronunciation pair: the original spelling that must survive in the script
 * and subtitles, and the respelling the TTS voice should actually say.
 */
export const StoryPronunciationSchema = z.object({
  word: z.string().trim().min(1),
  /** One word; use hyphens for syllables so it stays one spoken token. */
  respelling: z
    .string()
    .trim()
    .min(1)
    .regex(
      /^\S+$/u,
      "respelling must be a single word (use hyphens for syllables)",
    ),
});

export const StoryOutputSchema = z.object({
  title: z.string().min(1),
  story: z.string().min(1),
  // Required, not defaulted: a missing ledger would silently skip claim
  // verification (the whole point of DP3). An explicit `[]` is still allowed.
  claims: z.array(StoryClaimSchema),
  /**
   * Names and foreign words the voice would otherwise mispronounce. TTS input
   * uses the respelling; the script, subtitles and manifest keep the original.
   */
  pronunciations: z.array(StoryPronunciationSchema).default([]),
});

export type StoryOutput = z.infer<typeof StoryOutputSchema>;
export type StoryClaim = z.infer<typeof StoryClaimSchema>;
export type StoryPronunciation = z.infer<typeof StoryPronunciationSchema>;

export const VERIFICATION_ISSUE_KINDS = [
  "unsupported_event",
  "invented_quote",
  "invented_motive",
  "unhedged_disputed_claim",
  "invented_dialogue",
  "other",
] as const;

export const StoryVerificationSchema = z.object({
  issues: z
    .array(
      z.object({
        kind: z.enum(VERIFICATION_ISSUE_KINDS),
        description: z.string().min(1),
        severity: z.enum(["blocking", "advisory"]),
      }),
    )
    .default([]),
});

export type StoryVerification = z.infer<typeof StoryVerificationSchema>;

export const SceneGroupingSchema = z.object({
  scenes: z
    .array(
      z.object({
        sceneId: z.number().int().positive(),
        sentenceIds: z.array(z.string().min(1)).min(1),
        visualPurpose: z.string().min(1),
      }),
    )
    .min(1),
});

export type SceneGrouping = z.infer<typeof SceneGroupingSchema>;

export const CharacterRegistrySchema = z.object({
  /**
   * Registry contract version. v2 adds per-individual item + colour
   * uniqueness; stored v1 registries keep loading with a warning.
   */
  registryVersion: z.literal(2),
  characters: z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .regex(
            /^[a-z][a-z0-9_-]*$/,
            "character id must be a lowercase slug (a-z, 0-9, _, -)",
          ),
        name: z.string().min(1),
        role: z.string().min(1),
        /**
         * `individual` is a person the pictures must follow across scenes;
         * `group` is an anonymous crowd drawn as one collective. The split
         * rule lives in the registry prompt; the lint enforces the cue budget.
         */
        kind: z.enum(["individual", "group"]).default("individual"),
        /**
         * The story's protagonist. At most one entry may be the lead. If the
         * lead's one cue is a hat, it may not name a tricorn, bicorne,
         * three-cornered or pointed shape; a non-hat cue (sash, scarf) and a
         * non-historical hat are allowed.
         */
        lead: z.boolean().optional(),
        visualDescription: z.string().min(1),
      }),
    )
    .default([]),
});

export type CharacterRegistry = z.infer<typeof CharacterRegistrySchema>;
export type Character = CharacterRegistry["characters"][number];

/**
 * A required prompt slot: whitespace-only strings are rejected at the schema
 * layer so the agent harness retries with a clear message, instead of a
 * degenerate "Lighting: " line reaching the image provider.
 */
function requiredText() {
  return z.string().trim().min(1);
}

/** A scene that names more than four characters reads as a crowd, not a beat. */
export const SCENE_MAX_CHARACTERS = 4;

/**
 * A scene character is either a registry reference (`id`) or an anonymous
 * group described inline by exactly one silhouette `cue`. The anonymous form
 * exists so unrelated people never have to borrow a registered group's id;
 * `lintImagePrompt` and the slots prompt both enforce the distinction.
 */
export const SceneCharacterSchema = z
  .object({
    id: z.string().min(1).optional(),
    /** One silhouette cue for an anonymous group (no registry id). */
    cue: z.string().trim().min(1).optional(),
    pose: requiredText(),
    expression: requiredText(),
  })
  .refine(
    (entry) => (entry.id === undefined) !== (entry.cue === undefined),
    "a scene character needs exactly one of id (registry) or cue (anonymous group)",
  );

export const SceneVisualSlotsSchema = z.object({
  sceneId: z.number().int().positive(),
  action: requiredText(),
  characters: z
    .array(SceneCharacterSchema)
    .max(
      SCENE_MAX_CHARACTERS,
      `a scene may name at most ${SCENE_MAX_CHARACTERS} characters`,
    )
    .default([]),
  setting: requiredText(),
  props: z.array(z.string()).default([]),
  lighting: requiredText(),
  composition: requiredText(),
  /** True when the scene is drawn as a metaphor for an abstract idea. */
  metaphor: z.boolean().default(false),
});

export type SceneVisualSlots = z.infer<typeof SceneVisualSlotsSchema>;

// ---------------------------------------------------------------------------
// Internal derived types
// ---------------------------------------------------------------------------

export interface Sentence {
  /** Stable id assigned by code: s1..sN. */
  id: string;
  text: string;
  wordCount: number;
}

export type SceneStageStatus = "pending" | "done" | "failed";

export interface SceneStatus {
  prompt: SceneStageStatus;
  image: SceneStageStatus;
  audio: SceneStageStatus;
  transcript: SceneStageStatus;
  timing: SceneStageStatus;
}

export interface SceneImageRecord {
  path: string;
  /** Absolute or job-relative source path recorded at generation time. */
  prompt: string;
  /** Set when a refusal triggered the single logged softening retry. */
  softenedFrom?: string;
  provider: string;
  model?: string;
  attempts: number;
  promptHash: string;
  referenceImage?: string;
  byteSize: number;
  /** Dimensions actually returned by the provider (DP4: keep source size). */
  width: number;
  height: number;
  aspect: number;
  /** Mean/variance of the decoded luminance, for blank detection. */
  luminanceVariance: number;
  generatedAt: string;
}

export interface SceneAudioPieceRecord {
  path: string;
  durationSec: number;
  text: string;
  /** Provider identity: a change invalidates the piece on resume. */
  providerFingerprint: string;
}

export interface SceneAudioChunkRecord {
  path: string;
  durationSec: number;
  /** Character budget pieces when the narration exceeded STORY_TTS_MAX_CHARS. */
  pieces: SceneAudioPieceRecord[];
  meanVolumeDb?: number;
  wordsPerMinute?: number;
  /**
   * Fraction of script words a free (unconstrained) ASR pass heard, 0..1.
   * Absent when verification is disabled or the chunk predates the check.
   */
  asrCoverage?: number;
  /** Script words the free ASR pass did not hear (first few, for the log). */
  asrMissing?: string[];
  /** Set when low coverage triggered the single automatic re-synthesis. */
  resynthesized?: boolean;
  /** True once the free-ASR check ran; stops resume from re-checking forever. */
  asrChecked?: boolean;
  /** Silence-driven re-syntheses performed in S6 (max 2). */
  silenceRetakes?: number;
  /** Total leading/trailing silence trimmed from the chunk edge, in seconds. */
  edgeTrimmedSec?: number;
  /** Longest internal pause observed during the S6 check, in seconds. */
  maxInternalSilenceSec?: number;
  /**
   * Internal pauses still over 1.0 s after the retake limit, shortened to
   * 0.6 s before the chunk duration is measured. Recorded for the manifest.
   */
  shortenedPauses?: ScenePauseShortening[];
}

export interface ScenePauseShortening {
  /** Pause position in the chunk, in seconds (before shortening). */
  startSec: number;
  /** Measured pause length before shortening. */
  originalSec: number;
  /** Pause length kept after shortening. */
  shortenedSec: number;
}

export interface SceneTiming {
  start: number;
  end: number;
  startFrame: number;
  endFrame: number;
  /** "measured" — from real ffprobe chunk durations, never guessed. */
  method: "measured";
}

export interface SceneWordTimestamp {
  word: string;
  start: number;
  end: number;
}

export interface SceneTranscript {
  matchRatio: number;
  method: "aligned" | "proportional";
  words: SceneWordTimestamp[];
}

export interface StoryScene {
  sceneId: number;
  sentenceIds: string[];
  narration: string;
  wordCount: number;
  visualPurpose: string;
  slots?: SceneVisualSlots;
  imagePrompt?: string;
  /** Fingerprint of the inputs the prompt was composed from (resume check). */
  promptFingerprint?: string;
  imagePromptWarnings: string[];
  image?: SceneImageRecord;
  audio?: SceneAudioChunkRecord;
  transcript?: SceneTranscript;
  timing?: SceneTiming;
  status: SceneStatus;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Job input / resolved configuration
// ---------------------------------------------------------------------------

export interface StoryJobInput {
  topic: string;
  targetDurationSec: number;
  language: string;
  tone?: string;
  style: string;
  jobId: string;
  outputDir?: string;
}

export interface ResolvedStoryConfig extends StoryJobInput {
  wpm: number;
  imageConcurrency: number;
  sceneMinSec: number;
  sceneTargetMinSec: number;
  sceneTargetMaxSec: number;
  sceneSoftMaxSec: number;
  width: number;
  height: number;
  fps: number;
  sceneGapMs: number;
  imageMinWidth: number;
  imageMinHeight: number;
  imageMinAspect: number;
  imageMaxAspect: number;
  ttsMaxChars: number;
  /** Free ASR verification of each narration chunk (advisory). */
  asrVerify: boolean;
  subtitleMaxCharsPerLine: number;
  subtitleMinDurationMs: number;
  crf: number;
  preset: string;
}

export const STORY_STAGES = [
  "S1_input",
  "S2_story",
  "S3_scenes",
  "S4_visual_plan",
  "S5_images",
  "S6_audio",
  "S7_align",
  "S8_render",
] as const;

export type StoryStage = (typeof STORY_STAGES)[number];

export interface StageRecord {
  status: "pending" | "running" | "done" | "failed" | "skipped";
  fingerprint?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
  warnings?: string[];
  metrics?: Record<string, unknown>;
  telemetry?: {
    model?: string;
    totalTokens?: number;
    retries?: number;
    fromCache?: boolean;
  };
}

export interface StoryLintSummary {
  passed: boolean;
  attempts: number;
  sentenceCount: number;
  wordCount: number;
  averageSentenceWords: number;
  maximumSentenceWords: number;
  readingGrade: number;
  wordBudgetTarget: number;
  wordBudgetVariance: number;
  issues: string[];
  warnings: string[];
}

export interface StoryVerificationSummary {
  attempts: number;
  issues: { kind: string; description: string; severity: string }[];
  blocking: string[];
  notes: string[];
}

export interface FfprobeSummary {
  width: number;
  height: number;
  fps: number;
  duration: number;
  videoCodec?: string;
  audioCodec?: string;
  pixFmt?: string;
}

/**
 * `gate` checks decide whether a job may be marked complete. `warning` checks
 * are recorded and surfaced in `manifest.warnings` but do not fail the render.
 *
 * Only the frame-vs-source comparison is a warning: real stickman scenes share
 * a palette and line weight, so its correlation margin still needs tuning on
 * real Gemini images. A false failure must never throw away a good render.
 */
export type ValidationSeverity = "gate" | "warning";

export interface RenderValidationCheck {
  name: string;
  passed: boolean;
  detail: string;
  severity: ValidationSeverity;
}

export interface RenderValidationReport {
  passed: boolean;
  checks: RenderValidationCheck[];
}

export interface StoryManifest {
  version: 1;
  jobId: string;
  createdAt: string;
  updatedAt: string;
  input: StoryJobInput;
  config: ResolvedStoryConfig;
  stages: Partial<Record<StoryStage, StageRecord>>;
  story?: {
    title: string;
    story: string;
    wordCount: number;
    lint: StoryLintSummary;
  };
  claims?: StoryClaim[];
  /** TTS respellings; the script and subtitles keep the original spelling. */
  pronunciations?: StoryPronunciation[];
  verification?: StoryVerificationSummary;
  groundingSource: "model-knowledge";
  /** DP3: every claim is model knowledge, so nothing here is verified. */
  unverified: boolean;
  characters?: Character[];
  scenes: StoryScene[];
  audio?: {
    masterPath: string;
    durationSec: number;
    gapMs: number;
    sampleRate: number;
  };
  transcriptPath?: string;
  subtitles?: {
    ass: string;
    srt: string;
    cueCount: number;
    overallMatchRatio: number;
  };
  render?: {
    finalVideo: string;
    ffprobe: FfprobeSummary;
    validations: RenderValidationReport;
  };
  warnings: string[];
  errors: string[];
}
