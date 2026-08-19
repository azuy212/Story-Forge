import { config } from "./config.js";

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

export const logger = {
  info(message: string, meta?: LogMeta): void {
    console.log(formatHuman("info", message, meta));
  },
  warn(message: string, meta?: LogMeta): void {
    console.warn(formatHuman("warn", message, meta));
  },
  error(message: string, meta?: LogMeta): void {
    console.error(formatHuman("error", message, meta));
  },
  debug(message: string, meta?: LogMeta): void {
    if (config.isDebug()) {
      console.log(formatJson("debug", message, meta));
    }
  },

  nodeStart(label: string): void {
    console.log(formatNodeMessage(`${label} started`));
  },
  nodeDone(label: string, durationMs: number): void {
    console.log(
      formatNodeMessage(`${label} complete (${formatDuration(durationMs)})`),
    );
  },
  nodeRetry(
    label: string,
    attempt: number,
    maxRetries: number,
    reason: string,
  ): void {
    console.log(
      formatNodeMessage(
        `${label} retrying (${attempt}/${maxRetries}): ${reason}`,
      ),
    );
  },
  nodeSkipped(label: string, reason: string): void {
    console.log(formatNodeMessage(`${label} skipped: ${reason}`));
  },
  nodeIncomplete(label: string, detail: string): void {
    console.log(formatNodeMessage(`${label} incomplete (${detail})`));
  },
  nodeFailed(label: string, reason: string): void {
    console.error(formatNodeMessage(`${label} failed: ${reason}`));
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
