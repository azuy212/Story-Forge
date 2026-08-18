import { pathToFileURL } from 'url';
import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod/v4';
import { Logger } from './logger';
import { loadConfig, type Config } from './config';
import { GeminiClient } from './gemini-client';
import { detectMediaExt, extToMime } from './asset-downloader';
import type { AssetType, GenerationOptions, GenerationResult } from './types';
import { ProviderError, type ProviderErrorType, isRetryableType } from './errors';

export const MAX_REFERENCE_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_REFERENCE_REQUEST_BYTES = 64 * 1024 * 1024;

/** HTTP status for each normalized failure type. */
const ERROR_STATUS: Record<ProviderErrorType, number> = {
  content_policy: 422,
  invalid_prompt: 422,
  rate_limit: 429,
  timeout: 504,
  server_error: 503,
  authentication: 401,
  invalid_request: 400,
  unknown: 500,
};

interface ProviderErrorPayload {
  error: {
    type: ProviderErrorType;
    message: string;
    rawMessage?: string;
    provider: string;
    model: string;
    retryable: boolean;
  };
}

/** Provider identification attached to every error payload. */
const PROVIDER_INFO = { provider: 'gemini', model: 'gemini-image-model' } as const;

function buildErrorPayload(
  err: ProviderError,
  providerInfo: { provider: string; model: string } = PROVIDER_INFO,
): ProviderErrorPayload {
  return {
    error: {
      type: err.type,
      message: err.message,
      rawMessage: err.rawMessage ?? err.message,
      provider: providerInfo.provider,
      model: providerInfo.model,
      retryable: isRetryableType(err.type),
    },
  };
}

function decodeBase64(value: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;

  const unpadded = value.replace(/=+$/, '');
  if (unpadded.length % 4 === 1) return null;

  const normalized = unpadded + '='.repeat((4 - (unpadded.length % 4)) % 4);
  const decoded = Buffer.from(normalized, 'base64');
  const canonical = decoded.toString('base64').replace(/=+$/, '');
  return canonical === unpadded && decoded.length > 0 ? decoded : null;
}

const ReferenceImageSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  mime: z.string().regex(/^image\//),
  base64: z.string().min(1),
});

export const GenerateRequestSchema = z
  .object({
    prompt: z.string().min(1, 'Prompt is required').max(4000, 'Prompt too long'),
    type: z.enum(['image', 'video']).optional().default('image'),
    mode: z.enum(['text_to_image', 'image_to_image', 'edit']).optional().default('text_to_image'),
    referenceImages: z.array(ReferenceImageSchema).max(4).optional().default([]),
  })
  .superRefine((request, ctx) => {
    request.referenceImages.forEach((reference, index) => {
      const decoded = decodeBase64(reference.base64);
      if (!decoded) {
        ctx.addIssue({
          code: 'custom',
          path: ['referenceImages', index, 'base64'],
          message: 'Reference image must contain valid Base64 data',
        });
      } else if (decoded.byteLength > MAX_REFERENCE_IMAGE_BYTES) {
        ctx.addIssue({
          code: 'custom',
          path: ['referenceImages', index, 'base64'],
          message: `Reference image exceeds ${MAX_REFERENCE_IMAGE_BYTES} raw bytes`,
        });
      }
    });
  });

type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

interface MediaPayload {
  filename: string;
  mime: string;
  base64: string;
}

function buildMediaPayload(result: GenerationResult): MediaPayload[] {
  return result.assets.map((asset) => ({
    filename: asset.filename,
    mime: extToMime(detectMediaExt(asset.buffer, result.assetType)),
    base64: asset.buffer.toString('base64'),
  }));
}

export async function startServer(config: Config, port: number): Promise<void> {
  const logger = new Logger(config.logLevel);

  const app = Fastify({
    logger: false,
    bodyLimit: MAX_REFERENCE_REQUEST_BYTES,
  });

  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept'],
    maxAge: 86400,
  });

  const client = new GeminiClient(config, logger);

  let browserReady = false;
  let browserStarting: Promise<void> | null = null;

  const ensureBrowser = (): Promise<void> => {
    if (browserReady) return Promise.resolve();
    if (browserStarting) return browserStarting;

    browserStarting = (async () => {
      logger.info('Starting browser (lazy init)...');
      await client.start();
      await client.waitForAuthentication();
      browserReady = true;
    })().catch((error) => {
      browserStarting = null;
      throw error;
    });

    return browserStarting;
  };

  app.addHook('onClose', async () => {
    logger.info('Shutting down browser...');
    await client.shutdown();
  });

  app.get(
    '/health',
    {
      schema: {
        response: {
          200: {
            type: 'object',
            properties: {
              status: { type: 'string' },
              authenticated: { type: 'boolean' },
              browserReady: { type: 'boolean' },
            },
          },
        },
      },
    },
    async () => {
      return { status: 'ok', authenticated: browserReady, browserReady };
    },
  );

  app.post<{ Body: GenerateRequest }>('/generate', async (request, reply) => {
    const result = GenerateRequestSchema.safeParse(request.body);

    if (!result.success) {
      return reply.status(400).send({
        error: 'Validation failed',
        details: result.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const { prompt, type, mode, referenceImages } = result.data;
    const assetType: AssetType = type;
    const options: GenerationOptions = { mode, referenceImages };

    logger.info('Generating asset', {
      prompt: prompt.substring(0, 60),
      assetType,
    });

    if (!(await client.isCached(prompt, assetType, options))) {
      try {
        await ensureBrowser();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error('Failed to start browser', { error: msg });
        return reply
          .status(503)
          .send(
            buildErrorPayload(
              new ProviderError(`Browser init failed: ${msg}`, 'server_error'),
              PROVIDER_INFO,
            ),
          );
      }
    }

    let generation: GenerationResult;
    try {
      generation = await client.generate(prompt, assetType, options);
    } catch (error) {
      if (error instanceof ProviderError) {
        logger.error('Generation rejected by provider', {
          type: error.type,
          message: error.message,
        });
        return reply.status(ERROR_STATUS[error.type]).send(buildErrorPayload(error, PROVIDER_INFO));
      }
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Generation failed', { error: msg });
      return reply
        .status(503)
        .send(buildErrorPayload(new ProviderError(msg, 'server_error'), PROVIDER_INFO));
    }

    if (generation.assets.length === 0) {
      return reply
        .status(503)
        .send(
          buildErrorPayload(
            new ProviderError('No assets generated', 'server_error'),
            PROVIDER_INFO,
          ),
        );
    }

    const media = buildMediaPayload(generation);

    const acceptsJson = (request.headers.accept || '').includes('application/json');

    if (acceptsJson) {
      return {
        prompt,
        type: generation.assetType,
        count: media.length,
        fromCache: generation.fromCache,
        media,
      };
    }

    const buf = generation.assets[0].buffer;
    const mime = extToMime(detectMediaExt(buf, generation.assetType));
    return reply.type(mime).send(buf);
  });

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    logger.error('Unhandled error', { error: error.message, stack: error.stack });
    const status = error.statusCode ?? 500;
    reply.status(status).send({ error: error.message || 'Internal server error' });
  });

  const handleSignal = async (signal: string) => {
    logger.info(`Received ${signal}, shutting down...`);
    await app.close();
    process.exit(0);
  };

  process.on('SIGINT', () => handleSignal('SIGINT'));
  process.on('SIGTERM', () => handleSignal('SIGTERM'));

  await app.listen({ port, host: '0.0.0.0' });
  logger.info(`API server ready at http://localhost:${port}`);
  logger.info('Endpoints:');
  logger.info('  GET  /health');
  logger.info(
    '  POST /generate  body: { "prompt": "...", "type": "image|video", "mode": "text_to_image|image_to_image|edit", "referenceImages": [] }',
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  const port = parseInt(process.env.PORT || '3000', 10);
  await startServer(config, port);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(msg);
    process.exit(1);
  });
}
