import { afterAll, describe, it, expect } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  SynthesizeOptions,
  TTSProvider,
} from "../src/providers/tts-provider.js";
import {
  findVoiceOutliers,
  runAudioStage,
  splitForTts,
  trimEdgeSilence,
} from "../src/story/audio.js";
import { concatNarrationWithGaps } from "../src/story/ffmpeg-args.js";
import { detectSilence } from "../src/story/media.js";
import { resolveStoryConfig } from "../src/story/config.js";
import { jobPaths } from "../src/story/paths.js";
import { countWords } from "../src/story/sentences.js";
import type { StoryScene } from "../src/story/types.js";

/**
 * TTS validation (brief test matrix #9): empty, truncated and implausible
 * chunks, plus the >maxChars split and the per-scene chunk contract (DP1).
 *
 * The fake provider writes real WAVs through ffmpeg, so duration comes from the
 * same ffprobe path production uses — a stub returning a number would not catch
 * the "provider reported 3 s, file is 0 s" case.
 */

const ROOT = mkdtempSync(join(tmpdir(), "story-audio-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

function writeWav(path: string, seconds: number, frequency = 440): void {
  mkdirSync(join(path, ".."), { recursive: true });
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:sample_rate=24000:duration=${seconds}`,
      "-c:a",
      "pcm_s16le",
      "-ac",
      "1",
      path,
    ],
    { stdio: "pipe" },
  );
}

function writeWavWithGap(
  path: string,
  gapSeconds: number,
  toneSeconds = 0.8,
  frequency = 300,
): void {
  mkdirSync(join(path, ".."), { recursive: true });
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:sample_rate=24000:duration=${toneSeconds}`,
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=24000:cl=mono:d=${gapSeconds}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:sample_rate=24000:duration=${toneSeconds}`,
      "-filter_complex",
      "[0:a][1:a][2:a]concat=n=3:v=0:a=1",
      "-c:a",
      "pcm_s16le",
      "-ac",
      "1",
      path,
    ],
    { stdio: "pipe" },
  );
}

function writeWavWithEdges(
  path: string,
  edgeSeconds: number,
  toneSeconds = 1,
  frequency = 440,
): void {
  mkdirSync(join(path, ".."), { recursive: true });
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=24000:cl=mono:d=${edgeSeconds}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${frequency}:sample_rate=24000:duration=${toneSeconds}`,
      "-f",
      "lavfi",
      "-i",
      `anullsrc=r=24000:cl=mono:d=${edgeSeconds}`,
      "-filter_complex",
      "[0:a][1:a][2:a]concat=n=3:v=0:a=1",
      "-c:a",
      "pcm_s16le",
      "-ac",
      "1",
      path,
    ],
    { stdio: "pipe" },
  );
}

interface FakeProvider extends TTSProvider {
  calls: number;
  texts: string[];
}

function fakeProvider(
  options: {
    /** Override the duration of the produced file (seconds). */
    seconds?: (text: string, words: number) => number;
    /** Write an empty file instead of audio. */
    empty?: boolean;
    /** Internal pause in seconds for the given synthesis call (1-based). */
    gap?: (call: number) => number | undefined;
  } = {},
): FakeProvider {
  const provider: FakeProvider = {
    calls: 0,
    texts: [],
    cacheFingerprint: () => "fake-tts-v1",
    async synthesize(opts: SynthesizeOptions) {
      provider.calls += 1;
      provider.texts.push(opts.text);
      const path = join(ROOT, "synth", `call-${provider.calls}.wav`);
      if (options.empty) {
        mkdirSync(join(path, ".."), { recursive: true });
        writeFileSync(path, "");
      } else {
        const words = countWords(opts.text);
        const seconds = options.seconds
          ? options.seconds(opts.text, words)
          : Math.max(0.6, (words / 150) * 60);
        const gap = options.gap?.(provider.calls);
        if (gap !== undefined) {
          writeWavWithGap(path, gap, seconds / 2, 300 + provider.calls * 20);
        } else {
          writeWav(path, seconds, 300 + provider.calls * 20);
        }
      }
      return { audioUrl: path, durationMs: 0 };
    },
  };
  return provider;
}

function scene(id: number, narration: string): StoryScene {
  return {
    sceneId: id,
    sentenceIds: [`s${id}`],
    narration,
    wordCount: countWords(narration),
    visualPurpose: "Purpose.",
    imagePromptWarnings: [],
    status: {
      prompt: "done",
      image: "done",
      audio: "pending",
      transcript: "pending",
      timing: "pending",
    },
    warnings: [],
  };
}

describe("splitForTts", () => {
  it("keeps a short narration in one piece", () => {
    expect(splitForTts("One short sentence.", 450)).toEqual([
      "One short sentence.",
    ]);
  });

  it("splits a long narration at sentence boundaries and loses no text", () => {
    const sentence = "The printer lifts a sheet of paper from the press. ";
    const text = sentence.repeat(20).trim();
    const pieces = splitForTts(text, 450);

    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) expect(piece.length).toBeLessThanOrEqual(450);
    expect(pieces.join(" ")).toBe(text);
    for (const piece of pieces) {
      // Every piece ends on a sentence terminator: no mid-sentence cut.
      expect(piece).toMatch(/[.!?]$/);
    }
  });

  it("breaks an over-long single sentence at word boundaries", () => {
    const text = "word ".repeat(300).trim();
    const pieces = splitForTts(text, 100);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(100);
      expect(piece).not.toMatch(/\s$/);
    }
    expect(pieces.join(" ")).toBe(text);
  });

  it("returns nothing for empty input", () => {
    expect(splitForTts("   ", 450)).toEqual([]);
  });
});

describe("trimEdgeSilence", () => {
  it("keeps a two-chunk join under S8's 1 s silence gate", async () => {
    const dir = join(ROOT, "edge-trim");
    const first = join(dir, "first.wav");
    const second = join(dir, "second.wav");
    writeWavWithEdges(first, 0.5, 1, 440);
    writeWavWithEdges(second, 0.5, 1, 660);

    const untrimmed = join(dir, "untrimmed.wav");
    await concatNarrationWithGaps({
      chunkPaths: [first, second],
      gapMs: 200,
      outputPath: untrimmed,
    });
    const before = await detectSilence(untrimmed, -50, 1.0);
    // The fixture is adversarial: 0.5 s trailing + 0.2 s gap + 0.5 s
    // leading is a 1.2 s silence at the join, so S8 would fail it.
    expect(before.length).toBeGreaterThan(0);

    const firstDuration = await trimEdgeSilence(first, 2);
    const secondDuration = await trimEdgeSilence(second, 2);
    expect(firstDuration).toBeGreaterThan(1.1);
    expect(firstDuration).toBeLessThan(1.3);
    expect(secondDuration).toBeGreaterThan(1.1);
    expect(secondDuration).toBeLessThan(1.3);

    const trimmed = join(dir, "trimmed.wav");
    await concatNarrationWithGaps({
      chunkPaths: [first, second],
      gapMs: 200,
      outputPath: trimmed,
    });
    expect(await detectSilence(trimmed, -50, 1.0)).toEqual([]);
  });
});

describe("runAudioStage", () => {
  const jobDir = join(ROOT, "job");
  const paths = jobPaths(jobDir);
  const config = resolveStoryConfig({ topic: "Audio" });

  function setup(): void {
    mkdirSync(paths.audioChunksDir, { recursive: true });
    mkdirSync(paths.audioPartsDir, { recursive: true });
    mkdirSync(paths.dir, { recursive: true });
  }

  it("creates one chunk per scene and a master with a gap between them", async () => {
    setup();
    const provider = fakeProvider();
    const scenes = [
      scene(1, "One two three four five."),
      scene(2, "Six seven eight nine ten."),
    ];

    const result = await runAudioStage({
      scenes,
      paths,
      config,
      ttsProvider: provider,
      voice: "narrator",
      runId: "test-run",
    });

    expect(provider.calls).toBe(2);
    expect(result.chunks.map((chunk) => chunk.sceneId)).toEqual([1, 2]);
    expect(result.gapMs).toBe(config.sceneGapMs);

    const sum = result.chunks.reduce(
      (total, chunk) => total + chunk.durationSec,
      0,
    );
    const expected = sum + (result.gapMs / 1000) * (result.chunks.length - 1);
    expect(Math.abs(result.masterDurationSec - expected)).toBeLessThan(0.1);

    for (const audioScene of scenes) {
      expect(audioScene.status.audio).toBe("done");
      expect(audioScene.audio?.wordsPerMinute).toBeGreaterThan(0);
    }
  });

  it("rejects a chunk that decodes to zero duration", async () => {
    setup();
    const provider = fakeProvider({ empty: true });
    await expect(
      runAudioStage({
        scenes: [scene(1, "One two three.")],
        paths,
        config,
        ttsProvider: provider,
        voice: "narrator",
        runId: "test-run",
      }),
    ).rejects.toThrow(/zero duration|no usable audio|not decodable/);
  });

  it("flags an implausibly short chunk as a warning instead of shipping it silently", async () => {
    setup();
    // 40 words at 150 wpm should be ~16 s; 0.7 s is far outside the 0.5x band.
    const provider = fakeProvider({ seconds: () => 0.7 });
    const scenes = [scene(1, "word ".repeat(40).trim())];

    const result = await runAudioStage({
      scenes,
      paths,
      config,
      ttsProvider: provider,
      voice: "narrator",
      runId: "test-run",
    });

    expect(result.chunks).toHaveLength(1);
    expect(scenes[0].warnings.join(" ")).toContain("outside the plausible");
  });

  it("reuses finished chunks and re-synthesizes only what changed", async () => {
    setup();
    const provider = fakeProvider();
    const scenes = [scene(1, "One two three."), scene(2, "Four five six.")];

    await runAudioStage({
      scenes,
      paths,
      config,
      ttsProvider: provider,
      voice: "narrator",
      runId: "test-run",
    });
    expect(provider.calls).toBe(2);

    await runAudioStage({
      scenes,
      paths,
      config,
      ttsProvider: provider,
      voice: "narrator",
      runId: "test-run",
    });
    expect(provider.calls).toBe(2);

    scenes[1].narration = "A completely different second scene.";
    await runAudioStage({
      scenes,
      paths,
      config,
      ttsProvider: provider,
      voice: "narrator",
      runId: "test-run",
    });
    expect(provider.calls).toBe(3);
    expect(provider.texts.at(-1)).toBe("A completely different second scene.");
  });

  it("re-synthesizes a chunk with a long internal pause and records it", async () => {
    setup();
    const provider = fakeProvider({
      gap: (call) => (call === 1 ? 1.4 : undefined),
    });
    const audioScene = scene(1, "One two three four five six.");

    await runAudioStage({
      scenes: [audioScene],
      paths,
      config,
      ttsProvider: provider,
      voice: "narrator",
      runId: "silence-retake",
    });

    expect(provider.calls).toBe(2);
    expect(audioScene.audio?.silenceRetakes).toBe(1);
    expect(audioScene.audio?.maxInternalSilenceSec).toBeGreaterThan(1.3);
    expect(audioScene.warnings.join(" ")).not.toContain("still has");
  });

  it("caps silence retakes at two and leaves the S8 warning behind", async () => {
    setup();
    const provider = fakeProvider({ gap: () => 1.4 });
    const audioScene = scene(1, "One two three four five six.");

    await runAudioStage({
      scenes: [audioScene],
      paths,
      config,
      ttsProvider: provider,
      voice: "narrator",
      runId: "silence-retake-cap",
    });

    expect(provider.calls).toBe(3);
    expect(audioScene.audio?.silenceRetakes).toBe(2);
    expect(audioScene.warnings.join(" ")).toContain("S8 will gate the master");
  });

  it("asks the provider to skip WPM normalization", async () => {
    setup();
    const seen: (boolean | undefined)[] = [];
    const provider: TTSProvider = {
      async synthesize(opts) {
        seen.push(opts.skipWpmNormalization);
        const path = join(ROOT, "synth", `flag-${seen.length}.wav`);
        writeWav(path, 1);
        return { audioUrl: path, durationMs: 1000 };
      },
    };
    await runAudioStage({
      scenes: [scene(1, "One two three four.")],
      paths,
      config,
      ttsProvider: provider,
      voice: "narrator",
      runId: "test-run",
    });
    expect(seen).toEqual([true]);
  });
});

describe("findVoiceOutliers", () => {
  function withAudio(
    id: number,
    wordsPerMinute: number,
    meanVolumeDb?: number,
  ): StoryScene {
    const value = scene(id, "One two three four five six seven.");
    value.audio = {
      path: `/tmp/scene-${id}.wav`,
      durationSec: 3,
      pieces: [],
      meanVolumeDb,
      wordsPerMinute,
    };
    value.status.audio = "done";
    return value;
  }

  it("stays quiet with fewer than three chunks", () => {
    expect(findVoiceOutliers([withAudio(1, 150), withAudio(2, 300)])).toEqual(
      [],
    );
  });

  it("flags a pace outlier against the run median", () => {
    const outliers = findVoiceOutliers([
      withAudio(1, 150),
      withAudio(2, 152),
      withAudio(3, 148),
      withAudio(4, 260),
    ]);
    expect(outliers.map((entry) => entry.sceneId)).toEqual([4]);
    expect(outliers[0].reason).toContain("pace");
  });

  it("flags a loudness outlier against the run median", () => {
    const outliers = findVoiceOutliers([
      withAudio(1, 150, -18),
      withAudio(2, 151, -18.5),
      withAudio(3, 149, -17.5),
      withAudio(4, 150, -40),
    ]);
    expect(outliers.map((entry) => entry.sceneId)).toEqual([4]);
    expect(outliers[0].reason).toContain("loudness");
  });
});
