import { describe, it, expect } from "@jest/globals";
import {
  SCENE_ALIGNMENT_GATE,
  alignScene,
  narrationFidelity,
  numberValue,
  normalizeToken,
  proportionalAlignment,
  tokenizeScript,
} from "../src/story/alignment.js";
import type { AsrWord } from "../src/story/alignment.js";

/** Build ASR words at a fixed 0.5 s cadence starting at `start`. */
const asr = (words: string[], start = 0, step = 0.5): AsrWord[] =>
  words.map((word, index) => ({
    word,
    start: start + index * step,
    end: start + (index + 1) * step,
  }));

describe("story tokenizeScript", () => {
  it("keeps sentence punctuation on the token that owns it", () => {
    expect(tokenizeScript("It ended. Then!")).toEqual([
      "It",
      "ended.",
      "Then!",
    ]);
  });

  it("keeps commas, colons and closing quotes", () => {
    expect(tokenizeScript('He said "stop." Then he left, slowly.')).toEqual([
      "He",
      "said",
      '"stop."',
      "Then",
      "he",
      "left,",
      "slowly.",
    ]);
  });

  it("never splits a decimal into two tokens", () => {
    expect(tokenizeScript("Pi is 3.14 ok.")).toEqual([
      "Pi",
      "is",
      "3",
      "14",
      "ok.",
    ]);
  });

  it("returns nothing for empty input", () => {
    expect(tokenizeScript("   ")).toEqual([]);
  });
});

describe("story normalizeToken / numberValue", () => {
  it("strips punctuation, case and diacritics", () => {
    expect(normalizeToken("Days.")).toBe("days");
    expect(normalizeToken("don’t")).toBe("don't");
    expect(normalizeToken("café")).toBe("cafe");
    expect(normalizeToken("well–known")).toBe("well-known");
    expect(normalizeToken("...")).toBe("");
  });

  it("reads digits, separators and number words", () => {
    expect(numberValue("1492")).toBe(1492);
    expect(numberValue("1,492")).toBe(1492);
    expect(numberValue("3.5")).toBe(3.5);
    expect(numberValue("fourteen")).toBe(14);
    expect(numberValue("ninety-two")).toBe(92);
    expect(numberValue("hundred")).toBe(100);
    expect(numberValue("four hundred")).toBe(400);
    expect(numberValue("one thousand")).toBe(1000);
  });

  it("reads ordinals the way narration speaks them", () => {
    expect(numberValue("eleventh")).toBe(11);
    expect(numberValue("twenty-first")).toBe(21);
    expect(numberValue("third")).toBe(3);
    expect(numberValue("twelfth")).toBe(12);
    expect(numberValue("twentieth")).toBe(20);
    expect(numberValue("hundredth")).toBe(100);
  });

  it("returns undefined for non-numbers", () => {
    expect(numberValue("ship")).toBeUndefined();
    expect(numberValue("")).toBeUndefined();
  });
});

describe("story alignScene", () => {
  it("matches a clean transcript and keeps the script's punctuation", () => {
    const script = "The crew had not seen land for many days.";
    const tokens = tokenizeScript(script);
    const result = alignScene({
      scriptText: script,
      asrWords: asr(tokens.map((token) => token.replace(/\.$/, ""))),
      bounds: { start: 0, end: 4.5 },
    });

    expect(result.method).toBe("aligned");
    expect(result.matchRatio).toBe(1);
    expect(result.matched).toBe(result.total);
    expect(result.words.map((word) => word.token)).toEqual(tokens);
    expect(result.words.every((word) => word.matched)).toBe(true);
    expect(result.words[0].start).toBe(0);
    expect(result.words[result.words.length - 1].end).toBe(4.5);
  });

  it("absorbs a dropped ASR word and interpolates the missing token", () => {
    const script = "The crew had not seen land for many days now.";
    const result = alignScene({
      scriptText: script,
      // "had" is dropped by the transcriber.
      asrWords: asr([
        "The",
        "crew",
        "not",
        "seen",
        "land",
        "for",
        "many",
        "days",
        "now",
      ]),
      bounds: { start: 0, end: 4.5 },
    });

    expect(result.method).toBe("aligned");
    expect(result.matchRatio).toBeCloseTo(9 / 10, 10);
    expect(result.matchRatio).toBeGreaterThanOrEqual(SCENE_ALIGNMENT_GATE);
    const dropped = result.words[2];
    expect(dropped.token).toBe("had");
    expect(dropped.matched).toBe(false);
    // Interpolated strictly between its matched neighbours.
    expect(dropped.start).toBeGreaterThanOrEqual(result.words[1].end);
    expect(dropped.end).toBeLessThanOrEqual(result.words[3].start);
  });

  it("ignores extra ASR words", () => {
    const script = "It was a long night.";
    const result = alignScene({
      scriptText: script,
      asrWords: asr(["um", "It", "was", "a", "long", "um", "night"]),
      bounds: { start: 0, end: 3.5 },
    });

    expect(result.method).toBe("aligned");
    expect(result.matchRatio).toBe(1);
  });

  it("matches a spoken year to its digit form", () => {
    const result = alignScene({
      scriptText: "It was 1492 when it began.",
      asrWords: asr([
        "it",
        "was",
        "fourteen",
        "ninety-two",
        "when",
        "it",
        "began",
      ]),
      bounds: { start: 0, end: 3.5 },
    });

    expect(result.matched).toBe(6);
    expect(result.matchRatio).toBe(1);
    expect(result.method).toBe("aligned");
    const year = result.words.find((word) => word.token === "1492");
    expect(year?.matched).toBe(true);
    expect(year?.start).toBe(1);
  });

  it("falls back to proportional timing when the transcript does not match", () => {
    const result = alignScene({
      scriptText: "Alpha beta gamma delta.",
      asrWords: asr(["completely", "different", "words"]),
      bounds: { start: 10, end: 14 },
    });

    expect(result.method).toBe("proportional");
    expect(result.matchRatio).toBe(0);
    expect(result.words).toHaveLength(4);
    expect(result.words[0].start).toBe(10);
    expect(result.words[3].end).toBeCloseTo(14, 10);
    for (let index = 1; index < result.words.length; index++) {
      expect(result.words[index].start).toBeGreaterThanOrEqual(
        result.words[index - 1].end,
      );
    }
  });

  it("never times a word outside the scene window", () => {
    const tokens = tokenizeScript(
      "One two three four five six seven eight nine ten.",
    );
    const result = alignScene({
      scriptText: "One two three four five six seven eight nine ten.",
      // Matched words, but every timestamp is outside the chunk window.
      asrWords: tokens.map((word, index) => ({
        word,
        start: -10 + index,
        end: -9.5 + index,
      })),
      bounds: { start: 0, end: 1.5 },
    });

    expect(result.method).toBe("aligned");
    expect(result.matchRatio).toBe(1);
    for (const word of result.words) {
      expect(word.start).toBeGreaterThanOrEqual(0);
      expect(word.end).toBeLessThanOrEqual(1.5);
      expect(word.end).toBeGreaterThanOrEqual(word.start);
    }
  });

  it("returns no words for an empty script", () => {
    expect(
      alignScene({
        scriptText: "",
        asrWords: [],
        bounds: { start: 0, end: 1 },
      }),
    ).toMatchObject({ words: [], matchRatio: 1, method: "proportional" });
  });
});

describe("story proportionalAlignment", () => {
  it("weights longer tokens with more time and covers the window exactly", () => {
    const words = proportionalAlignment(["a", "bbbbbbbbbb"], {
      start: 0,
      end: 11,
    });
    expect(words[1].end - words[1].start).toBeGreaterThan(
      words[0].end - words[0].start,
    );
    expect(words[1].end).toBeCloseTo(11, 10);
  });
});

describe("story narrationFidelity", () => {
  it("reports full coverage when every script word was heard", () => {
    const fidelity = narrationFidelity(
      "The sailors stared at the empty ocean.",
      asr(["The", "sailors", "stared", "at", "the", "empty", "ocean"]),
    );
    expect(fidelity.coverage).toBe(1);
    expect(fidelity.missing).toEqual([]);
  });

  it("names the script words a free ASR pass never heard", () => {
    const fidelity = narrationFidelity(
      "The crew had not seen land for many days now.",
      asr(["The", "crew", "not", "seen", "land", "for", "many", "days", "now"]),
    );
    expect(fidelity.coverage).toBeCloseTo(0.9, 10);
    expect(fidelity.missing).toEqual(["had"]);
  });

  it("matches a spoken year against its digit form", () => {
    const fidelity = narrationFidelity(
      "It was fourteen ninety-two when it began.",
      asr(["It", "was", "1492", "when", "it", "began"]),
    );
    expect(fidelity.coverage).toBe(1);
    expect(fidelity.missing).toEqual([]);
  });

  it("matches a spoken half against the ASR decimal form", () => {
    const fidelity = narrationFidelity(
      "It leans over, tipped about twenty-three and a half degrees.",
      asr(["It", "leans", "over", "tipped", "about", "23.5", "degrees"]),
    );
    expect(fidelity.coverage).toBe(1);
    expect(fidelity.missing).toEqual([]);
  });

  it("flags a repeated word in place of the script's ending", () => {
    const fidelity = narrationFidelity(
      "We saw land and we cheered.",
      asr(["We", "saw", "land", "and", "saw", "land"]),
    );
    expect(fidelity.coverage).toBeLessThan(1);
    expect(fidelity.missing.some((word) => word.startsWith("cheered"))).toBe(
      true,
    );
  });

  it("reads a spoken date with a comma as two numbers", () => {
    const fidelity = narrationFidelity(
      "It was the night of October eleventh, fourteen ninety-two.",
      asr(["It", "was", "the", "night", "of", "October", "11,", "1492"]),
    );
    expect(fidelity.coverage).toBe(1);
    expect(fidelity.missing).toEqual([]);
  });

  it("flags a dropped clause below the warning threshold", () => {
    // 3 of 16 tokens missing -> 0.81, under the 0.85 warning line.
    const fidelity = narrationFidelity(
      "We saw land and we cheered while the whole crew ran to the rail.",
      asr([
        "We",
        "saw",
        "land",
        "and",
        "the",
        "whole",
        "crew",
        "ran",
        "to",
        "the",
        "rail",
      ]),
    );
    expect(fidelity.coverage).toBeLessThan(0.85);
    expect(fidelity.missing).toEqual(["we", "cheered", "while"]);
  });

  it("treats an empty script as fully covered", () => {
    expect(narrationFidelity("   ", [])).toEqual({ coverage: 1, missing: [] });
  });
});
