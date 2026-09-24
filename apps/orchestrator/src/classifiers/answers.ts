import type {
  Answer,
  ChoiceAnswer,
  ClassificationResult,
  NoulAnswer,
  ScoreAnswer,
} from "./types.js";

function answerOrThrow(result: ClassificationResult, name: string): Answer {
  const answer = result.answers[name];
  if (!answer) {
    throw new Error(
      `Classifier response missing answer for question "${name}"`,
    );
  }
  return answer;
}

export function choiceAnswer(
  result: ClassificationResult,
  name: string,
): ChoiceAnswer {
  const answer = answerOrThrow(result, name);
  if (answer.type !== "choice") {
    throw new Error(
      `Classifier answer "${name}" is ${answer.type}, expected choice`,
    );
  }
  return answer;
}

export function noulAnswer(
  result: ClassificationResult,
  name: string,
): NoulAnswer {
  const answer = answerOrThrow(result, name);
  if (answer.type !== "noul") {
    throw new Error(
      `Classifier answer "${name}" is ${answer.type}, expected noul`,
    );
  }
  return answer;
}

export function scoreAnswer(
  result: ClassificationResult,
  name: string,
): ScoreAnswer {
  const answer = answerOrThrow(result, name);
  if (answer.type !== "score") {
    throw new Error(
      `Classifier answer "${name}" is ${answer.type}, expected score`,
    );
  }
  return answer;
}

/**
 * Lowest confidence across the named choice/score answers. Noul answers are
 * skipped (their probability is the answer, not a confidence report). Returns
 * 1 when none of the named answers carry a confidence — gates treat that as
 * fully confident so pure-noul question sets do not abstain by accident.
 */
export function minConfidence(
  result: ClassificationResult,
  names: string[],
): number {
  let min = 1;
  let seen = false;
  for (const name of names) {
    const answer = result.answers[name];
    if (!answer) continue;
    if (answer.type === "choice" || answer.type === "score") {
      if (!seen || answer.confidence < min) min = answer.confidence;
      seen = true;
    }
  }
  return min;
}
