import { z } from "zod";

export const ContentSchema = z.object({
  title: z.string().optional(),
  hook: z.string().optional(),
  script: z.string().optional(),
  narration: z.string().optional(),
  callToAction: z.string().optional(),
  estimatedDurationSeconds: z.number().int().positive().optional(),
});

export type Content = z.input<typeof ContentSchema>;
