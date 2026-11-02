import { startTestMongo } from '@nexus/database/testing';
import { startMockIdp, type MockIdp, type MockIdpOptions, type MockUser } from '@nexus/mock-idp';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { parseOidcConfig } from '../src/auth/oidc-config.js';
import { CLIENT_ID, CLIENT_SECRET, oidcHarness, SECURE_WEB, WEB, type OidcHarness, type SignInResult } from './oidc-helpers.js';

/**
 * What a REAL identity provider does that the happy-path mock does not: Microsoft Entra ID v2.0 token shapes, issuer identifiers
 * with paths and trailing slashes, key rotation, slow or failing endpoints, token-response oddities, hostile claim values.
 * Everything here runs against the in-repo mock provider configured to behave that way. It does NOT prove that any real tenant
 * works (see docs/auth-oidc.md "Verification status" and docs/runbooks/oidc-staging-verification.md).
 *
 * Behaviour already covered by oidc.test.ts (tampered signature/nonce/audience/issuer/expiry, alg=none, wrong azp, state and flow
 * replay, mix-up `iss`, access_denied, token endpoint errors, takeover by e-mail, JIT and group maps, logout) is not repeated here.
 */
let mongo: Awaited<ReturnType<typeof startTestMongo>>;
const open: OidcHarness[] = [];
const idps: MockIdp[] = [];
const CALLBACKS = [`${WEB}/api/v1/auth/oidc/callback`, `${SECURE_WEB}/api/v1/auth/oidc/callback`];

async function provider(users: MockUser[], extra: Partial<MockIdpOptions> = {}): Promise<MockIdp> {
  const i = await startMockIdp({ users, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUris: CALLBACKS, postLogoutRedirectUris: [`${WEB}/`, `${SECURE_WEB}/`], ...extra });
  idps.push(i);
  return i;
}
async function app(idp: MockIdp, env: Record<string, string> = {}): Promise<OidcHarness> {
  const h = await oidcHarness(mongo.uri, { idp, env });
  open.push(h);
  return h;
}
const refused = (r: SignInResult, code: string) => { expect(r.sessionCookie).toBeNull(); expect(r.authError).toBe(code); };
const signedIn = (r: SignInResult) => { expect(r.authError).toBeNull(); expect(r.sessionCookie).not.toBeNull(); };

beforeAll(async () => { mongo = await startTestMongo(); }, 240_000);
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  for (const h of open) { await h.app.close(); await h.db.close(); }
  for (const i of idps) await i.close();
  await mongo?.stop();
});

const TID = '72f988bf-86f1-41af-91ab-2d7cd011db47';

describe('Microsoft Entra ID v2.0 shape (issuer carries the tenant id; no e-mail_verified; preferred_username/upn are not e-mail)', () => {
  const users: MockUser[] = [
    // What Entra sends once the optional `email` claim is configured: no email_verified at all.
    { sub: 'AAAAAAAAAAAAAAAAAAAAAbcDeFgHiJkLmNoPqRsTuVw', email: 'engineer@acme.test', name: 'Erin Engineer', claims: { tid: TID, oid: 'b1c2d3e4-0000-4000-8000-000000000001', ver: '2.0', preferred_username: 'engineer@acme.test' } },
    // The default Entra token: NO email claim, only preferred_username / upn naming somebody else's mailbox.
    { sub: 'entra-no-email', name: 'Not Olivia', claims: { tid: TID, oid: 'b1c2d3e4-0000-4000-8000-000000000002', ver: '2.0', preferred_username: 'owner@acme.test', upn: 'owner@acme.test' } },
  ];
  let idp: MockIdp;
  let strict: OidcHarness; // defaults: e-mail must be verified
  let relaxed: OidcHarness; // OIDC_REQUIRE_EMAIL_VERIFIED=false, the documented single-tenant Entra setting

  beforeAll(async () => {
    idp = await provider(users, { issuerPath: `/${TID}/v2.0` });
    strict = await app(idp);
    relaxed = await app(idp, { OIDC_REQUIRE_EMAIL_VERIFIED: 'false' });
  });

  test('the issuer is the tenant-scoped v2.0 URL and discovery lives under it', async () => {
    expect(idp.issuer).toBe(`${idp.url}/${TID}/v2.0`);
    const res = await fetch(`${idp.issuer}/.well-known/openid-configuration`);
    expect((await res.json() as { issuer: string }).issuer).toBe(idp.issuer);
  });

  test('without email_verified the default configuration refuses sign-in (secure default; the operator must opt out knowingly)', async () => {
    refused(await strict.signIn('ignored', { loginHint: users[0]!.sub }), 'not_authorized');
    expect((await strict.db.c.users.findOne({ emailLower: 'engineer@acme.test' }))?.externalSubject ?? null).toBeNull();
  });

  test('with OIDC_REQUIRE_EMAIL_VERIFIED=false the pre-provisioned user signs in and is bound to (tenant issuer, sub), not to an e-mail address', async () => {
    const r = await relaxed.signIn('ignored', { loginHint: users[0]!.sub });
    signedIn(r);
    const u = await relaxed.db.c.users.findOne({ emailLower: 'engineer@acme.test' });
    expect(u?.externalIssuer).toBe(idp.issuer);
    expect(u?.externalSubject).toBe(users[0]!.sub);
    expect(idp.tokenRequests.at(-1)?.authMethod).toBe('client_secret_basic');
  });

  test('preferred_username / upn naming another account are NEVER treated as an e-mail address (no e-mail claim = no sign-in, no binding)', async () => {
    for (const h of [strict, relaxed]) {
      const sessions = await h.db.c.sessions.countDocuments();
      refused(await h.signIn('ignored', { loginHint: 'entra-no-email' }), 'login_failed');
      expect(await h.db.c.sessions.countDocuments()).toBe(sessions);
      expect((await h.db.c.users.findOne({ emailLower: 'owner@acme.test' }))?.externalSubject ?? null).toBeNull();
    }
  });

  test('a v1.0-style issuer in the token (sts.windows.net/<tid>/) is rejected when the app is configured for v2.0', async () => {
    idp.setBehavior({ issClaim: `https://sts.windows.net/${TID}/` });
    refused(await relaxed.signIn('ignored', { loginHint: users[0]!.sub }), 'login_failed');
    idp.reset();
  });

  test('extra token-response fields Entra sends (ext_expires_in, foci, client_info) and a string expires_in do not matter', async () => {
    idp.setBehavior({ extraTokenFields: { ext_expires_in: 3599, foci: '1', client_info: 'eyJ1aWQiOiJ4In0' }, expiresInAsString: true });
    signedIn(await relaxed.signIn('ignored', { loginHint: users[0]!.sub }));
    idp.reset();
  });

  test('multi-audience tokens (aud array + azp = this client) are accepted; an azp for another client is not', async () => {
    idp.setBehavior({ audArray: true });
    signedIn(await relaxed.signIn('ignored', { loginHint: users[0]!.sub }));
    idp.setBehavior({ audArray: true, tamper: 'wrong-azp' });
    refused(await relaxed.signIn('ignored', { loginHint: users[0]!.sub }), 'login_failed');
    idp.reset();
  });

  test('a provider that does not implement RFC 9207 (no `iss` response parameter, not advertised) still works; one that advertises it and omits it is refused', async () => {
    const plain = await provider(users, { issuerPath: `/${TID}/v2.0`, rfc9207: false });
    signedIn(await (await app(plain, { OIDC_REQUIRE_EMAIL_VERIFIED: 'false' })).signIn('ignored', { loginHint: users[0]!.sub }));
    idp.setBehavior({ omitIssParam: true });
    refused(await relaxed.signIn('ignored', { loginHint: users[0]!.sub }), 'login_failed');
    idp.reset();
  });
});

describe('issuer identifiers a real provider publishes (path, trailing slash)', () => {
  const who: MockUser = { sub: 'issuer-shape-user', email: 'engineer@acme.test', emailVerified: true };
  test.each([
    ['bare origin (Auth0 / Keycloak-less)', {}],
    ['bare origin with trailing slash (Auth0)', { issuerTrailingSlash: true }],
    ['path (Entra v2.0, Okta custom authorization server, Keycloak realm)', { issuerPath: '/tenant/v2.0' }],
    ['path WITH trailing slash (Azure AD B2C, Authentik, Entra v1.0)', { issuerPath: '/tenant/v2.0', issuerTrailingSlash: true }],
  ] as [string, Partial<MockIdpOptions>][])('%s', async (_name, shape) => {
    const idp = await provider([who], shape);
    const h = await app(idp);
    signedIn(await h.signIn('ignored', { loginHint: who.sub }));
    // The identity key is the provider's own issuer string (what its tokens carry in `iss`), exactly.
    const stored = (await h.db.c.users.findOne({ emailLower: 'engineer@acme.test' }))?.externalIssuer;
    expect(new URL(stored!).href).toBe(new URL(idp.issuer).href);
    if (shape.issuerPath) expect(stored).toBe(idp.issuer);
  });

  test('configuring the issuer with or without a trailing slash for a bare-origin provider yields the same identity key', async () => {
    const idp = await provider([who], { issuerTrailingSlash: true });
    const a = await app(idp, { OIDC_ISSUER: idp.issuer });
    const b = await app(idp, { OIDC_ISSUER: idp.issuer.replace(/\/$/, '') });
    signedIn(await a.signIn('ignored', { loginHint: who.sub }));
    signedIn(await b.signIn('ignored', { loginHint: who.sub }));
    const ia = (await a.db.c.users.findOne({ emailLower: 'engineer@acme.test' }))?.externalIssuer;
    const ib = (await b.db.c.users.findOne({ emailLower: 'engineer@acme.test' }))?.externalIssuer;
    expect(ia).toBe(ib);
  });
});

describe('discovery document problems', () => {
  const who: MockUser = { sub: 'disc-user', email: 'engineer@acme.test', emailVerified: true };
  const start = (h: OidcHarness) => h.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/login' });

  test('the multi-tenant /common template issuer ({tenantid}) and any issuer that is not the configured one are refused cleanly, then recover once fixed', async () => {
    const idp = await provider([who], { issuerPath: '/common/v2.0' });
    const h = await app(idp);
    for (const bad of ['https://login.microsoftonline.com/{tenantid}/v2.0', 'https://evil.example/common/v2.0']) {
      idp.setBehavior({ discoveryIssuer: bad });
      const r = await start(h);
      expect(r.statusCode).toBe(302);
      expect(String(r.headers.location)).toBe(`${WEB}/?auth_error=idp_unavailable`);
      expect(await h.db.c.authFlows.countDocuments()).toBe(0); // nothing half-started
    }
    idp.reset(); // discovery failure is not cached: the next attempt works without a restart
    signedIn(await h.signIn('ignored', { loginHint: who.sub }));
  });

  test('a provider that hangs on discovery is cut off (about 10 s) with a clean redirect, and recovers when it answers again', async () => {
    const idp = await provider([who]);
    const h = await app(idp);
    idp.setBehavior({ discoveryDelayMs: 13_000 });
    const t0 = Date.now();
    const r = await start(h);
    expect(String(r.headers.location)).toBe(`${WEB}/?auth_error=idp_unavailable`);
    expect(Date.now() - t0).toBeLessThan(12_500);
    idp.reset();
    signedIn(await h.signIn('ignored', { loginHint: who.sub }));
  });
});

describe('ID token and JWKS handling', () => {
  const who: MockUser = { sub: 'tok-user', email: 'engineer@acme.test', emailVerified: true };
  let idp: MockIdp;
  let h: OidcHarness;
  beforeAll(async () => { idp = await provider([who]); h = await app(idp); });
  afterEach(() => idp.reset());
  const login = () => h.signIn('ignored', { loginHint: who.sub });

  test('HS256 signed with the client secret (key confusion) and an alg the published key does not allow are refused', async () => {
    idp.setBehavior({ tamper: 'hs256-client-secret' });
    refused(await login(), 'login_failed');
    idp.setBehavior({ tamper: 'alg-mismatch' });
    refused(await login(), 'login_failed');
  });

  test.each([
    ['exp 20 s ago (inside the 30 s tolerance)', { expOffset: -20, iatOffset: -300 }, true],
    ['exp 45 s ago (outside the tolerance)', { expOffset: -45, iatOffset: -300 }, false],
    ['nbf 20 s ahead (inside the tolerance)', { nbfOffset: 20 }, true],
    ['nbf 45 s ahead (outside the tolerance)', { nbfOffset: 45 }, false],
  ] as const)('clock skew: %s', async (_name, behavior, ok) => {
    idp.setBehavior({ ...behavior });
    const r = await login();
    if (ok) signedIn(r); else refused(r, 'login_failed');
  });

  test('clock tolerance is configurable and strict at 0: nbf 5 s ahead is refused only when the tolerance is 0', async () => {
    const strict = await app(idp, { OIDC_CLOCK_TOLERANCE_SECONDS: '0' });
    idp.setBehavior({ nbfOffset: 5 });
    refused(await strict.signIn('ignored', { loginHint: who.sub }), 'login_failed');
    signedIn(await login()); // the default 30 s tolerates the same token
  });

  test('token response oddities: lowercase token_type and a string expires_in are tolerated', async () => {
    idp.setBehavior({ tokenType: 'bearer', expiresInAsString: true });
    signedIn(await login());
  });

  test('JWKS endpoint errors fail the sign-in cleanly (no 500, no session) and the next attempt works once it recovers', async () => {
    const fresh = await provider([who]);
    const hh = await app(fresh);
    fresh.setBehavior({ jwksStatus: 503 });
    refused(await hh.signIn('ignored', { loginHint: who.sub }), 'login_failed');
    fresh.reset();
    signedIn(await hh.signIn('ignored', { loginHint: who.sub }));
  });

  test('a JWKS endpoint that hangs is cut off (about 5 s), not waited for', async () => {
    const fresh = await provider([who]);
    const hh = await app(fresh);
    fresh.setBehavior({ jwksDelayMs: 9_000 });
    const t0 = Date.now();
    refused(await hh.signIn('ignored', { loginHint: who.sub }), 'login_failed');
    expect(Date.now() - t0).toBeLessThan(8_000);
    fresh.reset();
    signedIn(await hh.signIn('ignored', { loginHint: who.sub }));
  });

  test('a token endpoint that hangs is cut off (about 10 s), not held for the library default of 30 s', async () => {
    const fresh = await provider([who]);
    const hh = await app(fresh);
    fresh.setBehavior({ tokenDelayMs: 16_000 });
    const t0 = Date.now();
    refused(await hh.signIn('ignored', { loginHint: who.sub }), 'login_failed');
    expect(Date.now() - t0).toBeLessThan(13_000);
    fresh.reset();
    signedIn(await hh.signIn('ignored', { loginHint: who.sub }));
  }, 60_000);

  test('key rotation: an unknown kid triggers at most ONE bounded JWKS refetch per cool-down; sign-in recovers after it', async () => {
    const fresh = await provider([who]);
    const hh = await app(fresh);
    const realNow = Date.now.bind(Date);
    let skewMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skewMs);

    signedIn(await hh.signIn('ignored', { loginHint: who.sub })); // primes the JWKS cache
    expect(fresh.jwksRequests).toBe(1);
    await fresh.rotateKey(); // new kid; the old key is withdrawn

    for (let i = 0; i < 4; i++) refused(await hh.signIn('ignored', { loginHint: who.sub }), 'login_failed');
    expect(fresh.jwksRequests).toBe(1); // inside the cool-down: hammering with unknown kids does NOT hammer the provider

    skewMs = 31_000; // the cool-down (30 s) has passed
    signedIn(await hh.signIn('ignored', { loginHint: who.sub }));
    expect(fresh.jwksRequests).toBe(2); // exactly one refetch picked up the new key
  });

  test('a provider that publishes the new key alongside the old one keeps working across the rotation', async () => {
    const fresh = await provider([who]);
    const hh = await app(fresh);
    signedIn(await hh.signIn('ignored', { loginHint: who.sub }));
    await fresh.rotateKey({ keepOld: true });
    fresh.setBehavior({});
    // Tokens are now signed with the new key; the cached set does not contain it yet, so within the cool-down this fails once
    // (documented): operators who rotate keys should publish ahead of use. After the cool-down it succeeds.
    const realNow = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 31_000);
    signedIn(await hh.signIn('ignored', { loginHint: who.sub }));
  });
});

describe('errors the provider returns on the authorization endpoint', () => {
  const who: MockUser = { sub: 'err-user', email: 'engineer@acme.test', emailVerified: true };
  let idp: MockIdp;
  let h: OidcHarness;
  beforeAll(async () => { idp = await provider([who]); h = await app(idp); });
  afterEach(() => idp.reset());

  test.each([
    ['login_required', 'login_required'], ['interaction_required', 'interaction_required'], ['consent_required', 'consent_required'],
    ['temporarily_unavailable', 'temporarily_unavailable'], ['server_error', 'server_error'], ['invalid_scope', 'invalid_scope'],
    ['a 5,000-character error code', 'x'.repeat(5000)],
  ])('error: %s becomes a generic message', async (_label, code) => {
    idp.setBehavior({ authorizeError: code });
    const r = await h.signIn('ignored', { loginHint: who.sub });
    refused(r, 'login_failed');
    expect(r.location).toBe(`${WEB}/?auth_error=login_failed`); // no provider text, no stack, no 500
  });

  test('an authorization endpoint that rejects an unregistered redirect URI never sends the browser back (nothing to complete)', async () => {
    const wrong = await app(idp, { OIDC_REDIRECT_URI: `${WEB}/some/other/callback` });
    const login = await wrong.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/login' });
    const res = await fetch(String(login.headers.location), { redirect: 'manual' });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });
});

describe('client authentication method', () => {
  const who: MockUser = { sub: 'auth-user', email: 'engineer@acme.test', emailVerified: true };
  test('a provider that supports only client_secret_post (and advertises that) is served with client_secret_post', async () => {
    const idp = await provider([who], { tokenAuthMethods: ['client_secret_post'] });
    const h = await app(idp);
    signedIn(await h.signIn('ignored', { loginHint: who.sub }));
    expect(idp.tokenRequests.at(-1)?.authMethod).toBe('client_secret_post');
  });
  test('a provider that supports only HTTP basic is served with basic', async () => {
    const idp = await provider([who], { tokenAuthMethods: ['client_secret_basic'] });
    const h = await app(idp);
    signedIn(await h.signIn('ignored', { loginHint: who.sub }));
    expect(idp.tokenRequests.at(-1)?.authMethod).toBe('client_secret_basic');
  });
});

describe('claim values from a real directory are hostile data', () => {
  const hostileName = `<img src=x onerror=alert(1)>Eve\u0007\u0000\n${'x'.repeat(5000)}`;
  const users: MockUser[] = [
    { sub: 'hostile-name', email: 'hostile@acme.test', emailVerified: true, name: hostileName },
    { sub: 'long-email', email: `${'a'.repeat(300)}@acme.test`, emailVerified: true },
    { sub: 'l'.repeat(300), email: 'longsub@acme.test', emailVerified: true },
    { sub: 'cyrillic', email: 'user@аcme.test', emailVerified: true }, // Cyrillic "а": looks like acme.test, is not
    { sub: 'spaced', email: 'a b@acme.test', emailVerified: true },
    { sub: 'shouty', email: 'ENGINEER@ACME.TEST', emailVerified: true, name: 'Erin Engineer' },
    { sub: 'string-verified-false', email: 'viewer@acme.test', emailVerified: 'false' },
    { sub: 'string-verified-true', email: 'viewer@acme.test', emailVerified: 'true' },
    // Entra groups overage: the group list is replaced by pointers the app must not follow
    { sub: 'overage', email: 'overage@acme.test', emailVerified: true, claims: { _claim_names: { groups: 'src1' }, _claim_sources: { src1: { endpoint: 'https://graph.microsoft.com/v1.0/users/x/getMemberObjects' } } } },
    { sub: 'guid-admin', email: 'guidadmin@acme.test', emailVerified: true, groups: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'] },
    { sub: 'guid-unmapped', email: 'guidother@acme.test', emailVerified: true, groups: ['99999999-9999-4999-8999-999999999999'] },
    { sub: 'groups-as-string', email: 'groupstr@acme.test', emailVerified: true, claims: { groups: '11111111-1111-4111-8111-111111111111' } },
  ];
  let idp: MockIdp;
  let invite: OidcHarness;
  let jit: OidcHarness;
  beforeAll(async () => {
    idp = await provider(users);
    invite = await app(idp);
    jit = await app(idp, {
      OIDC_PROVISIONING: 'jit', OIDC_DEFAULT_ORG_SLUG: 'acme', OIDC_ALLOWED_EMAIL_DOMAINS: 'acme.test',
      OIDC_GROUP_ROLE_MAP: JSON.stringify({ '11111111-1111-4111-8111-111111111111': 'admin' }),
    });
  });
  const hint = (sub: string) => ({ loginHint: sub });

  test('a hostile display name is stored without markup or control characters and is capped; sign-in still works', async () => {
    const c = await jit.session('ignored', hint('hostile-name'));
    const me = (await c.req('GET', '/api/v1/auth/session')).json;
    expect(me.user.displayName).not.toMatch(/[<>\u0000-\u001f\u007f]/);
    expect(me.user.displayName.length).toBeLessThanOrEqual(100);
    expect(me.user.displayName).toContain('Eve');
  });

  test('an e-mail over the length limit, a subject over 255 characters, an e-mail with whitespace: refused, nothing created', async () => {
    const before = await jit.db.c.users.countDocuments();
    for (const sub of ['long-email', 'l'.repeat(300), 'spaced']) refused(await jit.signIn('ignored', hint(sub)), 'login_failed');
    expect(await jit.db.c.users.countDocuments()).toBe(before);
  });

  test('a look-alike (Cyrillic) domain does not pass the allow-list', async () => {
    refused(await jit.signIn('ignored', hint('cyrillic')), 'not_authorized');
  });

  test('e-mail letter case differences still bind to the pre-provisioned account, and the identity is (issuer, sub)', async () => {
    signedIn(await invite.signIn('ignored', hint('shouty')));
    const u = await invite.db.c.users.findOne({ emailLower: 'engineer@acme.test' });
    expect(u?.externalSubject).toBe('shouty');
    expect(u?.externalIssuer).toBe(idp.issuer);
    expect(u?.email).toBe('engineer@acme.test'); // the stored address is not overwritten by the provider's casing
  });

  test('email_verified as the STRING "false" is refused, as the string "true" is accepted (providers differ)', async () => {
    refused(await invite.signIn('ignored', hint('string-verified-false')), 'not_authorized');
    signedIn(await invite.signIn('ignored', hint('string-verified-true')));
  });

  test('groups overage (_claim_names, no groups claim): provisioned as a plain member; the pointer is never followed', async () => {
    const c = await jit.session('ignored', hint('overage'));
    expect((await c.req('GET', '/api/v1/auth/session')).json.orgRole).toBe('member');
  });

  test('group GUIDs map to a role only when listed in the operator map, only at first provisioning', async () => {
    const admin = await jit.session('ignored', hint('guid-admin'));
    expect((await admin.req('GET', '/api/v1/auth/session')).json.orgRole).toBe('admin');
    const other = await jit.session('ignored', hint('guid-unmapped'));
    expect((await other.req('GET', '/api/v1/auth/session')).json.orgRole).toBe('member');
  });

  test('a single group sent as a string (not an array) grants nothing', async () => {
    const c = await jit.session('ignored', hint('groups-as-string'));
    expect((await c.req('GET', '/api/v1/auth/session')).json.orgRole).toBe('member');
  });
});

describe('disabled accounts and providers without an end-session endpoint', () => {
  const users: MockUser[] = [
    { sub: 'bound-then-disabled', email: 'auditor@acme.test', emailVerified: true },
    { sub: 'logout-user', email: 'viewer@acme.test', emailVerified: true },
  ];
  test('a user disabled AFTER their identity was bound can no longer sign in, and their live session stops working', async () => {
    const idp = await provider(users);
    const h = await app(idp);
    const c = await h.session('ignored', { loginHint: 'bound-then-disabled' });
    expect((await c.req('GET', '/api/v1/auth/session')).status).toBe(200);
    await h.db.c.users.updateOne({ _id: c.userId }, { $set: { disabledAt: new Date() } });
    refused(await h.signIn('ignored', { loginHint: 'bound-then-disabled' }), 'not_authorized');
    expect((await c.req('GET', '/api/v1/projects')).status).toBe(401);
  });

  test('without an end_session_endpoint, logout still revokes the session locally and returns no provider redirect', async () => {
    const idp = await provider(users, { omitEndSession: true });
    const h = await app(idp);
    const c = await h.session('ignored', { loginHint: 'logout-user' });
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: c.cookie, 'x-csrf-token': c.csrf, origin: h.cfg.webOrigin } });
    expect(res.statusCode).toBe(200);
    expect(res.json().redirect).toBeNull();
    expect((await c.req('GET', '/api/v1/auth/session')).status).toBe(401);
  });
});

describe('issuer normalisation (configuration unit)', () => {
  const parse = (issuer: string) => parseOidcConfig({ OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'x' }, { webOrigin: 'http://localhost:5173', production: false }).issuer;
  test('a bare origin is the same issuer with or without a slash; a path is kept exactly as configured', () => {
    expect(parse('https://tenant.auth0.com/')).toBe('https://tenant.auth0.com');
    expect(parse('https://tenant.auth0.com')).toBe('https://tenant.auth0.com');
    expect(parse('https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0')).toBe('https://login.microsoftonline.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0');
    expect(parse('https://tenant.b2clogin.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0/')).toBe('https://tenant.b2clogin.com/72f988bf-86f1-41af-91ab-2d7cd011db47/v2.0/');
    expect(parse('https://auth.example.com/application/o/nexus/')).toBe('https://auth.example.com/application/o/nexus/');
  });
});
