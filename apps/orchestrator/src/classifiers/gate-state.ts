import type { ProjectState } from "../schemas/project-state.js";
import type { ClassifierGate } from "./types.js";
import type { QaGateInject } from "./qa-gate.js";

function serializeFacts(
  facts:
    | {
        id: string;
        fact: string;
        confidence: string;
        classification?: string;
      }[]
    | undefined,
): string {
  if (!facts || facts.length === 0) return "";
  return facts
    .map((f) => {
      const cls = f.classification
        ? ` (classification: ${f.classification})`
        : "";
      return `- ${f.id} (confidence: ${f.confidence})${cls}: ${f.fact}`;
    })
    .join("\n");
}

function serializeBeats(
  beats:
    | {
        beatId: number;
        purpose: string;
        curiosityQuestion?: string;
        keyMessage: string;
      }[]
    | undefined,
): string {
  if (!beats || beats.length === 0) return "";
  return beats
    .map((b) => {
      const curiosity = b.curiosityQuestion
        ? `\nCuriosity Question: ${b.curiosityQuestion}`
        : "";
      return `Beat ${b.beatId}\nPurpose: ${b.purpose}${curiosity}\nKey Message: ${b.keyMessage}`;
    })
    .join("\n\n");
}

export function buildGateState(
  gate: ClassifierGate,
  state: ProjectState,
): { state: string; sceneIds?: number[]; factIds?: string[] } | null {
  switch (gate) {
    case "researchqa": {
      const facts = state.research?.facts ?? [];
      if (facts.length === 0) return null;
      const factIds = facts.map((f) => f.id);
      return {
        state: [
          `Pillar: ${state.project.pillar}`,
          `Topic: ${state.project.topic}`,
          `Summary: ${state.research?.summary ?? ""}`,
          "",
          "Facts:",
          serializeFacts(facts),
        ].join("\n"),
        factIds,
      };
    }
    case "scriptqa": {
      const content = state.content ?? {};
      if (!content.narration && !content.script) return null;
      return {
        state: [
          `Title: ${state.storyPlan?.content?.title ?? ""}`,
          `Hook: ${state.storyPlan?.content?.hook ?? ""}`,
          `Script: ${content.script ?? ""}`,
          `Narration: ${content.narration ?? ""}`,
          `CTA: ${content.callToAction ?? ""}`,
          `Estimated duration (s): ${content.estimatedDurationSeconds ?? ""}`,
          "",
          "Story beats:",
          serializeBeats(state.storyPlan?.storyBeats),
          "",
          "Research facts:",
          serializeFacts(state.research?.facts),
        ].join("\n"),
      };
    }
    case "promptqa": {
      const scenes = state.production?.scenes ?? [];
      const visualPlan = state.production?.visualPlan ?? [];
      const withPrompts = scenes.filter((s) => s.generationPrompt);
      if (withPrompts.length === 0) return null;
      const sceneIds = withPrompts.map((s) => s.sceneId);
      return {
        state: JSON.stringify(
          {
            scenes: withPrompts.map((s) => ({
              sceneId: s.sceneId,
              generationPrompt: s.generationPrompt,
              assetType: s.assetType,
              visualDescription: s.visualDescription,
              narration: s.narration,
            })),
            visualPlan: visualPlan.filter((p) => sceneIds.includes(p.sceneId)),
          },
          null,
          2,
        ),
        sceneIds,
      };
    }
    case "releasereview": {
      const content = state.content ?? {};
      if (!content.narration && !state.metadataOutput) return null;
      return {
        state: [
          `Topic: ${state.project.topic}`,
          `Title: ${content.title ?? ""}`,
          `Hook: ${content.hook ?? ""}`,
          `Narration: ${content.narration ?? ""}`,
          `Thumbnail text: ${state.thumbnail?.thumbnailText ?? ""}`,
          "",
          "Metadata:",
          JSON.stringify(state.metadataOutput ?? {}, null, 2),
          "",
          "Deterministic validations:",
          JSON.stringify(state.releaseValidation ?? {}, null, 2),
        ].join("\n"),
      };
    }
  }
}

export function injectFromConfigurable(
  configurable: Record<string, unknown> | undefined,
): QaGateInject {
  const cfg = configurable ?? {};
  return {
    createClassifier: cfg.createClassifier as QaGateInject["createClassifier"],
    runLogSink: (cfg.runLogSink as QaGateInject["runLogSink"]) ?? null,
    runId: typeof cfg.runId === "string" ? cfg.runId : undefined,
  };
}
