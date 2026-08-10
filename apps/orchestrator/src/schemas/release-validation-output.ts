import { z } from "zod";

export const ReleaseValidationOutputSchema = z.object({
  status: z.enum(["approved", "fatal"]),
  issues: z.array(z.string()).optional(),
  validations: z.array(z.string()).optional(),
});

export type ReleaseValidationOutput = z.input<typeof ReleaseValidationOutputSchema>;
