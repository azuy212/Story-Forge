import { describe, it, expect } from "@jest/globals";
import {
  calibrationBuckets,
  computeGateMetrics,
  formatMetricsSummary,
  toEvalPair,
} from "../src/eval/metrics.js";
import type { EvalPair } from "../src/eval/types.js";

function pair(
  overrides: Partial<EvalPair> & {
    referenceStatus: string;
    predictedStatus: string;
    confidence: number;
  },
): EvalPair {
  return toEvalPair(
    overrides.caseId ?? "case",
    overrides.gate ?? "scriptqa",
    overrides.referenceStatus,
    {
      status: overrides.predictedStatus,
      confidence: overrides.confidence,
      durationMs: overrides.durationMs,
    },
  );
}

describe("toEvalPair", () => {
  it("flags correct status match and binary approval", () => {
    const approved = pair({
      referenceStatus: "approved",
      predictedStatus: "approved",
      confidence: 0.9,
    });
    expect(approved.correct).toBe(true);
    expect(approved.referenceApproved).toBe(true);
    expect(approved.predictedApproved).toBe(true);

    const falseApproval = pair({
      referenceStatus: "major_revision",
      predictedStatus: "approved",
      confidence: 0.95,
    });
    expect(falseApproval.correct).toBe(false);
    expect(falseApproval.referenceApproved).toBe(false);
    expect(falseApproval.predictedApproved).toBe(true);
  });
});

describe("computeGateMetrics", () => {
  const pairs: EvalPair[] = [
    // correct approvals
    pair({
      caseId: "a1",
      referenceStatus: "approved",
      predictedStatus: "approved",
      confidence: 0.95,
      durationMs: 100,
    }),
    pair({
      caseId: "a2",
      referenceStatus: "approved",
      predictedStatus: "approved",
      confidence: 0.88,
      durationMs: 300,
    }),
    // correct rejection
    pair({
      caseId: "r1",
      referenceStatus: "fatal",
      predictedStatus: "fatal",
      confidence: 0.92,
      durationMs: 200,
    }),
    // false approval (dangerous)
    pair({
      caseId: "fa1",
      referenceStatus: "minor_revision",
      predictedStatus: "approved",
      confidence: 0.7,
      durationMs: 150,
    }),
    // false rejection
    pair({
      caseId: "fr1",
      referenceStatus: "approved",
      predictedStatus: "major_revision",
      confidence: 0.6,
      durationMs: 180,
    }),
    // low-confidence wrong
    pair({
      caseId: "w1",
      referenceStatus: "approved",
      predictedStatus: "minor_revision",
      confidence: 0.55,
      durationMs: 120,
    }),
  ];

  it("computes accuracy, false rates, mean confidence, mean duration", () => {
    const metrics = computeGateMetrics(pairs);
    expect(metrics.n).toBe(6);
    // correct: a1, a2, r1 → 3/6
    expect(metrics.accuracy).toBeCloseTo(0.5);
    // false approvals: fa1 (1) / referenceRejected (r1, fa1 → 2)
    expect(metrics.falseApprovalRate).toBeCloseTo(0.5);
    // false rejections: fr1 + w1 (approved refs predicted non-approved) / referenceApproved (a1,a2,fr1,w1 → 4)
    expect(metrics.falseRejectionRate).toBeCloseTo(0.5);
    expect(metrics.meanConfidence).toBeCloseTo(
      (0.95 + 0.88 + 0.92 + 0.7 + 0.6 + 0.55) / 6,
    );
    expect(metrics.meanDurationMs).toBeCloseTo(
      (100 + 300 + 200 + 150 + 180 + 120) / 6,
    );
  });

  it("threshold sweep isolates high-confidence subset", () => {
    const metrics = computeGateMetrics(pairs, { thresholds: [0.9] });
    const row = metrics.thresholdSweep[0];
    expect(row.threshold).toBe(0.9);
    // accepted: a1 (0.95), r1 (0.92) — a2 is 0.88
    expect(row.accepted).toBe(2);
    expect(row.abstained).toBe(4);
    expect(row.coverage).toBeCloseTo(2 / 6);
    expect(row.accuracyAmongAccepted).toBeCloseTo(1);
    expect(row.falseApprovalRateAmongAccepted).toBe(0);
  });

  it("empty pair set yields zeroed metrics without NaN", () => {
    const metrics = computeGateMetrics([]);
    expect(metrics.n).toBe(0);
    expect(metrics.accuracy).toBe(0);
    expect(metrics.falseApprovalRate).toBe(0);
    expect(metrics.meanConfidence).toBe(0);
    expect(metrics.meanDurationMs).toBeUndefined();
  });

  it("handles all-approved references (false rejection undefined → 0)", () => {
    const allApproved = [
      pair({
        referenceStatus: "approved",
        predictedStatus: "approved",
        confidence: 0.9,
      }),
      pair({
        referenceStatus: "approved",
        predictedStatus: "fatal",
        confidence: 0.9,
      }),
    ];
    const metrics = computeGateMetrics(allApproved);
    expect(metrics.falseApprovalRate).toBe(0);
    expect(metrics.falseRejectionRate).toBeCloseTo(0.5);
  });
});

describe("calibrationBuckets", () => {
  it("assigns confidence to buckets and computes per-bucket accuracy", () => {
    const pairs = [
      pair({
        referenceStatus: "approved",
        predictedStatus: "approved",
        confidence: 0.95,
      }),
      pair({
        referenceStatus: "approved",
        predictedStatus: "approved",
        confidence: 0.91,
      }),
      pair({
        referenceStatus: "fatal",
        predictedStatus: "fatal",
        confidence: 0.75,
      }),
      pair({
        referenceStatus: "approved",
        predictedStatus: "fatal",
        confidence: 0.6,
      }),
      pair({
        referenceStatus: "approved",
        predictedStatus: "approved",
        confidence: 0.4,
      }),
    ];
    const buckets = calibrationBuckets(pairs);
    const byLabel = Object.fromEntries(buckets.map((b) => [b.label, b]));
    expect(byLabel["[0.9,1.0]"].count).toBe(2);
    expect(byLabel["[0.9,1.0]"].accuracy).toBe(1);
    expect(byLabel["[0.7,0.8)"].count).toBe(1);
    expect(byLabel["[0.7,0.8)"].accuracy).toBe(1);
    expect(byLabel["[0.5,0.7)"].count).toBe(1);
    expect(byLabel["[0.5,0.7)"].accuracy).toBe(0);
    expect(byLabel["[0.0,0.5)"].count).toBe(1);
    expect(byLabel["[0.0,0.5)"].accuracy).toBe(1);
  });

  it("confidence of exactly 1 lands in the last bucket", () => {
    const pairs = [
      pair({
        referenceStatus: "approved",
        predictedStatus: "approved",
        confidence: 1,
      }),
    ];
    const buckets = calibrationBuckets(pairs);
    const last = buckets[buckets.length - 1];
    expect(last.count).toBe(1);
    expect(last.accuracy).toBe(1);
  });
});

describe("formatMetricsSummary", () => {
  it("renders a non-empty multi-line summary", () => {
    const metrics = computeGateMetrics([
      pair({
        referenceStatus: "approved",
        predictedStatus: "approved",
        confidence: 0.9,
      }),
    ]);
    const text = formatMetricsSummary("scriptqa", metrics);
    expect(text).toContain("scriptqa: n=1");
    expect(text).toContain("thr>=0.90");
  });
});
