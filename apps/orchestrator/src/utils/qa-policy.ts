import type { ProjectState } from "../types/index.js";
import { logger } from "./logger.js";
import { MINOR_REVISION_MAX, MAJOR_REVISION_MAX } from "./constants.js";
import { appendRunLogEvent } from "./run-log.js";
import { sanitizeForLog } from "./log-redaction.js";

/**
 * Single source of truth for the QA retry + pipeline continuation policy.
 *
 * Every QA router resolves through `decideQaRetry`, so all revision loops share
 * the same budgets and the same fallback semantics:
 *
 *   approved       -> continue
 *   minor_revision -> revise once, then accept the best result and continue
 *   major/fail     -> revise up to 2, then fail the run (blocking)
 *   retry          -> retry the cheap QA node (infra), then fail
 *
 * `repeated` feedback (the QA node produced the same verdict/issues as the
 * previous round) never overrides severity: repeated minor is accepted,
 * repeated major/fatal fails immediately — regenerating identical input would
 * just waste a generation. `unchangedArtifact` is the same principle applied
 * to the artifact: when the producer re-submitted a hash-identical artifact
 * while QA still rejects it, more regenerations cannot converge, so the loop
 * stops early. QA nodes persist the artifacts' hashes; the routers only pass
 * the resulting flag in.
 */

export type QaStatus =
  | "approved"
  | "minor_revision"
  | "major_revision"
  | "fail"
  | "fatal"
  | "retry"
  | undefined;

export type QaAction = "continue" | "revise" | "retry" | "fail";

export interface QaDecision {
  action: QaAction;
  reason: string;
  status: QaStatus;
  revisionAttempts: number;
  qaAttempts: number;
  maxRevisionAttempts: number;
  blocking: boolean;
  repeated: boolean;
  unchangedArtifact: boolean;
}

export interface QaRetryInput {
  /** Router name used in decision logging. */
  node: string;
  status: QaStatus;
  /**
   * Total producer runs so far (retryCount[producer]). The producer increments
   * its own counter on every run, including the initial one, so a budget of N
   * revisions allows N+1 total producer runs.
   */
  revisionAttempts: number;
  /** Number of times the QA node has run for infra-retry accounting. */
  qaAttempts: number;
  /** True when this verdict repeats the previous QA round's feedback. */
  repeated?: boolean;
  /** True when the reviewed artifact is hash-identical to the previous round's. */
  unchangedArtifact?: boolean;
  /** QA node infra-retry budget (retries of the QA node's own LLM call). */
  infraMax: number;
}

export function decideQaRetry(input: QaRetryInput): QaDecision {
  const {
    node,
    status,
    revisionAttempts,
    qaAttempts,
    repeated = false,
    unchangedArtifact = false,
  } = input;
  // Both signals mean "another identical round cannot change the outcome";
  // keeping them distinct lets run logs show WHY the loop stopped.
  const stalled = repeated || unchangedArtifact;

  let action: QaAction;
  let reason: string;
  let maxRevisionAttempts = 0;
  let blocking = false;

  // Producer counter includes the initial run; allow maxRevision revisions on
  // top of it (maxRevision + 1 total runs).
  const budgetExhausted = (max: number) => revisionAttempts >= max + 1;

  switch (status) {
    case "approved":
      action = "continue";
      reason = "approved";
      break;
    case "minor_revision":
      maxRevisionAttempts = MINOR_REVISION_MAX;
      blocking = false;
      if (stalled || budgetExhausted(MINOR_REVISION_MAX)) {
        action = "continue";
        reason = unchangedArtifact
          ? "producer reproduced an unchanged artifact; accepting best available result"
          : repeated
            ? "repeated minor feedback; accepting best available result"
            : "minor revision budget exhausted; accepting best available result";
      } else {
        action = "revise";
        reason = "minor revision within budget";
      }
      break;
    case "major_revision":
    case "fail":
    case "fatal":
      maxRevisionAttempts = MAJOR_REVISION_MAX;
      blocking = true;
      if (stalled || budgetExhausted(MAJOR_REVISION_MAX)) {
        action = "fail";
        reason = unchangedArtifact
          ? "producer reproduced an unchanged artifact while QA still rejects it; non-convergence, failing run"
          : repeated
            ? "repeated blocking feedback; failing run"
            : "revision budget exhausted; failing run";
      } else {
        action = "revise";
        reason = "revision within budget";
      }
      break;
    case "retry":
      if (qaAttempts < input.infraMax) {
        action = "retry";
        reason = "QA infrastructure failure; retrying QA node";
      } else {
        action = "fail";
        blocking = true;
        reason = "QA infrastructure budget exhausted; failing run";
      }
      break;
    default:
      action = "fail";
      blocking = true;
      reason = "missing or unhandled QA status; failing run";
  }

  logger.debug(`${node} router`, {
    node,
    status,
    blocking,
    revisionAttempts,
    maxRevisionAttempts,
    qaAttempts,
    qaInfraMax: input.infraMax,
    repeated,
    unchangedArtifact,
    action,
    reason,
  });

  appendRunLogEvent(logger.getCurrentSink(), {
    event: "qa_decision",
    node,
    status,
    revisionAttempts,
    maxRevisionAttempts,
    qaAttempts,
    qaInfraMax: input.infraMax,
    blocking,
    repeated,
    unchangedArtifact,
    action,
    reason,
  });

  return {
    action,
    reason,
    status,
    revisionAttempts,
    qaAttempts,
    maxRevisionAttempts,
    blocking,
    repeated,
    unchangedArtifact,
  };
}

/**
 * Canonical serialization of a QA round's feedback (issues + feedback text).
 * Issues are sorted for deterministic comparison so reordering doesn't trigger
 * false "repeated" negatives. QA nodes persist it per node; an identical hash
 * on the next round signals repeated feedback so the router does not
 * regenerate the same artifact again.
 */
export function hashIssues(issues?: string[], feedback?: string): string {
  const sortedIssues = [...(issues ?? [])].sort();
  return JSON.stringify({ issues: sortedIssues, feedback: feedback ?? "" });
}

/**
 * Centralized terminal-state predicate: a run is COMPLETE only when the
 * Publisher produced a publish result for every requested platform. Every
 * other terminal path (fail-closed guard, QA budget exhaustion, blocked
 * publish gate, fatal review) is FAILED. This is the one definition every
 * terminal edge in the graph relies on.
 */
export function isRunComplete(state: ProjectState): boolean {
  const platforms = state.branding?.platforms ?? ["youtube"];
  const results = state.publishing?.results ?? [];

  if (platforms.length === 0) return false;
  if (results.length === 0) return false;

  const completedPlatforms = new Set(
    results.map((r) => r.platform).filter((p): p is string => Boolean(p)),
  );

  return platforms.every((platform) => completedPlatforms.has(platform));
}

export function isRunFailed(state: ProjectState): boolean {
  return !isRunComplete(state);
}

/** Human-readable failure reason for the launcher's diagnostics. */
const isBlockingQa = (status?: string): boolean =>
  status === "fail" || status === "fatal";

interface QaFailureLike {
  status?: unknown;
  feedback?: string;
  issues?: string[];
  lastFeedback?: string;
}

/**
 * One redacted, truncated line summarizing the QA feedback that killed the
 * run. Read from the QA output already stored in state, so nothing beyond
 * what the QA node itself produced flows into the diagnostics.
 */
function qaFailureDetail(
  qa: QaFailureLike | undefined,
  retryCount: Record<string, number> | undefined,
  producer: string,
): string {
  const attempts = retryCount?.[producer];
  const feedback =
    qa?.feedback ??
    qa?.lastFeedback ??
    (qa?.issues && qa.issues.length > 0 ? qa.issues[0] : undefined);
  const details: string[] = [];
  if (typeof qa?.status === "string" && qa.status !== "approved") {
    details.push(`status=${qa.status}`);
  }
  if (typeof attempts === "number") {
    details.push(`${producer} runs=${attempts}`);
  }
  if (feedback && feedback.trim()) {
    // Redacted + capped: this string lands in run_final and diagnostics.
    details.push(
      `feedback: ${sanitizeForLog(feedback.trim(), { maxChars: 300 })}`,
    );
  }
  return details.length > 0 ? ` (${details.join("; ")})` : "";
}

export function runFailureReason(state: ProjectState): string {
  const retryCount = state.execution?.retryCount as
    Record<string, number> | undefined;
  if (isBlockingQa(state.researchQA?.status)) {
    return (
      "research QA failed" +
      qaFailureDetail(state.researchQA, retryCount, "ResearchAgent")
    );
  }
  if (isBlockingQa(state.scriptQA?.status)) {
    return (
      "script QA failed" +
      qaFailureDetail(state.scriptQA, retryCount, "ScriptWriter")
    );
  }
  if (isBlockingQa(state.production?.promptQA?.status)) {
    return (
      "prompt QA failed" +
      qaFailureDetail(
        state.production?.promptQA,
        retryCount,
        "ImagePromptGenerator",
      )
    );
  }
  if (state.releaseReview?.status === "fatal") {
    return (
      "release review failed" +
      qaFailureDetail(state.releaseReview, retryCount, "ReleaseReview")
    );
  }
  if (state.releaseValidation?.status === "fatal") {
    return (
      "release validation failed" +
      qaFailureDetail(state.releaseValidation, retryCount, "ReleaseValidation")
    );
  }
  if (state.publishReady?.status === "blocked") {
    const issues = state.publishReady.issues ?? [];
    return issues.length > 0
      ? `publish gate blocked: ${issues.join("; ")}`
      : "publish gate blocked";
  }
  return "pipeline terminated before publishing";
}
