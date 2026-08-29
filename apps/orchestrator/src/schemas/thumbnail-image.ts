import { z } from "zod";
import { ThumbnailFallbackReasonSchema } from "./thumbnail-qa.js";

export const ThumbnailImageOutputSchema = z.object({
  sourceUrl: z.string(),
  imageUrl: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  text: z.string(),
  textPosition: z.string(),
  compositorVersion: z.string(),
  mode: z.enum(["full", "overlay"]),
  fallbackReason: ThumbnailFallbackReasonSchema,
});

export type ThumbnailImageOutput = z.infer<typeof ThumbnailImageOutputSchema>;
