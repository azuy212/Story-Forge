import { z } from "zod";

const AssetPromptSchema = z.object({
  sceneId: z
    .number()
    .int("sceneId must be whole number")
    .positive("sceneId must be positive"),
  assetType: z.enum(["image", "video"]),
  generationPrompt: z
    .string()
    .min(40, "generationPrompt must be at least 40 characters"),
});

export const ImagePromptOutputSchema = z.object({
  assets: z
    .array(AssetPromptSchema)
    .min(1, "must have at least one asset")
    .superRefine((assets, ctx) => {
      const seen = new Set<number>();
      for (const a of assets) {
        if (seen.has(a.sceneId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Duplicate sceneId: ${a.sceneId}`,
          });
        }
        seen.add(a.sceneId);
      }
    }),
});

export type ImagePromptOutput = z.input<typeof ImagePromptOutputSchema>;
