import { z } from "zod";
import { ThumbnailFallbackReasonSchema } from "./thumbnail-qa.js";

export const ThumbnailSchema = z.object({
  thumbnailPrompt: z.string().optional(),
  thumbnailText: z.string().optional(),
  textPosition: z.string().optional(),
  colorScheme: z.string().optional(),
  imageUrl: z.string().optional(),
  generatedAt: z.string().optional(),
  mode: z.enum(["full", "overlay"]).optional(),
  fallbackReason: ThumbnailFallbackReasonSchema,
});

export type Thumbnail = z.input<typeof ThumbnailSchema>;
