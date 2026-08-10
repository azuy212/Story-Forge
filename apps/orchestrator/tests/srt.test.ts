import { describe, it, expect } from "@jest/globals";
import { parseSrtCues } from "../src/utils/srt.js";

describe("parseSrtCues", () => {
  it("parses standard numbered cues with text", () => {
    const srt = [
      "1",
      "00:00:01,000 --> 00:00:03,500",
      "Hello world",
      "",
      "2",
      "00:00:04,000 --> 00:00:06,000",
      "Second cue",
      "with a second line",
    ].join("\n");

    const cues = parseSrtCues(srt);

    expect(cues).toHaveLength(2);
    expect(cues[0].startMs).toBe(1000);
    expect(cues[0].endMs).toBe(3500);
    expect(cues[0].text).toBe("Hello world");
    expect(cues[1].text).toBe("Second cue with a second line");
  });

  it("interprets short millisecond fractions as milliseconds, not raw ms", () => {
    const srt = "1\n00:00:00,5 --> 00:00:01,50\nFractional";
    const cues = parseSrtCues(srt);

    expect(cues[0].startMs).toBe(500);
    expect(cues[0].endMs).toBe(1500);
  });

  it("handles missing index numbers", () => {
    const srt = "00:00:00,000 --> 00:00:02,000\nNo index";
    const cues = parseSrtCues(srt);

    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe("No index");
  });

  it("returns empty array for empty or garbage input", () => {
    expect(parseSrtCues("")).toEqual([]);
    expect(parseSrtCues("not an srt at all")).toEqual([]);
    expect(parseSrtCues("1\nno timeline here\nfoo")).toEqual([]);
  });
});
