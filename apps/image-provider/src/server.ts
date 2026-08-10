import { pathToFileURL } from 'url';
import Fastify, { type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod/v4';
import { Logger } from './logger';
import { loadConfig, type Config } from './config';
import { GeminiClient } from './gemini-client';
import { detectMediaExt, extToMime } from './asset-downloader';
import type { AssetType, GenerationResult } from './types';

const GenerateRequestSchema = z.object({
  prompt: z.string().min(1, 'Prompt is required').max(1000, 'Prompt too long'),
  type: z.enum(['image', 'video']).optional().default('image'),
});

type GenerateRequest = z.infer<typeof GenerateRequestSchema>;

interface MediaPayload {
  filename: string;
  mime: string;
  base64: string;
}

export async function startServer(config: Config, port: number): Promise<void> {
  const logger = new Logger(config.logLevel);

  const app = Fastify({ logger: false });

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

  const buildMediaPayload = (result: GenerationResult): MediaPayload[] => {
    return result.assets.map((asset) => ({
      filename: asset.filename,
      mime: extToMime(detectMediaExt(asset.buffer, result.assetType)),
      base64: asset.buffer.toString('base64'),
    }));
  };

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

    const { prompt, type } = result.data;
    const assetType: AssetType = type;

    logger.info('Generating asset', {
      prompt: prompt.substring(0, 60),
      assetType,
    });

    if (!(await client.isCached(prompt, assetType))) {
      try {
        await ensureBrowser();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error('Failed to start browser', { error: msg });
        return reply.status(500).send({ error: `Browser init failed: ${msg}` });
      }
    }

    const generation = await client.generate(prompt, assetType);

    if (generation.assets.length === 0) {
      return reply.status(500).send({ error: 'No assets generated' });
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
  logger.info('  POST /generate  body: { "prompt": "...", "type": "image|video" }');
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
