import { z } from "zod";

/**
 * Persisted state machine for a single platform publication, keyed by
 * `publicationId` (runId:platform). Idempotency depends on this artifact:
 * the videoId is recorded the moment YouTube confirms the upload, so a
 * retried run resumes from persisted state instead of uploading again.
 */
export const PublicationStatusSchema = z.enum([
  "pending",
  "uploading",
  "uploaded",
  "finalizing",
  "scheduled",
  "published",
  "failed",
]);

export const PublicationErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
});

export const PublicationArtifactSchema = z.object({
  publicationId: z.string(),
  platform: z.string(),
  status: PublicationStatusSchema,
  videoId: z.string().optional(),
  thumbnailUploaded: z.boolean().optional(),
  playlistIds: z.array(z.string()).optional(),
  publishAt: z.string().optional(),
  error: PublicationErrorSchema.optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** One publication artifact per run; the map is keyed by publicationId. */
export const PublicationsStateSchema = z.record(
  z.string(),
  PublicationArtifactSchema,
);

export type PublicationStatus = z.input<typeof PublicationStatusSchema>;
export type PublicationError = z.input<typeof PublicationErrorSchema>;
export type PublicationArtifact = z.input<typeof PublicationArtifactSchema>;
export type PublicationsState = z.input<typeof PublicationsStateSchema>;
