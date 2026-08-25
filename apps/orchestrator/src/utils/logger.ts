import { config } from "./config.js";
import { prettyFormatter } from "./pretty-formatter.js";

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

export const logger = {
  setRunContext(runId: string, topic: string, attempt: number): void {
    if (usePretty) {
      prettyFormatter.setRunContext({ runId, topic, attempt });
    }
  },

  info(message: string, meta?: LogMeta): void {
    if (usePretty) {
      prettyFormatter.info(message, meta);
    } else {
      console.log(formatHuman("info", message, meta));
    }
  },
  warn(message: string, meta?: LogMeta): void {
    if (usePretty) {
      prettyFormatter.warn(message, meta);
    } else {
      console.warn(formatHuman("warn", message, meta));
    }
  },
  error(message: string, meta?: LogMeta): void {
    if (usePretty) {
      prettyFormatter.error(message, meta);
    } else {
      console.error(formatHuman("error", message, meta));
    }
  },
  debug(message: string, meta?: LogMeta): void {
    if (config.isDebug()) {
      if (usePretty) {
        prettyFormatter.debug(message, meta);
      } else {
        console.log(formatJson("debug", message, meta));
      }
    }
  },

  nodeStart(label: string): void {
    if (usePretty) {
      prettyFormatter.nodeStart(label, "");
    } else {
      console.log(formatNodeMessage(`${label} started`));
    }
  },
  nodeDone(label: string, durationMs: number): void {
    if (usePretty) {
      prettyFormatter.nodeDone(label, durationMs);
    } else {
      console.log(
        formatNodeMessage(`${label} complete (${formatDuration(durationMs)})`),
      );
    }
  },
  nodePhase(label: string, phase: string): void {
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
  ): void {
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
  nodeSkipped(label: string, reason: string): void {
    if (usePretty) {
      prettyFormatter.nodeSkipped(label, reason);
    } else {
      console.log(formatNodeMessage(`${label} skipped: ${reason}`));
    }
  },
  nodeIncomplete(label: string, detail: string): void {
    if (usePretty) {
      prettyFormatter.nodeWarning(label, detail);
    } else {
      console.log(formatNodeMessage(`${label} incomplete (${detail})`));
    }
  },
  nodeFailed(label: string, reason: string): void {
    if (usePretty) {
      prettyFormatter.nodeFailed(label, reason);
    } else {
      console.error(formatNodeMessage(`${label} failed: ${reason}`));
    }
  },

  finalize(status: "complete" | "failed", summary?: string): void {
    if (usePretty) {
      prettyFormatter.finalize(status, summary);
    } else {
      const prefix = status === "complete" ? "✓" : "✗";
      console.log(formatNodeMessage(`${prefix} VIDEO ${status.toUpperCase()}`));
      if (summary) console.log(formatNodeMessage(summary));
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
