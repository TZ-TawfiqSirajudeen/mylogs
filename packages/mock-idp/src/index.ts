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
  | 'alg-none' | 'wrong-azp' | 'no-id-token';

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
}

export interface MockIdpOptions {
  users: MockUser[];
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
  postLogoutRedirectUris?: string[];
  port?: number;
  host?: string;
  /** Lifetime of issued ID tokens in seconds. */
  idTokenTtl?: number;
}

export interface AuthorizationRequestRecord { clientId: string; redirectUri: string; scope: string; state: string; nonce: string; codeChallenge: string; codeChallengeMethod: string; loginHint?: string }

export interface MockIdp {
  issuer: string;
  url: string;
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
  const kid = `mock-${randomBytes(4).toString('hex')}`;
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  const codes = new Map<string, AuthorizationRequestRecord & { sub: string; used: boolean; exp: number }>();
  const pending = new Map<string, AuthorizationRequestRecord>();
  const state = { behavior: { ...DEFAULT_BEHAVIOR } };
  const idp = {
    authorizationRequests: [] as AuthorizationRequestRecord[],
    tokenRequests: [] as MockIdp['tokenRequests'],
    logoutRequests: [] as string[],
  };
  let issuer = '';

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
    const t = state.behavior.tamper;
    const user = users.get(rec.sub)!;
    const now = Math.floor(Date.now() / 1000);
    const ttl = opts.idTokenTtl ?? 300;
    const claims: Record<string, unknown> = {
      ...user.claims, nonce: t === 'nonce' ? 'not-the-nonce' : t === 'missing-nonce' ? undefined : rec.nonce,
      auth_time: now, ...(user.email ? { email: user.email } : {}), ...(user.emailVerified !== undefined ? { email_verified: user.emailVerified } : {}),
      ...(user.name ? { name: user.name } : {}), ...(user.groups ? { groups: user.groups } : {}),
      ...(t === 'wrong-azp' ? { azp: 'some-other-client' } : {}),
    };
    let jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(t === 'issuer' ? 'https://evil.example' : issuer)
      .setAudience(t === 'audience' ? 'another-client' : opts.clientId)
      .setIssuedAt(t === 'expired' ? now - 7200 : now)
      .setExpirationTime(t === 'expired' ? now - 3600 : now + ttl);
    if (t !== 'missing-sub') jwt = jwt.setSubject(rec.sub);
    if (t === 'not-yet-valid') jwt = jwt.setNotBefore(now + 3600).setIssuedAt(now + 3600).setExpirationTime(now + 7200);
    if (t === 'alg-none') {
      const header = b64url(Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })));
      const payload = b64url(Buffer.from(JSON.stringify({ iss: issuer, sub: rec.sub, aud: opts.clientId, exp: now + ttl, iat: now, nonce: rec.nonce, email: user.email, email_verified: true })));
      return `${header}.${payload}.`;
    }
    return jwt.sign(t === 'signature' ? (other.privateKey as CryptoKey) : (privateKey as CryptoKey));
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', issuer || 'http://localhost');
    try {
      if (url.pathname === '/.well-known/openid-configuration') {
        return send(res, 200, {
          issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, end_session_endpoint: `${issuer}/logout`,
          response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
          code_challenge_methods_supported: ['S256'], scopes_supported: ['openid', 'profile', 'email'], grant_types_supported: ['authorization_code'],
          token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', ...(opts.clientSecret ? [] : ['none'])],
          authorization_response_iss_parameter_supported: true, claims_supported: ['sub', 'iss', 'aud', 'exp', 'iat', 'nonce', 'email', 'email_verified', 'name', 'groups'],
        });
      }
      if (url.pathname === '/jwks') return send(res, 200, { keys: [jwk] });

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
        const fail = (error: string, desc: string) => redirectWith(res, redirectUri, { error, error_description: desc, state: rec.state, iss: issuer });
        if (q.get('response_type') !== 'code') return fail('unsupported_response_type', 'only the code flow is supported');
        if (!rec.scope.split(' ').includes('openid')) return fail('invalid_scope', 'openid scope required');
        if (!rec.state) return fail('invalid_request', 'state required');
        if (!rec.nonce) return fail('invalid_request', 'nonce required');
        if (!rec.codeChallenge || rec.codeChallengeMethod !== 'S256') return fail('invalid_request', 'PKCE with S256 is required');
        if (state.behavior.denyAuthorize) return fail('access_denied', 'the user denied the request');
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
        return redirectWith(res, rec.redirectUri, { error: 'access_denied', state: rec.state, iss: issuer });
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
        if (state.behavior.tokenError) return err('server_error', 'configured failure', 500);
        if (id !== opts.clientId || (opts.clientSecret && !safeEq(secret, opts.clientSecret))) return err('invalid_client', 'client authentication failed', 401);
        if (p.get('grant_type') !== 'authorization_code') return err('unsupported_grant_type', 'only authorization_code');
        const rec = codes.get(p.get('code') ?? '');
        if (!rec || rec.exp < Date.now()) return err('invalid_grant', 'unknown or expired code');
        if (rec.used) return err('invalid_grant', 'authorization code already used');
        rec.used = true;
        if (p.get('redirect_uri') !== rec.redirectUri) return err('invalid_grant', 'redirect_uri mismatch');
        const verifier = p.get('code_verifier') ?? '';
        if (!verifier || !safeEq(b64url(sha256(verifier)), rec.codeChallenge)) return err('invalid_grant', 'PKCE verification failed');
        const body: Record<string, unknown> = { access_token: randomBytes(24).toString('base64url'), token_type: 'Bearer', expires_in: 300, scope: rec.scope };
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

  function approve(res: http.ServerResponse, rec: AuthorizationRequestRecord, sub: string) {
    const code = randomBytes(24).toString('base64url');
    codes.set(code, { ...rec, sub, used: false, exp: Date.now() + 60_000 });
    redirectWith(res, rec.redirectUri, {
      code, state: state.behavior.wrongState ? 'attacker-state' : rec.state, iss: state.behavior.wrongIssParam ? 'https://evil.example' : issuer,
    });
  }

  await new Promise<void>((r) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  issuer = `http://${opts.host ?? '127.0.0.1'}:${port}`;

  return {
    issuer, url: issuer, ...idp, authorizationRequests: idp.authorizationRequests, tokenRequests: idp.tokenRequests, logoutRequests: idp.logoutRequests,
    get behavior() { return state.behavior; },
    setBehavior(b) { state.behavior = { ...state.behavior, ...b }; },
    reset() { state.behavior = { ...DEFAULT_BEHAVIOR }; idp.authorizationRequests.length = 0; idp.tokenRequests.length = 0; idp.logoutRequests.length = 0; codes.clear(); pending.clear(); },
    addUser(u) { users.set(u.sub, u); },
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  } as MockIdp;
}
