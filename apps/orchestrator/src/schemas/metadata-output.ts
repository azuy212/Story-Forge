import { z } from "zod";

export const MetadataOutputSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  tags: z.array(z.string()),
  hashtags: z.array(z.string()),
  category: z.string().min(1),
  pinnedComment: z.string().min(1),
});

export type MetadataOutput = z.input<typeof MetadataOutputSchema>;
