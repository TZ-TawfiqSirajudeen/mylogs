import { readFileSync } from 'node:fs';

export type ProvisionableRole = 'member' | 'auditor' | 'admin';
export const PROVISIONABLE_ROLES: readonly ProvisionableRole[] = ['member', 'auditor', 'admin'];

export interface OidcConfig {
  issuer: string;
  clientId: string;
  /** Read from the environment or a mounted secret file. Never logged, never returned by any endpoint. */
  clientSecret: string | null;
  redirectUri: string;
  postLogoutRedirectUri: string;
  scopes: string[];
  providerName: string;
  /** invite-only (default): only users an administrator already added may sign in. jit: create a member on first sign-in. */
  provisioning: 'invite-only' | 'jit';
  defaultOrgSlug: string | null;
  allowedEmailDomains: string[];
  requireEmailVerified: boolean;
  groupsClaim: string;
  /** IdP group -> org role applied ONLY when a user is first provisioned (jit). Never includes "owner". */
  groupRoleMap: Record<string, ProvisionableRole>;
  allowInsecureIssuer: boolean;
  clockToleranceSeconds: number;
}

export interface OidcEnv {
  OIDC_ISSUER?: string | undefined; OIDC_CLIENT_ID?: string | undefined; OIDC_CLIENT_SECRET?: string | undefined; OIDC_CLIENT_SECRET_FILE?: string | undefined;
  OIDC_REDIRECT_URI?: string | undefined; OIDC_POST_LOGOUT_REDIRECT_URI?: string | undefined; OIDC_SCOPES?: string | undefined; OIDC_PROVIDER_NAME?: string | undefined;
  OIDC_PROVISIONING?: string | undefined; OIDC_DEFAULT_ORG_SLUG?: string | undefined; OIDC_ALLOWED_EMAIL_DOMAINS?: string | undefined;
  OIDC_REQUIRE_EMAIL_VERIFIED?: string | undefined; OIDC_GROUPS_CLAIM?: string | undefined; OIDC_GROUP_ROLE_MAP?: string | undefined;
  OIDC_ALLOW_INSECURE_ISSUER?: string | undefined; OIDC_CLOCK_TOLERANCE_SECONDS?: string | undefined;
}

/**
 * Parses and validates the OIDC settings. Problems are reported by variable NAME only: values (and especially the client
 * secret) never appear in an error message. In production, anything that weakens the flow is refused rather than allowed.
 */
export function parseOidcConfig(e: OidcEnv, ctx: { webOrigin: string; production: boolean }): OidcConfig {
  const problems: string[] = [];
  const bad = (name: string, why?: string) => problems.push(why ? `${name} ${why}` : name);

  let issuer = '';
  try { issuer = new URL(e.OIDC_ISSUER ?? '').toString().replace(/\/$/, ''); } catch { bad('OIDC_ISSUER', 'must be an absolute URL'); }
  if (!e.OIDC_CLIENT_ID?.trim()) bad('OIDC_CLIENT_ID', 'is required');

  let secret: string | null = e.OIDC_CLIENT_SECRET?.trim() || null;
  if (!secret && e.OIDC_CLIENT_SECRET_FILE) {
    try { secret = readFileSync(e.OIDC_CLIENT_SECRET_FILE, 'utf8').trim() || null; } catch { bad('OIDC_CLIENT_SECRET_FILE', 'could not be read'); }
  }

  const allowInsecureIssuer = e.OIDC_ALLOW_INSECURE_ISSUER === 'true';
  if (issuer && !issuer.startsWith('https://')) {
    if (ctx.production) bad('OIDC_ISSUER', 'must be https:// in production');
    else if (!allowInsecureIssuer) bad('OIDC_ISSUER', 'must be https:// (set OIDC_ALLOW_INSECURE_ISSUER=true for a local development provider only)');
  }
  if (ctx.production && allowInsecureIssuer) bad('OIDC_ALLOW_INSECURE_ISSUER', 'is for development only');

  const redirectUri = e.OIDC_REDIRECT_URI?.trim() || `${ctx.webOrigin}/api/v1/auth/oidc/callback`;
  try {
    const r = new URL(redirectUri);
    if (r.origin !== ctx.webOrigin) bad('OIDC_REDIRECT_URI', 'must be on the WEB_ORIGIN origin (the session cookie is set by the callback)');
    if (r.hash) bad('OIDC_REDIRECT_URI', 'must not contain a fragment');
    if (ctx.production && r.protocol !== 'https:') bad('OIDC_REDIRECT_URI', 'must be https:// in production');
  } catch { bad('OIDC_REDIRECT_URI', 'must be an absolute URL'); }
  const postLogoutRedirectUri = e.OIDC_POST_LOGOUT_REDIRECT_URI?.trim() || `${ctx.webOrigin}/`;
  try { if (new URL(postLogoutRedirectUri).origin !== ctx.webOrigin) bad('OIDC_POST_LOGOUT_REDIRECT_URI', 'must be on the WEB_ORIGIN origin'); } catch { bad('OIDC_POST_LOGOUT_REDIRECT_URI', 'must be an absolute URL'); }

  const scopes = (e.OIDC_SCOPES ?? 'openid profile email').split(/[\s,]+/).filter(Boolean);
  if (!scopes.includes('openid')) bad('OIDC_SCOPES', 'must include "openid"');

  const provisioning = (e.OIDC_PROVISIONING ?? 'invite-only') as OidcConfig['provisioning'];
  if (provisioning !== 'invite-only' && provisioning !== 'jit') bad('OIDC_PROVISIONING', 'must be "invite-only" or "jit"');
  const domains = (e.OIDC_ALLOWED_EMAIL_DOMAINS ?? '').split(',').map((d) => d.trim().toLowerCase().replace(/^@/, '')).filter(Boolean);
  for (const d of domains) if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(d)) bad('OIDC_ALLOWED_EMAIL_DOMAINS', 'contains an invalid domain');
  const defaultOrgSlug = e.OIDC_DEFAULT_ORG_SLUG?.trim() || null;
  // Open registration is never the default: JIT needs an explicit org AND an explicit domain allow-list.
  if (provisioning === 'jit') {
    if (!defaultOrgSlug) bad('OIDC_DEFAULT_ORG_SLUG', 'is required when OIDC_PROVISIONING=jit');
    if (domains.length === 0) bad('OIDC_ALLOWED_EMAIL_DOMAINS', 'is required when OIDC_PROVISIONING=jit (no open registration)');
  }

  const groupRoleMap: Record<string, ProvisionableRole> = {};
  if (e.OIDC_GROUP_ROLE_MAP) {
    try {
      const m = JSON.parse(e.OIDC_GROUP_ROLE_MAP) as unknown;
      if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('shape');
      for (const [g, role] of Object.entries(m)) {
        // "owner" can never be assigned from a token claim; ownership is granted inside the application only.
        if (!(PROVISIONABLE_ROLES as readonly string[]).includes(String(role))) throw new Error('role');
        groupRoleMap[g] = role as ProvisionableRole;
      }
    } catch { bad('OIDC_GROUP_ROLE_MAP', 'must be a JSON object mapping group -> member|auditor|admin (never owner)'); }
  }

  const tolerance = Number(e.OIDC_CLOCK_TOLERANCE_SECONDS ?? 30);
  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 120) bad('OIDC_CLOCK_TOLERANCE_SECONDS', 'must be between 0 and 120');
  const reqVerified = (e.OIDC_REQUIRE_EMAIL_VERIFIED ?? 'true') !== 'false';

  if (problems.length) throw new Error(`Invalid OIDC configuration: ${problems.join('; ')}`);
  const out: OidcConfig = {
    issuer, clientId: e.OIDC_CLIENT_ID!.trim(), clientSecret: null, redirectUri, postLogoutRedirectUri, scopes,
    providerName: (e.OIDC_PROVIDER_NAME ?? 'your identity provider').trim().slice(0, 60) || 'your identity provider',
    provisioning, defaultOrgSlug, allowedEmailDomains: domains, requireEmailVerified: reqVerified,
    groupsClaim: e.OIDC_GROUPS_CLAIM?.trim() || 'groups', groupRoleMap, allowInsecureIssuer, clockToleranceSeconds: tolerance,
  };
  // Non-enumerable: JSON.stringify / util.inspect / structured logging of the config can never include the secret.
  Object.defineProperty(out, 'clientSecret', { value: secret, enumerable: false, writable: false });
  return out;
}
