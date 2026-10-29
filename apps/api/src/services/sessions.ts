import { createHash, randomBytes } from 'node:crypto';
import type { Database, OrgRole, SessionDoc, UserDoc } from '@nexus/database';
import type { Config } from '../config.js';

export interface AuthContext {
  sessionId: string;
  csrfToken: string;
  user: UserDoc;
  orgId: string;
  orgRole: OrgRole;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Server-side sessions. The browser holds only an opaque random token (HttpOnly cookie); only its SHA-256 is stored,
 * so a database leak does not yield usable sessions.
 */
export class SessionService {
  constructor(private readonly db: Database, private readonly cfg: Config) {}

  async create(userId: string, orgId: string): Promise<{ token: string; session: SessionDoc }> {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const session: SessionDoc = {
      _id: crypto.randomUUID(),
      tokenHash: hash(token),
      userId,
      orgId,
      csrfToken: randomBytes(24).toString('base64url'),
      createdAt: now,
      lastSeenAt: now,
      idleExpiresAt: new Date(now.getTime() + this.cfg.sessionIdleTtlMs),
      expiresAt: new Date(now.getTime() + this.cfg.sessionAbsoluteTtlMs),
      revokedAt: null,
    };
    await this.db.c.sessions.insertOne(session);
    return { token, session };
  }

  /** Resolves a cookie token to an auth context, re-checking user and membership on every request (revocation is immediate). */
  async resolve(token: string): Promise<AuthContext | null> {
    const s = await this.db.c.sessions.findOne({ tokenHash: hash(token) });
    const now = new Date();
    if (!s || s.revokedAt || s.expiresAt <= now || s.idleExpiresAt <= now) return null;
    const [user, membership] = await Promise.all([
      this.db.c.users.findOne({ _id: s.userId }),
      this.db.c.orgMemberships.findOne({ orgId: s.orgId, userId: s.userId }),
    ]);
    if (!user || user.disabledAt || !membership) return null;
    // Slide the idle window at most once a minute to avoid a write per request.
    if (now.getTime() - s.lastSeenAt.getTime() > 60_000) {
      await this.db.c.sessions.updateOne(
        { _id: s._id },
        { $set: { lastSeenAt: now, idleExpiresAt: new Date(Math.min(s.expiresAt.getTime(), now.getTime() + this.cfg.sessionIdleTtlMs)) } },
      );
    }
    return { sessionId: s._id, csrfToken: s.csrfToken, user, orgId: s.orgId, orgRole: membership.role };
  }

  async revoke(sessionId: string): Promise<void> {
    await this.db.c.sessions.updateOne({ _id: sessionId }, { $set: { revokedAt: new Date() } });
  }

  async revokeToken(token: string): Promise<void> {
    await this.db.c.sessions.updateOne({ tokenHash: hash(token), revokedAt: null }, { $set: { revokedAt: new Date() } });
  }

  async revokeForUserInOrg(userId: string, orgId: string): Promise<number> {
    const r = await this.db.c.sessions.updateMany({ userId, orgId, revokedAt: null }, { $set: { revokedAt: new Date() } });
    return r.modifiedCount;
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await this.db.c.sessions.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
  }
}
