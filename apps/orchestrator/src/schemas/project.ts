import { z } from "zod";
import { VideoProfileEnum } from "./video-profile.js";

export const ProjectSchema = z.object({
  projectId: z.string().optional(),
  pillar: z.string(),
  topic: z.string(),
  youtubePublishAt: z.string().optional(),
  createdAt: z.string().optional(),
  videoProfile: VideoProfileEnum.optional(),
  targetDurationSec: z.number().positive().optional(),
});

export type ProjectInfo = z.input<typeof ProjectSchema>;
