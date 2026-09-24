import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import {
  choiceAnswer,
  minConfidence,
  noulAnswer,
  scoreAnswer,
} from "../src/classifiers/answers.js";
import { classificationTelemetry } from "../src/classifiers/telemetry.js";
import type { ClassificationResult } from "../src/classifiers/types.js";

function result(
  answers: ClassificationResult["answers"],
): ClassificationResult {
  return {
    answers,
    provider: "typesafe",
    model: "jev-test",
    usage: { inputTokens: 10, outputTokens: 0 },
    durationMs: 42,
  };
}

describe("answer accessors", () => {
  const sample = result({
    status: {
      type: "choice",
      choice: "approved",
      confidence: 0.91,
      probabilities: { approved: 0.91, fatal: 0.09 },
    },
    urgent: { type: "noul", noul: 0.95 },
    quality: {
      type: "score",
      score: 1.5,
      confidence: 0.7,
      probabilities: { "0": 0.2, "1": 0.6, "2": 0.2 },
    },
  });

  it("returns a typed choice answer", () => {
    const answer = choiceAnswer(sample, "status");
    expect(answer.choice).toBe("approved");
    expect(answer.confidence).toBe(0.91);
  });

  it("returns a typed noul answer", () => {
    expect(noulAnswer(sample, "urgent").noul).toBe(0.95);
  });

  it("returns a typed score answer", () => {
    expect(scoreAnswer(sample, "quality").score).toBe(1.5);
  });

  it("throws when the answer is missing", () => {
    expect(() => choiceAnswer(sample, "nope")).toThrow(
      'missing answer for question "nope"',
    );
  });

  it("throws when the answer has the wrong type", () => {
    expect(() => noulAnswer(sample, "status")).toThrow(
      "is choice, expected noul",
    );
  });

  it("minConfidence is the floor across named choice/score answers", () => {
    expect(minConfidence(sample, ["status", "quality"])).toBeCloseTo(0.7);
    expect(minConfidence(sample, ["status"])).toBeCloseTo(0.91);
  });

  it("minConfidence ignores nouls and defaults to 1 when none carry confidence", () => {
    expect(minConfidence(sample, ["urgent"])).toBe(1);
    expect(minConfidence(sample, [])).toBe(1);
  });
});

describe("classificationTelemetry", () => {
  it("projects classifier usage into NodeTelemetry shape", () => {
    const telemetry = classificationTelemetry(
      {
        answers: {},
        provider: "typesafe",
        model: "jev-latest",
        usage: { inputTokens: 120, outputTokens: 0 },
        durationMs: 88,
      },
      { promptVersion: "prompts/prompt-qa/v1", agentVersion: "1.0.0" },
    );
    expect(telemetry).toEqual({
      model: "typesafe/jev-latest",
      durationMs: 88,
      promptTokens: 120,
      completionTokens: 0,
      totalTokens: 120,
      retries: 0,
      promptVersion: "prompts/prompt-qa/v1",
      agentVersion: "1.0.0",
    });
  });
});

describe("classifier env defaults", () => {
  const KEYS = [
    "CLASSIFIER_PROVIDER",
    "CLASSIFIER_PROMPTQA",
    "CLASSIFIER_PROMPTQA_CONFIDENCE_MIN",
    "TYPESAFE_API_KEY",
    "TYPESAFE_DEFAULT_MODEL",
  ];
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = {};
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("config defaults keep the classifier layer off", async () => {
    const { config } = await import("../src/utils/config.js");
    expect(config.classifierProvider()).toBe("off");
    expect(config.classifierEnabledFor("promptqa")).toBe(false);
    expect(config.classifierConfidenceMin("promptqa")).toBe(0.85);
    expect(config.typesafeApiKey()).toBeUndefined();
    expect(config.typesafeDefaultModel()).toBe("jev-latest");
  });

  it("master switch plus gate flag enable a gate; explicit false disables it", async () => {
    const { config } = await import("../src/utils/config.js");
    process.env.CLASSIFIER_PROVIDER = "typesafe";
    process.env.TYPESAFE_API_KEY = "sk-test";
    expect(config.classifierEnabledFor("promptqa")).toBe(true);

    process.env.CLASSIFIER_PROMPTQA = "false";
    expect(config.classifierEnabledFor("promptqa")).toBe(false);
    // other gates unaffected
    expect(config.classifierEnabledFor("researchqa")).toBe(true);
  });

  it("per-gate confidence floor parses valid values and rejects invalid", async () => {
    const { config } = await import("../src/utils/config.js");
    process.env.CLASSIFIER_PROMPTQA_CONFIDENCE_MIN = "0.93";
    expect(config.classifierConfidenceMin("promptqa")).toBe(0.93);

    process.env.CLASSIFIER_PROMPTQA_CONFIDENCE_MIN = "1.5";
    expect(config.classifierConfidenceMin("promptqa")).toBe(0.85);

    process.env.CLASSIFIER_PROMPTQA_CONFIDENCE_MIN = "abc";
    expect(config.classifierConfidenceMin("promptqa")).toBe(0.85);
  });
});
