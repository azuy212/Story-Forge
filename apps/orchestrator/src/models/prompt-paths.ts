export const PromptPaths = {
  ResearchAgent: "research-agent/v1.md",
  ResearchQA: "research-qa/v1.md",
  ScriptPlanner: "script-planner/v1.md",
  ScriptWriter: "script-writer/v1.md",
  ScriptQA: "script-qa/v1.md",
  VisualDirector: "visual-director/v1.md",
  ImagePromptGenerator: "image-prompt-generator/v1.md",
  PromptQA: "prompt-qa/v1.md",
  ImagePromptRepair: "image-prompt-repair/v1.md",
  ReleaseReview: "release-review/v1.md",
  MetadataGenerator: "metadata-generator/v1.md",
  ThumbnailGenerator: "thumbnail-generator/v1.md",
} as const;

export type PromptPath = (typeof PromptPaths)[keyof typeof PromptPaths];
