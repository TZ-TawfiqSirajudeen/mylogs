import { startTestMongo } from '@nexus/database/testing';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { AuditService } from '../src/services/audit.js';
import { harness, type Client, type Harness } from './helpers.js';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let h: Harness;
let owner: Client, admin: Client, engineer: Client, viewer: Client, auditor: Client, globex: Client;

beforeAll(async () => {
  mongo = await startTestMongo();
  h = await harness(mongo.uri);
  [owner, admin, engineer, viewer, auditor, globex] = await Promise.all([
    h.login('owner@acme.test'), h.login('admin@acme.test'), h.login('engineer@acme.test'),
    h.login('viewer@acme.test'), h.login('auditor@acme.test'), h.login('owner@globex.test'),
  ]);
}, 240_000);
afterAll(async () => {
  await h?.app.close();
  await h?.db.close();
  await mongo?.stop();
});

const newProject = (c: Client, name: string, extra: object = {}) =>
  c.req('POST', '/api/v1/projects', { name, environments: [{ name: 'Development' }, { name: 'Production', isProduction: true }], ...extra });

describe('health', () => {
  test('liveness and readiness', async () => {
    expect((await h.app.inject('/healthz')).statusCode).toBe(200);
    const ready = await h.app.inject('/readyz');
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks.mongodb).toBe('up');
  });
});

describe('authentication & sessions', () => {
  test('unauthenticated requests are rejected', async () => {
    const res = await h.app.inject('/api/v1/projects');
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthenticated');
  });

  test('session cookie is HttpOnly + SameSite and the response never contains the token', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/auth/dev-login', headers: { origin: h.cfg.webOrigin }, payload: { email: 'viewer@acme.test' } });
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const token = cookie.split(';')[0]!.split('=')[1]!;
    expect(res.body).not.toContain(token);
  });

  test('unknown user and wrong org give an identical failure (no enumeration)', async () => {
    const a = await h.app.inject({ method: 'POST', url: '/api/v1/auth/dev-login', headers: { origin: h.cfg.webOrigin }, payload: { email: 'nobody@acme.test' } });
    const b = await h.app.inject({ method: 'POST', url: '/api/v1/auth/dev-login', headers: { origin: h.cfg.webOrigin }, payload: { email: 'owner@acme.test', orgSlug: 'globex' } });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json().error.message).toBe(b.json().error.message);
  });

  test('state-changing requests need the CSRF token and an allowed Origin', async () => {
    const noCsrf = await h.app.inject({ method: 'POST', url: '/api/v1/projects', headers: { cookie: owner.cookie, origin: h.cfg.webOrigin }, payload: { name: 'x' } });
    expect(noCsrf.statusCode).toBe(403);
    const wrongCsrf = await h.app.inject({ method: 'POST', url: '/api/v1/projects', headers: { cookie: owner.cookie, origin: h.cfg.webOrigin, 'x-csrf-token': 'nope' }, payload: { name: 'x' } });
    expect(wrongCsrf.statusCode).toBe(403);
    const evil = await h.app.inject({ method: 'POST', url: '/api/v1/projects', headers: { cookie: owner.cookie, origin: 'https://evil.example', 'x-csrf-token': owner.csrf }, payload: { name: 'x' } });
    expect(evil.statusCode).toBe(403);
    expect(evil.json().error.code).toBe('bad_origin');
  });

  test('logout revokes the session server-side', async () => {
    const c = await h.login('viewer@acme.test');
    expect((await c.req('GET', '/api/v1/auth/session')).status).toBe(200);
    const out = await c.req('POST', '/api/v1/auth/logout');
    expect(out.status).toBe(200);
    expect(out.json).toEqual({ redirect: null }); // dev mode has no IdP session to end
    expect((await c.req('GET', '/api/v1/auth/session')).status).toBe(401);
  });

  test('removing an org membership invalidates live sessions immediately', async () => {
    const c = await h.login('viewer@acme.test');
    const org = (await h.db.c.organizations.findOne({ slug: 'acme' }))!;
    const m = (await h.db.c.orgMemberships.findOne({ orgId: org._id, userId: c.userId }))!;
    await h.db.c.orgMemberships.deleteOne({ _id: m._id });
    expect((await c.req('GET', '/api/v1/projects')).status).toBe(401);
    await h.db.c.orgMemberships.insertOne(m); // restore for later tests
  });

  test('idle and absolute expiry are enforced', async () => {
    const c = await h.login('viewer@acme.test');
    await h.db.c.sessions.updateOne({ userId: c.userId, csrfToken: c.csrf }, { $set: { idleExpiresAt: new Date(Date.now() - 1000) } });
    expect((await c.req('GET', '/api/v1/auth/session')).status).toBe(401);
  });

  test('absolute expiry and revoked sessions are enforced', async () => {
    const a = await h.login('viewer@acme.test');
    await h.db.c.sessions.updateOne({ userId: a.userId, csrfToken: a.csrf }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await a.req('GET', '/api/v1/auth/session')).status).toBe(401);
    const b = await h.login('viewer@acme.test');
    await h.db.c.sessions.updateOne({ userId: b.userId, csrfToken: b.csrf }, { $set: { revokedAt: new Date() } });
    expect((await b.req('GET', '/api/v1/auth/session')).status).toBe(401);
  });

  test('signing in again revokes the session already attached to that browser', async () => {
    const first = await h.login('viewer@acme.test');
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/auth/dev-login', headers: { origin: h.cfg.webOrigin, cookie: first.cookie }, payload: { email: 'viewer@acme.test' } });
    expect(res.statusCode).toBe(200);
    expect((await first.req('GET', '/api/v1/auth/session')).status).toBe(401);
  });

  test('unauthenticated requests are rejected before body validation (401, not 400)', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/projects', headers: { origin: h.cfg.webOrigin }, payload: { name: '' } });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('unauthenticated');
  });

  test('error responses carry a request id and never leak internals', async () => {
    const res = await h.app.inject({ url: '/api/v1/projects', headers: { 'x-request-id': 'req-abcdef12' } });
    expect(res.headers['x-request-id']).toBe('req-abcdef12');
    const bad = await h.app.inject({ url: '/api/v1/projects', headers: { 'x-request-id': '<script>' } });
    expect(bad.headers['x-request-id']).not.toBe('<script>');
  });
});

describe('rate limiting', () => {
  test('login endpoint is throttled', async () => {
    const limited = await harness(mongo.uri, { AUTH_RATE_LIMIT_MAX: '3' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) {
      codes.push((await limited.app.inject({ method: 'POST', url: '/api/v1/auth/dev-login', headers: { origin: limited.cfg.webOrigin }, payload: { email: 'nobody@acme.test' } })).statusCode);
    }
    expect(codes).toEqual([401, 401, 401, 429, 429]);
    await limited.app.close();
    await limited.db.close();
  });
});

describe('projects, environments & RBAC', () => {
  let projectId: string;
  let devEnvId: string;
  let prodEnvId: string;

  test('owner creates a project with environments; creator becomes project admin', async () => {
    const res = await newProject(owner, 'Payments API', { description: 'Core payments', owningTeam: 'payments' });
    expect(res.status).toBe(201);
    expect(res.json.slug).toBe('payments-api');
    expect(res.json.environments.map((e: any) => [e.slug, e.isProduction])).toEqual([['development', false], ['production', true]]);
    projectId = res.json.id;
    devEnvId = res.json.environments[0].id;
    prodEnvId = res.json.environments[1].id;
  });

  test('duplicate slug -> 409, invalid input -> 400', async () => {
    expect((await newProject(owner, 'Payments API')).status).toBe(409);
    const bad = await owner.req('POST', '/api/v1/projects', { name: '' });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('validation_error');
    expect((await newProject(owner, 'Dup env', { environments: [{ name: 'a' }, { name: 'A' }] })).status).toBe(409);
  });

  test('members, viewers and auditors cannot create projects', async () => {
    for (const c of [engineer, viewer, auditor]) expect((await newProject(c, 'Nope')).status).toBe(403);
  });

  test('a member with no grant sees nothing and gets 404 (not 403) for a real project id', async () => {
    expect((await engineer.req('GET', '/api/v1/projects')).json).toEqual([]);
    expect((await engineer.req('GET', `/api/v1/projects/${projectId}`)).status).toBe(404);
  });

  test('auditor has no implicit access to projects', async () => {
    expect((await auditor.req('GET', '/api/v1/projects')).json).toEqual([]);
    expect((await auditor.req('GET', `/api/v1/projects/${projectId}`)).status).toBe(404);
  });

  test('project admin grants roles; grants take effect and are enforced', async () => {
    const members = (await owner.req('GET', '/api/v1/org/members')).json as any[];
    const idOf = (e: string) => members.find((m) => m.email === e).userId;

    expect((await owner.req('PUT', `/api/v1/projects/${projectId}/members/${idOf('engineer@acme.test')}`, { role: 'engineer' })).status).toBe(204);
    expect((await owner.req('PUT', `/api/v1/projects/${projectId}/members/${idOf('viewer@acme.test')}`, { role: 'viewer', environmentIds: [devEnvId] })).status).toBe(204);

    const eng = await engineer.req('GET', `/api/v1/projects/${projectId}`);
    expect(eng.status).toBe(200);
    expect(eng.json.role).toBe('engineer');
    expect(eng.json.environments).toHaveLength(2);

    // viewer is environment-restricted: production must be invisible
    const v = await viewer.req('GET', `/api/v1/projects/${projectId}`);
    expect(v.json.environments.map((e: any) => e.id)).toEqual([devEnvId]);
    expect((await viewer.req('GET', '/api/v1/projects')).json[0].environments).toHaveLength(1);

    // viewer/engineer cannot mutate
    expect((await viewer.req('PATCH', `/api/v1/projects/${projectId}`, { name: 'Hacked' })).status).toBe(403);
    expect((await engineer.req('POST', `/api/v1/projects/${projectId}/environments`, { name: 'qa' })).status).toBe(403);
    expect((await engineer.req('GET', `/api/v1/projects/${projectId}/members`)).status).toBe(403);
    expect((await engineer.req('PUT', `/api/v1/projects/${projectId}/members/${engineer.userId}`, { role: 'project_admin' })).status).toBe(403); // no self-escalation
  });

  test('project admin manages environments; deleting one cleans restricted memberships', async () => {
    const created = await admin.req('POST', `/api/v1/projects/${projectId}/environments`, { name: 'Staging' });
    expect(created.status).toBe(201);
    expect((await admin.req('POST', `/api/v1/projects/${projectId}/environments`, { name: 'staging' })).status).toBe(409);
    expect((await admin.req('DELETE', `/api/v1/projects/${projectId}/environments/${created.json.id}`)).status).toBe(204);
    expect((await admin.req('DELETE', `/api/v1/projects/${projectId}/environments/${created.json.id}`)).status).toBe(404);
  });

  test('environment restriction cannot reference foreign environments', async () => {
    const other = (await newProject(owner, 'Other project')).json;
    const res = await owner.req('PUT', `/api/v1/projects/${projectId}/members/${engineer.userId}`, { role: 'viewer', environmentIds: [other.environments[0].id] });
    expect(res.status).toBe(404);
  });

  test('prod flag is returned so the UI can warn', async () => {
    const p = (await owner.req('GET', `/api/v1/projects/${projectId}`)).json;
    expect(p.environments.find((e: any) => e.id === prodEnvId).isProduction).toBe(true);
  });
});

describe('tenant isolation (cross-org)', () => {
  let acmeProject: any;
  beforeAll(async () => { acmeProject = (await newProject(owner, 'Isolated acme project')).json; });

  test('other org cannot read, update or delete anything by id (IDOR)', async () => {
    const id = acmeProject.id;
    expect((await globex.req('GET', `/api/v1/projects/${id}`)).status).toBe(404);
    expect((await globex.req('PATCH', `/api/v1/projects/${id}`, { name: 'pwn' })).status).toBe(404);
    expect((await globex.req('POST', `/api/v1/projects/${id}/environments`, { name: 'x' })).status).toBe(404);
    expect((await globex.req('DELETE', `/api/v1/projects/${id}/environments/${acmeProject.environments[0].id}`)).status).toBe(404);
    expect((await globex.req('GET', `/api/v1/projects/${id}/members`)).status).toBe(404);
    expect((await globex.req('PUT', `/api/v1/projects/${id}/members/${globex.userId}`, { role: 'project_admin' })).status).toBe(404);
    expect((await globex.req('GET', '/api/v1/projects')).json).toEqual([]);
    const after = (await owner.req('GET', `/api/v1/projects/${id}`)).json;
    expect(after.name).toBe('Isolated acme project');
  });

  test('cannot grant a foreign-org user access to own project', async () => {
    const own = (await globex.req('POST', '/api/v1/projects', { name: 'Globex app' })).json;
    const acmeEngineer = engineer.userId;
    expect((await globex.req('PUT', `/api/v1/projects/${own.id}/members/${acmeEngineer}`, { role: 'viewer' })).status).toBe(404);
  });

  test('audit log and member list never cross orgs', async () => {
    const g = (await globex.req('GET', '/api/v1/audit?limit=200')).json;
    const globexOrg = (await h.db.c.organizations.findOne({ slug: 'globex' }))!;
    const expectedIds = (await h.db.c.auditEvents.find({ orgId: globexOrg._id }).toArray()).map((e) => e._id).sort();
    expect(g.items.length).toBeGreaterThan(0);
    expect(g.items.map((e: any) => e.id).sort()).toEqual(expectedIds); // exactly this org's events, nothing else
    const members = (await globex.req('GET', '/api/v1/org/members')).json as any[];
    expect(members.map((m) => m.email)).toEqual(['owner@globex.test']);
  });
});

describe('audit trail', () => {
  test('mutations are audited; audit read is limited to owner/admin/auditor', async () => {
    const res = await auditor.req('GET', '/api/v1/audit?limit=200');
    expect(res.status).toBe(200);
    const actions = res.json.items.map((e: any) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['project.created', 'project.member.upserted', 'environment.created', 'environment.deleted', 'auth.login']));
    expect((await viewer.req('GET', '/api/v1/audit')).status).toBe(403);
    expect((await engineer.req('GET', '/api/v1/audit')).status).toBe(403);
  });

  test('sequence numbers are strictly increasing and paginate by cursor', async () => {
    const p1 = (await owner.req('GET', '/api/v1/audit?limit=3')).json;
    expect(p1.items).toHaveLength(3);
    expect(p1.items[0].seq).toBeGreaterThan(p1.items[1].seq);
    const p2 = (await owner.req('GET', `/api/v1/audit?limit=3&before=${p1.nextBefore}`)).json;
    expect(p2.items[0].seq).toBeLessThan(p1.items[2].seq);
  });

  test('secrets in audit metadata are redacted before storage', async () => {
    const org = (await h.db.c.organizations.findOne({ slug: 'acme' }))!;
    await new AuditService(h.db).record(
      { orgId: org._id, actorUserId: null, action: 'test.secret', targetType: 'x', metadata: { password: 'hunter2', nested: { mongoUri: 'mongodb://u:p@h' }, ok: 1 } },
      { requestId: 'r' },
    );
    const stored = await h.db.c.auditEvents.findOne({ action: 'test.secret' });
    expect(JSON.stringify(stored)).not.toContain('hunter2');
    expect(JSON.stringify(stored)).not.toContain('u:p@h');
    expect(stored?.metadata.ok).toBe(1);
  });

  test('URL credentials under an innocuous key are scrubbed, including passwords containing @ or /', async () => {
    const org = (await h.db.c.organizations.findOne({ slug: 'acme' }))!;
    await new AuditService(h.db).record(
      { orgId: org._id, actorUserId: null, action: 'test.url', targetType: 'x', metadata: { error: 'connect failed mongodb://admin:p@ssw0rd/x@db.internal:27017/app' } },
      { requestId: 'r' },
    );
    const stored = JSON.stringify(await h.db.c.auditEvents.findOne({ action: 'test.url' }));
    expect(stored).not.toContain('ssw0rd');
    expect(stored).not.toContain('p@ss');
    expect(stored).toContain('db.internal');
  });

  test('a failure late in project creation rolls back the project, environments, membership and audit event', async () => {
    const before = {
      audit: await h.db.c.auditEvents.countDocuments({ action: 'project.created' }),
      projects: await h.db.c.projects.countDocuments({}),
      members: await h.db.c.projectMemberships.countDocuments({}),
      envs: await h.db.c.environments.countDocuments({}),
    };
    // projectMemberships.insertOne runs after the project + environment inserts, so a rollback must undo those too.
    const spy = vi.spyOn(h.db.c.projectMemberships, 'insertOne').mockRejectedValueOnce(new Error('injected failure'));
    const res = await newProject(owner, 'Atomicity probe');
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.json.error.message).toBe('Internal server error');
    expect(await h.db.c.projects.countDocuments({})).toBe(before.projects);
    expect(await h.db.c.environments.countDocuments({})).toBe(before.envs);
    expect(await h.db.c.projectMemberships.countDocuments({})).toBe(before.members);
    expect(await h.db.c.auditEvents.countDocuments({ action: 'project.created' })).toBe(before.audit);
    expect(await h.db.c.projects.countDocuments({ slug: 'atomicity-probe' })).toBe(0);
  });

  test('a duplicate slug creates nothing', async () => {
    const before = await h.db.c.projects.countDocuments({});
    expect((await newProject(owner, 'Payments API')).status).toBe(409);
    expect(await h.db.c.projects.countDocuments({})).toBe(before);
  });
});

describe('injection resistance', () => {
  test('NoSQL operator payloads are rejected by validation, not executed', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/auth/dev-login', headers: { origin: h.cfg.webOrigin },
      payload: { email: { $ne: null } },
    });
    expect(res.statusCode).toBe(400);
    // a non-uuid projectId filter is rejected rather than passed to the query
    expect((await owner.req('GET', '/api/v1/audit?projectId=%7B%22%24ne%22:null%7D')).status).toBe(400);
    const id = await owner.req('GET', '/api/v1/projects/%7B%22$ne%22:null%7D');
    expect(id.status).toBe(400);
  });
});

describe('cookie hygiene and origins', () => {
  test('logout clears a Secure __Host- cookie with matching attributes', async () => {
    const secure = await harness(mongo.uri, { COOKIE_SECURE: 'true' });
    const c = await secure.login('viewer@acme.test');
    expect(c.cookie.startsWith('__Host-nx_sid=')).toBe(true);
    const res = await secure.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: c.cookie, origin: secure.cfg.webOrigin, 'x-csrf-token': c.csrf } });
    expect(res.statusCode).toBe(200);
    const cleared = String(res.headers['set-cookie']);
    expect(cleared).toMatch(/__Host-nx_sid=;/);
    expect(cleared).toMatch(/Secure/i);
    expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/i);
    await secure.app.close();
    await secure.db.close();
  });

  test('dev accepts the localhost/127.0.0.1 alias of WEB_ORIGIN; unrelated origins are still rejected', async () => {
    const alias = await harness(mongo.uri, { WEB_ORIGIN: 'http://localhost:5173/' }); // trailing slash is normalized
    expect(alias.cfg.webOrigin).toBe('http://localhost:5173');
    for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5173']) {
      const r = await alias.app.inject({ method: 'POST', url: '/api/v1/auth/dev-login', headers: { origin }, payload: { email: 'viewer@acme.test' } });
      expect(r.statusCode).toBe(200);
    }
    const evil = await alias.app.inject({ method: 'POST', url: '/api/v1/auth/dev-login', headers: { origin: 'http://localhost:5174' }, payload: { email: 'viewer@acme.test' } });
    expect(evil.statusCode).toBe(403);
    await alias.app.close();
    await alias.db.close();
  });
});

describe('environment-restricted project admins cannot escape their scope', () => {
  let projectId: string;
  let dev: string, prod: string;
  let scoped: Client; // org member granted project_admin on the dev environment only
  let other: Client;

  beforeAll(async () => {
    const p = (await newProject(owner, 'Scoped admin project')).json;
    projectId = p.id; dev = p.environments[0].id; prod = p.environments[1].id;
    scoped = await h.login('engineer@acme.test');
    other = await h.login('viewer@acme.test');
    expect((await owner.req('PUT', `/api/v1/projects/${projectId}/members/${scoped.userId}`, { role: 'project_admin', environmentIds: [dev] })).status).toBe(204);
    // someone with access to production, whom the scoped admin must not be able to touch
    expect((await owner.req('PUT', `/api/v1/projects/${projectId}/members/${other.userId}`, { role: 'viewer', environmentIds: [prod] })).status).toBe(204);
  });

  test('cannot widen their own grant to all environments or to production', async () => {
    expect((await scoped.req('PUT', `/api/v1/projects/${projectId}/members/${scoped.userId}`, { role: 'project_admin', environmentIds: null })).status).toBe(403);
    expect((await scoped.req('PUT', `/api/v1/projects/${projectId}/members/${scoped.userId}`, { role: 'project_admin', environmentIds: [dev, prod] })).status).toBe(403);
    const me = (await scoped.req('GET', `/api/v1/projects/${projectId}`)).json;
    expect(me.environments.map((e: any) => e.id)).toEqual([dev]);
  });

  test('cannot grant, change or remove access to environments outside their scope', async () => {
    expect((await scoped.req('PUT', `/api/v1/projects/${projectId}/members/${other.userId}`, { role: 'viewer', environmentIds: [prod] })).status).toBe(403);
    expect((await scoped.req('PUT', `/api/v1/projects/${projectId}/members/${other.userId}`, { role: 'viewer', environmentIds: [dev] })).status).toBe(403); // would replace a prod grant
    expect((await scoped.req('DELETE', `/api/v1/projects/${projectId}/members/${other.userId}`)).status).toBe(403);
    const unrelated = await h.login('auditor@acme.test');
    expect((await scoped.req('PUT', `/api/v1/projects/${projectId}/members/${unrelated.userId}`, { role: 'viewer', environmentIds: null })).status).toBe(403);
  });

  test('cannot delete or create environments, or edit project-level settings', async () => {
    expect((await scoped.req('DELETE', `/api/v1/projects/${projectId}/environments/${prod}`)).status).toBe(404);
    expect((await owner.req('GET', `/api/v1/projects/${projectId}`)).json.environments).toHaveLength(2);
    expect((await scoped.req('POST', `/api/v1/projects/${projectId}/environments`, { name: 'qa' })).status).toBe(403);
    expect((await scoped.req('PATCH', `/api/v1/projects/${projectId}`, { name: 'renamed' })).status).toBe(403);
  });

  test('can manage members inside their scope and only sees members who reach it', async () => {
    const unrelated = await h.login('auditor@acme.test');
    expect((await scoped.req('PUT', `/api/v1/projects/${projectId}/members/${unrelated.userId}`, { role: 'viewer', environmentIds: [dev] })).status).toBe(204);
    const list = (await scoped.req('GET', `/api/v1/projects/${projectId}/members`)).json as any[];
    expect(list.map((m) => m.userId)).not.toContain(other.userId); // prod-only viewer is invisible to them
    expect(list.find((m) => m.userId === unrelated.userId).environmentIds).toEqual([dev]);
    expect((await scoped.req('DELETE', `/api/v1/projects/${projectId}/members/${unrelated.userId}`)).status).toBe(204);
  });

  test('an empty environment list is rejected (it would silently grant nothing)', async () => {
    expect((await owner.req('PUT', `/api/v1/projects/${projectId}/members/${other.userId}`, { role: 'viewer', environmentIds: [] })).status).toBe(400);
  });
});
