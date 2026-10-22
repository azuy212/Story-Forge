import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { GeminiClient } from '../src/core/gemini-client.js';
import { ProviderError, type ProviderErrorType } from '../src/core/errors.js';
import type { AssetType, GenerationOptions, GenerationResult } from '../src/core/types.js';
import { Logger } from '../src/logger.js';
import { createApp } from '../src/http/app.js';
import type { Config } from '../src/config.js';

const CONFIG = {
  logLevel: 'error',
  cacheDir: '/tmp/gemini-test-cache',
  downloadDir: '/tmp/gemini-test-out',
  generationType: 'image',
} as unknown as Config;

function makeDeps(
  overrides: {
    generate?: (
      prompt: string,
      assetType: AssetType,
      options: GenerationOptions,
    ) => Promise<GenerationResult>;
    isCached?: (
      prompt: string,
      assetType: AssetType,
      options: GenerationOptions,
    ) => Promise<boolean>;
    ensureBrowser?: () => Promise<void>;
  } = {},
) {
  const logger = new Logger('error');
  const client = {
    isCached: overrides.isCached ?? (async () => true),
    generate:
      overrides.generate ??
      (async () => {
        throw new Error('generate not stubbed');
      }),
  } as unknown as GeminiClient;

  return {
    config: CONFIG,
    logger,
    client,
    ensureBrowser:
      overrides.ensureBrowser ??
      (async () => {
        throw new Error('browser not started');
      }),
  };
}

async function withApp<T>(
  deps: ReturnType<typeof makeDeps>,
  run: (app: ReturnType<typeof createApp>) => Promise<T>,
): Promise<T> {
  const app = createApp(deps);
  try {
    return await run(app);
  } finally {
    await app.close();
  }
}

describe('http app', () => {
  it('reports health without needing the browser', async () => {
    await withApp(makeDeps(), async (app) => {
      const response = await app.inject({ method: 'GET', url: '/health' });
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), {
        status: 'ok',
        service: 'gemini-image-provider',
        authenticated: false,
        browserReady: false,
      });
    });
  });

  it('rejects an invalid body with a 400 validation payload', async () => {
    await withApp(makeDeps(), async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/generate',
        payload: { prompt: '' },
      });
      assert.equal(response.statusCode, 400);
      const body = response.json();
      assert.equal(body.error.code, 'INVALID_REQUEST');
      assert.equal(body.error.message, 'Validation failed');
      assert.ok(body.error.requestId);
      assert.ok(Array.isArray(body.error.details));
      assert.ok(body.error.details.length > 0);
    });
  });

  it('rejects non-base64 reference images', async () => {
    await withApp(makeDeps(), async (app) => {
      const response = await app.inject({
        method: 'POST',
        url: '/generate',
        payload: {
          prompt: 'a red pixel',
          referenceImages: [
            { id: 'r1', filename: 'r.png', mime: 'image/png', base64: 'not base64!!' },
          ],
        },
      });
      assert.equal(response.statusCode, 400);
      const details = response.json().error.details;
      assert.ok(details.some((d: { field: string }) => d.field === 'referenceImages.0.base64'));
    });
  });

  it('maps a provider error into the shared error envelope', async () => {
    await withApp(
      makeDeps({
        generate: async () => {
          throw new ProviderError('policy blocked', 'content_policy', 'raw policy text');
        },
      }),
      async (app) => {
        const response = await app.inject({
          method: 'POST',
          url: '/generate',
          payload: { prompt: 'a red pixel' },
        });
        assert.equal(response.statusCode, 422);
        const { requestId, ...error } = response.json().error;
        assert.deepEqual(
          { error },
          {
            error: {
              code: 'content_policy',
              type: 'content_policy',
              message: 'policy blocked',
              rawMessage: 'raw policy text',
              provider: 'gemini',
              model: 'gemini-image-model',
              retryable: false,
            },
          },
        );
        assert.match(requestId, /^[0-9a-f]{12}$/);
      },
    );
  });

  it('marks rate limits retryable and uses 429', async () => {
    await withApp(
      makeDeps({
        generate: async () => {
          throw new ProviderError('slow down', 'rate_limit');
        },
      }),
      async (app) => {
        const response = await app.inject({
          method: 'POST',
          url: '/generate',
          payload: { prompt: 'a red pixel' },
        });
        assert.equal(response.statusCode, 429);
        assert.equal(response.json().error.retryable, true);
        assert.ok(response.json().error.requestId);
      },
    );
  });

  it('returns 503 with the envelope for an unknown failure', async () => {
    await withApp(
      makeDeps({
        generate: async () => {
          throw new Error('boom');
        },
      }),
      async (app) => {
        const response = await app.inject({
          method: 'POST',
          url: '/generate',
          payload: { prompt: 'a red pixel' },
        });
        assert.equal(response.statusCode, 503);
        assert.equal(response.json().error.type, 'server_error');
      },
    );
  });

  it('serves generated media as JSON when the caller accepts it', async () => {
    await withApp(
      makeDeps({
        generate: async () => ({
          prompt: 'a red pixel',
          assetType: 'image' as const,
          fromCache: false,
          assets: [
            {
              filename: 'image-1',
              buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            },
          ],
        }),
      }),
      async (app) => {
        const response = await app.inject({
          method: 'POST',
          url: '/generate',
          headers: { accept: 'application/json' },
          payload: { prompt: 'a red pixel' },
        });
        assert.equal(response.statusCode, 200);
        const body = response.json();
        assert.equal(body.count, 1);
        assert.equal(body.fromCache, false);
        assert.equal(body.media[0].filename, 'image-1');
        assert.ok(body.media[0].base64.length > 0);
      },
    );
  });

  it('passes an explicit cache nonce to both cache lookup and generation', async () => {
    let cachedOptions: GenerationOptions | undefined;
    let generateOptions: GenerationOptions | undefined;
    await withApp(
      makeDeps({
        isCached: async (_prompt, _assetType, options) => {
          cachedOptions = options;
          return false;
        },
        ensureBrowser: async () => {},
        generate: async (_prompt, _assetType, options) => {
          generateOptions = options;
          return {
            prompt: 'a red pixel',
            assetType: 'image' as const,
            fromCache: false,
            assets: [
              {
                filename: 'image-1',
                buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
              },
            ],
          };
        },
      }),
      async (app) => {
        const response = await app.inject({
          method: 'POST',
          url: '/generate',
          headers: { accept: 'application/json' },
          payload: { prompt: 'a red pixel', cacheNonce: 'force-1' },
        });
        assert.equal(response.statusCode, 200);
        assert.equal(cachedOptions?.cacheNonce, 'force-1');
        assert.equal(generateOptions?.cacheNonce, 'force-1');
      },
    );
  });

  it('returns raw bytes when the caller does not accept JSON', async () => {
    await withApp(
      makeDeps({
        generate: async () => ({
          prompt: 'a red pixel',
          assetType: 'image' as const,
          fromCache: true,
          assets: [
            {
              filename: 'image-1',
              buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            },
          ],
        }),
      }),
      async (app) => {
        const response = await app.inject({
          method: 'POST',
          url: '/generate',
          headers: { accept: 'text/html' },
          payload: { prompt: 'a red pixel' },
        });
        assert.equal(response.statusCode, 200);
        assert.match(response.headers['content-type'] ?? '', /^image\//);
      },
    );
  });

  it('starts the browser on a cache miss and surfaces its failure as 503', async () => {
    let browserCalls = 0;
    await withApp(
      makeDeps({
        isCached: async () => false,
        ensureBrowser: async () => {
          browserCalls += 1;
          throw new Error('auth required');
        },
      }),
      async (app) => {
        const response = await app.inject({
          method: 'POST',
          url: '/generate',
          payload: { prompt: 'a red pixel' },
        });
        assert.equal(response.statusCode, 503);
        assert.equal(response.json().error.type, 'server_error');
        assert.match(response.json().error.message, /Browser init failed/);
        assert.equal(browserCalls, 1);
      },
    );
  });
});
