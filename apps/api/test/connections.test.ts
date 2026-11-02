import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startTestMongo } from '@nexus/database/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { harness, type Client, type Harness } from './helpers.js';

const TOKEN = 'api-test-token-aaaaaaaa';
const NEW_TOKEN = 'api-rotated-token-bbbbbbbb';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let h: Harness;
let target: http.Server;
let port: number;
let owner: Client, engineer: Client, viewer: Client, auditor: Client, globex: Client;
let projectId: string, devEnv: string, prodEnv: string;
const bodies: string[] = []; // every response body, scanned for secrets at the end

beforeAll(async () => {
  target = http.createServer((req, res) => {
    const ok = req.headers.authorization === `Bearer ${TOKEN}` || req.headers.authorization === `Bearer ${NEW_TOKEN}`;
    res.writeHead(ok ? 200 : 401); res.end();
  });
  await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
  port = (target.address() as AddressInfo).port;

  mongo = await startTestMongo();
  h = await harness(mongo.uri);
  [owner, engineer, viewer, auditor, globex] = await Promise.all([
    h.login('owner@acme.test'), h.login('engineer@acme.test'), h.login('viewer@acme.test'), h.login('auditor@acme.test'), h.login('owner@globex.test'),
  ]);
  // wrap every client so each response body is recorded
  for (const c of [owner, engineer, viewer, auditor, globex]) {
    const orig = c.req.bind(c);
    c.req = async (...a) => { const r = await orig(...a); bodies.push(JSON.stringify(r.json)); return r; };
  }
  const p = (await owner.req('POST', '/api/v1/projects', { name: 'Conn project', environments: [{ name: 'Dev' }, { name: 'Prod', isProduction: true }] })).json;
  projectId = p.id; devEnv = p.environments[0].id; prodEnv = p.environments[1].id;
  await owner.req('PUT', `/api/v1/projects/${projectId}/members/${engineer.userId}`, { role: 'engineer' });
  await owner.req('PUT', `/api/v1/projects/${projectId}/members/${viewer.userId}`, { role: 'viewer' });
}, 300_000);

afterAll(async () => {
  target?.closeAllConnections();
  await new Promise((r) => target?.close(r));
  await h?.app.close();
  await h?.db.close();
  await mongo?.stop();
});

const base = () => `/api/v1/projects/${projectId}`;
const create = (c: Client, env: string, over: Record<string, unknown> = {}) =>
  c.req('POST', `${base()}/environments/${env}/connections`, {
    connectorType: 'http-health', name: 'checkout api', authMethod: 'bearer',
    config: { url: `http://127.0.0.1:${port}/healthz` }, secrets: { token: TOKEN }, ...over,
  });

describe('connector registry endpoint', () => {
  test('requires authentication and reports implemented vs planned honestly', async () => {
    expect((await h.app.inject('/api/v1/connectors')).statusCode).toBe(401);
    const res = await viewer.req('GET', '/api/v1/connectors');
    expect(res.status).toBe(200);
    const byType = Object.fromEntries(res.json.map((d: any) => [d.type, d]));
    expect(['http-health', 'mongodb', 'redis'].every((t) => byType[t].status === 'implemented')).toBe(true);
    expect(byType['aws-cloudwatch'].status).toBe('planned');
    // push (ingestion) sources deliver telemetry; of the pull connectors only the database ones sample metrics; the health check only monitors
    expect(res.json.filter((d: any) => d.collection === 'implemented').map((d: any) => d.type).sort()).toEqual(['json-logs', 'mongodb', 'otlp', 'redis']);
    expect(byType['http-health'].collection).toBe('not_implemented');
    expect(res.json.filter((d: any) => d.mode === 'push').every((d: any) => d.status === 'implemented')).toBe(true);
    expect(byType.mongodb.leastPrivilegeGuide).toMatch(/clusterMonitor/);
  });
});

describe('authorization (server-side, per role)', () => {
  test('read-only roles can list but never create, test, rotate, disconnect or delete', async () => {
    const created = await create(owner, devEnv, { name: 'rbac probe' });
    expect(created.status).toBe(201);
    const id = created.json.id;
    for (const c of [engineer, viewer]) {
      expect((await c.req('GET', `${base()}/connections`)).status).toBe(200);
      expect((await c.req('GET', `${base()}/connections/${id}`)).status).toBe(200);
      expect((await create(c, devEnv, { name: 'nope' })).status).toBe(403);
      expect((await c.req('POST', `${base()}/connections/${id}/test`)).status).toBe(403);
      expect((await c.req('POST', `${base()}/connections/${id}/discover`)).status).toBe(403);
      expect((await c.req('POST', `${base()}/connections/${id}/rotate`, { secrets: { token: 'hijack-token-12345' } })).status).toBe(403);
      expect((await c.req('PATCH', `${base()}/connections/${id}`, { name: 'renamed' })).status).toBe(403);
      expect((await c.req('POST', `${base()}/connections/${id}/disconnect`)).status).toBe(403);
      expect((await c.req('DELETE', `${base()}/connections/${id}`)).status).toBe(403);
    }
    await owner.req('DELETE', `${base()}/connections/${id}`);
  });

  test('org members without a grant, auditors and other tenants cannot even see that the project exists', async () => {
    const created = await create(owner, devEnv, { name: 'hidden' });
    const id = created.json.id;
    const nobody = await h.login('admin@acme.test'); // org admin is allowed; use auditor/globex for the negative cases
    expect(nobody.userId).toBeTruthy();
    for (const c of [auditor, globex]) {
      expect((await c.req('GET', `${base()}/connections`)).status).toBe(404);
      expect((await c.req('GET', `${base()}/connections/${id}`)).status).toBe(404);
      expect((await c.req('POST', `${base()}/connections/${id}/test`)).status).toBe(404);
      expect((await create(c, devEnv, { name: 'x' })).status).toBe(404);
      expect((await c.req('DELETE', `${base()}/connections/${id}`)).status).toBe(404);
    }
    await owner.req('DELETE', `${base()}/connections/${id}`);
  });

  test('unauthenticated and CSRF-less writes are rejected before anything else', async () => {
    const noAuth = await h.app.inject({ method: 'POST', url: `${base()}/environments/${devEnv}/connections`, headers: { origin: h.cfg.webOrigin }, payload: { garbage: true } });
    expect(noAuth.statusCode).toBe(401);
    const noCsrf = await h.app.inject({ method: 'POST', url: `${base()}/environments/${devEnv}/connections`, headers: { cookie: owner.cookie, origin: h.cfg.webOrigin }, payload: {} });
    expect(noCsrf.statusCode).toBe(403);
  });

  test('environment-restricted project admins only manage their own environment', async () => {
    await owner.req('PUT', `${base()}/members/${engineer.userId}`, { role: 'project_admin', environmentIds: [devEnv] });
    try {
      const mine = await create(engineer, devEnv, { name: 'scoped dev' });
      expect(mine.status).toBe(201);
      expect((await create(engineer, prodEnv, { name: 'scoped prod' })).status).toBe(404); // not visible to them at all
      const prodConn = await create(owner, prodEnv, { name: 'prod only' });
      expect((await engineer.req('GET', `${base()}/connections`)).json.map((c: any) => c.id)).toEqual([mine.json.id]);
      expect((await engineer.req('GET', `${base()}/connections/${prodConn.json.id}`)).status).toBe(404);
      expect((await engineer.req('POST', `${base()}/connections/${prodConn.json.id}/test`)).status).toBe(404);
      expect((await engineer.req('DELETE', `${base()}/connections/${prodConn.json.id}`)).status).toBe(404);
      await owner.req('DELETE', `${base()}/connections/${mine.json.id}`);
      await owner.req('DELETE', `${base()}/connections/${prodConn.json.id}`);
    } finally {
      await owner.req('PUT', `${base()}/members/${engineer.userId}`, { role: 'engineer' });
    }
  });
});

describe('wizard flow over HTTP', () => {
  let id: string;

  test('create -> test -> discover -> select -> configure -> preview -> activate', async () => {
    const c = await create(owner, prodEnv, { name: 'wizard' });
    expect(c.status).toBe(201);
    id = c.json.id;
    expect(c.json.secrets).toEqual({ token: { set: true, updatedAt: expect.any(String) } });
    expect(c.json).not.toHaveProperty('lease');

    const t = await owner.req('POST', `${base()}/connections/${id}/test`);
    expect(t.status).toBe(200);
    expect(t.json.ok).toBe(true);
    expect(t.json.steps.map((s: any) => s.id)).toEqual(expect.arrayContaining(['config', 'network-policy', 'request', 'status']));
    expect(t.json.connection.health.state).toBe('healthy');

    const d = await owner.req('POST', `${base()}/connections/${id}/discover`);
    expect(d.json.resources[0].id).toBe('endpoint');

    expect((await owner.req('PUT', `${base()}/connections/${id}/selection`, { resourceIds: ['endpoint'], signals: ['logs'] })).status).toBe(400);
    expect((await owner.req('PUT', `${base()}/connections/${id}/selection`, { resourceIds: ['endpoint'], signals: ['metrics'] })).status).toBe(200);
    expect((await owner.req('PUT', `${base()}/connections/${id}/settings`, { pollIntervalSeconds: 5 })).status).toBe(400);
    expect((await owner.req('PUT', `${base()}/connections/${id}/settings`, { pollIntervalSeconds: 45, sampling: 1, retentionDays: 7 })).status).toBe(200);

    const p = await owner.req('GET', `${base()}/connections/${id}/preview`);
    expect(p.status).toBe(200);
    expect(p.json.resources).toEqual([{ id: 'endpoint', name: expect.any(String), type: 'http_endpoint' }]);
    expect(p.json.warnings.join(' ')).toMatch(/not implemented/i);

    const a = await owner.req('POST', `${base()}/connections/${id}/activate`);
    expect(a.status).toBe(200);
    expect(a.json.lifecycle).toBe('active');
    expect(a.json.collection.note).toMatch(/no data is being collected/);
    // viewers can see the result, including the honest collection note
    expect((await viewer.req('GET', `${base()}/connections/${id}`)).json.health.state).toBe('healthy');
  });

  test('premature activation is refused with the missing steps listed', async () => {
    const c = await create(owner, devEnv, { name: 'premature' });
    const a = await owner.req('POST', `${base()}/connections/${c.json.id}/activate`);
    expect(a.status).toBe(409);
    expect(a.json.error.code).toBe('precondition_failed');
    expect(a.json.error.details.missing.length).toBeGreaterThan(0);
    await owner.req('DELETE', `${base()}/connections/${c.json.id}`);
  });

  test('rotation, disconnect (credentials revoked) and delete', async () => {
    const r = await owner.req('POST', `${base()}/connections/${id}/rotate`, { secrets: { token: NEW_TOKEN } });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect((await owner.req('POST', `${base()}/connections/${id}/rotate`, { secrets: { wrongField: 'x' } })).status).toBe(400);

    const dis = await owner.req('POST', `${base()}/connections/${id}/disconnect`);
    expect(dis.json.lifecycle).toBe('disconnected');
    expect(dis.json.secrets).toEqual({});
    expect(await h.db.c.secrets.countDocuments({ connectionId: id })).toBe(0);
    expect((await owner.req('POST', `${base()}/connections/${id}/test`)).status).toBe(409);

    expect((await owner.req('DELETE', `${base()}/connections/${id}`)).status).toBe(204);
    expect((await owner.req('GET', `${base()}/connections/${id}`)).status).toBe(404);
  });

  test('the whole lifecycle is audited, attributed to the actor, with no secret values', async () => {
    const audit = (await owner.req('GET', '/api/v1/audit?limit=200')).json.items as any[];
    const forConn = audit.filter((e) => e.targetId === id).map((e) => e.action);
    expect(forConn).toEqual(expect.arrayContaining([
      'connection.created', 'connection.tested', 'connection.discovered', 'connection.selection_updated', 'connection.settings_updated',
      'connection.activated', 'connection.credentials_rotated', 'connection.disconnected', 'connection.deleted',
    ]));
    expect(audit.filter((e) => e.targetId === id).every((e) => e.actorUserId === owner.userId)).toBe(true);
    // auditors can read the trail (but still not the connections themselves)
    expect(JSON.stringify((await auditor.req('GET', '/api/v1/audit?limit=200')).json)).not.toContain(TOKEN);
  });
});

describe('input validation and SSRF through the API', () => {
  test('invalid input yields 400 with field paths and no echo of secrets; planned connectors yield 501', async () => {
    const bad = await create(owner, devEnv, { name: 'bad', config: { url: 123, nope: true }, secrets: { token: 'leaky-secret-value-1' } });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe('invalid_config');
    expect(JSON.stringify(bad.json)).not.toContain('leaky-secret-value-1');
    const planned = await create(owner, devEnv, { connectorType: 'aws-cloudwatch', authMethod: 'iam-role', secrets: {}, config: {} });
    expect(planned.status).toBe(501);
    expect(planned.json.error.code).toBe('connector_not_implemented');
    const push = await create(owner, devEnv, { connectorType: 'otlp', authMethod: 'ingest-token', secrets: {}, config: {} });
    expect(push.status).toBe(400);
    expect(push.json.error.code).toBe('use_ingestion_tokens'); // implemented, but set up with ingestion tokens
    expect((await create(owner, devEnv, { name: '' })).status).toBe(400);
  });

  test('metadata, private and shorthand-numeric targets are refused at test time; nothing is requested', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data/', 'http://10.0.0.7/healthz', 'http://[fd00:ec2::254]/', 'http://localhost.localdomain/']) {
      const c = await create(owner, devEnv, { name: `ssrf ${url.length}`, config: { url } });
      expect(c.status, url).toBe(201); // saving is allowed; it can never connect
      const t = await owner.req('POST', `${base()}/connections/${c.json.id}/test`);
      expect(t.json.ok, url).toBe(false);
      expect(t.json.failure.kind, url).toBe('misconfigured');
      expect(t.json.steps.find((s: any) => s.id === 'request'), url).toBeUndefined();
      expect(t.json.connection.health.state, url).toBe('misconfigured');
      await owner.req('DELETE', `${base()}/connections/${c.json.id}`);
    }
  });

  test('connection tests are throttled per session', async () => {
    const c = await create(owner, devEnv, { name: 'throttle', config: { url: 'http://169.254.169.254/' } });
    const codes: number[] = [];
    for (let i = 0; i < 24; i++) codes.push((await owner.req('POST', `${base()}/connections/${c.json.id}/test`)).status);
    expect(codes.slice(0, 5).every((s) => s === 200)).toBe(true);
    expect(codes).toContain(429);
    await owner.req('DELETE', `${base()}/connections/${c.json.id}`);
  });
});

describe('mongodb+srv helper (connection form)', () => {
  const url = () => `${base()}/connectors/mongodb/resolve-srv`;
  test('only people who can manage connections may use it; other tenants cannot see the project', async () => {
    expect((await viewer.req('POST', url(), { host: 'c.abcde.mongodb.net' })).status).toBe(403);
    expect((await engineer.req('POST', url(), { host: 'c.abcde.mongodb.net' })).status).toBe(403);
    for (const c of [auditor, globex]) expect((await c.req('POST', url(), { host: 'c.abcde.mongodb.net' })).status).toBe(404);
  });
  test('names that are not a cluster DNS name are refused before any lookup; extra body fields are refused', async () => {
    for (const host of ['localhost', '10.0.0.1', 'a.b', 'bad_label.x.y', '169.254.169.254']) {
      const r = await owner.req('POST', url(), { host });
      expect(r.status, host).toBe(400);
      expect(r.json.error.code, host).toBe('validation_error');
    }
    expect((await owner.req('POST', url(), { host: 'c.abcde.mongodb.net', password: 'x' })).status).toBe(400);
    expect((await owner.req('POST', url(), {})).status).toBe(400);
  });
});

describe('secret hygiene across every response', () => {
  test('no response body anywhere contained a credential', () => {
    expect(bodies.length).toBeGreaterThan(40);
    for (const b of bodies) {
      expect(b).not.toContain(TOKEN);
      expect(b).not.toContain(NEW_TOKEN);
      expect(b).not.toContain('hijack-token');
    }
  });
  test('the database never held a plaintext credential', async () => {
    for (const coll of ['connections', 'secrets', 'audit_events']) {
      const dump = JSON.stringify(await h.db.db.collection(coll).find({}).toArray());
      expect(dump, coll).not.toContain(TOKEN);
      expect(dump, coll).not.toContain(NEW_TOKEN);
    }
  });
});

describe('strict production-like network policy (loopback NOT allowed)', () => {
  test('loopback in every spelling is refused, including the decimal/hex/octal shorthand the URL parser normalises', async () => {
    const strict = await harness(mongo.uri, { NETWORK_ALLOW_LOOPBACK: 'false' });
    try {
      const o = await strict.login('owner@acme.test');
      const p = (await o.req('POST', '/api/v1/projects', { name: 'Strict', environments: [{ name: 'Prod' }] })).json;
      for (const url of [`http://127.0.0.1:${port}/`, 'http://2130706433:8080/', 'http://0x7f.1:8080/', 'http://0177.0.0.1:8080/', 'http://[::1]:8080/', 'http://[::ffff:127.0.0.1]:8080/', 'http://localhost:8080/']) {
        const c = await o.req('POST', `/api/v1/projects/${p.id}/environments/${p.environments[0].id}/connections`, {
          connectorType: 'http-health', name: `strict ${Math.random().toString(36).slice(2, 8)}`, authMethod: 'none', config: { url }, secrets: {},
        });
        const t = await o.req('POST', `/api/v1/projects/${p.id}/connections/${c.json.id}/test`);
        expect(t.json.ok, url).toBe(false);
        expect(t.json.failure.kind, url).toBe('misconfigured');
        expect(t.json.steps.find((s: any) => s.id === 'request'), url).toBeUndefined();
      }
    } finally {
      await strict.app.close();
      await strict.db.close();
    }
  });
});
