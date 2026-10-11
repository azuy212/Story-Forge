import type { FastifyReply, FastifyRequest } from 'fastify';

/** Reported in /health as part of the shared provider health contract. */
export const SERVICE_NAME = 'gemini-image-provider';

export interface HealthRouteDeps {
  /** True once the browser has been started AND authenticated. */
  authenticated: () => boolean;
}

/**
 * GET /health — reports browser readiness without depending on it, so the
 * endpoint answers while a lazy browser start is still in flight.
 */
export function createHealthHandler(deps: HealthRouteDeps) {
  return async function health(_request: FastifyRequest, _reply: FastifyReply) {
    return {
      status: 'ok',
      service: SERVICE_NAME,
      authenticated: deps.authenticated(),
      browserReady: deps.authenticated(),
    };
  };
}
