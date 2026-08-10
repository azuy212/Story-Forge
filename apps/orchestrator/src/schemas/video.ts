import { z } from "zod";

export const VideoSchema = z.object({
  videoUrl: z.string().optional(),
  durationMs: z.number().optional(),
  resolution: z.string().optional(),
  composedAt: z.string().optional(),
});

export type Video = z.input<typeof VideoSchema>;
