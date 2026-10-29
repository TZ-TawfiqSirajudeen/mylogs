import { AuditPage, AuditQuery, OrgRole } from '@nexus/contracts';
import type { ClientSession, Database } from '@nexus/database';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { canChangeOrgRole, canOrg } from '../authz/policy.js';
import { AppError, forbidden } from '../errors.js';
import { principalOf } from '../plugins/auth.js';
import type { AuditService } from '../services/audit.js';
import type { SessionService } from '../services/sessions.js';

const isDup = (e: unknown) => (e as { code?: number })?.code === 11000;
const UserIdParams = z.object({ userId: z.string().min(1).max(64) });
const InviteBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  displayName: z.string().trim().min(1).max(100).optional(),
  role: OrgRole,
});

export function orgRoutes(deps: { db: Database; audit: AuditService; sessions: SessionService }) {
  return async (app: FastifyInstance) => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const pre = { onRequest: app.authenticate };
    const ctxOf = (req: { id: string }) => ({ requestId: req.id });
    /**
     * Removes owner privilege (demotion or removal) while guaranteeing the organization keeps at least one owner. The org
     * document is written first, so two owners demoting each other at the same moment conflict and one retries (and then
     * fails) instead of both passing the check against a snapshot that still shows the other as owner.
     */
    const dropOwner = async (orgId: string, userId: string, apply: (session: ClientSession) => Promise<void>) => {
      await deps.db.transaction(async (session) => {
        await deps.db.c.organizations.updateOne({ _id: orgId }, { $set: { ownerLockAt: new Date() } }, { session });
        const others = await deps.db.c.orgMemberships.countDocuments({ orgId, role: 'owner', userId: { $ne: userId } }, { session });
        if (others === 0) throw new AppError(409, 'last_owner', 'An organization must keep at least one owner');
        await apply(session);
      });
    };

    r.get('/api/v1/audit', {
      ...pre,
      schema: { tags: ['audit'], summary: 'Audit history (owner, admin, auditor)', querystring: AuditQuery, response: { 200: AuditPage } },
    }, async (req) => {
      const p = principalOf(req);
      if (!canOrg(p, 'audit:read')) throw forbidden();
      // Always scoped to the caller's organization; projectId is only a narrowing filter.
      const page = await deps.audit.list(p.orgId, req.query);
      return {
        nextBefore: page.nextBefore,
        items: page.items.map((e) => ({
          id: e._id, seq: e.seq, action: e.action, actorUserId: e.actorUserId, actorType: e.actorType, targetType: e.targetType,
          targetId: e.targetId, projectId: e.projectId, environmentId: e.environmentId, requestId: e.requestId,
          metadata: e.metadata, createdAt: e.createdAt.toISOString(),
        })),
      };
    });

    r.get('/api/v1/org/members', {
      ...pre,
      schema: {
        tags: ['org'], summary: 'Organization members (owner, admin)',
        response: { 200: z.array(z.object({ userId: z.string(), email: z.string(), displayName: z.string(), role: OrgRole, signedInBefore: z.boolean() })) },
      },
    }, async (req) => {
      const p = principalOf(req);
      if (!canOrg(p, 'org:members:read')) throw forbidden();
      const ms = await deps.db.c.orgMemberships.find({ orgId: p.orgId }).toArray();
      const users = await deps.db.c.users.find({ _id: { $in: ms.map((m) => m.userId) } }).toArray();
      const byId = new Map(users.map((u) => [u._id, u]));
      return ms.flatMap((m) => {
        const u = byId.get(m.userId);
        return u ? [{ userId: u._id, email: u.email, displayName: u.displayName, role: m.role, signedInBefore: !!u.externalSubject }] : [];
      });
    });

    // Pre-authorizes a person. With OIDC in invite-only mode this is what lets them sign in: their first sign-in with a
    // VERIFIED matching e-mail binds the identity (issuer + subject) to this account.
    r.post('/api/v1/org/members', {
      ...pre,
      schema: { tags: ['org'], summary: 'Add or invite an organization member (owner, admin)', body: InviteBody, response: { 201: z.object({ userId: z.string(), email: z.string(), role: OrgRole }) } },
    }, async (req, reply) => {
      const p = principalOf(req);
      if (!canOrg(p, 'org:members:manage') || !canChangeOrgRole(p.orgRole, null, req.body.role)) throw forbidden();
      const { email, role } = req.body;
      const now = new Date();
      let user = await deps.db.c.users.findOne({ emailLower: email });
      if (user?.disabledAt) throw new AppError(409, 'conflict', 'This account cannot be added');
      try {
        await deps.db.transaction(async (session) => {
          if (!user) {
            user = { _id: crypto.randomUUID(), email, emailLower: email, displayName: req.body.displayName ?? email, externalSubject: null, externalIssuer: null, createdAt: now, disabledAt: null };
            await deps.db.c.users.insertOne(user, { session });
          }
          await deps.db.c.orgMemberships.insertOne({ _id: crypto.randomUUID(), orgId: p.orgId, userId: user._id, role, createdAt: now }, { session });
        });
      } catch (e) {
        if (isDup(e)) throw new AppError(409, 'conflict', 'That person is already a member');
        throw e;
      }
      await deps.audit.record({ orgId: p.orgId, actorUserId: p.userId, action: 'org.member_added', targetType: 'user', targetId: user!._id, metadata: { role } }, ctxOf(req));
      return reply.code(201).send({ userId: user!._id, email, role });
    });

    r.patch('/api/v1/org/members/:userId', {
      ...pre,
      schema: { tags: ['org'], summary: "Change a member's organization role (owner, admin)", params: UserIdParams, body: z.object({ role: OrgRole }), response: { 204: z.null() } },
    }, async (req, reply) => {
      const p = principalOf(req);
      if (!canOrg(p, 'org:members:manage')) throw forbidden();
      if (req.params.userId === p.userId) throw new AppError(409, 'conflict', 'You cannot change your own role');
      const m = await deps.db.c.orgMemberships.findOne({ orgId: p.orgId, userId: req.params.userId });
      if (!m) throw new AppError(404, 'not_found', 'Member not found');
      if (!canChangeOrgRole(p.orgRole, m.role, req.body.role)) throw forbidden();
      const setRole = async (session?: ClientSession) => { await deps.db.c.orgMemberships.updateOne({ _id: m._id, role: m.role }, { $set: { role: req.body.role } }, session ? { session } : {}); };
      if (m.role === 'owner' && req.body.role !== 'owner') await dropOwner(p.orgId, m.userId, setRole);
      else await setRole();
      // Sessions re-read the membership on every request, so this is effective at once; revoking also ends stale sessions.
      if (req.body.role !== m.role) await deps.sessions.revokeForUserInOrg(m.userId, p.orgId);
      await deps.audit.record({ orgId: p.orgId, actorUserId: p.userId, action: 'org.member_role_changed', targetType: 'user', targetId: m.userId, metadata: { from: m.role, to: req.body.role } }, ctxOf(req));
      return reply.code(204).send(null);
    });

    r.delete('/api/v1/org/members/:userId', {
      ...pre,
      schema: { tags: ['org'], summary: 'Remove a member from the organization (owner, admin)', params: UserIdParams, response: { 204: z.null() } },
    }, async (req, reply) => {
      const p = principalOf(req);
      if (!canOrg(p, 'org:members:manage')) throw forbidden();
      if (req.params.userId === p.userId) throw new AppError(409, 'conflict', 'You cannot remove yourself');
      const m = await deps.db.c.orgMemberships.findOne({ orgId: p.orgId, userId: req.params.userId });
      if (!m) throw new AppError(404, 'not_found', 'Member not found');
      if (!canChangeOrgRole(p.orgRole, m.role, null)) throw forbidden();
      const remove = async (session?: ClientSession) => {
        const o = session ? { session } : {};
        await deps.db.c.orgMemberships.deleteOne({ _id: m._id }, o);
        await deps.db.c.projectMemberships.deleteMany({ userId: m.userId, orgId: p.orgId }, o);
      };
      if (m.role === 'owner') await dropOwner(p.orgId, m.userId, remove);
      else await remove();
      await deps.sessions.revokeForUserInOrg(m.userId, p.orgId);
      await deps.audit.record({ orgId: p.orgId, actorUserId: p.userId, action: 'org.member_removed', targetType: 'user', targetId: m.userId, metadata: { role: m.role } }, ctxOf(req));
      return reply.code(204).send(null);
    });

    r.post('/api/v1/org/members/:userId/revoke-sessions', {
      ...pre,
      schema: { tags: ['org'], summary: 'Sign a member out everywhere (owner, admin)', params: UserIdParams, response: { 200: z.object({ revoked: z.number() }) } },
    }, async (req) => {
      const p = principalOf(req);
      if (!canOrg(p, 'org:members:manage')) throw forbidden();
      const m = await deps.db.c.orgMemberships.findOne({ orgId: p.orgId, userId: req.params.userId });
      if (!m) throw new AppError(404, 'not_found', 'Member not found');
      if (!canChangeOrgRole(p.orgRole, m.role, m.role)) throw forbidden();
      const revoked = await deps.sessions.revokeForUserInOrg(m.userId, p.orgId);
      await deps.audit.record({ orgId: p.orgId, actorUserId: p.userId, action: 'org.member_sessions_revoked', targetType: 'user', targetId: m.userId, metadata: { revoked } }, ctxOf(req));
      return { revoked };
    });
  };
}
