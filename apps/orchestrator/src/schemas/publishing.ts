import { z } from "zod";

export const PublishResultSchema = z.object({
  platform: z.string(),
  publishUrl: z.string(),
  status: z.string(),
  publishedAt: z.string(),
});

export const PublishingSchema = z.object({
  results: z.array(PublishResultSchema).optional(),
  publishedAt: z.string().optional(),
});

export type PublishResult = z.input<typeof PublishResultSchema>;
export type Publishing = z.input<typeof PublishingSchema>;
