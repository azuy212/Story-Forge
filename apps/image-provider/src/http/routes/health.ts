import type { FastifyReply, FastifyRequest } from 'fastify';

export interface HealthRouteDeps {
  /** True once the browser has been started AND authenticated. */
  authenticated: () => boolean;
}

/**
 * GET /health — reports browser readiness without depending on it, so the
 * endpoint answers while a lazy browser start is still in flight.
 */
export function createHealthHandler(deps: HealthRouteDeps) {
  return async function health(
    _request: FastifyRequest,
    _reply: FastifyReply,
  ) {
    return { status: 'ok', authenticated: deps.authenticated(), browserReady: deps.authenticated() };
  };
}
