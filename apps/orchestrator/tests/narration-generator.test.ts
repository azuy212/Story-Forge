import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { narrationGeneratorNode } from "../src/agents/narration-generator.node.js";
import type { ProjectState, Scene } from "../src/types/index.js";
import type { TTSProvider } from "../src/providers/tts-provider.js";
import { StubTTSProvider } from "../src/providers/stub-tts-provider.js";
import { config } from "../src/utils/config.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemArtifactStore } from "../src/artifacts/fs/fs-artifact-store.js";

const mockSynthesize = jest.fn<(...args: any[]) => Promise<any>>();
const mockConcat = jest
  .fn<(...args: any[]) => Promise<any>>()
  .mockImplementation(async (inputs: Array<{ durationMs: number }>) => ({
    audioPath: "combined.wav",
    durationMs: inputs.reduce((sum, input) => sum + input.durationMs, 0),
  }));

const mockTTSProvider: TTSProvider = {
  synthesize: mockSynthesize,
  cacheFingerprint: () => "mock-tts-v1",
};

function makeScene(sceneId: number, narration: string): Scene {
  return {
    sceneId,
    narration,
    startSecond: sceneId - 1,
    endSecond: sceneId,
    durationSeconds: 1,
  };
}

function runNode(
  scenes: Scene[] = [
    makeScene(1, "Scene one narration."),
    makeScene(2, "Scene two narration."),
  ],
  provider: TTSProvider = mockTTSProvider,
) {
  return narrationGeneratorNode(
    {
      project: { pillar: "Geography", topic: "Test" },
      content: { narration: "Global narration must not be synthesized." },
      production: { scenes },
      execution: { version: "0.1.0" },
      ...{},
    } as ProjectState,
    {
      configurable: {
        ttsProvider: provider,
        audioConcatenator: mockConcat,
      },
    } as any,
  );
}

beforeEach(() => {
  process.env.NARRATION_GENERATION_MODE = "scene";
  mockSynthesize.mockReset();
  mockConcat.mockReset();
  mockConcat.mockImplementation(
    async (inputs: Array<{ durationMs: number }>) => ({
      audioPath: "combined.wav",
      durationMs: inputs.reduce((sum, input) => sum + input.durationMs, 0),
    }),
  );
  mockSynthesize.mockImplementation(async (opts: { text: string }) => ({
    audioUrl: `scene-${opts.text.slice(6, 9)}.wav`,
    durationMs: opts.text.length * 10,
  }));
});

let storeDir: string;
let store: FilesystemArtifactStore;
let runId: string;

async function newStore(): Promise<void> {
  storeDir = await mkdtemp(join(tmpdir(), "narration-cache-"));
  process.env.ARTIFACT_STORE_DIR = storeDir;
  store = new FilesystemArtifactStore();
  runId = `run-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

afterEach(async () => {
  delete process.env.ARTIFACT_STORE_DIR;
  delete process.env.NARRATION_GENERATION_MODE;
  if (storeDir) await rm(storeDir, { recursive: true, force: true });
});

function runNodeWithStore(
  scenes: Scene[],
): ReturnType<typeof narrationGeneratorNode> {
  return narrationGeneratorNode(
    {
      project: { pillar: "Geography", topic: "Test" },
      production: { scenes },
      execution: { version: "0.1.0", runId },
    } as ProjectState,
    {
      configurable: {
        artifactStore: store,
        runId,
        ttsProvider: mockTTSProvider,
        audioConcatenator: mockConcat,
      },
    } as any,
  );
}

describe("narrationGeneratorNode", () => {
  it("creates one TTS job per scene with exact scene narration", async () => {
    const scenes = Array.from({ length: 7 }, (_, i) =>
      makeScene(i + 1, `Scene ${i + 1} narration.`),
    );

    const result = await runNode(scenes);

    expect(mockSynthesize).toHaveBeenCalledTimes(7);
    expect(mockSynthesize.mock.calls.map(([opts]) => opts.text).sort()).toEqual(
      scenes.map((scene) => scene.narration).sort(),
    );
    expect(result.audio.scenes).toHaveLength(7);
    expect(result.audio.combinedAudio?.sourceSceneArtifactIds).toHaveLength(7);
  });

  it("never synthesizes global narration or combines scenes", async () => {
    await runNode();

    expect(mockSynthesize.mock.calls.map(([opts]) => opts.text)).not.toContain(
      "Global narration must not be synthesized.",
    );
    expect(mockConcat).toHaveBeenCalledWith(
      [
        expect.objectContaining({ sceneId: 1 }),
        expect.objectContaining({ sceneId: 2 }),
      ],
      expect.stringContaining("narration.wav"),
    );
  });

  it("concatenates by scene ID despite TTS completion order", async () => {
    const scenes = [
      makeScene(2, "Second scene."),
      makeScene(1, "First scene."),
      makeScene(3, "Third scene."),
    ];
    mockSynthesize.mockImplementation(async (opts: { text: string }) => {
      await new Promise((resolve) =>
        setTimeout(resolve, opts.text.startsWith("First") ? 20 : 1),
      );
      return { audioUrl: `${opts.text}.wav`, durationMs: 1000 };
    });

    await runNode(scenes);

    expect(
      mockConcat.mock.calls[0][0].map(
        (input: { sceneId: number }) => input.sceneId,
      ),
    ).toEqual([1, 2, 3]);
  });

  it("reports failed scene and does not create combined audio", async () => {
    mockSynthesize.mockImplementation(async (opts: { text: string }) => {
      if (opts.text === "Scene two narration.")
        throw new Error("service unavailable");
      return { audioUrl: `${opts.text}.wav`, durationMs: 1000 };
    });

    const result = await runNode();

    expect(result.diagnostics.errors?.[0]).toContain("scene 2");
    expect(result.audio.combinedAudio).toBeUndefined();
    expect(mockConcat).not.toHaveBeenCalled();
    expect(result.audio.scenes).toHaveLength(1);
    expect(result.audio.scenes?.[0].sceneId).toBe(1);
  });

  it("uses branding voice and deterministic filenames", async () => {
    const result = await narrationGeneratorNode(
      {
        project: { pillar: "Geography", topic: "Test" },
        production: { scenes: [makeScene(3, "Third scene.")] },
        branding: { channel: "C", creator: "", cta: "", voice: "custom-voice" },
        execution: { version: "0.1.0" },
      } as ProjectState,
      {
        configurable: {
          ttsProvider: mockTTSProvider,
          audioConcatenator: mockConcat,
        },
      } as any,
    );

    expect(result.audio.voice).toBe("custom-voice");
    expect(mockSynthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Third scene.",
        voice: "custom-voice",
        filename: "scene-003.wav",
      }),
    );
  });

  it("rejects missing scene narration without calling TTS", async () => {
    const result = await runNode([makeScene(1, "   ")]);

    expect(result.diagnostics.errors?.[0]).toContain("Invalid scene narration");
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it("supports stub provider with scene audio aliases", async () => {
    const result = await runNode(
      [makeScene(1, "Stub scene.")],
      new StubTTSProvider(),
    );

    expect(result.audio.narrationUrl).toBe("combined.wav");
    expect(result.audio.narrationDurationMs).toBeGreaterThan(0);
    expect(result.audio.version).toBe(2);
  });

  it("keeps successful scenes cached after a partial failure", async () => {
    await newStore();
    mockSynthesize.mockImplementation(async (opts: { text: string }) => {
      if (opts.text === "Scene two narration.")
        throw new Error("service unavailable");
      return { audioUrl: `${opts.text}.wav`, durationMs: 1000 };
    });

    const first = await runNodeWithStore([
      makeScene(1, "Scene one narration."),
      makeScene(2, "Scene two narration."),
    ]);
    expect(first.diagnostics.errors?.[0]).toContain("scene 2");
    const cachedSceneOne = first.audio.scenes?.[0];

    mockSynthesize.mockClear();
    mockSynthesize.mockImplementation(async (opts: { text: string }) => ({
      audioUrl: `${opts.text}.wav`,
      durationMs: 1000,
    }));
    mockConcat.mockClear();

    const second = await runNodeWithStore([
      makeScene(1, "Scene one narration."),
      makeScene(2, "Scene two narration."),
    ]);

    expect(mockSynthesize).toHaveBeenCalledTimes(1);
    expect(mockSynthesize.mock.calls[0][0].text).toBe("Scene two narration.");
    expect(second.audio.combinedAudio).toBeDefined();
    expect(second.audio.scenes?.[0].artifactId).toBe(
      cachedSceneOne?.artifactId,
    );
  });

  it("regenerates exactly one scene when scene 3 narration changes", async () => {
    await newStore();
    mockConcat.mockClear();

    await runNodeWithStore([
      makeScene(1, "Scene one narration."),
      makeScene(2, "Scene two narration."),
      makeScene(3, "Original third narration."),
    ]);
    expect(mockSynthesize).toHaveBeenCalledTimes(3);

    mockSynthesize.mockClear();
    mockConcat.mockClear();

    const result = await runNodeWithStore([
      makeScene(1, "Scene one narration."),
      makeScene(2, "Scene two narration."),
      makeScene(3, "Changed third narration."),
    ]);

    expect(mockSynthesize).toHaveBeenCalledTimes(1);
    expect(mockSynthesize.mock.calls[0][0].text).toBe(
      "Changed third narration.",
    );
    expect(result.audio.scenes?.[2].sceneId).toBe(3);
    expect(result.audio.combinedAudio).toBeDefined();
  });

  it("returns a usable combined audio path on cache hit", async () => {
    await newStore();
    mockConcat.mockClear();

    const first = await runNodeWithStore([
      makeScene(1, "Scene one narration."),
      makeScene(2, "Scene two narration."),
    ]);
    const firstUrl = first.audio.combinedAudio?.url;
    const firstArtifactId = first.audio.combinedAudio?.artifactId;
    expect(firstUrl).toBe("combined.wav");
    expect(firstArtifactId).toBeDefined();
    expect(mockConcat).toHaveBeenCalledTimes(1);

    mockSynthesize.mockClear();
    mockConcat.mockClear();

    const second = await runNodeWithStore([
      makeScene(1, "Scene one narration."),
      makeScene(2, "Scene two narration."),
    ]);

    expect(mockSynthesize).not.toHaveBeenCalled();
    expect(mockConcat).not.toHaveBeenCalled();
    expect(second.audio.combinedAudio?.url).toBe(firstUrl);
    expect(second.audio.combinedAudio?.artifactId).toBe(firstArtifactId);
    expect(second.audio.combinedAudio?.sourceSceneArtifactIds).toEqual(
      first.audio.combinedAudio?.sourceSceneArtifactIds,
    );
  });
});

describe("narrationGenerationMode config", () => {
  const originalMode = process.env.NARRATION_GENERATION_MODE;
  const originalProvider = process.env.TTS_PROVIDER;

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.NARRATION_GENERATION_MODE;
    } else {
      process.env.NARRATION_GENERATION_MODE = originalMode;
    }
    if (originalProvider === undefined) {
      delete process.env.TTS_PROVIDER;
    } else {
      process.env.TTS_PROVIDER = originalProvider;
    }
  });

  it("defaults to scene when TTS_PROVIDER is chatterbox", () => {
    delete process.env.NARRATION_GENERATION_MODE;
    process.env.TTS_PROVIDER = "chatterbox";
    expect(config.narrationGenerationMode()).toBe("scene");
  });

  it("defaults to complete when TTS_PROVIDER is openrouter", () => {
    delete process.env.NARRATION_GENERATION_MODE;
    process.env.TTS_PROVIDER = "openrouter";
    expect(config.narrationGenerationMode()).toBe("complete");
  });

  it("defaults to scene when both NARRATION_GENERATION_MODE and TTS_PROVIDER are unset", () => {
    delete process.env.NARRATION_GENERATION_MODE;
    delete process.env.TTS_PROVIDER;
    expect(config.narrationGenerationMode()).toBe("scene");
  });

  it("returns scene for NARRATION_GENERATION_MODE=scene", () => {
    process.env.NARRATION_GENERATION_MODE = "scene";
    expect(config.narrationGenerationMode()).toBe("scene");
  });

  it("returns complete for NARRATION_GENERATION_MODE=complete", () => {
    process.env.NARRATION_GENERATION_MODE = "complete";
    expect(config.narrationGenerationMode()).toBe("complete");
  });

  it("falls through to provider default for invalid values", () => {
    process.env.NARRATION_GENERATION_MODE = "invalid";
    process.env.TTS_PROVIDER = "openrouter";
    expect(config.narrationGenerationMode()).toBe("complete");
  });
});

describe("narrationGeneratorNode complete mode", () => {
  const original = process.env.NARRATION_GENERATION_MODE;

  beforeEach(() => {
    process.env.NARRATION_GENERATION_MODE = "complete";
    mockSynthesize.mockReset();
    mockConcat.mockReset();
    mockSynthesize.mockImplementation(async (opts: { text: string }) => ({
      audioUrl: `complete-${opts.text.length}.wav`,
      durationMs: opts.text.length * 10,
    }));
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.NARRATION_GENERATION_MODE;
    } else {
      process.env.NARRATION_GENERATION_MODE = original;
    }
  });

  function runComplete(
    scenes: Scene[],
    contentNarration: string,
    provider: TTSProvider = mockTTSProvider,
  ) {
    return narrationGeneratorNode(
      {
        project: { pillar: "Geography", topic: "Test" },
        content: { narration: contentNarration },
        production: { scenes },
        execution: { version: "0.1.0" },
      } as ProjectState,
      {
        configurable: {
          ttsProvider: provider,
          audioConcatenator: mockConcat,
        },
      } as any,
    );
  }

  it("makes exactly one TTS call with the full narration text", async () => {
    const result = await runComplete(
      [
        makeScene(1, "Scene one narration."),
        makeScene(2, "Scene two narration."),
      ],
      "Full narration combining all scenes.",
    );

    expect(mockSynthesize).toHaveBeenCalledTimes(1);
    expect(mockSynthesize.mock.calls[0][0].text).toBe(
      "Full narration combining all scenes.",
    );
    expect(mockConcat).not.toHaveBeenCalled();
    expect(result.audio.version).toBe(2);
    expect(result.audio.scenes).toHaveLength(2);
    expect(result.audio.combinedAudio?.sourceSceneArtifactIds).toHaveLength(2);
  });

  it("estimates scene durations proportionally to word count", async () => {
    const sceneOne = "one two three four five six seven eight nine ten";
    const sceneTwo =
      "one two three four five six seven eight nine ten eleven twelve " +
      "thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty";
    mockSynthesize.mockImplementation(async () => ({
      audioUrl: "complete.wav",
      durationMs: 3000,
    }));

    const result = await runComplete(
      [makeScene(1, sceneOne), makeScene(2, sceneTwo)],
      `${sceneOne} ${sceneTwo}`,
    );

    const scenes = result.audio.scenes;
    // Scene 1 has 10 words of 30 total → 1000ms; Scene 2 has 20 → 2000ms.
    expect(scenes?.[0].durationMs).toBe(1000);
    expect(scenes?.[1].durationMs).toBe(2000);
    expect(scenes?.[0].durationMs! + scenes?.[1].durationMs!).toBe(3000);
  });

  it("provides narrationUrl and combined audio from the single synthesis", async () => {
    const result = await runComplete(
      [makeScene(1, "Hello world.")],
      "Hello world.",
    );

    expect(result.audio.narrationUrl).toBe("complete-12.wav");
    expect(result.audio.narrationDurationMs).toBe(120);
    expect(result.audio.combinedAudio?.url).toBe("complete-12.wav");
    expect(result.audio.combinedAudio?.durationMs).toBe(120);
  });

  it("does not set per-scene audio URLs in complete mode", async () => {
    const result = await runComplete(
      [makeScene(1, "Hello world.")],
      "Hello world.",
    );

    expect(result.audio.scenes?.[0].url).toBeUndefined();
    expect(result.audio.scenes?.[0].artifactId).toBeDefined();
    expect(result.audio.combinedAudio?.artifactId).toBeDefined();
  });

  it("fails when content.narration is missing without calling TTS", async () => {
    const result = await narrationGeneratorNode(
      {
        project: { pillar: "Geography", topic: "Test" },
        content: {},
        production: { scenes: [makeScene(1, "Scene one.")] },
        execution: { version: "0.1.0" },
      } as ProjectState,
      {
        configurable: {
          ttsProvider: mockTTSProvider,
          audioConcatenator: mockConcat,
        },
      } as any,
    );

    expect(result.diagnostics.errors?.[0]).toContain("content.narration");
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it("reports provider failures in complete mode", async () => {
    mockSynthesize.mockRejectedValue(new Error("service unavailable"));
    const result = await runComplete(
      [makeScene(1, "Hello world.")],
      "Hello world.",
    );

    expect(result.diagnostics.errors?.[0]).toContain("TTS synthesis failed");
    expect(result.audio.combinedAudio).toBeUndefined();
  });

  it("preserves scene order by scene ID", async () => {
    const result = await runComplete(
      [
        makeScene(3, "Third scene."),
        makeScene(1, "First scene."),
        makeScene(2, "Second scene."),
      ],
      "First scene. Second scene. Third scene.",
    );

    expect(result.audio.scenes?.map((scene) => scene.sceneId)).toEqual([
      1, 2, 3,
    ]);
  });

  it("supports stub provider with a single synthesis", async () => {
    const result = await runComplete(
      [makeScene(1, "Stub scene.")],
      "Stub complete narration.",
      new StubTTSProvider(),
    );

    expect(result.audio.narrationUrl).toBe(
      "https://placeholder.local/narration.wav",
    );
    expect(result.audio.narrationDurationMs).toBeGreaterThan(0);
    expect(result.audio.version).toBe(2);
  });
});
