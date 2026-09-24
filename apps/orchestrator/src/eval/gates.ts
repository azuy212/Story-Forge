import type {
  ClassificationResult,
  ClassifierGate,
  QuestionSpec,
} from "../classifiers/types.js";
import { choiceAnswer, minConfidence } from "../classifiers/answers.js";
import type { QaEvalCase, QaPrediction, QaReference } from "./types.js";

export const GATE_STATUS_OPTIONS: Record<
  ClassifierGate,
  Record<string, string>
> = {
  promptqa: {
    approved: "Every scene prompt is usable as-is.",
    minor_revision: "Mostly usable; a few scenes need targeted prompt fixes.",
    major_revision: "Systemic prompt problems across scenes; rework required.",
    fatal: "Prompts are unusable; the visual plan cannot deliver.",
  },
  researchqa: {
    approved: "Facts are accurate, well-classified, and usable.",
    minor_revision: "Minor fact issues; targeted fixes or reclassification.",
    major_revision: "Significant accuracy or classification problems.",
    fail: "Research is unusable for script generation.",
  },
  scriptqa: {
    approved: "Script meets quality, contract, and audience requirements.",
    minor_revision: "Minor script issues within revision budget.",
    major_revision: "Major script problems; structural revision required.",
    fatal: "Script is unusable.",
  },
  releasereview: {
    approved: "Release package is complete and publishable.",
    fatal: "Release package must not be published.",
  },
};

const REVISION_TARGET_OPTIONS: Record<string, string> = {
  prompts: "Regenerate scene generation prompts only.",
  visual_plan: "Re-plan the visual plan (and regenerate dependent prompts).",
  both: "Re-plan visuals and regenerate prompts.",
  none: "No revision target; status is approved or fatal without rework.",
};

const SCENE_VERDICT_OPTIONS: Record<string, string> = {
  pass: "This scene's generation prompt is usable as-is.",
  revise: "This scene's generation prompt needs revision.",
};

const FACT_VERDICT_OPTIONS: Record<string, string> = {
  keep: "Fact is accurate and correctly classified.",
  revise: "Fact is salvageable with a targeted correction.",
  remove: "Fact is wrong or unusable; drop it.",
};

function statusQuestion(gate: ClassifierGate): QuestionSpec {
  return {
    type: "choice",
    instructions:
      "Return the overall QA verdict for this review material under the gate's rubric.",
    options: GATE_STATUS_OPTIONS[gate],
  };
}

export function buildQuestions(
  gate: ClassifierGate,
  input: Pick<QaEvalCase, "sceneIds" | "factIds">,
): Record<string, QuestionSpec> {
  const questions: Record<string, QuestionSpec> = {
    status: statusQuestion(gate),
  };

  if (gate === "promptqa") {
    questions.revision_target = {
      type: "choice",
      instructions:
        "If a revision is needed, name the root-cause target the producer should fix first.",
      options: REVISION_TARGET_OPTIONS,
    };
    for (const sceneId of input.sceneIds ?? []) {
      questions[`scene_${sceneId}`] = {
        type: "choice",
        instructions: `Verdict for scene ${sceneId}'s generation prompt.`,
        options: SCENE_VERDICT_OPTIONS,
      };
    }
  }

  if (gate === "researchqa") {
    for (const factId of input.factIds ?? []) {
      questions[`fact_${factId}`] = {
        type: "choice",
        instructions: `Verdict for research fact "${factId}".`,
        options: FACT_VERDICT_OPTIONS,
      };
    }
  }

  return questions;
}

export function extractReference(
  gate: ClassifierGate,
  data: Record<string, unknown>,
): QaReference | null {
  const status = typeof data.status === "string" ? data.status : undefined;
  if (!status || status === "retry") return null;

  const reference: QaReference = { status };

  if (typeof data.revisionTarget === "string") {
    reference.revisionTarget = data.revisionTarget;
  }
  if (typeof data.feedback === "string") reference.feedback = data.feedback;
  if (typeof data.globalFeedback === "string") {
    reference.feedback = data.globalFeedback;
  }
  if (Array.isArray(data.issues)) {
    reference.issues = data.issues.filter(
      (issue): issue is string => typeof issue === "string",
    );
  }

  if (gate === "promptqa" && Array.isArray(data.sceneResults)) {
    const verdicts: Record<number, string> = {};
    for (const entry of data.sceneResults) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { sceneId?: unknown }).sceneId === "number" &&
        typeof (entry as { verdict?: unknown }).verdict === "string"
      ) {
        const { sceneId, verdict } = entry as {
          sceneId: number;
          verdict: string;
        };
        verdicts[sceneId] = verdict;
      }
    }
    if (Object.keys(verdicts).length > 0) reference.sceneVerdicts = verdicts;
  }

  if (gate === "researchqa" && Array.isArray(data.factVerdicts)) {
    const verdicts: Record<string, string> = {};
    for (const entry of data.factVerdicts) {
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { factId?: unknown }).factId === "string" &&
        typeof (entry as { verdict?: unknown }).verdict === "string"
      ) {
        const { factId, verdict } = entry as {
          factId: string;
          verdict: string;
        };
        verdicts[factId] = verdict;
      }
    }
    if (Object.keys(verdicts).length > 0) reference.factVerdicts = verdicts;
  }

  return reference;
}

const STATUS_QUESTION_NAMES = ["status"];

function confidenceQuestionNames(gate: ClassifierGate): string[] {
  if (gate === "promptqa") return ["status", "revision_target"];
  return STATUS_QUESTION_NAMES;
}

export function answersToPrediction(
  gate: ClassifierGate,
  result: ClassificationResult,
): QaPrediction {
  const statusAnswer = choiceAnswer(result, "status");
  const confidence = minConfidence(result, confidenceQuestionNames(gate));

  const prediction: QaPrediction = {
    status: statusAnswer.choice,
    statusConfidence: statusAnswer.confidence,
    confidence,
    provider: result.provider,
    model: result.model,
    durationMs: result.durationMs,
  };

  if (gate === "promptqa") {
    const revision = result.answers.revision_target;
    if (revision && revision.type === "choice") {
      prediction.revisionTarget = revision.choice;
    }
    const sceneVerdicts: Record<number, string> = {};
    for (const [name, answer] of Object.entries(result.answers)) {
      if (!name.startsWith("scene_") || answer.type !== "choice") continue;
      const sceneId = Number(name.slice("scene_".length));
      if (Number.isInteger(sceneId)) sceneVerdicts[sceneId] = answer.choice;
    }
    if (Object.keys(sceneVerdicts).length > 0) {
      prediction.sceneVerdicts = sceneVerdicts;
    }
  }

  if (gate === "researchqa") {
    const factVerdicts: Record<string, string> = {};
    for (const [name, answer] of Object.entries(result.answers)) {
      if (!name.startsWith("fact_") || answer.type !== "choice") continue;
      factVerdicts[name.slice("fact_".length)] = answer.choice;
    }
    if (Object.keys(factVerdicts).length > 0) {
      prediction.factVerdicts = factVerdicts;
    }
  }

  return prediction;
}

export function isApprovedStatus(status: string): boolean {
  return status === "approved";
}

export function referenceStatusMatches(
  reference: QaReference,
  prediction: QaPrediction,
): boolean {
  return reference.status === prediction.status;
}
