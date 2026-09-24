import type { Classifier, ClassifierGate } from "../classifiers/types.js";
import { answersToPrediction, buildQuestions } from "./gates.js";
import { computeGateMetrics, toEvalPair } from "./metrics.js";
import type { GateMetrics } from "./metrics.js";
import type { EvalPair, QaEvalCase, QaPrediction } from "./types.js";

export type ReplayOutcome = {
  caseId: string;
  gate: ClassifierGate;
  prediction: QaPrediction;
  pair: EvalPair;
  error?: string;
};

export type ReplayReport = {
  outcomes: ReplayOutcome[];
  metricsByGate: Record<string, GateMetrics>;
  errors: number;
};

export async function replayCases(
  classifier: Classifier,
  cases: QaEvalCase[],
): Promise<ReplayReport> {
  const outcomes: ReplayOutcome[] = [];

  for (const qaCase of cases) {
    try {
      const questions = buildQuestions(qaCase.gate, qaCase);
      const result = await classifier.classify({
        state: qaCase.state,
        questions,
      });
      const prediction = answersToPrediction(qaCase.gate, result);
      const pair = toEvalPair(
        qaCase.id,
        qaCase.gate,
        qaCase.reference.status,
        prediction,
      );
      outcomes.push({ caseId: qaCase.id, gate: qaCase.gate, prediction, pair });
    } catch (err) {
      outcomes.push({
        caseId: qaCase.id,
        gate: qaCase.gate,
        prediction: { status: "error", confidence: 0, statusConfidence: 0 },
        pair: toEvalPair(qaCase.id, qaCase.gate, qaCase.reference.status, {
          status: "error",
          confidence: 0,
        }),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const metricsByGate: Record<string, GateMetrics> = {};
  const byGate = new Map<string, EvalPair[]>();
  for (const outcome of outcomes) {
    const list = byGate.get(outcome.gate) ?? [];
    list.push(outcome.pair);
    byGate.set(outcome.gate, list);
  }
  for (const [gate, pairs] of byGate) {
    metricsByGate[gate] = computeGateMetrics(pairs);
  }

  return {
    outcomes,
    metricsByGate,
    errors: outcomes.filter((o) => o.error !== undefined).length,
  };
}
