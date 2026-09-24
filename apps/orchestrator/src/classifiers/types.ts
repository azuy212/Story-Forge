import type { RunLogSink } from "../utils/run-log.js";

/**
 * Provider-agnostic classifier contract for bounded QA decisions.
 *
 * A classifier evaluates typed questions against a state and returns typed
 * answers with confidence — it never generates prose. Nodes depend on this
 * interface only; the concrete backend (TypeSafe/Jev today, others later) is
 * chosen by factory and injected via RunnableConfig.configurable, parallel to
 * how createModel is injected for generative LLM calls.
 */

export type QuestionSpec =
  | {
      type: "choice";
      instructions: string;
      /** Option label → description shown to the model. */
      options: Record<string, string>;
    }
  | {
      type: "noul";
      instructions: string;
      criteria?: { true?: string; false?: string };
    }
  | {
      type: "score";
      instructions: string;
      /** Ordered rubric levels, at least two. */
      levels: [string, string, ...string[]];
    };

export type ClassificationRequest = {
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, QuestionSpec>;
  /** Optional model override (provider-specific identifier). */
  model?: string;
};

export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};

export type NoulAnswer = {
  type: "noul";
  noul: number;
};

export type ScoreAnswer = {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
};

export type Answer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

export type ClassificationUsage = {
  inputTokens: number;
  outputTokens: number;
};

export type ClassificationResult = {
  answers: Record<string, Answer>;
  provider: string;
  model: string;
  usage: ClassificationUsage;
  durationMs: number;
};

export type ClassifierGate =
  "promptqa" | "researchqa" | "releasereview" | "scriptqa";

export type CreateClassifierOptions = {
  runLogSink?: RunLogSink | null;
  runId?: string;
  /** Node/agent name for run-log context. */
  agent?: string;
  /**
   * Test seam: inject a client exposing systemOne() instead of constructing
   * the real TypeSafeClient. Mirrors createModel's `client` option.
   */
  client?: SystemOneClient;
};

export interface Classifier {
  readonly provider: string;
  readonly model: string;
  classify(request: ClassificationRequest): Promise<ClassificationResult>;
}

export type ClassifierFactory = (
  options?: CreateClassifierOptions,
) => Classifier;

/**
 * Minimal structural view of a System One client's request/response so the
 * adapter can be tested without the real SDK client.
 */
export type SystemOneRequest = {
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, unknown>;
  model?: string;
};

export type SystemOneResponse = {
  model: string;
  answers: Record<string, unknown>;
  usage?: { input_tokens?: number; output_tokens?: number };
};

export interface SystemOneClient {
  systemOne(request: SystemOneRequest): Promise<SystemOneResponse>;
}
