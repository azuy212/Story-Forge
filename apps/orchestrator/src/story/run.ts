import { createInterface } from "node:readline";
import { resolve } from "node:path";
import { hashObject } from "../artifacts/hash.js";
import { config as appConfig } from "../utils/config.js";
import { PipelineError } from "../utils/errors.js";
import { logger } from "../utils/logger.js";
import type { AgentInject } from "../agents/run-agent.js";
import {
  createDefaultAssetProvider,
  type AssetProvider,
} from "../providers/asset-provider.js";
import { ChatterboxTTSProvider } from "../providers/chatterbox-tts-provider.js";
import type { TTSProvider } from "../providers/tts-provider.js";
import {
  HttpWhisperXProvider,
  type WhisperXProvider,
} from "../providers/whisperx-provider.js";
import {
  alignScene,
  OVERALL_ALIGNMENT_GATE,
  toWordTimestamps,
} from "./alignment.js";
import { createStoryAgents, type StoryAgents } from "./agents.js";
import { atomicWriteFile, ensureDir, writeJsonFile } from "./atomic.js";
import {
  findVoiceOutliers,
  runAudioStage,
  type AudioStageResult,
} from "./audio.js";
import { resolveStoryConfig, type StoryCliOverrides } from "./config.js";
import { buildCharacterSheetReference, runImageStage } from "./images.js";
import { assertStoryInput, deriveJobId } from "./input.js";
import { lintCharacterRegistry, lintStory, storyStyleLimits } from "./lint.js";
import {
  addWarning,
  loadOrCreateManifest,
  saveManifest,
  stageFingerprint,
  updateStageMetrics,
} from "./manifest.js";
import { jobDir, jobPaths, styleProfilePath } from "./paths.js";
import { composeImagePrompt, lintImagePrompt } from "./prompt.js";
import { runRenderStage } from "./render.js";
import { runStage, type StoryRunContext } from "./runner.js";
import {
  assembleNarration,
  countWords,
  estimatedDurationSec,
  fallbackGrouping,
  segmentSentences,
  validateGrouping,
} from "./sentences.js";
import { loadStyleProfile, type StoryStyleProfile } from "./style-profile.js";
import {
  buildStoryAss,
  buildStorySrt,
  buildSubtitleCues,
  type SubtitleCue,
} from "./subtitles.js";
import { computeSceneTimings, validateTimings } from "./timing.js";
import {
  STORY_STAGES,
  type Character,
  type ResolvedStoryConfig,
  type SceneTiming,
  type Sentence,
  type StoryClaim,
  type StoryManifest,
  type StoryScene,
  type StoryStage,
} from "./types.js";

/**
 * Story-Forge stickman storytelling pipeline: topic in, validated 1080p MP4
 * out (S1–S8).
 *
 * Everything the model produces is treated as a *proposal*: narration is
 * reassembled from sentence ids, image prompts are composed from the registry
 * and the style profile, timings and frame counts are computed from measured
 * audio, and the render is only `complete` after S8 validation passes. Each
 * stage is fingerprinted and resumable, so a rerun redoes only what changed.
 */

export interface StoryJobOptions extends StoryCliOverrides {
  /** Run only these stages (others are reused or left untouched). */
  stages?: StoryStage[];
  /** Force this stage and every later stage to rerun. */
  from?: StoryStage;
  /** Validate input and report the plan without any paid call. */
  dryRun?: boolean;
  /** Pause after the story is written and wait for interactive approval. */
  reviewStory?: boolean;
  /** Test/smoke seams. Production callers omit them. */
  agents?: StoryAgents;
  agentInject?: AgentInject;
  assetProvider?: AssetProvider;
  ttsProvider?: TTSProvider;
  transcriber?: WhisperXProvider;
  /** Provenance label recorded on each generated image. */
  imageProviderLabel?: string;
}

export interface StoryPlan {
  wordBudget: number;
  estimatedSceneCount: number;
  estimatedLlmCalls: number;
  estimatedImageCalls: number;
  note: string;
}

export interface StoryJobResult {
  jobId: string;
  jobDir: string;
  status: "complete" | "stopped" | "failed";
  manifest: StoryManifest;
  finalVideo?: string;
  plan?: StoryPlan;
}

/** Concurrent scene-visual LLM calls (image calls use STORY_IMAGE_CONCURRENCY). */
const SLOT_CONCURRENCY = 2;
/** Automated story rewrites on lint/verification failure (brief S2). */
const STORY_ATTEMPTS = 2;

interface StoryContext extends StoryRunContext {
  config: ResolvedStoryConfig;
  style: StoryStyleProfile;
  options: StoryJobOptions;
}

function stageIndex(stage: StoryStage): number {
  return STORY_STAGES.indexOf(stage);
}

function buildForceStages(options: StoryJobOptions): Set<StoryStage> {
  const forceStages = new Set<StoryStage>();
  if (options.from) {
    const from = stageIndex(options.from);
    if (from < 0) {
      throw new PipelineError(
        `Unknown story stage "${options.from}" (expected one of ${STORY_STAGES.join(", ")})`,
        "STORY_INPUT_INVALID",
      );
    }
    for (const stage of STORY_STAGES) {
      if (stageIndex(stage) >= from) forceStages.add(stage);
    }
  }
  for (const stage of options.stages ?? []) {
    if (stageIndex(stage) < 0) {
      throw new PipelineError(
        `Unknown story stage "${stage}" (expected one of ${STORY_STAGES.join(", ")})`,
        "STORY_INPUT_INVALID",
      );
    }
    forceStages.add(stage);
  }
  return forceStages;
}

function wantsStage(options: StoryJobOptions, stage: StoryStage): boolean {
  return !options.stages || options.stages.length === 0
    ? true
    : options.stages.includes(stage);
}

function requireManifestStory(manifest: StoryManifest): {
  story: string;
  claims: StoryClaim[];
} {
  if (!manifest.story) {
    throw new PipelineError(
      "This stage requires a completed story (S2_story)",
      "STORY_STAGE_INCOMPLETE",
    );
  }
  return { story: manifest.story.story, claims: manifest.claims ?? [] };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runStoryJob(
  options: StoryJobOptions,
): Promise<StoryJobResult> {
  const storyConfig = resolveStoryConfig(options);
  const jobId = deriveJobId(storyConfig);
  const config: ResolvedStoryConfig = { ...storyConfig, jobId };
  const paths = jobPaths(jobDir(jobId, options.outputDir));

  assertStoryInput(config);
  const style = await loadStyleProfile(styleProfilePath(config.style));
  await ensureDir(paths.dir);
  await ensureDir(paths.imagesDir);
  await ensureDir(paths.audioPartsDir);
  await ensureDir(paths.audioChunksDir);
  await ensureDir(paths.renderDir);

  const { manifest, resumed } = await loadOrCreateManifest(
    paths.manifest,
    config,
    jobId,
  );
  logger.info(
    `${resumed ? "Resuming" : "Starting"} story job ${jobId} (${paths.dir})`,
  );

  const ctx: StoryContext = {
    manifest,
    paths,
    forceStages: buildForceStages(options),
    config,
    style,
    options,
  };

  if (options.dryRun) return runDryRun(ctx);

  const agents =
    options.agents ?? createStoryAgents({ inject: options.agentInject });

  try {
    await stageInput(ctx);
    if (wantsStage(options, "S2_story")) await stageStory(ctx, agents);
    if (wantsStage(options, "S3_scenes")) await stageScenes(ctx, agents);
    if (wantsStage(options, "S4_visual_plan")) {
      await stageVisualPlan(ctx, agents);
    }
    if (wantsStage(options, "S5_images")) await stageImages(ctx, options);
    if (wantsStage(options, "S6_audio")) await stageAudio(ctx, options);
    let cues: SubtitleCue[] = [];
    if (wantsStage(options, "S7_align")) cues = await stageAlign(ctx, options);
    if (wantsStage(options, "S8_render")) {
      await stageRender(ctx, options, cues);
    }
  } catch (err) {
    await saveManifest(paths.manifest, ctx.manifest);
    throw err;
  }

  await saveManifest(paths.manifest, ctx.manifest);
  const passed = ctx.manifest.render?.validations.passed === true;
  return {
    jobId,
    jobDir: paths.dir,
    status: passed ? "complete" : "stopped",
    manifest: ctx.manifest,
    finalVideo: ctx.manifest.render?.finalVideo,
  };
}

function runDryRun(ctx: StoryContext): StoryJobResult {
  const { config } = ctx;
  const wordBudget = Math.round((config.targetDurationSec * config.wpm) / 60);
  const midpoint = (config.sceneTargetMinSec + config.sceneTargetMaxSec) / 2;
  const estimatedSceneCount = Math.max(
    1,
    Math.round(config.targetDurationSec / midpoint),
  );
  const plan: StoryPlan = {
    wordBudget,
    estimatedSceneCount,
    // 1 story + 1 verification + 1 character registry + one per scene.
    estimatedLlmCalls: estimatedSceneCount + 3,
    estimatedImageCalls: estimatedSceneCount,
    note: "Dry run: no provider or LLM was called.",
  };
  logger.info("Story dry run", {
    jobId: ctx.manifest.jobId,
    jobDir: ctx.paths.dir,
    wordBudget,
    estimatedSceneCount,
    resolution: `${config.width}x${config.height}`,
    fps: config.fps,
    gapMs: config.sceneGapMs,
    imageConcurrency: config.imageConcurrency,
  });
  return {
    jobId: ctx.manifest.jobId,
    jobDir: ctx.paths.dir,
    status: "stopped",
    manifest: ctx.manifest,
    plan,
  };
}

// ---------------------------------------------------------------------------
// S1 input
// ---------------------------------------------------------------------------

async function stageInput(ctx: StoryContext): Promise<void> {
  const fingerprint = stageFingerprint({
    input: ctx.manifest.input,
    config: ctx.config,
    style: ctx.style.id,
    styleHash: hashObject(ctx.style),
  });
  await runStage(ctx, "S1_input", fingerprint, async () => {
    updateStageMetrics(ctx.manifest, "S1_input", {
      wordBudget: Math.round(
        (ctx.config.targetDurationSec * ctx.config.wpm) / 60,
      ),
      style: ctx.style.id,
      stylePath: styleProfilePath(ctx.config.style),
      grounded: false,
      unverified: true,
    });
    await writeJsonFile(ctx.paths.manifest, ctx.manifest);
  });
}

// ---------------------------------------------------------------------------
// S2 story
// ---------------------------------------------------------------------------

async function stageStory(
  ctx: StoryContext,
  agents: StoryAgents,
): Promise<void> {
  const wordBudget = Math.round(
    (ctx.config.targetDurationSec * ctx.config.wpm) / 60,
  );
  const fingerprint = stageFingerprint({
    topic: ctx.config.topic,
    language: ctx.config.language,
    tone: ctx.config.tone ?? null,
    wordBudget,
    style: ctx.style.id,
    hardWords: ctx.style.hardWords,
    explanationCues: ctx.style.explanationCues,
  });

  await runStage(ctx, "S2_story", fingerprint, async () => {
    let story = await requireAgent(
      agents.writeStory({
        topic: ctx.config.topic,
        language: ctx.config.language,
        tone: ctx.config.tone,
        targetWords: wordBudget,
        limits: storyStyleLimits(wordBudget),
      }),
      "story writing",
    );
    let lint = lintStory(story.story, lintOptions(ctx));
    let attempts = 1;

    // One automated rewrite carrying the exact violations (brief S2).
    if (!lint.passed && STORY_ATTEMPTS > 1) {
      logger.warn("Story failed the reading-level lint; rewriting once", {
        issues: lint.issues,
      });
      // Keep the first draft's violations in the artifact: they are the only
      // evidence of how close the up-front limits got the model on try one.
      addWarning(
        ctx.manifest,
        `Story draft ${attempts} failed the reading-level lint and was rewritten: ${lint.issues.join("; ")}`,
      );
      attempts += 1;
      story = await requireAgent(
        agents.writeStory({
          topic: ctx.config.topic,
          language: ctx.config.language,
          tone: ctx.config.tone,
          targetWords: wordBudget,
          limits: storyStyleLimits(wordBudget),
          feedback: formatFeedback([
            ...lint.issues,
            storyStyleContract(wordBudget),
          ]),
        }),
        "story rewrite",
      );
      lint = lintStory(story.story, lintOptions(ctx));
    }

    let verification = await requireAgent(
      agents.verifyStory({
        story: story.story,
        claims: story.claims,
        language: ctx.config.language,
      }),
      "story verification",
    );
    let verificationAttempts = 1;
    let blocking = blockingIssues(verification);

    if (blocking.length > 0 && STORY_ATTEMPTS > 1) {
      logger.warn(
        "Story verification reported blocking issues; rewriting once",
        { blocking },
      );
      attempts += 1;
      verificationAttempts += 1;
      story = await requireAgent(
        agents.writeStory({
          topic: ctx.config.topic,
          language: ctx.config.language,
          tone: ctx.config.tone,
          targetWords: wordBudget,
          limits: storyStyleLimits(wordBudget),
          feedback: formatFeedback([
            "Factual accuracy problems must be fixed:",
            ...blocking,
            "Hedge disputed or legendary claims, remove invented quotes, dialogue and motives, and keep the wording simple.",
            storyStyleContract(wordBudget),
          ]),
        }),
        "story rewrite",
      );
      lint = lintStory(story.story, lintOptions(ctx));
      verification = await requireAgent(
        agents.verifyStory({
          story: story.story,
          claims: story.claims,
          language: ctx.config.language,
        }),
        "story re-verification",
      );
      blocking = blockingIssues(verification);
    }

    if (!lint.passed) {
      throw new PipelineError(
        `Story failed the reading-level lint after ${attempts} attempt(s):\n${lint.issues.join("\n")}`,
        "STORY_LINT_FAILED",
      );
    }
    if (blocking.length > 0) {
      throw new PipelineError(
        `Story verification still reports blocking issues: ${blocking.join("; ")}`,
        "STORY_VERIFICATION_FAILED",
      );
    }

    for (const warning of lint.warnings) addWarning(ctx.manifest, warning);

    ctx.manifest.story = {
      title: story.title,
      // Narration downstream is rebuilt from sentence ids; the story text is
      // kept verbatim here as the single source of truth.
      story: story.story,
      wordCount: countWords(story.story),
      lint: {
        passed: lint.passed,
        attempts,
        sentenceCount: lint.sentenceCount,
        wordCount: lint.wordCount,
        averageSentenceWords: lint.averageSentenceWords,
        maximumSentenceWords: lint.maximumSentenceWords,
        readingGrade: lint.readingGrade,
        wordBudgetTarget: lint.wordBudgetTarget,
        wordBudgetVariance: lint.wordBudgetVariance,
        issues: lint.issues,
        warnings: lint.warnings,
      },
    };
    ctx.manifest.claims = story.claims;
    // DP3: no research agent ran, so nothing here is externally verified.
    ctx.manifest.groundingSource = "model-knowledge";
    ctx.manifest.unverified = true;
    ctx.manifest.verification = {
      attempts: verificationAttempts,
      issues: verification.issues,
      blocking: [],
      notes: verification.issues
        .filter((issue) => issue.severity === "advisory")
        .map((issue) => issue.description),
    };

    await writeJsonFile(ctx.paths.story, {
      title: story.title,
      story: story.story,
      wordCount: ctx.manifest.story.wordCount,
      claims: story.claims,
      lint: ctx.manifest.story.lint,
      verification: ctx.manifest.verification,
      groundingSource: ctx.manifest.groundingSource,
      unverified: ctx.manifest.unverified,
    });
    await writeJsonFile(ctx.paths.claims, story.claims);

    if (ctx.options.reviewStory) await reviewStory(ctx);
  });
}

function lintOptions(ctx: StoryContext) {
  return {
    wpm: ctx.config.wpm,
    targetDurationSec: ctx.config.targetDurationSec,
    hardWords: ctx.style.hardWords,
    explanationCues: ctx.style.explanationCues,
  };
}

function blockingIssues(verification: {
  issues: { kind: string; description: string; severity: string }[];
}): string[] {
  return verification.issues
    .filter((issue) => issue.severity === "blocking")
    .map((issue) => `${issue.kind}: ${issue.description}`);
}

/**
 * The measurable style contract, restated in every rewrite.
 *
 * A rewrite triggered by a factual problem used to carry only the fact list.
 * The model then relaxed the wording and the final lint failed — in a real run
 * the third (verification-triggered) draft averaged 15.3 words per sentence and
 * the job hard-failed after spending its whole rewrite budget. The numbers have
 * to travel with the feedback, because the model cannot see the linter.
 */
function storyStyleContract(wordBudget: number): string {
  const limits = storyStyleLimits(wordBudget);
  return (
    `Keep this style contract in the new version: ${limits.averageSentenceWords} words per sentence on average, ` +
    `no sentence longer than ${limits.maxSentenceWords} words, ` +
    `${limits.minWords}-${limits.maxWords} words in total.`
  );
}

function formatFeedback(issues: string[]): string {
  return issues.map((issue) => `- ${issue}`).join("\n");
}

async function requireAgent<T>(
  promise: Promise<{ data: T | null; error?: string }>,
  label: string,
): Promise<T> {
  const outcome = await promise;
  if (!outcome.data) {
    throw new PipelineError(
      `${label} failed: ${outcome.error ?? "unknown error"}`,
      "STORY_STAGE_FAILED",
    );
  }
  return outcome.data;
}

async function reviewStory(ctx: StoryContext): Promise<void> {
  const story = ctx.manifest.story;
  if (!process.stdin.isTTY) {
    addWarning(
      ctx.manifest,
      "review-story requested but stdin is not a TTY; the validated story was accepted without review",
    );
    return;
  }
  process.stdout.write(`\n${story?.title ?? ""}\n\n${story?.story ?? ""}\n\n`);
  const timeoutMs = appConfig.storyReviewStoryTimeoutMs();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let reviewTimer: ReturnType<typeof setTimeout> | undefined;
  const answer = await new Promise<string | undefined>((resolveAnswer) => {
    // Exactly one resolution path: an answer or the timeout closes the
    // interface, and the `close` event resolves the promise. Calling
    // `resolve` from several places made the ordering (and lint) fragile.
    let answered: string | undefined;
    if (timeoutMs > 0) {
      reviewTimer = setTimeout(() => rl.close(), timeoutMs);
    }
    rl.question("Approve this story? [y/N] ", (value) => {
      answered = value;
      rl.close();
    });
    rl.on("close", () => resolveAnswer(answered));
  });
  if (reviewTimer) clearTimeout(reviewTimer);
  if (answer === undefined) {
    addWarning(
      ctx.manifest,
      `review-story got no answer within ${timeoutMs || "the"} ${
        timeoutMs ? "ms" : "session"
      }; the validated story was accepted without review`,
    );
    return;
  }
  if (!/^y(es)?$/i.test(answer.trim())) {
    throw new PipelineError(
      "Story was not approved at the review gate",
      "STORY_REVIEW_REJECTED",
    );
  }
}

// ---------------------------------------------------------------------------
// S3 scenes
// ---------------------------------------------------------------------------

function freshScene(
  sceneId: number,
  sentenceIds: string[],
  narration: string,
  visualPurpose: string,
): StoryScene {
  return {
    sceneId,
    sentenceIds,
    narration,
    wordCount: countWords(narration),
    visualPurpose,
    imagePromptWarnings: [],
    status: {
      prompt: "pending",
      image: "pending",
      audio: "pending",
      transcript: "pending",
      timing: "pending",
    },
    warnings: [],
  };
}

/**
 * Rebuild the scene list. A scene whose narration is unchanged keeps its
 * slotted prompt, image, audio, transcript and timing, so a resume never
 * re-buys work the fingerprint says is still valid.
 */
function syncScenes(
  manifest: StoryManifest,
  grouping: { sceneId: number; sentenceIds: string[]; visualPurpose: string }[],
  sentenceById: Map<string, Sentence>,
): void {
  const narrationById = new Map(
    grouping.map((entry) => [
      entry.sceneId,
      assembleNarration(entry.sentenceIds, sentenceById),
    ]),
  );
  const reusable = new Map<number, StoryScene>();
  for (const scene of manifest.scenes) {
    if (narrationById.get(scene.sceneId) === scene.narration) {
      reusable.set(scene.sceneId, scene);
    }
  }
  manifest.scenes = grouping.map((entry) => {
    const narration = narrationById.get(entry.sceneId) ?? "";
    const existing = reusable.get(entry.sceneId);
    if (existing) {
      existing.sentenceIds = entry.sentenceIds;
      existing.visualPurpose = entry.visualPurpose;
      return existing;
    }
    return freshScene(
      entry.sceneId,
      entry.sentenceIds,
      narration,
      entry.visualPurpose,
    );
  });
}

async function stageScenes(
  ctx: StoryContext,
  agents: StoryAgents,
): Promise<void> {
  const { story } = requireManifestStory(ctx.manifest);
  const fingerprint = stageFingerprint({
    storyHash: hashObject(story),
    language: ctx.config.language,
    wpm: ctx.config.wpm,
    sceneMinSec: ctx.config.sceneMinSec,
    sceneTargetMinSec: ctx.config.sceneTargetMinSec,
    sceneTargetMaxSec: ctx.config.sceneTargetMaxSec,
  });

  await runStage(ctx, "S3_scenes", fingerprint, async () => {
    const sentences = segmentSentences(story, ctx.config.language);
    const sentenceById = new Map(
      sentences.map((sentence) => [sentence.id, sentence]),
    );

    let grouping:
      | { sceneId: number; sentenceIds: string[]; visualPurpose: string }[]
      | undefined;
    let issues: string[] = [];

    for (let attempt = 0; attempt < STORY_ATTEMPTS; attempt++) {
      const outcome = await agents.planScenes({
        sentences: sentences.map((sentence) => ({
          id: sentence.id,
          text: sentence.text,
        })),
        wpm: ctx.config.wpm,
        sceneTargetMinSec: ctx.config.sceneTargetMinSec,
        sceneTargetMaxSec: ctx.config.sceneTargetMaxSec,
      });
      if (!outcome.data) {
        issues = [outcome.error ?? "scene planning failed"];
        continue;
      }
      const found = validateGrouping(outcome.data.scenes, sentences);
      if (found.length === 0) {
        grouping = outcome.data.scenes.map((scene) => ({
          sceneId: scene.sceneId,
          sentenceIds: scene.sentenceIds,
          visualPurpose: scene.visualPurpose,
        }));
        issues = [];
        break;
      }
      issues = found.map((issue) => issue.message);
    }

    let method: "model" | "fallback" = "model";
    if (!grouping) {
      method = "fallback";
      grouping = fallbackGrouping(sentences, {
        wpm: ctx.config.wpm,
        sceneMinSec: ctx.config.sceneMinSec,
        sceneTargetMinSec: ctx.config.sceneTargetMinSec,
        sceneTargetMaxSec: ctx.config.sceneTargetMaxSec,
      });
      addWarning(
        ctx.manifest,
        `Scene planning fell back to deterministic grouping: ${issues.join("; ")}`,
      );
    }

    syncScenes(ctx.manifest, grouping, sentenceById);
    await writeJsonFile(ctx.paths.scenes, ctx.manifest.scenes);
    updateStageMetrics(ctx.manifest, "S3_scenes", {
      method,
      sceneCount: ctx.manifest.scenes.length,
      sentenceCount: sentences.length,
      estimatedDurationSec:
        Math.round(estimatedDurationSec(sentences, ctx.config.wpm) * 10) / 10,
      groupingIssues: issues,
    });
  });
}

// ---------------------------------------------------------------------------
// S4 visual plan
// ---------------------------------------------------------------------------

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const runners = Array.from(
    { length: Math.max(1, Math.min(limit, Math.max(1, items.length))) },
    async () => {
      for (;;) {
        const item = queue.shift();
        if (item === undefined) return;
        await worker(item);
      }
    },
  );
  await Promise.all(runners);
}

function scenePromptFingerprint(scene: StoryScene): string {
  return hashObject({
    narration: scene.narration,
    visualPurpose: scene.visualPurpose,
  });
}

async function stageVisualPlan(
  ctx: StoryContext,
  agents: StoryAgents,
): Promise<void> {
  const { story } = requireManifestStory(ctx.manifest);
  const charactersFingerprint = stageFingerprint({
    storyHash: hashObject(story),
    language: ctx.config.language,
    style: ctx.style.id,
    styleHash: hashObject(ctx.style),
  });
  const fingerprint = stageFingerprint({
    storyHash: hashObject(story),
    styleHash: hashObject(ctx.style),
    prompts: ctx.manifest.scenes.map(
      (scene) => `${scene.sceneId}:${scenePromptFingerprint(scene)}`,
    ),
  });

  await runStage(ctx, "S4_visual_plan", fingerprint, async () => {
    const storedRegistry =
      ctx.manifest.stages.S4_visual_plan?.metrics?.charactersFingerprint;
    if (
      ctx.manifest.characters === undefined ||
      storedRegistry !== charactersFingerprint
    ) {
      let characters: Character[] = [];
      let issues: string[] = [];
      for (let attempt = 0; attempt < STORY_ATTEMPTS; attempt++) {
        const registry = await requireAgent(
          agents.designCharacters({
            story,
            language: ctx.config.language,
            feedback: issues.length > 0 ? formatFeedback(issues) : undefined,
          }),
          "character registry",
        );
        characters = registry.characters;
        issues = lintCharacterRegistry(characters);
        if (issues.length === 0) break;
      }
      if (issues.length > 0) {
        throw new PipelineError(
          `Character registry failed the silhouette lint: ${issues.join("; ")}`,
          "STORY_STAGE_FAILED",
        );
      }
      ctx.manifest.characters = characters;
      await writeJsonFile(ctx.paths.characters, ctx.manifest.characters);
    }
    const characters = ctx.manifest.characters ?? [];
    updateStageMetrics(ctx.manifest, "S4_visual_plan", {
      charactersFingerprint,
      characterCount: characters.length,
    });

    const failures: string[] = [];
    await mapWithConcurrency(
      ctx.manifest.scenes,
      SLOT_CONCURRENCY,
      async (scene) => {
        const promptFingerprint = scenePromptFingerprint(scene);
        if (
          scene.status.prompt === "done" &&
          scene.imagePrompt &&
          scene.promptFingerprint === promptFingerprint &&
          scene.imagePromptWarnings.length === 0
        ) {
          return;
        }

        let feedback: string | undefined;
        for (let attempt = 0; attempt < STORY_ATTEMPTS; attempt++) {
          const outcome = await agents.planSceneVisuals({
            sceneId: scene.sceneId,
            narration: scene.narration,
            visualPurpose: scene.visualPurpose,
            characters,
            language: ctx.config.language,
          });
          if (!outcome.data) {
            feedback = outcome.error ?? "visual planning failed";
            continue;
          }
          if (outcome.data.sceneId !== scene.sceneId) {
            feedback = `sceneId must be ${scene.sceneId}, received ${outcome.data.sceneId}`;
            continue;
          }
          scene.slots = outcome.data;
          let composed;
          try {
            composed = composeImagePrompt({
              style: ctx.style,
              slots: outcome.data,
              characters,
            });
          } catch (err) {
            feedback = (err as Error)?.message ?? String(err);
            continue;
          }
          const issues = lintImagePrompt({
            prompt: composed.prompt,
            slots: outcome.data,
            characters,
            language: ctx.config.language,
          });
          if (issues.length === 0) {
            scene.imagePrompt = composed.prompt;
            scene.promptFingerprint = promptFingerprint;
            scene.imagePromptWarnings = [];
            scene.status.prompt = "done";
            return;
          }
          feedback = formatFeedback(issues.map((issue) => issue.message));
          scene.imagePromptWarnings = issues.map((issue) => issue.message);
        }

        scene.status.prompt = "failed";
        const message = `prompt lint failed: ${feedback ?? "unknown"}`;
        if (!scene.warnings.includes(message)) scene.warnings.push(message);
        failures.push(`scene ${scene.sceneId}: ${message}`);
      },
    );

    await writeJsonFile(ctx.paths.scenes, ctx.manifest.scenes);

    if (failures.length > 0) {
      throw new PipelineError(
        `Visual planning failed for ${failures.length} scene(s): ${failures.join("; ")}`,
        "STORY_STAGE_FAILED",
      );
    }
  });

  await writeJsonFile(ctx.paths.scenes, ctx.manifest.scenes);
  await writeJsonFile(ctx.paths.characters, ctx.manifest.characters ?? []);
}

// ---------------------------------------------------------------------------
// S5 images
// ---------------------------------------------------------------------------

function characterSheetPrompt(
  characters: { name: string; visualDescription: string }[],
): string {
  const lines = characters
    .map((character) => `- ${character.name}: ${character.visualDescription}`)
    .join("\n");
  return [
    "A hand-drawn digital illustration, clean vector line art, heavy black outlines, cel-shaded colouring, desaturated muted colour palette.",
    "",
    "A single reference sheet showing each character standing in a neutral pose, side by side, on a plain white background.",
    "",
    "Characters:",
    lines.length > 0 ? lines : "(none)",
    "",
    "Style constraints: simple white round stickman heads with black line-art bodies, no facial features beyond simple eyebrows and mouths, no photographic textures, no text, no lettering, no watermarks.",
    "",
    "Wide 16:9 horizontal composition.",
  ].join("\n");
}

async function stageImages(
  ctx: StoryContext,
  options: StoryJobOptions,
): Promise<void> {
  const assetProvider = options.assetProvider ?? createDefaultAssetProvider();
  const referenceSheet = appConfig.storyReferenceSheet();
  const fingerprint = stageFingerprint({
    prompts: ctx.manifest.scenes.map((scene) => ({
      sceneId: scene.sceneId,
      promptHash: scene.imagePrompt ? hashObject(scene.imagePrompt) : null,
    })),
    gate: {
      minWidth: ctx.config.imageMinWidth,
      minHeight: ctx.config.imageMinHeight,
      minAspect: ctx.config.imageMinAspect,
      maxAspect: ctx.config.imageMaxAspect,
    },
    concurrency: ctx.config.imageConcurrency,
    referenceSheet,
  });

  await runStage(ctx, "S5_images", fingerprint, async () => {
    const referenceImage = referenceSheet
      ? await buildCharacterSheetReference({
          assetProvider,
          prompt: characterSheetPrompt(ctx.manifest.characters ?? []),
          path: resolve(ctx.paths.imagesDir, "character-sheet.png"),
          runId: ctx.manifest.jobId,
        })
      : undefined;

    const outcome = await runImageStage({
      scenes: ctx.manifest.scenes,
      paths: ctx.paths,
      config: ctx.config,
      assetProvider,
      runId: ctx.manifest.jobId,
      workDir: ctx.paths.renderDir,
      providerLabel: options.imageProviderLabel,
      referenceImage,
    });
    await writeJsonFile(ctx.paths.scenes, ctx.manifest.scenes);
    updateStageMetrics(ctx.manifest, "S5_images", {
      generated: outcome.generated,
      reused: outcome.reused,
      failed: outcome.failed.length,
    });

    if (outcome.failed.length > 0) {
      throw new PipelineError(
        `Image generation failed for ${outcome.failed.length} scene(s); rerun to retry only those scenes: ${outcome.failed.join("; ")}`,
        "STORY_IMAGES_FAILED",
      );
    }
  });

  await writeJsonFile(ctx.paths.scenes, ctx.manifest.scenes);
}

// ---------------------------------------------------------------------------
// S6 audio
// ---------------------------------------------------------------------------

async function stageAudio(
  ctx: StoryContext,
  options: StoryJobOptions,
): Promise<void> {
  const ttsProvider = options.ttsProvider ?? new ChatterboxTTSProvider();
  const voice = appConfig.storyVoice();
  const providerFingerprint =
    typeof ttsProvider.cacheFingerprint === "function"
      ? ttsProvider.cacheFingerprint()
      : "default";
  const fingerprint = stageFingerprint({
    chunks: ctx.manifest.scenes.map((scene) => ({
      sceneId: scene.sceneId,
      narrationHash: hashObject(scene.narration),
    })),
    voice,
    providerFingerprint,
    gapMs: ctx.config.sceneGapMs,
    maxChars: ctx.config.ttsMaxChars,
    asrVerify: ctx.config.asrVerify,
  });

  await runStage(ctx, "S6_audio", fingerprint, async () => {
    const outcome: AudioStageResult = await runAudioStage({
      scenes: ctx.manifest.scenes,
      paths: ctx.paths,
      config: ctx.config,
      ttsProvider,
      transcriber: options.transcriber ?? new HttpWhisperXProvider(),
      voice,
      runId: ctx.manifest.jobId,
    });

    for (const outlier of findVoiceOutliers(ctx.manifest.scenes)) {
      addWarning(
        ctx.manifest,
        `scene ${outlier.sceneId} voice drift: ${outlier.reason}`,
      );
    }

    ctx.manifest.audio = {
      masterPath: outcome.masterPath,
      durationSec: outcome.masterDurationSec,
      gapMs: outcome.gapMs,
      sampleRate: 48000,
    };
    await writeJsonFile(ctx.paths.scenes, ctx.manifest.scenes);
    updateStageMetrics(ctx.manifest, "S6_audio", {
      chunks: outcome.chunks.length,
      durationSec: outcome.masterDurationSec,
      voice,
      providerFingerprint,
    });
  });

  await writeJsonFile(ctx.paths.scenes, ctx.manifest.scenes);
}

// ---------------------------------------------------------------------------
// S7 alignment + subtitles
// ---------------------------------------------------------------------------

function sceneChunkDurations(scene: StoryScene): {
  sceneId: number;
  durationSec: number;
} {
  return {
    sceneId: scene.sceneId,
    durationSec: scene.audio?.durationSec ?? 0,
  };
}

function computeTimingsFor(
  ctx: StoryContext,
): ReturnType<typeof computeSceneTimings> {
  const audio = ctx.manifest.audio;
  if (!audio) {
    throw new PipelineError(
      "Scene timing requires narration audio (S6_audio)",
      "STORY_STAGE_INCOMPLETE",
    );
  }
  const chunks = ctx.manifest.scenes.map(sceneChunkDurations);
  if (chunks.some((chunk) => chunk.durationSec <= 0)) {
    throw new PipelineError(
      "Scene timing requires a measured duration for every narration chunk",
      "STORY_STAGE_INCOMPLETE",
    );
  }
  return computeSceneTimings({
    chunks,
    gapMs: audio.gapMs,
    fps: ctx.config.fps,
    audioDurationSec: audio.durationSec,
  });
}

function assStyle(ctx: StoryContext) {
  return {
    fontName: appConfig.subtitleFontName(),
    fontSize: appConfig.subtitleFontSize(),
    primaryColor: appConfig.subtitlePrimaryColor(),
    outlineColor: "&H00000000",
    outline: appConfig.subtitleOutline(),
    marginV: appConfig.subtitleMarginV(),
    playResX: ctx.config.width,
    playResY: ctx.config.height,
  };
}

function cuesForScenes(
  ctx: StoryContext,
  timings: SceneTiming[],
): SubtitleCue[] {
  return buildSubtitleCues({
    scenes: ctx.manifest.scenes.map((scene, index) => ({
      sceneId: scene.sceneId,
      timing: timings[index],
      words: scene.transcript?.words ?? [],
    })),
    maxCharsPerLine: ctx.config.subtitleMaxCharsPerLine,
    minDurationMs: ctx.config.subtitleMinDurationMs,
  });
}

function overallMatchRatio(manifest: StoryManifest): number {
  return (
    manifest.scenes.reduce(
      (sum, scene) => sum + (scene.transcript?.matchRatio ?? 0),
      0,
    ) / Math.max(1, manifest.scenes.length)
  );
}

async function stageAlign(
  ctx: StoryContext,
  options: StoryJobOptions,
): Promise<SubtitleCue[]> {
  const transcriber = options.transcriber ?? new HttpWhisperXProvider();
  const timing = computeTimingsFor(ctx);
  const fingerprint = stageFingerprint({
    chunks: ctx.manifest.scenes.map((scene) => ({
      sceneId: scene.sceneId,
      durationSec: scene.audio?.durationSec ?? null,
      narrationHash: hashObject(scene.narration),
    })),
    timings: timing.timings,
    gapMs: ctx.manifest.audio?.gapMs ?? null,
    audioDurationSec: ctx.manifest.audio?.durationSec ?? null,
    fps: ctx.config.fps,
    maxCharsPerLine: ctx.config.subtitleMaxCharsPerLine,
    minDurationMs: ctx.config.subtitleMinDurationMs,
  });

  const computed = await runStage(ctx, "S7_align", fingerprint, async () => {
    for (const [index, scene] of ctx.manifest.scenes.entries()) {
      const sceneTiming = timing.timings[index];
      scene.timing = sceneTiming;
      scene.status.timing = "done";

      const chunkPath = scene.audio?.path;
      const chunkDurationSec = scene.audio?.durationSec;
      if (!chunkPath || chunkDurationSec === undefined) {
        throw new PipelineError(
          `Scene ${scene.sceneId} has no narration chunk to align`,
          "STORY_STAGE_INCOMPLETE",
        );
      }

      const chunkFingerprint = hashObject({
        narration: scene.narration,
        durationSec: chunkDurationSec,
      });
      const stored = (
        ctx.manifest.stages.S7_align?.metrics?.chunkFingerprints as
          Record<string, unknown> | undefined
      )?.[String(scene.sceneId)];
      if (
        scene.status.transcript === "done" &&
        scene.transcript &&
        stored === chunkFingerprint
      ) {
        continue;
      }

      const result = await transcriber.align(chunkPath, scene.narration, {
        runId: ctx.manifest.jobId,
        sceneId: scene.sceneId,
      });
      // ASR times are relative to the chunk, so alignment happens in chunk
      // coordinates and is offset onto the timeline afterwards.
      const alignment = alignScene({
        scriptText: scene.narration,
        asrWords: result.wordTimestamps.map((word) => ({
          word: word.word,
          start: word.start,
          end: word.end,
        })),
        bounds: { start: 0, end: chunkDurationSec },
      });
      scene.transcript = {
        matchRatio: Math.round(alignment.matchRatio * 1000) / 1000,
        method: alignment.method,
        words: toWordTimestamps(
          alignment.words.map((word) => ({
            token: word.token,
            start: word.start + sceneTiming.start,
            end: word.end + sceneTiming.start,
            matched: word.matched,
          })),
        ),
      };
      scene.status.transcript = "done";

      updateStageMetrics(ctx.manifest, "S7_align", {
        chunkFingerprints: {
          ...(ctx.manifest.stages.S7_align?.metrics?.chunkFingerprints as
            Record<string, unknown> | undefined),
          [String(scene.sceneId)]: chunkFingerprint,
        },
      });
    }

    const ratio = overallMatchRatio(ctx.manifest);
    if (ratio < OVERALL_ALIGNMENT_GATE) {
      throw new PipelineError(
        `Overall alignment match ratio ${ratio.toFixed(2)} is below the ${OVERALL_ALIGNMENT_GATE} gate; refusing to render a desynced video`,
        "STORY_ALIGNMENT_FAILED",
      );
    }

    for (const scene of ctx.manifest.scenes) {
      if (scene.transcript?.method === "proportional") {
        addWarning(
          ctx.manifest,
          `scene ${scene.sceneId} used proportional subtitle timing (match ratio ${scene.transcript.matchRatio.toFixed(2)})`,
        );
      }
    }

    return cuesForScenes(ctx, timing.timings);
  });

  const cues = computed ?? cuesForScenes(ctx, timing.timings);
  await writeSubtitles(ctx, cues, timing);
  return cues;
}

async function writeSubtitles(
  ctx: StoryContext,
  cues: SubtitleCue[],
  timing: ReturnType<typeof computeSceneTimings>,
): Promise<void> {
  if (cues.length === 0) {
    addWarning(ctx.manifest, "No subtitle cues were produced for this run");
  }

  await atomicWriteFile(
    ctx.paths.subtitlesAss,
    buildStoryAss(cues, assStyle(ctx)),
  );
  await atomicWriteFile(ctx.paths.subtitlesSrt, buildStorySrt(cues));

  const sceneTimings = ctx.manifest.scenes.map((scene) => scene.timing);
  if (sceneTimings.some((entry) => entry === undefined)) {
    throw new PipelineError(
      "Scene timings are missing; alignment must run before rendering",
      "STORY_TIMING_INVALID",
    );
  }
  const issues = validateTimings(sceneTimings as SceneTiming[], {
    fps: ctx.config.fps,
    audioDurationSec: ctx.manifest.audio?.durationSec ?? 0,
  });
  if (issues.length > 0) {
    throw new PipelineError(
      `Scene timings failed validation: ${issues.map((issue) => issue.message).join("; ")}`,
      "STORY_TIMING_INVALID",
    );
  }

  const ratio = overallMatchRatio(ctx.manifest);
  ctx.manifest.transcriptPath = ctx.paths.transcript;
  ctx.manifest.subtitles = {
    ass: ctx.paths.subtitlesAss,
    srt: ctx.paths.subtitlesSrt,
    cueCount: cues.length,
    overallMatchRatio: Math.round(ratio * 1000) / 1000,
  };

  await writeJsonFile(ctx.paths.transcript, {
    overallMatchRatio: Math.round(ratio * 1000) / 1000,
    scenes: ctx.manifest.scenes.map((scene) => ({
      sceneId: scene.sceneId,
      narration: scene.narration,
      timing: scene.timing,
      method: scene.transcript?.method,
      matchRatio: scene.transcript?.matchRatio,
      words: scene.transcript?.words,
    })),
    wordTimestamps: ctx.manifest.scenes.flatMap(
      (scene) => scene.transcript?.words ?? [],
    ),
  });

  await writeJsonFile(ctx.paths.scenes, ctx.manifest.scenes);
  updateStageMetrics(ctx.manifest, "S7_align", {
    totalFrames: timing.totalFrames,
    videoDurationSec: timing.videoDurationSec,
    audioDurationSec: timing.audioDurationSec,
    cues: cues.length,
    overallMatchRatio: Math.round(ratio * 1000) / 1000,
  });
}

// ---------------------------------------------------------------------------
// S8 render
// ---------------------------------------------------------------------------

async function stageRender(
  ctx: StoryContext,
  options: StoryJobOptions,
  cues: SubtitleCue[],
): Promise<void> {
  const audio = ctx.manifest.audio;
  if (!audio) {
    throw new PipelineError(
      "Render requires narration audio (S6_audio)",
      "STORY_STAGE_INCOMPLETE",
    );
  }
  const timing = computeTimingsFor(ctx);
  for (const [index, scene] of ctx.manifest.scenes.entries()) {
    scene.timing = timing.timings[index];
    scene.status.timing = "done";
  }

  const finalCues = cues.length > 0 ? cues : cuesForScenes(ctx, timing.timings);
  const fingerprint = stageFingerprint({
    scenes: ctx.manifest.scenes.map((scene) => ({
      sceneId: scene.sceneId,
      promptHash: scene.image?.promptHash ?? null,
      durationSec: scene.audio?.durationSec ?? null,
      frames: scene.timing?.endFrame,
    })),
    cues: ctx.manifest.subtitles?.cueCount ?? 0,
    cuesHash: hashObject(finalCues),
    audioDurationSec: audio.durationSec,
    resolution: `${ctx.config.width}x${ctx.config.height}`,
    fps: ctx.config.fps,
    crf: ctx.config.crf,
    preset: ctx.config.preset,
    gapMs: audio.gapMs,
  });

  await runStage(ctx, "S8_render", fingerprint, async () => {
    const outcome = await runRenderStage({
      scenes: ctx.manifest.scenes,
      paths: ctx.paths,
      config: ctx.config,
      cues: finalCues,
      frames: timing.frames,
      audioDurationSec: audio.durationSec,
      runId: ctx.manifest.jobId,
      dryRun: options.dryRun,
    });
    if (options.dryRun) return outcome;
    ctx.manifest.render = {
      finalVideo: outcome.finalVideo,
      ffprobe: outcome.ffprobe,
      validations: outcome.validations,
    };
    // Warning-level checks (the frame-vs-source comparison, still being tuned
    // on real images) must be visible without failing the job.
    for (const check of outcome.validations.checks) {
      if (check.severity === "warning" && !check.passed) {
        addWarning(
          ctx.manifest,
          `render warning ${check.name}: ${check.detail}`,
        );
      }
    }
    return outcome;
  });
}
