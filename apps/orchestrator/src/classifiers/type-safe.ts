import { TypeSafeClient, choice, noul, score } from "@typesafe-ai/sdk";
import { appendRunLogEvent, type RunLogSink } from "../utils/run-log.js";
import { config as configUtils } from "../utils/config.js";
import type {
  Answer,
  ClassificationRequest,
  ClassificationResult,
  Classifier,
  CreateClassifierOptions,
  QuestionSpec,
  SystemOneClient,
  SystemOneRequest,
  SystemOneResponse,
} from "./types.js";

export const TYPESAFE_PROVIDER = "typesafe";

function toSdkQuestion(spec: QuestionSpec): unknown {
  switch (spec.type) {
    case "choice":
      return choice(spec.instructions, spec.options);
    case "noul":
      return noul(
        spec.instructions,
        spec.criteria
          ? { true: spec.criteria.true, false: spec.criteria.false }
          : undefined,
      );
    case "score":
      return score(spec.instructions, spec.levels);
  }
}

type SdkChoiceAnswer = {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
};

type SdkNoulAnswer = { type: "noul"; noul: number };

type SdkScoreAnswer = {
  type: "score";
  score: number;
  confidence: number;
  probabilities: Record<string, number>;
};

type SdkAnswer = SdkChoiceAnswer | SdkNoulAnswer | SdkScoreAnswer;

function fromSdkAnswer(raw: unknown): Answer {
  const answer = raw as SdkAnswer;
  switch (answer?.type) {
    case "choice":
      return {
        type: "choice",
        choice: String(answer.choice),
        confidence: Number(answer.confidence),
        probabilities: { ...answer.probabilities },
      };
    case "noul":
      return { type: "noul", noul: Number(answer.noul) };
    case "score":
      return {
        type: "score",
        score: Number(answer.score),
        confidence: Number(answer.confidence),
        probabilities: { ...answer.probabilities },
      };
    default:
      throw new Error(
        `Unrecognized classifier answer shape: ${JSON.stringify(raw)}`,
      );
  }
}

function normalizeAnswers(
  raw: Record<string, unknown>,
): Record<string, Answer> {
  const answers: Record<string, Answer> = {};
  for (const [name, value] of Object.entries(raw)) {
    answers[name] = fromSdkAnswer(value);
  }
  return answers;
}

function summarizeAnswers(
  answers: Record<string, Answer>,
): Record<string, unknown> {
  const summary: Record<string, unknown> = {};
  for (const [name, answer] of Object.entries(answers)) {
    if (answer.type === "choice") {
      summary[name] = { choice: answer.choice, confidence: answer.confidence };
    } else if (answer.type === "noul") {
      summary[name] = { noul: answer.noul };
    } else {
      summary[name] = { score: answer.score, confidence: answer.confidence };
    }
  }
  return summary;
}

function buildClient(options: CreateClassifierOptions): SystemOneClient {
  if (options.client) return options.client;
  const apiKey = configUtils.typesafeApiKey();
  if (!apiKey) {
    throw new Error(
      "TYPESAFE_API_KEY not set in environment. Add it to .env to use the typesafe classifier provider.",
    );
  }
  const real = new TypeSafeClient({ apiKey });
  return {
    systemOne(request) {
      return real.systemOne(request as Parameters<typeof real.systemOne>[0]);
    },
  };
}

export function createTypeSafeClassifier(
  options: CreateClassifierOptions = {},
): Classifier {
  const client = buildClient(options);
  const sink: RunLogSink | null = options.runLogSink ?? null;
  // Model is per-request (a gate may override); the classifier reports the
  // client default so telemetry has a stable label before the first call.
  const fallbackModel = configUtils.typesafeDefaultModel();

  return {
    provider: TYPESAFE_PROVIDER,
    model: fallbackModel,
    async classify(
      request: ClassificationRequest,
    ): Promise<ClassificationResult> {
      const questionNames = Object.keys(request.questions);
      if (questionNames.length === 0) {
        throw new Error("Classification request has no questions");
      }
      const sdkQuestions: Record<string, unknown> = {};
      for (const [name, spec] of Object.entries(request.questions)) {
        sdkQuestions[name] = toSdkQuestion(spec);
      }

      const startedAt = Date.now();
      const payload: SystemOneRequest = {
        state: request.state,
        questions: sdkQuestions,
        model: request.model,
      };

      try {
        const response: SystemOneResponse = await client.systemOne(payload);
        const durationMs = Date.now() - startedAt;
        const answers = normalizeAnswers(response.answers ?? {});
        const usage = {
          inputTokens: Number(response.usage?.input_tokens ?? 0),
          outputTokens: Number(response.usage?.output_tokens ?? 0),
        };
        const result: ClassificationResult = {
          answers,
          provider: TYPESAFE_PROVIDER,
          model: response.model ?? fallbackModel,
          usage,
          durationMs,
        };

        appendRunLogEvent(sink, {
          event: "classifier",
          agent: options.agent,
          runId: options.runId,
          provider: TYPESAFE_PROVIDER,
          model: result.model,
          questionCount: questionNames.length,
          questionNames,
          answers: summarizeAnswers(answers),
          stateBytes:
            typeof request.state === "string"
              ? Buffer.byteLength(request.state, "utf-8")
              : Buffer.byteLength(JSON.stringify(request.state), "utf-8"),
          usage,
          requestDurationMs: durationMs,
        });

        return result;
      } catch (err) {
        const durationMs = Date.now() - startedAt;
        appendRunLogEvent(sink, {
          event: "classifier",
          agent: options.agent,
          runId: options.runId,
          provider: TYPESAFE_PROVIDER,
          model: fallbackModel,
          questionCount: questionNames.length,
          questionNames,
          requestDurationMs: durationMs,
          error: {
            name: (err as Error)?.name,
            message: (err as Error)?.message ?? String(err),
          },
        });
        throw err;
      }
    },
  };
}
