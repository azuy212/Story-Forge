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
  'encountering an error',
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
  // The Images surface states a spent allowance as an assurance.
  'limit resets',
  'create more images',
  'usage in settings',
];

/**
 * Sidebar chrome is excluded: it lists past conversations, and one titled
 * "Rate Limit Reached" is enough to make every later run look rate-limited.
 * Reading it here would report a failure the generation never produced.
 */
const CHROME_SELECTOR =
  'nav, [role="navigation"], gem-sidebar, mat-sidenav, [role="complementary"]';

export class GeminiErrorDetector {
  constructor(private readonly deps: ErrorDetectorDeps) {}

  /** Shortest visible text matching a known failure pattern, or null. */
  async detectGenerationError(): Promise<string | null> {
    const page = this.deps.getPage();
    if (!page) return null;

    // Avoid broad :has-text selectors. They can match html/script ancestors and
    // return Google's entire WIZ_global_data payload instead of the UI error.
    const visibleTexts = await page.locator('body *:visible').evaluateAll(
      (elements, chrome) =>
        elements
          .filter((element) => !element.closest(chrome))
          .map((element) => ({
            tag: element.tagName,
            text: (element.textContent || '').replace(/\s+/g, ' ').trim(),
          }))
          .filter(
            ({ tag, text }) =>
              !['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(tag) &&
              text.length > 0 &&
              text.length <= 500,
          ),
      CHROME_SELECTOR,
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
