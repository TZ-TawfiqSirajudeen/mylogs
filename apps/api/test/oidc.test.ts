import { startTestMongo } from '@nexus/database/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { safeReturnTo } from '../src/auth/oidc.js';
import { CLIENT_SECRET, oidcHarness, SECURE_WEB, WEB, type OidcHarness } from './oidc-helpers.js';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
const open: OidcHarness[] = [];
const MOCK_USERS = [
  { sub: 'sub-owner', email: 'owner@acme.test', emailVerified: true, name: 'Olivia Owner' },
  { sub: 'sub-admin', email: 'admin@acme.test', emailVerified: true, name: 'Adam Admin' },
  { sub: 'sub-engineer', email: 'engineer@acme.test', emailVerified: true, name: 'Erin Engineer' },
  { sub: 'sub-viewer', email: 'viewer@acme.test', emailVerified: true },
  { sub: 'sub-auditor', email: 'auditor@acme.test', emailVerified: true },
  { sub: 'sub-globex', email: 'owner@globex.test', emailVerified: true },
  { sub: 'sub-stranger', email: 'stranger@elsewhere.test', emailVerified: true },
  { sub: 'sub-unverified', email: 'viewer@acme.test', emailVerified: false },
  { sub: 'sub-imposter', email: 'engineer@acme.test', emailVerified: true },
  { sub: 'sub-claims', email: 'claims@acme.test', emailVerified: true, groups: ['admins', 'sre'], claims: { role: 'owner', roles: ['admin', 'owner'], admin: true, is_admin: true, org_role: 'owner' } },
  { sub: 'sub-admin-lookalike', email: 'administrator@acme.test', emailVerified: true, claims: { role: 'owner' } },
  { sub: 'sub-sre', email: 'sre@acme.test', emailVerified: true, groups: ['sre'] },
  { sub: 'sub-outsider', email: 'someone@gmail.test', emailVerified: true, groups: ['sre'] },
  { sub: 'sub-onlyadmins', email: 'onlyadmins@acme.test', emailVerified: true, groups: ['admins'], claims: { role: 'owner', admin: true } },
  { sub: 'sub-noemail' },
];

async function make(opts: Parameters<typeof oidcHarness>[1] = {}): Promise<OidcHarness> {
  const h = await oidcHarness(mongo.uri, { users: MOCK_USERS, ...opts });
  open.push(h);
  return h;
}

beforeAll(async () => { mongo = await startTestMongo(); }, 240_000);
afterAll(async () => {
  for (const h of open) { await h.app.close(); await h.db.close(); }
  for (const idp of new Set(open.map((h) => h.idp))) await idp.close();
  await mongo?.stop();
});

describe('safeReturnTo', () => {
  test.each([
    ['/logs?q=a#x', '/logs?q=a'], ['/projects/1', '/projects/1'],
    ['//evil.example', '/'], ['https://evil.example', '/'], ['/\\evil.example', '/'], ['javascript:alert(1)', '/'], ['/api/v1/auth/session', '/'],
    ['', '/'], [undefined, '/'], ['/a\nb', '/'], ['evil', '/'], ['/' + 'a'.repeat(600), '/'],
  ])('%s -> %s', (input, out) => { expect(safeReturnTo(input)).toBe(out); });
});

describe('sign-in: authorization code flow with PKCE', () => {
  let h: OidcHarness;
  beforeAll(async () => { h = await make(); });

  test('succeeds for a pre-provisioned user and sends proper authorization parameters', async () => {
    h.idp.reset();
    const r = await h.signIn('engineer@acme.test', { returnTo: '/projects?x=1' });
    expect(r.status).toBe(302);
    expect(r.location).toBe(`${WEB}/projects?x=1`);
    expect(r.authError).toBeNull();

    const req = h.idp.authorizationRequests.at(-1)!;
    expect(req.clientId).toBe('nexus-test');
    expect(req.redirectUri).toBe(`${WEB}/api/v1/auth/oidc/callback`); // exactly the configured URI
    expect(req.codeChallengeMethod).toBe('S256');
    expect(req.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(req.state.length).toBeGreaterThanOrEqual(20);
    expect(req.nonce.length).toBeGreaterThanOrEqual(20);
    expect(req.scope.split(' ')).toContain('openid');
    const tok = h.idp.tokenRequests.at(-1)!;
    expect(tok).toMatchObject({ grantType: 'authorization_code', hasVerifier: true, authMethod: 'client_secret_basic' });
    // The client secret is sent only to the token endpoint, never through the browser.
    expect(r.loginLocation).not.toContain(CLIENT_SECRET);
    expect(r.callbackUrl).not.toContain(CLIENT_SECRET);
  });

  test('the session cookie is HttpOnly + SameSite=Lax and the flow cookie is cleared; no token reaches the browser', async () => {
    const r = await h.signIn('viewer@acme.test');
    const sid = r.setCookies.find((c) => c.startsWith('nx_sid='))!;
    expect(sid).toMatch(/HttpOnly/i);
    expect(sid).toMatch(/SameSite=Lax/i);
    expect(sid).toMatch(/Path=\//);
    expect(r.setCookies.find((c) => c.startsWith('nx_flow=') && /Expires=Thu, 01 Jan 1970|Max-Age=0/i.test(c))).toBeTruthy();
    expect(r.location).not.toMatch(/id_token|access_token|code=|state=/);
    expect(r.setCookies.join('\n')).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./); // no JWT in any cookie
  });

  test('the flow cookie is HttpOnly, SameSite=Lax and short-lived', async () => {
    const r = await h.signIn('viewer@acme.test');
    expect(r.flowCookie).toMatch(/HttpOnly/i);
    expect(r.flowCookie).toMatch(/SameSite=Lax/i);
    expect(r.flowCookie).toMatch(/Max-Age=600/);
  });

  test('binds the identity (issuer + subject) to the pre-provisioned account and audits the login', async () => {
    const c = await h.session('auditor@acme.test');
    const user = (await h.db.c.users.findOne({ _id: c.userId }))!;
    expect(user.externalSubject).toBe('sub-auditor');
    expect(user.externalIssuer).toBe(h.idp.issuer);
    const ev = await h.db.c.auditEvents.findOne({ action: 'auth.login', actorUserId: c.userId });
    expect(ev?.metadata).toMatchObject({ mode: 'oidc' });
    const me = await c.req('GET', '/api/v1/auth/session');
    expect(me.json).toMatchObject({ orgRole: 'auditor', authMode: 'oidc', user: { email: 'auditor@acme.test' } });
  });

  test('later sign-ins match on (issuer, sub), not on e-mail', async () => {
    const before = (await h.session('viewer@acme.test')).userId;
    await h.db.c.users.updateOne({ _id: before }, { $set: { email: 'renamed@acme.test', emailLower: 'renamed@acme.test' } });
    expect((await h.session('viewer@acme.test')).userId).toBe(before);
  });

  test('the deep link survives the round trip, but off-site destinations collapse to /', async () => {
    expect((await h.signIn('engineer@acme.test', { returnTo: '/logs?service=checkout' })).location).toBe(`${WEB}/logs?service=checkout`);
    for (const evil of ['//evil.example/x', 'https://evil.example', '/\\evil.example', 'javascript:alert(1)']) {
      expect((await h.signIn('engineer@acme.test', { returnTo: evil })).location).toBe(`${WEB}/`);
    }
  });

  test('a stored returnTo is not taken from the callback request (cannot be altered by the redirect)', async () => {
    const r = await h.signIn('engineer@acme.test', { returnTo: '/safe', mutateCallback: (u) => `${u}&returnTo=https://evil.example` });
    expect(r.location).toBe(`${WEB}/safe`);
  });
});

describe('sign-in failures are safe and generic', () => {
  let h: OidcHarness;
  let engineerUserId: string | undefined;
  beforeAll(async () => { h = await make(); });
  const noSession = (r: { sessionCookie: string | null; location: string }, code: string) => {
    expect(r.sessionCookie).toBeNull();
    expect(r.location).toBe(`${WEB}/?auth_error=${code}`);
  };

  test('missing flow cookie (another browser, blocked cookies, or a forged callback)', async () => {
    noSession(await h.signIn('engineer@acme.test', { dropFlowCookie: true }), 'login_failed');
  });

  test('state mismatch', async () => {
    h.idp.setBehavior({ wrongState: true });
    noSession(await h.signIn('engineer@acme.test'), 'login_failed');
    h.idp.reset();
  });

  test('a flow cannot be replayed', async () => {
    let first: string | null = null;
    const r1 = await h.signIn('engineer@acme.test', { mutateCallback: (u) => { first = u; return u; } });
    expect(r1.sessionCookie).toBeTruthy();
    // Re-deliver the very same callback with the same flow cookie.
    const again = await h.app.inject({ method: 'GET', url: first!, headers: { cookie: r1.cookieHeader } });
    expect(String(again.headers.location)).toBe(`${WEB}/?auth_error=login_failed`);
    const replayCookies = ([] as unknown[]).concat(again.headers['set-cookie'] ?? []).map(String);
    expect(replayCookies.filter((c) => /^nx_sid=[^;]/.test(c))).toEqual([]); // no session cookie issued on replay
  });

  test('a flow from another browser cannot be completed with this one\'s cookie', async () => {
    const a = await h.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/login' });
    const b = await h.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/login' });
    const flowA = String(a.headers['set-cookie']).split(';')[0]!;
    const urlB = new URL(String(b.headers.location));
    urlB.searchParams.set('login_hint', 'engineer@acme.test');
    const cb = new URL(String((await fetch(urlB, { redirect: 'manual' })).headers.get('location')));
    const res = await h.app.inject({ method: 'GET', url: `${cb.pathname}${cb.search}`, headers: { cookie: flowA } });
    expect(String(res.headers.location)).toBe(`${WEB}/?auth_error=login_failed`);
  });

  test('expired flow records are rejected', async () => {
    const login = await h.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/login' });
    const flow = String(login.headers['set-cookie']).split(';')[0]!;
    const u = new URL(String(login.headers.location));
    u.searchParams.set('login_hint', 'engineer@acme.test');
    const cb = new URL(String((await fetch(u, { redirect: 'manual' })).headers.get('location')));
    await h.db.c.authFlows.updateMany({}, { $set: { expireAt: new Date(Date.now() - 1000) } }); // the 10-minute window has passed
    const res = await h.app.inject({ method: 'GET', url: `${cb.pathname}${cb.search}`, headers: { cookie: flow } });
    expect(String(res.headers.location)).toBe(`${WEB}/?auth_error=login_failed`);
  });

  test('the identity provider denying access', async () => {
    h.idp.setBehavior({ denyAuthorize: true });
    noSession(await h.signIn('engineer@acme.test'), 'idp_denied');
    h.idp.reset();
  });

  test('token endpoint errors', async () => {
    h.idp.setBehavior({ tokenError: true });
    noSession(await h.signIn('engineer@acme.test'), 'login_failed');
    h.idp.reset();
  });

  test('a mismatching `iss` authorization response parameter (mix-up attack) is refused', async () => {
    h.idp.setBehavior({ wrongIssParam: true });
    noSession(await h.signIn('engineer@acme.test'), 'login_failed');
    h.idp.reset();
  });

  test.each([
    'signature', 'nonce', 'audience', 'issuer', 'expired', 'not-yet-valid', 'missing-sub', 'missing-nonce', 'alg-none', 'wrong-azp', 'no-id-token',
  ] as const)('invalid ID token (%s) never creates a session', async (tamper) => {
    const engineerId = () => engineerUserId!;
    engineerUserId ??= (await h.db.c.users.findOne({ emailLower: 'engineer@acme.test' }))!._id;
    const before = await h.db.c.sessions.countDocuments({ userId: engineerUserId });
    h.idp.setBehavior({ tamper });
    const r = await h.signIn('engineer@acme.test');
    noSession(r, 'login_failed');
    expect(await h.db.c.sessions.countDocuments({ userId: engineerId() })).toBe(before);
    h.idp.reset();
  });

  test('an invalid token leaves no trace of a bound identity for a brand new subject', async () => {
    h.idp.setBehavior({ tamper: 'signature' });
    noSession(await h.signIn('auditor@acme.test'), 'login_failed');
    h.idp.reset();
    const u = await h.db.c.users.findOne({ emailLower: 'auditor@acme.test' });
    expect(u?.externalSubject ?? null).toBeNull();
  });

  test('missing code, duplicated parameters and garbage are rejected', async () => {
    noSession(await h.signIn('engineer@acme.test', { mutateCallback: (u) => u.replace(/([?&])code=[^&]+&?/, '$1') }), 'login_failed');
    noSession(await h.signIn('engineer@acme.test', { mutateCallback: (u) => `${u}&state=other` }), 'login_failed');
    noSession(await h.signIn('engineer@acme.test', { mutateCallback: (u) => u.replace(/code=[^&]+/, 'code=forged') }), 'login_failed');
    const bare = await h.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/callback' });
    expect(String(bare.headers.location)).toBe(`${WEB}/?auth_error=login_failed`);
  });

  test('error pages never echo provider error text or tokens', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/callback?error=server_error&error_description=<script>alert(1)</script>' });
    expect(String(res.headers.location)).toBe(`${WEB}/?auth_error=login_failed`);
    expect(res.body).not.toContain('script');
  });

  test('IdP unreachable at login start yields a clean redirect, not an error page', async () => {
    const dead = await oidcHarness(mongo.uri, { users: [], env: { OIDC_ISSUER: 'http://127.0.0.1:1' } });
    open.push(dead);
    const r = await dead.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/login' });
    expect(r.statusCode).toBe(302);
    expect(String(r.headers.location)).toBe(`${WEB}/?auth_error=idp_unavailable`);
  });
});

describe('who may sign in (invite-only is the default)', () => {
  let h: OidcHarness;
  beforeAll(async () => { h = await make(); });

  test('an unknown person is refused and no account is created', async () => {
    const users = await h.db.c.users.countDocuments();
    const r = await h.signIn('stranger@elsewhere.test');
    expect(r.sessionCookie).toBeNull();
    expect(r.authError).toBe('not_authorized');
    expect(await h.db.c.users.countDocuments()).toBe(users);
  });

  test('a provider account without an e-mail address cannot be provisioned', async () => {
    const r = await h.signIn('ignored', { loginHint: 'sub-noemail' });
    expect(r.sessionCookie).toBeNull();
    expect(r.authError).toBe('login_failed');
  });

  test('a different subject with the same e-mail cannot take over a bound account', async () => {
    await h.session('engineer@acme.test'); // binds sub-engineer
    h.idp.addUser({ sub: 'sub-imposter-2', email: 'engineer@acme.test', emailVerified: true });
    const r = await h.signIn('ignored', { loginHint: 'sub-imposter-2' });
    expect(r.sessionCookie).toBeNull();
    expect(r.authError).toBe('not_authorized');
    const u = await h.db.c.users.findOne({ emailLower: 'engineer@acme.test' });
    expect(u?.externalSubject).toBe('sub-engineer');
  });

  test('an unverified e-mail is refused even if it matches a pre-provisioned account', async () => {
    h.idp.addUser({ sub: 'sub-unverified-2', email: 'viewer@acme.test', emailVerified: false });
    const r = await h.signIn('ignored', { loginHint: 'sub-unverified-2' });
    expect(r.sessionCookie).toBeNull();
    expect(r.authError).toBe('not_authorized');
    const u = await h.db.c.users.findOne({ emailLower: 'viewer@acme.test' });
    expect(u?.externalSubject === 'sub-unverified-2').toBe(false);
  });

  test('a disabled account cannot sign in', async () => {
    await h.session('admin@acme.test');
    await h.db.c.users.updateOne({ emailLower: 'admin@acme.test' }, { $set: { disabledAt: new Date() } });
    const r = await h.signIn('admin@acme.test');
    expect(r.sessionCookie).toBeNull();
    expect(r.authError).toBe('not_authorized');
    await h.db.c.users.updateOne({ emailLower: 'admin@acme.test' }, { $set: { disabledAt: null } });
  });

  test('a user without any organization membership cannot sign in', async () => {
    await h.session('owner@globex.test');
    await h.db.c.orgMemberships.deleteMany({ userId: (await h.db.c.users.findOne({ emailLower: 'owner@globex.test' }))!._id });
    const r = await h.signIn('owner@globex.test');
    expect(r.authError).toBe('not_authorized');
  });

  test('no role is ever taken from token claims or from an admin-looking e-mail', async () => {
    const owner = await h.session('owner@acme.test');
    expect((await owner.req('POST', '/api/v1/org/members', { email: 'claims@acme.test', role: 'member' })).status).toBe(201);
    expect((await owner.req('POST', '/api/v1/org/members', { email: 'administrator@acme.test', role: 'member' })).status).toBe(201);
    for (const email of ['claims@acme.test', 'administrator@acme.test']) {
      const c = await h.session(email);
      const me = await c.req('GET', '/api/v1/auth/session');
      expect(me.json.orgRole).toBe('member');
      expect((await c.req('POST', '/api/v1/projects', { name: 'nope', environments: [{ name: 'Dev' }] })).status).toBe(403);
      expect((await c.req('GET', '/api/v1/org/members')).status).toBe(403);
      expect((await c.req('GET', '/api/v1/audit')).status).toBe(403);
    }
  });

  test('an invited person can sign in only after an administrator pre-authorizes them', async () => {
    h.idp.addUser({ sub: 'sub-new', email: 'new.hire@acme.test', emailVerified: true });
    expect((await h.signIn('new.hire@acme.test')).authError).toBe('not_authorized');
    const owner = await h.session('owner@acme.test');
    expect((await owner.req('POST', '/api/v1/org/members', { email: 'new.hire@acme.test', role: 'member' })).status).toBe(201);
    const c = await h.session('new.hire@acme.test');
    expect((await c.req('GET', '/api/v1/auth/session')).json.orgRole).toBe('member');
  });

  test('a dev-style login does not exist in OIDC mode', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/auth/dev-login', headers: { origin: h.cfg.webOrigin }, payload: { email: 'owner@acme.test' } });
    expect(res.statusCode).toBe(404);
  });
});

describe('just-in-time provisioning (opt-in, domain restricted, no admin from claims)', () => {
  let h: OidcHarness;
  beforeAll(async () => {
    h = await make({ env: { OIDC_PROVISIONING: 'jit', OIDC_DEFAULT_ORG_SLUG: 'acme', OIDC_ALLOWED_EMAIL_DOMAINS: 'acme.test' } });
  });

  test('creates a plain member with no project access for an allowed domain', async () => {
    const c = await h.session('administrator@acme.test'); // an admin-looking e-mail plus a role=owner claim
    const me = (await c.req('GET', '/api/v1/auth/session')).json;
    expect(me.orgRole).toBe('member');
    expect(me.org.slug).toBe('acme');
    expect((await c.req('GET', '/api/v1/projects')).json).toEqual([]);
    expect((await c.req('POST', '/api/v1/projects', { name: 'nope', environments: [{ name: 'Dev' }] })).status).toBe(403);
    const ev = await h.db.c.auditEvents.findOne({ action: 'auth.login', actorUserId: c.userId });
    expect(ev?.metadata).toMatchObject({ provisioned: true });
  });

  test('claims such as role/admin/groups do not elevate anyone when no group map is configured', async () => {
    const c = await h.session('claims@acme.test');
    expect((await c.req('GET', '/api/v1/auth/session')).json.orgRole).toBe('member');
  });

  test('other domains are refused', async () => {
    const r = await h.signIn('someone@gmail.test');
    expect(r.sessionCookie).toBeNull();
    expect(r.authError).toBe('not_authorized');
    expect(await h.db.c.users.findOne({ emailLower: 'someone@gmail.test' })).toBeNull();
  });

  test('a pre-existing member is not promoted by group claims at later sign-ins', async () => {
    const c = await h.session('engineer@acme.test');
    expect((await c.req('GET', '/api/v1/auth/session')).json.orgRole).toBe('member');
  });
});

describe('just-in-time provisioning with an explicit group map', () => {
  let h: OidcHarness;
  beforeAll(async () => {
    h = await make({ env: { OIDC_PROVISIONING: 'jit', OIDC_DEFAULT_ORG_SLUG: 'acme', OIDC_ALLOWED_EMAIL_DOMAINS: 'acme.test', OIDC_GROUP_ROLE_MAP: '{"sre":"admin"}' } });
  });

  test('applies the mapped role at first provisioning only', async () => {
    const c = await h.session('sre@acme.test');
    expect((await c.req('GET', '/api/v1/auth/session')).json.orgRole).toBe('admin');
    // Later group changes at the IdP do not rewrite the stored role.
    await h.db.c.orgMemberships.updateOne({ userId: c.userId }, { $set: { role: 'member' } });
    const again = await h.session('sre@acme.test');
    expect((await again.req('GET', '/api/v1/auth/session')).json.orgRole).toBe('member');
  });

  test('the unmapped "admins" group grants nothing, and owner is never reachable', async () => {
    const c = await h.session('onlyadmins@acme.test');
    expect((await c.req('GET', '/api/v1/auth/session')).json.orgRole).toBe('member');
  });

  test('a mapped group does not bypass the domain allow-list', async () => {
    const r = await h.signIn('someone@gmail.test');
    expect(r.authError).toBe('not_authorized');
  });
});

describe('session fixation, expiry and logout', () => {
  let h: OidcHarness;
  beforeAll(async () => { h = await make(); });

  test('a session cookie planted before login is never adopted, and a real earlier session is revoked', async () => {
    const planted = 'nx_sid=attacker-chosen-value';
    const r = await h.signIn('engineer@acme.test', { cookies: planted });
    expect(r.sessionCookie).toBeTruthy();
    expect(r.sessionCookie).not.toBe(planted);
    const probe = await h.app.inject({ method: 'GET', url: '/api/v1/auth/session', headers: { cookie: planted } });
    expect(probe.statusCode).toBe(401);

    const first = await h.session('viewer@acme.test');
    const second = await h.signIn('viewer@acme.test', { cookies: first.cookie });
    expect(second.sessionCookie).toBeTruthy();
    expect(second.sessionCookie).not.toBe(first.cookie);
    expect((await first.req('GET', '/api/v1/auth/session')).status).toBe(401); // the pre-login session died
  });

  test('sessions expire (idle and absolute) and are rejected afterwards', async () => {
    const c = await h.session('engineer@acme.test');
    expect((await c.req('GET', '/api/v1/auth/session')).status).toBe(200);
    await h.db.c.sessions.updateMany({ userId: c.userId }, { $set: { idleExpiresAt: new Date(Date.now() - 1000) } });
    expect((await c.req('GET', '/api/v1/auth/session')).status).toBe(401);
    const d = await h.session('engineer@acme.test');
    await h.db.c.sessions.updateMany({ userId: d.userId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await d.req('GET', '/api/v1/auth/session')).status).toBe(401);
  });

  test('logout revokes the session, clears the cookie and returns the IdP end-session URL', async () => {
    const c = await h.session('auditor@acme.test');
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: c.cookie, 'x-csrf-token': c.csrf, origin: h.cfg.webOrigin } });
    expect(res.statusCode).toBe(200);
    const target = new URL(res.json().redirect);
    expect(target.origin).toBe(h.idp.url);
    expect(target.pathname).toBe('/logout');
    expect(target.searchParams.get('post_logout_redirect_uri')).toBe(`${WEB}/`);
    expect(target.searchParams.get('client_id')).toBe('nexus-test');
    expect(String(res.headers['set-cookie'])).toMatch(/nx_sid=;/);
    expect((await c.req('GET', '/api/v1/auth/session')).status).toBe(401);
    // The same cookie after logout is useless even if a client keeps replaying it.
    expect((await c.req('GET', '/api/v1/projects')).status).toBe(401);
  });

  test('logout needs the CSRF token and an allowed Origin (no forced logout from another site)', async () => {
    const c = await h.session('auditor@acme.test');
    const noCsrf = await h.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: c.cookie, origin: h.cfg.webOrigin } });
    expect(noCsrf.statusCode).toBe(403);
    const evil = await h.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: c.cookie, 'x-csrf-token': c.csrf, origin: 'https://evil.example' } });
    expect(evil.statusCode).toBe(403);
    expect((await c.req('GET', '/api/v1/auth/session')).status).toBe(200);
  });

  test('state-changing API calls under OIDC sessions still require the CSRF token', async () => {
    const c = await h.session('owner@acme.test');
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/projects', headers: { cookie: c.cookie, origin: h.cfg.webOrigin }, payload: { name: 'x', environments: [{ name: 'Dev' }] } });
    expect(res.statusCode).toBe(403);
  });

  test('removing a member ends their live OIDC session at once', async () => {
    const owner = await h.session('owner@acme.test');
    const v = await h.session('viewer@acme.test');
    expect((await owner.req('DELETE', `/api/v1/org/members/${v.userId}`)).status).toBe(204);
    expect((await v.req('GET', '/api/v1/auth/session')).status).toBe(401);
    expect((await h.signIn('viewer@acme.test')).authError).toBe('not_authorized');
  });
});

describe('secure deployment mode', () => {
  test('uses __Host- cookies with the Secure attribute for both the session and the sign-in flow', async () => {
    const h = await make({ secure: true });
    const r = await h.signIn('engineer@acme.test');
    expect(r.location).toBe(`${SECURE_WEB}/`);
    const flow = r.flowCookie!;
    expect(flow).toMatch(/^__Host-nx_flow=/);
    expect(flow).toMatch(/; Secure/i);
    const sid = r.setCookies.find((c) => c.startsWith('__Host-nx_sid=') && !c.startsWith('__Host-nx_sid=;'))!;
    expect(sid).toMatch(/HttpOnly/i);
    expect(sid).toMatch(/; Secure/i);
    expect(sid).toMatch(/SameSite=Lax/i);
    expect(sid).not.toMatch(/Domain=/i); // __Host- cookies are host-only
  });
});

describe('authorization under OIDC sessions', () => {
  let h: OidcHarness;
  let projectId: string;
  let dev: string;
  beforeAll(async () => {
    h = await make();
    const owner = await h.session('owner@acme.test');
    const p = (await owner.req('POST', '/api/v1/projects', { name: 'OIDC project', environments: [{ name: 'Dev' }, { name: 'Prod', isProduction: true }] })).json;
    projectId = p.id; dev = p.environments[0].id;
    const viewer = await h.session('viewer@acme.test');
    const engineer = await h.session('engineer@acme.test');
    expect((await owner.req('PUT', `/api/v1/projects/${projectId}/members/${viewer.userId}`, { role: 'viewer', environmentIds: [dev] })).status).toBe(204);
    expect((await owner.req('PUT', `/api/v1/projects/${projectId}/members/${engineer.userId}`, { role: 'engineer' })).status).toBe(204);
  });
  const range = () => ({ from: new Date(Date.now() - 3600_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString() });

  test('tenant isolation: another organization\'s user sees nothing and cannot act on the project', async () => {
    const g = await h.session('owner@globex.test');
    expect((await g.req('GET', `/api/v1/projects/${projectId}`)).status).toBe(404);
    expect((await g.req('POST', `/api/v1/projects/${projectId}/logs/search`, range())).status).toBe(404);
    expect((await g.req('POST', `/api/v1/projects/${projectId}/logs/export`, { query: range(), format: 'csv' })).status).toBe(404);
    expect((await g.req('GET', `/api/v1/projects/${projectId}/ingest-tokens`)).status).toBe(404);
    expect((await g.req('GET', '/api/v1/projects')).json).toEqual([]);
    const members = (await g.req('GET', '/api/v1/org/members')).json as { email: string }[];
    expect(members.every((m) => m.email.endsWith('@globex.test'))).toBe(true);
  });

  test('another organization\'s admin cannot manage acme members', async () => {
    const g = await h.session('owner@globex.test');
    const acmeMember = (await h.db.c.users.findOne({ emailLower: 'engineer@acme.test' }))!._id;
    expect((await g.req('PATCH', `/api/v1/org/members/${acmeMember}`, { role: 'admin' })).status).toBe(404);
    expect((await g.req('DELETE', `/api/v1/org/members/${acmeMember}`)).status).toBe(404);
    expect((await g.req('POST', `/api/v1/org/members/${acmeMember}/revoke-sessions`)).status).toBe(404);
  });

  test('read-only roles: a viewer can search but cannot export, mint tokens or manage anything', async () => {
    const v = await h.session('viewer@acme.test');
    expect((await v.req('POST', `/api/v1/projects/${projectId}/logs/search`, range())).status).toBe(200);
    expect((await v.req('POST', `/api/v1/projects/${projectId}/logs/export`, { query: range(), format: 'csv' })).status).toBe(403);
    expect((await v.req('POST', `/api/v1/projects/${projectId}/environments/${dev}/ingest-tokens`, { name: 'x' })).status).toBe(403);
    expect((await v.req('POST', `/api/v1/projects/${projectId}/environments`, { name: 'Staging' })).status).toBe(403);
    expect((await v.req('GET', '/api/v1/org/members')).status).toBe(403);
    expect((await v.req('POST', '/api/v1/org/members', { email: 'x@acme.test', role: 'member' })).status).toBe(403);
  });

  test('environment scoping is enforced for OIDC-authenticated viewers', async () => {
    const v = await h.session('viewer@acme.test');
    const prod = (await h.db.c.environments.findOne({ projectId, name: 'Prod' }))!._id;
    const forced = await v.req('POST', `/api/v1/projects/${projectId}/logs/search`, { ...range(), environmentIds: [prod] });
    expect(forced.json.items).toEqual([]); // the grant covers Dev only: asking for Prod yields nothing, never Prod data
  });

  test('the auditor can read the audit trail but has no telemetry access', async () => {
    const a = await h.session('auditor@acme.test');
    expect((await a.req('GET', '/api/v1/audit')).status).toBe(200);
    expect((await a.req('POST', `/api/v1/projects/${projectId}/logs/search`, range())).status).toBe(404);
    expect((await a.req('POST', `/api/v1/projects/${projectId}/logs/export`, { query: range(), format: 'csv' })).status).toBe(404);
  });

  test('an engineer may export; the export is audited', async () => {
    const e = await h.session('engineer@acme.test');
    const res = await h.app.inject({
      method: 'POST', url: `/api/v1/projects/${projectId}/logs/export`,
      headers: { cookie: e.cookie, 'x-csrf-token': e.csrf, origin: h.cfg.webOrigin }, payload: { query: range(), format: 'ndjson' },
    });
    expect(res.statusCode).toBe(200);
    expect(await h.db.c.auditEvents.countDocuments({ action: 'logs.exported', actorUserId: e.userId })).toBe(1);
  });

  test('live tail requires an authenticated session', async () => {
    const res = await h.app.inject({ method: 'POST', url: `/api/v1/projects/${projectId}/logs/tail`, headers: { origin: h.cfg.webOrigin }, payload: { query: range() } });
    expect(res.statusCode).toBe(401);
  });

  test('saved queries and history require a session', async () => {
    for (const [method, url] of [['GET', `/api/v1/projects/${projectId}/logs/saved-queries`], ['POST', `/api/v1/projects/${projectId}/logs/saved-queries`], ['GET', `/api/v1/projects/${projectId}/logs/history`]] as const) {
      const res = await h.app.inject({ method, url, headers: { origin: h.cfg.webOrigin }, payload: method === 'POST' ? { name: 'x', query: {} } : undefined });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
  });
});

describe('authentication bypass: every API route is protected', () => {
  let h: OidcHarness;
  beforeAll(async () => { h = await make(); });

  // The ONLY routes that may be reached without a session. Anything new must be added here deliberately.
  const PUBLIC = new Set([
    'GET /healthz', 'GET /readyz', 'GET /api/v1/auth/config', 'GET /api/v1/auth/oidc/login', 'GET /api/v1/auth/oidc/callback',
  ]);
  const isDocs = (url: string) => url === '/docs' || url.startsWith('/docs/');

  test('route inventory: non-public routes all declare the authentication hook', () => {
    const offenders = h.app.routeTable
      .filter((r) => r.method !== 'HEAD' && r.method !== 'OPTIONS')
      .filter((r) => !PUBLIC.has(`${r.method} ${r.url}`) && !isDocs(r.url) && !r.authenticated)
      .map((r) => `${r.method} ${r.url}`);
    expect(offenders).toEqual([]);
    expect(h.app.routeTable.length).toBeGreaterThan(40); // guards against the inventory silently being empty
  });

  test('every protected route answers 401 without a session and 401 with a forged one', async () => {
    const protectedRoutes = h.app.routeTable.filter((r) => r.authenticated && r.method !== 'HEAD' && r.method !== 'OPTIONS');
    expect(protectedRoutes.length).toBeGreaterThan(40);
    for (const r of protectedRoutes) {
      const url = r.url.replace(/:[A-Za-z]+/g, 'x');
      const anon = await h.app.inject({ method: r.method as 'GET', url, headers: { origin: h.cfg.webOrigin }, payload: r.method === 'GET' || r.method === 'DELETE' ? undefined : {} });
      expect(anon.statusCode, `${r.method} ${r.url} (anonymous)`).toBe(401);
      const forged = await h.app.inject({ method: r.method as 'GET', url, headers: { origin: h.cfg.webOrigin, cookie: 'nx_sid=forged', authorization: 'Bearer forged', 'x-csrf-token': 'forged' }, payload: r.method === 'GET' || r.method === 'DELETE' ? undefined : {} });
      expect(forged.statusCode, `${r.method} ${r.url} (forged)`).toBe(401);
    }
  });

  test('bearer tokens, API-key headers and ingest tokens do not authenticate browser APIs', async () => {
    for (const headers of [{ authorization: 'Bearer abc' }, { 'x-api-key': 'abc' }, { authorization: 'Basic YTpi' }]) {
      expect((await h.app.inject({ method: 'GET', url: '/api/v1/projects', headers })).statusCode).toBe(401);
    }
  });

  test('the public config endpoint reveals only the provider name and mode', async () => {
    const res = await h.app.inject('/api/v1/auth/config');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ mode: 'oidc', providerName: 'Mock IdP', loginUrl: '/api/v1/auth/oidc/login', provisioning: 'invite-only' });
    expect(res.body).not.toContain(CLIENT_SECRET);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('secrets and sensitive values never leak', () => {
  test('logs, responses and cookies contain no client secret, authorization code, state, ID token or session token', async () => {
    const lines: string[] = [];
    const h = await make({ logStream: { write: (m: string) => { lines.push(m); } } });
    const r = await h.signIn('engineer@acme.test', { returnTo: '/logs' });
    expect(r.sessionCookie).toBeTruthy();
    // A few failures too: they are logged (reasons only).
    h.idp.setBehavior({ tamper: 'signature' });
    await h.signIn('engineer@acme.test');
    h.idp.reset();
    await h.signIn('engineer@acme.test', { dropFlowCookie: true });

    const authz = h.idp.authorizationRequests;
    const code = new URL(r.callbackUrl, WEB).searchParams.get('code')!;
    const sessionToken = r.sessionCookie!.split('=')[1]!;
    const everything = lines.join('\n');
    expect(everything.length).toBeGreaterThan(0);
    for (const secretish of [CLIENT_SECRET, code, sessionToken, ...authz.map((a) => a.state), ...authz.map((a) => a.nonce)]) {
      expect(everything, `log must not contain ${secretish.slice(0, 6)}…`).not.toContain(secretish);
    }
    expect(everything).not.toMatch(/eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\./); // no JWTs
    expect(everything).not.toMatch(/oidc\/callback\?/); // callback query strings are stripped from request logs
    expect(everything).toMatch(/oidc login failed/); // …but failures are still observable, by reason
  });

  test('the API never returns the client secret in any auth response', async () => {
    const h = await make();
    const c = await h.session('engineer@acme.test');
    const bodies = [
      (await h.app.inject('/api/v1/auth/config')).body,
      JSON.stringify((await c.req('GET', '/api/v1/auth/session')).json),
    ];
    for (const b of bodies) expect(b).not.toContain(CLIENT_SECRET);
  });

  test('stored sessions keep only a hash of the token, and no IdP tokens are persisted anywhere', async () => {
    const h = await make();
    const r = await h.signIn('engineer@acme.test');
    const token = r.sessionCookie!.split('=')[1]!;
    const stored = JSON.stringify(await h.db.c.sessions.find({}).toArray());
    expect(stored).not.toContain(token);
    const flows = await h.db.c.authFlows.countDocuments();
    expect(flows).toBeGreaterThanOrEqual(0);
    const dump = JSON.stringify(await h.db.c.users.find({}).toArray()) + stored + JSON.stringify(await h.db.c.auditEvents.find({}).toArray());
    expect(dump).not.toMatch(/eyJ[A-Za-z0-9_-]{15,}\./);
    expect(dump).not.toContain(CLIENT_SECRET);
  });
});
