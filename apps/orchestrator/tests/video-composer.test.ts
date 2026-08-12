import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import {
  videoComposerNode,
  scaleSceneDurations,
  alignSceneDurationsToAudio,
} from "../src/agents/video-composer.node.js";
import type { ProjectState } from "../src/types/index.js";
import type {
  ComposerProvider,
  ComposeOptions,
  ComposeResult,
} from "../src/providers/composer-provider.js";

const mockCompose = jest.fn<(...args: any[]) => Promise<any>>();

const mockComposerProvider: ComposerProvider = {
  compose: mockCompose,
};

const DEFAULT_SCENE = {
  sceneId: 1,
  assetUrl: "https://placeholder.local/scene-001.mp4",
  startSecond: 0,
  endSecond: 10,
  durationSeconds: 10,
  sceneGoal: "",
  visualDescription: "",
  sceneType: "landscape" as const,
  cameraShot: "aerial" as const,
  cameraMotion: "static" as const,
  transition: "cut" as const,
  emphasis: "high" as const,
  assetType: "video" as const,
  filename: "scene-001.mp4",
  extension: "mp4",
  assetId: "asset-scene-001",
  provider: "runway" as const,
  generationMode: "generate" as const,
};

const DEFAULT_RESULT: ComposeResult = {
  videoUrl: "https://placeholder.local/final.mp4",
  durationMs: 10000,
  resolution: "1080x1920",
};

function audioManifest(
  scenes: Array<{ sceneId: number; durationSeconds?: number }> = [
    DEFAULT_SCENE,
  ],
) {
  const sceneAudio = scenes.map((scene) => ({
    sceneId: scene.sceneId,
    artifactId: `audio-${scene.sceneId}`,
    narration: `Scene ${scene.sceneId}`,
    durationMs: Math.round((scene.durationSeconds ?? 10) * 1000),
    url: `scene-${scene.sceneId}.wav`,
  }));
  const durationMs = sceneAudio.reduce(
    (sum, scene) => sum + scene.durationMs,
    0,
  );
  return {
    version: 2 as const,
    scenes: sceneAudio,
    combinedAudio: {
      artifactId: "combined",
      durationMs,
      url: "https://placeholder.local/narration.wav",
      sourceSceneArtifactIds: sceneAudio.map((scene) => scene.artifactId),
    },
    narrationUrl: "https://placeholder.local/narration.wav",
    narrationDurationMs: durationMs,
  };
}

beforeEach(() => {
  mockCompose.mockReset();
});

function runNode(state?: Partial<ProjectState>, provider?: ComposerProvider) {
  return videoComposerNode(
    {
      project: { pillar: "Geography", topic: "Test" },
      content: { estimatedDurationSeconds: 10 },
      production: { scenes: [DEFAULT_SCENE] },
      audio: audioManifest(),
      subtitles: {
        srt: "1\n00:00:00,000 --> 00:00:10,000\nHello world",
        wordTimestamps: [],
        ass: "",
      },
      branding: { channel: "TestChannel", creator: "", cta: "" },
      execution: { version: "0.1.0" },
      ...state,
    } as ProjectState,
    {
      configurable: { composerProvider: provider ?? mockComposerProvider },
    } as any,
  );
}

describe("videoComposerNode", () => {
  it("successful composition sets all video fields", async () => {
    mockCompose.mockResolvedValue(DEFAULT_RESULT);

    const result = await runNode();

    expect(result.video.videoUrl).toBe("https://placeholder.local/final.mp4");
    expect(result.video.durationMs).toBe(10000);
    expect(result.video.resolution).toBe("1080x1920");
    expect(result.video.composedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.execution?.currentNode).toBe("VideoComposer");
  });

  it("returns error when scenes are missing", async () => {
    const result = await runNode({ production: {} } as any);

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain(
      "No production scenes found",
    );
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it("returns error when scenes array is empty", async () => {
    const result = await runNode({ production: { scenes: [] } } as any);

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain(
      "No production scenes found",
    );
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it("returns error when scene lacks assetUrl", async () => {
    const result = await runNode({
      production: { scenes: [{ ...DEFAULT_SCENE, assetUrl: undefined }] },
    } as any);

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("missing assetUrl");
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it("returns error when narrationUrl is missing", async () => {
    const result = await runNode({ audio: {} } as any);

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("scene audio manifest");
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it("returns error when srt is missing", async () => {
    const result = await runNode({ subtitles: {} } as any);

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain(
      "SRT subtitles are missing",
    );
    expect(mockCompose).not.toHaveBeenCalled();
  });

  it("returns error on provider failure", async () => {
    mockCompose.mockRejectedValue(new Error("Composition service unavailable"));

    const result = await runNode();

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain(
      "Composition service unavailable",
    );
    expect(result.video.videoUrl).toBeUndefined();
  });

  it("uses stub provider when explicitly injected", async () => {
    const stubProvider: ComposerProvider = {
      compose: async () => ({
        videoUrl: "https://placeholder.local/final.mp4",
        durationMs: 10000,
        resolution: "1080x1920",
      }),
    };

    const result = await videoComposerNode(
      {
        project: { pillar: "Geography", topic: "Test" },
        content: { estimatedDurationSeconds: 10 },
        production: { scenes: [DEFAULT_SCENE] },
        audio: audioManifest(),
        subtitles: { srt: "1\n00:00:00,000 --> 00:00:10,000\nHello" },
        branding: { channel: "C", creator: "", cta: "" },
        execution: { version: "0.1.0" },
      } as ProjectState,
      { configurable: { composerProvider: stubProvider } } as any,
    );

    expect(result.video.videoUrl).toBe("https://placeholder.local/final.mp4");
    expect(result.video.resolution).toBe("1080x1920");
  });

  it("uses injected provider over stub", async () => {
    const customResult: ComposeResult = {
      videoUrl: "https://custom.local/video.mp4",
      durationMs: 5000,
      resolution: "720x1280",
    };
    mockCompose.mockResolvedValue(customResult);

    const result = await runNode();

    expect(result.video.videoUrl).toBe("https://custom.local/video.mp4");
    expect(result.video.resolution).toBe("720x1280");
  });

  it("sets execution.currentNode", async () => {
    mockCompose.mockResolvedValue(DEFAULT_RESULT);

    const result = await runNode();

    expect(result.execution?.currentNode).toBe("VideoComposer");
  });

  it("composedAt is valid ISO timestamp", async () => {
    mockCompose.mockResolvedValue(DEFAULT_RESULT);

    const result = await runNode();

    expect(result.video.composedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("correct scene data is passed to provider", async () => {
    mockCompose.mockImplementation(async (opts: ComposeOptions) => {
      expect(opts.scenes).toHaveLength(1);
      expect(opts.scenes[0].sceneId).toBe(1);
      expect(opts.scenes[0].assetUrl).toBe(
        "https://placeholder.local/scene-001.mp4",
      );
      expect(opts.scenes[0].startSecond).toBe(0);
      expect(opts.narrationUrl).toBe("https://placeholder.local/narration.wav");
      expect(opts.srt).toContain("Hello world");
      expect(opts.totalDurationSeconds).toBe(10);
      expect(opts.narrativeHoldSeconds).toBe(0.5);
      expect(opts.branding.channel).toBe("TestChannel");
      expect(opts.branding.outroAsset).toBe("assets/branding/outro.mp4");
      expect(opts.branding.ctaEnabled).toBe(true);
      expect(opts.branding.outroContainsCta).toBe(false);
      return DEFAULT_RESULT;
    });

    await runNode();
    expect(mockCompose).toHaveBeenCalledTimes(1);
  });

  it("passes branding disabled through to composer", async () => {
    mockCompose.mockResolvedValue(DEFAULT_RESULT);

    await runNode({
      branding: { channel: "C", creator: "", cta: "", enabled: false },
    });

    const opts = mockCompose.mock.calls[0][0] as ComposeOptions;
    expect(opts.branding.enabled).toBe(false);
  });

  it("uses actual scene audio durations and preserves planned scenes", async () => {
    const durations = [5, 9, 11, 10, 8, 12];
    const ends = durations.reduce<number[]>((acc, d) => {
      acc.push((acc.at(-1) ?? 0) + d);
      return acc;
    }, []);
    const scenes = durations.map((d, i) => ({
      ...DEFAULT_SCENE,
      sceneId: i + 1,
      startSecond: i === 0 ? 0 : ends[i - 1],
      endSecond: ends[i],
      durationSeconds: d,
    }));

    const audioScenes = scenes.map((scene, i) => ({
      sceneId: scene.sceneId,
      artifactId: `audio-${scene.sceneId}`,
      narration: `Scene ${scene.sceneId}`,
      durationMs: [4000, 7000, 12000, 9000, 6000, 11000][i],
      url: `scene-${scene.sceneId}.wav`,
    }));
    const narrationDurationMs = audioScenes.reduce(
      (sum, scene) => sum + scene.durationMs,
      0,
    );

    mockCompose.mockImplementation(async (opts: ComposeOptions) => {
      expect(opts.totalDurationSeconds).toBeCloseTo(49, 1);
      expect(opts.scenes).toHaveLength(6);
      const total = opts.scenes.reduce((acc, s) => acc + s.durationSeconds, 0);
      expect(total).toBeGreaterThanOrEqual(narrationDurationMs / 1000);
      return DEFAULT_RESULT;
    });

    const result = await runNode({
      content: { estimatedDurationSeconds: 55 },
      production: { scenes },
      audio: {
        ...audioManifest(),
        scenes: audioScenes,
        combinedAudio: {
          ...audioManifest().combinedAudio,
          durationMs: narrationDurationMs,
          sourceSceneArtifactIds: audioScenes.map((scene) => scene.artifactId),
        },
        narrationDurationMs,
      },
    });

    expect(mockCompose).toHaveBeenCalledTimes(1);

    const scaled = result.production?.scenes!;
    expect(scaled).toHaveLength(6);
    expect(result.production?.plannedScenes).toEqual(scenes);

    expect(scaled[0].durationSeconds).toBeGreaterThanOrEqual(4);
    expect(scaled[0].startSecond).toBe(0);

    const total = scaled.reduce((acc, s) => acc + (s.durationSeconds ?? 0), 0);
    expect(total).toBeGreaterThanOrEqual(narrationDurationMs / 1000);

    for (let i = 1; i < scaled.length; i++) {
      expect(scaled[i].startSecond).toBeCloseTo(scaled[i - 1].endSecond!, 2);
    }
  });

  it("fails with diagnostics when scene audio is missing", async () => {
    const scenes = [
      {
        ...DEFAULT_SCENE,
        sceneId: 1,
        startSecond: 0,
        endSecond: 10,
        durationSeconds: 10,
      },
    ];

    const result = await runNode({
      content: { estimatedDurationSeconds: 10 },
      production: { scenes },
      audio: audioManifest([]),
    });

    expect(mockCompose).not.toHaveBeenCalled();
    expect(result.video.videoUrl).toBeUndefined();
    expect(result.diagnostics?.errors?.[0]).toContain("scene audio manifest");
  });
});

describe("alignSceneDurationsToAudio", () => {
  it("uses cumulative actual audio boundaries instead of global scaling", () => {
    const scenes = [
      { ...DEFAULT_SCENE, sceneId: 1, durationSeconds: 10 },
      { ...DEFAULT_SCENE, sceneId: 2, durationSeconds: 10 },
    ];
    const audio = [
      {
        sceneId: 1,
        artifactId: "a1",
        narration: "One",
        durationMs: 4500,
        url: "1.wav",
      },
      {
        sceneId: 2,
        artifactId: "a2",
        narration: "Two",
        durationMs: 6500,
        url: "2.wav",
      },
    ];

    const result = alignSceneDurationsToAudio(scenes, audio);

    expect(result[0].startSecond).toBe(0);
    expect(result[0].durationSeconds).toBe(4.5);
    expect(result[1].startSecond).toBe(result[0].endSecond);
    expect(result[1].durationSeconds).toBeCloseTo(6.5, 2);
  });
});

describe("scaleSceneDurations", () => {
  const FRAME_RATE = 30;

  function scene(durationSeconds: number, sceneId = 1) {
    return { ...DEFAULT_SCENE, sceneId, durationSeconds };
  }

  function totalMs(
    scaled: Awaited<ReturnType<typeof scaleSceneDurations>>,
  ): number {
    return scaled.reduce((acc, s) => acc + (s.durationSeconds ?? 0) * 1000, 0);
  }

  it("every scene duration is a whole number of 30fps frames", () => {
    const scaled = scaleSceneDurations([scene(5), scene(9), scene(11)], 30000);

    for (const s of scaled) {
      expect((s.durationSeconds ?? 0) * FRAME_RATE).toBeCloseTo(
        Math.round((s.durationSeconds ?? 0) * FRAME_RATE),
        8,
      );
      expect((s.startSecond ?? 0) * FRAME_RATE).toBeCloseTo(
        Math.round((s.startSecond ?? 0) * FRAME_RATE),
        8,
      );
      expect((s.endSecond ?? 0) * FRAME_RATE).toBeCloseTo(
        Math.round((s.endSecond ?? 0) * FRAME_RATE),
        8,
      );
    }
  });

  it("never undershoots the target across fractional frame boundaries", () => {
    const scenes = [scene(3), scene(3), scene(3)];

    for (const targetMs of [4900, 5190, 8190, 9001, 15091]) {
      const scaled = scaleSceneDurations(scenes, targetMs);
      expect(totalMs(scaled)).toBeGreaterThanOrEqual(targetMs);
    }
  });

  it("rounds the target narration duration up to whole frames", () => {
    const scaled = scaleSceneDurations([scene(1)], 1001);

    const totalFrames = scaled.reduce(
      (sum, s) => sum + (s.durationSeconds ?? 0) * FRAME_RATE,
      0,
    );

    expect(totalFrames).toBeCloseTo(31, 8);
    expect(totalMs(scaled)).toBeGreaterThanOrEqual(1001);
  });

  it("final scene endSecond equals the scaled total", () => {
    const scaled = scaleSceneDurations([scene(5), scene(9), scene(11)], 30000);

    const totalSeconds = scaled.reduce(
      (acc, s) => acc + (s.durationSeconds ?? 0),
      0,
    );
    expect(scaled.at(-1)?.endSecond).toBeCloseTo(totalSeconds, 8);
  });

  it("scaled scenes are contiguous and preserve order", () => {
    const scenes = [scene(5, 1), scene(9, 2), scene(11, 3)];
    const scaled = scaleSceneDurations(scenes, 30000);

    expect(scaled.map((s) => s.sceneId)).toEqual([1, 2, 3]);
    for (let i = 1; i < scaled.length; i++) {
      expect(scaled[i].startSecond).toBeCloseTo(scaled[i - 1].endSecond!, 8);
    }
    expect(scaled[0].startSecond).toBe(0);
  });

  it("throws when target duration is not positive", () => {
    expect(() => scaleSceneDurations([scene(10)], 0)).toThrow(
      /narration duration is 0ms/,
    );
    expect(() => scaleSceneDurations([scene(10)], -1000)).toThrow(
      /narration duration is -1000ms/,
    );
  });

  it("throws when planned scene durations sum to zero", () => {
    expect(() => scaleSceneDurations([scene(0)], 10000)).toThrow(/sum to 0ms/);
  });
});
