import { describe, expect, it } from "@jest/globals";
import {
  formatScriptComplexityReport,
  validateScriptComplexity,
} from "../src/utils/script-complexity.js";

describe("validateScriptComplexity", () => {
  it("passes clear spoken narration", () => {
    const report = validateScriptComplexity(
      "This island has no permanent residents. It sits far from every other island. Visitors need special permission to enter.",
    );

    expect(report.passed).toBe(true);
    expect(report.averageSentenceWords).toBeLessThanOrEqual(15);
    expect(report.maximumSentenceWords).toBeLessThanOrEqual(25);
  });

  it("fails narration with a sentence over the hard limit", () => {
    const narration = `${Array.from(
      { length: 26 },
      (_, index) => `word${index + 1}`,
    ).join(" ")}.`;
    const report = validateScriptComplexity(narration);

    expect(report.passed).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toContain(
      "maximum_sentence_length",
    );
  });

  it("flags obviously complex language and idiom", () => {
    const report = validateScriptComplexity(
      "Astronomers were perplexed by this celestial object. In a nutshell, it was a piece of cake to explain.",
    );

    expect(report.passed).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["complex_language", "idiom_or_slang"]),
    );
  });

  it("allows technical terminology when the narration explains it", () => {
    const report = validateScriptComplexity(
      "A black hole has an event horizon. Once something crosses it, it cannot escape. This boundary marks its edge.",
    );

    expect(report.passed).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it("allows technical explanations in the same sentence", () => {
    const report = validateScriptComplexity(
      "An event horizon is the boundary around a black hole. It marks the edge of escape.",
    );

    expect(report.passed).toBe(true);
  });

  it("does not accept an explanation two sentences later", () => {
    const report = validateScriptComplexity(
      "A black hole has an event horizon. The galaxy is huge and describes many stars. This boundary marks its edge.",
    );

    expect(report.issues.map((issue) => issue.code)).toContain(
      "unexplained_technical_term",
    );
  });

  it("handles decimals and common abbreviations", () => {
    const report = validateScriptComplexity(
      "Dr. Smith studies 2.5 million stars. U.S. scientists review the results.",
    );

    expect(report.sentenceCount).toBe(2);
    expect(report.maximumSentenceWords).toBeLessThanOrEqual(25);
  });

  it("flags unexplained technical terminology and reports soft grade warnings", () => {
    const report = validateScriptComplexity(
      "The ecosystem is highly unique. Photosynthesis transforms sunlight into energy for complex organisms.",
    );

    expect(report.passed).toBe(false);
    expect(report.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["unexplained_technical_term"]),
    );
    expect(report.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Approximate reading grade"),
      ]),
    );
    expect(formatScriptComplexityReport(report)).toContain(
      "Approximate reading grade:",
    );
  });
});
