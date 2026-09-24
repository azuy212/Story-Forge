import type { EvalPair } from "./types.js";
import { isApprovedStatus } from "./gates.js";

export type ThresholdSweepRow = {
  threshold: number;
  coverage: number;
  accuracyAmongAccepted: number;
  falseApprovalRateAmongAccepted: number;
  falseRejectionRateAmongAccepted: number;
  accepted: number;
  abstained: number;
};

export type CalibrationBucket = {
  label: string;
  min: number;
  max: number;
  count: number;
  accuracy: number;
};

export type GateMetrics = {
  n: number;
  accuracy: number;
  falseApprovalRate: number;
  falseRejectionRate: number;
  meanConfidence: number;
  calibration: CalibrationBucket[];
  thresholdSweep: ThresholdSweepRow[];
  meanDurationMs?: number;
};

export const DEFAULT_SWEEP_THRESHOLDS = [
  0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95,
] as const;

const DEFAULT_CALIBRATION_BUCKETS: Array<{
  label: string;
  min: number;
  max: number;
}> = [
  { label: "[0.0,0.5)", min: 0, max: 0.5 },
  { label: "[0.5,0.7)", min: 0.5, max: 0.7 },
  { label: "[0.7,0.8)", min: 0.7, max: 0.8 },
  { label: "[0.8,0.9)", min: 0.8, max: 0.9 },
  { label: "[0.9,1.0]", min: 0.9, max: 1.0 },
];

export function toEvalPair(
  caseId: string,
  gate: EvalPair["gate"],
  referenceStatus: string,
  prediction: { status: string; confidence: number; durationMs?: number },
): EvalPair {
  const referenceApproved = isApprovedStatus(referenceStatus);
  const predictedApproved = isApprovedStatus(prediction.status);
  return {
    caseId,
    gate,
    referenceStatus,
    predictedStatus: prediction.status,
    confidence: prediction.confidence,
    referenceApproved,
    predictedApproved,
    correct: referenceStatus === prediction.status,
    durationMs: prediction.durationMs,
  };
}

function safeRate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator;
}

function sweepRow(pairs: EvalPair[], threshold: number): ThresholdSweepRow {
  const accepted = pairs.filter((p) => p.confidence >= threshold);
  const abstained = pairs.length - accepted.length;
  const correct = accepted.filter((p) => p.correct).length;
  const falseApprovals = accepted.filter(
    (p) => p.predictedApproved && !p.referenceApproved,
  ).length;
  const predictedApproved = accepted.filter((p) => p.predictedApproved).length;
  const referenceApproved = accepted.filter((p) => p.referenceApproved).length;
  const falseRejections = accepted.filter(
    (p) => !p.predictedApproved && p.referenceApproved,
  ).length;

  return {
    threshold,
    coverage: safeRate(accepted.length, pairs.length),
    accuracyAmongAccepted: safeRate(correct, accepted.length),
    falseApprovalRateAmongAccepted: safeRate(falseApprovals, predictedApproved),
    falseRejectionRateAmongAccepted: safeRate(
      falseRejections,
      referenceApproved,
    ),
    accepted: accepted.length,
    abstained,
  };
}

export function calibrationBuckets(
  pairs: EvalPair[],
  definitions = DEFAULT_CALIBRATION_BUCKETS,
): CalibrationBucket[] {
  return definitions.map((def) => {
    const bucket = pairs.filter(
      (p) => p.confidence >= def.min && p.confidence < def.max,
    );
    // Fold the final upper bound into the last bucket so confidence === 1 lands.
    const isLast = def.max === 1;
    const inBucket = isLast
      ? pairs.filter((p) => p.confidence >= def.min && p.confidence <= def.max)
      : bucket;
    return {
      label: def.label,
      min: def.min,
      max: def.max,
      count: inBucket.length,
      accuracy: safeRate(
        inBucket.filter((p) => p.correct).length,
        inBucket.length,
      ),
    };
  });
}

export function computeGateMetrics(
  pairs: EvalPair[],
  options: { thresholds?: readonly number[] } = {},
): GateMetrics {
  const thresholds = options.thresholds ?? DEFAULT_SWEEP_THRESHOLDS;
  const n = pairs.length;
  const falseApprovals = pairs.filter(
    (p) => p.predictedApproved && !p.referenceApproved,
  ).length;
  const referenceRejected = pairs.filter((p) => !p.referenceApproved).length;
  const falseRejections = pairs.filter(
    (p) => !p.predictedApproved && p.referenceApproved,
  ).length;
  const referenceApproved = pairs.filter((p) => p.referenceApproved).length;

  const durations = pairs
    .map((p) => p.durationMs)
    .filter((d): d is number => typeof d === "number" && Number.isFinite(d));

  const metrics: GateMetrics = {
    n,
    accuracy: safeRate(pairs.filter((p) => p.correct).length, n),
    falseApprovalRate: safeRate(falseApprovals, referenceRejected),
    falseRejectionRate: safeRate(falseRejections, referenceApproved),
    meanConfidence: safeRate(
      pairs.reduce((sum, p) => sum + p.confidence, 0),
      n,
    ),
    calibration: calibrationBuckets(pairs),
    thresholdSweep: thresholds.map((threshold) => sweepRow(pairs, threshold)),
  };

  if (durations.length > 0) {
    metrics.meanDurationMs =
      durations.reduce((sum, d) => sum + d, 0) / durations.length;
  }

  return metrics;
}

export function formatMetricsSummary(
  gate: string,
  metrics: GateMetrics,
): string {
  const lines = [
    `${gate}: n=${metrics.n} accuracy=${(metrics.accuracy * 100).toFixed(1)}% ` +
      `falseApproval=${(metrics.falseApprovalRate * 100).toFixed(1)}% ` +
      `falseRejection=${(metrics.falseRejectionRate * 100).toFixed(1)}% ` +
      `meanConfidence=${metrics.meanConfidence.toFixed(3)}`,
  ];
  for (const row of metrics.thresholdSweep) {
    lines.push(
      `  thr>=${row.threshold.toFixed(2)} coverage=${(row.coverage * 100).toFixed(1)}% ` +
        `acc=${(row.accuracyAmongAccepted * 100).toFixed(1)}% ` +
        `far=${(row.falseApprovalRateAmongAccepted * 100).toFixed(1)}% ` +
        `frr=${(row.falseRejectionRateAmongAccepted * 100).toFixed(1)}% ` +
        `(accepted=${row.accepted}, abstained=${row.abstained})`,
    );
  }
  return lines.join("\n");
}
