import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { OidcService } from '../auth/oidc.js';
import type { Config } from '../config.js';

export const FLOW_COOKIE = (cfg: Config) => (cfg.cookieSecure ? '__Host-nx_flow' : 'nx_flow');

/**
 * Public, unauthenticated endpoints that start and finish an interactive sign-in. Everything else under /api/v1 requires a session.
 *
 * CSRF reasoning: sign-in is a top-level GET navigation, so the usual cookie+header token does not apply. Login CSRF / forced
 * login is prevented differently: the callback only succeeds for the browser that started the flow (the flow cookie must match a
 * server-side record keyed by the one-time `state`), and records are single-use with a 10-minute lifetime.
 */
export function oidcRoutes(deps: { cfg: Config; oidc: OidcService | null }) {
  const { cfg, oidc } = deps;
  return async (app: FastifyInstance) => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const limit = { rateLimit: { max: cfg.authRateLimitMax * 3, timeWindow: '1 minute' } };
    const flowCookie = FLOW_COOKIE(cfg);
    const flowCookieOpts = { httpOnly: true, secure: cfg.cookieSecure, sameSite: 'lax' as const, path: '/', maxAge: 600 };

    r.get('/api/v1/auth/config', {
      schema: {
        tags: ['auth'], summary: 'How this deployment signs users in (public; contains no secrets)',
        response: { 200: z.object({ mode: z.enum(['dev', 'oidc']), providerName: z.string().nullable(), loginUrl: z.string().nullable(), provisioning: z.enum(['invite-only', 'jit']).nullable() }) },
      },
    }, async (_req, reply) => {
      reply.header('cache-control', 'no-store');
      return oidc
        ? { mode: 'oidc' as const, providerName: oidc.providerName, loginUrl: '/api/v1/auth/oidc/login', provisioning: oidc.provisioning }
        : { mode: 'dev' as const, providerName: null, loginUrl: null, provisioning: null };
    });

    if (!oidc) return; // dev mode: no OIDC routes exist at all

    r.get('/api/v1/auth/oidc/login', {
      config: limit,
      schema: { tags: ['auth'], summary: 'Start the OpenID Connect sign-in (redirects to the identity provider)', querystring: z.object({ returnTo: z.string().max(600).optional() }) },
    }, async (req, reply) => {
      const started = await oidc.startLogin(req.query.returnTo);
      if (!started) return reply.redirect(`${cfg.webOrigin}/?auth_error=idp_unavailable`);
      reply.header('cache-control', 'no-store');
      reply.setCookie(flowCookie, started.flowId, flowCookieOpts);
      return reply.redirect(started.url.toString());
    });

    r.get('/api/v1/auth/oidc/callback', {
      config: limit,
      schema: { tags: ['auth'], summary: 'OpenID Connect redirect URI', querystring: z.record(z.string(), z.union([z.string(), z.array(z.string())])) },
    }, async (req, reply) => {
      reply.header('cache-control', 'no-store');
      reply.header('referrer-policy', 'no-referrer');
      const q = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query as Record<string, string | string[]>)) {
        // A parameter that appears twice is ambiguous (parameter pollution): treat the whole callback as malformed.
        if (Array.isArray(v)) { reply.clearCookie(flowCookie, { path: '/', httpOnly: true, secure: cfg.cookieSecure, sameSite: 'lax' }); return reply.redirect(`${cfg.webOrigin}/?auth_error=login_failed`); }
        q.set(k, v.slice(0, 4096));
      }
      const result = await oidc.handleCallback(q, req.cookies[flowCookie], req.cookies[app.cookieName]);
      reply.clearCookie(flowCookie, { path: '/', httpOnly: true, secure: cfg.cookieSecure, sameSite: 'lax' });
      if (!result.ok) return reply.redirect(`${cfg.webOrigin}/?auth_error=${result.code}`);
      reply.setCookie(app.cookieName, result.sessionToken, { httpOnly: true, secure: cfg.cookieSecure, sameSite: 'lax', path: '/', maxAge: Math.floor(cfg.sessionAbsoluteTtlMs / 1000) });
      return reply.redirect(`${cfg.webOrigin}${result.returnTo}`);
    });
  };
}
