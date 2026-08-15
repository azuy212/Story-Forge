import { z } from "zod";

export const PublishStatusSchema = z.enum([
  "uploaded",
  "published",
  "scheduled",
  "private",
]);

export const PublishResultSchema = z.object({
  platform: z.string(),
  platformVideoId: z.string(),
  url: z.string(),
  status: PublishStatusSchema,
  publishedAt: z.string(),
});

export const PublishingSchema = z.object({
  results: z.array(PublishResultSchema).optional(),
  publishedAt: z.string().optional(),
});

export type PublishStatus = z.input<typeof PublishStatusSchema>;
export type PublishResult = z.input<typeof PublishResultSchema>;
export type Publishing = z.input<typeof PublishingSchema>;
