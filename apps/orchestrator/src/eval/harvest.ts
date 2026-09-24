import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ClassifierGate } from "../classifiers/types.js";
import { extractReference } from "./gates.js";
import type { QaEvalCase, QaReferenceMeta } from "./types.js";

type ArtifactEnvelope = {
  data?: Record<string, unknown>;
  meta?: Record<string, unknown>;
  version?: number;
  createdAt?: string;
};

const GATE_ARTIFACT_TYPE: Record<ClassifierGate, string> = {
  promptqa: "promptQA",
  researchqa: "researchQA",
  releasereview: "releaseReview",
  scriptqa: "scriptQA",
};

const SUPPORTING_ARTIFACT_TYPES = [
  "research",
  "scriptPlan",
  "script",
  "visualDirector",
  "prompts",
  "assets",
  "metadata",
  "thumbnail",
  "releaseValidation",
] as const;

function isGate(value: string): value is ClassifierGate {
  return (
    value === "promptqa" ||
    value === "researchqa" ||
    value === "releasereview" ||
    value === "scriptqa"
  );
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function loadArtifact(runDir: string, type: string): ArtifactEnvelope | null {
  const file = join(runDir, "artifacts", type, "v1.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = readFileSync(file, "utf8");
    const envelope = JSON.parse(parsed) as ArtifactEnvelope;
    if (!envelope || typeof envelope !== "object") return null;
    return envelope;
  } catch {
    return null;
  }
}

function loadSupporting(runDir: string): Map<string, ArtifactEnvelope> {
  const map = new Map<string, ArtifactEnvelope>();
  for (const type of SUPPORTING_ARTIFACT_TYPES) {
    const artifact = loadArtifact(runDir, type);
    if (artifact) map.set(type, artifact);
  }
  return map;
}

function projectReferenceMeta(
  envelope: ArtifactEnvelope,
): QaReferenceMeta | undefined {
  const meta = envelope.meta;
  if (!meta) return undefined;
  const out: QaReferenceMeta = {};
  if (typeof meta.model === "string") out.model = meta.model;
  if (typeof meta.promptTokens === "number") {
    out.promptTokens = meta.promptTokens;
  }
  if (typeof meta.completionTokens === "number") {
    out.completionTokens = meta.completionTokens;
  }
  if (typeof meta.durationMs === "number") out.durationMs = meta.durationMs;
  return Object.keys(out).length > 0 ? out : undefined;
}

function serializeFacts(facts: unknown): string {
  if (!Array.isArray(facts) || facts.length === 0) return "";
  return facts
    .map((f) => {
      const fact = f as {
        id?: string;
        fact?: string;
        confidence?: string;
        classification?: string;
      };
      const cls = fact.classification
        ? ` (classification: ${fact.classification})`
        : "";
      return `- ${fact.id ?? "?"} (confidence: ${fact.confidence ?? "?"})${cls}: ${fact.fact ?? ""}`;
    })
    .join("\n");
}

function serializeBeats(beats: unknown): string {
  if (!Array.isArray(beats) || beats.length === 0) return "";
  return beats
    .map((b) => {
      const beat = b as {
        beatId?: number;
        purpose?: string;
        curiosityQuestion?: string;
        keyMessage?: string;
      };
      const curiosity = beat.curiosityQuestion
        ? `\nCuriosity Question: ${beat.curiosityQuestion}`
        : "";
      return `Beat ${beat.beatId}\nPurpose: ${beat.purpose ?? ""}${curiosity}\nKey Message: ${beat.keyMessage ?? ""}`;
    })
    .join("\n\n");
}

function buildResearchState(
  runMeta: Record<string, unknown> | null,
  supporting: Map<string, ArtifactEnvelope>,
): { state: string; factIds: string[] } | null {
  const research = supporting.get("research")?.data;
  if (!research) return null;
  const summary = typeof research.summary === "string" ? research.summary : "";
  const facts = Array.isArray(research.facts) ? research.facts : [];
  const factIds = facts
    .map((f) => (f as { id?: string }).id)
    .filter((id): id is string => typeof id === "string");
  const pillar = typeof runMeta?.pillar === "string" ? runMeta.pillar : "";
  const topic = typeof runMeta?.topic === "string" ? runMeta.topic : "";
  const state = [
    `Pillar: ${pillar}`,
    `Topic: ${topic}`,
    `Summary: ${summary}`,
    "",
    "Facts:",
    serializeFacts(facts),
  ].join("\n");
  return { state, factIds };
}

function buildScriptState(
  supporting: Map<string, ArtifactEnvelope>,
): { state: string } | null {
  const script = supporting.get("script")?.data;
  const plan = supporting.get("scriptPlan")?.data;
  const research = supporting.get("research")?.data;
  if (!script && !plan) return null;
  const content = (script?.content ?? {}) as {
    script?: string;
    narration?: string;
    callToAction?: string;
    estimatedDurationSeconds?: number;
  };
  const planContent = (plan?.content ?? {}) as {
    title?: string;
    hook?: string;
  };
  const storyBeats = plan?.storyBeats;
  const state = [
    `Title: ${planContent.title ?? ""}`,
    `Hook: ${planContent.hook ?? ""}`,
    `Script: ${content.script ?? ""}`,
    `Narration: ${content.narration ?? ""}`,
    `CTA: ${content.callToAction ?? ""}`,
    `Estimated duration (s): ${content.estimatedDurationSeconds ?? ""}`,
    "",
    "Story beats:",
    serializeBeats(storyBeats),
    "",
    "Research facts:",
    serializeFacts(research?.facts),
  ].join("\n");
  return { state };
}

function buildPromptState(
  supporting: Map<string, ArtifactEnvelope>,
): { state: string; sceneIds: number[] } | null {
  const assets = supporting.get("assets")?.data;
  const visual = supporting.get("visualDirector")?.data;
  const prompts = supporting.get("prompts")?.data;

  const assetScenes = Array.isArray(assets?.scenes)
    ? (assets.scenes as Array<Record<string, unknown>>)
    : [];
  const promptAssets = Array.isArray(prompts?.assets)
    ? (prompts.assets as Array<Record<string, unknown>>)
    : [];
  const visualScenes = Array.isArray(visual?.scenes)
    ? (visual.scenes as Array<Record<string, unknown>>)
    : [];
  const visualPlans = Array.isArray(visual?.visualPlans)
    ? (visual.visualPlans as Array<Record<string, unknown>>)
    : [];

  const promptByScene = new Map<number, string>();
  for (const asset of assetScenes) {
    if (
      typeof asset.sceneId === "number" &&
      typeof asset.generationPrompt === "string"
    ) {
      promptByScene.set(asset.sceneId, asset.generationPrompt);
    }
  }
  for (const asset of promptAssets) {
    if (
      typeof asset.sceneId === "number" &&
      typeof asset.generationPrompt === "string" &&
      !promptByScene.has(asset.sceneId)
    ) {
      promptByScene.set(asset.sceneId, asset.generationPrompt);
    }
  }

  const sceneMeta = new Map<number, Record<string, unknown>>();
  for (const scene of visualScenes) {
    if (typeof scene.sceneId === "number") sceneMeta.set(scene.sceneId, scene);
  }

  if (promptByScene.size === 0 && visualScenes.length === 0) return null;

  const sceneIds = [
    ...new Set([
      ...promptByScene.keys(),
      ...visualScenes
        .map((s) => s.sceneId)
        .filter((id): id is number => typeof id === "number"),
    ]),
  ].sort((a, b) => a - b);

  const scenes = sceneIds.map((sceneId) => {
    const meta = sceneMeta.get(sceneId) ?? {};
    return {
      sceneId,
      generationPrompt: promptByScene.get(sceneId) ?? "",
      assetType: meta.assetType ?? "",
      visualDescription: meta.visualDescription ?? "",
      narration: meta.narration ?? "",
    };
  });

  const planByScene = new Map<number, Record<string, unknown>>();
  for (const plan of visualPlans) {
    if (typeof plan.sceneId === "number") planByScene.set(plan.sceneId, plan);
  }
  const visualPlan = sceneIds.map((sceneId) => {
    const plan = planByScene.get(sceneId) ?? {};
    return {
      sceneId,
      renderStyle: plan.renderStyle ?? "",
      colorMood: plan.colorMood ?? "",
      lighting: plan.lighting ?? "",
      composition: plan.composition ?? "",
      visualNotes: plan.visualNotes ?? "",
    };
  });

  const state = JSON.stringify({ scenes, visualPlan }, null, 2);
  return { state, sceneIds };
}

function buildReleaseState(
  runMeta: Record<string, unknown> | null,
  supporting: Map<string, ArtifactEnvelope>,
): { state: string } | null {
  const metadata = supporting.get("metadata")?.data;
  const thumbnail = supporting.get("thumbnail")?.data;
  const script = supporting.get("script")?.data;
  const validation = supporting.get("releaseValidation")?.data;
  if (!metadata && !thumbnail && !script) return null;

  const content = (script?.content ?? {}) as {
    script?: string;
    narration?: string;
  };
  const plan = supporting.get("scriptPlan")?.data;
  const planContent = (plan?.content ?? {}) as {
    title?: string;
    hook?: string;
  };
  const topic = typeof runMeta?.topic === "string" ? runMeta.topic : "";

  const state = [
    `Topic: ${topic}`,
    `Title: ${planContent.title ?? ""}`,
    `Hook: ${planContent.hook ?? ""}`,
    `Narration: ${content.narration ?? ""}`,
    `Thumbnail text: ${(thumbnail as { thumbnailText?: string } | undefined)?.thumbnailText ?? ""}`,
    "",
    "Metadata:",
    JSON.stringify(metadata ?? {}, null, 2),
    "",
    "Deterministic validations:",
    JSON.stringify(validation ?? {}, null, 2),
  ].join("\n");
  return { state };
}

function buildStateForGate(
  gate: ClassifierGate,
  runMeta: Record<string, unknown> | null,
  supporting: Map<string, ArtifactEnvelope>,
): { state: string; sceneIds?: number[]; factIds?: string[] } | null {
  switch (gate) {
    case "researchqa": {
      const built = buildResearchState(runMeta, supporting);
      return built ? { state: built.state, factIds: built.factIds } : null;
    }
    case "scriptqa":
      return buildScriptState(supporting);
    case "promptqa": {
      const built = buildPromptState(supporting);
      return built ? { state: built.state, sceneIds: built.sceneIds } : null;
    }
    case "releasereview":
      return buildReleaseState(runMeta, supporting);
  }
}

export type HarvestOptions = {
  runsDir?: string;
  gates?: ClassifierGate[];
};

function listRunDirs(runsDir: string): string[] {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => join(runsDir, entry.name))
    .sort();
}

export function harvestCases(options: HarvestOptions = {}): QaEvalCase[] {
  const runsDir = options.runsDir ?? "runs";
  const gates = (
    options.gates ??
    (["promptqa", "researchqa", "releasereview", "scriptqa"] as const)
  ).filter(isGate);

  const cases: QaEvalCase[] = [];

  for (const runDir of listRunDirs(runsDir)) {
    const ns = runDir.split("/").pop() ?? runDir;
    let runMeta: Record<string, unknown> | null = null;
    try {
      const runJsonPath = join(runDir, "run.json");
      if (existsSync(runJsonPath)) {
        runMeta = readJson(runJsonPath) as Record<string, unknown>;
      }
    } catch {
      runMeta = null;
    }

    const supporting = loadSupporting(runDir);
    const topic =
      typeof runMeta?.topic === "string" ? runMeta.topic : undefined;

    for (const gate of gates) {
      const artifact = loadArtifact(runDir, GATE_ARTIFACT_TYPE[gate]);
      if (!artifact?.data) continue;
      const reference = extractReference(gate, artifact.data);
      if (!reference) continue;

      const built = buildStateForGate(gate, runMeta, supporting);
      if (!built) continue;

      cases.push({
        id: `${ns}:${gate}:v${artifact.version ?? 1}`,
        gate,
        ns,
        state: built.state,
        reference,
        referenceMeta: projectReferenceMeta(artifact),
        sceneIds: built.sceneIds,
        factIds: built.factIds,
        topic,
      });
    }
  }

  return cases;
}
