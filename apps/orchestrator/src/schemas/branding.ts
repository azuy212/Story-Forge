import { z } from "zod";

export const BrandingSchema = z.object({
  channel: z.string(),
  creator: z.string(),
  cta: z.string(),
  style: z.string().optional(),
  colorPalette: z.string().optional(),
  logo: z.string().optional(),
  voice: z.string().optional(),
  platforms: z.array(z.string()).optional(),
});

export type Branding = z.input<typeof BrandingSchema>;
