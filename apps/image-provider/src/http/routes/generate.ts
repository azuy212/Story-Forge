import type { FastifyReply, FastifyRequest } from 'fastify';
import { ProviderError } from '../../core/errors.js';
import type { GeminiClient } from '../../core/gemini-client.js';
import type { Logger } from '../../logger.js';
import type { Config } from '../../config.js';
import type { AssetType, GenerationOptions, GenerationResult } from '../../core/types.js';
import {
  buildErrorPayload,
  buildValidationError,
  newRequestId,
  PROVIDER_INFO,
  statusForProviderError,
} from '../error-envelope.js';
import { buildMediaPayload, mediaMime } from '../payloads.js';
import { GenerateRequestSchema, type GenerateRequest } from '../request-schema.js';

export interface GenerateRouteDeps {
  client: GeminiClient;
  logger: Logger;
  config: Config;
  /**
   * Lazily brings the browser up. Only called on a cache miss — a cached hit
   * must never pay for (or trigger) browser startup.
   */
  ensureBrowser: () => Promise<void>;
}

/**
 * POST /generate.
 *
 * Extracted from startServer so the request/response handling — validation,
 * cache short-circuit, error mapping, and JSON-vs-binary response — lives
 * separately from server wiring (CORS, signals, lifecycle).
 */
export function createGenerateHandler(deps: GenerateRouteDeps) {
  return async function generate(
    request: FastifyRequest<{ Body: GenerateRequest }>,
    reply: FastifyReply,
  ) {
    const { client, logger } = deps;
    const requestId = newRequestId();

    const result = GenerateRequestSchema.safeParse(request.body);

    if (!result.success) {
      return reply.status(400).send(
        buildValidationError(
          requestId,
          result.error.issues.map((issue) => ({
            field: issue.path.join('.'),
            message: issue.message,
          })),
        ),
      );
    }

    const { prompt, type, mode, referenceImages, cacheNonce } = result.data;
    const assetType: AssetType = type;
    const options: GenerationOptions = {
      mode,
      referenceImages,
      ...(cacheNonce ? { cacheNonce } : {}),
    };

    logger.info('Generating asset', {
      prompt: prompt.substring(0, 60),
      assetType,
      ...(cacheNonce ? { cacheNonce } : {}),
    });

    if (!(await client.isCached(prompt, assetType, options))) {
      try {
        await deps.ensureBrowser();
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error('Failed to start browser', { error: msg });
        return reply
          .status(503)
          .send(
            buildErrorPayload(
              new ProviderError(`Browser init failed: ${msg}`, 'server_error'),
              PROVIDER_INFO,
              requestId,
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
        return reply
          .status(statusForProviderError(error))
          .send(buildErrorPayload(error, PROVIDER_INFO, requestId));
      }
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Generation failed', { error: msg });
      return reply
        .status(503)
        .send(buildErrorPayload(new ProviderError(msg, 'server_error'), PROVIDER_INFO, requestId));
    }

    if (generation.assets.length === 0) {
      return reply
        .status(503)
        .send(
          buildErrorPayload(
            new ProviderError('No assets generated', 'server_error'),
            PROVIDER_INFO,
            requestId,
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

    return reply.type(mediaMime(generation)).send(generation.assets[0].buffer);
  };
}
