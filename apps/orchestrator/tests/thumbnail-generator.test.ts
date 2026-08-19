import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import {
  isUsableThumbnailImage,
  thumbnailGeneratorNode,
} from "../src/agents/thumbnail-generator.node.js";
import type { ProjectState } from "../src/types/index.js";

const mockGenerate = jest.fn<(...args: any[]) => Promise<any>>();

const MOCK_PROMPT = [
  "You are a YouTube thumbnail designer.",
  "---",
  "Title: {{title}}",
].join("\n");

function makeMocks() {
  const createModel = jest.fn<
    (...args: any[]) => { model: string; generate: typeof mockGenerate }
  >(() => ({
    model: "test-model",
    generate: mockGenerate,
  }));
  const loadPrompt = jest
    .fn<(...args: any[]) => Promise<string>>()
    .mockImplementation(() => Promise.resolve(MOCK_PROMPT));
  return { createModel, loadPrompt };
}

function runNode(
  state?: Partial<ProjectState>,
  compositorOverrides?: Record<string, unknown>,
  configOverrides?: Record<string, unknown>,
) {
  const mocks = makeMocks();
  const assetProvider = {
    generateImage: jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue({ url: "https://placeholder.local/thumbnail.png" }),
    generateVideo: jest.fn<(...args: any[]) => Promise<any>>(),
  };
  const compositor = {
    version: "1.0.0",
    fingerprint: jest.fn<(...args: any[]) => string>(() => "test-compositor"),
    composite: jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockImplementation(async (opts: any) => ({
        url: opts.sourceUrl,
        width: 1080,
        height: 1920,
      })),
    ...compositorOverrides,
  };
  const promise = thumbnailGeneratorNode(
    {
      project: { pillar: "Geography", topic: "Test" },
      content: {
        title: "Test Title",
        hook: "Test hook?",
        narration: "Test narration.",
      },
      branding: {
        channel: "TestChannel",
        creator: "",
        cta: "",
        style: "Documentary",
        colorPalette: "Cold blue",
      },
      execution: { version: "0.1.0" },
      ...state,
    } as ProjectState,
    {
      configurable: {
        ...mocks,
        assetProvider,
        thumbnailCompositor: compositor,
        ...configOverrides,
      },
    } as any,
  );
  return { promise, mocks, assetProvider, compositor };
}

function buildLLMResponse(data: unknown) {
  return {
    choices: [{ message: { content: JSON.stringify(data) } }],
    usage: { prompt_tokens: 16, completion_tokens: 12, total_tokens: 28 },
    model: "test-model",
  };
}

// In-memory artifact store that only serves thumbnailImage artifacts, forcing
// the LLM agent to recompute on every run. Simulates pending->complete via
// markStatus so a completed (QA-passed) thumbnail is servable from cache.
function createMemoryStore() {
  const records: Array<{
    runId: string;
    type: string;
    version: number;
    status: string;
    meta: Record<string, unknown>;
    data: unknown;
  }> = [];
  const versions: Record<string, number> = {};
  return {
    records,
    latest: async (runId: string, type: string) => {
      if (type !== "thumbnailImage") return null;
      const list = records.filter((r) => r.runId === runId && r.type === type);
      const last = list[list.length - 1];
      if (!last) return null;
      return {
        schemaVersion: 1,
        artifactId: `${type}-v${last.version}`,
        type: last.type,
        version: last.version,
        status: last.status,
        createdAt: new Date().toISOString(),
        meta: last.meta,
        data: last.data,
      };
    },
    findCompleteByInputHash: async () => null,
    save: async (
      runId: string,
      type: string,
      data: unknown,
      meta: Record<string, unknown>,
      status = "complete",
    ) => {
      const version = (versions[type] ?? 0) + 1;
      versions[type] = version;
      records.push({ runId, type, version, status, meta, data });
      return {
        artifactId: `${type}-v${version}`,
        type,
        version,
        location: "/tmp/test.json",
        runId,
      };
    },
    getManifest: async (runId: string) => {
      const out: Record<string, { latest: string; versions: never[] }> = {};
      for (const r of records) {
        if (r.runId !== runId) continue;
        out[r.type] = { latest: `v${r.version}`, versions: [] };
      }
      return out;
    },
    markStatus: async (
      runId: string,
      type: string,
      version: number,
      status: string,
    ) => {
      const r = records.find(
        (x) => x.runId === runId && x.type === type && x.version === version,
      );
      if (r) r.status = status;
    },
    recordRef: async () => undefined,
  };
}

describe("thumbnailGeneratorNode", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    process.env.THUMBNAIL_MODE = "overlay";
    process.env.THUMBNAIL_QA = "true";
  });

  afterEach(() => {
    delete process.env.THUMBNAIL_MODE;
    delete process.env.THUMBNAIL_QA;
  });

  it("rejects cached local thumbnail paths that no longer exist", () => {
    expect(
      isUsableThumbnailImage({
        sourceUrl: "/tmp/source.png",
        imageUrl: "/tmp/missing-thumbnail.png",
        width: 1080,
        height: 1920,
        text: "T",
        textPosition: "center",
        compositorVersion: "1.0.0",
        mode: "overlay",
      }),
    ).toBe(false);
  });

  it("accepts cached provider thumbnail URLs", () => {
    expect(
      isUsableThumbnailImage({
        sourceUrl: "https://cdn.local/source.png",
        imageUrl: "https://cdn.local/thumbnail.png",
        width: 1080,
        height: 1920,
        text: "T",
        textPosition: "center",
        compositorVersion: "1.0.0",
        mode: "overlay",
      }),
    ).toBe(true);
  });

  it("successful generation sets all thumbnail fields", async () => {
    const output = {
      thumbnailPrompt:
        "High contrast aerial view of remote island. Dramatic shadows. Cold blue tones.",
      thumbnailText: "Doesn't Exist?",
      textPosition: "bottom-third",
      colorScheme: "cold blue and white",
    };
    mockGenerate.mockResolvedValueOnce(buildLLMResponse(output));

    const { promise, assetProvider, compositor } = runNode();
    const result = await promise;

    expect(result.thumbnail.thumbnailPrompt).toBe(output.thumbnailPrompt);
    expect(result.thumbnail.thumbnailText).toBe(output.thumbnailText);
    expect(result.thumbnail.textPosition).toBe("bottom-third");
    expect(result.thumbnail.colorScheme).toBe("cold blue and white");
    expect(result.thumbnail.imageUrl).toBe(
      "https://placeholder.local/thumbnail.png",
    );
    expect(result.thumbnail.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.execution?.currentNode).toBe("ThumbnailGenerator");

    const [generateCall] = assetProvider.generateImage.mock.calls.at(-1)!;
    expect(generateCall.sceneId).toBe(0);
    expect(generateCall.filename).toBe("thumbnail.png");
    // Authoritative generation prompt preserves the LLM scene prompt and
    // appends pipeline overlay instructions.
    expect(generateCall.prompt).toContain(output.thumbnailPrompt);
    expect(generateCall.prompt).toContain('overlay text "Doesn\'t Exist?"');
    expect(generateCall.prompt).toContain("1080x1920");
    expect(generateCall.prompt).toContain("Do NOT render any text");

    expect(compositor.composite).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceUrl: "https://placeholder.local/thumbnail.png",
        text: "Doesn't Exist?",
        textPosition: "bottom-third",
        filename: "thumbnail-composited.png",
      }),
    );
  });

  it("persists composited image as thumbnailImage artifact", async () => {
    const output = {
      thumbnailPrompt: "P",
      thumbnailText: "T",
      textPosition: "center",
      colorScheme: "blue",
    };
    const saved: Array<{ type: string; data: Record<string, unknown> }> = [];
    const artifactStore = {
      latest: jest.fn(async (..._args: any[]) => null),
      save: jest.fn(
        async (_runId: string, type: string, data: Record<string, unknown>) => {
          saved.push({ type, data });
          return {
            artifactId: "thumbnail-artifact",
            type,
            version: 1,
            location: "/tmp/thumbnail-artifact.json",
            runId: "thumbnail-artifact-test",
          };
        },
      ),
      recordRef: jest.fn(async (..._args: any[]) => undefined),
      findCompleteByInputHash: jest
        .fn<(..._args: any[]) => Promise<null>>()
        .mockResolvedValue(null),
    };
    mockGenerate.mockResolvedValueOnce(buildLLMResponse(output));

    const { promise } = runNode(
      {},
      {
        composite: jest
          .fn<(...args: any[]) => Promise<any>>()
          .mockResolvedValue({
            url: "https://cdn.local/thumbnail-composited.png",
            width: 1080,
            height: 1920,
          }),
      },
      { runId: "thumbnail-artifact-test", artifactStore },
    );
    const result = await promise;

    expect(result.thumbnail.imageUrl).toBe(
      "https://cdn.local/thumbnail-composited.png",
    );
    expect(saved).toEqual(
      expect.arrayContaining([
        {
          type: "thumbnailImage",
          data: expect.objectContaining({
            imageUrl: "https://cdn.local/thumbnail-composited.png",
            width: 1080,
            height: 1920,
          }),
        },
      ]),
    );
  });

  it("normalizes unknown textPosition to bottom-third for the compositor", async () => {
    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({
        thumbnailPrompt: "P",
        thumbnailText: "T",
        textPosition: "weird-spot",
        colorScheme: "blue",
      }),
    );

    const { promise, compositor } = runNode();
    const result = await promise;

    expect(result.thumbnail.textPosition).toBe("bottom-third");
    expect(compositor.composite).toHaveBeenCalledWith(
      expect.objectContaining({ textPosition: "bottom-third" }),
    );
  });

  it("compositor failure fails the thumbnail node (no raw fallback)", async () => {
    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({
        thumbnailPrompt: "P",
        thumbnailText: "T",
        textPosition: "center",
        colorScheme: "blue",
      }),
    );

    const failing = {
      composite: jest
        .fn<(...args: any[]) => Promise<any>>()
        .mockRejectedValue(new Error("drawtext font missing")),
    };
    const { promise } = runNode({}, failing);
    const result = await promise;

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("Image generation failed");
    expect(result.diagnostics?.errors![0]).toContain("drawtext font missing");
    expect(result.thumbnail.imageUrl).toBeUndefined();
    expect(result.thumbnail.thumbnailPrompt).toBeUndefined();
  });

  it("rejects non-canonical compositor dimensions", async () => {
    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({
        thumbnailPrompt: "P",
        thumbnailText: "T",
        textPosition: "center",
        colorScheme: "blue",
      }),
    );

    const invalid = {
      composite: jest.fn<(...args: any[]) => Promise<any>>().mockResolvedValue({
        url: "/tmp/thumbnail.png",
        width: 720,
        height: 1280,
      }),
    };
    const { promise } = runNode({}, invalid);
    const result = await promise;

    expect(result.diagnostics?.errors?.[0]).toContain("expected 1080x1920");
    expect(result.thumbnail.imageUrl).toBeUndefined();
  });

  it("returns error when title missing", async () => {
    const { promise } = runNode({ content: { hook: "H" } } as any);
    const result = await promise;

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("Title is missing");
    expect(result.thumbnail.thumbnailPrompt).toBeUndefined();
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  it("LLM failure returns error", async () => {
    mockGenerate.mockRejectedValue(new Error("Generation failed"));

    const { promise } = runNode();
    const result = await promise;

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("Generation failed");
    expect(result.thumbnail.thumbnailPrompt).toBeUndefined();
  });

  it("telemetry recorded", async () => {
    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({
        thumbnailPrompt: "P",
        thumbnailText: "T",
        textPosition: "center",
        colorScheme: "blue",
      }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.diagnostics?.telemetry?.ThumbnailGenerator).toBeDefined();
  });

  it("image generation failure returns error", async () => {
    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({
        thumbnailPrompt: "P",
        thumbnailText: "T",
        textPosition: "center",
        colorScheme: "blue",
      }),
    );

    const { promise, assetProvider } = runNode();
    assetProvider.generateImage.mockRejectedValueOnce(
      new Error("API quota exceeded"),
    );

    const result = await promise;

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("Image generation failed");
    expect(result.diagnostics?.errors![0]).toContain("API quota exceeded");
    expect(result.thumbnail.thumbnailPrompt).toBeUndefined();
  });

  it("sets execution.currentNode", async () => {
    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({
        thumbnailPrompt: "P",
        thumbnailText: "T",
        textPosition: "center",
        colorScheme: "blue",
      }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.execution?.currentNode).toBe("ThumbnailGenerator");
  });

  it("generatedAt is valid ISO timestamp", async () => {
    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({
        thumbnailPrompt: "P",
        thumbnailText: "T",
        textPosition: "center",
        colorScheme: "blue",
      }),
    );

    const { promise } = runNode();
    const result = await promise;

    expect(result.thumbnail.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("thumbnailGeneratorNode modes", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
  });

  afterEach(() => {
    delete process.env.THUMBNAIL_MODE;
    delete process.env.THUMBNAIL_QA;
  });

  it("full mode renders image model typography (empty compositor text) and skips overlay text", async () => {
    process.env.THUMBNAIL_MODE = "full";
    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({
        thumbnailPrompt: "Cinematic close-up.",
        thumbnailText: "THE DEADLY PRIZE",
        textPosition: "center",
        colorScheme: "blue",
      }),
    );

    const { promise, assetProvider, compositor } = runNode(
      {},
      {},
      { thumbnailQa: async () => ({ status: "pass", issues: [] }) },
    );
    const result = await promise;

    const [generateCall] = assetProvider.generateImage.mock.calls.at(-1)!;
    expect(generateCall.prompt).toContain('"THE DEADLY PRIZE"');
    expect(generateCall.prompt).toContain("integrated into the composition");
    expect(generateCall.prompt).toContain("1080x1920");
    expect(generateCall.prompt).not.toContain("Do NOT render any text");

    expect(compositor.composite).toHaveBeenCalledWith(
      expect.objectContaining({ text: "" }),
    );
    expect(result.thumbnail.mode).toBe("full");
    expect(result.thumbnail.imageUrl).toBe(
      "https://placeholder.local/thumbnail.png",
    );
  });

  it("full mode fails closed when QA rejects (no fallback)", async () => {
    process.env.THUMBNAIL_MODE = "full";
    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({
        thumbnailPrompt: "P",
        thumbnailText: "T",
        textPosition: "center",
        colorScheme: "blue",
      }),
    );

    const { promise } = runNode(
      {},
      {},
      {
        thumbnailQa: async () => ({
          status: "fail",
          issues: ["title misspelled"],
        }),
      },
    );
    const result = await promise;

    expect(result.thumbnail.imageUrl).toBeUndefined();
    expect(result.diagnostics?.errors?.[0]).toContain("failed QA");
    expect(result.diagnostics?.errors?.[0]).toContain("title misspelled");
  });

  it("auto mode falls back to overlay and records fallbackReason when QA fails", async () => {
    process.env.THUMBNAIL_MODE = "auto";
    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({
        thumbnailPrompt: "P",
        thumbnailText: "T",
        textPosition: "bottom-third",
        colorScheme: "blue",
      }),
    );

    const { promise, compositor } = runNode(
      {},
      {},
      {
        thumbnailQa: async () => ({
          status: "fail",
          issues: ["extra text present", "title too small"],
        }),
      },
    );
    const result = await promise;

    expect(result.thumbnail.imageUrl).toBe(
      "https://placeholder.local/thumbnail.png",
    );
    expect(result.thumbnail.mode).toBe("overlay");
    expect(result.thumbnail.fallbackReason).toEqual({
      code: "thumbnail_qa_failed",
      issues: ["extra text present", "title too small"],
    });
    expect(compositor.composite).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: "T" }),
    );
  });

  it("auto mode distinguishes QA infrastructure failure from QA rejection", async () => {
    process.env.THUMBNAIL_MODE = "auto";
    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({
        thumbnailPrompt: "P",
        thumbnailText: "T",
        textPosition: "bottom-third",
        colorScheme: "blue",
      }),
    );

    const { promise } = runNode(
      {},
      {},
      {
        thumbnailQa: async () => {
          throw new Error("vision model timeout");
        },
      },
    );
    const result = await promise;

    expect(result.thumbnail.mode).toBe("overlay");
    expect(result.thumbnail.fallbackReason).toEqual({
      code: "thumbnail_qa_unavailable",
      issues: ["vision model timeout"],
    });
  });

  it("auto mode keeps the full thumbnail when QA passes", async () => {
    process.env.THUMBNAIL_MODE = "auto";
    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({
        thumbnailPrompt: "P",
        thumbnailText: "T",
        textPosition: "center",
        colorScheme: "blue",
      }),
    );

    const { promise } = runNode(
      {},
      {},
      { thumbnailQa: async () => ({ status: "pass", issues: [] }) },
    );
    const result = await promise;

    expect(result.thumbnail.mode).toBe("full");
    expect(result.thumbnail.fallbackReason).toBeUndefined();
  });
});

describe("thumbnailGeneratorNode cache behavior", () => {
  beforeEach(() => {
    mockGenerate.mockReset();
    process.env.THUMBNAIL_MODE = "auto";
    process.env.THUMBNAIL_QA = "true";
  });

  afterEach(() => {
    delete process.env.THUMBNAIL_MODE;
    delete process.env.THUMBNAIL_QA;
  });

  it("QA fail: full-mode artifact left pending (not servable); overlay cached complete", async () => {
    const saveCalls: Array<{
      type: string;
      data: Record<string, unknown>;
      status?: string;
    }> = [];
    const artifactStore = {
      latest: jest.fn(async (..._args: any[]) => null),
      save: jest.fn(
        async (
          _runId: string,
          type: string,
          data: Record<string, unknown>,
          _meta?: Record<string, unknown>,
          status: "pending" | "complete" = "complete",
        ) => {
          saveCalls.push({ type, data, status });
          return {
            artifactId: "thumbnail-artifact",
            type,
            version: 1,
            location: "/tmp/thumbnail-artifact.json",
            runId: "thumbnail-cache-test",
          };
        },
      ),
      recordRef: jest.fn(async (..._args: any[]) => undefined),
      findCompleteByInputHash: jest
        .fn<(..._args: any[]) => Promise<null>>()
        .mockResolvedValue(null),
    };

    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({
        thumbnailPrompt: "Cinematic scene.",
        thumbnailText: "THE DEADLY PRIZE",
        textPosition: "bottom-third",
        colorScheme: "dark",
      }),
    );

    const { promise, assetProvider } = runNode(
      {},
      {},
      {
        thumbnailQa: async () => ({
          status: "fail",
          issues: ["title misspelled", "extra text present"],
        }),
        artifactStore,
        runId: "thumbnail-cache-test",
      },
    );
    const result = await promise;

    // Should have fallen back to overlay
    expect(result.thumbnail.mode).toBe("overlay");
    expect(result.thumbnail.fallbackReason).toEqual({
      code: "thumbnail_qa_failed",
      issues: ["title misspelled", "extra text present"],
    });

    // Full-mode artifact saved pending, overlay saved complete.
    const thumbnailSaves = saveCalls.filter((c) => c.type === "thumbnailImage");
    expect(thumbnailSaves.length).toBe(2);
    expect(thumbnailSaves[0].data.mode).toBe("full");
    expect(thumbnailSaves[0].status).toBe("pending"); // never completed => never servable
    expect(thumbnailSaves[1].data.mode).toBe("overlay");
    expect(thumbnailSaves[1].status).toBe("complete");
    expect(thumbnailSaves[1].data.fallbackReason).toBeUndefined(); // overlay has no fallbackReason

    // Both full and overlay generation calls should have occurred
    expect(assetProvider.generateImage).toHaveBeenCalledTimes(2);
    // First call: full mode (empty compositor text)
    expect(assetProvider.generateImage.mock.calls[0][0].prompt).toContain(
      "integrated into the composition",
    );
    // Second call: overlay mode (with text)
    expect(assetProvider.generateImage.mock.calls[1][0].prompt).toContain(
      "Do NOT render any text",
    );
  });

  it("full mode: QA infrastructure error → node fails (does not ship unverified)", async () => {
    process.env.THUMBNAIL_MODE = "full";

    mockGenerate.mockResolvedValueOnce(
      buildLLMResponse({
        thumbnailPrompt: "P",
        thumbnailText: "T",
        textPosition: "center",
        colorScheme: "blue",
      }),
    );

    const { promise } = runNode(
      {},
      {},
      {
        thumbnailQa: async () => {
          throw new Error("vision model timeout");
        },
      },
    );
    const result = await promise;

    expect(result.thumbnail.imageUrl).toBeUndefined();
    expect(result.diagnostics?.errors?.[0]).toContain(
      "Full-mode thumbnail QA failed",
    );
    expect(result.diagnostics?.errors?.[0]).toContain("vision model timeout");
  });

  it("cache key includes QA model: changing MODEL_THUMBNAILQA misses the cache", async () => {
    const store = createMemoryStore();
    const qaSpy = jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue({ status: "pass", issues: [] });

    async function runOnce(qaModel: string) {
      process.env.THUMBNAIL_MODE = "auto";
      process.env.THUMBNAIL_QA = "true";
      process.env.MODEL_THUMBNAILQA = qaModel;
      mockGenerate.mockResolvedValueOnce(
        buildLLMResponse({
          thumbnailPrompt: "P",
          thumbnailText: "T",
          textPosition: "center",
          colorScheme: "blue",
        }),
      );
      const { promise, assetProvider } = runNode(
        {},
        {},
        { thumbnailQa: qaSpy, artifactStore: store, runId: "cache-key-test" },
      );
      const result = await promise;
      return { result, assetProvider };
    }

    // Run 1, model-a: generate + QA, cached complete.
    const r1 = await runOnce("model-a");
    expect(r1.result.thumbnail.mode).toBe("full");
    expect(r1.assetProvider.generateImage).toHaveBeenCalledTimes(1);
    expect(qaSpy).toHaveBeenCalledTimes(1);

    // Run 2, same model-a: cache hit - no generation, no QA.
    const r2 = await runOnce("model-a");
    expect(r2.result.thumbnail.mode).toBe("full");
    expect(r2.assetProvider.generateImage).not.toHaveBeenCalled();
    expect(qaSpy).toHaveBeenCalledTimes(1);

    // Run 3, model-b: cache miss - generation + QA rerun, new entry.
    const r3 = await runOnce("model-b");
    expect(r3.result.thumbnail.mode).toBe("full");
    expect(r3.assetProvider.generateImage).toHaveBeenCalledTimes(1);
    expect(qaSpy).toHaveBeenCalledTimes(2);

    const fullHashes = store.records
      .filter((r) => r.type === "thumbnailImage")
      .map((r) => r.meta.inputHash as string);
    expect(fullHashes.length).toBe(2);
    expect(fullHashes[0]).not.toBe(fullHashes[1]);
  });
});
