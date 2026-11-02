import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';

/**
 * A small but standards-conforming OpenID Provider (authorization code flow + PKCE S256, RS256 ID tokens, discovery, JWKS,
 * RFC 9207 `iss` response parameter, RP-initiated logout). It exists so the relying party can be exercised end to end —
 * in unit tests and in a real browser — including FAILURE modes a real provider will not produce on demand
 * (tampered signature, wrong nonce/audience/issuer, expired token, replayed code, error responses).
 * It is NOT a production identity provider: it performs no authentication beyond "pick a user".
 */
export interface MockUser {
  sub: string;
  email?: string;
  emailVerified?: boolean | string;
  name?: string;
  groups?: string[];
  /** Extra claims placed in the ID token (used to prove untrusted-looking claims cannot grant roles). */
  claims?: Record<string, unknown>;
}

export type Tamper =
  | 'none' | 'signature' | 'nonce' | 'audience' | 'issuer' | 'expired' | 'not-yet-valid' | 'missing-sub' | 'missing-nonce'
  | 'alg-none' | 'wrong-azp' | 'no-id-token'
  /** HS256 signed with the CLIENT SECRET as the HMAC key (the classic key-confusion attempt). */
  | 'hs256-client-secret'
  /** Header says PS256 while the published key is restricted to RS256. */
  | 'alg-mismatch';

export interface Behavior {
  tamper: Tamper;
  /** Answer /authorize with error=access_denied instead of a code. */
  denyAuthorize: boolean;
  /** Answer /token with an error. */
  tokenError: boolean;
  /** Add a wrong `iss` to the authorization response (mix-up attack). */
  wrongIssParam: boolean;
  /** Return a different `state` than the one received. */
  wrongState: boolean;
  // ---- real-provider quirks: every one of these defaults to "off" (undefined) ----
  /** Seconds from now for `exp` / `iat` / `nbf` (negative = in the past). Used for clock-skew boundary tests. */
  expOffset?: number | undefined;
  iatOffset?: number | undefined;
  nbfOffset?: number | undefined;
  /** `aud` as an array `[clientId, "api://other-resource"]` with `azp` = clientId (Microsoft/Google style multi-audience tokens). */
  audArray?: boolean | undefined;
  /** Put this value in the ID token `iss` (e.g. a v1.0-style issuer while the provider is configured as v2.0). */
  issClaim?: string | undefined;
  /** Put this value in the discovery document `issuer` (e.g. the literal `{tenantid}` template served for Entra /common). */
  discoveryIssuer?: string | undefined;
  /** Answer /authorize with this error code (e.g. login_required, interaction_required, temporarily_unavailable). */
  authorizeError?: string | undefined;
  /** Leave the RFC 9207 `iss` parameter out of authorization responses. */
  omitIssParam?: boolean | undefined;
  /** JWKS endpoint answers with this HTTP status instead of the key set. */
  jwksStatus?: number | undefined;
  /** Milliseconds each endpoint waits before answering (hanging / slow provider). */
  jwksDelayMs?: number | undefined;
  discoveryDelayMs?: number | undefined;
  tokenDelayMs?: number | undefined;
  /** Token response oddities seen in the wild. */
  tokenType?: string | undefined;
  expiresInAsString?: boolean | undefined;
  extraTokenFields?: Record<string, unknown> | undefined;
}

export interface MockIdpOptions {
  users: MockUser[];
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  postLogoutRedirectUris?: string[];
  port?: number;
  /** Interface to bind (default 127.0.0.1). */
  host?: string;
  /** Origin advertised in the issuer and endpoints (default `http://<host>:<port>`). Needed when the bind address differs from the name clients use, e.g. a container. */
  publicOrigin?: string;
  /** Lifetime of issued ID tokens in seconds. */
  idTokenTtl?: number;
  /** Serve the provider under a path, e.g. `/<tenant-guid>/v2.0` (Microsoft Entra ID shape). Issuer = origin + path. */
  issuerPath?: string;
  /** Issuer identifier ends with `/` (Auth0 / some Okta authorization servers). */
  issuerTrailingSlash?: boolean;
  /** Do not advertise `end_session_endpoint` (several providers have none). */
  omitEndSession?: boolean;
  /** `false`: do not advertise or send the RFC 9207 `iss` response parameter (most providers do not). Default true. */
  rfc9207?: boolean;
  /** Restrict the client-authentication methods the token endpoint accepts and advertises (default: basic, post and none). */
  tokenAuthMethods?: string[];
}

export interface AuthorizationRequestRecord { clientId: string; redirectUri: string; scope: string; state: string; nonce: string; codeChallenge: string; codeChallengeMethod: string; loginHint?: string }

export interface MockIdp {
  issuer: string;
  /** The origin only (scheme + host + port), regardless of any issuer path. */
  url: string;
  /** Number of times the JWKS / discovery document was fetched since the last reset. */
  jwksRequests: number;
  discoveryRequests: number;
  /** Publishes a new signing key and signs from now on with it; the old key is withdrawn unless `keepOld`. */
  rotateKey(opts?: { keepOld?: boolean }): Promise<void>;
  /** Every authorization request received (for asserting PKCE/state/nonce/redirect_uri). */
  authorizationRequests: AuthorizationRequestRecord[];
  tokenRequests: { grantType: string; hasVerifier: boolean; authMethod: string }[];
  logoutRequests: string[];
  behavior: Behavior;
  setBehavior(b: Partial<Behavior>): void;
  reset(): void;
  addUser(u: MockUser): void;
  close(): Promise<void>;
}

const DEFAULT_BEHAVIOR: Behavior = { tamper: 'none', denyAuthorize: false, tokenError: false, wrongIssParam: false, wrongState: false };
const b64url = (b: Buffer) => b.toString('base64url');
const sha256 = (s: string) => createHash('sha256').update(s).digest();
const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export async function startMockIdp(opts: MockIdpOptions): Promise<MockIdp> {
  const users = new Map(opts.users.map((u) => [u.sub, u]));
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const other = await generateKeyPair('RS256', { extractable: true }); // used to forge signatures
  let kid = `mock-${randomBytes(4).toString('hex')}`;
  let signingKey: CryptoKey = privateKey as CryptoKey;
  let published: JWK[] = [{ ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' }];
  const counters = { jwks: 0, discovery: 0 };
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  let psKey: CryptoKey | null = null;
  const codes = new Map<string, AuthorizationRequestRecord & { sub: string; used: boolean; exp: number }>();
  const pending = new Map<string, AuthorizationRequestRecord>();
  const state = { behavior: { ...DEFAULT_BEHAVIOR } };
  const idp = {
    authorizationRequests: [] as AuthorizationRequestRecord[],
    tokenRequests: [] as MockIdp['tokenRequests'],
    logoutRequests: [] as string[],
  };
  let issuer = '';
  let base = ''; // endpoints live under this (the issuer without a trailing slash)
  let prefix = ''; // path the whole provider is served under

  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...headers });
    res.end(text);
  };
  const redirectWith = (res: http.ServerResponse, redirectUri: string, params: Record<string, string>) => {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    res.writeHead(302, { location: u.toString(), 'cache-control': 'no-store' });
    res.end();
  };

  async function issueIdToken(rec: AuthorizationRequestRecord & { sub: string }): Promise<string> {
    const b = state.behavior;
    const t = b.tamper;
    const user = users.get(rec.sub)!;
    const now = Math.floor(Date.now() / 1000);
    const ttl = opts.idTokenTtl ?? 300;
    let iat = now + (b.iatOffset ?? 0);
    let exp = b.expOffset !== undefined ? now + b.expOffset : iat + ttl;
    if (t === 'expired') { iat = now - 7200; exp = now - 3600; }
    const claims: Record<string, unknown> = {
      ...user.claims, nonce: t === 'nonce' ? 'not-the-nonce' : t === 'missing-nonce' ? undefined : rec.nonce,
      auth_time: now, ...(user.email ? { email: user.email } : {}), ...(user.emailVerified !== undefined ? { email_verified: user.emailVerified } : {}),
      ...(user.name ? { name: user.name } : {}), ...(user.groups ? { groups: user.groups } : {}),
      ...(b.audArray ? { azp: opts.clientId } : {}),
      ...(t === 'wrong-azp' ? { azp: 'some-other-client' } : {}),
    };
    const alg = t === 'hs256-client-secret' ? 'HS256' : t === 'alg-mismatch' ? 'PS256' : 'RS256';
    let jwt = new SignJWT(claims)
      .setProtectedHeader({ alg, kid })
      .setIssuer(t === 'issuer' ? 'https://evil.example' : b.issClaim ?? issuer)
      .setAudience(t === 'audience' ? 'another-client' : b.audArray ? [opts.clientId, 'api://other-resource'] : opts.clientId)
      .setIssuedAt(iat)
      .setExpirationTime(exp);
    if (b.nbfOffset !== undefined) jwt = jwt.setNotBefore(now + b.nbfOffset);
    if (t !== 'missing-sub') jwt = jwt.setSubject(rec.sub);
    if (t === 'not-yet-valid') jwt = jwt.setNotBefore(now + 3600).setIssuedAt(now + 3600).setExpirationTime(now + 7200);
    if (t === 'alg-none') {
      const header = b64url(Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })));
      const payload = b64url(Buffer.from(JSON.stringify({ iss: issuer, sub: rec.sub, aud: opts.clientId, exp: now + ttl, iat: now, nonce: rec.nonce, email: user.email, email_verified: true })));
      return `${header}.${payload}.`;
    }
    if (t === 'hs256-client-secret') return jwt.sign(new TextEncoder().encode(opts.clientSecret ?? 'secret'));
    if (t === 'alg-mismatch') { psKey ??= (await generateKeyPair('PS256')).privateKey as CryptoKey; return jwt.sign(psKey); }
    return jwt.sign(t === 'signature' ? (other.privateKey as CryptoKey) : signingKey);
  }

  const server = http.createServer(async (req, res) => {
    const raw = new URL(req.url ?? '/', base || 'http://localhost');
    // When served under a path (issuerPath), only that subtree exists; everything inside it is routed by its relative path.
    const inside = prefix === '' || raw.pathname === prefix || raw.pathname.startsWith(`${prefix}/`);
    const url = new URL(raw.toString());
    if (prefix !== '' && inside) url.pathname = raw.pathname.slice(prefix.length) || '/';
    try {
      if (!inside) return send(res, 404, { error: 'not_found' });
      const b = state.behavior;
      if (url.pathname === '/.well-known/openid-configuration') {
        counters.discovery++;
        if (b.discoveryDelayMs) await sleep(b.discoveryDelayMs);
        return send(res, 200, {
          issuer: b.discoveryIssuer ?? issuer, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, jwks_uri: `${base}/jwks`,
          ...(opts.omitEndSession ? {} : { end_session_endpoint: `${base}/logout` }),
          response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'], scopes_supported: ['openid', 'profile', 'email'], grant_types_supported: ['authorization_code'],
          token_endpoint_auth_methods_supported: opts.tokenAuthMethods ?? ['client_secret_basic', 'client_secret_post', ...(opts.clientSecret ? [] : ['none'])],
          ...(opts.rfc9207 === false ? {} : { authorization_response_iss_parameter_supported: true }),
          claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce', 'email', 'email_verified', 'name', 'groups'],
        });
      }
      if (url.pathname === '/jwks') {
        counters.jwks++;
        if (b.jwksDelayMs) await sleep(b.jwksDelayMs);
        if (b.jwksStatus) return send(res, b.jwksStatus, { error: 'jwks_unavailable' });
        return send(res, 200, { keys: published });
      }

      if (url.pathname === '/authorize') {
        const q = url.searchParams;
        const clientId = q.get('client_id') ?? '', redirectUri = q.get('redirect_uri') ?? '';
        // Unknown client / unregistered redirect URI: never redirect (RFC 6749 §3.1.2.4).
        if (clientId !== opts.clientId || !opts.redirectUris.includes(redirectUri)) return send(res, 400, '<h1>Invalid client or redirect_uri</h1>');
        const rec: AuthorizationRequestRecord = {
          clientId, redirectUri, scope: q.get('scope') ?? '', state: q.get('state') ?? '', nonce: q.get('nonce') ?? '',
          codeChallenge: q.get('code_challenge') ?? '', codeChallengeMethod: q.get('code_challenge_method') ?? '', ...(q.get('login_hint') ? { loginHint: q.get('login_hint')! } : {}),
        };
        idp.authorizationRequests.push(rec);
        const fail = (error: string, desc: string) => redirectWith(res, redirectUri, { error, error_description: desc, state: rec.state, ...issParam() });
        if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'only the code flow is supported');
        if (!rec.scope.split(' ').includes('openid')) return fail('invalid_scope', 'openid scope required');
        if (!rec.state) return fail('invalid_request', 'state required');
        if (!rec.nonce) return fail('invalid_request', 'nonce required');
        if (!rec.codeChallenge || rec.codeChallengeMethod !== 'S256') return fail('invalid_request', 'PKCE with S256 is required');
        if (state.behavior.denyAuthorize) return fail('access_denied', 'the user denied the request');
        if (state.behavior.authorizeError) return fail(state.behavior.authorizeError, 'configured failure');
        const hint = rec.loginHint?.toLowerCase();
        const hinted = hint ? [...users.values()].find((u) => u.email?.toLowerCase() === hint || u.sub === rec.loginHint) : undefined;
        if (hinted) return approve(res, rec, hinted.sub);
        const sid = randomBytes(12).toString('hex');
        pending.set(sid, rec);
        const list = [...users.values()].map((u) => `<li><a href="/authorize/approve?sid=${sid}&user=${encodeURIComponent(u.sub)}" data-testid="idp-user-${u.email ?? u.sub}">Sign in as ${u.name ?? u.email ?? u.sub} (${u.email ?? u.sub})</a></li>`).join('');
        return send(res, 200, `<!doctype html><html lang="en"><head><title>Mock identity provider</title></head><body><main><h1>Mock identity provider</h1><p>Test double — choose an identity.</p><ul>${list}</ul><p><a href="/authorize/deny?sid=${sid}">Deny</a></p></main></body></html>`);
      }
      if (url.pathname === '/authorize/approve') {
        const rec = pending.get(url.searchParams.get('sid') ?? '');
        const sub = url.searchParams.get('user') ?? '';
        if (!rec || !users.has(sub)) return send(res, 400, '<h1>Unknown request</h1>');
        pending.delete(url.searchParams.get('sid')!);
        return approve(res, rec, sub);
      }
      if (url.pathname === '/authorize/deny') {
        const rec = pending.get(url.searchParams.get('sid') ?? '');
        if (!rec) return send(res, 400, '<h1>Unknown request</h1>');
        return redirectWith(res, rec.redirectUri, { error: 'access_denied', state: rec.state, ...issParam() });
      }

      if (url.pathname === '/token' && req.method === 'POST') {
        let raw = '';
        for await (const c of req) raw += c;
        const p = new URLSearchParams(raw);
        const basic = /^Basic (.+)$/i.exec(String(req.headers.authorization ?? ''));
        let id = p.get('client_id') ?? '', secret = p.get('client_secret') ?? '';
        let method = secret ? 'client_secret_post' : 'none';
        if (basic) { const [a, ...b] = Buffer.from(basic[1]!, 'base64').toString().split(':'); id = decodeURIComponent(a ?? ''); secret = decodeURIComponent(b.join(':')); method = 'client_secret_basic'; }
        idp.tokenRequests.push({ grantType: p.get('grant_type') ?? '', hasVerifier: !!p.get('code_verifier'), authMethod: method });
        const err = (code: string, desc: string, status = 400) => send(res, status, { error: code, error_description: desc });
        if (state.behavior.tokenDelayMs) await sleep(state.behavior.tokenDelayMs);
        if (state.behavior.tokenError) return err('server_error', 'configured failure', 500);
        if (opts.tokenAuthMethods && !opts.tokenAuthMethods.includes(method)) return err('invalid_client', `authentication method ${method} is not supported`, 401);
        if (id !== opts.clientId || (opts.clientSecret && !safeEq(secret, opts.clientSecret))) return err('invalid_client', 'client authentication failed', 401);
        if (p.get('grant_type') !== 'authorization_code') return err('unsupported_grant_type', 'only authorization_code');
        const rec = codes.get(p.get('code') ?? '');
        if (!rec || rec.exp < Date.now()) return err('invalid_grant', 'unknown or expired code');
        if (rec.used) return err('invalid_grant', 'authorization code already used');
        rec.used = true;
        if (p.get('redirect_uri') !== rec.redirectUri) return err('invalid_grant', 'redirect_uri mismatch');
        const verifier = p.get('code_verifier') ?? '';
        if (!verifier || !safeEq(b64url(sha256(verifier)), rec.codeChallenge)) return err('invalid_grant', 'PKCE verification failed');
        const tb = state.behavior;
        const body: Record<string, unknown> = {
          access_token: randomBytes(24).toString('base64url'), token_type: tb.tokenType ?? 'Bearer', expires_in: tb.expiresInAsString ? '300' : 300, scope: rec.scope, ...tb.extraTokenFields,
        };
        if (state.behavior.tamper !== 'no-id-token') body.id_token = await issueIdToken(rec);
        return send(res, 200, body);
      }

      if (url.pathname === '/logout') {
        idp.logoutRequests.push(url.search);
        const target = url.searchParams.get('post_logout_redirect_uri');
        if (target && opts.postLogoutRedirectUris?.includes(target)) { res.writeHead(302, { location: target }); return res.end(); }
        return send(res, 200, '<!doctype html><title>Signed out</title><h1>Signed out of the mock identity provider</h1>');
      }
      return send(res, 404, { error: 'not_found' });
    } catch (e) {
      return send(res, 500, { error: 'server_error', error_description: e instanceof Error ? e.message : 'error' });
    }
  });

  /** The RFC 9207 `iss` authorization-response parameter: sent by default, omitted for providers that do not support it. */
  function issParam(): Record<string, string> {
    if (opts.rfc9207 === false || state.behavior.omitIssParam) return {};
    return { iss: state.behavior.wrongIssParam ? 'https://evil.example' : issuer };
  }

  function approve(res: http.ServerResponse, rec: AuthorizationRequestRecord, sub: string) {
    const code = randomBytes(24).toString('base64url');
    codes.set(code, { ...rec, sub, used: false, exp: Date.now() + 60_000 });
    redirectWith(res, rec.redirectUri, { code, state: state.behavior.wrongState ? 'attacker-state' : rec.state, ...issParam() });
  }

  await new Promise<void>((r) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const origin = (opts.publicOrigin ?? `http://${opts.host ?? '127.0.0.1'}:${port}`).replace(/\/+$/, '');
  prefix = (opts.issuerPath ?? '').replace(/\/+$/, '');
  if (prefix && !prefix.startsWith('/')) prefix = `/${prefix}`;
  base = `${origin}${prefix}`;
  issuer = opts.issuerTrailingSlash ? `${base}/` : base;

  return {
    issuer, url: origin, ...idp,
    get jwksRequests() { return counters.jwks; },
    get discoveryRequests() { return counters.discovery; },
    async rotateKey(o) {
      const next = await generateKeyPair('RS256', { extractable: true });
      kid = `mock-${randomBytes(4).toString('hex')}`;
      signingKey = next.privateKey as CryptoKey;
      const fresh: JWK = { ...(await exportJWK(next.publicKey)), kid, alg: 'RS256', use: 'sig' };
      published = o?.keepOld ? [...published, fresh] : [fresh];
    }, authorizationRequests: idp.authorizationRequests, tokenRequests: idp.tokenRequests, logoutRequests: idp.logoutRequests,
    get behavior() { return state.behavior; },
    setBehavior(b) { state.behavior = { ...state.behavior, ...b }; },
    reset() { state.behavior = { ...DEFAULT_BEHAVIOR }; idp.authorizationRequests.length = 0; idp.tokenRequests.length = 0; idp.logoutRequests.length = 0; codes.clear(); pending.clear(); counters.jwks = 0; counters.discovery = 0; },
    addUser(u) { users.set(u.sub, u); },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  } as MockIdp;
}
