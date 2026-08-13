import { z } from "zod";

export const PublishReadyStatusSchema = z.object({
  status: z.enum(["ready", "blocked"]).optional(),
  issues: z.array(z.string()).optional(),
});

export type PublishReadyStatus = z.input<typeof PublishReadyStatusSchema>;
