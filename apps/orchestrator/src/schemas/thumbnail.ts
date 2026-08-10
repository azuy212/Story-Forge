import { z } from "zod";

export const ThumbnailSchema = z.object({
  thumbnailPrompt: z.string().optional(),
  thumbnailText: z.string().optional(),
  textPosition: z.string().optional(),
  colorScheme: z.string().optional(),
  imageUrl: z.string().optional(),
  generatedAt: z.string().optional(),
});

export type Thumbnail = z.input<typeof ThumbnailSchema>;
