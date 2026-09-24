import { describe, it, expect } from "@jest/globals";
import {
  GATE_STATUS_OPTIONS,
  answersToPrediction,
  buildQuestions,
  extractReference,
  isApprovedStatus,
} from "../src/eval/gates.js";
import type { ClassificationResult } from "../src/classifiers/types.js";

function result(
  answers: ClassificationResult["answers"],
  overrides: Partial<ClassificationResult> = {},
): ClassificationResult {
  return {
    answers,
    provider: "typesafe",
    model: "jev-test",
    usage: { inputTokens: 10, outputTokens: 0 },
    durationMs: 12,
    ...overrides,
  };
}

describe("buildQuestions", () => {
  it("always includes a status question with gate-specific options", () => {
    const questions = buildQuestions("releasereview", {});
    expect(questions.status).toBeDefined();
    if (questions.status?.type !== "choice") throw new Error("expected choice");
    expect(Object.keys(questions.status.options)).toEqual([
      "approved",
      "fatal",
    ]);
  });

  it("adds revision_target and per-scene questions for promptqa", () => {
    const questions = buildQuestions("promptqa", { sceneIds: [1, 3] });
    expect(Object.keys(questions).sort()).toEqual([
      "revision_target",
      "scene_1",
      "scene_3",
      "status",
    ]);
    expect(GATE_STATUS_OPTIONS.promptqa.approved).toBeDefined();
  });

  it("adds per-fact questions for researchqa", () => {
    const questions = buildQuestions("researchqa", {
      factIds: ["fact-001", "fact-002"],
    });
    expect(Object.keys(questions).sort()).toEqual([
      "fact_fact-001",
      "fact_fact-002",
      "status",
    ]);
  });

  it("scriptqa only asks status", () => {
    const questions = buildQuestions("scriptqa", { sceneIds: [1] });
    expect(Object.keys(questions)).toEqual(["status"]);
  });
});

describe("extractReference", () => {
  it("returns null for retry / missing status", () => {
    expect(extractReference("scriptqa", { status: "retry" })).toBeNull();
    expect(extractReference("scriptqa", {})).toBeNull();
  });

  it("extracts promptqa scene verdicts and revision target", () => {
    const reference = extractReference("promptqa", {
      status: "minor_revision",
      revisionTarget: "prompts",
      globalFeedback: "fix scene 2",
      issues: ["scene 2 prompt too vague"],
      sceneResults: [
        { sceneId: 1, verdict: "pass" },
        { sceneId: 2, verdict: "revise" },
      ],
    });
    expect(reference).toEqual({
      status: "minor_revision",
      revisionTarget: "prompts",
      feedback: "fix scene 2",
      issues: ["scene 2 prompt too vague"],
      sceneVerdicts: { 1: "pass", 2: "revise" },
    });
  });

  it("extracts researchqa fact verdicts", () => {
    const reference = extractReference("researchqa", {
      status: "approved",
      factVerdicts: [
        { factId: "fact-001", verdict: "keep", reason: "ok" },
        { factId: "fact-002", verdict: "revise", reason: "stale" },
      ],
    });
    expect(reference?.status).toBe("approved");
    expect(reference?.factVerdicts).toEqual({
      "fact-001": "keep",
      "fact-002": "revise",
    });
  });
});

describe("answersToPrediction", () => {
  it("maps status + confidence and promptqa sub-answers", () => {
    const prediction = answersToPrediction(
      "promptqa",
      result({
        status: {
          type: "choice",
          choice: "minor_revision",
          confidence: 0.9,
          probabilities: { minor_revision: 0.9, approved: 0.1 },
        },
        revision_target: {
          type: "choice",
          choice: "prompts",
          confidence: 0.7,
          probabilities: { prompts: 0.7, visual_plan: 0.3 },
        },
        scene_1: {
          type: "choice",
          choice: "pass",
          confidence: 0.95,
          probabilities: { pass: 0.95, revise: 0.05 },
        },
        scene_2: {
          type: "choice",
          choice: "revise",
          confidence: 0.8,
          probabilities: { pass: 0.2, revise: 0.8 },
        },
      }),
    );
    expect(prediction.status).toBe("minor_revision");
    expect(prediction.statusConfidence).toBe(0.9);
    // gate confidence floors on the weakest key question (revision_target)
    expect(prediction.confidence).toBeCloseTo(0.7);
    expect(prediction.revisionTarget).toBe("prompts");
    expect(prediction.sceneVerdicts).toEqual({ 1: "pass", 2: "revise" });
  });

  it("maps researchqa fact answers and keeps status-only confidence", () => {
    const prediction = answersToPrediction(
      "researchqa",
      result({
        status: {
          type: "choice",
          choice: "approved",
          confidence: 0.99,
          probabilities: { approved: 0.99, fail: 0.01 },
        },
        "fact_fact-001": {
          type: "choice",
          choice: "keep",
          confidence: 0.6,
          probabilities: { keep: 0.6, remove: 0.4 },
        },
      }),
    );
    expect(prediction.status).toBe("approved");
    expect(prediction.confidence).toBeCloseTo(0.99);
    expect(prediction.factVerdicts).toEqual({ "fact-001": "keep" });
  });

  it("supports binary releasereview status", () => {
    const prediction = answersToPrediction(
      "releasereview",
      result({
        status: {
          type: "choice",
          choice: "fatal",
          confidence: 0.88,
          probabilities: { approved: 0.12, fatal: 0.88 },
        },
      }),
    );
    expect(prediction.status).toBe("fatal");
    expect(isApprovedStatus(prediction.status)).toBe(false);
  });
});
