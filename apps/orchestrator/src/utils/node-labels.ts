import { AgentModel } from "../models/agent-model.js";

const LABELS: Record<string, string> = {
  [AgentModel.ResearchAgent]: "Research",
  [AgentModel.ResearchQA]: "Research review",
  [AgentModel.ScriptPlanner]: "Story plan",
  [AgentModel.ScriptWriter]: "Script",
  [AgentModel.ScriptQA]: "Script review",
  [AgentModel.MetadataGenerator]: "Metadata",
  [AgentModel.ThumbnailGenerator]: "Thumbnail",
  [AgentModel.VisualDirector]: "Scene direction",
  [AgentModel.AssetStrategy]: "Asset strategy",
  [AgentModel.ImagePromptGenerator]: "Scene prompts",
  [AgentModel.PromptQA]: "Prompt review",
  [AgentModel.AssetGenerator]: "Scene assets",
  [AgentModel.ImagePromptRepair]: "Prompt repair",
  [AgentModel.NarrationGenerator]: "Narration",
  [AgentModel.SubtitleGenerator]: "Subtitles",
  [AgentModel.VideoComposer]: "Video composition",
  [AgentModel.ReleaseValidation]: "Release validation",
  [AgentModel.ReleaseReview]: "Release review",
  [AgentModel.Publisher]: "Publishing",
  PublishReady: "Publish readiness",
};

export function nodeLabel(agent: string): string {
  return LABELS[agent] ?? agent;
}

export function nodeStart(agent: string): string {
  return `${nodeLabel(agent)} started`;
}

export function nodeDone(agent: string, durationMs: number): string {
  return `${nodeLabel(agent)} complete (${formatDuration(durationMs)})`;
}

export function nodeRetry(
  agent: string,
  attempt: number,
  maxRetries: number,
  reason: string,
): string {
  return `${nodeLabel(agent)} retrying (${attempt}/${maxRetries}): ${reason}`;
}

export function nodeSkipped(agent: string, reason: string): string {
  return `${nodeLabel(agent)} skipped: ${reason}`;
}

export function nodeIncomplete(agent: string, detail: string): string {
  return `${nodeLabel(agent)} incomplete (${detail})`;
}

export function nodeFailed(agent: string, reason: string): string {
  return `${nodeLabel(agent)} failed: ${reason}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem ? `${mins}m ${rem.toString().padStart(2, "0")}s` : `${mins}m 00s`;
}
