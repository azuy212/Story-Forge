import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyGeminiError,
  isRetryableType,
  ProviderError,
  toProviderError,
} from '../src/errors';

// Regression table for every message pattern surfaced by
// `detectGenerationError` in gemini-client, so the classifier can never
// silently drift from the text the provider actually produces.
const PATTERN_REGRESSIONS: Array<[string, string]> = [
  ['image generation failed', 'server_error'],
  ['image generation error', 'server_error'],
  ['something went wrong', 'server_error'],
  ['encountered an error', 'server_error'],
  ["can't generate this image", 'invalid_prompt'],
  ["couldn't generate an image", 'invalid_prompt'],
  ['This image violates our content policy', 'content_policy'],
  ['rate limit reached', 'rate_limit'],
  ['blocked due to a safety violation', 'content_policy'],
  ['violation of our policies', 'content_policy'],
  ['The requested image is not available', 'server_error'],
  ['unable to generate this image', 'invalid_prompt'],
  ['flagged by our filters', 'content_policy'],
];

describe('classifyGeminiError', () => {
  it('classifies every detectGenerationError pattern', () => {
    for (const [message, expected] of PATTERN_REGRESSIONS) {
      assert.equal(classifyGeminiError(message), expected, message);
    }
  });

  it('never downgrades a policy rejection to server_error', () => {
    const policyMessages = [
      "I can't generate images of some public figures.",
      'Content policy: generation refused',
      'Your prompt was flagged and blocked',
      'This was blocked by our safety systems',
    ];
    for (const message of policyMessages) {
      const type = classifyGeminiError(message);
      assert.equal(type, 'content_policy', message);
      assert.equal(isRetryableType(type), false, message);
    }
  });

  it('classifies rate limits, timeouts, and server errors as retryable', () => {
    const messages = [
      'You have reached your rate limit, try again later',
      'Too many requests, please slow down',
      'Your quota is exhausted',
    ];
    for (const message of messages) {
      assert.equal(classifyGeminiError(message), 'rate_limit', message);
    }
    assert.equal(classifyGeminiError('Generation timed out waiting for images'), 'timeout');
    for (const message of [
      'Image generation failed, please try again',
      'Something went wrong while generating',
    ]) {
      assert.equal(classifyGeminiError(message), 'server_error', message);
      assert.equal(isRetryableType(classifyGeminiError(message)), true);
    }
  });

  it('classifies authentication failures as non-retryable', () => {
    const messages = ['Please sign in to continue', 'Authentication required'];
    for (const message of messages) {
      assert.equal(classifyGeminiError(message), 'authentication', message);
      assert.equal(isRetryableType('authentication'), false);
    }
  });

  it('classifies infrastructure failures as server_error, never content_policy', () => {
    // "connection refused" / "blocked" substrings must not be misread as
    // prompt rejections: these are transport failures, not policy issues.
    const infraMessages = [
      'net::ERR_CONNECTION_REFUSED',
      'net::ERR_INTERNET_DISCONNECTED',
      'getaddrinfo ENOTFOUND api.gemini.google.com',
      'socket hang up',
      'connection reset by peer',
      'fetch failed: cause: request to google.com failed',
    ];
    for (const message of infraMessages) {
      assert.equal(classifyGeminiError(message), 'server_error', message);
      assert.equal(isRetryableType('server_error'), true, message);
    }
  });

  it('does not route generic "try again" phrasing to prompt repair', () => {
    // "try again" alone is operational text, not a prompt defect. It must
    // never trigger an LLM prompt-rewrite cycle.
    assert.equal(classifyGeminiError('try again'), 'unknown');
    assert.equal(classifyGeminiError('Please try again'), 'unknown');
  });

  it('falls back to unknown for empty or unmatched text', () => {
    assert.equal(classifyGeminiError(''), 'unknown');
    assert.equal(classifyGeminiError('completely unrelated text'), 'unknown');
  });
});

describe('ProviderError / toProviderError', () => {
  it('preserves an already-classified error', () => {
    const err = new ProviderError('blocked', 'content_policy');
    assert.equal(toProviderError(err, 'fallback'), err);
  });

  it('classifies a bare Error by its message', () => {
    const err = toProviderError(new Error("I can't depict some public figures"), 'fallback');
    assert.equal(err.type, 'content_policy');
  });

  it('carries the raw provider message alongside the normalized message', () => {
    const raw = "I can't depict some public figures";
    const err = toProviderError(new Error(raw), 'fallback');
    assert.equal(err.rawMessage, raw);
    assert.equal(err.message, raw);

    const typed = new ProviderError('blocked', 'content_policy', raw);
    assert.equal(typed.rawMessage, raw);
  });
});
