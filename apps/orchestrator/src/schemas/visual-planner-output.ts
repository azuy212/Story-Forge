import { z } from "zod";
import { lenientEnum } from "./lenient-enum.js";

export const RENDER_STYLES = [
  "photorealistic",
  "illustration",
  "3D",
  "satellite",
  "map",
  "diagram",
  "macro",
  "archive-style",
  "timelapse",
] as const;

export const RenderStyleEnum = lenientEnum(RENDER_STYLES, {
  fallback: "photorealistic",
  aliases: {
    photo: "photorealistic",
    photos: "photorealistic",
    realistic: "photorealistic",
    photoreal: "photorealistic",
    "photo-real": "photorealistic",
    hyperrealistic: "photorealistic",
    liveaction: "photorealistic",
    illustrated: "illustration",
    illustration: "illustration",
    drawing: "illustration",
    sketch: "illustration",
    handdrawn: "illustration",
    painterly: "illustration",
    cartoon: "illustration",
    vector: "illustration",
    "flat-art": "illustration",
    "flat-design": "illustration",
    comic: "illustration",
    "line-art": "illustration",
    engraving: "illustration",
    etching: "illustration",
    watercolor: "illustration",
    cgi: "3D",
    "3-d": "3D",
    render: "3D",
    rendered: "3D",
    "satellite-imagery": "satellite",
    "satellite-view": "satellite",
    aerial: "satellite",
    overhead: "satellite",
    cartography: "map",
    infographic: "diagram",
    schematic: "diagram",
    chart: "diagram",
    closeup: "macro",
    "close-up": "macro",
    archive: "archive-style",
    archival: "archive-style",
    vintage: "archive-style",
    historical: "archive-style",
    "black-and-white": "archive-style",
    monochrome: "archive-style",
    sepia: "archive-style",
    "time-lapse": "timelapse",
    timelapsevideo: "timelapse",
  },
});

export const VisualPlanEntrySchema = z.object({
  sceneId: z
    .number()
    .int("sceneId must be whole number")
    .positive("sceneId must be positive"),
  renderStyle: RenderStyleEnum,
  colorMood: z.string().min(1, "colorMood must not be empty"),
  lighting: z.string().min(1, "lighting must not be empty"),
  composition: z.string().min(1, "composition must not be empty"),
  visualNotes: z.string().optional(),
});

export type VisualPlanEntry = z.input<typeof VisualPlanEntrySchema>;
export type RenderStyle = (typeof RENDER_STYLES)[number];
