/**
 * Prompt text shaping for the Gemini Images surface.
 *
 * `/images` submits through a Quill-style editor: a prompt with line breaks is
 * delivered as several editor blocks and the surface answers with a generic
 * "I seem to be encountering an error" instead of generating. The same text as
 * one line generates normally, and the model does not need the paragraph
 * structure — the section labels ("Scene:", "Characters:", ...) carry it.
 *
 * Collapse every run of whitespace that contains a newline into a single
 * space, and trim the result, so a multi-line prompt reaches the model intact.
 */
export function normalizeImagesPrompt(prompt: string): string {
  return prompt
    .replace(/[^\S\n]*(?:\r?\n[^\S\n]*)+/g, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .trim();
}
