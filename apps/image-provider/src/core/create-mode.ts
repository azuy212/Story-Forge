import type { AssetType } from './types.js';

/** Which create-mode step should run for this request. */
export type CreateModeAction = 'images' | 'cached' | 'menu';

/**
 * Decide how to reach a composer for `assetType`.
 *
 * `'images'` means Gemini's dedicated Images surface is available and must be
 * used. It outranks the cached flag on purpose: a finished generation navigates
 * to its conversation, so a cached "image mode" says nothing about the page the
 * next prompt will be typed into. Skipping the surface there sent the second
 * prompt of a batch to the chat composer, which answered with text and left
 * the run polling for an image that was never requested.
 */
export function chooseCreateMode(
  assetType: AssetType,
  modeCached: boolean,
  imagesSurfaceReady: boolean,
): CreateModeAction {
  if (assetType === 'image' && imagesSurfaceReady) return 'images';
  if (modeCached) return 'cached';
  return 'menu';
}
