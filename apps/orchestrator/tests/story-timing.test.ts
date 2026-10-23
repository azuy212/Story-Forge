import { describe, it, expect } from "@jest/globals";
import { computeSceneTimings, validateTimings } from "../src/story/timing.js";
import { isPipelineError } from "../src/utils/errors.js";

const chunks = (...durations: number[]) =>
  durations.map((durationSec, index) => ({ sceneId: index + 1, durationSec }));

describe("story computeSceneTimings", () => {
  it("derives frame counts from cumulative boundaries, not per-scene rounding", () => {
    const result = computeSceneTimings({
      chunks: chunks(7.6, 7.2, 7.2, 8.4),
      gapMs: 200,
      fps: 30,
      audioDurationSec: 31.2,
    });

    // starts: 0, 7.8, 15.2, 22.6 → boundaries 0, 234, 456, 678, ceil(31.2*30)=936
    expect(result.frames).toEqual([234, 222, 222, 258]);
    expect(result.totalFrames).toBe(936);
    expect(result.frames.reduce((sum, value) => sum + value, 0)).toBe(936);
    expect(result.timings.map((timing) => [timing.start, timing.end])).toEqual([
      [0, 7.8],
      [7.8, 15.2],
      [15.2, 22.6],
      [22.6, 31.2],
    ]);
    expect(result.videoDurationSec).toBe(31.2);
    expect(result.timings.every((timing) => timing.method === "measured")).toBe(
      true,
    );
  });

  it("would drift if each scene were rounded independently", () => {
    const result = computeSceneTimings({
      chunks: chunks(1, 1),
      gapMs: 100,
      fps: 24,
      audioDurationSec: 2.2,
    });
    // Boundaries: 0, round(1.1*24)=26, ceil(2.2*24)=53.
    expect(result.frames).toEqual([26, 27]);
    expect(result.totalFrames).toBe(53);
    // round(1*24) per scene would give 48 frames and lose five of them.
    expect(result.frames).not.toEqual([24, 24]);
  });

  it("guarantees at least one frame per scene for a degenerate chunk", () => {
    const result = computeSceneTimings({
      chunks: chunks(0, 1),
      gapMs: 0,
      fps: 30,
      audioDurationSec: 1,
    });
    expect(result.frames).toEqual([1, 29]);
    expect(result.timings[0]).toMatchObject({ startFrame: 0, endFrame: 1 });
    expect(result.timings[1]).toMatchObject({ startFrame: 1, endFrame: 30 });
  });

  it("covers the audio for a single scene", () => {
    const result = computeSceneTimings({
      chunks: chunks(5),
      gapMs: 200,
      fps: 30,
      audioDurationSec: 5.2,
    });
    expect(result.frames).toEqual([156]);
    expect(result.timings[0]).toMatchObject({ start: 0, end: 5.2 });
  });

  it("rejects an empty chunk list or invalid fps/audio duration", () => {
    const bad = (options: Parameters<typeof computeSceneTimings>[0]) => {
      try {
        computeSceneTimings(options);
        return undefined;
      } catch (error) {
        return error;
      }
    };

    expect(
      isPipelineError(
        bad({ chunks: [], gapMs: 200, fps: 30, audioDurationSec: 5 }),
      ),
    ).toBe(true);
    expect(
      isPipelineError(
        bad({ chunks: chunks(1), gapMs: 0, fps: 0, audioDurationSec: 1 }),
      ),
    ).toBe(true);
    expect(
      isPipelineError(
        bad({ chunks: chunks(1), gapMs: 0, fps: 30, audioDurationSec: 0 }),
      ),
    ).toBe(true);
  });
});

describe("story validateTimings", () => {
  const good = computeSceneTimings({
    chunks: chunks(7.6, 7.2),
    gapMs: 200,
    fps: 30,
    audioDurationSec: 15.2,
  });

  it("accepts a contiguous measured timeline that covers the audio", () => {
    expect(
      validateTimings(good.timings, { fps: 30, audioDurationSec: 15.2 }),
    ).toEqual([]);
  });

  it("rejects a first scene that does not start at frame 0", () => {
    const shifted = [{ ...good.timings[0], startFrame: 5 }, good.timings[1]];
    expect(
      validateTimings(shifted, { fps: 30, audioDurationSec: 15.2 }).map(
        (issue) => issue.message,
      ),
    ).toContain("first scene must start at frame 0, got 5");
  });

  it("rejects a gap between scenes", () => {
    const broken = [good.timings[0], { ...good.timings[1], startFrame: 999 }];
    expect(
      validateTimings(broken, { fps: 30, audioDurationSec: 15.2 }).map(
        (issue) => issue.message,
      ),
    ).toContain("scene 2 starts at frame 999 but scene 1 ended at frame 234");
  });

  it("rejects a zero-length scene and a timeline shorter than the audio", () => {
    const zero = [{ ...good.timings[0], endFrame: 0 }];
    expect(
      validateTimings(zero, { fps: 30, audioDurationSec: 1 }).map(
        (issue) => issue.message,
      ),
    ).toContain("scene 1 has non-positive duration (0→0)");

    const short = [good.timings[0]];
    expect(
      validateTimings(short, { fps: 30, audioDurationSec: 15.2 }).map(
        (issue) => issue.message,
      ),
    ).toContain("timeline ends at frame 234 but the audio needs 456 frames");
  });

  it("rejects an empty timeline", () => {
    expect(validateTimings([], { fps: 30, audioDurationSec: 1 })).toEqual([
      { message: "no scene timings" },
    ]);
  });
});
