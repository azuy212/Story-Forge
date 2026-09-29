import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnableConfig } from "@langchain/core/runnables";
import { FilesystemArtifactStore } from "../src/artifacts/fs/fs-artifact-store.js";
import {
  runWithArtifactCache,
  cacheNodeResult,
  type ComputeResult,
} from "../src/artifacts/cache.js";

let dir: string;
let payloads: string;
let store: FilesystemArtifactStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "manual-override-test-"));
  payloads = join(dir, "payloads");
  mkdirSync(payloads, { recursive: true });
  process.env.ARTIFACT_STORE_DIR = dir;
  store = new FilesystemArtifactStore();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ARTIFACT_STORE_DIR;
});

function makeConfig(extra: Record<string, unknown> = {}): RunnableConfig {
  return {
    configurable: { runId: "run-override", artifactStore: store, ...extra },
  } as RunnableConfig;
}

function writePayload(name: string, data: unknown): string {
  const path = join(payloads, name);
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
  return path;
}

function mkdirPayload(name: string): string {
  const path = join(payloads, name);
  mkdirSync(path, { recursive: true });
  return path;
}

function computeResult(
  data: unknown,
  overrides: Partial<ComputeResult<unknown>["telemetry"]> = {},
): ComputeResult<unknown> {
  return {
    data,
    telemetry: {
      model: "test-model",
      durationMs: 100,
      retries: 0,
      promptVersion: "prompts/test",
      agentVersion: "1.0.0",
      fromCache: false,
      ...overrides,
    },
  };
}

const PROMPT = "Prompt body.\n---\n{{title}}";
const loadPromptMock = jest
  .fn<(...args: any[]) => Promise<string>>()
  .mockResolvedValue(PROMPT);

function scriptQaOptions(extra: Record<string, unknown> = {}) {
  return {
    type: "scriptQA" as const,
    agent: "ScriptQA",
    promptPath: "prompts/script-qa.md",
    variables: { script: "S" },
    loadPrompt: loadPromptMock,
    ...extra,
  };
}

function makeScene(id: number) {
  return {
    sceneId: id,
    narration: "Scene narration text.",
    sceneGoal: "Goal",
    visualDescription: "Visual",
    sceneType: "landscape" as const,
    assetMode: "generated" as const,
    sceneRole: "narrative" as const,
    cameraShot: "wide" as const,
    cameraMotion: "static" as const,
    transition: "cut" as const,
    emotionalBeat: "mystery" as const,
  };
}

function makeVisualPlan(id: number) {
  return {
    sceneId: id,
    renderStyle: "photorealistic" as const,
    colorMood: "cool blue",
    lighting: "soft",
    composition: "rule of thirds",
  };
}

function longVisualDirectorPayload(scenes = 25) {
  const sceneList = Array.from({ length: scenes }, (_, i) => makeScene(i + 1));
  return {
    scenes: sceneList,
    visualPlans: sceneList.map((s) => makeVisualPlan(s.sceneId)),
  };
}

beforeEach(() => {
  loadPromptMock.mockReset();
  loadPromptMock.mockResolvedValue(PROMPT);
});

describe("manual artifact override: LLM cache path", () => {
  it("serves the file payload without calling compute", async () => {
    const path = writePayload("scriptQA.json", { status: "approved" });
    const compute = jest
      .fn<() => Promise<ComputeResult<unknown>>>()
      .mockResolvedValue(computeResult({ status: "fatal" }));

    const result = await runWithArtifactCache(
      scriptQaOptions({ manualArtifacts: { scriptQA: path } }),
      compute,
      makeConfig({ manualArtifacts: { scriptQA: path } }),
    );

    expect(compute).not.toHaveBeenCalled();
    expect(result.data).toEqual({ status: "approved" });
    expect(result.telemetry.fromCache).toBe(true);
    expect(result.telemetry.model).toBe("manual");
    expect(result.telemetry.durationMs).toBe(0);
    expect(result.telemetry.artifactRef?.version).toBe(1);
  });

  it("persists a complete artifact with empty inputHash, sourceOverride meta, manifest entry and execution ref", async () => {
    const path = writePayload("scriptQA.json", { status: "approved" });
    const config = makeConfig({ manualArtifacts: { scriptQA: path } });

    const result = await runWithArtifactCache(
      scriptQaOptions(),
      jest.fn<() => Promise<ComputeResult<unknown>>>(),
      config,
    );

    const record = await store.latest("run-override", "scriptQA");
    expect(record?.status).toBe("complete");
    expect(record?.meta.inputHash).toBe("");
    expect(record?.meta.sourceOverride).toBe(true);
    expect(record?.data).toEqual({ status: "approved" });

    const manifest = await store.getManifest("run-override");
    expect(manifest?.scriptQA?.latest).toBe("v1");
    const version = manifest?.scriptQA?.versions?.find((v) => v.version === 1);
    expect(version?.status).toBe("complete");

    const execRefs = JSON.parse(
      readFileSync(
        join(dir, "run-override", "state", "execution.json"),
        "utf-8",
      ),
    );
    expect(execRefs["scriptQA@v1"]).toEqual(result.telemetry.artifactRef);

    expect(result.telemetry.artifactRef).toMatchObject({
      type: "scriptQA",
      version: 1,
      runId: "run-override",
    });
  });

  it("a later plain resume without the flag does not match the empty inputHash", async () => {
    const path = writePayload("scriptQA.json", { status: "approved" });
    const compute = jest
      .fn<() => Promise<ComputeResult<unknown>>>()
      .mockResolvedValue(computeResult({ status: "approved" }));

    await runWithArtifactCache(
      scriptQaOptions(),
      compute,
      makeConfig({ manualArtifacts: { scriptQA: path } }),
    );
    expect(compute).not.toHaveBeenCalled();

    const plain = await runWithArtifactCache(
      scriptQaOptions(),
      compute,
      makeConfig(),
    );
    expect(compute).toHaveBeenCalledTimes(1);
    expect(plain.telemetry.fromCache).toBe(false);
    expect(plain.telemetry.artifactRef?.version).toBe(2);
  });

  it("override wins even when a stale complete artifact exists for the type", async () => {
    writePayload("scriptQA.json", { status: "minor_revision" });
    const compute = jest
      .fn<() => Promise<ComputeResult<unknown>>>()
      .mockResolvedValue(computeResult({ status: "minor_revision" }));

    await runWithArtifactCache(scriptQaOptions(), compute, makeConfig());
    expect(compute).toHaveBeenCalledTimes(1);

    const overridePath = writePayload("approved.json", {
      status: "approved",
    });
    const second = await runWithArtifactCache(
      scriptQaOptions({
        variables: { script: "CHANGED" },
        manualArtifacts: { scriptQA: overridePath },
      }),
      compute,
      makeConfig({ manualArtifacts: { scriptQA: overridePath } }),
    );

    expect(compute).toHaveBeenCalledTimes(1);
    expect(second.data).toEqual({ status: "approved" });
    expect(second.telemetry.fromCache).toBe(true);
    expect(second.telemetry.artifactRef?.version).toBe(2);

    const record = await store.latest<{ status: string }>(
      "run-override",
      "scriptQA",
    );
    expect(record?.data.status).toBe("approved");
    expect(record?.meta.inputHash).toBe("");
  });

  it("throws when the override payload fails schema validation", async () => {
    const path = writePayload("scriptQA.json", { status: "not-a-status" });

    await expect(
      runWithArtifactCache(
        scriptQaOptions(),
        jest.fn<() => Promise<ComputeResult<unknown>>>(),
        makeConfig({ manualArtifacts: { scriptQA: path } }),
      ),
    ).rejects.toThrow('Manual artifact override invalid for type "scriptQA"');
  });

  it("throws when the override payload is rejected by the node validate hook", async () => {
    const path = writePayload("scriptQA.json", { status: "approved" });

    await expect(
      runWithArtifactCache(
        scriptQaOptions({
          validate: () => false,
          manualArtifacts: { scriptQA: path },
        }),
        jest.fn<() => Promise<ComputeResult<unknown>>>(),
        makeConfig({ manualArtifacts: { scriptQA: path } }),
      ),
    ).rejects.toThrow(
      'Manual artifact override rejected by node validation for type "scriptQA"',
    );
  });

  it("throws when the configured path does not exist", async () => {
    await expect(
      runWithArtifactCache(
        scriptQaOptions(),
        jest.fn<() => Promise<ComputeResult<unknown>>>(),
        makeConfig({
          manualArtifacts: { scriptQA: join(payloads, "missing.json") },
        }),
      ),
    ).rejects.toThrow("Manual artifact override path not found");
  });

  it("throws when a configured key is not an injectable artifact type", async () => {
    await expect(
      runWithArtifactCache(
        scriptQaOptions(),
        jest.fn<() => Promise<ComputeResult<unknown>>>(),
        makeConfig({
          manualArtifacts: {
            notAType: writePayload("whatever.json", { ok: true }),
          },
        }),
      ),
    ).rejects.toThrow(
      'manualArtifacts key "notAType" is not an injectable artifact type',
    );
  });

  it("throws when an unkeyed type maps to a directory of multiple files (ambiguous)", async () => {
    const ambiguous = mkdirPayload("scriptQA-dir");
    writeFileSync(
      join(ambiguous, "a.json"),
      JSON.stringify({ status: "approved" }),
    );
    writeFileSync(
      join(ambiguous, "b.json"),
      JSON.stringify({ status: "approved" }),
    );

    await expect(
      runWithArtifactCache(
        scriptQaOptions(),
        jest.fn<() => Promise<ComputeResult<unknown>>>(),
        makeConfig({ manualArtifacts: { scriptQA: ambiguous } }),
      ),
    ).rejects.toThrow("is ambiguous");
  });

  it("throws when the JSON file is malformed", async () => {
    const path = join(payloads, "broken.json");
    writeFileSync(path, "{not json", "utf-8");

    await expect(
      runWithArtifactCache(
        scriptQaOptions(),
        jest.fn<() => Promise<ComputeResult<unknown>>>(),
        makeConfig({ manualArtifacts: { scriptQA: path } }),
      ),
    ).rejects.toThrow("not valid JSON");
  });

  it("throws when manualArtifacts is not an object map", async () => {
    await expect(
      runWithArtifactCache(
        scriptQaOptions(),
        jest.fn<() => Promise<ComputeResult<unknown>>>(),
        makeConfig({ manualArtifacts: "/tmp/some-file.json" }),
      ),
    ).rejects.toThrow("manualArtifacts must be an object");
  });
});

describe("manual artifact override: profile-aware validation", () => {
  it("accepts a 25-scene visualDirector payload when manualArtifactProfile is long", async () => {
    const payload = longVisualDirectorPayload(25);
    const path = writePayload("visualDirector.json", payload);
    const config = makeConfig({
      manualArtifacts: { visualDirector: path },
      manualArtifactProfile: "long",
    });

    const result = await runWithArtifactCache(
      {
        type: "visualDirector",
        agent: "VisualDirector",
        promptPath: "prompts/visual-director.md",
        variables: {},
        loadPrompt: loadPromptMock,
      },
      jest.fn<() => Promise<ComputeResult<unknown>>>(),
      config,
    );

    expect(result.data).toMatchObject({ scenes: expect.any(Array) });
    const scenes = (result.data as { scenes: unknown[] }).scenes;
    expect(scenes).toHaveLength(25);

    const record = await store.latest("run-override", "visualDirector");
    expect(record?.meta.manualArtifactProfile).toBe("long");
  });

  it("rejects a 25-scene visualDirector payload without a profile (short schema max is 12)", async () => {
    const payload = longVisualDirectorPayload(25);
    const path = writePayload("visualDirector.json", payload);

    await expect(
      runWithArtifactCache(
        {
          type: "visualDirector",
          agent: "VisualDirector",
          promptPath: "prompts/visual-director.md",
          variables: {},
          loadPrompt: loadPromptMock,
        },
        jest.fn<() => Promise<ComputeResult<unknown>>>(),
        makeConfig({ manualArtifacts: { visualDirector: path } }),
      ),
    ).rejects.toThrow(
      'Manual artifact override invalid for type "visualDirector"',
    );
  });
});

describe("manual artifact override: keyed node cache path (cacheNodeResult)", () => {
  it("selects scene-<id>.json from a directory for scene-keyed calls", async () => {
    const dirPath = mkdirPayload("subtitles-dir");
    writeFileSync(
      join(dirPath, "scene-1.json"),
      JSON.stringify({ srt: "1\n00:00:00,000 --> 00:00:01,000\none" }),
    );
    writeFileSync(
      join(dirPath, "scene-2.json"),
      JSON.stringify({ srt: "2\n00:00:00,000 --> 00:00:01,000\ntwo" }),
    );
    const config = makeConfig({ manualArtifacts: { subtitles: dirPath } });
    const compute = jest
      .fn<() => Promise<{ data: unknown; error?: string }>>()
      .mockResolvedValue({ data: { srt: "computed" } });

    const first = await cacheNodeResult(
      { type: "subtitles", node: "SubtitleGenerator", key: { sceneId: 1 } },
      compute,
      config,
    );
    const second = await cacheNodeResult(
      { type: "subtitles", node: "SubtitleGenerator", key: { sceneId: 2 } },
      compute,
      config,
    );

    expect(compute).not.toHaveBeenCalled();
    expect(first.fromCache).toBe(true);
    expect(first.data).toMatchObject({ srt: expect.stringContaining("one") });
    expect(second.data).toMatchObject({ srt: expect.stringContaining("two") });
    expect(first.ref?.version).toBe(1);
    expect(second.ref?.version).toBe(2);
  });

  it("falls through to the normal cache path when the directory has no scene file for this key", async () => {
    const dirPath = mkdirPayload("combined-only");
    writeFileSync(
      join(dirPath, "combined.json"),
      JSON.stringify({
        voice: "narrator",
        combinedAudio: {
          durationMs: 1000,
          url: "file:///tmp/combined.mp3",
          sourceSceneArtifactIds: ["s1"],
        },
      }),
    );
    const compute = jest
      .fn<() => Promise<{ data: unknown; error?: string }>>()
      .mockResolvedValue({ data: { voice: "computed" } });

    const result = await cacheNodeResult(
      {
        type: "audio",
        node: "NarrationGenerator",
        key: { kind: "scene", sceneId: 7 },
      },
      compute,
      makeConfig({ manualArtifacts: { audio: dirPath } }),
    );

    expect(compute).toHaveBeenCalledTimes(1);
    expect(result.fromCache).toBe(false);
    expect(result.data).toEqual({ voice: "computed" });
  });

  it("selects <kind>.json for kind-keyed calls", async () => {
    const dirPath = mkdirPayload("audio-dir");
    writeFileSync(
      join(dirPath, "combined.json"),
      JSON.stringify({
        voice: "narrator",
        combinedAudio: {
          durationMs: 1000,
          url: "file:///tmp/combined.mp3",
          sourceSceneArtifactIds: ["s1"],
        },
      }),
    );
    const compute = jest
      .fn<() => Promise<{ data: unknown; error?: string }>>()
      .mockResolvedValue({ data: null, error: "TTS down" });

    const result = await cacheNodeResult(
      { type: "audio", node: "NarrationGenerator", key: { kind: "combined" } },
      compute,
      makeConfig({ manualArtifacts: { audio: dirPath } }),
    );

    expect(compute).not.toHaveBeenCalled();
    expect(result.fromCache).toBe(true);
    expect(result.data).toMatchObject({
      combinedAudio: { url: "file:///tmp/combined.mp3" },
    });
  });

  it("never serves a scene-N.json file to a kind-keyed call that misses kind.json", async () => {
    const dirPath = mkdirPayload("scenes-only");
    writeFileSync(
      join(dirPath, "scene-1.json"),
      JSON.stringify({ srt: "one" }),
    );
    const compute = jest
      .fn<() => Promise<{ data: unknown; error?: string }>>()
      .mockResolvedValue({ data: { srt: "computed" } });

    const result = await cacheNodeResult(
      {
        type: "subtitles",
        node: "SubtitleGenerator",
        key: { kind: "combined" },
      },
      compute,
      makeConfig({ manualArtifacts: { subtitles: dirPath } }),
    );

    expect(compute).toHaveBeenCalledTimes(1);
    expect(result.fromCache).toBe(false);
  });

  it("returns an error result (without calling compute) when the override file is missing", async () => {
    const compute = jest
      .fn<() => Promise<{ data: unknown; error?: string }>>()
      .mockResolvedValue({ data: { srt: "computed" } });

    const result = await cacheNodeResult(
      {
        type: "subtitles",
        node: "SubtitleGenerator",
        key: { sceneId: 1 },
      },
      compute,
      makeConfig({
        manualArtifacts: { subtitles: join(payloads, "nope.json") },
      }),
    );

    expect(compute).not.toHaveBeenCalled();
    expect(result.data).toBeNull();
    expect(result.fromCache).toBe(false);
    expect(result.error).toContain("Manual artifact override path not found");
  });

  it("returns an error result when the override payload fails schema validation", async () => {
    const path = writePayload("scene-1.json", { wordTimestamps: "nope" });
    const compute = jest
      .fn<() => Promise<{ data: unknown; error?: string }>>()
      .mockResolvedValue({ data: { srt: "computed" } });

    const result = await cacheNodeResult(
      {
        type: "subtitles",
        node: "SubtitleGenerator",
        key: { sceneId: 1 },
      },
      compute,
      makeConfig({ manualArtifacts: { subtitles: path } }),
    );

    expect(compute).not.toHaveBeenCalled();
    expect(result.data).toBeNull();
    expect(result.error).toContain(
      'Manual artifact override invalid for type "subtitles"',
    );
  });

  it("ignores an unconfigured type while other keys are configured", async () => {
    const path = writePayload("scriptQA.json", { status: "approved" });
    const compute = jest
      .fn<() => Promise<{ data: unknown; error?: string }>>()
      .mockResolvedValue({ data: { srt: "computed" } });

    const result = await cacheNodeResult(
      {
        type: "subtitles",
        node: "SubtitleGenerator",
        key: { sceneId: 1 },
      },
      compute,
      makeConfig({ manualArtifacts: { scriptQA: path } }),
    );

    expect(compute).toHaveBeenCalledTimes(1);
    expect(result.fromCache).toBe(false);
    expect(result.data).toEqual({ srt: "computed" });
  });
});
