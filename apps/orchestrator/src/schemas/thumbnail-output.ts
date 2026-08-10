import { z } from "zod";

export const ThumbnailOutputSchema = z.object({
  thumbnailPrompt: z.string().min(1),
  thumbnailText: z.string().min(1).max(30),
  textPosition: z.string().min(1),
  colorScheme: z.string().min(1),
});

export type ThumbnailOutput = z.input<typeof ThumbnailOutputSchema>;
