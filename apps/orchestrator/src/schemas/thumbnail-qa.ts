import { z } from "zod";

export const ThumbnailQaSchema = z.object({
  status: z.enum(["pass", "fail"]),
  issues: z.array(z.string()).default([]),
});

export type ThumbnailQa = z.infer<typeof ThumbnailQaSchema>;

export const ThumbnailFallbackReasonSchema = z
  .object({
    code: z.enum(["thumbnail_qa_failed", "thumbnail_qa_unavailable"]),
    issues: z.array(z.string()),
  })
  .optional();

export type ThumbnailFallbackReason = z.infer<
  typeof ThumbnailFallbackReasonSchema
>;
