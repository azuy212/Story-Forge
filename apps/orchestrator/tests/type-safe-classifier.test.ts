import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import { createTypeSafeClassifier } from "../src/classifiers/type-safe.js";
import { defaultCreateClassifier } from "../src/classifiers/factory.js";
import { classifierEnabledFor } from "../src/classifiers/factory.js";
import { choiceAnswer, noulAnswer } from "../src/classifiers/answers.js";
import type {
  ClassificationRequest,
  SystemOneClient,
  SystemOneRequest,
  SystemOneResponse,
} from "../src/classifiers/types.js";
import type { RunLogSink, RunLogEventInput } from "../src/utils/run-log.js";

function fakeClient(
  respond: (request: SystemOneRequest) => SystemOneResponse,
): SystemOneClient & { calls: SystemOneRequest[] } {
  const calls: SystemOneRequest[] = [];
  return {
    calls,
    systemOne(request) {
      calls.push(request);
      return Promise.resolve(respond(request));
    },
  };
}

function recordingSink(): { sink: RunLogSink; events: RunLogEventInput[] } {
  const events: RunLogEventInput[] = [];
  const sink = {
    runId: "run-1",
    filePath: "runs/x/run.log",
    appendLine: (event: RunLogEventInput) => {
      events.push(event);
      return Promise.resolve();
    },
    flush: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  return { sink, events };
}

const ENV_KEYS = [
  "CLASSIFIER_PROVIDER",
  "CLASSIFIER_PROMPTQA",
  "TYPESAFE_API_KEY",
  "TYPESAFE_DEFAULT_MODEL",
];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("createTypeSafeClassifier", () => {
  it("maps question specs to SDK shapes and answers back to typed results", async () => {
    const client = fakeClient(() => ({
      model: "jev-test",
      answers: {
        status: {
          type: "choice",
          choice: "approved",
          confidence: 0.97,
          probabilities: { approved: 0.97, fatal: 0.03 },
        },
        usable: { type: "noul", noul: 0.88 },
        quality: {
          type: "score",
          score: 2,
          confidence: 0.8,
          probabilities: { "0": 0, "1": 0.2, "2": 0.8 },
        },
      },
      usage: { input_tokens: 50, output_tokens: 0 },
    }));

    const classifier = createTypeSafeClassifier({ client });
    const request: ClassificationRequest = {
      state: { title: "demo" },
      questions: {
        status: {
          type: "choice",
          instructions: "What is the verdict?",
          options: {
            approved: "Everything checks out.",
            fatal: "Blocking defect.",
          },
        },
        usable: {
          type: "noul",
          instructions: "Is the research usable?",
          criteria: { true: "usable", false: "unusable" },
        },
        quality: {
          type: "score",
          instructions: "Rate quality",
          levels: ["poor", "ok", "great"],
        },
      },
    };

    const result = await classifier.classify(request);

    expect(classifier.provider).toBe("typesafe");
    expect(result.provider).toBe("typesafe");
    expect(result.model).toBe("jev-test");
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 0 });
    expect(choiceAnswer(result, "status").choice).toBe("approved");
    expect(choiceAnswer(result, "status").confidence).toBe(0.97);
    expect(noulAnswer(result, "usable").noul).toBe(0.88);
    expect(result.answers.quality).toMatchObject({ type: "score", score: 2 });

    expect(client.calls).toHaveLength(1);
    const sent = client.calls[0];
    expect(sent.state).toEqual({ title: "demo" });
    const questions = sent.questions as Record<
      string,
      { type: string; criteria?: unknown }
    >;
    expect(questions.status.type).toBe("choice");
    expect(questions.usable.type).toBe("noul");
    expect(questions.quality.type).toBe("score");
  });

  it("appends a classifier run-log event with answers and usage", async () => {
    const client = fakeClient(() => ({
      model: "jev-test",
      answers: {
        verdict: {
          type: "choice",
          choice: "fatal",
          confidence: 0.9,
          probabilities: { approved: 0.1, fatal: 0.9 },
        },
      },
      usage: { input_tokens: 7, output_tokens: 0 },
    }));
    const { sink, events } = recordingSink();

    const classifier = createTypeSafeClassifier({
      client,
      runLogSink: sink,
      agent: "ReleaseReview",
      runId: "run-1",
    });
    await classifier.classify({
      state: "some state",
      questions: {
        verdict: {
          type: "choice",
          instructions: "approve or reject",
          options: { approved: "ok", fatal: "bad" },
        },
      },
    });

    expect(events).toHaveLength(1);
    const event = events[0] as Record<string, unknown>;
    expect(event.event).toBe("classifier");
    expect(event.agent).toBe("ReleaseReview");
    expect(event.provider).toBe("typesafe");
    expect(event.questionCount).toBe(1);
    expect(event.answers).toEqual({
      verdict: { choice: "fatal", confidence: 0.9 },
    });
    expect(event.usage).toEqual({ inputTokens: 7, outputTokens: 0 });
  });

  it("rejects empty question sets before calling the client", async () => {
    const client = fakeClient(() => {
      throw new Error("should not be called");
    });
    const classifier = createTypeSafeClassifier({ client });
    await expect(
      classifier.classify({ state: "x", questions: {} }),
    ).rejects.toThrow("no questions");
    expect(client.calls).toHaveLength(0);
  });

  it("logs a classifier failure event and rethrows", async () => {
    const failing: SystemOneClient = {
      systemOne: () => Promise.reject(new Error("rate limited")),
    };
    const { sink, events } = recordingSink();
    const classifier = createTypeSafeClassifier({
      client: failing,
      runLogSink: sink,
      agent: "PromptQA",
    });

    await expect(
      classifier.classify({
        state: "x",
        questions: {
          status: {
            type: "choice",
            instructions: "verdict",
            options: { a: "a", b: "b" },
          },
        },
      }),
    ).rejects.toThrow("rate limited");

    expect(events).toHaveLength(1);
    const event = events[0] as Record<string, unknown>;
    expect(event.event).toBe("classifier");
    expect(event.error).toMatchObject({ message: "rate limited" });
  });

  it("throws a clear error when TYPESAFE_API_KEY is missing and no client is injected", () => {
    expect(() => createTypeSafeClassifier()).toThrow("TYPESAFE_API_KEY");
  });
});

describe("defaultCreateClassifier / classifierEnabledFor", () => {
  it("is disabled by default (provider off)", () => {
    expect(classifierEnabledFor("promptqa")).toBe(false);
    expect(() => defaultCreateClassifier()).toThrow(
      "no classifier backend available",
    );
  });

  it("builds a TypeSafe classifier when the provider is on and a key exists", () => {
    process.env.CLASSIFIER_PROVIDER = "typesafe";
    process.env.TYPESAFE_API_KEY = "sk-test";
    expect(classifierEnabledFor("promptqa")).toBe(true);
    const client = fakeClient(() => ({
      model: "jev-latest",
      answers: {},
      usage: { input_tokens: 0, output_tokens: 0 },
    }));
    // Injected client exercises the same factory selection path used by nodes
    // once CLASSIFIER_PROVIDER is set (real path constructs TypeSafeClient).
    const classifier = defaultCreateClassifier({ client });
    expect(classifier.provider).toBe("typesafe");
  });

  it("throws without an API key when provider is typesafe", () => {
    process.env.CLASSIFIER_PROVIDER = "typesafe";
    expect(() => defaultCreateClassifier()).toThrow("TYPESAFE_API_KEY");
  });
});
