import type { Page } from 'playwright';
import type { Logger } from '../logger.js';

/**
 * Reads the UI's own failure message when a generation produced nothing.
 *
 * Extracted from GeminiClient so the pattern list — which mirrors
 * `classifyGeminiError` — lives in one place and can be reasoned about without
 * the browser lifecycle.
 *
 * The page-side query records whether an element sits inside navigation
 * chrome, and `selectFailureText` decides from that record. Keeping the
 * decision pure is what makes the sidebar regression testable from a recorded
 * snapshot instead of a live account.
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

/** One visible text node as recorded from the page. */
export interface VisibleTextEntry {
  tag: string;
  text: string;
  /** True when the element sits inside the sidebar / navigation chrome. */
  inChrome: boolean;
}

const IGNORED_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);
const MAX_TEXT_LENGTH = 500;

/**
 * Shortest recorded text matching a known failure pattern, or null.
 *
 * Chrome is ignored, and so are script payloads: Google embeds its
 * WIZ_global_data blob in inline scripts, which contains every word the
 * patterns look for.
 */
export function selectFailureText(
  entries: readonly VisibleTextEntry[],
  patterns: readonly string[] = ERROR_PATTERNS,
): string | null {
  const candidates = entries.filter(
    (entry) =>
      !entry.inChrome &&
      !IGNORED_TAGS.has(entry.tag.toUpperCase()) &&
      entry.text.length > 0 &&
      entry.text.length <= MAX_TEXT_LENGTH,
  );

  for (const pattern of patterns) {
    const match = candidates
      .filter((entry) => entry.text.toLowerCase().includes(pattern))
      .sort((left, right) => left.text.length - right.text.length)[0];

    if (match) return match.text;
  }

  return null;
}

export class GeminiErrorDetector {
  constructor(private readonly deps: ErrorDetectorDeps) {}

  /** Shortest visible text matching a known failure pattern, or null. */
  async detectGenerationError(): Promise<string | null> {
    const page = this.deps.getPage();
    if (!page) return null;

    // Avoid broad :has-text selectors. They can match html/script ancestors and
    // return Google's entire WIZ_global_data payload instead of the UI error.
    const entries = await page.locator('body *:visible').evaluateAll(
      (elements, chrome): VisibleTextEntry[] =>
        elements.map((element) => ({
          tag: element.tagName,
          text: (element.textContent || '').replace(/\s+/g, ' ').trim(),
          inChrome: element.closest(chrome) !== null,
        })),
      CHROME_SELECTOR,
    );

    return selectFailureText(entries);
  }
}
