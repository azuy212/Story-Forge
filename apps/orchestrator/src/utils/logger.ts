import { config } from "./config.js";

type LogLevel = "info" | "warn" | "error" | "debug";

type LogMeta = Record<string, unknown>;

function formatEntry(
  level: LogLevel,
  message: string,
  meta?: LogMeta,
): string {
  return JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    message,
    ...meta,
  });
}

export const logger = {
  info(message: string, meta?: LogMeta): void {
    console.log(formatEntry("info", message, meta));
  },
  warn(message: string, meta?: LogMeta): void {
    console.warn(formatEntry("warn", message, meta));
  },
  error(message: string, meta?: LogMeta): void {
    console.error(formatEntry("error", message, meta));
  },
  debug(message: string, meta?: LogMeta): void {
    if (config.isDebug()) {
      console.log(formatEntry("debug", message, meta));
    }
  },
};
