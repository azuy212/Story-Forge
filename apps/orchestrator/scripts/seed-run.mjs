#!/usr/bin/env node
// Seed-driven run launcher.
//
// Feeds pre-written research (and optionally a script) into the pipeline so
// the LLM research/script producers are skipped. The graph's entry router
// (apps/orchestrator/src/graph/index.ts) jumps straight to ScriptPlanner
// (research only) or VisualDirector (research + script), bypassing
// ResearchAgent, ResearchQA, ScriptWriter, and ScriptQA.
//
// Usage (from apps/orchestrator):
//   node scripts/seed-run.mjs --seed ./my-seed.json [--profile short|long]
//
// Seed JSON shape:
// {
//   "pillar": "Psychology",
//   "topic": "Why Your Brain Remembers Things That Never Happened",
//   "videoProfile": "short",            // optional, defaults to short
//   "research": {
//     "summary": "One-paragraph research brief.",
//     "facts": [
//       "id": "f1", "fact": "...", "confidence": "high", "classification": "study"
//     ]
//   },
//   "content": {
//     "script": "Full narration/script text.",
//     "narration": "Optional; defaults to script.",
//     "title": "Optional short title.",
//     "hook": "Optional opening hook.",
//     "ending": { "type": "twist", "narration": "Optional payoff line." }
//   }
// }
//
// Two modes are supported; the script auto-detects which one applies, or
// --convert / --no-convert force a choice:
//
//   Mode A — Structured (bypasses the LLM convert call):
//     The seed JSON matches the strict shape above (research is an object with
//     summary + facts, content is an object with script). It's validated and
//     fed straight to the graph. No OpenRouter call is made. pillar + topic
//     are required (use --pillar/--topic if not in the file).
//
//   Mode B — Text/paragraph (LLM-converts to structured):
//     Triggered by either a .txt / .md seed file or a JSON seed whose
//     `research` and/or `script` field is a freeform string. The text is sent
//     to the LLM with SEED_CONVERT_PROMPT; the LLM returns pillar + topic
//     (unless flags/file already supply them) plus research + content.
//     Plain-text seeds therefore work without --pillar/--topic.
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createOrAppendRunMeta } from "../src/artifacts/run-meta.mjs";
import { logger } from "../dist/utils/logger.js";
import { closeAllRunLogSinks } from "../dist/utils/run-log.js";
import { getAssistantId, resumeRun } from "./resume.mjs";
import {
  reemitSseEventToSink,
  setActiveSink as setRunNextActiveSink,
} from "./run-next.mjs";
import { config } from "../dist/utils/config.js";
import { buildSeed } from "./seed-build.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNS_DIR =
  process.env.ARTIFACT_STORE_DIR || join(__dirname, "..", "runs");
const DEV_API = process.env.LANGGRAPH_URL || "http://localhost:2024";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

// Prompt that converts a creator's loose research notes / raw script into the
// strict seed JSON shape this script feeds to the graph (research.{summary,
// facts} + content.{script, narration, ...} + pillar + topic). Used only when
// the seed file supplies freeform strings instead of the structured form.
const SEED_CONVERT_PROMPT = `You convert a creator's rough research notes and optional raw script into the structured JSON a YouTube-Shorts pipeline consumes.

Return ONLY JSON (no prose) with this exact shape:
{
  "pillar": "string — single high-level category (e.g. Geography, Psychology, History, Science, Technology)",
  "topic": "string — the specific angle of this short, written as a short title",
  "research": {
    "summary": "string — 2-4 sentence neutral brief of the key points",
    "facts": [
      { "id": "f1", "fact": "string — one concrete claim", "confidence": "high|medium|low", "classification": "study|statistic|expert|anecdote|general" }
    ]
  },
  "content": {
    "title": "string — short punchy title",
    "hook": "string — one opening line that creates curiosity",
    "script": "string — full spoken narration, written for the ear, no stage directions",
    "narration": "string — same as script (or a tighter edit if script has headings)",
    "ending": { "type": "twist|revelation|callback|open_question|surprising_implication", "narration": "string — final payoff line" }
  }
}

Rules:
- Every fact in "facts" must be grounded in the provided notes; do not invent sources.
- "id" is sequential f1, f2, ...
- "pillar" is one short category label; choose the single best fit.
- "topic" is the specific angle; mirror the creator's framing when present.
- If a script was provided, reformat it into clean spoken narration (keep all facts, drop markdown/headings); otherwise write a tight script from the research sized for a short.
- Keep the creator's wording and intent; do not change the topic or pillar.`;

// Loose input = research and/or script supplied as raw strings rather than the
// strict object form. Detected so we can LLM-convert before validating.
function isLooseSeed(raw) {
  if (typeof raw.research === "string") return true;
  if (typeof raw.script === "string") return true;
  if (raw.content && typeof raw.content === "string") return true;
  return false;
}

async function convertLooseSeed(raw, overrides) {
  const apiKey = config.openrouterApiKey();
  const model = config.defaultModel();
  const pillar = overrides.pillar || raw.pillar || "";
  const topic = overrides.topic || raw.topic || "";
  const researchText = typeof raw.research === "string" ? raw.research : "";
  const scriptText =
    typeof raw.script === "string"
      ? raw.script
      : raw.content && typeof raw.content === "string"
        ? raw.content
        : (raw.content?.script ?? "");

  const userContent = `Pillar: ${pillar}
Topic: ${topic}

Research notes:
${researchText}

${
  scriptText
    ? `Provided script (reformat into clean narration, keep all facts):\n${scriptText}`
    : "No script provided — write a tight script from the research."
}`;

  const res = await fetch(`${OPENROUTER_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: SEED_CONVERT_PROMPT },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
      temperature: 0.4,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(
      `seed conversion LLM failed ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error("seed conversion returned invalid JSON");
  }
  if (!parsed?.research || !parsed?.content?.script) {
    throw new Error(
      "seed conversion output missing research or content.script",
    );
  }
  if (
    typeof parsed.pillar !== "string" ||
    !parsed.pillar.trim() ||
    typeof parsed.topic !== "string" ||
    !parsed.topic.trim()
  ) {
    throw new Error("seed conversion output missing pillar or topic");
  }
  // Preserve pillar/topic metadata from the original file/overrides when
  // present, fall back to the LLM-derived values otherwise.
  return {
    ...raw,
    pillar: overrides.pillar || raw.pillar || parsed.pillar.trim(),
    topic: overrides.topic || raw.topic || parsed.topic.trim(),
    research: parsed.research,
    content: parsed.content,
  };
}

function slugify(value) {
  return (
    String(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

function formatRunStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const ms = String(date.getMilliseconds()).padStart(3, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "-",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    ".",
    ms,
  ].join("");
}

function buildNamespace(topic) {
  return `${formatRunStamp()}-${slugify(topic)}`;
}

function parseArgs(args) {
  const parsed = {
    seed: null,
    pillar: null,
    topic: null,
    profile: null,
    convert: null, // null=auto, true=force LLM convert, false=force bypass
    publishAt: null,
    projectId: null,
    dryRun: false,
    help: false,
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--convert") {
      parsed.convert = true;
    } else if (arg === "--no-convert") {
      parsed.convert = false;
    } else if (arg === "--seed") {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error("--seed requires a path to a JSON file");
      parsed.seed = args[++i];
    } else if (arg === "--pillar") {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error("--pillar requires a value");
      parsed.pillar = args[++i];
    } else if (arg === "--topic") {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error("--topic requires a value");
      parsed.topic = args[++i];
    } else if (arg === "--profile") {
      const val = args[++i];
      if (val !== "short" && val !== "long")
        throw new Error("--profile must be 'short' or 'long'");
      parsed.profile = val;
    } else if (arg === "--publish-at") {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error("--publish-at requires an ISO 8601 datetime");
      const val = args[++i];
      const t = Date.parse(val);
      if (Number.isNaN(t))
        throw new Error(`--publish-at: invalid ISO 8601 datetime: ${val}`);
      parsed.publishAt = new Date(t).toISOString();
    } else if (arg === "--project-id") {
      if (!args[i + 1] || args[i + 1].startsWith("--"))
        throw new Error("--project-id requires a value");
      parsed.projectId = args[++i];
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return parsed;
}

function showHelp() {
  console.log(`
Usage: node scripts/seed-run.mjs --seed <seed.json|txt> [options]

Feeds your own research (and script) into the pipeline, skipping the LLM
research and script producers.

Modes (auto-detected unless --convert / --no-convert is set):
  Structured  Seed is strict JSON (research.{summary,facts},
              content.{script,...}) — validated and passed to the graph
              directly, no LLM call.
  Text        Seed is a .txt/.md file, or JSON whose research/script fields
              are freeform strings — an LLM converts it to the structured
              form (requires OPENROUTER_API_KEY). The LLM also derives
              pillar + topic when not supplied via flags/file.

Options:
  --seed <path>           Path to a seed file (.json, .txt, or .md)
  --pillar <pillar>       Override pillar from the seed (required for structured
                          without pillar; text/loose mode lets the LLM derive it)
  --topic <topic>         Override topic from the seed (required for structured
                          without topic; text/loose mode lets the LLM derive it)
  --profile <short|long>  Video profile (defaults to seed file or short)
  --publish-at <iso>      Schedule the YouTube publish at an ISO 8601 datetime
                          (requires YOUTUBE_PRIVACY_STATUS=private)
  --project-id <id>       Sheet row id to link this run to (for backlog sync)
  --convert               Force LLM conversion even if input looks structured
  --no-convert            Force bypass; reject if input isn't strict structured
  --dry-run               Validate + show plan, do not run
  --help, -h              Show this help

Examples:
  node scripts/seed-run.mjs --seed structured.json
  node scripts/seed-run.mjs --seed notes.txt --pillar Psychology --topic "Why..."
  node scripts/seed-run.mjs --seed partial.json --convert
`);
}

// Validate + normalize the seed file into graph-input channels. Fail-closed:
// an incomplete seed is rejected here rather than silently falling back to the
// full LLM flow (which would surprise the caller).
// buildSeed is imported from ./seed-build.mjs so resume can apply the exact
// same normalization and keep the artifact cache input hashes stable.

async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  if (parsed.help || !parsed.seed) {
    showHelp();
    process.exit(parsed.seed ? 0 : 1);
  }

  if (!existsSync(parsed.seed)) {
    console.error(`Seed file not found: ${parsed.seed}`);
    process.exit(1);
  }

  // Read the seed. Two file kinds:
  //   - .txt / .md  → text mode (whole file is the research paragraph; convert
  //                   via LLM). Requires --pillar and --topic.
  //   - .json       → JSON mode (structured or loose; auto-detected below).
  const isTextFile = /\.(txt|md)$/i.test(parsed.seed);
  let raw;
  if (isTextFile) {
    if (!parsed.pillar || !parsed.topic) {
      console.log(
        "seed: no --pillar/--topic supplied; the LLM will derive them from the text",
      );
    }
    raw = {
      pillar: parsed.pillar,
      topic: parsed.topic,
      research: readFileSync(parsed.seed, "utf-8"),
    };
  } else {
    try {
      raw = JSON.parse(readFileSync(parsed.seed, "utf-8"));
    } catch (e) {
      console.error(`Failed to parse seed JSON: ${e.message}`);
      process.exit(1);
    }
  }

  // Decide conversion: explicit flag wins; otherwise auto (loose → convert,
  // strict → bypass). Text files always convert regardless of --no-convert,
  // since there's no other way to produce a structured seed.
  const loose = isTextFile || isLooseSeed(raw);
  const doConvert = parsed.convert === true
    ? true
    : parsed.convert === false
      ? isTextFile
        ? true
        : false
      : loose;

  if (doConvert) {
    const mode = isTextFile ? "text/paragraph" : "loose JSON";
    console.log(
      `Seed is ${mode} — converting research/script into pipeline format via LLM...`,
    );
    try {
      raw = await convertLooseSeed(raw, {
        pillar: parsed.pillar,
        topic: parsed.topic,
      });
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  } else {
    console.log("Seed is structured — bypassing LLM conversion.");
  }

  let built;
  try {
    built = buildSeed(raw, { pillar: parsed.pillar, topic: parsed.topic });
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }

  const { pillar, topic, videoProfile, seed } = built;
  const ns = buildNamespace(topic);

  console.log(`\nSeed run namespace: ${ns}`);
  console.log(`  Topic: ${topic}`);
  console.log(`  Pillar: ${pillar}`);
  console.log(`  Profile: ${videoProfile}`);
  console.log(
    `  Plan: ${seed.content.script ? "research + script → VisualDirector" : "research → ScriptPlanner"}`,
  );
  console.log(
    `  Publish: ${parsed.publishAt ? `scheduled at ${parsed.publishAt}` : "immediate (uploads as configured privacy)"}`,
  );

  if (parsed.dryRun) {
    console.log("\nDry run complete. Remove --dry-run to run.");
    process.exit(0);
  }

  createOrAppendRunMeta(RUNS_DIR, ns, {
    topic,
    pillar,
    videoProfile,
    runSource: "seed",
    // Persist the exact seed payload so a future `pnpm resume <ns>` can
    // re-inject it and the artifact cache input hashes stay stable.
    seed,
  });
  await logger.setRunContext(ns, topic, 1);
  setRunNextActiveSink(logger.getCurrentSink());

  logger.info(`Seeding run: ${ns}`);
  logger.info(
    `  Topic: ${topic} | Pillar: ${pillar} | Profile: ${videoProfile}`,
  );

  let assistantId;
  try {
    assistantId = await getAssistantId();
  } catch (e) {
    logger.error(`Failed to get assistant: ${e.message}`);
    process.exit(1);
  }

  try {
    const { lastEvent } = await resumeRun(
      ns,
      { pillar, topic, videoProfile, runSource: "seed" },
      {
        assistantId,
        seed,
        ...(parsed.publishAt ? { youtubePublishAt: parsed.publishAt } : {}),
        ...(parsed.projectId ? { projectId: parsed.projectId } : {}),
        onEvent: (event) => reemitSseEventToSink(event),
      },
    );
    const status =
      lastEvent?.data?.execution?.status === "complete" ? "complete" : "failed";
    await logger.finalize(status);
  } catch (e) {
    await logger.finalize("failed", e.message);
    logger.error(e.message);
    process.exit(1);
  }

  logger.info(`Artifacts in: runs/${ns}`);
  await closeAllRunLogSinks();
  setRunNextActiveSink(null);
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
