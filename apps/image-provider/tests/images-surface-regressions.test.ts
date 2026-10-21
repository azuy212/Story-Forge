import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { selectFailureText, type VisibleTextEntry } from '../src/core/gemini-error-detector.js';
import { resultImageSrcs, type MediaCandidate } from '../src/core/media-collector.js';
import { normalizeImagesPrompt } from '../src/core/prompt-text.js';
import { chooseCreateMode } from '../src/core/create-mode.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(resolve(here, 'fixtures', name), 'utf8')) as T;

/**
 * Recorded from the live Gemini UI on 2026-10-21: the sidebar, a conversation
 * that failed with "I seem to be encountering an error", and the page's images.
 * Each case below is one defect the Images-surface port had to fix, pinned to
 * that recording so a UI change shows up here instead of in generated images.
 */
const visibleTexts = fixture<VisibleTextEntry[]>('gemini-visible-texts.json');
const imageSizes = fixture<MediaCandidate[]>('gemini-image-sizes.json');
const storyPrompt = readFileSync(resolve(here, 'fixtures', 'story-scene-prompt.txt'), 'utf8');

describe('failure scan recording', () => {
  it('records the sidebar titles that used to be misread as the run failure', () => {
    const sidebarRateLimits = visibleTexts.filter(
      (entry) => entry.inChrome && /rate limit reached/i.test(entry.text),
    );
    assert.ok(sidebarRateLimits.length > 0, 'fixture lost its sidebar rate-limit titles');
  });

  it('ignores sidebar conversation titles when the reply says nothing', () => {
    const sidebarOnly = visibleTexts.filter((entry) => entry.inChrome);
    assert.equal(
      selectFailureText(sidebarOnly),
      null,
      'a past conversation titled "Rate Limit Reached" must not fail the current run',
    );
  });

  it('finds the real failure reply outside the sidebar', () => {
    assert.equal(
      selectFailureText(visibleTexts),
      'I seem to be encountering an error. Can I try something else for you?',
    );
  });

  it('never reads script payloads even outside the sidebar', () => {
    assert.equal(
      selectFailureText([
        { tag: 'script', text: 'rate limit reached quota exceeded', inChrome: false },
      ]),
      null,
    );
  });
});

describe('image candidate recording', () => {
  it('records the 32px account avatar that used to end the poll', () => {
    const small = imageSizes.filter((candidate) => candidate.width < 100 || candidate.height < 100);
    assert.ok(small.length > 0, 'fixture lost its small chrome images');
    const avatar = small.find((candidate) => /googleusercontent/.test(candidate.src));
    assert.ok(avatar, 'fixture lost the avatar image');
    assert.ok(avatar.width <= 64 && avatar.height <= 64);
  });

  it('keeps only images large enough to be a generated result', () => {
    const srcs = resultImageSrcs(imageSizes);
    assert.ok(srcs.length > 0, 'fixture has no generated image');
    for (const src of srcs) {
      const candidate = imageSizes.find((entry) => entry.src === src);
      assert.ok(candidate && candidate.width >= 100 && candidate.height >= 100);
    }
    assert.ok(
      !srcs.some((src) => /s64-c/.test(src)),
      'the account avatar must not count as a result',
    );
  });
});

describe('story prompt recording', () => {
  it('flattens a real multi-block scene prompt to one line', () => {
    const flattened = normalizeImagesPrompt(storyPrompt);
    assert.ok(storyPrompt.includes('\n\n'), 'fixture should be multi-paragraph');
    assert.ok(!/[\r\n]/.test(flattened), 'flattened prompt must not contain line breaks');
    assert.deepEqual(
      flattened.split(' ').filter(Boolean),
      storyPrompt.split(/\s+/).filter(Boolean),
      'flattening must not drop or reorder a word',
    );
  });
});

describe('create-mode ordering', () => {
  it('re-enters the Images surface even when image mode is cached', () => {
    // Regression: the second prompt of a batch went to the chat composer
    // because the cached flag short-circuited the surface check.
    assert.equal(chooseCreateMode('image', true, true), 'images');
    assert.equal(chooseCreateMode('image', false, true), 'images');
  });

  it('falls back to the cached mode or the tools menu when the surface is absent', () => {
    assert.equal(chooseCreateMode('image', true, false), 'cached');
    assert.equal(chooseCreateMode('image', false, false), 'menu');
    assert.equal(chooseCreateMode('video', true, false), 'cached');
    assert.equal(chooseCreateMode('video', false, false), 'menu');
  });
});
