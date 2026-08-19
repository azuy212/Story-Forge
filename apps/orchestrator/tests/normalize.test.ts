import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import { DEFAULT_MAX_RETRIES } from "../src/utils/constants.js";

jest.unstable_mockModule("../src/providers/composer/ffmpeg/ffmpeg.js", () => ({
  runFfmpeg: jest.fn(() => Promise.resolve()),
  runFfmpegWithRetry: jest.fn(() => Promise.resolve()),
}));

const { normalizeAsset, isImage, staticScaleFilter, PAN_PRESET_COUNT } =
  await import("../src/providers/composer/ffmpeg/normalize.js");
const { runFfmpegWithRetry } =
  await import("../src/providers/composer/ffmpeg/ffmpeg.js");

const mockRunFfmpegWithRetry = runFfmpegWithRetry as unknown as jest.Mock;

const BASE_OPTS = {
  width: 1080,
  height: 1920,
  fps: 30,
  kenBurnsEnabled: true,
  kenBurnsMaxZoom: 1.15,
  fastSeek: true,
  encoder: { name: "test", encoder: "libx264", crf: 23, preset: "medium" },
};

function vfFromArgs(args: string[]): string {
  const idx = args.indexOf("-vf");
  return idx >= 0 ? args[idx + 1] : "";
}

function lastCallArgs(): string[] {
  // runFfmpegWithRetry(args, description, maxRetries, ...) — first arg is the
  // args array itself.
  const call = mockRunFfmpegWithRetry.mock.calls.at(-1)?.[0];
  return Array.isArray(call) ? (call as string[]) : [];
}

beforeEach(() => {
  mockRunFfmpegWithRetry.mockClear();
});

describe("isImage", () => {
  it("detects image extensions", () => {
    expect(isImage("scene.png")).toBe(true);
    expect(isImage("scene.JPG")).toBe(true);
    expect(isImage("scene.avif")).toBe(true);
  });

  it("rejects non-image paths", () => {
    expect(isImage("scene.mp4")).toBe(false);
    expect(isImage("scene.mov")).toBe(false);
    expect(isImage("scene")).toBe(false);
  });
});

describe("normalizeAsset Ken Burns (image)", () => {
  it("derives zoom step from clip length so every clip reaches maxZoom on its last frame", async () => {
    await normalizeAsset("input.png", "out.mp4", 10, 0, { ...BASE_OPTS });
    const filter = vfFromArgs(lastCallArgs());

    // 10s * 30fps = 300 output frames.
    expect(filter).toContain("d=300");
    // Uses smoothstep interpolation: progress = 3*t^2 - 2*t^3
    // zoom = 1 + (maxZoom - 1) * progress
    expect(filter).toContain("z='1+(");
    expect(filter).toContain("1.15-1"); // maxZoom value in the expression
    expect(filter).toContain("pow("); // smoothstep uses pow
  });

  it("uses canonical zoompan with -loop, emitting d=frames from a single input frame", async () => {
    await normalizeAsset("input.png", "out.mp4", 5, 0, { ...BASE_OPTS });
    const args = lastCallArgs();
    const filter = vfFromArgs(args);

    // Image input requires -loop 1 to repeat the single frame
    expect(args).toContain("-loop");
    expect(args).toContain("1");
    expect(filter).toContain(`d=${5 * BASE_OPTS.fps}`);
    expect(filter).toContain(`s=${BASE_OPTS.width}x${BASE_OPTS.height}`);
    expect(filter).toContain(`fps=${BASE_OPTS.fps}`);
    expect(args.at(-1)).toBe("out.mp4");
  });

  it("fills (cover/crop) the canvas before zoom — no padding, no duplicate fps", async () => {
    await normalizeAsset("input.png", "out.mp4", 4, 0, { ...BASE_OPTS });
    const filter = vfFromArgs(lastCallArgs());

    // Scale up to 2x then crop via zoompan's s= parameter
    expect(filter).toContain("force_original_aspect_ratio=increase");
    expect(filter).toContain(`s=${BASE_OPTS.width}x${BASE_OPTS.height}`);
    expect(filter).not.toContain("pad=");
    // fps appears exactly once — inside zoompan, not in the pre-filter.
    expect(filter.match(/fps=30/g)).toHaveLength(1);
  });

  it("pans center by default", async () => {
    await normalizeAsset("input.png", "out.mp4", 4, 0, { ...BASE_OPTS });
    const filter = vfFromArgs(lastCallArgs());

    expect(filter).toContain("x='iw/2-(iw/zoom/2)'");
    expect(filter).toContain("y='ih/2-(ih/zoom/2)'");
    // panVariant 0 (center) doesn't use progress/on in x/y
    expect(filter).not.toContain("(on/");
  });

  it("panVariant selects distinct pan directions, deterministically", async () => {
    await normalizeAsset("input.png", "out.mp4", 4, 0, {
      ...BASE_OPTS,
      panVariant: 1,
    });
    const leftRight = vfFromArgs(lastCallArgs());
    // Uses smoothstep progress: x = (iw-iw/zoom) * progress
    expect(leftRight).toContain("x='(iw-iw/zoom)*");
    expect(leftRight).toContain("pow("); // smoothstep uses pow

    await normalizeAsset("input.png", "out.mp4", 4, 0, {
      ...BASE_OPTS,
      panVariant: 2,
    });
    const rightLeft = vfFromArgs(lastCallArgs());
    expect(rightLeft).toContain("x='(iw-iw/zoom)*");
    expect(rightLeft).toContain("pow(");
    expect(rightLeft).not.toBe(leftRight);

    await normalizeAsset("input.png", "out.mp4", 4, 0, {
      ...BASE_OPTS,
      panVariant: 3,
    });
    const topBottom = vfFromArgs(lastCallArgs());
    expect(topBottom).toContain("y='(ih-ih/zoom)*");
    expect(topBottom).toContain("pow(");

    // Same variant is stable.
    await normalizeAsset("input.png", "out.mp4", 4, 0, {
      ...BASE_OPTS,
      panVariant: 1,
    });
    expect(vfFromArgs(lastCallArgs())).toBe(leftRight);
  });

  it("exposes a preset count", () => {
    expect(PAN_PRESET_COUNT).toBe(7);
  });
});

describe("normalizeAsset without Ken Burns (image)", () => {
  it("keeps contain+pad static framing and -loop", async () => {
    await normalizeAsset("input.png", "out.mp4", 4, 0, {
      ...BASE_OPTS,
      kenBurnsEnabled: false,
    });
    const args = lastCallArgs();
    const filter = vfFromArgs(args);

    expect(args).toContain("-loop");
    expect(filter).toContain("force_original_aspect_ratio=decrease");
    expect(filter).toContain(`pad=${BASE_OPTS.width}:${BASE_OPTS.height}`);
    expect(filter).not.toContain("zoompan");
  });
});

describe("normalizeAsset (video)", () => {
  it("keeps contain+pad, fastSeek trim, and no Ken Burns", async () => {
    await normalizeAsset("input.mp4", "out.mp4", 6, 3, { ...BASE_OPTS });
    const args = lastCallArgs();
    const filter = vfFromArgs(args);

    expect(args).toContain("-ss");
    expect(args).toContain("3");
    expect(filter).toContain("force_original_aspect_ratio=decrease");
    expect(filter).toContain(`pad=${BASE_OPTS.width}:${BASE_OPTS.height}`);
    expect(filter).not.toContain("zoompan");
  });

  it("uses configured retry budget for image and video normalization", async () => {
    await normalizeAsset("image.png", "image.mp4", 4, 0, { ...BASE_OPTS });
    await normalizeAsset("image.png", "image-static.mp4", 4, 0, {
      ...BASE_OPTS,
      kenBurnsEnabled: false,
    });
    await normalizeAsset("video.mp4", "video-normalized.mp4", 4, 0, {
      ...BASE_OPTS,
    });

    expect(mockRunFfmpegWithRetry.mock.calls.map((call) => call[2])).toEqual([
      DEFAULT_MAX_RETRIES,
      DEFAULT_MAX_RETRIES,
      DEFAULT_MAX_RETRIES,
    ]);
  });
});

describe("staticScaleFilter", () => {
  it("applies scale, pad, setsar, fps, format", () => {
    const filter = staticScaleFilter({ ...BASE_OPTS, kenBurnsEnabled: false });
    expect(filter).toContain(
      "scale=1080:1920:force_original_aspect_ratio=decrease",
    );
    expect(filter).toContain("pad=1080:1920");
    expect(filter).toContain("fps=30");
    expect(filter).toContain("format=yuv420p");
  });
});
