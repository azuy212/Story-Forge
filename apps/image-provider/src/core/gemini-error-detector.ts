import type { Page } from 'playwright';
import type { Logger } from '../logger.js';

/**
 * Reads the UI's own failure message when a generation produced nothing.
 *
 * Extracted from GeminiClient so the pattern list — which mirrors
 * `classifyGeminiError` — lives in one place and can be reasoned about without
 * the browser lifecycle.
 */
export interface ErrorDetectorDeps {
  getPage: () => Page | null;
  logger: Logger;
}

const ERROR_PATTERNS = [
  'image generation failed',
  'image generation error',
  'something went wrong',
  'encountered an error',
  "can't generate",
  "couldn't generate",
  'content policy',
  'rate limit',
  'try again',
  'blocked',
  'violation',
  'not available',
  'unable to generate',
  'flagge',
];

export class GeminiErrorDetector {
  constructor(private readonly deps: ErrorDetectorDeps) {}

  /** Shortest visible text matching a known failure pattern, or null. */
  async detectGenerationError(): Promise<string | null> {
    const page = this.deps.getPage();
    if (!page) return null;

    // Avoid broad :has-text selectors. They can match html/script ancestors and
    // return Google's entire WIZ_global_data payload instead of the UI error.
    const visibleTexts = await page.locator('body *:visible').evaluateAll((elements) =>
      elements
        .map((element) => ({
          tag: element.tagName,
          text: (element.textContent || '').replace(/\s+/g, ' ').trim(),
        }))
        .filter(
          ({ tag, text }) =>
            !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(tag) && text.length > 0 && text.length <= 500,
        ),
    );

    for (const pattern of ERROR_PATTERNS) {
      const match = visibleTexts
        .filter(({ text }) => text.toLowerCase().includes(pattern))
        .sort((left, right) => left.text.length - right.text.length)[0];

      if (match) return match.text;
    }

    return null;
  }
}
