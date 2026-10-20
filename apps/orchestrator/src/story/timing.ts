import { PipelineError } from "../utils/errors.js";
import type { SceneTiming } from "./types.js";

/**
 * Scene timing derived from MEASURED narration chunk durations (DP2) and
 * snapped to the video frame grid.
 *
 * Timeline definition (documented so subtitles and images never disagree):
 *   - the narration chunk for scene i begins at `start_i`, which is the sum of
 *     every earlier chunk duration plus one inter-scene gap each;
 *   - scene i's still is held from `start_i` until `start_{i+1}`, so the gap
 *     reads as a short hold of the same image after the narration ends;
 *   - the last scene is held to the end of the audio (which includes the
 *     trailing gap), so the timeline covers `[0, audioDuration]` with no holes
 *     and no overlaps.
 *
 * Frame counts come from CUMULATIVE boundaries (`round(cum*fps)` differences),
 * never from `round(dur*fps)` per scene, so per-chunk rounding cannot
 * accumulate into visible drift.
 */

export interface SceneChunkDuration {
  sceneId: number;
  durationSec: number;
}

export interface TimingResult {
  timings: SceneTiming[];
  /** Frames per scene, aligned with `timings`. */
  frames: number[];
  audioDurationSec: number;
  videoDurationSec: number;
  totalFrames: number;
}

export function computeSceneTimings(options: {
  chunks: SceneChunkDuration[];
  gapMs: number;
  fps: number;
  /** Measured duration of the concatenated narration track. */
  audioDurationSec: number;
}): TimingResult {
  const { chunks, gapMs, fps, audioDurationSec } = options;
  if (chunks.length === 0) {
    throw new PipelineError(
      "Cannot compute scene timings without narration chunks",
      "STORY_TIMING_EMPTY",
    );
  }
  if (!Number.isFinite(fps) || fps <= 0) {
    throw new PipelineError(
      `Cannot compute scene timings with fps=${fps}`,
      "STORY_TIMING_INVALID",
    );
  }
  if (!Number.isFinite(audioDurationSec) || audioDurationSec <= 0) {
    throw new PipelineError(
      `Cannot compute scene timings with audioDurationSec=${audioDurationSec}`,
      "STORY_TIMING_INVALID",
    );
  }

  const gapSec = gapMs / 1000;
  const starts: number[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    starts.push(cursor);
    cursor += chunk.durationSec + gapSec;
  }

  const lastFrame = Math.max(chunks.length, Math.ceil(audioDurationSec * fps));
  const boundaries: number[] = [0];
  for (let index = 1; index < chunks.length; index++) {
    boundaries.push(Math.round(starts[index] * fps));
  }
  boundaries.push(lastFrame);

  // Enforce strictly increasing boundaries with at least one frame per scene so
  // a sliver chunk can never produce a zero-length or negative window.
  for (let index = 1; index < boundaries.length; index++) {
    boundaries[index] = Math.max(boundaries[index], boundaries[index - 1] + 1);
  }

  const timings: SceneTiming[] = [];
  const frames: number[] = [];
  for (let index = 0; index < chunks.length; index++) {
    const startFrame = boundaries[index];
    const endFrame = boundaries[index + 1];
    timings.push({
      start: round3(startFrame / fps),
      end: round3(endFrame / fps),
      startFrame,
      endFrame,
      method: "measured",
    });
    frames.push(endFrame - startFrame);
  }

  return {
    timings,
    frames,
    audioDurationSec: round3(audioDurationSec),
    videoDurationSec: round3(boundaries[boundaries.length - 1] / fps),
    totalFrames: boundaries[boundaries.length - 1],
  };
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface TimingValidationIssue {
  message: string;
}

export function validateTimings(
  timings: SceneTiming[],
  expected: { fps: number; audioDurationSec: number },
): TimingValidationIssue[] {
  const issues: TimingValidationIssue[] = [];
  if (timings.length === 0) {
    issues.push({ message: "no scene timings" });
    return issues;
  }

  if (timings[0].startFrame !== 0) {
    issues.push({
      message: `first scene must start at frame 0, got ${timings[0].startFrame}`,
    });
  }

  for (let index = 0; index < timings.length; index++) {
    const timing = timings[index];
    if (timing.endFrame <= timing.startFrame) {
      issues.push({
        message: `scene ${index + 1} has non-positive duration (${timing.startFrame}→${timing.endFrame})`,
      });
    }
    if (index > 0 && timing.startFrame !== timings[index - 1].endFrame) {
      issues.push({
        message: `scene ${index + 1} starts at frame ${timing.startFrame} but scene ${index} ended at frame ${timings[index - 1].endFrame}`,
      });
    }
  }

  const last = timings[timings.length - 1];
  const requiredFrames = Math.ceil(expected.audioDurationSec * expected.fps);
  if (last.endFrame < requiredFrames) {
    issues.push({
      message: `timeline ends at frame ${last.endFrame} but the audio needs ${requiredFrames} frames`,
    });
  }

  return issues;
}
