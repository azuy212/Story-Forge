import { z } from "zod";

export const ArtifactStatusSchema = z.enum([
  "pending",
  "complete",
  "failed",
  "invalid",
  "superseded",
]);

export type ArtifactStatus = z.infer<typeof ArtifactStatusSchema>;

export const ArtifactTypeSchema = z.enum([
  "scriptPlan",
  "research",
  "researchQA",
  "script",
  "scriptQA",
  "metadata",
  "thumbnail",
  "thumbnailImage",
  "visualDirector",
  "prompts",
  "promptQA",
  "assets",
  "audio",
  "subtitles",
  "videoPlan",
  "releaseValidation",
  "releaseReview",
  "publish",
]);

export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ArtifactReferenceSchema = z.object({
  artifactId: z.string(),
  type: ArtifactTypeSchema,
  version: z.number().int().positive(),
  location: z.string(),
  runId: z.string(),
});

export type ArtifactReference = z.infer<typeof ArtifactReferenceSchema>;

export const ArtifactMetaSchema = z.object({
  inputHash: z.string(),
  promptVersion: z.string().optional(),
  promptHash: z.string().optional(),
  promptPath: z.string().optional(),
  model: z.string().optional(),
  temperature: z.number().optional(),
  producerVersion: z.string().optional(),
  agentVersion: z.string().optional(),
  runId: z.string(),
  node: z.string().optional(),
  durationMs: z.number().optional(),
  promptTokens: z.number().optional(),
  completionTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  retries: z.number().optional(),
});

export type ArtifactMeta = z.infer<typeof ArtifactMetaSchema>;

export const CacheMetaSchema = z.object({
  key: z.unknown(),
  valid: z.boolean(),
  fromCache: z.boolean(),
});

export type CacheMeta = z.infer<typeof CacheMetaSchema>;

export const ArtifactRecordSchema = z.object({
  schemaVersion: z.literal(1),
  artifactId: z.string(),
  type: ArtifactTypeSchema,
  version: z.number().int().positive(),
  status: ArtifactStatusSchema,
  createdAt: z.string(),
  meta: ArtifactMetaSchema,
  data: z.unknown(),
});

export type ArtifactRecord<T = unknown> = z.infer<
  typeof ArtifactRecordSchema
> & {
  data: T;
};

export const ManifestEntrySchema = z.object({
  version: z.number().int().positive(),
  status: ArtifactStatusSchema,
  createdAt: z.string(),
  inputHash: z.string(),
  artifactId: z.string(),
});

export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

export const ManifestSchema = z.record(
  ArtifactTypeSchema,
  z.object({
    latest: z.string(),
    versions: z.array(ManifestEntrySchema),
  }),
);

export type Manifest = z.infer<typeof ManifestSchema>;

export const CacheKeySchema = z.object({
  agent: z.string(),
  promptPath: z.string(),
  promptHash: z.string(),
  variables: z.record(z.string(), z.unknown()),
  temperature: z.number().optional(),
  responseFormat: z.unknown().optional(),
  model: z.string().optional(),
  agentVersion: z.string().optional(),
});

export type CacheKey = z.infer<typeof CacheKeySchema>;
