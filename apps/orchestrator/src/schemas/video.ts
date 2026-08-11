import { z } from "zod";

export const VideoSchema = z.object({
  videoUrl: z.string().optional(),
  durationMs: z.number().optional(),
  resolution: z.string().optional(),
  timeline: z
    .object({
      narrativeDurationMs: z.number().nonnegative(),
      narrativeHoldMs: z.number().nonnegative(),
      outroDurationMs: z.number().nonnegative(),
      durationMs: z.number().nonnegative(),
    })
    .optional(),
  composedAt: z.string().optional(),
});

export type Video = z.input<typeof VideoSchema>;
