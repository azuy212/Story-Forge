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
  // Identifies how this run was launched so downstream side effects (e.g.
  // Google Sheets writeback) can route to the correct sheet. "backlog" is
  // the run-next backlog sheet for the profile; "seed" is the dedicated
  // seed-run sheet. Undefined falls back to profile-based routing.
  runSource: z.enum(["backlog", "seed"]).optional(),
});

export type ProjectInfo = z.input<typeof ProjectSchema>;
