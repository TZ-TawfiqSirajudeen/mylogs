import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import type { Config } from '../config.js';
import { AppError, forbidden, unauthorized } from '../errors.js';
import type { Principal } from '../authz/policy.js';
import type { AuthContext, SessionService } from '../services/sessions.js';

declare module 'fastify' {
  interface FastifyRequest { auth: AuthContext | null }
  interface FastifyInstance {
    authenticate: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
    cookieName: string;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const principalOf = (req: FastifyRequest): Principal => {
  if (!req.auth) throw unauthorized();
  return { userId: req.auth.user._id, orgId: req.auth.orgId, orgRole: req.auth.orgRole };
};

export function checkOrigin(req: FastifyRequest, cfg: Config) {
  const origin = req.headers.origin;
  if (origin && !cfg.allowedOrigins.includes(origin)) throw new AppError(403, 'bad_origin', 'Cross-origin request rejected');
}

function csrfMatches(expected: string, given: unknown): boolean {
  if (typeof given !== 'string') return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Cookie-session authentication + CSRF defence for state-changing requests:
 *  1. Origin header (when present) must equal the configured web origin;
 *  2. `x-csrf-token` must equal the per-session token (synchronizer token, constant-time compare).
 * The cookie is HttpOnly + SameSite=Lax (+ Secure, __Host- prefixed in production).
 */
export default fp(async (app: FastifyInstance, opts: { cfg: Config; sessions: SessionService }) => {
  const { cfg, sessions } = opts;
  const cookieName = cfg.cookieSecure ? '__Host-nx_sid' : 'nx_sid';
  app.decorate('cookieName', cookieName);
  app.decorateRequest('auth', null);

  app.decorate('authenticate', async (req: FastifyRequest) => {
    const token = req.cookies[cookieName];
    if (!token) throw unauthorized();
    const ctx = await sessions.resolve(token);
    if (!ctx) throw unauthorized();
    if (!SAFE_METHODS.has(req.method)) {
      checkOrigin(req, cfg);
      if (!csrfMatches(ctx.csrfToken, req.headers['x-csrf-token'])) throw forbidden('Missing or invalid CSRF token');
    }
    req.auth = ctx;
  });
});
