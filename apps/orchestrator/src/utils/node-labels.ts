import { AgentModel } from "../models/agent-model.js";

const LABELS: Record<string, string> = {
  [AgentModel.ResearchAgent]: "research",
  [AgentModel.ResearchQA]: "research review",
  [AgentModel.ScriptPlanner]: "story plan",
  [AgentModel.ScriptWriter]: "script generation",
  [AgentModel.ScriptQA]: "script review",
  [AgentModel.MetadataGenerator]: "metadata",
  [AgentModel.ThumbnailGenerator]: "thumbnail",
  [AgentModel.VisualDirector]: "scene direction",
  [AgentModel.AssetStrategy]: "asset strategy",
  [AgentModel.ImagePromptGenerator]: "scene prompts",
  [AgentModel.PromptQA]: "prompt review",
  [AgentModel.AssetGenerator]: "scene assets",
  [AgentModel.ImagePromptRepair]: "prompt repair",
  [AgentModel.NarrationGenerator]: "narration",
  [AgentModel.SubtitleGenerator]: "subtitles",
  [AgentModel.VideoComposer]: "video composition",
  [AgentModel.ReleaseValidation]: "release validation",
  [AgentModel.ReleaseReview]: "release review",
  [AgentModel.Publisher]: "publishing",
  PublishReady: "publish readiness",
};

export function nodeLabel(agent: string): string {
  return LABELS[agent] ?? agent;
}

export function nodeStart(agent: string): string {
  return `Processing ${nodeLabel(agent)}`;
}

export function nodeDone(agent: string): string {
  return `${nodeLabel(agent)} complete`;
}

export function nodeFailed(agent: string): string {
  return `${nodeLabel(agent)} failed`;
}

export function nodeIncomplete(agent: string): string {
  return `${nodeLabel(agent)} incomplete`;
}

export function nodeSkipped(agent: string): string {
  return `${nodeLabel(agent)} skipped`;
}
