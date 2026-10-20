import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { normalizeImagesPrompt } from '../src/core/prompt-text.js';

describe('normalizeImagesPrompt', () => {
  it('collapses line breaks into single spaces', () => {
    const prompt = 'Heading\n\nScene: a ship\r\nCharacters:\n- sailor';
    assert.equal(normalizeImagesPrompt(prompt), 'Heading Scene: a ship Characters: - sailor');
  });

  it('keeps single-line prompts untouched while trimming the edges', () => {
    assert.equal(
      normalizeImagesPrompt('  flat vector, white background \n'),
      'flat vector, white background',
    );
  });

  it('never leaves a doubled space behind a removed newline', () => {
    assert.equal(normalizeImagesPrompt('one \n\n two\t\tthree'), 'one two three');
  });

  it('preserves length-sensitive content other than whitespace', () => {
    const prompt = 'A stick figure — holding a flag (1720s), "land ahoy!"';
    assert.equal(normalizeImagesPrompt(prompt), prompt);
  });
});
