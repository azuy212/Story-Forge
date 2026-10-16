import type { Page } from 'playwright';
import type { ReferenceImage } from './types.js';

/**
 * Reference-image upload through Gemini's "Upload & tools" control.
 *
 * Extracted from GeminiClient: the file-input path is independent of the
 * client's browser lifecycle, and it is the one step where a *partial* upload
 * (2 of 3 accepted) must fail loudly rather than silently generate from a
 * subset.
 */
export async function uploadReferenceImages(
  page: Page,
  references: ReferenceImage[],
): Promise<void> {
  const plusButton = page.locator('button[aria-label="Upload & tools"]').first();
  await plusButton.click();

  const fileInput = page.locator('input[type="file"]').first();
  await fileInput.waitFor({ state: 'attached', timeout: 15000 });
  await fileInput.setInputFiles(
    references.map((reference) => ({
      name: reference.filename,
      mimeType: reference.mime,
      buffer: Buffer.from(reference.base64, 'base64'),
    })),
  );
  const uploadedCount = await fileInput.evaluate(
    (input) => (input as HTMLInputElement).files?.length ?? 0,
  );
  assertReferenceUploadCount(uploadedCount, references.length);
  await page.keyboard.press('Escape').catch(() => {});
}

export function assertReferenceUploadCount(uploadedCount: number, expectedCount: number): void {
  if (uploadedCount !== expectedCount) {
    throw new Error(
      `Gemini reference upload accepted ${uploadedCount} of ${expectedCount} image(s)`,
    );
  }
}
