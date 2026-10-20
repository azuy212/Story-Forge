import { describe, it, expect } from "@jest/globals";
import {
  buildStoryAss,
  buildStorySrt,
  buildSubtitleCues,
  wrapLines,
} from "../src/story/subtitles.js";
import type { SceneWordTimestamp } from "../src/story/types.js";

const word = (
  text: string,
  start: number,
  end: number,
): SceneWordTimestamp => ({ word: text, start, end });

const timing = (start: number, end: number) => ({
  start,
  end,
  startFrame: Math.round(start * 30),
  endFrame: Math.round(end * 30),
  method: "measured" as const,
});

const OPTIONS = { maxCharsPerLine: 42, minDurationMs: 800 };

describe("story buildSubtitleCues", () => {
  it("closes a cue at a sentence end, one sentence per cue", () => {
    const cues = buildSubtitleCues({
      ...OPTIONS,
      scenes: [
        {
          sceneId: 1,
          timing: timing(0, 5),
          words: [
            word("The", 0, 0.5),
            word("crew", 0.5, 1),
            word("had", 1, 1.5),
            word("not", 1.5, 2),
            word("seen", 2, 2.5),
            word("land.", 2.5, 3),
            word("Then", 3, 3.5),
            word("he", 3.5, 4),
            word("left.", 4, 4.5),
          ],
        },
      ],
    });

    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({
      index: 1,
      startMs: 0,
      endMs: 3000,
      lines: ["The crew had not seen land."],
    });
    // "Then he left." is shorter than half a line, so it stays a single cue
    // rather than shedding a second, sub-second one.
    expect(cues[1]).toMatchObject({
      index: 2,
      startMs: 3000,
      endMs: 4500,
      lines: ["Then he left."],
    });
  });

  it("splits an over-long cue into two balanced lines instead of one run-on line", () => {
    const cues = buildSubtitleCues({
      ...OPTIONS,
      scenes: [
        {
          sceneId: 1,
          timing: timing(0, 4),
          words: [
            word("Columbus", 0, 0.4),
            word("stood", 0.4, 0.8),
            word("on", 0.8, 1.2),
            word("the", 1.2, 1.6),
            word("deck", 1.6, 2),
            word("of", 2, 2.4),
            word("a", 2.4, 2.8),
            word("small", 2.8, 3.2),
            word("wooden", 3.2, 3.6),
            word("ship.", 3.6, 4),
          ],
        },
      ],
    });

    expect(cues).toHaveLength(1);
    expect(cues[0].lines).toEqual([
      "Columbus stood on the deck",
      "of a small wooden ship.",
    ]);
    for (const line of cues[0].lines) {
      expect(line.length).toBeLessThanOrEqual(42);
    }
  });

  it("extends a short cue to the minimum on-screen time", () => {
    const cues = buildSubtitleCues({
      ...OPTIONS,
      scenes: [
        { sceneId: 1, timing: timing(0, 4), words: [word("Hi.", 0, 0.2)] },
      ],
    });
    expect(cues[0]).toMatchObject({ startMs: 0, endMs: 800 });
  });

  it("never overlaps, even when the minimum duration cannot be honoured", () => {
    const cues = buildSubtitleCues({
      ...OPTIONS,
      scenes: [
        {
          sceneId: 1,
          timing: timing(0, 5),
          words: [
            word("Alpha", 0, 0.1),
            word("beta", 0.1, 0.2),
            word("gamma", 0.2, 0.3),
            word("delta.", 0.3, 0.4),
            word("Epsilon", 0.5, 0.6),
            word("zeta", 0.6, 0.7),
            word("eta", 0.7, 0.8),
            word("theta.", 0.8, 0.9),
          ],
        },
      ],
    });

    expect(cues).toHaveLength(2);
    // No-overlap wins over the 800 ms minimum: the first cue is clamped to the
    // second cue's start so the two can never cover each other.
    expect(cues[0].endMs).toBe(500);
    expect(cues[1].startMs).toBe(500);
    expect(cues[0].endMs).toBeLessThanOrEqual(cues[1].startMs);
  });

  it("keeps cues inside their own scene and in scene order", () => {
    const cues = buildSubtitleCues({
      ...OPTIONS,
      scenes: [
        {
          sceneId: 1,
          timing: timing(0, 4),
          words: [word("First", 0, 1), word("scene.", 1, 2)],
        },
        {
          sceneId: 2,
          timing: timing(4, 8),
          words: [word("Second", 4, 5), word("scene.", 5, 6)],
        },
      ],
    });

    expect(cues.map((cue) => cue.lines.join(" "))).toEqual([
      "First scene.",
      "Second scene.",
    ]);
    expect(cues[0].endMs).toBeLessThanOrEqual(cues[1].startMs);
  });

  it("drops zero-length words and words that end before the scene starts", () => {
    const cues = buildSubtitleCues({
      ...OPTIONS,
      scenes: [
        {
          sceneId: 1,
          timing: timing(5, 9),
          words: [
            word("Zero", 3, 3),
            word("Early", 2, 4),
            word("Started", 6, 7),
            word("late.", 7, 8),
          ],
        },
      ],
    });

    expect(cues).toHaveLength(1);
    expect(cues[0].lines.join(" ")).toBe("Started late.");
    expect(cues[0].startMs).toBe(6000);
  });
});

describe("story wrapLines", () => {
  it("keeps a short line whole", () => {
    expect(wrapLines([word("All", 0, 1), word("good.", 1, 2)], 42)).toEqual([
      "All good.",
    ]);
  });

  it("balances two lines and keeps every word", () => {
    const words = Array.from({ length: 10 }, (_, index) =>
      word(`word${index}`, index, index + 1),
    );
    const lines = wrapLines(words, 42, 2);
    expect(lines).toEqual([
      "word0 word1 word2 word3 word4",
      "word5 word6 word7 word8 word9",
    ]);
  });

  it("returns one line when only one is allowed", () => {
    const words = Array.from({ length: 20 }, (_, index) =>
      word(`word${index}`, index, index + 1),
    );
    expect(wrapLines(words, 42, 1)).toHaveLength(1);
  });

  it("returns nothing for no words", () => {
    expect(wrapLines([], 42)).toEqual([]);
  });
});

describe("story buildStorySrt / buildStoryAss", () => {
  it("writes indexed SRT with comma millisecond separators", () => {
    const srt = buildStorySrt([
      { index: 1, startMs: 0, endMs: 65_000, lines: ["Line one", "Line two"] },
    ]);
    expect(srt).toBe("1\n00:00:00,000 --> 00:01:05,000\nLine one\nLine two\n");
  });

  it("writes ASS with PlayRes, the configured style, and no force_style", () => {
    const ass = buildStoryAss(
      [{ index: 1, startMs: 0, endMs: 2000, lines: ["a{b}c", "tail"] }],
      {
        fontName: "Noto Sans",
        fontSize: 48,
        primaryColor: "&H00FFFFFF",
        outlineColor: "&H00000000",
        outline: 2,
        marginV: 70,
        playResX: 1920,
        playResY: 1080,
      },
    );

    expect(ass).toContain("PlayResX: 1920");
    expect(ass).toContain("PlayResY: 1080");
    expect(ass).toContain(
      "Style: Default,Noto Sans,48,&H00FFFFFF,&H00FFFFFF,&H00000000,",
    );
    // Braces are stripped (ASS override syntax) and lines join with \N.
    expect(ass).toContain(
      "Dialogue: 0,0:00:00.00,0:00:02.00,Default,,0,0,0,,abc\\Ntail",
    );
    expect(ass).not.toContain("force_style");
  });

  it("escapes backslashes so a path-like word cannot become an override", () => {
    const ass = buildStoryAss(
      [{ index: 1, startMs: 0, endMs: 1000, lines: ["back\\slash"] }],
      {
        fontName: "Noto Sans",
        fontSize: 48,
        primaryColor: "&H00FFFFFF",
        outlineColor: "&H00000000",
        outline: 2,
        marginV: 70,
        playResX: 1920,
        playResY: 1080,
      },
    );
    expect(ass).toContain("back\\\\slash");
  });
});
