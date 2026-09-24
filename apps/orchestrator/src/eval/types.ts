import type { ClassifierGate } from "../classifiers/types.js";

export type QaReference = {
  status: string;
  revisionTarget?: string;
  sceneVerdicts?: Record<number, string>;
  factVerdicts?: Record<string, string>;
  issues?: string[];
  feedback?: string;
};

export type QaReferenceMeta = {
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
};

export type QaEvalCase = {
  id: string;
  gate: ClassifierGate;
  ns: string;
  state: string;
  reference: QaReference;
  referenceMeta?: QaReferenceMeta;
  sceneIds?: number[];
  factIds?: string[];
  topic?: string;
};

export type QaPrediction = {
  status: string;
  confidence: number;
  statusConfidence: number;
  revisionTarget?: string;
  sceneVerdicts?: Record<number, string>;
  factVerdicts?: Record<string, string>;
  provider?: string;
  model?: string;
  durationMs?: number;
};

export type EvalPair = {
  caseId: string;
  gate: ClassifierGate;
  referenceStatus: string;
  predictedStatus: string;
  confidence: number;
  referenceApproved: boolean;
  predictedApproved: boolean;
  correct: boolean;
  durationMs?: number;
};
