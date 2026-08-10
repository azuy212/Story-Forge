import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { narrationGeneratorNode } from "../src/agents/narration-generator.node.js";
import type { ProjectState } from "../src/types/index.js";
import type { TTSProvider } from "../src/providers/tts-provider.js";
import { StubTTSProvider } from "../src/providers/stub-tts-provider.js";

const mockSynthesize = jest.fn<(...args: any[]) => Promise<any>>();

const mockTTSProvider: TTSProvider = {
  synthesize: mockSynthesize,
};

beforeEach(() => {
  mockSynthesize.mockReset();
});

function runNode(state?: Partial<ProjectState>, provider?: TTSProvider) {
  return narrationGeneratorNode(
    {
      project: { pillar: "Geography", topic: "Test" },
      content: { narration: "This is the narration text for testing purposes." },
      execution: { version: "0.1.0" },
      ...state,
    } as ProjectState,
    { configurable: { ttsProvider: provider ?? mockTTSProvider } } as any,
  );
}

describe("narrationGeneratorNode", () => {
  it("synthesizes narration and sets all audio fields", async () => {
    mockSynthesize.mockResolvedValue({ audioUrl: "https://tts.local/narration.wav", durationMs: 3000 });

    const result = await runNode();

    expect(result.audio.narrationUrl).toBe("https://tts.local/narration.wav");
    expect(result.audio.narrationDurationMs).toBe(3000);
    expect(result.audio.voice).toBe("en-US-Neural2-F");
    expect(result.audio.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.execution?.currentNode).toBe("NarrationGenerator");
  });

  it("uses branding voice when provided", async () => {
    mockSynthesize.mockResolvedValue({ audioUrl: "https://tts.local/narration.wav", durationMs: 2000 });

    const result = await runNode({ branding: { channel: "C", creator: "", cta: "", voice: "en-US-Studio-O" } });

    expect(result.audio.voice).toBe("en-US-Studio-O");
    expect(mockSynthesize).toHaveBeenCalledWith(
      expect.objectContaining({ voice: "en-US-Studio-O" }),
    );
  });

  it("returns error when narration is missing", async () => {
    const result = await runNode({ content: {} } as any);

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("missing or empty");
    expect(result.audio.narrationUrl).toBeUndefined();
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it("returns error when narration is empty string", async () => {
    const result = await runNode({ content: { narration: "   " } } as any);

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("missing or empty");
    expect(mockSynthesize).not.toHaveBeenCalled();
  });

  it("returns error on provider failure", async () => {
    mockSynthesize.mockRejectedValue(new Error("TTS service unavailable"));

    const result = await runNode();

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("TTS service unavailable");
    expect(result.audio.narrationUrl).toBeUndefined();
  });

  it("uses stub provider when no provider injected", async () => {
    const result = await narrationGeneratorNode(
      {
        project: { pillar: "Geography", topic: "Test" },
        content: { narration: "Test narration." },
        execution: { version: "0.1.0" },
      } as ProjectState,
      { configurable: { ttsProvider: new StubTTSProvider() } } as any,
    );

    expect(result.audio.narrationUrl).toContain("placeholder.local");
    expect(result.audio.narrationDurationMs).toBeGreaterThan(0);
  });

  it("uses injected provider over stub", async () => {
    mockSynthesize.mockResolvedValue({ audioUrl: "https://custom.local/audio.mp3", durationMs: 5000 });

    const result = await runNode();

    expect(result.audio.narrationUrl).toBe("https://custom.local/audio.mp3");
    expect(result.audio.narrationDurationMs).toBe(5000);
  });

  it("sets execution.currentNode", async () => {
    mockSynthesize.mockResolvedValue({ audioUrl: "https://tts.local/n.wav", durationMs: 1000 });

    const result = await runNode();

    expect(result.execution?.currentNode).toBe("NarrationGenerator");
  });

  it("generatedAt is valid ISO timestamp", async () => {
    mockSynthesize.mockResolvedValue({ audioUrl: "https://tts.local/n.wav", durationMs: 1000 });

    const result = await runNode();

    expect(result.audio.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });

  it("passes text and voice to provider", async () => {
    mockSynthesize.mockResolvedValue({ audioUrl: "https://tts.local/n.wav", durationMs: 1000 });

    await runNode();

    expect(mockSynthesize).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "This is the narration text for testing purposes.",
        voice: "en-US-Neural2-F",
      }),
    );
  });
});
