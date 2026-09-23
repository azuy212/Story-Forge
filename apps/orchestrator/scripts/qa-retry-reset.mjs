import {
  existsSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

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

// QC-gated pairs: which artifact types must be cleared together so the gate
// for a given frontier re-runs with a fresh retry budget. A retry budget is
// burned inside the LangGraph thread state, which is not persisted across
// resumes, but the cached producer + QA verdict artifacts replay the exact
// exhausted loop on resume — so the fix is to cache-bust the gate's inputs
// and its stored verdict (plus any residue after it).
const QC_PAIRS = {
  research: ["research", "researchQA"],
  researchQA: ["research", "researchQA"],
  script: ["script", "scriptQA"],
  scriptQA: ["script", "scriptQA"],
  visualDirector: ["visualDirector", "thumbnailImage", "prompts", "promptQA"],
  thumbnailImage: ["visualDirector", "thumbnailImage", "prompts", "promptQA"],
  prompts: ["visualDirector", "thumbnailImage", "prompts", "promptQA"],
  promptQA: ["visualDirector", "thumbnailImage", "prompts", "promptQA"],
};

function stageStatus(manifest, type) {
  const m = manifest?.[type];
  if (!m) return "missing";
  if (m.latest && m.versions) {
    const latest = m.versions.find(
      (v) => v.version === Number(String(m.latest).replace("v", "")),
    );
    return latest?.status ?? "unknown";
  }
  return "unknown";
}

export function planQaRetryReset(runsDir, ns) {
  const noop = (reason) => ({ reason, frontier: null, resetTypes: [] });

  const manifestPath = join(runsDir, ns, "manifest.json");
  if (!existsSync(manifestPath)) return noop("no-manifest");

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
  } catch {
    return noop("manifest-unreadable");
  }
  if (!manifest || typeof manifest !== "object")
    return noop("manifest-unreadable");

  if (stageStatus(manifest, "publish") === "complete")
    return noop("already-published");

  let frontierIndex = -1;
  for (let i = STAGE_ORDER.length - 1; i >= 0; i--) {
    if (stageStatus(manifest, STAGE_ORDER[i]) === "complete") {
      frontierIndex = i;
      break;
    }
  }
  if (frontierIndex === -1) return noop("no-complete-stage");

  const frontier = STAGE_ORDER[frontierIndex];
  const resetTypes = [];
  const push = (t) => {
    if (t && !resetTypes.includes(t)) resetTypes.push(t);
  };
  for (const t of QC_PAIRS[frontier] ?? [frontier]) push(t);
  // Residue from the failed attempt: any stage after the frontier that has a
  // manifest entry (complete, invalid, or pending) belongs to the discarded
  // attempt and must not replay.
  for (let i = frontierIndex + 1; i < STAGE_ORDER.length; i++) {
    if (manifest[STAGE_ORDER[i]]) push(STAGE_ORDER[i]);
  }
  resetTypes.sort((a, b) => STAGE_ORDER.indexOf(a) - STAGE_ORDER.indexOf(b));

  return { reason: null, frontier, resetTypes };
}

export function resetLastStepQaRetries(runsDir, ns, { dryRun = false } = {}) {
  const plan = planQaRetryReset(runsDir, ns);
  if (plan.reason || plan.resetTypes.length === 0) {
    return { ...plan, dryRun, deleted: {} };
  }

  const deleted = {};
  if (!dryRun) {
    const manifestPath = join(runsDir, ns, "manifest.json");
    let manifest = null;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
    } catch {
      manifest = null;
    }

    for (const type of plan.resetTypes) {
      const dir = join(runsDir, ns, "artifacts", type);
      let count = 0;
      if (existsSync(dir)) {
        count = readdirSync(dir).filter((f) => /^v\d+\.json$/.test(f)).length;
        rmSync(dir, { recursive: true, force: true });
      }
      deleted[type] = count;
    }

    if (manifest && typeof manifest === "object") {
      let changed = false;
      for (const type of plan.resetTypes) {
        if (type in manifest) {
          delete manifest[type];
          changed = true;
        }
      }
      if (changed) {
        writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
      }
    }

    const execPath = join(runsDir, ns, "state", "execution.json");
    if (existsSync(execPath)) {
      try {
        const refs = JSON.parse(readFileSync(execPath, "utf-8"));
        if (refs && typeof refs === "object") {
          let changed = false;
          for (const type of plan.resetTypes) {
            for (const k of Object.keys(refs)) {
              if (k.startsWith(`${type}@`)) {
                delete refs[k];
                changed = true;
              }
            }
          }
          if (changed) {
            writeFileSync(execPath, JSON.stringify(refs, null, 2), "utf-8");
          }
        }
      } catch {
        // corrupted execution refs; artifact delete is the source of truth
      }
    }
  }

  return { ...plan, dryRun, deleted };
}

export function describeQaRetryReset(result) {
  if (result?.reason) {
    return `QA retry reset: nothing to reset (${result.reason})`;
  }
  const verb = result.dryRun ? "would clear" : "cleared";
  const detail = result.dryRun
    ? result.resetTypes.join(", ")
    : Object.entries(result.deleted ?? {})
        .map(([t, n]) => `${t} (${n})`)
        .join(", ");
  return `QA retry reset: ${verb} frontier "${result.frontier}" — ${detail}`;
}
