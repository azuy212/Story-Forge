import { Annotation } from "@langchain/langgraph";
import type {
  ProjectInfo,
  Content,
  Research,
  Production,
  Branding,
  Diagnostics,
  Execution,
  ScriptPlannerOutput,
  ScriptQAOutput,
  Audio,
  Subtitles,
  Video,
  ReleaseValidationOutput,
  MetadataOutput,
  Thumbnail,
  Publishing,
  ResearchQAOutput,
} from "../types/index.js";

function merge<T>(current: T, update: Partial<T>): T {
  return { ...current, ...update };
}

function mergeDiagnostics(
  current: Diagnostics,
  update: Partial<Diagnostics>,
): Diagnostics {
  return {
    errors: [...(current.errors ?? []), ...(update.errors ?? [])],
    warnings: [...(current.warnings ?? []), ...(update.warnings ?? [])],
    scores: { ...(current.scores ?? {}), ...(update.scores ?? {}) },
    telemetry: { ...(current.telemetry ?? {}), ...(update.telemetry ?? {}) },
  };
}

const defaultContent: Content = {};
const defaultResearch: Research = {};
const defaultProduction: Production = { scenes: [] };
const defaultBranding: Branding = { channel: "", creator: "", cta: "" };
const defaultDiagnostics: Diagnostics = {
  errors: [],
  warnings: [],
  scores: {},
  telemetry: {},
};
const defaultExecution: Execution = {
  status: "pending",
  version: "0.2.0",
};

export const StateAnnotation = Annotation.Root({
  project: Annotation<ProjectInfo, Partial<ProjectInfo>>({
    reducer: merge,
  }),
  content: Annotation<Content, Partial<Content>>({
    reducer: merge,
    default: () => ({ ...defaultContent }),
  }),
  research: Annotation<Research, Partial<Research>>({
    reducer: merge,
    default: () => ({ ...defaultResearch }),
  }),
  audio: Annotation<Audio, Partial<Audio>>({
    reducer: merge,
    default: () => ({}),
  }),
  subtitles: Annotation<Subtitles, Partial<Subtitles>>({
    reducer: merge,
    default: () => ({}),
  }),
  video: Annotation<Video, Partial<Video>>({
    reducer: merge,
    default: () => ({}),
  }),
  releaseValidation: Annotation<
    ReleaseValidationOutput,
    Partial<ReleaseValidationOutput>
  >({
    reducer: merge,
  }),
  releaseReview: Annotation<
    ReleaseValidationOutput,
    Partial<ReleaseValidationOutput>
  >({
    reducer: merge,
  }),
  metadataOutput: Annotation<MetadataOutput, Partial<MetadataOutput>>({
    reducer: merge,
  }),
  thumbnail: Annotation<Thumbnail, Partial<Thumbnail>>({
    reducer: merge,
    default: () => ({}),
  }),
  publishing: Annotation<Publishing, Partial<Publishing>>({
    reducer: merge,
    default: () => ({ results: [] }),
  }),
  production: Annotation<Production, Partial<Production>>({
    reducer: merge,
    default: () => ({ ...defaultProduction }),
  }),
  branding: Annotation<Branding, Partial<Branding>>({
    reducer: merge,
    default: () => ({ ...defaultBranding }),
  }),
  diagnostics: Annotation<Diagnostics, Partial<Diagnostics>>({
    reducer: mergeDiagnostics,
    default: () => ({ ...defaultDiagnostics }),
  }),
  execution: Annotation<Execution, Partial<Execution>>({
    reducer: merge,
    default: () => ({ ...defaultExecution }),
  }),
  storyPlan: Annotation<ScriptPlannerOutput, Partial<ScriptPlannerOutput>>({
    reducer: merge,
    default: () => ({
      content: { title: "", hook: "" },
      storyType: "mystery",
      storySummary: "",
      storyBeats: [],
    }),
  }),
  scriptQA: Annotation<ScriptQAOutput, Partial<ScriptQAOutput>>({
    reducer: merge,
  }),
  researchQA: Annotation<ResearchQAOutput, Partial<ResearchQAOutput>>({
    reducer: merge,
  }),
});
