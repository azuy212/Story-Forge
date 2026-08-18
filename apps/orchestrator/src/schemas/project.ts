import { z } from "zod";

export const ProjectSchema = z.object({
  projectId: z.string().optional(),
  pillar: z.string(),
  topic: z.string(),
  youtubePublishAt: z.string().optional(),
  createdAt: z.string().optional(),
});

export type ProjectInfo = z.input<typeof ProjectSchema>;
