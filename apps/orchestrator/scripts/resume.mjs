#!/usr/bin/env node

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createOrAppendRunMeta } from "../src/artifacts/run-meta.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR =
  process.env.ARTIFACT_STORE_DIR || join(__dirname, "..", "runs");
const DEV_API = "http://localhost:2024";

function sanitizeKey(threadId) {
  return threadId.replace(/[^a-z0-9-_.]+/gi, "_");
}

function listRunNamespaces() {
  return readdirSync(RUNS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== ".run-names")
    .map((d) => d.name);
}

function resolveNamespace(input) {
  const namespaces = listRunNamespaces();
  const exact = namespaces.find((n) => n === input);
  if (exact) return exact;

  const matches = namespaces.filter((n) => n.includes(input));
  if (matches.length === 1) return matches[0];

  if (matches.length > 1) {
    console.error(`Multiple runs match "${input}":`);
    for (const m of matches) console.error(`  ${m}`);
    process.exit(1);
  }

  console.error(`No run found for "${input}"`);
  console.error("Available runs:");
  for (const n of namespaces) console.error(`  ${n}`);
  process.exit(1);
}

function readRunMeta(ns) {
  const path = join(RUNS_DIR, ns, "run.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
}

function readManifest(ns) {
  const path = join(RUNS_DIR, ns, "manifest.json");
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf-8"));
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

function getStageStatus(manifest) {
  if (!manifest) return {};
  const status = {};
  for (const type of STAGE_ORDER) {
    const m = manifest[type];
    if (!m) {
      status[type] = "missing";
      continue;
    }
    if (m.latest && m.versions) {
      const latest = m.versions.find(
        (v) => v.version === Number(m.latest.replace("v", "")),
      );
      status[type] = latest?.status ?? "unknown";
    } else {
      status[type] = "unknown";
    }
  }
  return status;
}

function printStatus(ns, meta, manifest) {
  console.log(`\nRun: ${ns}`);
  console.log(`Thread: ${meta?.threadId ?? "unknown"}`);
  console.log(`Topic: ${meta?.topic ?? "unknown"}`);
  console.log(`Pillar: ${meta?.pillar ?? "unknown"}`);
  console.log(`Created: ${meta?.createdAt ?? "unknown"}`);
  console.log(`Thread history: ${meta?.threadHistory?.join(", ") ?? "none"}`);
  console.log("\nStage status:");
  const status = getStageStatus(manifest);
  for (const [type, s] of Object.entries(status)) {
    const icon =
      s === "complete"
        ? "✓"
        : s === "missing"
          ? "○"
          : s === "pending"
            ? "⏳"
            : "?";
    console.log(`  ${icon} ${type}: ${s}`);
  }
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers || {}) },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return res.json();
}

export async function getAssistantId() {
  const assistants = await fetchJson(`${DEV_API}/assistants/search`, {
    method: "POST",
    body: "{}",
  });
  const agent = assistants.find((a) => a.graph_id === "agent");
  if (!agent) throw new Error("No 'agent' assistant found");
  return agent.assistant_id;
}

export async function createThread() {
  const res = await fetch(`${DEV_API}/threads`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!res.ok) throw new Error(`Create thread failed: ${res.status}`);
  return res.json();
}

export async function runStream(
  threadId,
  assistantId,
  input,
  runId,
  devApi = DEV_API,
) {
  const res = await fetch(`${devApi}/threads/${threadId}/runs/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      assistant_id: assistantId,
      input,
      config: { configurable: { runId, thread_id: threadId } },
      multitask_strategy: "interrupt",
      stream_mode: ["values"],
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Run stream failed: ${res.status} ${text}`);
  }
  return res;
}

export async function drainStream(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let lastEvent = null;
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;

      let event;
      try {
        event = JSON.parse(line.slice(6));
      } catch {
        throw new Error(`Malformed SSE data event: ${line.slice(0, 200)}`);
      }

      lastEvent = event;

      if (
        event.event === "error" ||
        (event.event === "values" && event.data?.execution?.status === "failed")
      ) {
        const errMsg =
          event.data?.diagnostics?.errors?.[0] ||
          event.data?.error ||
          JSON.stringify(event);
        throw new Error(`Graph run failed: ${errMsg}`);
      }

      if (event.event === "values" || event.event === "updates") {
        process.stdout.write(".");
      }
    }
  }

  if (lastEvent?.data?.execution?.status !== "complete") {
    throw new Error(
      `Run ended prematurely. Final status: ${lastEvent?.data?.execution?.status ?? "unknown"}`,
    );
  }

  return { lastEvent };
}

export function parseArgs(args) {
  const parsed = {
    namespace: null,
    pillar: null,
    topic: null,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--pillar") {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error("--pillar requires a value");
      parsed.pillar = args[++i];
    } else if (arg === "--topic") {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error("--topic requires a value");
      parsed.topic = args[++i];
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    } else if (!parsed.namespace) {
      parsed.namespace = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return parsed;
}

function showHelp() {
  console.log(`
Usage: pnpm --filter youtube-shorts-orchestrator resume <namespace|topic> [options]

Options:
  --pillar <pillar>    Override pillar (takes precedence over run.json; warns if different)
  --topic <topic>      Override topic (required for legacy runs without run.json)
  --dry-run            Show status and exit without running
  --help, -h           Show this help

Examples:
  pnpm resume why-your-brain-makes-you-remember-things-that-never-happened-20260817-230021-56a1
  pnpm resume "why your brain" --pillar Psychology --topic "Why Your Brain Makes You Remember Things That Never Happened"
  pnpm resume <ns> --dry-run
`);
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  if (parsed.help || !parsed.namespace) {
    showHelp();
    process.exit(0);
  }

  const ns = resolveNamespace(parsed.namespace);
  const pillarOverride = parsed.pillar;
  const topicOverride = parsed.topic;
  const dryRun = parsed.dryRun;

  const meta = readRunMeta(ns);
  const manifest = readManifest(ns);

  if (!manifest) {
    console.error(`No manifest.json in ${ns}`);
    process.exit(1);
  }

  printStatus(ns, meta, manifest);

  const status = getStageStatus(manifest);
  if (status.publish === "complete") {
    console.log(
      "\nRun already published (publish artifact complete). Nothing to resume.",
    );
    process.exit(0);
  }

  if (dryRun) {
    console.log("\nDry run complete. Use without --dry-run to resume.");
    process.exit(0);
  }

  let pillar = meta?.pillar;
  let topic = meta?.topic;

  if (pillarOverride) {
    if (pillar && pillar !== pillarOverride) {
      console.warn(
        `WARNING: overriding stored pillar "${pillar}" with "${pillarOverride}". Research/cache keys may change and research may regenerate.`,
      );
    }
    pillar = pillarOverride;
  }
  if (topicOverride) {
    if (topic && topic !== topicOverride) {
      console.warn(
        `WARNING: overriding stored topic "${topic}" with "${topicOverride}".`,
      );
    }
    topic = topicOverride;
  }

  if (!pillar) {
    console.error(
      "\nERROR: No pillar found. Provide --pillar <pillar> for this run.",
    );
    process.exit(1);
  }
  if (!topic) {
    console.error(
      "\nERROR: No topic found. Provide --topic <topic> for this run.",
    );
    process.exit(1);
  }

  console.log("\nResuming...");
  console.log(`  Topic: ${topic}`);
  console.log(`  Pillar: ${pillar}`);

  let assistantId;
  try {
    assistantId = await getAssistantId();
  } catch (e) {
    console.error(`Failed to get assistant: ${e.message}`);
    process.exit(1);
  }

  try {
    await resumeRun(ns, { pillar, topic }, { assistantId });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  console.log(`\nArtifacts in: runs/${ns}`);
}

/**
 * Orchestrates a resume: create a fresh thread, record it in run.json
 * history (fail closed — a run that cannot be recorded must not start), then
 * stream the run replaying through the artifact cache.
 *
 * Deps are injectable for tests; defaults hit the real dev server.
 */
export async function resumeRun(
  ns,
  { pillar, topic },
  {
    assistantId = "",
    projectId = "",
    youtubePublishAt = "",
    createThread: createThreadImpl = createThread,
    runStream: runStreamImpl = runStream,
    drainStream: drainStreamImpl = drainStream,
    recordThread = async (threadId) => {
      createOrAppendRunMeta(RUNS_DIR, ns, {
        threadId,
        topic,
        pillar,
        ...(projectId ? { projectId } : {}),
      });
    },
  } = {},
) {
  const newThread = await createThreadImpl();
  const threadId = newThread.thread_id;
  console.log(`  Created thread: ${threadId}`);

  // Record every attempted thread in run.json history, even if the run fails,
  // so threadHistory is an audit trail of resume attempts.
  await recordThread(threadId);

  const input = {
    project: {
      pillar,
      topic,
      // projectId ties the Sheet row to the run; youtubePublishAt is only
      // seeded by run-next (new or resume) and never by the manual resume CLI.
      ...(projectId ? { projectId } : {}),
      ...(youtubePublishAt ? { youtubePublishAt } : {}),
    },
  };
  console.log(`  Starting run...`);
  const stream = await runStreamImpl(threadId, assistantId, input, ns);
  const { lastEvent } = await drainStreamImpl(stream);
  console.log("\nRun complete.");
  if (lastEvent?.event === "values" && lastEvent.data?.execution?.status) {
    console.log(`Final status: ${lastEvent.data.execution.status}`);
  }
  return { threadId, lastEvent };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) ===
    fileURLToPath(pathToFileURL(process.argv[1]).href)
) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
