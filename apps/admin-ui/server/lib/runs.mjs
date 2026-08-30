import { readdirSync, readFileSync, statSync, existsSync, openSync, readSync, closeSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_UI_ROOT = join(__dirname, "..", "..");
const ORCHESTRATOR_ROOT = join(ADMIN_UI_ROOT, "..", "orchestrator");
const RUNS_DIR = process.env.ARTIFACT_STORE_DIR || join(ORCHESTRATOR_ROOT, "runs");

export const PATHS = {
  ROOT: ADMIN_UI_ROOT,
  ORCHESTRATOR: ORCHESTRATOR_ROOT,
  RUNS: RUNS_DIR,
  ORCH_ENV: join(ORCHESTRATOR_ROOT, ".env"),
};

export function listNamespaces() {
  if (!existsSync(PATHS.RUNS)) return [];
  return readdirSync(PATHS.RUNS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== ".run-names")
    .map((d) => d.name);
}

export function readRunMeta(ns) {
  const p = join(PATHS.RUNS, ns, "run.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

export function readManifest(ns) {
  const p = join(PATHS.RUNS, ns, "manifest.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

export function readLogTail(ns, fromBytes = 0, maxBytes = 256 * 1024) {
  const p = join(PATHS.RUNS, ns, "run.log");
  if (!existsSync(p)) return { lines: [], nextOffset: fromBytes, eof: true };
  const stat = statSync(p);
  const start = Math.max(fromBytes, stat.size - maxBytes);
  const len = stat.size - start;
  if (len <= 0) return { lines: [], nextOffset: stat.size, eof: true };
  const fd = openSync(p, "r");
  const buf = Buffer.alloc(len);
  try {
    readSync(fd, buf, 0, len, start);
  } finally {
    closeSync(fd);
  }
  const text = buf.toString("utf-8");
  const lines = text.split("\n").filter(Boolean).map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return { event: "raw", line };
    }
  });
  return { lines, nextOffset: stat.size, eof: true };
}

export function logSize(ns) {
  const p = join(PATHS.RUNS, ns, "run.log");
  if (!existsSync(p)) return 0;
  return statSync(p).size;
}

const STAGE_ORDER = [
  "research",
  "researchQA",
  "scriptPlan",
  "script",
  "scriptQA",
  "metadata",
  "thumbnail",
  "visualDirector",
  "thumbnailImage",
  "prompts",
  "promptQA",
  "assets",
  "audio",
  "subtitles",
  "videoPlan",
  "releaseValidation",
  "releaseReview",
  "publish",
];

const SEED_BYPASS = new Set([
  "research",
  "researchQA",
  "scriptPlan",
  "script",
  "scriptQA",
]);

export function stageStatus(manifest, isSeedRun = false) {
  const status = {};
  for (const type of STAGE_ORDER) {
    const m = manifest?.[type];
    if (!m) {
      status[type] = isSeedRun && SEED_BYPASS.has(type) ? "seeded" : "missing";
      continue;
    }
    if (m.latest && m.versions) {
      const latest = m.versions.find(
        (v) => v.version === Number(String(m.latest).replace("v", "")),
      );
      status[type] = latest?.status ?? "unknown";
    } else {
      status[type] = "unknown";
    }
  }
  return status;
}

export function deriveRunStatus(meta, manifest, logTail) {
  if (meta?.abortedAt) return "aborted";
  const stages = stageStatus(manifest, meta?.runSource === "seed");
  if (stages.publish === "complete") return "published";
  if (stages.publish === "failed") return "failed";
  if (logTail?.some((e) => e.event === "node_failed")) return "failed";
  const lastStart = logTail?.findLast?.((e) => e.event === "node_start");
  const lastEnd = logTail?.findLast?.((e) => e.event === "node_end" || e.event === "node_failed");
  if (lastStart && (!lastEnd || lastStart.ts > lastEnd.ts)) {
    if (Date.now() - (lastStart.ts ?? 0) < 120_000) return "running";
  }
  const anyComplete = Object.values(stages).some((s) => s === "complete");
  if (anyComplete) return "incomplete";
  return "new";
}

export function summarizeRun(ns) {
  const meta = readRunMeta(ns);
  const manifest = readManifest(ns);
  const logTail = readLogTail(ns, 0, 32 * 1024).lines;
  const status = deriveRunStatus(meta, manifest, logTail);
  return {
    ns,
    topic: meta?.topic ?? null,
    pillar: meta?.pillar ?? null,
    videoProfile: meta?.videoProfile ?? null,
    runSource: meta?.runSource ?? "backlog",
    projectId: meta?.projectId ?? null,
    youtubePublishAt: meta?.youtubePublishAt ?? null,
    createdAt: meta?.createdAt ?? null,
    threadHistory: meta?.threadHistory ?? [],
    hasSeed: Boolean(meta?.seed),
    abortedAt: meta?.abortedAt ?? null,
    status,
  };
}
