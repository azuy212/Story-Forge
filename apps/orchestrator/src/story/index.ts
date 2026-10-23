/**
 * Story-Forge stickman storytelling pipeline — public entry point.
 *
 * This module is deliberately isolated from the Shorts pipeline: nothing here
 * imports `src/graph/**` or any agent node, and the only shared code it uses is
 * the additive, behaviour-preserving surface listed in the implementation
 * brief (runAgent, prompt paths, complexity lint, FFmpeg wrappers, providers).
 */

export { runStoryJob } from "./run.js";
export type { StoryJobOptions, StoryJobResult, StoryPlan } from "./run.js";

export {
  parseResolution,
  resolveStoryConfig,
  STORY_CLI_OVERRIDE_KEYS,
  storyTtsMode,
} from "./config.js";
export type { StoryCliOverrides } from "./config.js";

export { assertStoryInput, deriveJobId, validateStoryInput } from "./input.js";
export type { StoryInputIssue } from "./input.js";

export { jobDir, jobPaths, jobsRoot, styleProfilePath } from "./paths.js";
export type { JobPaths } from "./paths.js";

export {
  STORY_COMPLEXITY_THRESHOLDS,
  WORD_BUDGET_TOLERANCE,
  findHardWordIssues,
  formatLintViolations,
  lintStory,
} from "./lint.js";
export type { StoryLintOptions, StoryLintReport } from "./lint.js";

export {
  assembleNarration,
  countWords,
  estimatedDurationSec,
  fallbackGrouping,
  segmentSentences,
  splitSentences,
  validateGrouping,
} from "./sentences.js";
export type { GroupingIssue, GroupingOptions } from "./sentences.js";

export { loadStyleProfile, StyleProfileSchema } from "./style-profile.js";
export type { StoryStyleProfile } from "./style-profile.js";

export {
  MAX_PROMPT_CHARS,
  composeImagePrompt,
  lintImagePrompt,
} from "./prompt.js";
export type { ComposedImagePrompt, PromptLintIssue } from "./prompt.js";

export { createStoryAgents } from "./agents.js";
export type {
  StoryAgents,
  StoryAgentOutcome,
  StoryAgentTelemetry,
} from "./agents.js";

export {
  findVoiceOutliers,
  runAudioStage,
  shortenLongPauses,
  splitForTts,
  trimEdgeSilence,
} from "./audio.js";
export type { AudioChunkResult, AudioStageResult } from "./audio.js";

export {
  MIN_LUMINANCE_VARIANCE,
  clearImageWarnings,
  runImageStage,
  softenPrompt,
  validateSceneImage,
} from "./images.js";

export {
  OVERALL_ALIGNMENT_GATE,
  SCENE_ALIGNMENT_GATE,
  alignScene,
  applyPronunciations,
  canonicalizeAsrWords,
  narrationFidelity,
  numberValue,
  normalizeToken,
  proportionalAlignment,
  pronunciationAliases,
  tokenizeScript,
} from "./alignment.js";
export type {
  AlignedWord,
  AlignmentResult,
  AsrWord,
  NarrationFidelity,
} from "./alignment.js";

export {
  CLAIM_CHECKBOX,
  annotateClaims,
  assertClaimsConfirmed,
  buildClaimsChecklist,
  claimNeedsSource,
  claimsChecklistProgress,
  ensureClaimsChecklist,
  suggestClaimQuery,
} from "./claims.js";
export type { ClaimsChecklistProgress } from "./claims.js";

export { computeSceneTimings, validateTimings } from "./timing.js";
export type { SceneChunkDuration, TimingResult } from "./timing.js";

export {
  buildStoryAss,
  buildStorySrt,
  buildSubtitleCues,
  wrapLines,
} from "./subtitles.js";
export type {
  AssStyleConfig,
  SceneSubtitleInput,
  SubtitleCue,
} from "./subtitles.js";

export {
  buildConcatList,
  buildNarrationConcatArgs,
  buildRenderArgs,
  buildRenderVideoFilter,
  renderStoryVideo,
} from "./ffmpeg-args.js";
export type { ConcatEntry, StoryRenderArgsOptions } from "./ffmpeg-args.js";

export {
  SAMPLE_SCENE_COUNT,
  runRenderStage,
  validateRender,
} from "./render.js";
export type { RenderStageOptions, RenderStageResult } from "./render.js";

export {
  detectBlack,
  detectSilence,
  parseBlackIntervals,
  parseSilenceIntervals,
  probeMedia,
  probeStreams,
} from "./media.js";
export type {
  BlackInterval,
  MediaInfo,
  SilenceInterval,
  StreamInfo,
} from "./media.js";

export {
  STORY_STAGES,
  StoryClaimSchema,
  StoryOutputSchema,
  StoryPronunciationSchema,
  StoryVerificationSchema,
  SceneGroupingSchema,
  CharacterRegistrySchema,
  SceneVisualSlotsSchema,
} from "./types.js";
export type {
  Character,
  FfprobeSummary,
  RenderValidationReport,
  ResolvedStoryConfig,
  SceneAudioChunkRecord,
  SceneImageRecord,
  ScenePauseShortening,
  SceneTiming,
  SceneVisualSlots,
  SceneWordTimestamp,
  Sentence,
  StoryClaim,
  StoryJobInput,
  StoryManifest,
  StoryOutput,
  StoryPronunciation,
  StoryScene,
  StoryStage,
  StoryVerification,
} from "./types.js";
