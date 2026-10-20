import { describe, it, expect } from "@jest/globals";
import {
  assembleNarration,
  countWords,
  estimatedDurationSec,
  fallbackGrouping,
  segmentSentences,
  splitSentences,
  validateGrouping,
} from "../src/story/sentences.js";

const word = (count: number, prefix = "w"): string =>
  Array.from({ length: count }, (_, index) => `${prefix}${index}`).join(" ");

describe("story splitSentences", () => {
  it("splits on Latin terminators and normalizes whitespace", () => {
    expect(splitSentences("One.  Two!\nThird?")).toEqual([
      "One.",
      "Two!",
      "Third?",
    ]);
  });

  it("keeps a sentence together across an abbreviation", () => {
    expect(splitSentences("Dr. Smith arrived. He left.")).toEqual([
      "Dr. Smith arrived.",
      "He left.",
    ]);
  });

  it("keeps a sentence together across initials", () => {
    expect(splitSentences("J. K. Rowling wrote it. It sold well.")).toEqual([
      "J. K. Rowling wrote it.",
      "It sold well.",
    ]);
  });

  it("does not split decimals or thousands separators", () => {
    expect(splitSentences("Pi is 3.14 exactly. Yes.")).toEqual([
      "Pi is 3.14 exactly.",
      "Yes.",
    ]);
    expect(splitSentences("It cost 1,492 coins. Then it stopped.")).toEqual([
      "It cost 1,492 coins.",
      "Then it stopped.",
    ]);
  });

  it("continues a sentence after a lowercase word", () => {
    expect(splitSentences("Wait... one moment. Then go.")).toEqual([
      "Wait... one moment.",
      "Then go.",
    ]);
  });

  it("splits after a closing quote", () => {
    expect(splitSentences('He shouted "stop." Then he left.')).toEqual([
      'He shouted "stop."',
      "Then he left.",
    ]);
  });

  it("splits spaceless terminators (Urdu, Devanagari, CJK)", () => {
    expect(splitSentences("ایک۔ دو؟")).toEqual(["ایک۔", "دو؟"]);
    expect(splitSentences("एक। दो।")).toEqual(["एक।", "दो।"]);
    expect(splitSentences("一。二！")).toEqual(["一。", "二！"]);
  });

  it("returns an empty list for empty input", () => {
    expect(splitSentences("   \n ")).toEqual([]);
  });
});

describe("story segmentSentences / countWords / assembleNarration", () => {
  it("assigns stable s1..sN ids", () => {
    const sentences = segmentSentences("First one. Second one. Third one.");
    expect(sentences.map((sentence) => sentence.id)).toEqual([
      "s1",
      "s2",
      "s3",
    ]);
    expect(sentences[0].text).toBe("First one.");
    expect(sentences[0].wordCount).toBe(2);
  });

  it("counts hyphenated and apostrophe words as one token", () => {
    expect(countWords("It's a well-known fact.")).toBe(4);
  });

  it("reassembles narration from ids, never from model text", () => {
    const sentences = segmentSentences("First one. Second one. Third one.");
    const byId = new Map(sentences.map((sentence) => [sentence.id, sentence]));
    expect(assembleNarration(["s1", "s3"], byId)).toBe("First one. Third one.");
    expect(assembleNarration(["s1", "s99", "s2"], byId)).toBe(
      "First one. Second one.",
    );
  });

  it("estimates duration from word counts at the configured rate", () => {
    const sentences = segmentSentences(`${word(15, "A")}. ${word(15, "B")}.`);
    expect(estimatedDurationSec(sentences, 150)).toBeCloseTo(12, 5);
  });
});

describe("story validateGrouping", () => {
  const sentences = segmentSentences("A one. B two. C three. D four.");

  it("accepts a complete contiguous grouping", () => {
    expect(
      validateGrouping(
        [
          { sceneId: 1, sentenceIds: ["s1", "s2"], visualPurpose: "p1" },
          { sceneId: 2, sentenceIds: ["s3", "s4"], visualPurpose: "p2" },
        ],
        sentences,
      ),
    ).toEqual([]);
  });

  it("rejects an unknown sentence id", () => {
    const issues = validateGrouping(
      [{ sceneId: 1, sentenceIds: ["s1", "s9"], visualPurpose: "p" }],
      sentences,
    );
    expect(issues.map((issue) => issue.message).join(" ")).toContain(
      "unknown sentence id s9",
    );
  });

  it("rejects a sentence used twice", () => {
    const issues = validateGrouping(
      [
        { sceneId: 1, sentenceIds: ["s1"], visualPurpose: "p" },
        { sceneId: 2, sentenceIds: ["s1"], visualPurpose: "p" },
      ],
      sentences,
    );
    expect(issues.map((issue) => issue.message).join(" ")).toContain(
      "used by both scene 1 and scene 2",
    );
  });

  it("rejects out-of-order sentences", () => {
    const issues = validateGrouping(
      [{ sceneId: 1, sentenceIds: ["s2", "s1"], visualPurpose: "p" }],
      sentences,
    );
    expect(issues.map((issue) => issue.message).join(" ")).toContain(
      "must be covered in order",
    );
  });

  it("rejects a non-sequential sceneId and an empty scene", () => {
    const issues = validateGrouping(
      [
        { sceneId: 2, sentenceIds: [], visualPurpose: "p" },
        {
          sceneId: 3,
          sentenceIds: ["s1", "s2", "s3", "s4"],
          visualPurpose: "p",
        },
      ],
      sentences,
    );
    const messages = issues.map((issue) => issue.message).join(" ");
    expect(messages).toContain("must have sceneId 1");
    expect(messages).toContain("covers no sentences");
  });

  it("reports sentences no scene covers", () => {
    const issues = validateGrouping(
      [{ sceneId: 1, sentenceIds: ["s1"], visualPurpose: "p" }],
      sentences,
    );
    expect(issues.map((issue) => issue.message).join(" ")).toContain(
      "sentences not covered by any scene: s2, s3, s4",
    );
  });

  it("rejects an empty grouping", () => {
    expect(validateGrouping([], sentences)).toEqual([
      { message: "grouping must contain at least one scene" },
    ]);
  });
});

describe("story fallbackGrouping", () => {
  const options = {
    wpm: 150,
    sceneMinSec: 3,
    sceneTargetMinSec: 6,
    sceneTargetMaxSec: 12,
  };

  it("covers every sentence once, in order, and never splits one", () => {
    const sentences = segmentSentences(
      `${word(10, "A")}. ${word(10, "B")}. ${word(10, "C")}. ${word(10, "D")}. ${word(10, "E")}. ${word(10, "F")}.`,
    );
    const scenes = fallbackGrouping(sentences, options);
    expect(scenes.flatMap((scene) => scene.sentenceIds)).toEqual(
      sentences.map((sentence) => sentence.id),
    );
    expect(validateGrouping(scenes, sentences)).toEqual([]);
    // 30 words = 12 s per scene at 150 wpm, so three sentences per scene.
    expect(scenes.map((scene) => scene.sentenceIds.length)).toEqual([3, 3]);
  });

  it("folds a too-short trailing scene into its predecessor", () => {
    const sentences = segmentSentences(
      `${word(10, "A")}. ${word(10, "B")}. ${word(10, "C")}. ${word(10, "D")}. ${word(10, "E")}. ${word(10, "F")}. Tiny.`,
    );
    const scenes = fallbackGrouping(sentences, options);
    expect(scenes).toHaveLength(2);
    expect(scenes[1].sentenceIds).toEqual(["s4", "s5", "s6", "s7"]);
  });

  it("keeps a single scene when the story is shorter than the target", () => {
    const sentences = segmentSentences(`${word(5, "A")}. ${word(5, "B")}.`);
    const scenes = fallbackGrouping(sentences, options);
    expect(scenes).toHaveLength(1);
    expect(scenes[0].sentenceIds).toEqual(["s1", "s2"]);
  });
});

/**
 * Matrix #5: the concatenated scene narration must always equal the story, and
 * grouping validation must reject every corruption — checked over many random
 * partitions rather than the handful of fixtures above.
 */
describe("story grouping properties", () => {
  /** Deterministic PRNG so a failure is reproducible. */
  function random(seed: number): () => number {
    let state = seed;
    return () => {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const storyText = [
    "Johannes Gutenberg lined up tiny metal letters.",
    "It was Mainz, around 1450.",
    "Each block was reversed.",
    "He inked the letters!",
    "He pressed a sheet of paper down on top.",
    '"A full page of words appeared," the chronicle says.',
    "Before this, scribes copied books by hand.",
    "One page could take months.",
    "Now a workshop made many copies quickly.",
    "Books became cheaper.",
    "Printers opened shops in town after town.",
    "Some historians think more people owned books.",
    "Gutenberg's Bible came out in the 1450s.",
    "Some copies survive today.",
    "The press changed how Europe read.",
  ].join(" ");

  const sentences = segmentSentences(storyText);
  const byId = new Map(sentences.map((sentence) => [sentence.id, sentence]));

  function partition(rand: () => number): string[][] {
    const groups: string[][] = [];
    let current: string[] = [];
    for (let index = 0; index < sentences.length; index++) {
      current.push(sentences[index].id);
      const isLast = index === sentences.length - 1;
      const cut = rand() < 0.3 || current.length >= 4;
      if (cut && !isLast) {
        groups.push(current);
        current = [];
      }
    }
    if (current.length > 0) groups.push(current);
    return groups;
  }

  function asScenes(groups: string[][]) {
    return groups.map((sentenceIds, index) => ({
      sceneId: index + 1,
      sentenceIds,
      visualPurpose: `Scene ${index + 1}`,
    }));
  }

  const expectedNarration = sentences
    .map((sentence) => sentence.text)
    .join(" ");

  it("accepts every random contiguous partition and reassembles the story exactly", () => {
    for (const seed of [1, 7, 99]) {
      const rand = random(seed);
      for (let iteration = 0; iteration < 100; iteration++) {
        const groups = partition(rand);
        const scenes = asScenes(groups);
        expect(validateGrouping(scenes, sentences)).toEqual([]);

        const narration = groups.map((ids) => assembleNarration(ids, byId));
        expect(narration.join(" ")).toBe(expectedNarration);
      }
    }
  });

  it("rejects duplication, omission, reordering and empty scenes", () => {
    const rand = random(42);
    for (let iteration = 0; iteration < 100; iteration++) {
      const groups = partition(rand);
      if (groups.length < 2) continue;
      const scenes = asScenes(groups);

      // Duplicate the first id into the second scene.
      const duplicated = asScenes(groups.map((ids) => [...ids]));
      duplicated[1].sentenceIds.push(duplicated[0].sentenceIds[0]);
      expect(validateGrouping(duplicated, sentences).length).toBeGreaterThan(0);

      // Drop the last id of the first scene.
      const dropped = asScenes(groups.map((ids) => [...ids]));
      dropped[0].sentenceIds.pop();
      expect(validateGrouping(dropped, sentences).length).toBeGreaterThan(0);

      // Swap the first ids of the first two scenes.
      const swapped = asScenes(groups.map((ids) => [...ids]));
      const first = swapped[0].sentenceIds[0];
      swapped[0].sentenceIds[0] = swapped[1].sentenceIds[0];
      swapped[1].sentenceIds[0] = first;
      const swapIssues = validateGrouping(swapped, sentences);
      // A swap of two adjacent single-id scenes is a reorder and must fail.
      expect(swapIssues.length).toBeGreaterThan(0);

      // Empty the last scene.
      const emptied = asScenes(groups.map((ids) => [...ids]));
      emptied[emptied.length - 1].sentenceIds = [];
      expect(validateGrouping(emptied, sentences).length).toBeGreaterThan(0);

      // Non-sequential ids.
      const renumbered = asScenes(groups.map((ids) => [...ids]));
      renumbered[0].sceneId = 5;
      expect(validateGrouping(renumbered, sentences).length).toBeGreaterThan(0);
    }
  });

  it("fallback grouping always validates and never splits a sentence", () => {
    for (const seed of [3, 11, 1234]) {
      const rand = random(seed);
      for (let iteration = 0; iteration < 50; iteration++) {
        const groups = partition(rand);
        const scenes = fallbackGrouping(sentences, {
          wpm: 140 + Math.floor(rand() * 30),
          sceneMinSec: 3,
          sceneTargetMinSec: 5 + Math.floor(rand() * 3),
          sceneTargetMaxSec: 9 + Math.floor(rand() * 4),
        });
        expect(validateGrouping(scenes, sentences)).toEqual([]);
        const flat = scenes.flatMap((scene) => scene.sentenceIds);
        expect(flat).toEqual(sentences.map((sentence) => sentence.id));
        expect(groups.flat()).toEqual(flat);
      }
    }
  });
});
