import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Logger } from '../src/logger.js';
import { AssetCache } from '../src/storage/cache.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('AssetCache cache nonce', () => {
  it('keeps the normal key byte-compatible and makes each nonce distinct', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gemini-cache-nonce-'));
    try {
      const cache = new AssetCache(new Logger('error'), dir);
      const normal = cache.key('a prompt', 'image');
      assert.equal(cache.key('a prompt', 'image', {}), normal);
      assert.equal(
        cache.key('a prompt', 'image', { cacheNonce: 'a' }),
        cache.key('a prompt', 'image', { cacheNonce: 'a' }),
      );
      assert.notEqual(cache.key('a prompt', 'image', { cacheNonce: 'a' }), normal);
      assert.notEqual(
        cache.key('a prompt', 'image', { cacheNonce: 'a' }),
        cache.key('a prompt', 'image', { cacheNonce: 'b' }),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not let a fresh nonce read an older cached entry', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'gemini-cache-nonce-'));
    try {
      const cache = new AssetCache(new Logger('error'), dir);
      await cache.put('a prompt', 'image', [{ filename: 'image-1', buffer: PNG }], {
        cacheNonce: 'first',
      });

      assert.equal(await cache.has('a prompt', 'image', { cacheNonce: 'first' }), true);
      assert.equal(await cache.has('a prompt', 'image', { cacheNonce: 'second' }), false);
      assert.equal(await cache.has('a prompt', 'image'), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
