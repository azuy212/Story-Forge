import { describe, it, expect } from "@jest/globals";
import { buildKaraokeAss, splitIntoLines } from "../src/utils/ass.js";
import type { WordTimestamp } from "../src/providers/subtitle-provider.js";

function words(entries: Array<[string, number, number]>): WordTimestamp[] {
  return entries.map(([word, start, end]) => ({ word, start, end }));
}

describe("splitIntoLines", () => {
  it("keeps 4 words on a single line", () => {
    const w = words([
      ["a", 0, 0.2],
      ["b", 0.2, 0.4],
      ["c", 0.4, 0.6],
      ["d", 0.6, 0.8],
    ]);
    expect(splitIntoLines(w)).toEqual([w]);
  });

  it("splits 5 words into balanced 2+3 lines", () => {
    const w = words([
      ["a", 0, 0.2],
      ["b", 0.2, 0.4],
      ["c", 0.4, 0.6],
      ["d", 0.6, 0.8],
      ["e", 0.8, 1.0],
    ]);
    const lines = splitIntoLines(w);
    expect(lines.map((l) => l.length)).toEqual([2, 3]);
  });

  it("never leaves a single-word orphan line", () => {
    const w = words([
      ["a", 0, 0.2],
      ["b", 0.2, 0.4],
      ["c", 0.4, 0.6],
      ["d", 0.6, 0.8],
      ["e", 0.8, 1.0],
      ["f", 1.0, 1.2],
      ["g", 1.2, 1.4],
    ]);
    const lines = splitIntoLines(w);
    expect(lines.length).toBeLessThanOrEqual(2);
    expect(lines.every((l) => l.length >= 2)).toBe(true);
  });
});

describe("buildKaraokeAss", () => {
  it("emits a header, style, and one event per word", () => {
    const groups = [
      words([
        ["The", 0.0, 0.3],
        ["Boston", 0.3, 0.6],
        ["Molasses", 0.6, 0.9],
        ["Flood", 0.9, 1.2],
      ]),
    ];
    const ass = buildKaraokeAss(groups, {
      fontSize: 14,
      marginV: 24,
      accentColor: "&H0000E0FF",
    });

    expect(ass).toContain("[Script Info]");
    expect(ass).toContain("Style: Default,Noto Sans,14");
    expect(ass).toContain(
      "Style: Default,Noto Sans,14,&H00FFFFFF,&H0000E0FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,2,0,2,20,20,24,1",
    );
    expect(ass).toContain("[Events]");
    // One Dialogue event per word in the group.
    expect(ass.match(/Dialogue: 0,/g)).toHaveLength(4);
  });

  it("accent colors exactly one word per event and keeps the rest primary", () => {
    const groups = [
      words([
        ["The", 0.0, 0.3],
        ["Boston", 0.3, 0.6],
      ]),
    ];
    const ass = buildKaraokeAss(groups, {
      primaryColor: "&H00FFFFFF",
      accentColor: "&H0000E0FF",
    });

    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue: 0,"));
    expect(events).toHaveLength(2);

    // Event 1: "The" accented, "Boston" plain.
    expect(events[0]).toContain("{\\c&H0000E0FF}The{\\c&H00FFFFFF} Boston");
    // Event 2: "The" plain, "Boston" accented.
    expect(events[1]).toContain("The {\\c&H0000E0FF}Boston{\\c&H00FFFFFF}");
  });

  it("event timing follows word boundaries with no gaps", () => {
    const groups = [
      words([
        ["The", 0.0, 0.3],
        ["Boston", 0.3, 0.6],
        ["Molasses", 0.6, 0.9],
      ]),
    ];
    const ass = buildKaraokeAss(groups);

    const times = ass
      .split("\n")
      .filter((l) => l.startsWith("Dialogue: 0,"))
      .map((l) => {
        const m = l.match(/Dialogue: 0,([\d:.]+),([\d:.]+),Default/);
        return m ? [m[1], m[2]] : null;
      });

    // Event 1 spans word 0 start -> word 1 start; event 2 word 1 -> word 2
    // start; event 3 word 2 -> group end. Contiguous, gap-free.
    expect(times).toEqual([
      ["0:00:00.00", "0:00:00.30"],
      ["0:00:00.30", "0:00:00.60"],
      ["0:00:00.60", "0:00:00.90"],
    ]);
  });

  it("escapes ASS control characters in word text", () => {
    const groups = [
      words([
        ["a\\b{c}", 0.0, 0.3],
        ["d", 0.3, 0.6],
      ]),
    ];
    const ass = buildKaraokeAss(groups);
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue: 0,"));
    expect(events[0]).not.toContain("\\b{c}");
    expect(events[0]).toContain("a\\\\b\\{c\\}");
  });

  it("splits long groups into at most 2 lines", () => {
    const groups = [
      words([
        ["one", 0, 0.2],
        ["two", 0.2, 0.4],
        ["three", 0.4, 0.6],
        ["four", 0.6, 0.8],
        ["five", 0.8, 1.0],
      ]),
    ];
    const ass = buildKaraokeAss(groups);
    const events = ass.split("\n").filter((l) => l.startsWith("Dialogue: 0,"));
    for (const ev of events) {
      expect(ev.match(/\\N/g)?.length ?? 0).toBeLessThanOrEqual(1);
    }
  });
});
