import { config } from "../utils/config.js";
import { TYPESAFE_PROVIDER, createTypeSafeClassifier } from "./type-safe.js";
import type { ClassifierFactory, CreateClassifierOptions } from "./types.js";

type Gate = Parameters<typeof config.classifierEnabledFor>[0];

/**
 * True when the classifier layer is active for a QA gate: the global
 * CLASSIFIER_PROVIDER master switch must be on AND the per-gate flag must not
 * be explicitly disabled. Defaults are off — existing LLM behavior is
 * untouched until CLASSIFIER_PROVIDER is set.
 */
export function classifierEnabledFor(gate: Gate): boolean {
  return config.classifierEnabledFor(gate);
}

/**
 * Default classifier factory, selected by CLASSIFIER_PROVIDER. Nodes resolve
 * `inject.createClassifier ?? defaultCreateClassifier` so tests can inject a
 * fake without jest.mock, mirroring the createModel seam in run-agent.
 */
export const defaultCreateClassifier: ClassifierFactory = (
  options: CreateClassifierOptions = {},
) => {
  const provider = config.classifierProvider();
  if (provider === TYPESAFE_PROVIDER) {
    return createTypeSafeClassifier(options);
  }
  throw new Error(
    `CLASSIFIER_PROVIDER is "${provider}" — no classifier backend available. Set CLASSIFIER_PROVIDER=typesafe with TYPESAFE_API_KEY.`,
  );
};
