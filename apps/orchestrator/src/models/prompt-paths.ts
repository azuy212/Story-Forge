import { config as configUtils } from "../utils/config.js";

/**
 * Prompt file locations, resolved against the active prompt version.
 *
 * Every prompt ships as `<agent>/v1.md`. A candidate rollout is dropped in
 * alongside it as `<agent>/v2.md`, and `PROMPT_VERSION` selects which one the
 * pipeline loads — dropping a v2 file in does NOT switch versions by itself.
 * The default is v1, so the switch is inert until an A/B sets it explicitly,
 * and reverting is a single env change.
 */
export function promptPathsFor(version: string): Record<string, string> {
  const promptPath = (agent: string): string => `${agent}/${version}.md`;
  return {
    ResearchAgent: promptPath("research-agent"),
    ResearchQA: promptPath("research-qa"),
    ScriptPlanner: promptPath("script-planner"),
    ScriptWriter: promptPath("script-writer"),
    ScriptQA: promptPath("script-qa"),
    VisualDirector: promptPath("visual-director"),
    ImagePromptGenerator: promptPath("image-prompt-generator"),
    PromptQA: promptPath("prompt-qa"),
    ImagePromptRepair: promptPath("image-prompt-repair"),
    ReleaseReview: promptPath("release-review"),
    MetadataGenerator: promptPath("metadata-generator"),
    ThumbnailGenerator: promptPath("thumbnail-generator"),
    ThumbnailQA: promptPath("thumbnail-qa"),
  };
}

export const PromptPaths = promptPathsFor(
  configUtils.promptVersion() || "v1",
) as {
  [K in keyof ReturnType<typeof promptPathsFor>]: string;
};

export type PromptPath = (typeof PromptPaths)[keyof typeof PromptPaths];
