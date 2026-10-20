import { z } from "zod";
import { PipelineError } from "../utils/errors.js";
import { readJsonFile } from "./atomic.js";

/**
 * Image style profiles are data files, not code (brief section 6), so a new
 * style (e.g. a different drawing treatment) is a new JSON file under
 * `prompts/story/style/`. The profile owns the prompt template, the style
 * constraints, the reading-level hard-word list, and the in-sentence
 * explanation cues that make a hard word acceptable.
 */
export const StyleProfileSchema = z.object({
  id: z.string().min(1),
  description: z.string().optional(),
  /** Must contain the six {slot} placeholders listed below. */
  promptTemplate: z.string().min(1),
  /** Explicit aspect/size request appended to every composed prompt (DP4). */
  aspectInstruction: z.string().min(1),
  hardWords: z.array(z.string().min(1)).default([]),
  /** Regex sources whose match in the same sentence explains a hard word. */
  explanationCues: z.array(z.string().min(1)).default([]),
});

export type StoryStyleProfile = z.infer<typeof StyleProfileSchema>;

export const REQUIRED_PROMPT_PLACEHOLDERS = [
  "action",
  "characters",
  "setting",
  "props",
  "lighting",
  "composition",
] as const;

export async function loadStyleProfile(
  path: string,
): Promise<StoryStyleProfile> {
  const raw = await readJsonFile<unknown>(path);
  if (raw === undefined) {
    throw new PipelineError(
      `Story style profile not found or unreadable: ${path}`,
      "STORY_STYLE_MISSING",
    );
  }
  const parsed = StyleProfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new PipelineError(
      `Story style profile ${path} is invalid: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
      "STORY_STYLE_INVALID",
    );
  }
  const missing = REQUIRED_PROMPT_PLACEHOLDERS.filter(
    (placeholder) => !parsed.data.promptTemplate.includes(`{${placeholder}}`),
  );
  if (missing.length > 0) {
    throw new PipelineError(
      `Story style profile ${path} is missing prompt placeholders: ${missing
        .map((placeholder) => `{${placeholder}}`)
        .join(", ")}`,
      "STORY_STYLE_INVALID",
    );
  }
  return parsed.data;
}
