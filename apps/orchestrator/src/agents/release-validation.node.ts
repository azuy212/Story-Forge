import type { RunnableConfig } from "@langchain/core/runnables";
import type { ProjectState, Diagnostics, Execution } from "../types/index.js";
import { AgentModel } from "../types/index.js";
import { config as configUtils } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { nodeLabel } from "../utils/node-labels.js";
import { parseSrtCues } from "../utils/srt.js";
import {
  probe as defaultProbe,
  type FfprobeResult,
} from "../providers/composer/ffmpeg/ffmpeg.js";
import { AUDIO_DURATION_TOLERANCE_MS } from "../utils/constants.js";

const PROBE_TOLERANCE_MS = 250;
const FIRST_CUE_START_MAX_MS = 1000;
const SUBTITLE_OVERRUN_EPSILON_MS = 500;
const SCENE_SUM_TOLERANCE_MS = 500;
const MIN_PACE_SAMPLE_MS = 10_000;

export type ReleaseProbe = (input: string) => Promise<FfprobeResult>;

export interface ValidatePackageResult {
  status: "approved" | "fatal";
  issues: string[];
  validations: string[];
  warnings: string[];
}

export async function validatePackage(
  state: ProjectState,
  probe: ReleaseProbe = defaultProbe,
): Promise<ValidatePackageResult> {
  const issues: string[] = [];
  const validations: string[] = [];
  const warnings: string[] = [];

  const check = (ok: boolean, label: string, detail?: string) => {
    if (ok) validations.push(label);
    else issues.push(detail ? `${label}: ${detail}` : label);
  };

  const scenes = state.production?.scenes ?? [];
  const estimated = state.content?.estimatedDurationSeconds;
  const narrationMs =
    state.audio?.combinedAudio?.durationMs ?? state.audio?.narrationDurationMs;
  const timeline = state.video?.timeline;

  // --- Artifact existence ---
  check(!!state.video?.videoUrl, "Final video exists");
  check(!!state.audio?.narrationUrl, "Narration audio exists");
  check(
    !!state.subtitles?.srt && state.subtitles.srt.trim().length > 0,
    "SRT subtitles present",
  );

  // --- Scene audio manifest ---
  const audioScenes = state.audio?.scenes ?? [];
  const combinedAudio = state.audio?.combinedAudio;
  check(
    state.audio?.version === 2,
    "Audio manifest version is 2",
    `received ${state.audio?.version ?? "missing"}`,
  );
  if (audioScenes.length > 0 || combinedAudio) {
    const productionIds = scenes.map((scene) => scene.sceneId);
    const audioIds = audioScenes.map((scene) => scene.sceneId);
    const artifactIds = audioScenes.map((scene) => scene.artifactId);
    const sourceIds = combinedAudio?.sourceSceneArtifactIds ?? [];
    const uniqueAudioIds = new Set(audioIds);
    const uniqueProductionIds = new Set(productionIds);

    check(
      audioScenes.length === scenes.length,
      "Scene audio count matches production",
      `audio ${audioScenes.length} vs production ${scenes.length}`,
    );
    check(
      uniqueAudioIds.size === audioIds.length,
      "Scene audio IDs are unique",
    );
    check(
      uniqueProductionIds.size === productionIds.length,
      "Production scene IDs are unique",
    );
    check(
      productionIds.every((id, index) => id === audioIds[index]),
      "Scene audio order matches production",
    );
    check(
      artifactIds.every(
        (id): id is string => typeof id === "string" && id.length > 0,
      ),
      "Scene audio artifact IDs present",
    );
    check(
      sourceIds.length === artifactIds.length &&
        sourceIds.every((id, index) => id === artifactIds[index]),
      "Combined audio sources match scene artifacts",
    );

    if (combinedAudio) {
      const sceneDurationMs = audioScenes.reduce(
        (sum, scene) => sum + scene.durationMs,
        0,
      );
      check(
        Math.abs(combinedAudio.durationMs - sceneDurationMs) <=
          AUDIO_DURATION_TOLERANCE_MS,
        "Combined audio duration matches scene audio",
        `combined ${combinedAudio.durationMs}ms vs scenes ${sceneDurationMs}ms`,
      );
    }
  }
  check(!!state.content?.title, "Title present");

  const meta = state.metadataOutput;
  check(
    !!meta?.title && !!meta?.description && (meta?.tags?.length ?? 0) > 0,
    "Metadata fields present",
  );
  if (configUtils.enableThumbnail()) {
    check(!!state.thumbnail?.thumbnailPrompt, "Thumbnail prompt present");
    check(!!state.thumbnail?.imageUrl, "Thumbnail image exists");
  }

  const missingAssets = scenes.filter((s) => !s.assetUrl);
  check(
    missingAssets.length === 0,
    "All scene assets exist",
    missingAssets.length > 0
      ? `IDs: ${missingAssets.map((s) => s.sceneId).join(", ")}`
      : undefined,
  );

  const emptyPrompts = scenes.filter((s) => !s.generationPrompt);
  check(
    emptyPrompts.length === 0,
    "All scene prompts present",
    emptyPrompts.length > 0
      ? `IDs: ${emptyPrompts.map((s) => s.sceneId).join(", ")}`
      : undefined,
  );

  // --- Scene timing ---
  if (scenes.length > 0) {
    const sum = scenes.reduce((acc, s) => acc + (s.durationSeconds ?? 0), 0);
    if (narrationMs && narrationMs > 0) {
      check(
        Math.abs(sum * 1000 - narrationMs) <= SCENE_SUM_TOLERANCE_MS,
        "Scene durations sum to narration",
        `sum ${sum}s vs narration ${(narrationMs / 1000).toFixed(2)}s`,
      );
    } else {
      check(
        Math.abs(sum - (estimated ?? 0)) <= SCENE_SUM_TOLERANCE_MS / 1000,
        "Scene durations sum to target",
        `sum ${sum}s vs target ${estimated}s`,
      );
    }

    const contiguous =
      scenes[0]?.startSecond === 0 &&
      scenes.every(
        (s, i) => i === 0 || s.startSecond === scenes[i - 1].endSecond,
      );
    check(contiguous, "Scenes contiguous");
  }

  // --- Subtitles ---
  const cues = parseSrtCues(state.subtitles?.srt ?? "");
  if (cues.length > 0) {
    check(cues.length > 0, "Subtitle cue count > 0");

    check(
      cues[0].startMs <= FIRST_CUE_START_MAX_MS,
      "First subtitle starts near zero",
      `starts at ${cues[0].startMs}ms`,
    );

    let monotonic = true;
    let overlap = false;
    for (let i = 0; i < cues.length; i++) {
      const c = cues[i];
      if (c.startMs >= c.endMs) {
        monotonic = false;
        issues.push(
          `Subtitle cue ${c.index}: start (${c.startMs}ms) not before end (${c.endMs}ms)`,
        );
        break;
      }
      if (i > 0 && c.startMs < cues[i - 1].endMs) {
        overlap = true;
      }
    }
    check(monotonic, "Subtitle timestamps monotonic");
    check(!overlap, "Subtitle cues do not overlap");

    if (narrationMs) {
      const lastEnd = cues[cues.length - 1].endMs;
      check(
        lastEnd <= narrationMs + SUBTITLE_OVERRUN_EPSILON_MS,
        "Subtitle end within narration",
        `last cue ends ${lastEnd}ms vs narration ${narrationMs}ms`,
      );
    }
  } else if (state.subtitles?.srt) {
    issues.push("SRT subtitles unparsable");
  }

  // --- Subtitle text vs narration (semantic, not byte-exact) ---
  // Subtitle text is derived from the narration; a transcription provider
  // that drifts from it would silently change what the viewer reads. Compare
  // normalized token overlap instead of exact equality so harmless
  // formatting/segmentation differences pass.
  if (cues.length > 0 && state.content?.narration) {
    const narrationWords = state.content.narration
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean);
    const subWords = cues
      .flatMap((c) => c.text)
      .join(" ")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean);
    if (narrationWords.length > 0 && subWords.length > 0) {
      const subSet = new Set(subWords);
      const covered = narrationWords.filter((w) => subSet.has(w)).length;
      const overlap = covered / narrationWords.length;
      check(
        overlap >= 0.95,
        "Subtitle text matches narration",
        `${(overlap * 100).toFixed(1)}% of narration words appear in subtitles`,
      );
    }
  }

  // --- Narration pace (best-effort warning; not fatal) ---
  if (narrationMs && narrationMs >= MIN_PACE_SAMPLE_MS) {
    const words = (state.content?.narration ?? "")
      .split(/\s+/)
      .filter(Boolean).length;
    if (words > 0) {
      const wps = (words / narrationMs) * 1000;
      if (wps < 2.4 || wps > 2.8) {
        warnings.push(`Narration pace ${wps.toFixed(2)} wps outside 2.4-2.8`);
      } else {
        validations.push("Narration pace 2.4-2.8 wps");
      }
    }
  }

  // --- Media streams (best-effort probe) ---
  const videoUrl = state.video?.videoUrl;
  if (videoUrl) {
    try {
      const info = await probe(videoUrl);
      check(info.duration > 0, "Video duration > 0");
      check(info.hasVideo, "Video stream exists");
      check(info.hasAudio, "Audio stream exists");
      check(
        info.width > 0 && info.height > 0,
        "Resolution sane",
        `${info.width}x${info.height}`,
      );
      check(info.fps > 0, "FPS > 0", String(info.fps));

      if (state.video?.resolution) {
        const [w, h] = state.video.resolution.split("x").map(Number);
        check(
          w === info.width && h === info.height,
          "Resolution matches expected",
          `${info.width}x${info.height} vs expected ${w}x${h}`,
        );
      }

      if (timeline) {
        check(
          timeline.durationMs > 0 &&
            timeline.narrativeDurationMs >= 0 &&
            timeline.narrativeHoldMs >= 0 &&
            timeline.outroDurationMs >= 0,
          "Composer timeline metadata present",
        );
        const actualMs = Math.round(info.duration * 1000);
        check(
          Math.abs(actualMs - timeline.durationMs) <= PROBE_TOLERANCE_MS,
          "Video duration matches composer timeline",
          `${actualMs}ms vs timeline ${timeline.durationMs}ms`,
        );
      } else if (narrationMs) {
        const actualMs = Math.round(info.duration * 1000);
        check(
          Math.abs(actualMs - narrationMs) <= PROBE_TOLERANCE_MS,
          "Video duration ≈ narration",
          `${actualMs}ms vs ${narrationMs}ms`,
        );
      }
    } catch {
      warnings.push("Media probe unavailable — stream checks skipped");
      validations.push("Media probe skipped (best-effort)");
    }
  }

  return {
    status: issues.length === 0 ? "approved" : "fatal",
    issues,
    validations,
    warnings,
  };
}

function getProbe(config: RunnableConfig): ReleaseProbe {
  const inject = (config.configurable ?? {}) as Record<string, unknown>;
  return (inject.probe as ReleaseProbe | undefined) ?? defaultProbe;
}

export async function releaseValidationNode(
  state: ProjectState,
  config: RunnableConfig,
): Promise<{
  releaseValidation: {
    status: "approved" | "fatal";
    issues?: string[];
    validations?: string[];
  };
  diagnostics: Partial<Diagnostics>;
  execution: Partial<Execution>;
}> {
  const startedAt = Date.now();
  const label = nodeLabel(AgentModel.ReleaseValidation);
  logger.nodeStart(label);

  if (!configUtils.enableReleaseQA()) {
    logger.nodeSkipped(label, "release QA disabled");
    return {
      releaseValidation: {
        status: "approved",
        issues: [],
        validations: [],
      },
      diagnostics: {},
      execution: {},
    };
  }

  logger.nodePhase(label, "validating release package");

  const result = await validatePackage(state, getProbe(config));

  if (result.status === "fatal") {
    logger.nodeFailed(label, `${result.issues?.length ?? 0} issues`);
  } else {
    logger.nodeDone(label, Date.now() - startedAt);
  }

  return {
    releaseValidation: result,
    diagnostics: {
      ...(result.status === "fatal"
        ? {
            errors: result.issues ?? [
              `${AgentModel.ReleaseValidation}: validation failed`,
            ],
          }
        : {}),
      warnings: result.warnings,
    },
    execution: { currentNode: AgentModel.ReleaseValidation },
  };
}
