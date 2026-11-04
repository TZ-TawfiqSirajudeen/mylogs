import { AuditService, type IncidentDoc } from '@nexus/database';
import { startTestMongo } from '@nexus/database/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { harness, type Client, type Harness } from './helpers.js';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let h: Harness;
let owner: Client, engineer: Client, viewer: Client, devOnly: Client, globex: Client;
let projectId: string, devEnv: string, prodEnv: string, gProject: string, gEnv: string;
let devToken: string, prodToken: string, telemetryToken: string, gToken: string;

const base = () => `/api/v1/projects/${projectId}`;
const body = (over: Record<string, unknown> = {}) => ({ service: `svc-${Math.random().toString(36).slice(2, 7)}`, version: '1.0.0', status: 'succeeded', ...over });
type Res = { status: number; json: any; headers: Record<string, unknown>; raw: string };

/** A CI-style call: a bearer token, no cookie, no origin, no CSRF. */
async function ci(token: string | undefined, payload: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const r = await h.app.inject({ method: 'POST', url: '/api/v1/deployments', headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, payload: payload as object });
  return { status: r.statusCode, json: safe(r.body), headers: r.headers, raw: r.body };
}
const safe = (s: string) => { try { return JSON.parse(s); } catch { return s; } };
const mint = async (c: Client, env: string, signals: string[] | undefined, name: string) => {
  const r = await c.req('POST', `${base()}/environments/${env}/ingest-tokens`, { name, ...(signals ? { signals } : {}) });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json as { token: string; info: { id: string; scopes: string[] } };
};
// Every token is limited to 30 writes a minute (that is tested below), so the tests share a small rotating pool instead of one token.
const pool: Record<string, { token: string; uses: number }> = {};
async function tok(env: 'dev' | 'prod'): Promise<string> {
  let p = pool[env];
  if (!p || p.uses >= 12) { p = pool[env] = { token: (await mint(owner, env === 'dev' ? devEnv : prodEnv, ['deployments'], `ci-${env}-${Math.random().toString(36).slice(2, 6)}`)).token, uses: 0 }; }
  p.uses++;
  return p.token;
}
const asSession = (c: Client, projectId: string, environmentId: string, over: Record<string, unknown> = {}) => c.req('POST', '/api/v1/deployments', body({ projectId, environmentId, ...over }));

beforeAll(async () => {
  mongo = await startTestMongo();
  h = await harness(mongo.uri);
  [owner, engineer, viewer, devOnly, globex] = await Promise.all([
    h.login('owner@acme.test'), h.login('engineer@acme.test'), h.login('viewer@acme.test'), h.login('auditor@acme.test'), h.login('owner@globex.test'),
  ]);
  const p = (await owner.req('POST', '/api/v1/projects', { name: 'Deploy project', environments: [{ name: 'Dev' }, { name: 'Prod', isProduction: true }] })).json;
  projectId = p.id; devEnv = p.environments[0].id; prodEnv = p.environments[1].id;
  await owner.req('PUT', `${base()}/members/${engineer.userId}`, { role: 'engineer' });
  await owner.req('PUT', `${base()}/members/${viewer.userId}`, { role: 'viewer' });
  await owner.req('PUT', `${base()}/members/${devOnly.userId}`, { role: 'engineer', environmentIds: [devEnv] }); // an environment-restricted engineer
  const g = (await globex.req('POST', '/api/v1/projects', { name: 'Globex deploy', environments: [{ name: 'Dev' }] })).json;
  gProject = g.id; gEnv = g.environments[0].id;
  devToken = (await mint(owner, devEnv, ['deployments'], 'ci-dev')).token;
  prodToken = (await mint(owner, prodEnv, ['deployments'], 'ci-prod')).token;
  telemetryToken = (await mint(owner, devEnv, undefined, 'telemetry-only')).token;
  const gm = await globex.req('POST', `/api/v1/projects/${gProject}/environments/${gEnv}/ingest-tokens`, { name: 'g-ci', signals: ['deployments'] });
  gToken = gm.json.token;
}, 300_000);
afterAll(async () => { await h?.app.close(); await h?.db.close(); await mongo?.stop(); });

describe('the deployments scope on ingestion tokens', () => {
  test('it is opt-in: the default token cannot record deployments, an explicit one can, and the DTO shows the scopes', async () => {
    const def = await mint(owner, devEnv, undefined, 'default-scopes');
    expect(def.info.scopes).toEqual(['logs', 'traces', 'metrics']);
    const dep = await mint(owner, devEnv, ['deployments'], 'only-deployments');
    expect(dep.info.scopes).toEqual(['deployments']);
    expect((await ci(def.token, body())).status).toBe(403);
    expect((await ci(dep.token, body())).status).toBe(201);
    const all = await mint(owner, devEnv, ['logs', 'deployments'], 'logs-and-deployments');
    expect(all.info.scopes).toEqual(['logs', 'deployments']);
    expect((await owner.req('POST', `${base()}/environments/${devEnv}/ingest-tokens`, { name: 'bad', signals: ['deploys'] })).status).toBe(400);
  });
  test('only a project admin can mint one (viewers and engineers cannot)', async () => {
    for (const c of [viewer, engineer]) expect((await c.req('POST', `${base()}/environments/${devEnv}/ingest-tokens`, { name: 'nope', signals: ['deployments'] })).status).toBe(403);
  });
});

describe('authentication of the write endpoint', () => {
  test('no credential, unknown, malformed and revoked tokens all get the same 401', async () => {
    const minted = await mint(owner, devEnv, ['deployments'], 'to-revoke');
    expect((await owner.req('DELETE', `${base()}/ingest-tokens/${minted.info.id}`)).status).toBe(204);
    const attempts = await Promise.all([ci(undefined, body()), ci(`nxi_${'A'.repeat(43)}`, body()), ci('garbage', body()), ci(minted.token, body())]);
    expect(attempts.map((a) => a.status)).toEqual([401, 401, 401, 401]);
    expect(new Set(attempts.map((a) => JSON.stringify({ ...a.json, error: { ...a.json.error, requestId: '' } }))).size).toBe(1); // indistinguishable
    expect(attempts.every((a) => !a.raw.includes(minted.token))).toBe(true); // tokens never appear in an error
  });
  test('a token that cannot record deployments is told so (403); a telemetry token never writes a deployment', async () => {
    const r = await ci(telemetryToken, body());
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('forbidden_scope');
    expect(await h.db.c.deployments.countDocuments({ _id: { $exists: true }, version: 'telemetry-attempt' })).toBe(0);
  });
  test('the X-Nexus-Token header works like a bearer token', async () => {
    const r = await h.app.inject({ method: 'POST', url: '/api/v1/deployments', headers: { 'x-nexus-token': devToken }, payload: body() });
    expect(r.statusCode).toBe(201);
  });
  test('a presented token never falls back to the cookie: a valid session plus a bad token is a 401', async () => {
    const r = await h.app.inject({
      method: 'POST', url: '/api/v1/deployments', headers: { authorization: 'Bearer nxi_wrong', cookie: engineer.cookie, 'x-csrf-token': engineer.csrf, origin: h.cfg.webOrigin },
      payload: body({ projectId, environmentId: devEnv }),
    });
    expect(r.statusCode).toBe(401);
  });
  test('an ingestion token does not authenticate any read route', async () => {
    for (const url of [`${base()}/deployments`, `${base()}/deployments/markers?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z`, `${base()}/deployments/${crypto.randomUUID()}`, `${base()}/incidents/${crypto.randomUUID()}/deployments`, '/api/v1/projects']) {
      expect((await h.app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${devToken}` } })).statusCode, url).toBe(401);
    }
  });
  test('every read route requires a session (anonymous and forged cookie: 401)', async () => {
    const routes = h.app.routeTable.filter((r) => /deployments/.test(r.url) && r.method === 'GET');
    expect(routes.length).toBe(4);
    expect(routes.every((r) => r.authenticated)).toBe(true);
    for (const r of routes) {
      const url = r.url.replace(':projectId', projectId).replace(/:\w+/g, crypto.randomUUID());
      expect((await h.app.inject({ method: 'GET', url })).statusCode, r.url).toBe(401);
      expect((await h.app.inject({ method: 'GET', url, headers: { cookie: 'nx_sid=forged' } })).statusCode, r.url).toBe(401);
    }
  });
  test('repeated failed authentication is throttled per address (429 with Retry-After) and does not affect a good token afterwards', async () => {
    // a fresh app instance so the per-address budget of this test cannot affect the others
    const h2 = await harness(mongo.uri);
    try {
      let last = 0;
      for (let i = 0; i < 35; i++) last = (await h2.app.inject({ method: 'POST', url: '/api/v1/deployments', headers: { authorization: `Bearer nxi_${'B'.repeat(43)}` }, payload: body() })).statusCode;
      expect(last).toBe(429);
    } finally { await h2.app.close(); await h2.db.close(); }
  });
});

describe('where a record goes: the credential decides, never the payload', () => {
  test('a token records into its own environment; the response carries no tenant ids beyond the project', async () => {
    const r = await ci(await tok('dev'), body({ service: 'where-1' }));
    expect(r.status).toBe(201);
    expect(r.json.outcome).toBe('created');
    expect(r.json.deployment).toMatchObject({ projectId, environmentId: devEnv, service: 'where-1', actor: { type: 'token', name: expect.stringMatching(/^ci-dev/) } });
    const doc = await h.db.c.deployments.findOne({ _id: r.json.deployment.id });
    expect(doc).toMatchObject({ projectId, environmentId: devEnv });
    expect(r.raw).not.toContain(devToken);
    const prod = await ci(await tok('prod'), body({ service: 'where-1' }));
    expect(prod.json.deployment.environmentId).toBe(prodEnv);
  });
  test('a payload that names a project, environment or organization is refused, never honoured', async () => {
    const a = await ci(await tok('dev'), body({ environmentId: prodEnv }));
    expect(a.status).toBe(400);
    expect(a.json.error.code).toBe('scope_in_payload');
    expect((await ci(await tok('dev'), body({ projectId: gProject }))).json.error.code).toBe('scope_in_payload');
    expect((await ci(await tok('dev'), body({ orgId: 'x' }))).status).toBe(400); // unknown field
    expect(await h.db.c.deployments.countDocuments({ environmentId: prodEnv, service: { $regex: '^svc-' }, version: '1.0.0', 'actor.name': 'ci-dev' })).toBe(0);
  });
  test('another tenant\'s token stores under that tenant; neither side sees or collides with the other', async () => {
    const k = 'cross-tenant-key';
    const a = await ci(await tok('dev'), body({ service: 'tenant-svc', idempotencyKey: k }));
    const g = await ci(gToken, body({ service: 'tenant-svc', idempotencyKey: k }));
    expect([a.status, g.status]).toEqual([201, 201]);
    expect(a.json.deployment.id).not.toBe(g.json.deployment.id);
    expect(await h.db.c.deployments.findOne({ _id: g.json.deployment.id })).toMatchObject({ projectId: gProject, environmentId: gEnv });
    const mine = await owner.req('GET', `${base()}/deployments?service=tenant-svc`);
    expect(mine.json.items.map((d: { id: string }) => d.id)).toEqual([a.json.deployment.id]);
    expect((await owner.req('GET', `${base()}/deployments/${g.json.deployment.id}`)).status).toBe(404);
    expect((await owner.req('GET', `/api/v1/projects/${gProject}/deployments`)).status).toBe(404);
    expect((await globex.req('GET', `/api/v1/projects/${gProject}/deployments/${a.json.deployment.id}`)).status).toBe(404);
  });
});

describe('idempotency through the API', () => {
  test('create 201, identical replay 200 unchanged, progress 200 updated, conflict 409; the Idempotency-Key header works', async () => {
    const svc = `idem-${Math.random().toString(36).slice(2, 6)}`;
    const key = `run-${svc}`;
    const a = await ci(await tok('dev'), body({ service: svc, status: 'started', idempotencyKey: key }));
    expect([a.status, a.json.outcome]).toEqual([201, 'created']);
    const again = await ci(await tok('dev'), body({ service: svc, status: 'started' }), { 'idempotency-key': key });
    expect([again.status, again.json.outcome, again.json.deployment.id]).toEqual([200, 'unchanged', a.json.deployment.id]);
    const done = await ci(await tok('dev'), body({ service: svc, status: 'succeeded' }), { 'idempotency-key': key });
    expect([done.status, done.json.outcome, done.json.deployment.status]).toEqual([200, 'updated', 'succeeded']);
    expect(done.json.deployment.finishedAt).not.toBeNull();
    expect((await ci(await tok('dev'), body({ service: svc, version: '9.9.9', status: 'succeeded', idempotencyKey: key }))).json.error.code).toBe('idempotency_conflict');
    expect((await ci(await tok('dev'), body({ service: svc, status: 'started', idempotencyKey: key }))).json.error.code).toBe('invalid_transition');
    expect(await h.db.c.deployments.countDocuments({ service: svc })).toBe(1);
    // the header and the body must agree; a bad header is a 400
    expect((await ci(await tok('dev'), body({ service: svc, idempotencyKey: 'other' }), { 'idempotency-key': key })).status).toBe(400);
    expect((await ci(await tok('dev'), body(), { 'idempotency-key': 'has space' })).status).toBe(400);
  });
  test('a CI retry storm with one key records one deployment', async () => {
    const svc = `storm-${Math.random().toString(36).slice(2, 6)}`;
    const t = await tok('dev');
    const rs = await Promise.all(Array.from({ length: 10 }, () => ci(t, body({ service: svc, idempotencyKey: 'storm-key' }))));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(await h.db.c.deployments.countDocuments({ service: svc })).toBe(1);
  });
});

describe('validation', () => {
  test.each([
    ['empty body', {}],
    ['missing status', { service: 's', version: '1' }],
    ['bad status', body({ status: 'deploying' })],
    ['service too long', body({ service: 'x'.repeat(129) })],
    ['control characters', body({ service: 'a\u0000b' })],
    ['notes too long', body({ notes: 'n'.repeat(1001) })],
    ['commit not hex', body({ commitSha: 'not-a-sha' })],
    ['start in the future', body({ startedAt: new Date(Date.now() + 3_600_000).toISOString() })],
    ['start too old', body({ startedAt: new Date(Date.now() - 100 * 86_400_000).toISOString() })],
    ['finish before start', body({ startedAt: new Date(Date.now() - 60_000).toISOString(), finishedAt: new Date(Date.now() - 120_000).toISOString() })],
    ['finishedAt on a started deployment', body({ status: 'started', finishedAt: new Date().toISOString() })],
    ['array body', [body()]],
  ])('%s is a 400 with details, never a 500', async (_n, payload) => {
    const r = await ci(await tok('dev'), payload);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toMatch(/validation_error|invalid_time/);
  });
  test.each(['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html;base64,PHNjcmlwdD4=', 'http://example.com/run', 'ftp://example.com', 'file:///etc/passwd', '//example.com/x', 'https://user:pass@example.com/x', 'https://exa mple.com'])(
    'link %s is refused', async (linkUrl) => {
      const r = await ci(await tok('dev'), body({ linkUrl }));
      expect(r.status).toBe(400);
      expect(await h.db.c.deployments.countDocuments({ linkUrl })).toBe(0);
    });
  test('an https link is accepted and returned normalized', async () => {
    const r = await ci(await tok('dev'), body({ linkUrl: 'https://CI.example.com/runs/42?x=1' }));
    expect(r.json.deployment.linkUrl).toBe('https://ci.example.com/runs/42?x=1');
  });
  test('an oversized body is refused before it is parsed (413)', async () => {
    const r = await ci(await tok('dev'), body({ notes: 'x'.repeat(40_000) }));
    expect(r.status).toBe(413);
  });
  test('hostile text is stored and returned inert, verbatim, as JSON strings (the web page renders it as text: see the browser spec)', async () => {
    const xss = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const r = await ci(await tok('dev'), body({ service: `xss-${xss}`, version: `"><svg onload=alert(3)>`, notes: xss, triggeredBy: '<b>mallory</b>' }));
    expect(r.status).toBe(201);
    expect(String(r.headers['content-type'])).toMatch(/^application\/json/);
    expect(r.json.deployment).toMatchObject({ service: `xss-${xss}`, version: '"><svg onload=alert(3)>', notes: xss, triggeredBy: '<b>mallory</b>' });
    const listed = await owner.req('GET', `${base()}/deployments?service=${encodeURIComponent(`xss-${xss}`)}`);
    expect(listed.json.items[0].notes).toBe(xss);
    expect(String(listed.headers['content-type'])).toMatch(/^application\/json/);
    expect(String(listed.headers['content-type'])).not.toMatch(/html/);
  });
  test('credential-looking text in notes is scrubbed before storage', async () => {
    const fake = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_'); // assembled at run time so no token-shaped literal sits in the source
    const r = await ci(await tok('dev'), body({ notes: `deploy ok password=correct-horse-battery token=${fake}` }));
    expect(r.json.deployment.notes).not.toContain('correct-horse-battery');
    expect(r.json.deployment.notes).not.toContain(fake);
    expect((await h.db.c.deployments.findOne({ _id: r.json.deployment.id }))?.notes).not.toContain('correct-horse-battery');
  });
});

describe('rate limits', () => {
  test('a token is limited to 30 writes a minute (429 with Retry-After); another token is not affected', async () => {
    const t = (await mint(owner, devEnv, ['deployments'], 'burst')).token;
    const statuses: number[] = [];
    let retryAfter: unknown;
    for (let i = 0; i < 34; i++) {
      const r = await ci(t, body());
      statuses.push(r.status);
      if (r.status === 429) retryAfter = r.headers['retry-after'];
    }
    expect(statuses.slice(0, 30).every((s) => s === 201)).toBe(true);
    expect(statuses.slice(30).every((s) => s === 429)).toBe(true);
    expect(retryAfter).toBeTruthy();
    expect((await ci(await tok('prod'), body())).status).toBe(201);
  });
});

describe('recording with a session (engineers and project admins)', () => {
  test('an engineer can record; the actor is the signed-in user; the response says so', async () => {
    const r = await asSession(engineer, projectId, devEnv, { service: 'by-session' });
    expect(r.status).toBe(201);
    expect(r.json.deployment.actor).toEqual({ type: 'user', name: 'Erin Engineer' });
    expect((await asSession(owner, projectId, prodEnv, { service: 'by-owner' })).status).toBe(201);
  });
  test('a viewer cannot write (403) but can read', async () => {
    expect((await asSession(viewer, projectId, devEnv)).status).toBe(403);
    expect((await viewer.req('GET', `${base()}/deployments`)).status).toBe(200);
  });
  test('the browser protections apply: no CSRF token = 403, a foreign origin = 403, no cookie = 401', async () => {
    const payload = body({ projectId, environmentId: devEnv });
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/deployments', headers: { cookie: engineer.cookie, origin: h.cfg.webOrigin }, payload })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/deployments', headers: { cookie: engineer.cookie, 'x-csrf-token': engineer.csrf, origin: 'https://evil.example' }, payload })).statusCode).toBe(403);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/deployments', payload })).statusCode).toBe(401);
  });
  test('the project and environment are required, and authorized against the caller\'s grant', async () => {
    expect((await engineer.req('POST', '/api/v1/deployments', body())).json.error.code).toBe('scope_required');
    expect((await asSession(engineer, projectId, crypto.randomUUID())).status).toBe(404); // not an environment of the project
    expect((await asSession(devOnly, projectId, devEnv)).status).toBe(201);
    expect((await asSession(devOnly, projectId, prodEnv)).status).toBe(404); // outside the restricted grant: indistinguishable from "does not exist"
    expect((await asSession(globex, projectId, devEnv)).status).toBe(404); // another tenant's project
    expect((await asSession(engineer, gProject, gEnv)).status).toBe(404);
  });
  test('a session write is audited with the user as the actor', async () => {
    const r = await asSession(engineer, projectId, devEnv, { service: 'audit-me', notes: 'a private note' });
    const ev = await h.db.c.auditEvents.findOne({ targetId: r.json.deployment.id });
    expect(ev).toMatchObject({ action: 'deployment.recorded', actorType: 'user', actorUserId: engineer.userId });
    expect(JSON.stringify(ev)).not.toContain('a private note');
  });
});

describe('reading', () => {
  test('list, filter, page and fetch one; the environment-restricted user sees only their environment', async () => {
    const stamp = Math.random().toString(36).slice(2, 6);
    const svc = `read-${stamp}`;
    const t0 = Date.now() - 3_600_000;
    const mk = async (env: 'dev' | 'prod', version: string, status: string, min: number) => ci(await tok(env), body({ service: svc, version, status, startedAt: new Date(t0 + min * 60_000).toISOString() }));
    await mk('dev', 'd1', 'succeeded', 0); await mk('dev', 'd2', 'failed', 10); await mk('prod', 'p1', 'succeeded', 20); await mk('prod', 'p2', 'rolled_back', 30);
    const all = await owner.req('GET', `${base()}/deployments?service=${svc}`);
    expect(all.json.items.map((d: { version: string }) => d.version)).toEqual(['p2', 'p1', 'd2', 'd1']);
    expect((await engineer.req('GET', `${base()}/deployments?service=${svc}&status=failed`)).json.items.map((d: { version: string }) => d.version)).toEqual(['d2']);
    expect((await owner.req('GET', `${base()}/deployments?service=${svc}&environmentId=${prodEnv}`)).json.items.map((d: { version: string }) => d.version)).toEqual(['p2', 'p1']);
    const p1 = await owner.req('GET', `${base()}/deployments?service=${svc}&limit=3`);
    expect(p1.json.items).toHaveLength(3);
    const p2 = await owner.req('GET', `${base()}/deployments?service=${svc}&limit=3&cursor=${encodeURIComponent(p1.json.nextCursor)}`);
    expect(p2.json.items.map((d: { version: string }) => d.version)).toEqual(['d1']);
    expect(p2.json.nextCursor).toBeNull();
    // restricted to Dev
    const restricted = await devOnly.req('GET', `${base()}/deployments?service=${svc}`);
    expect(restricted.json.items.map((d: { version: string }) => d.version)).toEqual(['d2', 'd1']);
    expect((await devOnly.req('GET', `${base()}/deployments?service=${svc}&environmentId=${prodEnv}`)).json.items).toEqual([]);
    const prodItem = all.json.items.find((d: { version: string }) => d.version === 'p1');
    expect((await devOnly.req('GET', `${base()}/deployments/${prodItem.id}`)).status).toBe(404);
    expect((await owner.req('GET', `${base()}/deployments/${prodItem.id}`)).json).toMatchObject({ version: 'p1', environmentId: prodEnv });
    // markers: same scoping, lightweight
    const from = new Date(t0 - 60_000).toISOString(), to = new Date().toISOString();
    const m = await owner.req('GET', `${base()}/deployments/markers?from=${from}&to=${to}&service=${svc}`);
    expect(m.json.items.map((x: { version: string }) => x.version)).toEqual(['d1', 'd2', 'p1', 'p2']);
    expect(Object.keys(m.json.items[0])).not.toContain('notes');
    expect((await devOnly.req('GET', `${base()}/deployments/markers?from=${from}&to=${to}&service=${svc}`)).json.items.map((x: { version: string }) => x.version)).toEqual(['d1', 'd2']);
    expect((await owner.req('GET', `${base()}/deployments/markers?from=${to}&to=${from}`)).status).toBe(400);
  });
  test('people without access to the project, and another tenant, get a 404 (not a 403)', async () => {
    expect((await globex.req('GET', `${base()}/deployments`)).status).toBe(404);
    expect((await globex.req('GET', `${base()}/deployments/markers?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z`)).status).toBe(404);
  });
  test('malformed ids and queries are 400/404, never 500', async () => {
    expect((await owner.req('GET', `${base()}/deployments/not-a-uuid`)).status).toBe(400);
    expect((await owner.req('GET', `${base()}/deployments?status=bogus`)).status).toBe(400);
    expect((await owner.req('GET', `${base()}/deployments?limit=1000`)).status).toBe(400);
    expect((await owner.req('GET', `${base()}/deployments?cursor=%21%21%21`)).status).toBe(400);
  });
});

describe('the incident correlation route', () => {
  const open = new Date();
  test('shows only deployments of the incident\'s service in its environment shortly before it opened; the wording is fixed', async () => {
    const svc = `corr-${Math.random().toString(36).slice(2, 6)}`;
    const at = (min: number) => new Date(open.getTime() + min * 60_000).toISOString();
    expect((await ci(await tok('prod'), body({ service: svc, version: 'before', status: 'succeeded', startedAt: at(-20), finishedAt: at(-18) }))).status).toBe(201);
    expect((await ci(await tok('prod'), body({ service: svc, version: 'too-early', status: 'succeeded', startedAt: at(-90), finishedAt: at(-88) }))).status).toBe(201);
    expect((await ci(await tok('dev'), body({ service: svc, version: 'other-env', status: 'succeeded', startedAt: at(-20), finishedAt: at(-18) }))).status).toBe(201);
    expect((await ci(await tok('prod'), body({ service: 'unrelated', version: 'other-svc', status: 'succeeded', startedAt: at(-20), finishedAt: at(-18) }))).status).toBe(201);
    const ruleId = crypto.randomUUID();
    await h.db.c.alertConfig.insertOne({ _id: ruleId, kind: 'rule', orgId: (await h.db.c.projects.findOne({ _id: projectId }))!.orgId, projectId, environmentId: prodEnv, name: 'r', query: { kind: 'metric', metric: 'm', service: svc } } as never);
    const inc: IncidentDoc = {
      _id: crypto.randomUUID(), orgId: (await h.db.c.projects.findOne({ _id: projectId }))!.orgId, projectId, environmentId: prodEnv, ruleId, ruleName: 'r', severity: 'critical', title: 't',
      groupKey: '', groupLabels: {}, status: 'open', active: true, openedAt: open, acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolvedBy: null, lastValue: 1,
      condition: { op: 'gt', threshold: 1, windowSeconds: 60 }, timeline: [], commentCount: 0, eventCount: 0, expireAt: null,
    };
    await h.db.c.incidents.insertOne(inc);
    await new AuditService(h.db).record({ orgId: inc.orgId, actorUserId: null, action: 'test.noop', targetType: 'x' }, { requestId: 'r1' });

    const r = await viewer.req('GET', `${base()}/incidents/${inc._id}/deployments`);
    expect(r.status).toBe(200);
    expect(r.json.services).toEqual([svc]);
    expect(r.json.items.map((d: { version: string }) => d.version)).toEqual(['before']);
    expect(r.json.windowMinutes).toBe(30);
    expect(r.json.note).toBe('Deployed shortly before; correlation, not proof of cause.');
    // the restricted (Dev only) user cannot see a Prod incident at all
    expect((await devOnly.req('GET', `${base()}/incidents/${inc._id}/deployments`)).status).toBe(404);
    expect((await globex.req('GET', `${base()}/incidents/${inc._id}/deployments`)).status).toBe(404);
    expect((await viewer.req('GET', `${base()}/incidents/${crypto.randomUUID()}/deployments`)).status).toBe(404);
  });
});
