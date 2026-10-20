import { describe, it, expect } from "@jest/globals";
import {
  buildConcatList,
  buildNarrationConcatArgs,
  buildRenderArgs,
  buildRenderVideoFilter,
} from "../src/story/ffmpeg-args.js";
import { staticScaleFilter } from "../src/providers/composer/ffmpeg/normalize.js";
import type { NormalizeOptions } from "../src/providers/composer/ffmpeg/normalize.js";

const ENCODER: NormalizeOptions = {
  width: 1920,
  height: 1080,
  fps: 30,
  kenBurnsEnabled: false,
  kenBurnsMaxZoom: 1,
  encoder: { name: "story", encoder: "libx264", crf: 19, preset: "medium" },
};

describe("story buildConcatList", () => {
  it("quotes each path and repeats the last entry without a duration", () => {
    const list = buildConcatList([
      { path: "/jobs/a/scene-001.png", durationSec: 7.8 },
      { path: "/jobs/a/scene-002.png", durationSec: 7.4 },
    ]);

    expect(list).toBe(
      [
        "file '/jobs/a/scene-001.png'",
        "duration 7.800000",
        "file '/jobs/a/scene-002.png'",
        "duration 7.400000",
        "file '/jobs/a/scene-002.png'",
        "",
      ].join("\n"),
    );
  });

  it("escapes a single quote in a path so the demuxer cannot break out", () => {
    const list = buildConcatList([
      { path: "/jobs/it's here/scene-001.png", durationSec: 1 },
    ]);
    expect(list).toContain("file '/jobs/it'\\''s here/scene-001.png'");
  });

  it("returns nothing for no entries", () => {
    expect(buildConcatList([])).toBe("");
  });
});

describe("story buildNarrationConcatArgs", () => {
  it("pads between chunks only and concatenates in order", () => {
    const args = buildNarrationConcatArgs({
      chunkPaths: ["/a/1.wav", "/a/2.wav", "/a/3.wav"],
      gapMs: 200,
      outputPath: "/a/narration.wav",
    });

    expect(args.slice(0, 7)).toEqual([
      "-y",
      "-i",
      "/a/1.wav",
      "-i",
      "/a/2.wav",
      "-i",
      "/a/3.wav",
    ]);

    const filter = args[args.indexOf("-filter_complex") + 1];
    expect(filter).toContain(
      "[0:a]aformat=sample_rates=48000:channel_layouts=mono,apad=pad_dur=0.200[a0]",
    );
    // No pad after the last chunk: a trailing gap stretched the master (and
    // the last scene's image window) one gap past the final word.
    expect(filter).toContain(
      "[2:a]aformat=sample_rates=48000:channel_layouts=mono[a2]",
    );
    expect(filter.match(/apad/g)).toHaveLength(2);
    expect(filter).toContain("[a0][a1][a2]concat=n=3:v=0:a=1[out]");
    expect(args).toContain("pcm_s16le");
    expect(args[args.length - 1]).toBe("/a/narration.wav");
  });

  it("honours a custom sample rate", () => {
    const args = buildNarrationConcatArgs({
      chunkPaths: ["/a/1.wav"],
      gapMs: 0,
      outputPath: "/a/out.wav",
      sampleRate: 44100,
    });
    expect(args[args.indexOf("-filter_complex") + 1]).toContain(
      "sample_rates=44100",
    );
    expect(args[args.indexOf("-ar") + 1]).toBe("44100");
  });
});

describe("story buildRenderVideoFilter", () => {
  it("uses the shared cover-crop Lanczos chain with no padding", () => {
    const filter = buildRenderVideoFilter({
      width: 1920,
      height: 1080,
      fps: 30,
      crf: 19,
      preset: "medium",
    });

    expect(filter).toBe(
      staticScaleFilter({
        ...ENCODER,
        fit: "cover",
        scaleFlags: "lanczos",
      }),
    );
    expect(filter).toContain("force_original_aspect_ratio=increase");
    expect(filter).toContain("crop=1920:1080");
    expect(filter).not.toContain("pad=");
  });

  it("burns subtitles with an escaped path and no force_style", () => {
    const filter = buildRenderVideoFilter({
      width: 1920,
      height: 1080,
      fps: 30,
      crf: 19,
      preset: "medium",
      subtitlePath: "/jobs/a/subs: v1, take 2.ass",
    });

    expect(filter).toContain(
      "subtitles=filename=/jobs/a/subs\\: v1\\, take 2.ass",
    );
    expect(filter).not.toContain("force_style");
  });

  it("passes the font directory when one is configured", () => {
    const filter = buildRenderVideoFilter({
      width: 1920,
      height: 1080,
      fps: 30,
      crf: 19,
      preset: "medium",
      subtitlePath: "/a/subs.ass",
      fontsDir: "/a/fonts",
    });
    expect(filter).toContain(":fontsdir=/a/fonts");
  });
});

describe("story buildRenderArgs", () => {
  const args = buildRenderArgs({
    concatListPath: "/a/concat.txt",
    narrationPath: "/a/narration.wav",
    subtitlePath: "/a/subs.ass",
    outputPath: "/a/final.mp4",
    width: 1920,
    height: 1080,
    fps: 30,
    crf: 19,
    preset: "medium",
  });

  const valueAfter = (flag: string): string | undefined =>
    args[args.indexOf(flag) + 1];

  it("reads the image sequence from the concat demuxer and the audio separately", () => {
    expect(args.slice(0, 6)).toEqual([
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
    ]);
    expect(args.filter((argument) => argument === "-i")).toHaveLength(2);
    expect(args[args.indexOf("-i") + 1]).toBe("/a/concat.txt");
    expect(args[8]).toBe("/a/narration.wav");
  });

  it("encodes video exactly once (a single lossy pass)", () => {
    expect(args.filter((argument) => argument === "-c:v")).toHaveLength(1);
    expect(args.filter((argument) => argument === "-vf")).toHaveLength(1);
    expect(args).not.toContain("segment");
    expect(args.filter((argument) => argument === "-c:a")).toHaveLength(1);
  });

  it("burns subtitles in the same encode and maps both streams", () => {
    expect(valueAfter("-vf")).toContain("subtitles=filename=/a/subs.ass");
    expect(args).toContain("-map");
    expect(args[args.indexOf("-map") + 1]).toBe("0:v:0");
    expect(args.lastIndexOf("-map")).toBeGreaterThan(args.indexOf("-map"));
    expect(args[args.lastIndexOf("-map") + 1]).toBe("1:a:0");
    expect(args).toContain("-shortest");
    expect(args[args.indexOf("-shortest") + 1]).toBe("-movflags");
  });

  it("sets the delivery encoding knobs", () => {
    expect(valueAfter("-c:v")).toBe("libx264");
    expect(valueAfter("-crf")).toBe("19");
    expect(valueAfter("-preset")).toBe("medium");
    expect(valueAfter("-pix_fmt")).toBe("yuv420p");
    expect(valueAfter("-r")).toBe("30");
    expect(valueAfter("-c:a")).toBe("aac");
    expect(valueAfter("-b:a")).toBe("192k");
    expect(valueAfter("-ar")).toBe("48000");
    expect(valueAfter("-ac")).toBe("2");
    expect(args).toContain("+faststart");
    expect(args[args.length - 1]).toBe("/a/final.mp4");
  });

  it("omits the subtitle filter when no subtitles are supplied", () => {
    const plain = buildRenderArgs({
      concatListPath: "/a/concat.txt",
      narrationPath: "/a/narration.wav",
      outputPath: "/a/final.mp4",
      width: 1920,
      height: 1080,
      fps: 30,
      crf: 19,
      preset: "medium",
    });
    expect(plain[plain.indexOf("-vf") + 1]).not.toContain("subtitles");
  });
});
