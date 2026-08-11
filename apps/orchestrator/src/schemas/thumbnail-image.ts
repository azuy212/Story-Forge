import { z } from "zod";

export const ThumbnailImageOutputSchema = z.object({
  sourceUrl: z.string(),
  imageUrl: z.string(),
  width: z.literal(1080),
  height: z.literal(1920),
  text: z.string(),
  textPosition: z.string(),
  compositorVersion: z.string(),
});

export type ThumbnailImageOutput = z.infer<typeof ThumbnailImageOutputSchema>;
