import { config } from "./config.js";
import { prettyFormatter } from "./pretty-formatter.js";
import {
  openRunLogSink,
  closeRunLogSink,
  type RunLogSink,
  type RunLogContext,
} from "./run-log.js";

type LogLevel = "info" | "warn" | "error" | "debug";

type LogMeta = Record<string, unknown>;

function formatTime(): string {
  return new Date().toISOString().slice(11, 19);
}

function formatHuman(level: LogLevel, message: string, meta?: LogMeta): string {
  const time = formatTime();
  const metaStr =
    meta && Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : "";
  return `[${time}] ${level.toUpperCase()} ${message}${metaStr}`;
}

function formatJson(level: LogLevel, message: string, meta?: LogMeta): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  });
}

function formatNodeMessage(message: string): string {
  return `[${formatTime()}] ${message}`;
}

const usePretty = config.logFormat() === "pretty";

let currentSink: RunLogSink | null = null;
let currentContext: { runId: string; topic: string; attempt: number } | null =
  null;
const totals = {
  llmCalls: 0,
  llmCostUsd: 0,
  providerCalls: 0,
  retries: 0,
  nodes: 0,
  scenes: 0,
};

function resetTotals(): void {
  totals.llmCalls = 0;
  totals.llmCostUsd = 0;
  totals.providerCalls = 0;
  totals.retries = 0;
  totals.nodes = 0;
  totals.scenes = 0;
}

function nowEvent(extra: Record<string, unknown>): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    runId: currentContext?.runId,
    ...extra,
  };
}

function writeSinkEvent(extra: Record<string, unknown>): void {
  if (!currentSink) return;
  void currentSink.appendLine(
    nowEvent(extra) as Parameters<RunLogSink["appendLine"]>[0],
  );
}

function recordTotals(event: string, meta?: LogMeta): void {
  switch (event) {
    case "node_start":
      totals.nodes += 1;
      break;
    case "scene_event":
      totals.scenes += 1;
      break;
    case "node_retry":
      totals.retries += 1;
      break;
    case "llm_call":
      totals.llmCalls += 1;
      if (typeof meta?.costUsd === "number") {
        totals.llmCostUsd += meta.costUsd;
      }
      break;
    case "provider_call":
      totals.providerCalls += 1;
      break;
  }
}

export const logger = {
  setRunContext(
    runId: string,
    topic: string,
    attempt: number,
    extra?: {
      threadId?: string;
      profile?: string;
      projectId?: string;
      pillar?: string;
      runDir?: string;
    },
  ): void {
    if (usePretty) {
      prettyFormatter.setRunContext({ runId, topic, attempt });
    }
    resetTotals();
    currentContext = { runId, topic, attempt };
    if (currentSink) {
      void closeRunLogSink(currentSink.runId);
      currentSink = null;
    }
    if (!runId) {
      currentSink = null;
      return;
    }
    const context: RunLogContext = {
      runId,
      topic,
      attempt,
      runDir: extra?.runDir ?? "",
      env: {},
      ...(extra?.threadId ? { threadId: extra.threadId } : {}),
      ...(extra?.profile ? { profile: extra.profile } : {}),
      ...(extra?.projectId ? { projectId: extra.projectId } : {}),
      ...(extra?.pillar ? { pillar: extra.pillar } : {}),
    };
    void openRunLogSink(context).then((sink) => {
      currentSink = sink;
      return undefined;
    });
  },

  getCurrentSink(): RunLogSink | null {
    return currentSink;
  },

  setSink(sink: RunLogSink | null): void {
    if (currentSink && currentSink !== sink) {
      void closeRunLogSink(currentSink.runId);
    }
    currentSink = sink;
  },

  info(message: string, meta?: LogMeta): void {
    recordTotals("log_message", meta);
    writeSinkEvent({ event: "log_message", level: "info", message, meta });
    if (usePretty) {
      prettyFormatter.info(message, meta);
    } else {
      console.log(formatHuman("info", message, meta));
    }
  },
  warn(message: string, meta?: LogMeta): void {
    recordTotals("log_message", meta);
    writeSinkEvent({ event: "log_message", level: "warn", message, meta });
    if (usePretty) {
      prettyFormatter.warn(message, meta);
    } else {
      console.warn(formatHuman("warn", message, meta));
    }
  },
  error(message: string, meta?: LogMeta): void {
    recordTotals("log_message", meta);
    writeSinkEvent({ event: "log_message", level: "error", message, meta });
    if (usePretty) {
      prettyFormatter.error(message, meta);
    } else {
      console.error(formatHuman("error", message, meta));
    }
  },
  debug(message: string, meta?: LogMeta): void {
    if (!config.isDebug()) return;
    recordTotals("log_message", meta);
    writeSinkEvent({ event: "log_message", level: "debug", message, meta });
    if (usePretty) {
      prettyFormatter.debug(message, meta);
    } else {
      console.log(formatJson("debug", message, meta));
    }
  },

  nodeStart(label: string, meta?: LogMeta): void {
    recordTotals("node_start", meta);
    writeSinkEvent({ event: "node_start", node: label, meta });
    if (usePretty) {
      prettyFormatter.nodeStart(label, "");
    } else {
      console.log(formatNodeMessage(`${label} started`));
    }
  },
  nodeDone(label: string, durationMs: number, meta?: LogMeta): void {
    writeSinkEvent({
      event: "node_end",
      node: label,
      durationMs,
      meta,
    });
    if (usePretty) {
      prettyFormatter.nodeDone(label, durationMs);
    } else {
      console.log(
        formatNodeMessage(`${label} complete (${formatDuration(durationMs)})`),
      );
    }
  },
  nodePhase(label: string, phase: string, meta?: LogMeta): void {
    writeSinkEvent({ event: "node_phase", node: label, phase, meta });
    if (usePretty) {
      prettyFormatter.nodePhase(label, phase);
    } else {
      console.log(formatNodeMessage(`${label} ${phase}`));
    }
  },
  nodeRetry(
    label: string,
    attempt: number,
    maxRetries: number,
    reason: string,
    meta?: LogMeta,
  ): void {
    recordTotals("node_retry", meta);
    writeSinkEvent({
      event: "node_retry",
      node: label,
      attempt,
      maxRetries,
      reason,
      meta,
    });
    if (usePretty) {
      prettyFormatter.nodeRetry(label, attempt, maxRetries, reason);
    } else {
      console.log(
        formatNodeMessage(
          `${label} retrying (${attempt}/${maxRetries}): ${reason}`,
        ),
      );
    }
  },
  nodeSkipped(label: string, reason: string, meta?: LogMeta): void {
    writeSinkEvent({ event: "node_skipped", node: label, reason, meta });
    if (usePretty) {
      prettyFormatter.nodeSkipped(label, reason);
    } else {
      console.log(formatNodeMessage(`${label} skipped: ${reason}`));
    }
  },
  nodeIncomplete(label: string, detail: string, meta?: LogMeta): void {
    writeSinkEvent({ event: "node_incomplete", node: label, detail, meta });
    if (usePretty) {
      prettyFormatter.nodeWarning(label, detail);
    } else {
      console.log(formatNodeMessage(`${label} incomplete (${detail})`));
    }
  },
  nodeFailed(label: string, reason: string, meta?: LogMeta): void {
    writeSinkEvent({ event: "node_failed", node: label, reason, meta });
    if (usePretty) {
      prettyFormatter.nodeFailed(label, reason);
    } else {
      console.error(formatNodeMessage(`${label} failed: ${reason}`));
    }
  },

  finalize(status: "complete" | "failed", summary?: string): void {
    const finishedAt = new Date().toISOString();
    writeSinkEvent({
      event: "run_final",
      status,
      summary,
      finishedAt,
      totals: { ...totals },
    });
    if (usePretty) {
      prettyFormatter.finalize(status, summary);
    } else {
      const prefix = status === "complete" ? "✓" : "✗";
      console.log(formatNodeMessage(`${prefix} VIDEO ${status.toUpperCase()}`));
      if (summary) console.log(formatNodeMessage(summary));
    }
    if (currentSink) {
      const sink = currentSink;
      currentSink = null;
      void sink.flush().then(() => sink.close());
    }
  },
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem ? `${mins}m ${rem.toString().padStart(2, "0")}s` : `${mins}m 00s`;
}
