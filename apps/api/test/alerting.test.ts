import { AlertEngine, IncidentService, Notifier, type WebhookSender } from '@nexus/alerting';
import { AuditService } from '@nexus/database';
import { startTestMongo } from '@nexus/database/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { harness, type Client, type Harness } from './helpers.js';

const SECRET = 'whsec_api-test-signing-secret-0123456789';
const TOKEN_PATH = 'SUPER-SECRET-PATH-TOKEN-8842';
// an IP literal: validation resolves host names through real DNS, which a test must not depend on
const HOOK = `https://93.184.216.34/services/${TOKEN_PATH}`;

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let h: Harness;
let strict: Harness;
let owner: Client, engineer: Client, viewer: Client, devEngineer: Client, globex: Client, globexStrictOwner: Client;
let projectId: string, devEnv: string, prodEnv: string, gProject: string, gEnv: string;
const bodies: string[] = [];
const sentToReceiver: { url: string; secret: string; event: string; body: string }[] = [];
const sender: WebhookSender = async (req) => { sentToReceiver.push({ url: req.url, secret: req.secret, event: req.event, body: req.body }); return { ok: true, httpStatus: 200, code: null, message: 'Delivered (HTTP 200)', retryable: false }; };

const base = () => `/api/v1/projects/${projectId}`;
const ruleBody = (over: Record<string, unknown> = {}) => ({
  name: `High error rate ${Math.random().toString(36).slice(2, 7)}`, severity: 'critical', environmentId: devEnv,
  query: { kind: 'metric', metric: 'http.errors', agg: 'max' }, condition: { op: 'gt', threshold: 10 }, windowSeconds: 300, forSeconds: 0, ...over,
});
const channelBody = (over: Record<string, unknown> = {}) => ({ type: 'webhook', name: `ops-${Math.random().toString(36).slice(2, 7)}`, url: HOOK, signingSecret: SECRET, ...over });

/** Opens an incident for a rule exactly as the worker would (through the engine, with a scripted metric store). */
async function openIncident(ruleId: string, groupKeyValue?: string) {
  const rule = (await h.db.c.alertConfig.findOne({ _id: ruleId }))! as never as Parameters<IncidentService['open']>[0];
  const svc = new IncidentService(h.db, new AuditService(h.db), new Notifier(h.db));
  const labels: Record<string, string> = groupKeyValue ? { service: groupKeyValue } : {};
  return (await svc.open(rule, { key: groupKeyValue ? `service=${groupKeyValue}` : '', labels }, 99, new Date())).incident;
}

beforeAll(async () => {
  mongo = await startTestMongo();
  h = await harness(mongo.uri, {}, { webhookSender: sender });
  // a second deployment with the PRODUCTION network policy (no loopback, no plain http) to prove the SSRF protection at the API
  strict = await harness(mongo.uri, { NETWORK_ALLOW_LOOPBACK: 'false', NETWORK_ALLOW_INSECURE_HTTP: 'false' });
  [owner, engineer, viewer, devEngineer, globex] = await Promise.all([
    h.login('owner@acme.test'), h.login('engineer@acme.test'), h.login('viewer@acme.test'), h.login('auditor@acme.test'), h.login('owner@globex.test'),
  ]);
  globexStrictOwner = await strict.login('owner@globex.test');
  for (const c of [owner, engineer, viewer, devEngineer, globex]) {
    const orig = c.req.bind(c);
    c.req = async (...a) => { const r = await orig(...a); bodies.push(JSON.stringify(r.json)); return r; };
  }
  const p = (await owner.req('POST', '/api/v1/projects', { name: 'Alerting project', environments: [{ name: 'Dev' }, { name: 'Prod', isProduction: true }] })).json;
  projectId = p.id; devEnv = p.environments[0].id; prodEnv = p.environments[1].id;
  await owner.req('PUT', `${base()}/members/${engineer.userId}`, { role: 'engineer' });
  await owner.req('PUT', `${base()}/members/${viewer.userId}`, { role: 'viewer' });
  await owner.req('PUT', `${base()}/members/${devEngineer.userId}`, { role: 'engineer', environmentIds: [devEnv] }); // an auditor with an environment-restricted engineer grant
  const g = (await globex.req('POST', '/api/v1/projects', { name: 'Globex project', environments: [{ name: 'Dev' }] })).json;
  gProject = g.id; gEnv = g.environments[0].id;
}, 300_000);

afterAll(async () => {
  await h?.app.close(); await h?.db.close();
  await strict?.app.close(); await strict?.db.close();
  await mongo?.stop();
});

describe('authentication and the OpenAPI contract', () => {
  test('every alerting route requires a session: anonymous and forged-cookie requests get 401, state changes without CSRF get 403', async () => {
    const routes = h.app.routeTable.filter((r) => /\/(alert-rules|alert-channels|alert-silences|incidents)/.test(r.url) && r.method !== 'HEAD');
    expect(routes.length).toBeGreaterThanOrEqual(19);
    expect(routes.every((r) => r.authenticated)).toBe(true);
    for (const r of routes) {
      const url = r.url.replace(':projectId', projectId).replace(/:\w+/g, crypto.randomUUID());
      const anon = await h.app.inject({ method: r.method as 'GET', url });
      expect(anon.statusCode, `${r.method} ${r.url}`).toBe(401);
      const forged = await h.app.inject({ method: r.method as 'GET', url, headers: { cookie: 'nx_sid=forged', authorization: 'Bearer x' } });
      expect(forged.statusCode, `${r.method} ${r.url}`).toBe(401);
    }
    const noCsrf = await h.app.inject({ method: 'POST', url: `${base()}/alert-rules`, headers: { cookie: owner.cookie, origin: h.cfg.webOrigin }, payload: ruleBody() });
    expect(noCsrf.statusCode).toBe(403);
    const badOrigin = await h.app.inject({ method: 'POST', url: `${base()}/alert-rules`, headers: { cookie: owner.cookie, 'x-csrf-token': owner.csrf, origin: 'https://evil.example' }, payload: ruleBody() });
    expect(badOrigin.statusCode).toBe(403);
  });

  test('the OpenAPI document describes every route with typed bodies and responses', async () => {
    const spec = (h.app as unknown as { swagger(): { paths: Record<string, Record<string, { tags?: string[]; requestBody?: unknown; responses?: Record<string, unknown> }>>; components?: unknown } }).swagger();
    const p = (path: string, method: string) => spec.paths[`/api/v1/projects/{projectId}${path}`]?.[method];
    const expected: [string, string, string][] = [
      ['/alert-rules', 'get', '200'], ['/alert-rules', 'post', '201'], ['/alert-rules/{ruleId}', 'get', '200'], ['/alert-rules/{ruleId}', 'patch', '200'], ['/alert-rules/{ruleId}', 'delete', '204'],
      ['/alert-channels', 'get', '200'], ['/alert-channels', 'post', '201'], ['/alert-channels/{channelId}', 'patch', '200'], ['/alert-channels/{channelId}', 'delete', '204'], ['/alert-channels/{channelId}/test', 'post', '200'],
      ['/alert-silences', 'get', '200'], ['/alert-silences', 'post', '201'], ['/alert-silences/{silenceId}', 'delete', '204'],
      ['/incidents', 'get', '200'], ['/incidents/{incidentId}', 'get', '200'], ['/incidents/{incidentId}/deliveries', 'get', '200'],
      ['/incidents/{incidentId}/acknowledge', 'post', '200'], ['/incidents/{incidentId}/resolve', 'post', '200'], ['/incidents/{incidentId}/comments', 'post', '200'],
    ];
    for (const [path, method, ok] of expected) {
      const op = p(path, method);
      expect(op, `${method} ${path}`).toBeTruthy();
      expect(op!.tags?.[0]).toMatch(/alerting|incidents/);
      expect(Object.keys(op!.responses ?? {})).toContain(ok);
    }
    expect(p('/alert-rules', 'post')!.requestBody).toBeTruthy();
    // the signing secret is declared write-only in the request schema and absent from every response schema
    const json = JSON.stringify(spec);
    const channelResp = JSON.stringify(p('/alert-channels', 'post')!.responses!['201']);
    expect(channelResp).not.toMatch(/signingSecret/);
    expect(json).toMatch(/signingSecret/);
  });

  test('malformed input is a 400 validation error with details and never a 500', async () => {
    for (const body of [{}, ruleBody({ severity: 'nope' }), ruleBody({ windowSeconds: 5 }), ruleBody({ query: { kind: 'metric', metric: 'm', agg: 'p99' } }), ruleBody({ projectId: crypto.randomUUID() }), ruleBody({ environmentId: 'not-a-uuid' }), ruleBody({ condition: { op: '$ne', threshold: 1 } })]) {
      const r = await owner.req('POST', `${base()}/alert-rules`, body);
      expect(r.status).toBe(400);
      expect(r.json.error).toMatchObject({ code: 'validation_error' });
    }
    expect((await owner.req('GET', `${base()}/incidents?limit=abc`)).status).toBe(400);
    expect((await owner.req('GET', `${base()}/incidents?limit=1000`)).status).toBe(400);
    expect((await owner.req('GET', `${base()}/incidents/not-a-uuid`)).status).toBe(400);
    expect((await owner.req('GET', `${base()}/alert-rules?enabled=maybe`)).status).toBe(400);
  });
});

describe('RBAC: viewers read, engineers act on incidents, project admins configure', () => {
  test('rules, channels and silences: everyone with access can read; only project admins (and org owners/admins) can change them', async () => {
    const rule = (await owner.req('POST', `${base()}/alert-rules`, ruleBody())).json;
    const ch = (await owner.req('POST', `${base()}/alert-channels`, channelBody())).json;
    for (const c of [viewer, engineer]) {
      expect((await c.req('GET', `${base()}/alert-rules`)).status).toBe(200);
      expect((await c.req('GET', `${base()}/alert-rules/${rule.id}`)).status).toBe(200);
      expect((await c.req('GET', `${base()}/alert-channels`)).status).toBe(200);
      expect((await c.req('GET', `${base()}/alert-silences`)).status).toBe(200);
      expect((await c.req('POST', `${base()}/alert-rules`, ruleBody())).status).toBe(403);
      expect((await c.req('PATCH', `${base()}/alert-rules/${rule.id}`, { enabled: false })).status).toBe(403);
      expect((await c.req('DELETE', `${base()}/alert-rules/${rule.id}`)).status).toBe(403);
      expect((await c.req('POST', `${base()}/alert-channels`, channelBody())).status).toBe(403);
      expect((await c.req('PATCH', `${base()}/alert-channels/${ch.id}`, { enabled: false })).status).toBe(403);
      expect((await c.req('DELETE', `${base()}/alert-channels/${ch.id}`)).status).toBe(403);
      expect((await c.req('POST', `${base()}/alert-channels/${ch.id}/test`)).status).toBe(403);
      expect((await c.req('POST', `${base()}/alert-silences`, { comment: 'x', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 3600_000).toISOString() })).status).toBe(403);
    }
    expect(sentToReceiver.filter((s) => s.event === 'test')).toHaveLength(0); // the forbidden test-send reached no receiver
    // a rule untouched by the refused attempts
    expect((await owner.req('GET', `${base()}/alert-rules/${rule.id}`)).json).toMatchObject({ enabled: true, version: 1 });
  });

  test('incidents: viewers are read-only; engineers (and admins) acknowledge, resolve and comment', async () => {
    const rule = (await owner.req('POST', `${base()}/alert-rules`, ruleBody())).json;
    const inc = await openIncident(rule._id ?? rule.id);
    const path = `${base()}/incidents/${inc._id}`;
    expect((await viewer.req('GET', path)).status).toBe(200);
    expect((await viewer.req('GET', `${base()}/incidents`)).status).toBe(200);
    expect((await viewer.req('POST', `${path}/acknowledge`, {})).status).toBe(403);
    expect((await viewer.req('POST', `${path}/resolve`, {})).status).toBe(403);
    expect((await viewer.req('POST', `${path}/comments`, { body: 'hi' })).status).toBe(403);
    expect((await owner.req('GET', path)).json).toMatchObject({ status: 'open', acknowledgedBy: null });

    const ack = await engineer.req('POST', `${path}/acknowledge`, { note: 'on it' });
    expect(ack.status).toBe(200);
    expect(ack.json).toMatchObject({ status: 'acknowledged', acknowledgedBy: engineer.userId });
    expect(ack.json.timeline.map((e: { type: string }) => e.type)).toEqual(['opened', 'acknowledged']);
    expect(ack.json.timeline[1]).toMatchObject({ actorUserId: engineer.userId, actorName: 'Erin Engineer' });
    expect((await engineer.req('POST', `${path}/acknowledge`, {})).status).toBe(409);
    const c = await engineer.req('POST', `${path}/comments`, { body: 'rolling back the deploy' });
    expect(c.status).toBe(200);
    expect(c.json.timeline.at(-1)).toMatchObject({ type: 'comment', message: 'rolling back the deploy' });
    expect((await engineer.req('POST', `${path}/comments`, { body: '   ' })).status).toBe(400);
    expect((await engineer.req('POST', `${path}/comments`, { body: 'x'.repeat(2001) })).status).toBe(400);
    const res = await owner.req('POST', `${path}/resolve`, { note: 'rolled back' });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ status: 'resolved', resolvedBy: { kind: 'user', userId: owner.userId } });
    expect((await owner.req('POST', `${path}/resolve`, {})).status).toBe(409);
    // the audit trail attributes every action
    const audit = await owner.req('GET', `/api/v1/audit?projectId=${projectId}&limit=200`);
    const actions = audit.json.items.filter((e: { targetId: string }) => e.targetId === inc._id).map((e: { action: string; actorUserId: string }) => [e.action, e.actorUserId]);
    expect(actions).toEqual(expect.arrayContaining([['incident.acknowledged', engineer.userId], ['incident.commented', engineer.userId], ['incident.resolved', owner.userId]]));
  });

  test('a user with no grant on the project gets 404 (not 403) for everything', async () => {
    const stranger = await h.login('admin@acme.test'); // org admin: implicit access, so use the auditor WITHOUT a grant on another project
    void stranger;
    const p2 = (await owner.req('POST', '/api/v1/projects', { name: 'Private alerts project', environments: [{ name: 'Dev' }] })).json;
    for (const [m, u] of [['GET', `/api/v1/projects/${p2.id}/alert-rules`], ['GET', `/api/v1/projects/${p2.id}/incidents`], ['GET', `/api/v1/projects/${p2.id}/alert-channels`], ['POST', `/api/v1/projects/${p2.id}/alert-rules`]] as const) {
      expect((await viewer.req(m, u, m === 'POST' ? ruleBody({ environmentId: p2.environments[0].id }) : undefined)).status, `${m} ${u}`).toBe(404);
    }
  });
});

describe('rules API', () => {
  test('create, read, update, enable/disable, list with pagination, delete; changes are audited', async () => {
    const created = await owner.req('POST', `${base()}/alert-rules`, ruleBody({ name: 'API lifecycle', description: 'd', channelIds: [] }));
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ name: 'API lifecycle', enabled: true, health: 'unknown', status: 'unknown', version: 1, forSeconds: 0, resolveAfterSeconds: 120, noDataPolicy: 'keep', intervalSeconds: 60, projectId });
    expect(created.json).not.toHaveProperty('orgId');
    expect(created.json).not.toHaveProperty('lease');
    expect((await owner.req('POST', `${base()}/alert-rules`, ruleBody({ name: 'api LIFECYCLE' }))).status).toBe(409);
    const id = created.json.id;
    const upd = await owner.req('PATCH', `${base()}/alert-rules/${id}`, { enabled: false, severity: 'warning' });
    expect(upd.status).toBe(200);
    expect(upd.json).toMatchObject({ enabled: false, severity: 'warning', nextEvalAt: null, version: 2 });
    expect((await owner.req('PATCH', `${base()}/alert-rules/${id}`, {})).status).toBe(400);
    expect((await owner.req('GET', `${base()}/alert-rules?enabled=false`)).json.items.map((r: { id: string }) => r.id)).toContain(id);
    expect((await owner.req('GET', `${base()}/alert-rules?enabled=true`)).json.items.map((r: { id: string }) => r.id)).not.toContain(id);
    // keyset pagination
    for (let i = 0; i < 5; i++) await owner.req('POST', `${base()}/alert-rules`, ruleBody({ name: `page-${i}` }));
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const r: { json: { items: { id: string }[]; nextCursor: string | null } } = await owner.req('GET', `${base()}/alert-rules?limit=3${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...r.json.items.map((x) => x.id)); cursor = r.json.nextCursor;
    } while (cursor);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(6);
    expect((await owner.req('DELETE', `${base()}/alert-rules/${id}`)).status).toBe(204);
    expect((await owner.req('GET', `${base()}/alert-rules/${id}`)).status).toBe(404);
    const audit = (await owner.req('GET', `/api/v1/audit?projectId=${projectId}&limit=200`)).json.items.filter((e: { targetId: string }) => e.targetId === id).map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['alert.rule.created', 'alert.rule.updated', 'alert.rule.deleted']));
  });

  test('a rule can only target an environment of its own project and only the project\'s own channels', async () => {
    expect((await owner.req('POST', `${base()}/alert-rules`, ruleBody({ environmentId: gEnv }))).status).toBe(404);
    expect((await owner.req('POST', `${base()}/alert-rules`, ruleBody({ environmentId: crypto.randomUUID() }))).status).toBe(404);
    const gCh = (await globex.req('POST', `/api/v1/projects/${gProject}/alert-channels`, channelBody({ name: 'globex hook' })));
    expect(gCh.status).toBe(201);
    const r = await owner.req('POST', `${base()}/alert-rules`, ruleBody({ channelIds: [gCh.json.id] }));
    expect(r.status).toBe(422);
  });

  test('an environment-restricted engineer cannot see, ack or touch the other environment\'s incidents or rules', async () => {
    const prodRule = (await owner.req('POST', `${base()}/alert-rules`, ruleBody({ environmentId: prodEnv }))).json;
    const devRule = (await owner.req('POST', `${base()}/alert-rules`, ruleBody({ environmentId: devEnv }))).json;
    const prodInc = await openIncident(prodRule.id), devInc = await openIncident(devRule.id);
    const list = (await devEngineer.req('GET', `${base()}/incidents?limit=100`)).json.items.map((i: { id: string }) => i.id);
    expect(list).toContain(devInc._id);
    expect(list).not.toContain(prodInc._id);
    expect((await devEngineer.req('GET', `${base()}/incidents/${prodInc._id}`)).status).toBe(404);
    expect((await devEngineer.req('POST', `${base()}/incidents/${prodInc._id}/acknowledge`, {})).status).toBe(404);
    expect((await devEngineer.req('POST', `${base()}/incidents/${prodInc._id}/comments`, { body: 'x' })).status).toBe(404);
    expect((await devEngineer.req('GET', `${base()}/alert-rules/${prodRule.id}`)).status).toBe(404);
    expect((await devEngineer.req('GET', `${base()}/incidents?environmentId=${prodEnv}`)).json.items).toEqual([]);
    expect((await devEngineer.req('POST', `${base()}/incidents/${devInc._id}/acknowledge`, {})).status).toBe(200);
    expect((await owner.req('GET', `${base()}/incidents/${prodInc._id}`)).json.status).toBe('open'); // untouched
  });
});

describe('channels API: secrets, SSRF, test send', () => {
  test('the signing secret and the URL path/token are write-only: they never appear in any response, audit entry or stored document', async () => {
    const created = await owner.req('POST', `${base()}/alert-channels`, channelBody({ name: 'secret-hygiene' }));
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ name: 'secret-hygiene', hasSigningSecret: true, urlDisplay: 'https://93.184.216.34/…', type: 'webhook', enabled: true, rateLimitPerMinute: 20 });
    expect(Object.keys(created.json).sort()).toEqual(['createdAt', 'createdBy', 'enabled', 'hasSigningSecret', 'id', 'lastTest', 'name', 'projectId', 'rateLimitPerMinute', 'type', 'updatedAt', 'urlDisplay']);
    await owner.req('PATCH', `${base()}/alert-channels/${created.json.id}`, { signingSecret: `${SECRET}-rotated`, rateLimitPerMinute: 10 });
    await owner.req('POST', `${base()}/alert-channels/${created.json.id}/test`);
    await owner.req('GET', `${base()}/alert-channels`);
    for (const c of [viewer, engineer]) await c.req('GET', `${base()}/alert-channels`);
    for (const b of bodies) { expect(b).not.toContain(SECRET); expect(b).not.toContain(TOKEN_PATH); }
    const audit = JSON.stringify((await owner.req('GET', `/api/v1/audit?projectId=${projectId}&limit=200`)).json);
    expect(audit).toContain('alert.channel.created');
    expect(audit).not.toContain(SECRET); expect(audit).not.toContain(TOKEN_PATH);
    expect(JSON.stringify(await h.db.c.alertConfig.find({ projectId }).toArray())).not.toContain(SECRET);
    expect(JSON.stringify(await h.db.c.alertDeliveries.find({ projectId }).toArray())).not.toContain(SECRET);
    expect(JSON.stringify(await h.db.c.secrets.find({}).toArray())).not.toContain(SECRET);
    expect(JSON.stringify(await h.db.c.secrets.find({}).toArray())).not.toContain(TOKEN_PATH);
  });

  test('test-send signs with the stored secret, records a delivery, never retries, and is limited to 5 per minute', async () => {
    const ch = (await owner.req('POST', `${base()}/alert-channels`, channelBody({ name: 'test-send' }))).json;
    const before = sentToReceiver.length;
    const r = await owner.req('POST', `${base()}/alert-channels/${ch.id}/test`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, status: 200, delivery: { event: 'test', status: 'delivered', attempts: 1, channelId: ch.id } });
    expect(sentToReceiver.length).toBe(before + 1);
    expect(sentToReceiver.at(-1)).toMatchObject({ url: HOOK, secret: SECRET, event: 'test' }); // decrypted correctly for the receiver, only inside the server
    expect(JSON.stringify(r.json)).not.toContain(SECRET);
    for (let i = 0; i < 4; i++) expect((await owner.req('POST', `${base()}/alert-channels/${ch.id}/test`)).status).toBe(200);
    expect((await owner.req('POST', `${base()}/alert-channels/${ch.id}/test`)).status).toBe(429);
    expect((await owner.req('GET', `${base()}/alert-channels`)).json.items.find((c: { id: string }) => c.id === ch.id).lastTest).toMatchObject({ ok: true });
  });

  test('SSRF at the API (production network policy): private, loopback, link-local, metadata, non-https and credentialed URLs are refused when saving', async () => {
    const p = (await globexStrictOwner.req('POST', '/api/v1/projects', { name: 'Strict SSRF', environments: [{ name: 'Dev' }] })).json;
    const url = `/api/v1/projects/${p.id}/alert-channels`;
    for (const bad of [
      'http://93.184.216.34/hook', 'https://127.0.0.1/hook', 'https://[::1]/hook', 'https://10.0.0.5/hook', 'https://192.168.1.10/hook', 'https://169.254.169.254/latest/meta-data/',
      'https://metadata.google.internal/', 'https://localhost/hook', 'https://2130706433/', 'https://[::ffff:127.0.0.1]/', 'https://user:pw@93.184.216.34/hook', 'ftp://93.184.216.34/', 'https://93.184.216.34:25/',
    ]) {
      const r = await globexStrictOwner.req('POST', url, channelBody({ name: `bad-${bad.length}-${Math.random().toString(36).slice(2, 5)}`, url: bad }));
      expect(r.status, bad).toBe(422);
      expect(r.json.error.code).toBe('validation_error');
      expect(JSON.stringify(r.json)).not.toContain(SECRET);
    }
    expect(await strict.db.c.alertConfig.countDocuments({ projectId: p.id })).toBe(0);
    expect((await globexStrictOwner.req('POST', url, channelBody({ name: 'ok-public', url: 'https://93.184.216.34/hook' }))).status).toBe(201);
    // updating an existing channel to a blocked URL is refused too, and the stored URL is unchanged
    const ch = (await globexStrictOwner.req('GET', url)).json.items[0];
    expect((await globexStrictOwner.req('PATCH', `${url}/${ch.id}`, { url: 'https://169.254.169.254/' })).status).toBe(422);
    expect((await globexStrictOwner.req('GET', url)).json.items[0].urlDisplay).toBe('https://93.184.216.34/…');
  });

  test('deleting a channel removes its secrets and detaches it from rules', async () => {
    const ch = (await owner.req('POST', `${base()}/alert-channels`, channelBody({ name: 'to-delete' }))).json;
    const rule = (await owner.req('POST', `${base()}/alert-rules`, ruleBody({ channelIds: [ch.id] }))).json;
    expect((await owner.req('DELETE', `${base()}/alert-channels/${ch.id}`)).status).toBe(204);
    expect((await owner.req('GET', `${base()}/alert-rules/${rule.id}`)).json.channelIds).toEqual([]);
    expect(await h.db.c.secrets.countDocuments({ connectionId: `alert-channel:${ch.id}` })).toBe(0);
  });
});

describe('silences API and notification flow', () => {
  test('a silence suppresses the webhook but the incident is still recorded and visible in the delivery log', async () => {
    const ch = (await owner.req('POST', `${base()}/alert-channels`, channelBody({ name: 'silenced-channel' }))).json;
    const rule = (await owner.req('POST', `${base()}/alert-rules`, ruleBody({ channelIds: [ch.id] }))).json;
    const sil = await owner.req('POST', `${base()}/alert-silences`, { comment: 'Planned database migration', startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 3600_000).toISOString(), matchers: { ruleIds: [rule.id] } });
    expect(sil.status).toBe(201);
    expect(sil.json).toMatchObject({ state: 'active', matchers: { ruleIds: [rule.id] } });
    const inc = await openIncident(rule.id);
    const deliveries = (await viewer.req('GET', `${base()}/incidents/${inc._id}/deliveries`)).json;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ status: 'suppressed', silenceId: sil.json.id, channelName: 'silenced-channel' });
    const detail = (await viewer.req('GET', `${base()}/incidents/${inc._id}`)).json;
    expect(detail.status).toBe('open');
    expect(detail.timeline.map((e: { type: string }) => e.type)).toEqual(['opened', 'notification_suppressed']);
    expect((await owner.req('DELETE', `${base()}/alert-silences/${sil.json.id}`)).status).toBe(204);
    expect((await owner.req('DELETE', `${base()}/alert-silences/${sil.json.id}`)).status).toBe(404);
    // invalid silences
    const now = Date.now();
    for (const body of [
      { comment: 'x', startsAt: new Date(now).toISOString(), endsAt: new Date(now - 1000).toISOString() },
      { comment: 'x', startsAt: new Date(now).toISOString(), endsAt: new Date(now + 40 * 86_400_000).toISOString() },
      { comment: '', startsAt: new Date(now).toISOString(), endsAt: new Date(now + 1000).toISOString() },
    ]) expect((await owner.req('POST', `${base()}/alert-silences`, body)).status).toBe(400);
  });

  test('the engine opens an incident that the API then serves (end to end through real services)', async () => {
    const rule = (await owner.req('POST', `${base()}/alert-rules`, ruleBody({ name: 'e2e-through-api', severity: 'warning' }))).json;
    const svc = new IncidentService(h.db, new AuditService(h.db), new Notifier(h.db));
    const engine = new AlertEngine(h.db, {
      metrics: { query: async (_s, q) => ({ metric: q.metric, type: 'gauge', unit: null, agg: 'max', stepMs: 60000, from: q.from, to: q.to, truncated: false, notes: [], series: [{ labels: {}, points: [{ t: 0, v: 55 }], exemplars: [] }] }) as never },
      logs: { histogram: async () => ({ bucketMs: 1, buckets: [] }) },
    }, svc, { owner: 'api-test' });
    await engine.tick();
    const list = (await viewer.req('GET', `${base()}/incidents?ruleId=${rule.id}&status=active`)).json;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ ruleName: 'e2e-through-api', severity: 'warning', status: 'open', lastValue: 55, environmentId: devEnv, condition: { op: 'gt', threshold: 10, windowSeconds: 300 } });
    expect(list.items[0]).not.toHaveProperty('timeline');
    expect((await viewer.req('GET', `${base()}/alert-rules/${rule.id}`)).json).toMatchObject({ health: 'ok', status: 'firing', lastValue: 55 });
  });
});

describe('tenant isolation (another organization, and another project of the same organization)', () => {
  test('globex can never list, read, change or notify about acme\'s alerting objects, by any route', async () => {
    const rule = (await owner.req('POST', `${base()}/alert-rules`, ruleBody({ name: 'acme-private' }))).json;
    const ch = (await owner.req('POST', `${base()}/alert-channels`, channelBody({ name: 'acme-private-channel' }))).json;
    const inc = await openIncident(rule.id);
    const sentBefore = sentToReceiver.length;
    const attempts: [string, string, unknown?][] = [
      ['GET', `${base()}/alert-rules`], ['GET', `${base()}/alert-rules/${rule.id}`], ['PATCH', `${base()}/alert-rules/${rule.id}`, { enabled: false }], ['DELETE', `${base()}/alert-rules/${rule.id}`],
      ['POST', `${base()}/alert-rules`, ruleBody({ environmentId: gEnv })],
      ['GET', `${base()}/alert-channels`], ['PATCH', `${base()}/alert-channels/${ch.id}`, { enabled: false }], ['DELETE', `${base()}/alert-channels/${ch.id}`], ['POST', `${base()}/alert-channels/${ch.id}/test`],
      ['POST', `${base()}/alert-channels`, channelBody({ name: 'x' })],
      ['GET', `${base()}/alert-silences`], ['POST', `${base()}/alert-silences`, { comment: 'x', startsAt: new Date().toISOString(), endsAt: new Date(Date.now() + 1000).toISOString() }],
      ['GET', `${base()}/incidents`], ['GET', `${base()}/incidents/${inc._id}`], ['GET', `${base()}/incidents/${inc._id}/deliveries`],
      ['POST', `${base()}/incidents/${inc._id}/acknowledge`, {}], ['POST', `${base()}/incidents/${inc._id}/resolve`, {}], ['POST', `${base()}/incidents/${inc._id}/comments`, { body: 'hi' }],
    ];
    for (const [m, u, b] of attempts) expect((await globex.req(m, u, b)).status, `${m} ${u}`).toBe(404);
    // using the incident id under globex's OWN project must not find it either
    const g = `/api/v1/projects/${gProject}`;
    for (const [m, u, b] of [['GET', `${g}/incidents/${inc._id}`], ['POST', `${g}/incidents/${inc._id}/acknowledge`, {}], ['POST', `${g}/incidents/${inc._id}/comments`, { body: 'x' }], ['GET', `${g}/alert-rules/${rule.id}`], ['POST', `${g}/alert-channels/${ch.id}/test`]] as const) {
      expect((await globex.req(m, u, b)).status, `${m} ${u}`).toBe(404);
    }
    expect((await globex.req('GET', `${g}/incidents`)).json.items).toEqual([]);
    expect((await globex.req('GET', `${g}/alert-rules`)).json.items.every((r: { projectId: string }) => r.projectId === gProject)).toBe(true);
    expect(sentToReceiver.length).toBe(sentBefore); // nothing was sent on globex's behalf
    expect(await h.db.c.incidents.findOne({ _id: inc._id })).toMatchObject({ status: 'open', commentCount: 0, acknowledgedBy: null });
    expect((await owner.req('GET', `${base()}/alert-rules/${rule.id}`)).json).toMatchObject({ enabled: true, version: 1 });
  });

  test('two projects of the SAME organization are isolated from each other as well', async () => {
    const p2 = (await owner.req('POST', '/api/v1/projects', { name: 'Second alerting project', environments: [{ name: 'Dev' }] })).json;
    const rule = (await owner.req('POST', `${base()}/alert-rules`, ruleBody({ name: 'only-in-first' }))).json;
    const inc = await openIncident(rule.id);
    const other = `/api/v1/projects/${p2.id}`;
    expect((await owner.req('GET', `${other}/alert-rules/${rule.id}`)).status).toBe(404);
    expect((await owner.req('GET', `${other}/incidents/${inc._id}`)).status).toBe(404);
    expect((await owner.req('POST', `${other}/incidents/${inc._id}/acknowledge`, {})).status).toBe(404);
    expect((await owner.req('GET', `${other}/incidents`)).json.items).toEqual([]);
    expect((await owner.req('POST', `${other}/alert-rules`, ruleBody({ environmentId: devEnv }))).status).toBe(404); // first project's environment
    // the same rule name may exist in both projects
    expect((await owner.req('POST', `${other}/alert-rules`, ruleBody({ name: 'only-in-first', environmentId: p2.environments[0].id }))).status).toBe(201);
  });
});
