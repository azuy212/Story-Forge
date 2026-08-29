import { config } from "./config.js";
import { getTotalNodeCount, getNodePhase } from "./pipeline-stages.js";

const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[36m";
const GRAY = "\x1b[90m";

const ICONS = {
  complete: "✓",
  running: "▶",
  retry: "↻",
  warning: "⚠",
  failed: "✗",
  skipped: "○",
} as const;

type NodeStatus = keyof typeof ICONS;

interface RunContext {
  runId: string;
  topic: string;
  attempt: number;
}

interface NodeEntry {
  label: string;
  status: NodeStatus;
  phase?: string;
  durationMs?: number;
  detail?: string;
  printed: boolean;
}

export class PrettyConsoleFormatter {
  private readonly useColors: boolean;
  private silent = false;
  private runContext?: RunContext;
  private runStartedAt?: number;
  private nodes: NodeEntry[] = [];
  private currentNodeLabel?: string;
  private headerPrinted = false;
  private lastPrintedIndex = -1;

  constructor() {
    this.useColors = process.stdout.isTTY && config.logFormat() !== "json";
  }

  /**
   * Suppress the per-run header box and per-node progress lines. Used by
   * the run-next launcher, which renders its own in-place progress bar and
   * does not want the box to share a row with the bar's first render.
   * `logger.info`/`warn`/`error` still emit their `  • message` lines.
   */
  setSilent(value: boolean): void {
    this.silent = value;
  }

  setRunContext(context: RunContext): void {
    this.runContext = context;
    this.runStartedAt = Date.now();
    this.nodes = [];
    this.currentNodeLabel = undefined;
    this.headerPrinted = false;
    this.lastPrintedIndex = -1;
  }

  private printHeader(): void {
    if (!this.runContext || this.headerPrinted || this.silent) return;

    const { runId, topic, attempt } = this.runContext;
    const width = 60;
    const line = "─".repeat(width);
    const top = `╭${line}╮`;
    const mid1 = `│ ${"AI VIDEO PIPELINE".padEnd(width - 2)} │`;
    const mid2 = `│ ${`Run ${runId} · Attempt ${attempt}`.padEnd(width - 2)} │`;
    const mid3 = `│ ${this.fit(topic, width - 2).padEnd(width - 2)} │`;
    const bot = `╰${line}╯`;

    const color = this.useColors ? BLUE : "";
    const reset = this.useColors ? RESET : "";

    console.log(`${color}${top}${reset}`);
    console.log(`${color}${mid1}${reset}`);
    console.log(`${color}${mid2}${reset}`);
    console.log(`${color}${mid3}${reset}`);
    console.log(`${color}${bot}${reset}`);
    console.log("");
    this.headerPrinted = true;
  }

  private fit(text: string, width: number): string {
    if (text.length <= width) return text.padEnd(width);
    return `${text.slice(0, width - 1)}…`;
  }

  private colorize(text: string, color: string): string {
    return this.useColors ? `${color}${text}${RESET}` : text;
  }

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const secs = ms / 1000;
    if (secs < 60) return `${secs.toFixed(1)}s`;
    const mins = Math.floor(secs / 60);
    const rem = Math.floor(secs % 60);
    return rem
      ? `${mins}m ${rem.toString().padStart(2, "0")}s`
      : `${mins}m 00s`;
  }

  private formatDetail(detail?: string): string {
    if (!detail) return "";
    return this.colorize(`  ${detail}`, GRAY);
  }

  private getIconColor(status: NodeStatus): string {
    switch (status) {
      case "complete":
        return GREEN;
      case "running":
        return BLUE;
      case "retry":
        return YELLOW;
      case "warning":
        return YELLOW;
      case "failed":
        return RED;
      case "skipped":
        return GRAY;
    }
  }

  private printProgressBar(completed: number, total: number): void {
    if (this.silent) return;
    const barWidth = 28;
    const filled = Math.round((completed / total) * barWidth);
    const bar = "█".repeat(filled) + "░".repeat(barWidth - filled);

    const barColor = this.useColors ? BLUE : "";
    const reset = this.useColors ? RESET : "";

    console.log(
      `\n  Progress  ${barColor}[${bar}]${reset} ${completed}/${total}  ${this.currentNodeLabel ?? ""}\n`,
    );
  }

  private renderNewEntries(): void {
    if (!this.headerPrinted) return;

    const totalNodes = getTotalNodeCount();

    for (let i = this.lastPrintedIndex + 1; i < this.nodes.length; i++) {
      const entry = this.nodes[i];
      if (!entry.printed && entry.status !== "running") {
        this.printNodeLine(entry, false);
        entry.printed = true;
        this.lastPrintedIndex = i;
      }
    }

    // Print current running node if it exists and hasn't been printed
    if (this.currentNodeLabel) {
      const currentEntry = this.nodes.find(
        (n) => n.label === this.currentNodeLabel,
      );
      if (
        currentEntry &&
        currentEntry.status === "running" &&
        !currentEntry.printed
      ) {
        this.printNodeLine(currentEntry, true);
        currentEntry.printed = true;
      }
    }

    // Count completed (not failed/skipped) for progress
    let completed = 0;
    for (const entry of this.nodes) {
      if (entry.status === "complete" || entry.status === "skipped") {
        completed++;
      }
    }

    this.printProgressBar(completed, totalNodes);
  }

  private printNodeLine(entry: NodeEntry, isCurrent = false): void {
    if (this.silent) return;
    const icon = ICONS[entry.status];
    const iconColor = this.getIconColor(entry.status);
    const coloredIcon = this.colorize(icon, iconColor);

    const label = entry.label.padEnd(24);
    const phase = entry.phase ? entry.phase.padEnd(36) : "".padEnd(36);
    const duration = entry.durationMs
      ? this.formatDuration(entry.durationMs).padStart(10)
      : "";

    let line = "";
    if (isCurrent) {
      line = `  ${coloredIcon} ${this.colorize(label, BLUE)}${phase}`;
      if (entry.phase) {
        line += this.colorize(`  ${entry.phase}`, GRAY);
      }
    } else {
      const labelColor =
        entry.status === "failed"
          ? RED
          : entry.status === "skipped"
            ? GRAY
            : "";
      const coloredLabel =
        this.useColors && labelColor ? `${labelColor}${label}${RESET}` : label;
      line = `  ${coloredIcon} ${coloredLabel}${phase}${duration}`;
    }

    if (entry.detail && entry.status !== "running") {
      line += this.formatDetail(entry.detail);
    }

    console.log(line);
  }

  nodeStart(label: string, phase: string): void {
    this.printHeader();

    const effectivePhase = phase || getNodePhase(label) || "";

    const existing = this.nodes.find((n) => n.label === label);
    if (existing) {
      existing.status = "running";
      existing.phase = effectivePhase;
      existing.printed = false;
    } else {
      this.nodes.push({
        label,
        status: "running",
        phase: effectivePhase,
        printed: false,
      });
    }

    this.currentNodeLabel = label;
    this.renderNewEntries();
  }

  nodePhase(label: string, phase: string): void {
    const entry = this.nodes.find((n) => n.label === label);
    if (entry) {
      entry.phase = phase;
      if (entry.status === "running") {
        // Re-print the running node with updated phase
        console.log("\x1b[1A\x1b[2K"); // Move up one line and clear
        this.printNodeLine(entry, true);
      }
    }
  }

  nodeDone(label: string, durationMs: number, detail?: string): void {
    const entry = this.nodes.find((n) => n.label === label);
    if (entry) {
      entry.status = "complete";
      entry.durationMs = durationMs;
      entry.detail = detail;
      entry.printed = false;
    } else {
      this.nodes.push({
        label,
        status: "complete",
        durationMs,
        detail,
        printed: false,
      });
    }

    this.renderNewEntries();
  }

  nodeRetry(
    label: string,
    attempt: number,
    maxRetries: number,
    reason: string,
  ): void {
    const entry = this.nodes.find((n) => n.label === label);
    const detail = `retry ${attempt}/${maxRetries}: ${reason}`;
    if (entry) {
      entry.status = "retry";
      entry.detail = detail;
      entry.printed = false;
    } else {
      this.nodes.push({ label, status: "retry", detail, printed: false });
    }

    this.renderNewEntries();
  }

  nodeSkipped(label: string, reason: string): void {
    const entry = this.nodes.find((n) => n.label === label);
    if (entry) {
      entry.status = "skipped";
      entry.detail = reason;
      entry.printed = false;
    } else {
      this.nodes.push({
        label,
        status: "skipped",
        detail: reason,
        printed: false,
      });
    }

    this.renderNewEntries();
  }

  nodeFailed(label: string, reason: string): void {
    const entry = this.nodes.find((n) => n.label === label);
    if (entry) {
      entry.status = "failed";
      entry.detail = reason;
      entry.printed = false;
    } else {
      this.nodes.push({
        label,
        status: "failed",
        detail: reason,
        printed: false,
      });
    }

    this.renderNewEntries();
  }

  nodeWarning(label: string, detail: string): void {
    const entry = this.nodes.find((n) => n.label === label);
    if (entry) {
      entry.status = "warning";
      entry.detail = detail;
      entry.printed = false;
    } else {
      this.nodes.push({ label, status: "warning", detail, printed: false });
    }
    this.renderNewEntries();
  }

  finalize(status: "complete" | "failed", summary?: string): void {
    const totalMs = this.runStartedAt ? Date.now() - this.runStartedAt : 0;
    const totalDuration = this.formatDuration(totalMs);

    console.log("");

    const width = 60;
    const line = "─".repeat(width);
    const top = `╭${line}╮`;
    const bot = `╰${line}╯`;

    if (status === "complete") {
      const color = this.useColors ? GREEN : "";
      const reset = this.useColors ? RESET : "";
      console.log(`${color}${top}${reset}`);
      console.log(
        `${color}│ ${"✓ VIDEO COMPLETE".padEnd(width - 2)} │${reset}`,
      );
      console.log(
        `${color}│ ${`Total time: ${totalDuration}`.padEnd(width - 2)} │${reset}`,
      );
      if (summary) {
        console.log(
          `${color}│ ${this.fit(summary, width - 2).padEnd(width - 2)} │${reset}`,
        );
      }
      console.log(`${color}${bot}${reset}`);
    } else {
      const color = this.useColors ? RED : "";
      const reset = this.useColors ? RESET : "";
      console.log(`${color}${top}${reset}`);
      console.log(`${color}│ ${"✗ VIDEO FAILED".padEnd(width - 2)} │${reset}`);
      console.log(
        `${color}│ ${`Time: ${totalDuration}`.padEnd(width - 2)} │${reset}`,
      );
      if (this.currentNodeLabel) {
        console.log(
          `${color}│ ${`Node: ${this.currentNodeLabel}`.padEnd(width - 2)} │${reset}`,
        );
      }
      if (summary) {
        console.log(
          `${color}│ ${this.fit(summary, width - 2).padEnd(width - 2)} │${reset}`,
        );
      }
      console.log(`${color}${bot}${reset}`);
    }

    // Reset context
    this.headerPrinted = false;
    this.nodes = [];
    this.currentNodeLabel = undefined;
    this.lastPrintedIndex = -1;
  }

  // Human-readable output for launcher messages
  info(message: string, _meta?: Record<string, unknown>): void {
    this.printHeader();
    console.log(`  ${this.colorize("•", BLUE)} ${message}`);
  }

  warn(message: string, _meta?: Record<string, unknown>): void {
    this.printHeader();
    console.log(`  ${this.colorize("⚠", YELLOW)} ${message}`);
  }

  error(message: string, _meta?: Record<string, unknown>): void {
    this.printHeader();
    console.log(`  ${this.colorize("✗", RED)} ${message}`);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    if (config.isDebug()) {
      const entry = {
        timestamp: new Date().toISOString(),
        level: "debug",
        message,
        ...meta,
      };
      console.log(JSON.stringify(entry));
    }
  }
}

export const prettyFormatter = new PrettyConsoleFormatter();
