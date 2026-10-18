import { mkdir, writeFile } from 'fs/promises';
import path from 'path';
import type { Config } from '../config.js';
import { Logger } from '../logger.js';
import { GeminiClient } from '../core/gemini-client.js';
import { createApp } from '../http/app.js';
import { buildOutputPath, detectMediaExt } from '../storage/asset-downloader.js';
import type { AssetType } from '../core/types.js';

/** JSON shape of a successful `POST /generate` response (Accept: application/json). */
interface GenerateJsonResponse {
  prompt: string;
  type: AssetType;
  count: number;
  fromCache: boolean;
  media: Array<{ filename: string; mime: string; base64: string }>;
}

/** Error envelope shape every service failure follows. */
interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
}

export interface BatchSummaryItem {
  prompt: string;
  ok: boolean;
  assetDir?: string;
  assetFilenames?: string[];
  fromCache?: boolean;
  error?: { code: string; message: string; requestId?: string };
}

export interface BatchDeps {
  /**
   * Injectable client so tests can stub generation without a browser.
   * Defaults to the real GeminiClient with the same lazy-start wiring as
   * the HTTP server.
   */
  client?: GeminiClient;
}

/**
 * Batch generation that drives the same `POST /generate` flow the orchestrator
 * invoked: request-schema validation, the cache short-circuit (a cache hit
 * never starts the browser), lazy browser start, retry semantics inside
 * GeminiClient, and the provider error envelope. The Fastify app is exercised
 * in-process via `app.inject()` — no HTTP listener is opened, and each prompt
 * that fails logs its envelope code and continues to the next one.
 */
export async function runBatchGeneration(
  config: Config,
  logger: Logger,
  prompts: string[],
  assetType: AssetType,
  deps: BatchDeps = {},
): Promise<BatchSummaryItem[]> {
  const client = deps.client ?? new GeminiClient(config, logger);

  let browserStarting: Promise<void> | null = null;
  const startBrowser = (): Promise<void> => {
    if (browserStarting) return browserStarting;
    browserStarting = (async () => {
      logger.info('Starting browser (lazy init)...');
      await client.start();
      await client.waitForAuthentication();
    })().catch((error) => {
      browserStarting = null;
      throw error;
    });
    return browserStarting;
  };

  const app = createApp({ config, logger, client, ensureBrowser: startBrowser });
  app.addHook('onClose', async () => {
    logger.info('Shutting down browser...');
    await client.shutdown();
  });

  const handleSignal = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down gracefully...`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));

  const summary: BatchSummaryItem[] = [];

  try {
    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i];
      const label = `[${i + 1}/${prompts.length}]`;
      logger.info(`${label} Generating`, { prompt: prompt.substring(0, 60), assetType });

      const response = await app.inject({
        method: 'POST',
        url: '/generate',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        payload: { prompt, type: assetType },
      });

      if (response.statusCode >= 400) {
        const body = response.json<ErrorEnvelope | null>();
        const code = body?.error?.code ?? 'unknown_error';
        const message = body?.error?.message ?? response.body;
        const requestId = body?.error?.requestId;
        logger.error(`${label} Failed`, { code, message, requestId });
        summary.push({ prompt, ok: false, error: { code, message, requestId } });
        continue;
      }

      const body = response.json<GenerateJsonResponse>();
      const saved = await saveGeneratedMedia(config, body);
      logger.info(`${label} Done`, {
        assets: saved.assetFilenames.length,
        fromCache: body.fromCache,
        dir: saved.assetDir,
      });
      summary.push({
        prompt,
        ok: true,
        assetDir: saved.assetDir,
        assetFilenames: saved.assetFilenames,
        fromCache: body.fromCache,
      });
    }
  } finally {
    await app.close();
  }

  const succeeded = summary.filter((item) => item.ok).length;
  const failed = summary.length - succeeded;
  logger.info('Batch complete', { total: prompts.length, succeeded, failed });

  return summary;
}

/**
 * Saves the base64 media of a successful /generate response to disk, mirroring
 * the asset layout the orchestrator produces per prompt:
 * `<downloadDir>/<date>/<slug>/<name>.<ext>` plus a `metadata.json`.
 */
async function saveGeneratedMedia(
  config: Config,
  body: GenerateJsonResponse,
): Promise<{ assetDir: string; assetFilenames: string[] }> {
  const assetDir = buildOutputPath(config.downloadDir, body.prompt);
  await mkdir(assetDir, { recursive: true });

  const assetFilenames: string[] = [];

  for (const media of body.media ?? []) {
    const buffer = Buffer.from(media.base64, 'base64');
    const ext = detectMediaExt(buffer, body.type);
    const name = `${media.filename.replace(/\.[^.]+$/, '')}.${ext}`;
    await writeFile(path.join(assetDir, name), buffer);
    assetFilenames.push(name);
  }

  await writeFile(
    path.join(assetDir, 'metadata.json'),
    JSON.stringify(
      {
        prompt: body.prompt,
        timestamp: new Date().toISOString(),
        assetType: body.type,
        assetCount: assetFilenames.length,
        assetFilenames,
      },
      null,
      2,
    ),
  );

  return { assetDir, assetFilenames };
}
