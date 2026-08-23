import { StateGraph } from "@langchain/langgraph";
import { StateAnnotation } from "./state.js";
import { researchAgentNode } from "../agents/research-agent.node.js";
import { researchQANode } from "../agents/research-qa.node.js";
import { scriptPlannerNode } from "../agents/script-planner.node.js";
import { scriptWriterNode } from "../agents/script-writer.node.js";
import { scriptQANode } from "../agents/script-qa.node.js";
import { metadataGeneratorNode } from "../agents/metadata-generator.node.js";
import { thumbnailGeneratorNode } from "../agents/thumbnail-generator.node.js";
import { visualDirectorNode } from "../agents/visual-director.node.js";
import { assetStrategyNode } from "../agents/asset-strategy.node.js";
import { imagePromptGeneratorNode } from "../agents/image-prompt-generator.node.js";
import { promptQANode } from "../agents/prompt-qa.node.js";
import { assetGeneratorNode } from "../agents/asset-generator.node.js";
import {
  imagePromptRepairNode,
  isAwaitingRepair,
} from "../agents/image-prompt-repair.node.js";
import { narrationGeneratorNode } from "../agents/narration-generator.node.js";
import { subtitleGeneratorNode } from "../agents/subtitle-generator.node.js";
import { videoComposerNode } from "../agents/video-composer.node.js";
import { releaseValidationNode } from "../agents/release-validation.node.js";
import { releaseReviewNode } from "../agents/release-review.node.js";
import { publisherNode } from "../agents/publisher.node.js";
import { publishReadyNode } from "../agents/publish-ready.node.js";
import { logger } from "../utils/logger.js";
import { config as configUtils } from "../utils/config.js";
import {
  decideQaRetry,
  isRunFailed,
  runFailureReason,
} from "../utils/qa-policy.js";

import {
  RESEARCH_QA_MAX_RETRIES,
  SCRIPT_QA_MAX_RETRIES,
  PROMPT_QA_MAX_RETRIES,
} from "../utils/constants.js";

// Fan-out fired by VisualDirector once the visual plan exists: the parallel
// Metadata/Thumbnail enrichment pair.
const POST_VD_FANOUT: [string, string] = [
  "MetadataGenerator",
  "ThumbnailGenerator",
];

// Single terminal node: every fail-closed guard and every QA/other router
// resolves here so execution.status is finalized exactly once with one shared
// definition of complete vs failed.
const FINALIZE = "Finalize";

function retryCount(
  state: typeof StateAnnotation.State,
  nodeName: string,
): number {
  return state.execution?.retryCount?.[nodeName] ?? 0;
}

type GuardState = typeof StateAnnotation.State;

/**
 * Builds a conditional-edge router that advances to `next` when the upstream
 * node produced the output the next node needs, and routes to the shared
 * `Finalize` terminal otherwise. This guarantees downstream nodes never run
 * after an upstream failure — the failing node's error is already in
 * diagnostics — and that every failed path still finalizes execution.status.
 */
function guard(condition: (state: GuardState) => boolean, next: string) {
  return (state: GuardState) => (condition(state) ? next : FINALIZE);
}

const hasResearch = (s: GuardState) =>
  !!s.research?.summary && (s.research?.facts?.length ?? 0) > 0;
const hasStoryPlan = (s: GuardState) =>
  (s.storyPlan?.storyBeats?.length ?? 0) > 0;
const hasScript = (s: GuardState) => !!s.content?.script;
const hasScenes = (s: GuardState) => (s.production?.scenes?.length ?? 0) > 0;
// All-or-nothing by design: a single failed scene halts the spine rather than
// advancing with a partially-generated asset set. If partial rendering is ever
// desired, these predicates must change to "at least one" semantics.
const hasScenePrompts = (s: GuardState) =>
  hasScenes(s) && s.production!.scenes!.every((sc) => !!sc.generationPrompt);
const hasSceneAssets = (s: GuardState) =>
  hasScenes(s) && s.production!.scenes!.every((sc) => !!sc.assetUrl);
const hasNarration = (s: GuardState) => {
  const scenes = s.production?.scenes ?? [];
  const audioScenes = s.audio?.scenes ?? [];
  const combined = s.audio?.combinedAudio;
  if (
    scenes.length === 0 ||
    audioScenes.length !== scenes.length ||
    !combined
  ) {
    return false;
  }

  const sceneIds = scenes.map((scene) => scene.sceneId);
  const audioIds = audioScenes.map((scene) => scene.sceneId);
  const artifactIds = audioScenes.map((scene) => scene.artifactId);
  return (
    artifactIds.every(
      (id): id is string => typeof id === "string" && id.length > 0,
    ) &&
    typeof combined.artifactId === "string" &&
    combined.artifactId.length > 0 &&
    sceneIds.every((id, index) => id === audioIds[index]) &&
    combined.sourceSceneArtifactIds.length === artifactIds.length &&
    combined.sourceSceneArtifactIds.every(
      (id, index) => id === artifactIds[index],
    ) &&
    !!s.audio?.narrationUrl &&
    !!s.audio?.narrationDurationMs
  );
};
const hasSubtitles = (s: GuardState) => !!s.subtitles?.srt;
const hasVideo = (s: GuardState) => !!s.video?.videoUrl;
const hasPassedValidation = (s: GuardState) =>
  s.releaseValidation?.status === "approved";
const hasMetadata = (s: GuardState) =>
  !!s.metadataOutput?.title &&
  !!s.metadataOutput?.description &&
  (s.metadataOutput?.tags?.length ?? 0) > 0;
const thumbnailEnabled = configUtils.enableThumbnail();
// Require the actual thumbnail image only when thumbnails are enabled.
// When disabled, the prompt-only thumbnail is sufficient for the package.
const hasThumbnail = (s: GuardState) =>
  thumbnailEnabled ? !!s.thumbnail?.imageUrl : !!s.thumbnail?.thumbnailPrompt;
// Publisher requires video + metadata + thumbnail to all exist. This is the
// final gate on PublishReady's conditional edge: PublishReady fires once after
// ReleaseReview approval, and can only advance to Publisher once the full
// release package is present.
const hasPublishablePackage = (s: GuardState) =>
  hasVideo(s) && hasMetadata(s) && hasThumbnail(s);
// PublishReady doubles as a hard operational gate (files exist, lengths valid,
// credentials present). A "ready" verdict is required on top of the package so
// a blocked publication cannot reach Publisher.
const hasPublishReady = (s: GuardState) => s.publishReady?.status === "ready";

// Fail-closed QA routing: an explicit "approved" is the ONLY verdict that
// advances the pipeline. All routers resolve through decideQaRetry so the
// severity budgets and after-max fallbacks are identical everywhere: minor is
// revised once then accepted, major/fail is revised twice then fails the run,
// and QA-infra failures retry the cheap QA node within its own budget.
const researchRouter = (state: typeof StateAnnotation.State) => {
  const decision = decideQaRetry({
    node: "ResearchQA",
    status: state.researchQA?.status,
    revisionAttempts: retryCount(state, "ResearchAgent"),
    qaAttempts: retryCount(state, "ResearchQA"),
    repeated: state.researchQA?.repeated,
    infraMax: RESEARCH_QA_MAX_RETRIES,
  });
  if (decision.action === "continue") return "ScriptPlanner";
  if (decision.action === "revise") return "ResearchAgent";
  if (decision.action === "retry") return "ResearchQA";
  return FINALIZE;
};

const scriptRouter = (state: typeof StateAnnotation.State) => {
  const decision = decideQaRetry({
    node: "ScriptQA",
    status: state.scriptQA?.status,
    revisionAttempts: retryCount(state, "ScriptWriter"),
    qaAttempts: retryCount(state, "ScriptQA"),
    repeated: state.scriptQA?.repeated,
    infraMax: SCRIPT_QA_MAX_RETRIES,
  });
  if (decision.action === "continue") return "VisualDirector";
  if (decision.action === "revise") return "ScriptWriter";
  if (decision.action === "retry") return "ScriptQA";
  return FINALIZE;
};

const promptRouter = (state: typeof StateAnnotation.State) => {
  const status = state.production?.promptQA?.status;
  // Major revisions trace back to the visual plan (VisualDirector); minor and
  // fatal revisions regenerate the prompts (ImagePromptGenerator). Each uses
  // its own producer's run counter.
  const planIssue = status === "major_revision";
  const decision = decideQaRetry({
    node: "PromptQA",
    status,
    revisionAttempts: retryCount(
      state,
      planIssue ? "VisualDirector" : "ImagePromptGenerator",
    ),
    qaAttempts: retryCount(state, "PromptQA"),
    repeated: state.production?.promptQA?.repeated,
    infraMax: PROMPT_QA_MAX_RETRIES,
  });
  if (decision.action === "continue") return "AssetGenerator";
  if (decision.action === "revise")
    return planIssue ? "VisualDirector" : "ImagePromptGenerator";
  if (decision.action === "retry") return "PromptQA";
  return FINALIZE;
};

/**
 * VisualDirector edge: on success (scenes present) fan out to the parallel
 * Metadata/Thumbnail branches, which rejoin the production spine at the
 * BranchJoin barrier before AssetStrategy. On a hard structural validation
 * failure the node emits directorReview = minor_revision, so retry
 * VisualDirector with the feedback within the minor budget; when no scenes
 * exist after the budget the run fails through the shared terminal.
 * Metadata/Thumbnail therefore never start unless the visual plan succeeded.
 */
const visualDirectorRouter = (state: typeof StateAnnotation.State) => {
  if (hasScenes(state)) return POST_VD_FANOUT;
  const review = state.production?.directorReview;
  const decision = decideQaRetry({
    node: "VisualDirector",
    status: review?.status,
    revisionAttempts: retryCount(state, "VisualDirector"),
    qaAttempts: 0,
    infraMax: PROMPT_QA_MAX_RETRIES,
  });
  if (decision.action === "revise") return "VisualDirector";
  return FINALIZE;
};

/**
 * Metadata/Thumbnail synchronization barrier. LangGraph fires a node when ANY
 * incoming edge delivers, so BranchJoin runs once per completed branch:
 * - Both branches finish in the SAME superstep: LangGraph coalesces the
 *   triggers into ONE BranchJoin execution, which sees the full pair and
 *   releases the spine at AssetStrategy.
 * - Branches finish in DIFFERENT supersteps: the first firing sees a half
 *   pair. There is no "wait" routing target in a StateGraph, so it dead-ends
 *   that branch via __end__ WITHOUT touching execution.status; the graph stays
 *   alive because the other branch's task is still pending, and its completion
 *   re-fires BranchJoin with the full pair.
 * A branch that FAILED never reaches here (its guard routed to Finalize), so
 * the barrier can only release on a complete, healthy pair.
 */
const branchJoinRouter = (state: typeof StateAnnotation.State) => {
  if (hasMetadata(state) && hasThumbnail(state)) return "AssetStrategy";
  logger.debug("BranchJoin waiting for remaining parallel branch");
  return "__end__";
};

const finalRouter = (state: typeof StateAnnotation.State) => {
  const status = state.releaseReview?.status;

  logger.debug("ReleaseReview router", { status });

  // Single-shot release review: approved advances, anything else (fatal or a
  // missing decision) fails the run through the shared terminal.
  return status === "approved" ? "PublishReady" : FINALIZE;
};

/**
 * PublishReady has a single incoming edge (ReleaseReview approval), so it
 * fires exactly once with the spine complete and the parallel
 * Metadata/Thumbnail branches long finished. It advances to Publisher only
 * when the full package exists AND its operational gate passed; a blocked
 * gate (or any other non-ready outcome) is a terminal failure.
 */
const publishReadyRouter = (state: typeof StateAnnotation.State) => {
  if (hasPublishablePackage(state) && hasPublishReady(state))
    return "Publisher";
  return FINALIZE;
};

/**
 * Shared terminal node. Resolves to the single centralized definition of
 * complete (Publisher produced a result for every platform) vs failed (every
 * other terminal: fail-closed guard, QA budget exhaustion, blocked publish
 * gate, fatal review). Writes execution.status so the launcher can distinguish
 * "the run finished" from "the LangGraph server is still alive".
 */
function finalizeNode(state: GuardState): {
  execution: {
    currentNode: string;
    status: "complete" | "failed";
    finishedAt: string;
  };
  diagnostics: { errors?: string[] };
} {
  const failed = isRunFailed(state);
  const hasErrors = (state.diagnostics?.errors?.length ?? 0) > 0;
  return {
    execution: {
      currentNode: FINALIZE,
      status: failed ? "failed" : "complete",
      finishedAt: new Date().toISOString(),
    },
    diagnostics:
      failed && !hasErrors
        ? { errors: [`Run failed: ${runFailureReason(state)}`] }
        : {},
  };
}

const needsPromptRepair = (state: GuardState) =>
  (state.production?.scenes ?? []).some(isAwaitingRepair);

/**
 * Provider-failure recovery router. Non-retryable provider rejections
 * (content_policy / invalid_prompt) route to ImagePromptRepair within the
 * repair budget; fully-resolved scene sets advance. `unknown` is FATAL (never
 * repaired): an unclassifiable failure could hide an authentication or
 * infrastructure problem. A scene whose repair budget is exhausted or a
 * provider outage stays unresolved and the pipeline halts fail-closed
 * (hasSceneAssets requires EVERY scene to have an asset).
 */
const assetRouter = (state: typeof StateAnnotation.State) => {
  if (needsPromptRepair(state)) {
    logger.debug("AssetGenerator router: routing rejected prompts to repair", {
      scenes: (state.production?.scenes ?? [])
        .filter((s) => s.generationStatus === "prompt_repair")
        .map((s) => ({ sceneId: s.sceneId, repairs: s.repairCount ?? 0 })),
    });
    return "ImagePromptRepair";
  }
  if (hasSceneAssets(state)) return "NarrationGenerator";
  logger.warn("AssetGenerator router: unresolved scenes, terminating", {
    scenes: (state.production?.scenes ?? []).map((s) => ({
      sceneId: s.sceneId,
      status: s.generationStatus,
      failureType: s.failureType,
    })),
  });
  return FINALIZE;
};

/**
 * ImagePromptRepair exit: always returns to AssetGenerator so repaired
 * prompts are re-issued. Only when every scene already has an asset does it
 * advance (defensive; repair only touches scenes that lack assets).
 */
const repairRouter = (state: typeof StateAnnotation.State) => {
  if (hasSceneAssets(state)) return "NarrationGenerator";
  return "AssetGenerator";
};

const builder = new StateGraph(StateAnnotation)
  .addNode("ResearchAgent", researchAgentNode)
  .addNode("ResearchQA", researchQANode)
  .addNode("ScriptPlanner", scriptPlannerNode)
  .addNode("ScriptWriter", scriptWriterNode)
  .addNode("ScriptQA", scriptQANode)
  .addNode("MetadataGenerator", metadataGeneratorNode)
  .addNode("ThumbnailGenerator", thumbnailGeneratorNode)
  .addNode("VisualDirector", visualDirectorNode)
  .addNode("BranchJoin", () => ({}))
  .addNode("AssetStrategy", assetStrategyNode)
  .addNode("ImagePromptGenerator", imagePromptGeneratorNode)
  .addNode("PromptQA", promptQANode)
  .addNode("AssetGenerator", assetGeneratorNode)
  .addNode("ImagePromptRepair", imagePromptRepairNode)
  .addNode("NarrationGenerator", narrationGeneratorNode)
  .addNode("SubtitleGenerator", subtitleGeneratorNode)
  .addNode("VideoComposer", videoComposerNode)
  .addNode("ReleaseValidation", releaseValidationNode)
  .addNode("ReleaseReview", releaseReviewNode)
  .addNode("PublishReady", publishReadyNode)
  .addNode("Publisher", publisherNode)
  .addNode(FINALIZE, finalizeNode);

builder
  .addEdge("__start__", "ResearchAgent")
  .addConditionalEdges("ResearchAgent", guard(hasResearch, "ResearchQA"))
  .addConditionalEdges("ResearchQA", researchRouter)
  .addConditionalEdges("ScriptPlanner", guard(hasStoryPlan, "ScriptWriter"))
  .addConditionalEdges("ScriptWriter", guard(hasScript, "ScriptQA"))
  .addConditionalEdges("ScriptQA", scriptRouter);

// VisualDirector gates the parallel branches: ScriptQA approval runs
// VisualDirector alone; its success fans out to Metadata/Thumbnail, which run
// in parallel and synchronize at BranchJoin — the barrier releases the
// production spine (AssetStrategy) only once BOTH outputs exist. A branch
// that fails routes to Finalize via its guard, so BranchJoin can never
// release with a half pair and Publisher can never fire with a partial
// package. The spine guards remain: a node only advances when it produced
// the output the next node needs.
builder
  .addConditionalEdges("MetadataGenerator", guard(hasMetadata, "BranchJoin"))
  .addConditionalEdges(
    "ThumbnailGenerator",
    guard(hasThumbnail, "BranchJoin"),
  )
  .addConditionalEdges("BranchJoin", branchJoinRouter)
  .addConditionalEdges("VisualDirector", visualDirectorRouter)
  .addConditionalEdges(
    "AssetStrategy",
    guard(hasScenes, "ImagePromptGenerator"),
  )
  .addConditionalEdges(
    "ImagePromptGenerator",
    guard(hasScenePrompts, "PromptQA"),
  )
  .addConditionalEdges("PromptQA", promptRouter)
  .addConditionalEdges("AssetGenerator", assetRouter)
  .addConditionalEdges("ImagePromptRepair", repairRouter)
  .addConditionalEdges(
    "NarrationGenerator",
    guard(hasNarration, "SubtitleGenerator"),
  )
  .addConditionalEdges(
    "SubtitleGenerator",
    guard(hasSubtitles, "VideoComposer"),
  )
  .addConditionalEdges("VideoComposer", guard(hasVideo, "ReleaseValidation"))
  .addConditionalEdges(
    "ReleaseValidation",
    guard(hasPassedValidation, "ReleaseReview"),
  )
  .addConditionalEdges("ReleaseReview", finalRouter)
  .addConditionalEdges("PublishReady", publishReadyRouter);

builder.addEdge("Publisher", FINALIZE);
builder.addEdge(FINALIZE, "__end__");

export const graph = builder.compile();

graph.name = "YouTubeShortsPipeline";
