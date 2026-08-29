export interface PipelineNode {
  label: string;
  phase?: string;
}

export interface PipelineStage {
  name: string;
  nodes: PipelineNode[];
}

export const PIPELINE_STAGES: PipelineStage[] = [
  {
    name: "Research",
    nodes: [
      { label: "Research", phase: "researching sources" },
      { label: "Research QA", phase: "reviewing research quality" },
    ],
  },
  {
    name: "Story Plan",
    nodes: [{ label: "Story Plan", phase: "building story structure" }],
  },
  {
    name: "Script",
    nodes: [
      { label: "Script", phase: "generating script" },
      { label: "Script QA", phase: "checking script" },
    ],
  },
  {
    name: "Scene Direction",
    nodes: [{ label: "Scene Direction", phase: "planning visual direction" }],
  },
  {
    name: "Enrichment",
    nodes: [
      { label: "Metadata", phase: "generating metadata" },
      { label: "Thumbnail", phase: "generating thumbnail" },
    ],
  },
  {
    name: "Asset Strategy",
    nodes: [{ label: "Asset Strategy", phase: "searching source assets" }],
  },
  {
    name: "Scene Prompts",
    nodes: [
      { label: "Scene Prompts", phase: "generating scene prompts" },
      { label: "Prompt QA", phase: "reviewing scene prompts" },
    ],
  },
  {
    name: "Scene Assets",
    nodes: [{ label: "Scene Assets", phase: "generating images" }],
  },
  {
    name: "Prompt Repair",
    nodes: [{ label: "Prompt Repair", phase: "repairing rejected prompts" }],
  },
  {
    name: "Narration",
    nodes: [{ label: "Narration", phase: "generating voice audio" }],
  },
  {
    name: "Subtitles",
    nodes: [{ label: "Subtitles", phase: "generating subtitles" }],
  },
  {
    name: "Video Composition",
    nodes: [{ label: "Video Composition", phase: "rendering video" }],
  },
  {
    name: "Release Validation",
    nodes: [
      { label: "Release Validation", phase: "validating release package" },
    ],
  },
  {
    name: "Release Review",
    nodes: [{ label: "Release Review", phase: "reviewing release package" }],
  },
  {
    name: "Publish Ready",
    nodes: [{ label: "Publish Ready", phase: "checking publish readiness" }],
  },
  {
    name: "Publisher",
    nodes: [{ label: "Publisher", phase: "uploading video" }],
  },
];

export function getAllNodeLabels(): string[] {
  return PIPELINE_STAGES.flatMap((s) => s.nodes.map((n) => n.label));
}

export function getTotalNodeCount(): number {
  return PIPELINE_STAGES.reduce((sum, s) => sum + s.nodes.length, 0);
}

export function getStageForNode(label: string): PipelineStage | undefined {
  return PIPELINE_STAGES.find((s) => s.nodes.some((n) => n.label === label));
}

export function getNodePhase(label: string): string | undefined {
  const stage = getStageForNode(label);
  if (!stage) return undefined;
  const node = stage.nodes.find((n) => n.label === label);
  return node?.phase;
}
