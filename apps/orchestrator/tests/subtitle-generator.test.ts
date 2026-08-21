import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import {
  subtitleGeneratorNode,
  FallbackSceneSubtitleProvider,
} from "../src/agents/subtitle-generator.node.js";
import type { ProjectState, Scene } from "../src/types/index.js";
import type {
  SubtitleProvider,
  GenerateSubtitlesResult,
} from "../src/providers/subtitle-provider.js";
import type { SceneSubtitleProvider } from "../src/providers/scene-subtitle-provider.js";
import { parseSrtCues } from "../src/utils/srt.js";

const mockGenerateSubtitles = jest.fn<(...args: any[]) => Promise<any>>();
const mockLegacyProvider: SubtitleProvider = {
  generateSubtitles: mockGenerateSubtitles,
};

const mockGenerateSceneSubtitles = jest.fn<(...args: any[]) => Promise<any>>();
const mockSceneProvider: SceneSubtitleProvider = {
  generateSceneSubtitles: mockGenerateSceneSubtitles,
};

const SCENES: Scene[] = [
  { sceneId: 1, narration: "First scene has words." },
  { sceneId: 2, narration: "Second scene has words." },
];
const AUDIO_SCENES = [
  {
    sceneId: 1,
    artifactId: "a1",
    narration: SCENES[0].narration!,
    durationMs: 2000,
    url: "scene-001.wav",
  },
  {
    sceneId: 2,
    artifactId: "a2",
    narration: SCENES[1].narration!,
    durationMs: 3000,
    url: "scene-002.wav",
  },
];
const DEFAULT_AUDIO = {
  version: 2 as const,
  scenes: AUDIO_SCENES,
  combinedAudio: {
    artifactId: "combined",
    durationMs: 5000,
    url: "combined.wav",
    sourceSceneArtifactIds: ["a1", "a2"],
  },
  narrationUrl: "combined.wav",
  narrationDurationMs: 5000,
};

beforeEach(() => {
  mockGenerateSubtitles.mockReset();
  mockGenerateSceneSubtitles.mockReset();
});

function runNode(
  state: Partial<ProjectState> = {},
  inject?: {
    subtitleProvider?: SubtitleProvider;
    sceneSubtitleProvider?: SceneSubtitleProvider;
  },
) {
  return subtitleGeneratorNode(
    {
      project: { pillar: "Geography", topic: "Test" },
      content: { narration: "First scene has words. Second scene has words." },
      production: { scenes: SCENES },
      audio: DEFAULT_AUDIO,
      execution: { version: "0.1.0" },
      ...state,
    } as ProjectState,
    {
      configurable: {
        ...(inject?.subtitleProvider
          ? { subtitleProvider: inject.subtitleProvider }
          : {}),
        ...(inject?.sceneSubtitleProvider
          ? { sceneSubtitleProvider: inject.sceneSubtitleProvider }
          : {}),
      },
    } as any,
  );
}

describe("subtitleGeneratorNode", () => {
  it("creates scene-bounded subtitles without alignment service", async () => {
    const result = await runNode();

    expect(result.subtitles.srt).toBeDefined();
    expect(result.subtitles.ass).toBeDefined();
    expect(result.subtitles.wordTimestamps).toBeDefined();
    expect(result.subtitles.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const cues = parseSrtCues(result.subtitles.srt!);
    expect(cues.length).toBeGreaterThan(0);
    expect(cues.every((cue) => cue.endMs <= 5000)).toBe(true);
    expect(cues.some((cue) => cue.startMs < 2000 && cue.endMs > 2000)).toBe(
      false,
    );
  });

  it("starts scene 2 exactly at cumulative scene 1 duration", async () => {
    const result = await runNode();

    const cues = parseSrtCues(result.subtitles.srt!);
    const sceneTwoCue = cues.find((cue) => cue.text.includes("Second"));
    expect(sceneTwoCue).toBeDefined();
    expect(sceneTwoCue!.startMs).toBe(2000);
    expect(cues.every((cue) => cue.endMs <= 5000)).toBe(true);
  });

  it("never lets a cue cross a scene boundary", async () => {
    const longScenes = [
      { sceneId: 1, narration: "one two three four five six seven eight" },
      { sceneId: 2, narration: "nine ten eleven twelve thirteen" },
    ] as Scene[];
    const longAudio = [
      {
        sceneId: 1,
        artifactId: "a1",
        narration: longScenes[0].narration!,
        durationMs: 4000,
        url: "scene-001.wav",
      },
      {
        sceneId: 2,
        artifactId: "a2",
        narration: longScenes[1].narration!,
        durationMs: 5000,
        url: "scene-002.wav",
      },
    ];

    const result = await runNode({
      production: { scenes: longScenes },
      audio: {
        ...DEFAULT_AUDIO,
        scenes: longAudio,
        combinedAudio: {
          ...DEFAULT_AUDIO.combinedAudio!,
          durationMs: 9000,
          sourceSceneArtifactIds: ["a1", "a2"],
        },
        narrationDurationMs: 9000,
      },
    } as any);

    const cues = parseSrtCues(result.subtitles.srt!);
    expect(cues.some((cue) => cue.startMs < 4000 && cue.endMs > 4000)).toBe(
      false,
    );
  });

  it("requires complete scene audio manifest", async () => {
    const result = await runNode({
      audio: { narrationUrl: "legacy.wav" },
    } as any);

    expect(result.diagnostics.errors?.[0]).toContain(
      "Complete scene audio manifest is required",
    );
    expect(result.subtitles.srt).toBeUndefined();
  });

  it("rejects mismatched scene audio IDs", async () => {
    const result = await runNode({
      audio: {
        ...DEFAULT_AUDIO,
        scenes: [{ ...AUDIO_SCENES[0] }, { ...AUDIO_SCENES[1], sceneId: 99 }],
      },
    } as any);

    expect(result.diagnostics.errors?.[0]).toContain(
      "Scene audio IDs do not match production scenes",
    );
    expect(result.subtitles.srt).toBeUndefined();
  });

  it("rejects reordered scene audio (positional, not set, equality)", async () => {
    const result = await runNode({
      audio: {
        ...DEFAULT_AUDIO,
        scenes: [AUDIO_SCENES[1], AUDIO_SCENES[0]],
        combinedAudio: {
          ...DEFAULT_AUDIO.combinedAudio!,
          sourceSceneArtifactIds: ["a2", "a1"],
        },
      },
    } as any);

    expect(result.diagnostics.errors?.[0]).toContain(
      "Scene audio IDs do not match production scenes",
    );
    expect(result.subtitles.srt).toBeUndefined();
  });

  it("ignores legacy subtitleProvider injection (no WhisperX path)", async () => {
    mockGenerateSubtitles.mockResolvedValue({
      srt: "1\n00:00:00,000 --> 00:00:01,000\nLegacy",
      ass: "Legacy",
      wordTimestamps: [{ word: "Legacy", start: 0, end: 1 }],
    } satisfies GenerateSubtitlesResult);

    const result = await runNode({}, { subtitleProvider: mockLegacyProvider });

    expect(mockGenerateSubtitles).not.toHaveBeenCalled();
    expect(result.subtitles.srt).toBeDefined();
    expect(result.subtitles.srt).not.toContain("Legacy");
  });

  it("uses the scene subtitle provider", async () => {
    mockGenerateSceneSubtitles.mockResolvedValue({
      srt: "1\n00:00:00,000 --> 00:00:01,000\nScene",
      ass: "Scene",
      wordTimestamps: [{ word: "Scene", start: 0, end: 1 }],
    });

    const result = await runNode(
      {},
      { sceneSubtitleProvider: mockSceneProvider },
    );

    expect(mockGenerateSceneSubtitles).toHaveBeenCalledWith(
      SCENES,
      AUDIO_SCENES,
    );
    expect(result.subtitles.srt).toContain("Scene");
  });

  it("does not generate subtitles when scene count is incomplete", async () => {
    const result = await runNode({
      audio: { ...DEFAULT_AUDIO, scenes: AUDIO_SCENES.slice(0, 1) },
    } as any);

    expect(result.diagnostics.errors?.[0]).toContain(
      "Complete scene audio manifest",
    );
    expect(mockGenerateSubtitles).not.toHaveBeenCalled();
  });
});

describe("FallbackSceneSubtitleProvider", () => {
  const ok = { srt: "ok", ass: "ok", wordTimestamps: [] };
  const primary = {
    generateSceneSubtitles: jest.fn<(...args: any[]) => Promise<any>>(),
  };
  const fallback = {
    generateSceneSubtitles: jest.fn<(...args: any[]) => Promise<any>>(),
  };

  beforeEach(() => {
    primary.generateSceneSubtitles.mockReset();
    fallback.generateSceneSubtitles.mockReset();
  });

  it("falls back to the deterministic provider when the primary fails", async () => {
    primary.generateSceneSubtitles.mockRejectedValue(
      new Error("WhisperX down"),
    );
    fallback.generateSceneSubtitles.mockResolvedValue(ok);

    const wrapped = new FallbackSceneSubtitleProvider(
      primary as any,
      fallback as any,
    );
    const result = await wrapped.generateSceneSubtitles(
      SCENES as any,
      AUDIO_SCENES as any,
    );

    expect(primary.generateSceneSubtitles).toHaveBeenCalledWith(
      SCENES,
      AUDIO_SCENES,
    );
    expect(fallback.generateSceneSubtitles).toHaveBeenCalled();
    expect(result).toEqual(ok);
  });

  it("does not call the fallback when the primary succeeds", async () => {
    primary.generateSceneSubtitles.mockResolvedValue(ok);

    const wrapped = new FallbackSceneSubtitleProvider(
      primary as any,
      fallback as any,
    );
    const result = await wrapped.generateSceneSubtitles(
      SCENES as any,
      AUDIO_SCENES as any,
    );

    expect(fallback.generateSceneSubtitles).not.toHaveBeenCalled();
    expect(result).toEqual(ok);
  });
});
