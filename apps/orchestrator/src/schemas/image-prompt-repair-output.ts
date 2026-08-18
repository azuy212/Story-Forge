import { z } from "zod";

export const ImagePromptRepairOutputSchema = z.object({
  repairedPrompt: z.string().min(1),
  changes: z.array(z.string()),
  reason: z.string(),
  shouldRetry: z.boolean(),
});

export type ImagePromptRepairOutput = z.input<
  typeof ImagePromptRepairOutputSchema
>;
