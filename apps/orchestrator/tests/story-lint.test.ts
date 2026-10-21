import { describe, it, expect } from "@jest/globals";
import {
  STORY_COMPLEXITY_THRESHOLDS,
  WORD_BUDGET_TOLERANCE,
  characterCues,
  findHardWordIssues,
  formatLintViolations,
  lintCharacterRegistry,
  lintStory,
  storyStyleLimits,
} from "../src/story/lint.js";
import { countWords } from "../src/story/sentences.js";

/**
 * Build a story of exactly `total` words in sentences of at most ten words, so
 * the shared sentence splitter (which continues a sentence after a lowercase
 * word) sees a real sentence boundary at every full stop.
 */
function storyOfWords(total: number): string {
  const sentences: string[] = [];
  let remaining = total;
  let sentenceIndex = 0;
  while (remaining > 0) {
    const take = Math.min(10, remaining);
    const words = Array.from(
      { length: take },
      (_, index) => `w${sentenceIndex}${String.fromCharCode(97 + index)}`,
    );
    words[0] = `${words[0].charAt(0).toUpperCase()}${words[0].slice(1)}`;
    sentences.push(`${words.join(" ")}.`);
    remaining -= take;
    sentenceIndex += 1;
  }
  return sentences.join(" ");
}

const EXPLANATION_CUES = ["\\bwhich (?:is|was|means)\\b"];

describe("story findHardWordIssues", () => {
  it("returns nothing when the style lists no hard words", () => {
    expect(
      findHardWordIssues("A mutiny happened.", [], EXPLANATION_CUES),
    ).toEqual([]);
  });

  it("accepts a hard word explained in its own sentence", () => {
    expect(
      findHardWordIssues(
        "The crew planned a mutiny, which means they took the ship.",
        ["mutiny"],
        EXPLANATION_CUES,
      ),
    ).toEqual([]);
  });

  it("rejects a hard word with no explanation", () => {
    const issues = findHardWordIssues(
      "The crew planned a mutiny that night.",
      ["mutiny"],
      EXPLANATION_CUES,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('Hard word "mutiny"');
  });

  it("does not accept an explanation from a different sentence", () => {
    const issues = findHardWordIssues(
      "The crew planned a mutiny. It means taking the ship, which is a crime.",
      ["mutiny"],
      EXPLANATION_CUES,
    );
    expect(issues).toHaveLength(1);
  });

  it("matches whole words, case-insensitively", () => {
    expect(
      findHardWordIssues(
        "A Mutiny, which means trouble.",
        ["mutiny"],
        EXPLANATION_CUES,
      ),
    ).toEqual([]);
    expect(
      findHardWordIssues(
        "The mutinous sailors left.",
        ["mutiny"],
        EXPLANATION_CUES,
      ),
    ).toEqual([]);
  });

  it("falls back to the built-in cues when the profile supplies none", () => {
    expect(
      findHardWordIssues(
        "A mutiny, which means taking the ship.",
        ["mutiny"],
        [],
      ),
    ).toEqual([]);
  });

  it("ignores an invalid explanation cue instead of throwing", () => {
    expect(
      findHardWordIssues("A mutiny happened.", ["mutiny"], ["[("]),
    ).toHaveLength(1);
  });
});

describe("story lintStory word budget", () => {
  const options = {
    wpm: 150,
    targetDurationSec: 30,
    hardWords: [],
    explanationCues: [],
  };

  it("passes a story on the budget and reports its metrics", () => {
    const story = storyOfWords(75);
    const report = lintStory(story, options);

    expect(report.passed).toBe(true);
    expect(report.issues).toEqual([]);
    expect(report.wordCount).toBe(75);
    expect(report.sentenceCount).toBe(8);
    expect(report.wordBudgetTarget).toBe(75);
    expect(report.wordBudgetVariance).toBe(0);
    expect(report.averageSentenceWords).toBeLessThanOrEqual(
      STORY_COMPLEXITY_THRESHOLDS.maxAverageSentenceWords,
    );
    expect(report.maximumSentenceWords).toBeLessThanOrEqual(
      STORY_COMPLEXITY_THRESHOLDS.maxSentenceWords,
    );
  });

  it("accepts the outer edge of the ±15% tolerance", () => {
    // 86 / 75 - 1 = 0.1467, just inside 0.15.
    const report = lintStory(storyOfWords(86), options);
    expect(report.passed).toBe(true);
    expect(Math.abs(report.wordBudgetVariance)).toBeLessThanOrEqual(
      WORD_BUDGET_TOLERANCE,
    );
  });

  it("rejects a story over the budget and names the direction", () => {
    const report = lintStory(storyOfWords(100), options);
    expect(report.passed).toBe(false);
    expect(report.issues.join(" ")).toContain("33% over");
  });

  it("rejects a story under the budget", () => {
    const report = lintStory(storyOfWords(60), options);
    expect(report.passed).toBe(false);
    expect(report.issues.join(" ")).toContain("20% under");
  });

  it("skips the budget check when there is no target", () => {
    const report = lintStory(storyOfWords(75), {
      ...options,
      targetDurationSec: 0,
    });
    expect(report.wordBudgetTarget).toBe(0);
    expect(report.issues.join(" ")).not.toContain("budget");
  });
});

describe("story lintStory complexity integration", () => {
  it("uses the stricter story thresholds by default", () => {
    // 23 words in one sentence: over story's 22-word limit, inside the
    // Shorts limit of 25.
    const story = `${Array.from({ length: 23 }, (_, index) => `w${index}`).join(" ")}.`;
    const options = {
      wpm: 150,
      targetDurationSec: 20,
      hardWords: [],
      explanationCues: [],
    };

    const storyReport = lintStory(story, options);
    expect(storyReport.issues.join(" ")).toContain("limit is 22");

    const relaxed = lintStory(story, options, {
      ...STORY_COMPLEXITY_THRESHOLDS,
      maxSentenceWords: 25,
      maxAverageSentenceWords: 25,
    });
    expect(relaxed.issues.join(" ")).not.toContain("limit is 25");
  });

  it("reports a hard word through lintStory", () => {
    const report = lintStory("The crew planned a mutiny that night.", {
      wpm: 150,
      targetDurationSec: 3,
      hardWords: ["mutiny"],
      explanationCues: EXPLANATION_CUES,
    });
    expect(report.issues.join(" ")).toContain('Hard word "mutiny"');
  });

  it("formats violations as a bulleted feedback list", () => {
    const report = lintStory(storyOfWords(100), {
      wpm: 150,
      targetDurationSec: 30,
      hardWords: [],
      explanationCues: [],
    });
    const text = formatLintViolations(report);
    expect(text.startsWith("- ")).toBe(true);
    expect(text.split("\n").every((line) => line.startsWith("- "))).toBe(true);
  });

  it("counts words the same way the sentence layer does", () => {
    expect(countWords(storyOfWords(75))).toBe(75);
  });

  it("states the same limits to the writer that the linter enforces", () => {
    // The prompt must carry the numbers up front; a real first draft averaged
    // 15.3 words per sentence when they only arrived as rewrite feedback.
    const limits = storyStyleLimits(113);
    expect(limits.averageSentenceWords).toBe(
      STORY_COMPLEXITY_THRESHOLDS.maxAverageSentenceWords,
    );
    expect(limits.maxSentenceWords).toBe(
      STORY_COMPLEXITY_THRESHOLDS.maxSentenceWords,
    );
    const tolerance = Math.round(113 * WORD_BUDGET_TOLERANCE);
    expect(limits.minWords).toBe(113 - tolerance);
    expect(limits.maxWords).toBe(113 + tolerance);
  });
});

describe("story lintCharacterRegistry", () => {
  const character = (
    id: string,
    visualDescription: string,
    kind: "individual" | "group" = "individual",
  ) => ({ id, kind, visualDescription });

  it("accepts one cue on an individual", () => {
    expect(
      lintCharacterRegistry([
        character(
          "columbus",
          "A tall stick figure in a wide-brimmed black hat.",
        ),
      ]),
    ).toEqual([]);
  });

  it("rejects a second cue on an individual", () => {
    const issues = lintCharacterRegistry([
      character("rodrigo", "A stick figure with a red sash and a knit cap."),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('character "rodrigo"');
    expect(issues[0]).toMatch(/an individual needs exactly one/);
  });

  it("rejects an individual with no cue", () => {
    const issues = lintCharacterRegistry([
      character("sailor", "A plain stick figure in rough linen."),
    ]);
    expect(issues[0]).toMatch(/no silhouette cue/);
  });

  it("allows a group with two cues, or none at all", () => {
    expect(
      lintCharacterRegistry([
        character(
          "the_crew",
          "Stick figures in rough shirts with rope belts.",
          "group",
        ),
        character("islanders", "A crowd of plain stick figures.", "group"),
      ]),
    ).toEqual([]);
  });

  it("rejects two individuals sharing a cue", () => {
    const issues = lintCharacterRegistry([
      character("columbus", "A stick figure in a flat black hat."),
      character("rodrigo", "A stick figure in a flat black hat."),
    ]);
    expect(issues.join("\n")).toMatch(
      /characters "columbus" and "rodrigo" share the cue "hat"/,
    );
  });

  it("allows a group to repeat a member's base costume", () => {
    expect(
      lintCharacterRegistry([
        character("columbus", "A stick figure in a long dark-red coat."),
        character(
          "the_crew",
          "Stick figures in linen shirts and a dark-red coat.",
          "group",
        ),
      ]),
    ).toEqual([]);
  });

  it("rejects a place in the description", () => {
    const issues = lintCharacterRegistry([
      character("sailor", "A stick figure in a linen shirt on a deck."),
    ]);
    expect(issues[0]).toMatch(/names a place \("on a deck"\)/);
  });

  it("rejects an action in the description", () => {
    const issues = lintCharacterRegistry([
      character("columbus", "A stick figure holding a chart."),
    ]);
    expect(issues[0]).toMatch(/names an action \("holding"\)/);
  });

  it("rejects a costume list and names the cues", () => {
    const issues = lintCharacterRegistry([
      character(
        "columbus",
        "A tall man in a dark red knee-length coat over a black doublet, dark hose and a wide-brimmed black hat.",
      ),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('character "columbus"');
    expect(issues[0]).toContain("coat, doublet, hose, hat");
  });

  it("rejects a description over the word cap", () => {
    const issues = lintCharacterRegistry([
      character(
        "sailor",
        "A young sailor with a red sash who always smiles and never speaks unless the captain speaks to him first.",
      ),
    ]);
    expect(issues[0]).toMatch(/words \(max 16\)/);
  });

  it("is case-insensitive and counts plurals once", () => {
    expect(characterCues("Boots, boots, and a HAT.")).toEqual(["boots", "hat"]);
  });
});
