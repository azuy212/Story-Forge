import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import { subtitleGeneratorNode } from "../src/agents/subtitle-generator.node.js";
import type { ProjectState } from "../src/types/index.js";
import type {
  SubtitleProvider,
  GenerateSubtitlesResult,
} from "../src/providers/subtitle-provider.js";
import { WhisperXSubtitleProvider } from "../src/providers/whisperx-subtitle-provider.js";

const mockGenerateSubtitles = jest.fn<(...args: any[]) => Promise<any>>();

const mockSubtitleProvider: SubtitleProvider = {
  generateSubtitles: mockGenerateSubtitles,
};

const DEFAULT_AUDIO = {
  narrationUrl: "https://placeholder.local/narration.wav",
  narrationDurationMs: 6000,
};

const DEFAULT_RESULT: GenerateSubtitlesResult = {
  srt: "1\n00:00:00,000 --> 00:00:03,000\nHello world",
  ass: "Dialogue: 0,0:00:00.00,0:00:03.00,Default,,0,0,0,,Hello world",
  wordTimestamps: [
    { word: "Hello", start: 0.0, end: 1.5 },
    { word: "world", start: 1.5, end: 3.0 },
  ],
};

beforeEach(() => {
  mockGenerateSubtitles.mockReset();
});

function runNode(state?: Partial<ProjectState>, provider?: SubtitleProvider) {
  return subtitleGeneratorNode(
    {
      project: { pillar: "Geography", topic: "Test" },
      content: { narration: "Hello world." },
      audio: { ...DEFAULT_AUDIO },
      execution: { version: "0.1.0" },
      ...state,
    } as ProjectState,
    {
      configurable: { subtitleProvider: provider ?? mockSubtitleProvider },
    } as any,
  );
}

describe("subtitleGeneratorNode", () => {
  it("successful generation sets srt, ass, and wordTimestamps", async () => {
    mockGenerateSubtitles.mockResolvedValue(DEFAULT_RESULT);

    const result = await runNode();

    expect(result.subtitles.srt).toBe(DEFAULT_RESULT.srt);
    expect(result.subtitles.ass).toBe(DEFAULT_RESULT.ass);
    expect(result.subtitles.wordTimestamps).toHaveLength(2);
    expect(result.subtitles.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(result.execution?.currentNode).toBe("SubtitleGenerator");
  });

  it("returns error when narration is missing", async () => {
    const result = await runNode({ content: {} } as any);

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("missing or empty");
    expect(result.subtitles.srt).toBeUndefined();
    expect(mockGenerateSubtitles).not.toHaveBeenCalled();
  });

  it("returns error when narration is empty", async () => {
    const result = await runNode({ content: { narration: "" } } as any);

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("missing or empty");
    expect(mockGenerateSubtitles).not.toHaveBeenCalled();
  });

  it("returns error when audioUrl is missing", async () => {
    const result = await runNode({
      audio: { narrationDurationMs: 6000 },
    } as any);

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain(
      "Audio URL or duration missing",
    );
    expect(mockGenerateSubtitles).not.toHaveBeenCalled();
  });

  it("returns error when durationMs is missing", async () => {
    const result = await runNode({
      audio: { narrationUrl: "https://local/audio.wav" },
    } as any);

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain(
      "Audio URL or duration missing",
    );
    expect(mockGenerateSubtitles).not.toHaveBeenCalled();
  });

  it("returns error on provider failure", async () => {
    mockGenerateSubtitles.mockRejectedValue(
      new Error("TTS service unavailable"),
    );

    const result = await runNode();

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain("TTS service unavailable");
    expect(result.subtitles.srt).toBeUndefined();
  });

  it("uses stub provider when no provider injected", async () => {
    const result = await subtitleGeneratorNode(
      {
        project: { pillar: "Geography", topic: "Test" },
        content: { narration: "Short test." },
        audio: {
          narrationUrl: "https://local/audio.wav",
          narrationDurationMs: 2000,
        },
        execution: { version: "0.1.0" },
      } as ProjectState,
      { configurable: {} } as any,
    );

    expect(result.subtitles.srt).toBeDefined();
    expect(result.subtitles.srt!.length).toBeGreaterThan(0);
    expect(result.subtitles.ass).toBeDefined();
    expect(result.subtitles.ass!.length).toBeGreaterThan(0);
    expect(result.subtitles.wordTimestamps).toBeDefined();
    expect(result.subtitles.wordTimestamps!.length).toBeGreaterThan(0);
  });

  it("uses injected provider over stub", async () => {
    const customResult: GenerateSubtitlesResult = {
      srt: "1\n00:00:00,000 --> 00:00:02,000\nCustom",
      ass: "Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,Custom",
      wordTimestamps: [{ word: "Custom", start: 0.0, end: 2.0 }],
    };
    mockGenerateSubtitles.mockResolvedValue(customResult);

    const result = await runNode();

    expect(result.subtitles.srt).toContain("Custom");
    expect(result.subtitles.wordTimestamps![0].word).toBe("Custom");
  });

  it("passes narration duration to the provider", async () => {
    mockGenerateSubtitles.mockResolvedValue(DEFAULT_RESULT);

    const result = await runNode({
      audio: {
        narrationUrl: "https://placeholder.local/narration.wav",
        narrationDurationMs: 7500,
      },
    });

    expect(result.subtitles.srt).toBe(DEFAULT_RESULT.srt);
    expect(mockGenerateSubtitles).toHaveBeenCalledWith(
      "https://placeholder.local/narration.wav",
      "Hello world.",
      7500,
    );
  });

  it("passes through whisperx word timestamps into subtitles", async () => {
    const align = jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockResolvedValue({
        wordTimestamps: [
          { word: "Hello", start: 0.1, end: 0.5 },
          { word: "world.", start: 0.5, end: 0.9 },
        ],
      });
    const whisperxProvider = new WhisperXSubtitleProvider({ align } as any);

    const result = await runNode(undefined, whisperxProvider);

    expect(align).toHaveBeenCalledWith(
      "https://placeholder.local/narration.wav",
      "Hello world.",
    );
    expect(result.subtitles.srt).toContain("00:00:00,100 --> 00:00:00,900");
    expect(result.subtitles.srt).toContain("Hello world.");
    expect(result.subtitles.wordTimestamps).toEqual([
      { word: "Hello", start: 0.1, end: 0.5 },
      { word: "world.", start: 0.5, end: 0.9 },
    ]);
  });

  it("surfaces whisperx alignment failure as an error, no silent fallback", async () => {
    const align = jest
      .fn<(...args: any[]) => Promise<any>>()
      .mockRejectedValue(new Error("WhisperX alignment failed: HTTP 500"));
    const whisperxProvider = new WhisperXSubtitleProvider({ align } as any);

    const result = await runNode(undefined, whisperxProvider);

    expect(result.diagnostics?.errors).toBeDefined();
    expect(result.diagnostics?.errors![0]).toContain(
      "WhisperX alignment failed",
    );
    expect(result.subtitles.srt).toBeUndefined();
  });

  it("sets execution.currentNode", async () => {
    mockGenerateSubtitles.mockResolvedValue(DEFAULT_RESULT);

    const result = await runNode();

    expect(result.execution?.currentNode).toBe("SubtitleGenerator");
  });

  it("generatedAt is valid ISO timestamp", async () => {
    mockGenerateSubtitles.mockResolvedValue(DEFAULT_RESULT);

    const result = await runNode();

    expect(result.subtitles.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
