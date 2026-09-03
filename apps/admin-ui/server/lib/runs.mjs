import {
  readdirSync,
  readFileSync,
  statSync,
  existsSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ADMIN_UI_ROOT = join(__dirname, "..", "..");
const ORCHESTRATOR_ROOT = join(ADMIN_UI_ROOT, "..", "orchestrator");
const RUNS_DIR =
  process.env.ARTIFACT_STORE_DIR || join(ORCHESTRATOR_ROOT, "runs");

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
  const lines = text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
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

export const STAGE_ORDER = [
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
  const lastEnd = logTail?.findLast?.(
    (e) => e.event === "node_end" || e.event === "node_failed",
  );
  if (lastStart && (!lastEnd || lastStart.ts > lastEnd.ts)) {
    if (Date.now() - (lastStart.ts ?? 0) < 120_000) return "running";
  }
  const anyComplete = Object.values(stages).some((s) => s === "complete");
  if (anyComplete) return "incomplete";
  return "new";
}

/**
 * Per-stage LLM cost breakdown for one run. Reads every `llmUsage/v*.json`
 * artifact and groups `costUsd` by `meta.node`. Mirrors `LLMAggregate` from
 * `apps/orchestrator/src/models/usage.ts` — kept narrow here because the
 * admin-ui server is plain ESM and can't import the TS source safely.
 *
 * `totalCostUsd` stays `null` when no record reports a cost (the provider
 * can refuse to report); `null` is also returned for runs with no usage
 * artifacts yet. Per-stage `costUsd` is `null` when that stage has records
 * but none of them reported a cost.
 */
export function summarizeLlmCost(ns) {
  const dir = join(PATHS.RUNS, ns, "artifacts", "llmUsage");
  if (!existsSync(dir)) {
    return { totalCostUsd: null, requestCount: 0, perStage: {}, perModel: {} };
  }
  const files = readdirSync(dir).filter((f) => /^v\d+\.json$/.test(f));
  /** @type {Record<string, { costUsd: number | null; requests: number; costSeen: boolean }>} */
  const perStage = {};
  /** @type {Record<string, { costUsd: number | null; requests: number; costSeen: boolean }>} */
  const perModel = {};
  let total = 0;
  let totalSeen = false;
  let requests = 0;

  for (const f of files) {
    const p = join(dir, f);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(p, "utf-8"));
    } catch {
      continue;
    }
    const meta = parsed?.meta ?? {};
    const data = parsed?.data ?? {};
    const node =
      typeof meta.node === "string" && meta.node.length > 0
        ? meta.node
        : "unknown";
    const model =
      typeof meta.model === "string" && meta.model.length > 0
        ? meta.model
        : null;
    const cost =
      typeof data.costUsd === "number" && Number.isFinite(data.costUsd)
        ? data.costUsd
        : null;

    if (cost !== null) {
      total += cost;
      totalSeen = true;
    }
    requests += 1;

    const stage =
      perStage[node] ??
      (perStage[node] = { costUsd: null, requests: 0, costSeen: false });
    stage.requests += 1;
    if (cost !== null) {
      stage.costUsd = (stage.costUsd ?? 0) + cost;
      stage.costSeen = true;
    }

    if (model) {
      const m =
        perModel[model] ??
        (perModel[model] = { costUsd: null, requests: 0, costSeen: false });
      m.requests += 1;
      if (cost !== null) {
        m.costUsd = (m.costUsd ?? 0) + cost;
        m.costSeen = true;
      }
    }
  }

  // Strip the bookkeeping field before returning so the API doesn't expose it.
  const strip = (rec) => ({
    costUsd: rec.costSeen ? rec.costUsd : null,
    requests: rec.requests,
  });
  const cleanPerStage = {};
  for (const [k, v] of Object.entries(perStage)) cleanPerStage[k] = strip(v);
  const cleanPerModel = {};
  for (const [k, v] of Object.entries(perModel)) cleanPerModel[k] = strip(v);

  return {
    totalCostUsd: totalSeen ? total : null,
    requestCount: requests,
    perStage: cleanPerStage,
    perModel: cleanPerModel,
  };
}

export function summarizeRun(ns) {
  const meta = readRunMeta(ns);
  const manifest = readManifest(ns);
  const logTail = readLogTail(ns, 0, 32 * 1024).lines;
  const status = deriveRunStatus(meta, manifest, logTail);
  const llmCost = summarizeLlmCost(ns);
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
    llmCostUsd: llmCost.totalCostUsd,
    llmRequestCount: llmCost.requestCount,
  };
}
