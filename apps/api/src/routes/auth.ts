import { DevLoginBody, SessionInfo } from '@nexus/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '../config.js';
import { AppError } from '../errors.js';
import { checkOrigin } from '../plugins/auth.js';
import type { AuditService } from '../services/audit.js';
import type { SessionService } from '../services/sessions.js';
import type { Database } from '@nexus/database';

export function authRoutes(deps: { cfg: Config; db: Database; sessions: SessionService; audit: AuditService; logoutUrl?: (() => Promise<string | null>) | undefined }) {
  const { cfg, db, sessions, audit } = deps;
  return async (app: FastifyInstance) => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const authLimit = { rateLimit: { max: cfg.authRateLimitMax, timeWindow: '1 minute' } };

    const cookieOpts = {
      httpOnly: true, secure: cfg.cookieSecure, sameSite: 'lax' as const, path: '/', maxAge: Math.floor(cfg.sessionAbsoluteTtlMs / 1000),
    };

    // Dev-only passwordless login for seeded demo users. Route is not even registered unless AUTH_MODE=dev,
    // and loadConfig() refuses AUTH_MODE=dev in production.
    if (cfg.authMode === 'dev') {
      r.post('/api/v1/auth/dev-login', {
        config: authLimit,
        schema: { tags: ['auth'], summary: 'DEV ONLY: sign in as a seeded demo user', body: DevLoginBody, response: { 200: SessionInfo } },
      }, async (req, reply) => {
        checkOrigin(req, cfg);
        const fail = new AppError(401, 'invalid_login', 'Invalid login'); // identical for unknown user / no membership
        const user = await db.c.users.findOne({ emailLower: req.body.email.toLowerCase() });
        if (!user || user.disabledAt) throw fail;
        const memberships = await db.c.orgMemberships.find({ userId: user._id }).toArray();
        let membership = memberships[0];
        if (req.body.orgSlug) {
          const org = await db.c.organizations.findOne({ slug: req.body.orgSlug });
          membership = org ? memberships.find((m) => m.orgId === org._id) : undefined;
        }
        if (!membership) throw fail;
        const org = (await db.c.organizations.findOne({ _id: membership.orgId }))!;
        // Never leave a previous session alive when someone signs in on the same browser.
        const previous = req.cookies[app.cookieName];
        if (previous) await sessions.revokeToken(previous);
        const { token, session } = await sessions.create(user._id, org._id);
        await audit.record({ orgId: org._id, actorUserId: user._id, action: 'auth.login', targetType: 'session', targetId: session._id, metadata: { mode: 'dev' } }, { requestId: req.id, ip: req.ip });
        reply.setCookie(app.cookieName, token, cookieOpts);
        return {
          user: { id: user._id, email: user.email, displayName: user.displayName },
          org: { id: org._id, slug: org.slug, name: org.name },
          orgRole: membership.role, csrfToken: session.csrfToken, authMode: cfg.authMode,
        };
      });
    }

    r.get('/api/v1/auth/session', {
      onRequest: app.authenticate,
      schema: { tags: ['auth'], summary: 'Current session (also returns the CSRF token for state-changing requests)', response: { 200: SessionInfo } },
    }, async (req) => {
      const a = req.auth!;
      const org = (await db.c.organizations.findOne({ _id: a.orgId }))!;
      return {
        user: { id: a.user._id, email: a.user.email, displayName: a.user.displayName },
        org: { id: org._id, slug: org.slug, name: org.name },
        orgRole: a.orgRole, csrfToken: a.csrfToken, authMode: cfg.authMode,
      };
    });

    r.post('/api/v1/auth/logout', {
      onRequest: app.authenticate,
      schema: { tags: ['auth'], summary: 'Revoke the current session; returns the identity provider logout URL when there is one', response: { 200: z.object({ redirect: z.string().nullable() }) } },
    }, async (req, reply) => {
      const a = req.auth!;
      await sessions.revoke(a.sessionId);
      // Must repeat the attributes used when setting it: browsers ignore deletion of a __Host- cookie without Secure.
      reply.clearCookie(app.cookieName, { path: '/', httpOnly: true, secure: cfg.cookieSecure, sameSite: 'lax' });
      // The session is already revoked; an audit-store hiccup must not turn a successful logout into a 500.
      try {
        await audit.record({ orgId: a.orgId, actorUserId: a.user._id, action: 'auth.logout', targetType: 'session', targetId: a.sessionId }, { requestId: req.id, ip: req.ip });
      } catch (err) {
        req.log.error({ err }, 'failed to audit logout');
      }
      // With OIDC, also end the provider's own session (RP-initiated logout) so "sign out" really signs out.
      return reply.code(200).send({ redirect: deps.logoutUrl ? await deps.logoutUrl() : null });
    });
  };
}
