import { createHash, randomBytes } from 'node:crypto';
import type { Database } from '@nexus/database';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import * as client from 'openid-client';
import type { Config } from '../config.js';
import type { AuditSink } from '../services/audit.js';
import type { SessionService } from '../services/sessions.js';
import type { OidcConfig } from './oidc-config.js';
import { resolveIdentity, type DenyReason } from './provisioning.js';

export type FailureCode = 'idp_denied' | 'not_authorized' | 'login_failed' | 'idp_unavailable';

/** Why a login failed, for operators (logs). Users only ever see one of the generic FailureCodes. */
export type FailureReason =
  | 'idp_error' | 'flow_missing' | 'flow_invalid' | 'token_invalid' | 'callback_malformed' | 'idp_unavailable' | DenyReason;

export type LoginResult =
  | { ok: true; sessionToken: string; returnTo: string; userId: string; orgId: string }
  | { ok: false; reason: FailureReason; code: FailureCode };

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
export const FLOW_TTL_MS = 10 * 60_000;
/** Upper bound for every HTTP call to the provider (discovery, token endpoint). The library default is 30 s, which would let a hanging provider hold sign-ins open. */
export const IDP_HTTP_TIMEOUT_SECONDS = 10;

/**
 * Only same-origin relative paths are accepted as a post-login destination. Anything that could leave the site
 * (`//host`, `https://host`, `/\host`, `javascript:`) collapses to "/": no open redirect.
 */
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 512) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u001f\u007f]/.test(raw)) return '/';
  try {
    const u = new URL(raw, 'http://internal.invalid');
    if (u.origin !== 'http://internal.invalid' || u.pathname.startsWith('/api/')) return '/';
    return `${u.pathname}${u.search}`;
  } catch { return '/'; }
}

const GENERIC: Record<DenyReason, FailureCode> = {
  identity_unusable: 'login_failed', email_unverified: 'not_authorized', email_domain: 'not_authorized', not_provisioned: 'not_authorized',
  account_conflict: 'not_authorized', account_disabled: 'not_authorized', no_org_access: 'not_authorized', org_missing: 'login_failed',
};

/** Only asymmetric algorithms are accepted for ID tokens: never `none`, never HMAC (which would let the public key act as a secret). */
const ID_TOKEN_ALGS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];

/**
 * OpenID Connect relying party: Authorization Code flow with PKCE (S256), state and nonce, via the `openid-client` library
 * (certified implementation). The library checks the state, the `iss` authorization-response parameter (RFC 9207), the PKCE
 * exchange, and the ID token's `iss`/`aud`/`exp`/`iat`/`nonce`. It deliberately does NOT verify the ID token SIGNATURE for the
 * code flow (OIDC Core 3.1.3.7 lets a client rely on TLS to the token endpoint), so we verify it ourselves with `jose` against
 * the provider's JWKS — plus `azp`, and an asymmetric-only algorithm allow-list — rather than trusting the transport alone.
 * We add: one-time server-side flow records bound to the browser by a cookie, exact redirect-URI use, provisioning rules, session
 * rotation, and generic user-facing errors. No access/refresh/ID token is ever stored or sent to the browser.
 */
export class OidcService {
  private configPromise: Promise<client.Configuration> | null = null;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly oidc: OidcConfig,
    private readonly db: Database,
    private readonly sessions: SessionService,
    private readonly audit: AuditSink,
    private readonly log: { warn(o: object, m: string): void; info(o: object, m: string): void },
  ) {}

  get providerName() { return this.oidc.providerName; }
  get provisioning() { return this.oidc.provisioning; }

  /** Discovery is cached on success and retried on failure, so an IdP outage at boot does not poison the process. */
  private configuration(): Promise<client.Configuration> {
    if (!this.configPromise) {
      const p = (async () => {
        const url = new URL(this.oidc.issuer);
        const secret = this.oidc.clientSecret;
        const metadata = { [client.clockTolerance]: this.oidc.clockToleranceSeconds };
        const discovered = await Promise.race([
          client.discovery(url, this.oidc.clientId, metadata, secret ? client.ClientSecretBasic(secret) : client.None(), { timeout: IDP_HTTP_TIMEOUT_SECONDS, ...(this.oidc.allowInsecureIssuer ? { execute: [client.allowInsecureRequests] } : {}) }),
          new Promise<never>((_, rej) => setTimeout(() => rej(new Error('discovery timed out')), IDP_HTTP_TIMEOUT_SECONDS * 1000).unref()),
        ]);
        discovered.timeout = IDP_HTTP_TIMEOUT_SECONDS;
        // HTTP Basic is what the OIDC default (client_secret_basic) means. A provider that advertises client_secret_post and NOT basic
        // gets the secret in the request body instead; nothing else about the flow changes.
        const methods = discovered.serverMetadata().token_endpoint_auth_methods_supported;
        if (secret && Array.isArray(methods) && methods.includes('client_secret_post') && !methods.includes('client_secret_basic')) {
          const post = new client.Configuration(discovered.serverMetadata(), this.oidc.clientId, metadata, client.ClientSecretPost(secret));
          post.timeout = IDP_HTTP_TIMEOUT_SECONDS;
          if (this.oidc.allowInsecureIssuer) client.allowInsecureRequests(post);
          return post;
        }
        return discovered;
      })();
      this.configPromise = p;
      p.catch(() => { if (this.configPromise === p) this.configPromise = null; });
    }
    return this.configPromise;
  }

  /** Verifies signature, issuer, audience, authorized party, expiry and not-before of the raw ID token. */
  private async verifyIdToken(config: client.Configuration, idToken: string): Promise<JWTPayload> {
    const meta = config.serverMetadata();
    if (!meta.jwks_uri) throw new Error('provider publishes no jwks_uri');
    this.jwks ??= createRemoteJWKSet(new URL(meta.jwks_uri), { timeoutDuration: 5_000, cooldownDuration: 30_000 });
    const { payload } = await jwtVerify(idToken, this.jwks, {
      issuer: meta.issuer, audience: this.oidc.clientId, algorithms: ID_TOKEN_ALGS,
      clockTolerance: this.oidc.clockToleranceSeconds, requiredClaims: ['sub', 'exp', 'iat'],
    });
    if (payload.azp !== undefined && payload.azp !== this.oidc.clientId) throw new Error('azp mismatch');
    return payload;
  }

  async startLogin(returnTo: unknown): Promise<{ flowId: string; url: URL } | null> {
    let config: client.Configuration;
    try { config = await this.configuration(); } catch (e) { this.log.warn({ err: (e as Error).message }, 'oidc discovery failed'); return null; }
    const verifier = client.randomPKCECodeVerifier();
    const state = client.randomState();
    const nonce = client.randomNonce();
    const flowId = randomBytes(24).toString('base64url');
    const now = Date.now();
    await this.db.c.authFlows.insertOne({
      _id: flowId, stateHash: sha256(state), nonce, codeVerifier: verifier, returnTo: safeReturnTo(returnTo), createdAt: new Date(now), expireAt: new Date(now + FLOW_TTL_MS),
    });
    const url = client.buildAuthorizationUrl(config, {
      response_type: 'code', redirect_uri: this.oidc.redirectUri, scope: this.oidc.scopes.join(' '), state, nonce,
      code_challenge: await client.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
    });
    return { flowId, url };
  }

  /**
   * `query` is the callback's query string. The URL handed to the library is rebuilt from the CONFIGURED redirect URI, never from
   * request headers, so a spoofed Host/X-Forwarded-* header cannot influence validation.
   */
  async handleCallback(query: URLSearchParams, flowId: string | undefined, previousSessionToken: string | undefined): Promise<LoginResult> {
    const fail = (reason: FailureReason, code: FailureCode, extra: object = {}): LoginResult => {
      this.log.warn({ reason, ...extra }, 'oidc login failed'); // reasons only: no tokens, codes or claims
      return { ok: false, reason, code };
    };
    const state = query.get('state');

    // The flow record is one-time: consuming it first means a replayed or duplicated callback cannot succeed.
    let flow = null;
    if (flowId && state) {
      flow = await this.db.c.authFlows.findOneAndDelete({ _id: flowId, stateHash: sha256(state), expireAt: { $gt: new Date() } });
    } else if (flowId) {
      await this.db.c.authFlows.deleteOne({ _id: flowId });
    }
    if (query.get('error')) return fail('idp_error', query.get('error') === 'access_denied' ? 'idp_denied' : 'login_failed', { idpError: String(query.get('error')).slice(0, 40) });
    if (!flowId) return fail('flow_missing', 'login_failed');
    if (!state || !query.get('code')) return fail('callback_malformed', 'login_failed');
    if (!flow) return fail('flow_invalid', 'login_failed');

    let config: client.Configuration;
    try { config = await this.configuration(); } catch { return fail('idp_unavailable', 'idp_unavailable'); }

    let claims: client.IDToken;
    try {
      const callbackUrl = new URL(this.oidc.redirectUri);
      callbackUrl.search = query.toString();
      const tokens = await client.authorizationCodeGrant(config, callbackUrl, {
        pkceCodeVerifier: flow.codeVerifier, expectedState: state, expectedNonce: flow.nonce, idTokenExpected: true,
      });
      const c = tokens.claims();
      if (!c || !tokens.id_token) return fail('token_invalid', 'login_failed', { why: 'no id token claims' });
      const verified = await this.verifyIdToken(config, tokens.id_token);
      // The nonce is bound to this browser's flow; the library already compared it, this is the second, independent check.
      if (verified.nonce !== flow.nonce) return fail('token_invalid', 'login_failed', { why: 'nonce mismatch' });
      claims = verified as client.IDToken;
    } catch (e) {
      const err = e as { code?: string; error?: string; name?: string };
      return fail('token_invalid', 'login_failed', { why: err.code ?? err.error ?? err.name ?? 'error' });
    }

    const r = await resolveIdentity(this.db, this.oidc, claims as never);
    if (!r.ok) {
      if (r.userId && r.orgId) await this.audit.record({ orgId: r.orgId, actorUserId: r.userId, action: 'auth.login_denied', targetType: 'user', targetId: r.userId, metadata: { reason: r.reason } }, { requestId: 'oidc-callback' }).catch(() => undefined);
      return fail(r.reason, GENERIC[r.reason]);
    }

    // Session fixation: a session that existed before authentication is never carried over. Revoke it and mint a fresh one.
    if (previousSessionToken) await this.sessions.revokeToken(previousSessionToken);
    const { token, session } = await this.sessions.create(r.user._id, r.orgId);
    await this.audit.record({
      orgId: r.orgId, actorUserId: r.user._id, action: 'auth.login', targetType: 'session', targetId: session._id,
      metadata: { mode: 'oidc', provisioned: r.provisioned, identityBound: r.bound },
    }, { requestId: 'oidc-callback' });
    return { ok: true, sessionToken: token, returnTo: flow.returnTo, userId: r.user._id, orgId: r.orgId };
  }

  /** RP-initiated logout URL, when the provider supports it. No ID token hint is kept (we store no tokens). */
  async logoutUrl(): Promise<string | null> {
    try {
      const config = await this.configuration();
      if (!config.serverMetadata().end_session_endpoint) return null;
      return client.buildEndSessionUrl(config, { client_id: this.oidc.clientId, post_logout_redirect_uri: this.oidc.postLogoutRedirectUri }).toString();
    } catch { return null; }
  }
}
