import type { NodeTelemetry } from "../schemas/diagnostics.js";
import type { RunLogSink } from "../utils/run-log.js";
import { config as configUtils } from "../utils/config.js";
import { logger } from "../utils/logger.js";
import { classifierEnabledFor, defaultCreateClassifier } from "./factory.js";
import { classificationTelemetry } from "./telemetry.js";
import type {
  Classifier,
  ClassifierGate,
  CreateClassifierOptions,
} from "./types.js";
import type { QaPrediction } from "../eval/types.js";
import { answersToPrediction, buildQuestions } from "../eval/gates.js";

export type QaGateInject = {
  createClassifier?: typeof defaultCreateClassifier;
  runLogSink?: RunLogSink | null;
  runId?: string;
};

export type TrustedClassification = {
  prediction: QaPrediction;
  telemetry: NodeTelemetry;
};

/**
 * Run the classifier for a QA gate when the gate is enabled.
 *
 * Returns:
 * - `trusted` — confidence met the per-gate floor; use the verdict.
 * - `abstain` — gate off, low confidence, or classifier error; caller falls
 *   through to the existing LLM path.
 *
 * Never throws: classifier failures are logged and treated as abstain so a
 * missing key or network error cannot block the pipeline.
 */
export async function tryClassifyQaGate(
  gate: ClassifierGate,
  input: {
    state: string | Record<string, unknown> | unknown[];
    sceneIds?: number[];
    factIds?: string[];
    agent: string;
    inject?: QaGateInject;
    promptVersion?: string;
  },
): Promise<TrustedClassification | null> {
  if (!classifierEnabledFor(gate)) return null;

  const inject = input.inject ?? {};
  const createClassifier = inject.createClassifier ?? defaultCreateClassifier;
  const floor = configUtils.classifierConfidenceMin(gate);
  const createOptions: CreateClassifierOptions = {
    agent: input.agent,
    runId: inject.runId,
    runLogSink: inject.runLogSink ?? null,
  };

  let classifier: Classifier;
  try {
    classifier = createClassifier(createOptions);
  } catch (err) {
    logger.debug(`Classifier ${gate} unavailable, using LLM path`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  try {
    const questions = buildQuestions(gate, {
      sceneIds: input.sceneIds,
      factIds: input.factIds,
    });
    const result = await classifier.classify({
      state: input.state,
      questions,
    });
    const prediction = answersToPrediction(gate, result);
    const telemetry = classificationTelemetry(result, {
      promptVersion: input.promptVersion,
    });

    if (prediction.confidence < floor) {
      logger.debug(`Classifier ${gate} below confidence floor, using LLM`, {
        confidence: prediction.confidence,
        floor,
        status: prediction.status,
        model: result.model,
      });
      return null;
    }

    logger.debug(`Classifier ${gate} trusted`, {
      status: prediction.status,
      confidence: prediction.confidence,
      model: result.model,
    });
    return { prediction, telemetry };
  } catch (err) {
    logger.debug(`Classifier ${gate} failed, using LLM path`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
