import { z } from "zod";

export const BrandingSchema = z.object({
  channel: z.string(),
  creator: z.string(),
  cta: z.string(),
  handle: z.string().optional(),
  enabled: z.boolean().optional(),
  outroAsset: z.string().optional(),
  ctaEnabled: z.boolean().optional(),
  outroCta: z.string().optional(),
  outroContainsCta: z.boolean().optional(),
  style: z.string().optional(),
  colorPalette: z.string().optional(),
  logo: z.string().optional(),
  voice: z.string().optional(),
  platforms: z.array(z.string()).optional(),
});

export type Branding = z.input<typeof BrandingSchema>;
