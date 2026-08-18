import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from "@jest/globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnableConfig } from "@langchain/core/runnables";
import { FilesystemArtifactStore } from "../src/artifacts/fs/fs-artifact-store.js";
import {
  runWithArtifactCache,
  cacheNodeResult,
  completeArtifactForNode,
  type ComputeResult,
} from "../src/artifacts/cache.js";

let dir: string;
let store: FilesystemArtifactStore;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "artifact-cache-test-"));
  process.env.ARTIFACT_STORE_DIR = dir;
  store = new FilesystemArtifactStore();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.ARTIFACT_STORE_DIR;
});

function makeConfig(extra: Record<string, unknown> = {}): RunnableConfig {
  return {
    configurable: { runId: "run-cache", artifactStore: store, ...extra },
  } as RunnableConfig;
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
      promptTokens: 10,
      completionTokens: 20,
      totalTokens: 30,
      retries: 0,
      promptVersion: "prompts/script",
      agentVersion: "1.0.0",
      fromCache: false,
      ...overrides,
    },
  };
}

const PROMPT = "You are a script writer.\n---\n{{title}}";
const loadPromptMock = jest
  .fn<(...args: any[]) => Promise<string>>()
  .mockResolvedValue(PROMPT);

describe("runWithArtifactCache", () => {
  beforeEach(() => {
    loadPromptMock.mockReset();
    loadPromptMock.mockResolvedValue(PROMPT);
  });

  it("saves on miss and returns fromCache false", async () => {
    const compute = jest
      .fn<() => Promise<ComputeResult<unknown>>>()
      .mockResolvedValue(computeResult({ title: "T" }));
    const config = makeConfig();

    const result = await runWithArtifactCache(
      {
        type: "script",
        agent: "ScriptWriter",
        promptPath: "prompts/script.md",
        variables: { title: "T" },
        loadPrompt: loadPromptMock,
      },
      compute,
      config,
    );

    expect(compute).toHaveBeenCalledTimes(1);
    expect(result.telemetry.fromCache).toBe(false);
    expect(result.telemetry.artifactRef?.version).toBe(1);
    expect(result.data).toEqual({ title: "T" });
  });

  it("returns fromCache true and skips compute on a hash-identical hit", async () => {
    const compute = jest
      .fn<() => Promise<ComputeResult<unknown>>>()
      .mockResolvedValue(computeResult({ title: "T" }));
    const config = makeConfig();

    await runWithArtifactCache(
      {
        type: "script",
        agent: "ScriptWriter",
        promptPath: "prompts/script.md",
        variables: { title: "T" },
        loadPrompt: loadPromptMock,
      },
      compute,
      config,
    );

    const second = await runWithArtifactCache(
      {
        type: "script",
        agent: "ScriptWriter",
        promptPath: "prompts/script.md",
        variables: { title: "T" },
        loadPrompt: loadPromptMock,
      },
      compute,
      config,
    );

    expect(compute).toHaveBeenCalledTimes(1);
    expect(second.telemetry.fromCache).toBe(true);
    expect(second.data).toEqual({ title: "T" });
    expect(second.telemetry.durationMs).toBe(0);
  });

  it("recomputes (new version) when a variable changes the hash", async () => {
    const compute = jest
      .fn<() => Promise<ComputeResult<unknown>>>()
      .mockImplementation(async () => computeResult({ title: "T" }));
    const config = makeConfig();

    await runWithArtifactCache(
      {
        type: "script",
        agent: "ScriptWriter",
        promptPath: "prompts/script.md",
        variables: { title: "A" },
        loadPrompt: loadPromptMock,
      },
      compute,
      config,
    );
    const second = await runWithArtifactCache(
      {
        type: "script",
        agent: "ScriptWriter",
        promptPath: "prompts/script.md",
        variables: { title: "B" },
        loadPrompt: loadPromptMock,
      },
      compute,
      config,
    );

    expect(compute).toHaveBeenCalledTimes(2);
    expect(second.telemetry.fromCache).toBe(false);
    expect(second.telemetry.artifactRef?.version).toBe(2);
  });

  it("recomputes when the prompt file content changes", async () => {
    const compute = jest
      .fn<() => Promise<ComputeResult<unknown>>>()
      .mockResolvedValue(computeResult({ title: "T" }));
    const config = makeConfig();

    await runWithArtifactCache(
      {
        type: "script",
        agent: "ScriptWriter",
        promptPath: "prompts/script.md",
        variables: { title: "T" },
        loadPrompt: loadPromptMock,
      },
      compute,
      config,
    );

    loadPromptMock.mockResolvedValue("A different prompt entirely.");
    const second = await runWithArtifactCache(
      {
        type: "script",
        agent: "ScriptWriter",
        promptPath: "prompts/script.md",
        variables: { title: "T" },
        loadPrompt: loadPromptMock,
      },
      compute,
      config,
    );

    expect(compute).toHaveBeenCalledTimes(2);
    expect(second.telemetry.fromCache).toBe(false);
  });

  it("does not hit cache when latest artifact is pending", async () => {
    const compute = jest
      .fn<() => Promise<ComputeResult<unknown>>>()
      .mockResolvedValue(computeResult({ title: "T" }));
    const config = makeConfig();

    await runWithArtifactCache(
      {
        type: "script",
        agent: "ScriptWriter",
        promptPath: "prompts/script.md",
        variables: { title: "T" },
        deferComplete: true,
        loadPrompt: loadPromptMock,
      },
      compute,
      config,
    );

    await runWithArtifactCache(
      {
        type: "script",
        agent: "ScriptWriter",
        promptPath: "prompts/script.md",
        variables: { title: "T" },
        loadPrompt: loadPromptMock,
      },
      compute,
      config,
    );

    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("completeArtifactForNode flips a deferred artifact to complete and enables cache hits", async () => {
    const compute = jest
      .fn<() => Promise<ComputeResult<unknown>>>()
      .mockResolvedValue(computeResult({ title: "T" }));
    const config = makeConfig();

    await runWithArtifactCache(
      {
        type: "script",
        agent: "ScriptWriter",
        promptPath: "prompts/script.md",
        variables: { title: "T" },
        deferComplete: true,
        loadPrompt: loadPromptMock,
      },
      compute,
      config,
    );

    await completeArtifactForNode(config, "ScriptWriter");

    const second = await runWithArtifactCache(
      {
        type: "script",
        agent: "ScriptWriter",
        promptPath: "prompts/script.md",
        variables: { title: "T" },
        loadPrompt: loadPromptMock,
      },
      compute,
      config,
    );

    expect(compute).toHaveBeenCalledTimes(1);
    expect(second.telemetry.fromCache).toBe(true);
  });

  it("calls the semantic validate hook and recomputes when it rejects", async () => {
    const compute = jest
      .fn<() => Promise<ComputeResult<unknown>>>()
      .mockResolvedValue(computeResult({ scenes: [] }));
    const config = makeConfig();
    const validate = jest.fn<(a: unknown) => boolean>().mockReturnValue(false);

    await runWithArtifactCache(
      {
        type: "visualDirector",
        agent: "VisualDirector",
        promptPath: "prompts/visual-director.md",
        variables: {},
        loadPrompt: loadPromptMock,
        validate,
      },
      compute,
      config,
    );

    const second = await runWithArtifactCache(
      {
        type: "visualDirector",
        agent: "VisualDirector",
        promptPath: "prompts/visual-director.md",
        variables: {},
        loadPrompt: loadPromptMock,
        validate,
      },
      compute,
      config,
    );

    expect(compute).toHaveBeenCalledTimes(2);
    expect(second.telemetry.fromCache).toBe(false);
  });

  it("does not persist or cache when compute fails", async () => {
    const failing = jest
      .fn<() => Promise<ComputeResult<unknown>>>()
      .mockResolvedValue({
        data: null,
        error: "LLM failed",
        telemetry: {
          model: "test-model",
          durationMs: 50,
          retries: 2,
          promptVersion: "prompts/script",
          agentVersion: "1.0.0",
          fromCache: false,
        },
      });
    const config = makeConfig();

    const result = await runWithArtifactCache(
      {
        type: "script",
        agent: "ScriptWriter",
        promptPath: "prompts/script.md",
        variables: { title: "T" },
        loadPrompt: loadPromptMock,
      },
      failing,
      config,
    );

    expect(result.data).toBeNull();
    expect(result.error).toBe("LLM failed");

    expect(await store.exists("run-cache", "script")).toBe(false);
  });

  it("runs compute directly when the store is disabled", async () => {
    const compute = jest
      .fn<() => Promise<ComputeResult<unknown>>>()
      .mockResolvedValue(computeResult({ title: "T" }));
    const config = {
      configurable: { runId: "run-nostore", artifactStore: null },
    } as RunnableConfig;

    const result = await runWithArtifactCache(
      {
        type: "script",
        agent: "ScriptWriter",
        promptPath: "prompts/script.md",
        variables: { title: "T" },
        loadPrompt: loadPromptMock,
      },
      compute,
      config,
    );

    expect(compute).toHaveBeenCalledTimes(1);
    expect(result.telemetry.fromCache).toBe(false);
  });

  it("runs compute directly when there is no runId", async () => {
    const compute = jest
      .fn<() => Promise<ComputeResult<unknown>>>()
      .mockResolvedValue(computeResult({ title: "T" }));
    const config = { configurable: { artifactStore: store } } as RunnableConfig;

    const result = await runWithArtifactCache(
      {
        type: "script",
        agent: "ScriptWriter",
        promptPath: "prompts/script.md",
        variables: { title: "T" },
        loadPrompt: loadPromptMock,
      },
      compute,
      config,
    );

    expect(compute).toHaveBeenCalledTimes(1);
    expect(result.telemetry.fromCache).toBe(false);
  });

  it("hits cache via findCompleteByInputHash when latest version hash differs but older matches", async () => {
    const compute = jest
      .fn<() => Promise<ComputeResult<unknown>>>()
      .mockImplementation(async () => computeResult({ title: "T" }));
    const config = makeConfig();

    await runWithArtifactCache(
      {
        type: "prompts",
        agent: "ImagePromptGenerator",
        promptPath: "prompts/image-prompt.md",
        variables: { scenes: "v1" },
        loadPrompt: loadPromptMock,
      },
      compute,
      config,
    );

    loadPromptMock.mockResolvedValue("A different prompt entirely.");
    await runWithArtifactCache(
      {
        type: "prompts",
        agent: "ImagePromptGenerator",
        promptPath: "prompts/image-prompt.md",
        variables: { scenes: "v2" },
        loadPrompt: loadPromptMock,
      },
      compute,
      config,
    );

    expect(compute).toHaveBeenCalledTimes(2);

    loadPromptMock.mockResolvedValue(PROMPT);
    const third = await runWithArtifactCache(
      {
        type: "prompts",
        agent: "ImagePromptGenerator",
        promptPath: "prompts/image-prompt.md",
        variables: { scenes: "v1" },
        loadPrompt: loadPromptMock,
      },
      compute,
      config,
    );

    expect(compute).toHaveBeenCalledTimes(2);
    expect(third.telemetry.fromCache).toBe(true);
    expect(third.data).toEqual({ title: "T" });
    expect(third.telemetry.artifactRef?.version).toBe(1);
  });
});

describe("cacheNodeResult", () => {
  it("caches provider results and serves hits by input hash", async () => {
    const compute = jest
      .fn<() => Promise<{ data: unknown; error?: string }>>()
      .mockResolvedValue({ data: { urls: ["a.mp4"] } });
    const config = makeConfig();

    const first = await cacheNodeResult(
      { type: "assets", node: "AssetGenerator", key: { scene: 1 } },
      compute,
      config,
    );

    const second = await cacheNodeResult(
      { type: "assets", node: "AssetGenerator", key: { scene: 1 } },
      compute,
      config,
    );

    expect(compute).toHaveBeenCalledTimes(1);
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    expect(second.data).toEqual({ urls: ["a.mp4"] });
  });

  it("recomputes when the key differs", async () => {
    const compute = jest
      .fn<() => Promise<{ data: unknown; error?: string }>>()
      .mockResolvedValue({ data: { n: 1 } });
    const config = makeConfig();

    await cacheNodeResult(
      { type: "assets", node: "AssetGenerator", key: { scene: 1 } },
      compute,
      config,
    );
    await cacheNodeResult(
      { type: "assets", node: "AssetGenerator", key: { scene: 2 } },
      compute,
      config,
    );

    expect(compute).toHaveBeenCalledTimes(2);
  });

  it("finds unchanged scene artifacts in older versions", async () => {
    const compute = jest
      .fn<() => Promise<{ data: unknown; error?: string }>>()
      .mockImplementation(async () => ({ data: { audio: true } }));
    const config = makeConfig();

    await cacheNodeResult(
      {
        type: "audio",
        node: "NarrationGenerator",
        lookupAllVersions: true,
        key: { kind: "scene", sceneId: 1, narration: "one" },
      },
      compute,
      config,
    );
    await cacheNodeResult(
      {
        type: "audio",
        node: "NarrationGenerator",
        lookupAllVersions: true,
        key: { kind: "scene", sceneId: 2, narration: "two" },
      },
      compute,
      config,
    );
    const reused = await cacheNodeResult(
      {
        type: "audio",
        node: "NarrationGenerator",
        lookupAllVersions: true,
        key: { kind: "scene", sceneId: 1, narration: "one" },
      },
      compute,
      config,
    );

    expect(compute).toHaveBeenCalledTimes(2);
    expect(reused.fromCache).toBe(true);
    expect(reused.ref?.version).toBe(1);
  });

  it("preserves compute errors when provider data is non-null", async () => {
    const compute = jest
      .fn<() => Promise<{ data: unknown; error?: string }>>()
      .mockResolvedValue({ data: { partial: true }, error: "Scene failed" });

    const result = await cacheNodeResult(
      { type: "assets", node: "AssetGenerator", key: { scene: 1 } },
      compute,
      makeConfig(),
    );

    expect(result.data).toEqual({ partial: true });
    expect(result.error).toBe("Scene failed");
  });
});
