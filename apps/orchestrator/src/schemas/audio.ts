import { z } from "zod";

export const AudioSchema = z.object({
  narrationUrl: z.string().optional(),
  narrationDurationMs: z.number().optional(),
  voice: z.string().optional(),
  generatedAt: z.string().optional(),
});

export type Audio = z.input<typeof AudioSchema>;
