import { config } from "./config.js";

type LogLevel = "info" | "warn" | "error" | "debug";

type LogMeta = Record<string, unknown>;

function formatHuman(level: LogLevel, message: string, meta?: LogMeta): string {
  const time = new Date().toISOString().slice(11, 19);
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
};
