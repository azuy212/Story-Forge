import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { after, describe, it } from 'node:test';
import { ProviderError } from '../src/core/errors.js';
import { Logger } from '../src/logger.js';
import type { GeminiClient } from '../src/core/gemini-client.js';
import type { GenerationResult } from '../src/core/types.js';
import { runBatchGeneration } from '../src/cli/batch.js';
import type { Config } from '../src/config.js';

const roots: string[] = [];

function makeClient(
  overrides: {
    isCached?: (prompt: string) => Promise<boolean>;
    generate?: (prompt: string) => Promise<GenerationResult>;
    start?: () => Promise<void>;
  } = {},
): GeminiClient {
  return {
    start: overrides.start ?? (async () => {}),
    waitForAuthentication: async () => {},
    shutdown: async () => {},
    isCached: overrides.isCached ?? (async () => false),
    generate:
      overrides.generate ??
      (async () => {
        throw new Error('generate not stubbed');
      }),
  } as unknown as GeminiClient;
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(4)]);

describe('batch generation', () => {
  it('processes every prompt through /generate and saves the assets', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gemini-batch-test-'));
    roots.push(root);
    const config = {
      logLevel: 'error',
      cacheDir: path.join(root, 'cache'),
      downloadDir: path.join(root, 'out'),
      generationType: 'image',
    } as unknown as Config;

    const generated: string[] = [];
    const summary = await runBatchGeneration(
      config,
      new Logger('error'),
      ['first prompt', 'second prompt'],
      'image',
      {
        client: makeClient({
          generate: (prompt) => {
            generated.push(prompt);
            return Promise.resolve({
              prompt,
              assetType: 'image',
              assets: [{ filename: 'generated.png', buffer: PNG }],
              fromCache: false,
            });
          },
        }),
      },
    );

    assert.deepEqual(
      summary.map((item) => item.ok),
      [true, true],
    );
    assert.deepEqual(generated, ['first prompt', 'second prompt']);

    for (const item of summary) {
      assert.ok(item.assetDir?.startsWith(config.downloadDir as string));
      assert.deepEqual(item.assetFilenames, ['generated.png']);
      const metadata = JSON.parse(
        await readFile(path.join(item.assetDir!, 'metadata.json'), 'utf-8'),
      );
      assert.equal(metadata.prompt, item.prompt);
      assert.deepEqual(metadata.assetFilenames, ['generated.png']);
    }
  });

  it('reports the error envelope for a failing prompt and continues', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gemini-batch-test-'));
    roots.push(root);
    const config = {
      logLevel: 'error',
      cacheDir: path.join(root, 'cache'),
      downloadDir: path.join(root, 'out'),
      generationType: 'image',
    } as unknown as Config;
    const generate = async (prompt: string): Promise<GenerationResult> => {
      if (prompt === 'bad prompt') {
        throw new ProviderError('Generation rejected', 'content_policy');
      }
      return {
        prompt,
        assetType: 'image',
        assets: [{ filename: 'generated.png', buffer: PNG }],
        fromCache: false,
      };
    };

    const summary = await runBatchGeneration(
      config,
      new Logger('error'),
      ['bad prompt', 'ok prompt'],
      'image',
      {
        client: makeClient({ generate }),
      },
    );

    assert.equal(summary[0].ok, false);
    assert.equal(summary[0].error?.code, 'content_policy');
    assert.ok((summary[0].error?.message ?? '').includes('Generation rejected'));
    assert.ok(summary[0].error?.requestId);

    assert.equal(summary[1].ok, true);
  });

  it('never starts the browser on a cache hit', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gemini-batch-test-'));
    roots.push(root);
    const config = {
      logLevel: 'error',
      cacheDir: path.join(root, 'cache'),
      downloadDir: path.join(root, 'out'),
      generationType: 'image',
    } as unknown as Config;
    const summary = await runBatchGeneration(
      config,
      new Logger('error'),
      ['cached prompt'],
      'image',
      {
        client: makeClient({
          isCached: async () => true,
          start: async () => {
            throw new Error('browser must not start on cache hit');
          },
          generate: (prompt) =>
            Promise.resolve({
              prompt,
              assetType: 'image',
              assets: [{ filename: 'generated.png', buffer: PNG }],
              fromCache: true,
            }),
        }),
      },
    );

    assert.equal(summary.length, 1);
    assert.equal(summary[0].ok, true);
    assert.equal(summary[0].fromCache, true);
  });
});

after(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
});
