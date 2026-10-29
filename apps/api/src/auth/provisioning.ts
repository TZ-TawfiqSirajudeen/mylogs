import type { Database, OrgRole, UserDoc } from '@nexus/database';
import type { OidcConfig, ProvisionableRole } from './oidc-config.js';

export type DenyReason =
  | 'identity_unusable' | 'email_unverified' | 'email_domain' | 'not_provisioned' | 'account_conflict' | 'account_disabled' | 'no_org_access' | 'org_missing';

export interface IdentityClaims {
  iss: string;
  sub: string;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
  preferred_username?: unknown;
  [k: string]: unknown;
}

export type Resolution =
  | { ok: true; user: UserDoc; orgId: string; orgRole: OrgRole; provisioned: boolean; bound: boolean }
  | { ok: false; reason: DenyReason; userId?: string; orgId?: string };

const RANK: Record<ProvisionableRole, number> = { member: 0, auditor: 1, admin: 2 };
const isDup = (e: unknown) => (e as { code?: number })?.code === 11000;

export const cleanName = (v: unknown, fallback: string): string => {
  const s = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 100) : '';
  return s || fallback.slice(0, 100);
};

export function domainOf(email: string): string { return email.slice(email.lastIndexOf('@') + 1); }
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;

/**
 * Decides who a validated ID token belongs to — and what they may do — using ONLY server-side state.
 *
 *  - The stable identity is (issuer, subject). An e-mail address is never an identity: it can change or be reassigned.
 *  - A first sign-in may attach to an existing, administrator-created account only when the e-mail is verified
 *    (configurable for single-tenant providers that do not emit `email_verified`) and the account is not already bound
 *    to a different subject (no account takeover by e-mail reuse).
 *  - Authorization comes from the application's own organization membership. Claims such as `role`, `roles`, `admin` or an
 *    admin-looking e-mail are ignored. Only an explicit, operator-configured group map can assign a role, only at first
 *    provisioning, and never `owner`.
 */
export async function resolveIdentity(db: Database, cfg: OidcConfig, claims: IdentityClaims, now = new Date()): Promise<Resolution> {
  const sub = String(claims.sub ?? '');
  if (!sub || sub.length > 255 || /[\u0000-\u001f]/.test(sub)) return { ok: false, reason: 'identity_unusable' };
  const email = typeof claims.email === 'string' && EMAIL.test(claims.email.trim()) ? claims.email.trim().toLowerCase() : null;
  const verified = claims.email_verified === true || claims.email_verified === 'true';
  const displayName = cleanName(claims.name ?? claims.preferred_username, email ?? sub);

  let user = await db.c.users.findOne({ externalIssuer: cfg.issuer, externalSubject: sub });
  let provisioned = false;
  let bound = false;

  if (!user) {
    // ---- first sign-in with this identity
    if (!email) return { ok: false, reason: 'identity_unusable' };
    if (cfg.requireEmailVerified && !verified) return { ok: false, reason: 'email_unverified' };
    if (cfg.allowedEmailDomains.length && !cfg.allowedEmailDomains.includes(domainOf(email))) return { ok: false, reason: 'email_domain' };

    const existing = await db.c.users.findOne({ emailLower: email });
    if (existing) {
      if (existing.disabledAt) return { ok: false, reason: 'account_disabled', userId: existing._id };
      if (existing.externalSubject && (existing.externalIssuer !== cfg.issuer || existing.externalSubject !== sub)) return { ok: false, reason: 'account_conflict', userId: existing._id };
      // Bind atomically: only if still unbound, so two racing first sign-ins cannot both claim the account.
      const r = await db.c.users.findOneAndUpdate(
        { _id: existing._id, $or: [{ externalSubject: null }, { externalSubject: { $exists: false } }] },
        { $set: { externalIssuer: cfg.issuer, externalSubject: sub } },
        { returnDocument: 'after' },
      );
      if (!r) return { ok: false, reason: 'account_conflict', userId: existing._id };
      user = r;
      bound = true;
    } else if (cfg.provisioning === 'jit') {
      const org = cfg.defaultOrgSlug ? await db.c.organizations.findOne({ slug: cfg.defaultOrgSlug }) : null;
      if (!org) return { ok: false, reason: 'org_missing' };
      const groups = Array.isArray(claims[cfg.groupsClaim]) ? (claims[cfg.groupsClaim] as unknown[]).filter((g): g is string => typeof g === 'string') : [];
      // Highest mapped role wins; no mapping -> plain member (which has NO project access until a project admin grants it).
      const role = groups.map((g) => cfg.groupRoleMap[g]).filter((r): r is ProvisionableRole => !!r).sort((a, b) => RANK[b] - RANK[a])[0] ?? 'member';
      const doc: UserDoc = {
        _id: crypto.randomUUID(), email, emailLower: email, displayName, externalIssuer: cfg.issuer, externalSubject: sub, createdAt: now, disabledAt: null,
      };
      try {
        await db.transaction(async (session) => {
          await db.c.users.insertOne(doc, { session });
          await db.c.orgMemberships.insertOne({ _id: crypto.randomUUID(), orgId: org._id, userId: doc._id, role, createdAt: now }, { session });
        });
        user = doc;
        provisioned = true;
      } catch (e) {
        if (!isDup(e)) throw e;
        return { ok: false, reason: 'account_conflict' }; // a concurrent first sign-in created it; the retry will find it
      }
    } else {
      return { ok: false, reason: 'not_provisioned' };
    }
  }

  if (user.disabledAt) return { ok: false, reason: 'account_disabled', userId: user._id };

  const memberships = await db.c.orgMemberships.find({ userId: user._id }).sort({ createdAt: 1 }).toArray();
  if (memberships.length === 0) return { ok: false, reason: 'no_org_access', userId: user._id };
  let chosen = memberships[0]!;
  if (cfg.defaultOrgSlug) {
    const org = await db.c.organizations.findOne({ slug: cfg.defaultOrgSlug });
    const m = org ? memberships.find((x) => x.orgId === org._id) : undefined;
    if (m) chosen = m;
  }

  // Profile data (display name) follows the provider; authorization data never does.
  if (displayName !== user.displayName && claims.name) await db.c.users.updateOne({ _id: user._id }, { $set: { displayName } });
  return { ok: true, user: { ...user, displayName }, orgId: chosen.orgId, orgRole: chosen.role, provisioned, bound };
}
