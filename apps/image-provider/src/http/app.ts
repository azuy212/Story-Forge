import cors from '@fastify/cors';
import Fastify, { type FastifyError } from 'fastify';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import type { GeminiClient } from '../core/gemini-client.js';
import { createGenerateHandler } from './routes/generate.js';
import type { GenerateRequest } from './request-schema.js';
import { createHealthHandler } from './routes/health.js';
import { MAX_REFERENCE_REQUEST_BYTES } from './request-schema.js';

export interface ServerDeps {
  config: Config;
  logger: Logger;
  client: GeminiClient;
  ensureBrowser: () => Promise<void>;
}

/**
 * Builds the HTTP app without owning any lifecycle: no browser start, no
 * signal handlers, no listen. `startServer` adds those, and tests can drive
 * the routes in-process through `app.inject()`.
 */
export function createApp(deps: ServerDeps) {
  const { config, logger, client } = deps;
  const app = Fastify({
    logger: false,
    bodyLimit: MAX_REFERENCE_REQUEST_BYTES,
  });

  let browserReady = false;

  const ensureBrowser = async (): Promise<void> => {
    if (browserReady) return;
    await deps.ensureBrowser();
    browserReady = true;
  };

  void app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept'],
    maxAge: 86400,
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
              service: { type: 'string' },
              authenticated: { type: 'boolean' },
              browserReady: { type: 'boolean' },
            },
          },
        },
      },
    },
    createHealthHandler({ authenticated: () => browserReady }),
  );

  app.post<{ Body: GenerateRequest }>(
    '/generate',
    createGenerateHandler({
      client,
      logger,
      config,
      ensureBrowser,
    }),
  );

  app.setErrorHandler((error: FastifyError, _request, reply) => {
    logger.error('Unhandled error', { error: error.message, stack: error.stack });
    const status = error.statusCode ?? 500;
    reply.status(status).send({ error: error.message || 'Internal server error' });
  });

  return app;
}
