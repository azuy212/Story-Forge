import { describe, it, expect } from "@jest/globals";
import {
  decideQaRetry,
  hashIssues,
  isRunComplete,
  isRunFailed,
  runFailureReason,
} from "../src/utils/qa-policy.js";
import type { ProjectState } from "../src/types/index.js";

function decision(
  status: Parameters<typeof decideQaRetry>[0]["status"],
  overrides: Partial<Parameters<typeof decideQaRetry>[0]> = {},
) {
  return decideQaRetry({
    node: "TestQA",
    status,
    revisionAttempts: 0,
    qaAttempts: 0,
    infraMax: 2,
    ...overrides,
  });
}

describe("decideQaRetry", () => {
  it("continues on approved", () => {
    const d = decision("approved");
    expect(d.action).toBe("continue");
    expect(d.blocking).toBe(false);
  });

  it("revises minor within budget", () => {
    const d = decision("minor_revision", { revisionAttempts: 1 });
    expect(d.action).toBe("revise");
    expect(d.maxRevisionAttempts).toBe(1);
  });

  it("accepts minor when budget exhausted (producer ran 2x)", () => {
    const d = decision("minor_revision", { revisionAttempts: 2 });
    expect(d.action).toBe("continue");
  });

  it("accepts minor immediately when feedback repeats", () => {
    const d = decision("minor_revision", {
      revisionAttempts: 1,
      repeated: true,
    });
    expect(d.action).toBe("continue");
  });

  it("revises major within budget", () => {
    const d = decision("major_revision", { revisionAttempts: 1 });
    expect(d.action).toBe("revise");
    expect(d.maxRevisionAttempts).toBe(2);
    expect(d.blocking).toBe(true);
  });

  it("fails major when budget exhausted (producer ran 3x)", () => {
    const d = decision("major_revision", { revisionAttempts: 3 });
    expect(d.action).toBe("fail");
  });

  it("fails major immediately when feedback repeats", () => {
    const d = decision("major_revision", {
      revisionAttempts: 1,
      repeated: true,
    });
    expect(d.action).toBe("fail");
  });

  it("revises fail within budget, then fails after max", () => {
    expect(decision("fail", { revisionAttempts: 1 }).action).toBe("revise");
    expect(decision("fail", { revisionAttempts: 3 }).action).toBe("fail");
  });

  it("revises fatal within budget, then fails after max", () => {
    expect(decision("fatal", { revisionAttempts: 2 }).action).toBe("revise");
    expect(decision("fatal", { revisionAttempts: 3 }).action).toBe("fail");
  });

  it("retries the QA node within infra budget", () => {
    const d = decision("retry", { qaAttempts: 1, infraMax: 2 });
    expect(d.action).toBe("retry");
  });

  it("fails when QA infra budget exhausted", () => {
    const d = decision("retry", { qaAttempts: 2, infraMax: 2 });
    expect(d.action).toBe("fail");
    expect(d.blocking).toBe(true);
  });

  it("fails closed on missing or unhandled status", () => {
    expect(decision(undefined).action).toBe("fail");
  });
});

describe("hashIssues", () => {
  it("produces a stable hash for the same feedback", () => {
    expect(hashIssues(["a", "b"], "fb")).toBe(hashIssues(["a", "b"], "fb"));
    expect(hashIssues(["a", "b"], "fb")).not.toBe(hashIssues(["a", "c"], "fb"));
  });
});

function state(patch: Partial<ProjectState>): ProjectState {
  return {
    project: { pillar: "P", topic: "T" },
    branding: { channel: "C", creator: "", cta: "", platforms: ["youtube"] },
    publishing: { results: [] },
    execution: { version: "0.1.0" },
    ...patch,
  } as ProjectState;
}

describe("isRunComplete / isRunFailed", () => {
  it("a run with a publish result is complete", () => {
    const s = state({
      publishing: {
        results: [
          {
            platform: "youtube",
            platformVideoId: "v",
            url: "",
            status: "published",
            publishedAt: "t",
          },
        ],
      },
    });
    expect(isRunComplete(s)).toBe(true);
    expect(isRunFailed(s)).toBe(false);
  });

  it("an unpublished run is failed", () => {
    expect(isRunFailed(state({}))).toBe(true);
  });

  it("no platforms means failed (nothing to publish, can't complete)", () => {
    const s = state({
      branding: { channel: "C", creator: "", cta: "", platforms: [] },
    });
    expect(isRunComplete(s)).toBe(false);
  });

  it("a blocked publish gate with no publish result is failed", () => {
    const s = state({ publishReady: { status: "blocked", issues: ["creds"] } });
    expect(isRunFailed(s)).toBe(true);
  });

  it("QA fail verdict with no publish result is failed", () => {
    const s = state({ researchQA: { status: "fail", factVerdicts: [] } });
    expect(isRunFailed(s)).toBe(true);
  });
});

describe("runFailureReason", () => {
  it("names the failing QA node", () => {
    expect(
      runFailureReason(state({ scriptQA: { status: "fatal", issues: [] } })),
    ).toBe("script QA failed");
  });

  it("names a blocked publish gate with its issues", () => {
    expect(
      runFailureReason(
        state({
          publishReady: { status: "blocked", issues: ["missing creds"] },
        }),
      ),
    ).toBe("publish gate blocked: missing creds");
  });

  it("falls back to a generic reason", () => {
    expect(runFailureReason(state({}))).toBe(
      "pipeline terminated before publishing",
    );
  });
});
