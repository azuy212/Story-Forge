import { jest, describe, it, expect } from "@jest/globals";
import {
  WhisperXSubtitleProvider,
  groupWords,
} from "../src/providers/whisperx-subtitle-provider.js";
import type { WhisperXProvider } from "../src/providers/whisperx-provider.js";
import type { WordTimestamp } from "../src/providers/subtitle-provider.js";
import { PipelineError } from "../src/utils/errors.js";

const mockAlign = jest.fn<(...args: any[]) => Promise<any>>();

const whisperx: WhisperXProvider = { align: mockAlign };
const provider = new WhisperXSubtitleProvider(whisperx);

const AUDIO_URL = "generated/audio/run/narration.wav";
const NARRATION = "Hello world. Second.";

function words(entries: Array<[string, number, number]>): WordTimestamp[] {
  return entries.map(([word, start, end]) => ({ word, start, end }));
}

beforeEach(() => {
  mockAlign.mockReset();
});

describe("WhisperXSubtitleProvider", () => {
  it("uses whisperx timestamps for cues, not the 300ms/word heuristic", async () => {
    mockAlign.mockResolvedValue({
      wordTimestamps: words([
        ["Hello", 0.0, 0.4],
        ["world", 0.4, 0.9],
      ]),
    });

    const result = await provider.generateSubtitles(AUDIO_URL, NARRATION);

    // Cue end = 900ms from WhisperX, not 2 * 300ms = 600ms.
    expect(result.srt).toContain("00:00:00,000 --> 00:00:00,900");
    expect(result.srt).toContain("Hello world");
    expect(result.wordTimestamps).toEqual(
      words([
        ["Hello", 0.0, 0.4],
        ["world", 0.4, 0.9],
      ]),
    );
  });

  it("passes the audio URL and narration to whisperx align", async () => {
    mockAlign.mockResolvedValue({
      wordTimestamps: words([["Hello", 0.0, 0.4]]),
    });

    await provider.generateSubtitles(AUDIO_URL, NARRATION);

    expect(mockAlign).toHaveBeenCalledWith(AUDIO_URL, NARRATION);
  });

  it("groups 3-5 words per cue preferring punctuation boundaries", async () => {
    mockAlign.mockResolvedValue({
      wordTimestamps: words([
        ["one", 0.0, 0.2],
        ["two", 0.2, 0.4],
        ["three", 0.4, 0.6],
        ["four,", 0.6, 0.9],
        ["five", 1.0, 1.2],
        ["six", 1.2, 1.4],
        ["seven,", 1.4, 1.7],
        ["eight", 1.8, 2.0],
        ["nine", 2.0, 2.2],
        ["ten.", 2.2, 2.5],
      ]),
    });

    const result = await provider.generateSubtitles(AUDIO_URL, NARRATION);

    const texts = result.srt.split(/\n\s*\n/).map((block) =>
      block
        .split("\n")
        .filter((l) => l && !l.includes("-->") && !/^\d+$/.test(l))
        .join(" "),
    );
    expect(texts).toEqual([
      "one two three four,",
      "five six seven,",
      "eight nine ten.",
    ]);
  });

  it("cuts cues at a natural timing gap before reaching max words", async () => {
    mockAlign.mockResolvedValue({
      wordTimestamps: words([
        ["one", 0.0, 0.3],
        ["two", 0.3, 0.6],
        ["three", 0.6, 0.9],
        ["four", 1.8, 2.1],
        ["five", 2.1, 2.4],
        ["six", 2.4, 2.7],
      ]),
    });

    const result = await provider.generateSubtitles(AUDIO_URL, NARRATION);

    const texts = result.srt.split(/\n\s*\n/).map((block) =>
      block
        .split("\n")
        .filter((l) => l && !l.includes("-->") && !/^\d+$/.test(l))
        .join(" "),
    );
    expect(texts).toEqual(["one two three", "four five six"]);
  });

  it("never exceeds 5 words per cue", async () => {
    mockAlign.mockResolvedValue({
      wordTimestamps: words([
        ["a", 0.0, 0.2],
        ["b", 0.2, 0.4],
        ["c", 0.4, 0.6],
        ["d", 0.6, 0.8],
        ["e", 0.8, 1.0],
        ["f", 1.0, 1.2],
      ]),
    });

    const result = await provider.generateSubtitles(AUDIO_URL, NARRATION);

    const blocks = result.srt.split(/\n\s*\n/);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("a b c d e");
    expect(blocks[1]).toContain("f");
  });

  it("final cue ends at the final whisperx word timestamp", async () => {
    mockAlign.mockResolvedValue({
      wordTimestamps: words([
        ["Hello", 0.1, 0.5],
        ["world", 0.5, 0.9],
        ["again", 0.9, 1.45],
      ]),
    });

    const result = await provider.generateSubtitles(AUDIO_URL, NARRATION);

    expect(result.srt).toContain("00:00:00,100 --> 00:00:01,450");
    expect(result.srt).toMatch(/00:00:01,450\nHello world again$/);
  });

  it("cues are contiguous and never overlap", async () => {
    mockAlign.mockResolvedValue({
      wordTimestamps: words([
        ["The", 0.0, 0.3],
        ["mystery", 0.3, 0.6],
        ["began", 0.6, 1.0],
        ["when", 1.1, 1.3],
        ["scientists", 1.3, 1.7],
        ["looked", 1.7, 2.0],
      ]),
    });

    const result = await provider.generateSubtitles(AUDIO_URL, NARRATION);

    const blocks = result.srt.split(/\n\s*\n/).filter(Boolean);
    let prevEnd = -1;
    for (const block of blocks) {
      const line = block.split("\n").find((l) => l.includes("-->"))!;
      const m = line.match(/-->\s*(\d{2}):(\d{2}):(\d{2}),(\d{3})/);
      const startLine = line.match(/(\d{2}):(\d{2}):(\d{2}),(\d{3})\s*-->/);
      const toMs = (parts: RegExpMatchArray) =>
        ((+parts[1] * 60 + +parts[2]) * 60 + +parts[3]) * 1000 + +parts[4];
      const startMs = toMs(startLine!);
      const endMs = toMs(m!);
      expect(startMs).toBeGreaterThanOrEqual(prevEnd);
      expect(endMs).toBeGreaterThan(startMs);
      prevEnd = endMs;
    }
  });

  it("throws PipelineError when whisperx align fails", async () => {
    mockAlign.mockRejectedValue(
      new PipelineError(
        "WhisperX alignment failed: HTTP 500",
        "WHISPERX_PROVIDER_ERROR",
      ),
    );

    await expect(
      provider.generateSubtitles(AUDIO_URL, NARRATION),
    ).rejects.toThrow(PipelineError);
    await expect(
      provider.generateSubtitles(AUDIO_URL, NARRATION),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("throws when whisperx returns zero word timestamps", async () => {
    mockAlign.mockResolvedValue({ wordTimestamps: [] });

    await expect(
      provider.generateSubtitles(AUDIO_URL, NARRATION),
    ).rejects.toThrow(/no word timestamps/);
  });
});

describe("groupWords", () => {
  it("keeps a short sentence as a single cue", () => {
    const groups = groupWords(
      words([
        ["The", 0.0, 0.3],
        ["strange", 0.3, 0.7],
        ["signal", 0.7, 1.1],
        ["appeared.", 1.1, 1.6],
      ]),
    );
    expect(groups.map((g) => g.map((w) => w.word))).toEqual([
      ["The", "strange", "signal", "appeared."],
    ]);
  });

  it("prefers punctuation boundaries over fixed word groups", () => {
    const groups = groupWords(
      words([
        ["The", 0.0, 0.3],
        ["strange", 0.3, 0.7],
        ["signal", 0.7, 1.1],
        ["appeared,", 1.1, 1.6],
        ["but", 1.7, 1.9],
        ["nobody", 1.9, 2.3],
        ["knew", 2.3, 2.6],
        ["where", 2.6, 2.9],
        ["it", 2.9, 3.1],
        ["came", 3.1, 3.4],
        ["from.", 3.4, 3.8],
      ]),
    );
    expect(groups.map((g) => g.map((w) => w.word))).toEqual([
      ["The", "strange", "signal", "appeared,"],
      ["but", "nobody", "knew", "where", "it"],
      ["came", "from."],
    ]);
  });

  it("leaves whisperx timestamps untouched", () => {
    const input = words([
      ["a", 0.1, 0.2],
      ["b", 0.2, 0.3],
      ["c", 0.3, 0.4],
    ]);
    const groups = groupWords(input);
    expect(groups[0]).toEqual(input);
    expect(groups[0][0].start).toBe(0.1);
    expect(groups[0][2].end).toBe(0.4);
  });

  it("cuts on a timing gap even below the min word count", () => {
    const groups = groupWords(
      words([
        ["one", 0.0, 0.3],
        ["two", 0.8, 1.1],
        ["three", 1.1, 1.4],
      ]),
    );
    expect(groups.map((g) => g.map((w) => w.word))).toEqual([
      ["one"],
      ["two", "three"],
    ]);
  });
});
