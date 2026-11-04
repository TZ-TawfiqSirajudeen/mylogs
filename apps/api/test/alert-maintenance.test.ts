import { AuditService } from '@nexus/database';
import { IncidentService, Notifier, type WebhookSender } from '@nexus/alerting';
import { startTestMongo } from '@nexus/database/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { harness, type Client, type Harness } from './helpers.js';

// Maintenance windows (ADR-0010) and the replay-policy fields of rules, through the real HTTP stack.
let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let h: Harness;
let owner: Client, engineer: Client, viewer: Client, auditorRestricted: Client, globex: Client;
let projectId: string, devEnv: string, gProject: string;
const sent: string[] = [];
const sender: WebhookSender = async (req) => { sent.push(req.event); return { ok: true, httpStatus: 200, code: null, message: 'Delivered (HTTP 200)', retryable: false }; };
const base = () => `/api/v1/projects/${projectId}`;
const W = () => `${base()}/alert-maintenance-windows`;
const weekly = (over: Record<string, unknown> = {}) => ({ type: 'weekly', timezone: 'Europe/Berlin', weekdays: ['sun'], startTime: '02:00', durationMinutes: 120, ...over });
const once = (fromMs: number, toMs: number) => ({ type: 'once', startsAt: new Date(Date.now() + fromMs).toISOString(), endsAt: new Date(Date.now() + toMs).toISOString() });
const body = (over: Record<string, unknown> = {}) => ({ name: `Window ${Math.random().toString(36).slice(2, 8)}`, comment: 'planned', schedule: weekly(), ...over });
const ruleBody = (over: Record<string, unknown> = {}) => ({
  name: `Rule ${Math.random().toString(36).slice(2, 7)}`, severity: 'critical', environmentId: devEnv,
  query: { kind: 'metric', metric: 'http.errors', agg: 'max' }, condition: { op: 'gt', threshold: 10 }, windowSeconds: 300, forSeconds: 0, ...over,
});
async function openIncident(ruleId: string) {
  const rule = (await h.db.c.alertConfig.findOne({ _id: ruleId }))! as never as Parameters<IncidentService['open']>[0];
  const svc = new IncidentService(h.db, new AuditService(h.db), new Notifier(h.db));
  return (await svc.open(rule, { key: '', labels: {} }, 99, new Date())).incident;
}

beforeAll(async () => {
  mongo = await startTestMongo();
  h = await harness(mongo.uri, {}, { webhookSender: sender });
  [owner, engineer, viewer, auditorRestricted, globex] = await Promise.all([
    h.login('owner@acme.test'), h.login('engineer@acme.test'), h.login('viewer@acme.test'), h.login('auditor@acme.test'), h.login('owner@globex.test'),
  ]);
  const p = (await owner.req('POST', '/api/v1/projects', { name: 'Maintenance project', environments: [{ name: 'Dev' }, { name: 'Prod', isProduction: true }] })).json;
  projectId = p.id; devEnv = p.environments[0].id;
  await owner.req('PUT', `${base()}/members/${engineer.userId}`, { role: 'engineer' });
  await owner.req('PUT', `${base()}/members/${viewer.userId}`, { role: 'viewer' });
  await owner.req('PUT', `${base()}/members/${auditorRestricted.userId}`, { role: 'project_admin', environmentIds: [devEnv] });
  const g = (await globex.req('POST', '/api/v1/projects', { name: 'Globex maintenance', environments: [{ name: 'Dev' }] })).json;
  gProject = g.id;
}, 300_000);
afterAll(async () => { await h?.app.close(); await h?.db.close(); await mongo?.stop(); });

describe('contract and authentication', () => {
  test('every route requires a session and CSRF; the OpenAPI document describes them', async () => {
    const routes = h.app.routeTable.filter((r) => /alert-maintenance-windows/.test(r.url) && r.method !== 'HEAD');
    expect(routes.map((r) => `${r.method} ${r.url.replace('/api/v1/projects/:projectId', '')}`).sort()).toEqual([
      'DELETE /alert-maintenance-windows/:windowId', 'GET /alert-maintenance-windows', 'GET /alert-maintenance-windows/:windowId', 'PATCH /alert-maintenance-windows/:windowId', 'POST /alert-maintenance-windows',
    ]);
    expect(routes.every((r) => r.authenticated)).toBe(true);
    for (const r of routes) {
      const url = r.url.replace(':projectId', projectId).replace(/:\w+/g, crypto.randomUUID());
      expect((await h.app.inject({ method: r.method as 'GET', url })).statusCode, `${r.method} ${r.url}`).toBe(401);
    }
    const noCsrf = await h.app.inject({ method: 'POST', url: W(), headers: { cookie: owner.cookie, origin: h.cfg.webOrigin }, payload: body() });
    expect(noCsrf.statusCode).toBe(403);
    const spec = (h.app as unknown as { swagger(): { paths: Record<string, Record<string, { responses?: Record<string, unknown> }>> } }).swagger();
    const p = (path: string, m: string) => spec.paths[`/api/v1/projects/{projectId}/alert-maintenance-windows${path}`]?.[m];
    for (const [path, m, ok] of [['', 'get', '200'], ['', 'post', '201'], ['/{windowId}', 'get', '200'], ['/{windowId}', 'patch', '200'], ['/{windowId}', 'delete', '204']] as const) {
      expect(Object.keys(p(path, m)?.responses ?? {}), `${m} ${path}`).toContain(ok);
    }
  });
});

describe('RBAC', () => {
  test('everyone with access reads; only unrestricted project admins change windows; environment-restricted admins cannot', async () => {
    const w = (await owner.req('POST', W(), body({ name: 'rbac-window' }))).json;
    for (const c of [viewer, engineer, auditorRestricted]) {
      expect((await c.req('GET', W())).status).toBe(200);
      expect((await c.req('GET', `${W()}/${w.id}`)).status).toBe(200);
    }
    for (const c of [viewer, engineer]) {
      expect((await c.req('POST', W(), body())).status).toBe(403);
      expect((await c.req('PATCH', `${W()}/${w.id}`, { comment: 'x' })).status).toBe(403);
      expect((await c.req('DELETE', `${W()}/${w.id}`)).status).toBe(403);
    }
    // a project admin whose grant is limited to one environment: windows are project-wide, so management is refused
    for (const [m, u, b] of [['POST', W(), body()], ['PATCH', `${W()}/${w.id}`, { comment: 'x' }], ['DELETE', `${W()}/${w.id}`, undefined]] as const) {
      expect((await auditorRestricted.req(m, u, b)).status, `${m} ${u}`).toBe(403);
    }
    expect((await owner.req('GET', `${W()}/${w.id}`)).json.comment).toBe('planned');
  });
});

describe('CRUD with computed state', () => {
  test('create, read, list, edit, delete; recurring windows report their next occurrence, one-off windows their state', async () => {
    const created = await owner.req('POST', W(), body({ name: 'Weekly release', schedule: weekly({ weekdays: ['sat', 'sun'], timezone: 'America/New_York', startTime: '01:30', durationMinutes: 180 }), matchers: { severities: ['critical'] } }));
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ name: 'Weekly release', enabled: true, version: 1, matchers: { severities: ['critical'] }, schedule: { type: 'weekly', timezone: 'America/New_York', startTime: '01:30' } });
    expect(['active', 'scheduled']).toContain(created.json.state);
    const next = created.json.nextOccurrence;
    expect(Date.parse(next.startsAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(next.endsAt) - Date.parse(next.startsAt)).toBe(180 * 60_000);
    expect(JSON.stringify(created.json)).not.toMatch(/expireAt|orgId|nameLower/);

    const now = await owner.req('POST', W(), body({ name: 'Right now', schedule: once(-60_000, 3_600_000) }));
    expect(now.json).toMatchObject({ state: 'active', activeNow: true, currentOccurrence: { startsAt: expect.any(String) }, nextOccurrence: null });
    const later = await owner.req('POST', W(), body({ name: 'Tomorrow', schedule: once(86_400_000, 90_000_000) }));
    expect(later.json).toMatchObject({ state: 'scheduled', activeNow: false, currentOccurrence: null, nextOccurrence: { startsAt: expect.any(String) } });

    const list = (await viewer.req('GET', `${W()}?limit=100`)).json;
    expect(list.items.map((x: { name: string }) => x.name)).toEqual(expect.arrayContaining(['Weekly release', 'Right now', 'Tomorrow']));

    const patched = await owner.req('PATCH', `${W()}/${created.json.id}`, { enabled: false, comment: 'paused' });
    expect(patched.json).toMatchObject({ enabled: false, state: 'disabled', activeNow: false, nextOccurrence: null, comment: 'paused', version: 2 });
    const rescheduled = await owner.req('PATCH', `${W()}/${created.json.id}`, { enabled: true, schedule: weekly({ weekdays: ['mon'], startTime: '03:15', durationMinutes: 45 }) });
    expect(rescheduled.json).toMatchObject({ enabled: true, schedule: { weekdays: ['mon'], startTime: '03:15', durationMinutes: 45 }, version: 3 });

    expect((await owner.req('DELETE', `${W()}/${now.json.id}`)).status).toBe(204);
    expect((await owner.req('DELETE', `${W()}/${now.json.id}`)).status).toBe(404);
    expect((await owner.req('GET', `${W()}/${now.json.id}`)).status).toBe(404);
    expect((await owner.req('PATCH', `${W()}/${now.json.id}`, { comment: 'x' })).status).toBe(404);
  });

  test('invalid input is a 400 with details, a duplicate name or unknown reference a 409/422, never a 500', async () => {
    for (const b of [
      {}, body({ name: '' }), body({ schedule: weekly({ timezone: '+05:30' }) }), body({ schedule: weekly({ timezone: 'Nowhere/City' }) }), body({ schedule: weekly({ timezone: '' }) }),
      body({ schedule: weekly({ startTime: '24:00' }) }), body({ schedule: weekly({ startTime: '9:00' }) }), body({ schedule: weekly({ weekdays: [] }) }),
      body({ schedule: weekly({ weekdays: ['mon', 'mon'] }) }), body({ schedule: weekly({ weekdays: ['funday'] }) }), body({ schedule: weekly({ durationMinutes: 0 }) }),
      body({ schedule: weekly({ durationMinutes: 1441 }) }), body({ schedule: weekly({ durationMinutes: 'long' }) }), body({ schedule: { type: 'cron', expr: '* * * * *' } }),
      body({ schedule: { type: 'once', startsAt: new Date(Date.now() + 5000).toISOString(), endsAt: new Date(Date.now() + 1000).toISOString() } }),
      body({ schedule: once(0, 40 * 86_400_000) }), body({ extra: true }), body({ projectId: crypto.randomUUID() }), body({ matchers: { ruleIds: ['nope'] } }),
    ]) {
      const r = await owner.req('POST', W(), b);
      expect(r.status, JSON.stringify(b).slice(0, 120)).toBe(400);
      expect(r.json.error).toMatchObject({ code: 'validation_error' });
    }
    expect((await owner.req('PATCH', `${W()}/${crypto.randomUUID()}`, {})).status).toBe(400);
    const past = await owner.req('POST', W(), body({ schedule: once(-7_200_000, -3_600_000) }));
    expect(past.status).toBe(422);
    const dup = body({ name: 'dup-name' });
    expect((await owner.req('POST', W(), dup)).status).toBe(201);
    expect((await owner.req('POST', W(), { ...dup, name: 'DUP-NAME' })).status).toBe(409);
    expect((await owner.req('POST', W(), body({ matchers: { ruleIds: [crypto.randomUUID()] } }))).status).toBe(422);
    expect((await owner.req('POST', W(), body({ matchers: { environmentIds: [crypto.randomUUID()] } }))).status).toBe(422);
    expect((await owner.req('GET', `${W()}?limit=1000`)).status).toBe(400);
    expect((await owner.req('GET', `${W()}/not-a-uuid`)).status).toBe(400);
  });

  test('every change is an audit event written with the change; no secret-like data is involved', async () => {
    const w = (await owner.req('POST', W(), body({ name: 'audited' }))).json;
    await owner.req('PATCH', `${W()}/${w.id}`, { comment: 'changed' });
    await owner.req('DELETE', `${W()}/${w.id}`);
    const events = await h.db.c.auditEvents.find({ projectId, targetId: w.id }).sort({ seq: 1 }).toArray();
    expect(events.map((e) => e.action)).toEqual(['alert.maintenance.created', 'alert.maintenance.updated', 'alert.maintenance.deleted']);
    expect(events[1]!.metadata).toEqual({ name: 'audited', fields: ['comment'] });
    expect(events.every((e) => e.actorUserId === owner.userId && e.actorType === 'user')).toBe(true);
  });

  test('a project holds at most 20 windows (422 limit_reached); deleting one frees a place', async () => {
    const p = (await owner.req('POST', '/api/v1/projects', { name: 'Window limit project', environments: [{ name: 'Dev' }] })).json;
    const u = `/api/v1/projects/${p.id}/alert-maintenance-windows`;
    for (let i = 0; i < 20; i++) expect((await owner.req('POST', u, body({ name: `w${i}` }))).status).toBe(201);
    const over = await owner.req('POST', u, body({ name: 'w20' }));
    expect(over.status).toBe(422);
    expect(over.json.error.code).toBe('limit_reached');
    const first = (await owner.req('GET', `${u}?limit=1`)).json.items[0];
    expect((await owner.req('DELETE', `${u}/${first.id}`)).status).toBe(204);
    expect((await owner.req('POST', u, body({ name: 'w20' }))).status).toBe(201);
  });
});

describe('tenant isolation', () => {
  test('another organization and another project cannot see or change a window (404 everywhere)', async () => {
    const w = (await owner.req('POST', W(), body({ name: 'private' }))).json;
    for (const [m, u, b] of [
      ['GET', W()], ['POST', W(), body()], ['GET', `${W()}/${w.id}`], ['PATCH', `${W()}/${w.id}`, { comment: 'hijack' }], ['DELETE', `${W()}/${w.id}`],
    ] as const) expect((await globex.req(m, u, b)).status, `${m} ${u}`).toBe(404);
    const g = `/api/v1/projects/${gProject}/alert-maintenance-windows`;
    expect((await globex.req('GET', `${g}/${w.id}`)).status).toBe(404);
    expect((await globex.req('PATCH', `${g}/${w.id}`, { comment: 'x' })).status).toBe(404);
    expect((await globex.req('DELETE', `${g}/${w.id}`)).status).toBe(404);
    expect((await globex.req('GET', g)).json.items).toEqual([]);
    // a window of another project cannot be referenced either
    const gw = (await globex.req('POST', g, body({ name: 'globex-window' }))).json;
    expect((await owner.req('GET', `${W()}/${gw.id}`)).status).toBe(404);
    expect((await owner.req('GET', `${W()}/${w.id}`)).json.comment).toBe('planned');
  });
});

describe('effect on notifications', () => {
  test('an active window suppresses the webhook (delivery log names the window) but the incident is still opened; deleting the window ends it', async () => {
    const ch = (await owner.req('POST', `${base()}/alert-channels`, { type: 'webhook', name: 'maint-hook', url: 'https://93.184.216.34/hook', signingSecret: 'whsec_api-test-signing-secret-0123456789' })).json;
    const rule = (await owner.req('POST', `${base()}/alert-rules`, ruleBody({ channelIds: [ch.id] }))).json;
    const win = (await owner.req('POST', W(), body({ name: 'live window', schedule: once(-60_000, 3_600_000), matchers: { ruleIds: [rule.id] } }))).json;
    const inc = await openIncident(rule.id);
    const deliveries = (await viewer.req('GET', `${base()}/incidents/${inc._id}/deliveries`)).json;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ status: 'suppressed', maintenanceId: win.id, silenceId: null, channelName: 'maint-hook' });
    const detail = (await viewer.req('GET', `${base()}/incidents/${inc._id}`)).json;
    expect(detail.status).toBe('open');
    expect(detail.timeline.map((e: { type: string }) => e.type)).toEqual(['opened', 'notification_suppressed']);
    expect(detail.timeline[1].data).toMatchObject({ reason: 'maintenance', maintenanceId: win.id });
    expect(await h.db.c.alertDeliveries.countDocuments({ incidentId: inc._id, status: 'pending' })).toBe(0); // nothing is queued for sending

    await owner.req('DELETE', `${W()}/${win.id}`);
    await h.db.c.incidents.updateOne({ _id: inc._id }, { $set: { active: false, status: 'resolved' } }); // free the dedup slot for a second incident of the same rule
    const inc2 = await openIncident(rule.id);
    const d2 = (await viewer.req('GET', `${base()}/incidents/${inc2._id}/deliveries`)).json;
    expect(d2[0]).toMatchObject({ status: 'pending', maintenanceId: null });
  });
});

describe('replay-policy fields of a rule', () => {
  test('defaults, update without resetting state, validation, and the missed-evaluation status', async () => {
    const created = await owner.req('POST', `${base()}/alert-rules`, ruleBody({ name: 'replay-defaults' }));
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ missedPolicy: 'skip', maxReplayEvaluations: 5, staleNotificationSeconds: 900, missedEvaluations: { total: 0, replayed: 0, skipped: 0, lastAt: null } });
    const set = await owner.req('PATCH', `${base()}/alert-rules/${created.json.id}`, { missedPolicy: 'replay', maxReplayEvaluations: 20, staleNotificationSeconds: 600 });
    expect(set.json).toMatchObject({ missedPolicy: 'replay', maxReplayEvaluations: 20, staleNotificationSeconds: 600, version: 2 });
    for (const bad of [{ missedPolicy: 'catch-up' }, { maxReplayEvaluations: 21 }, { maxReplayEvaluations: 0 }, { maxReplayEvaluations: 2.5 }, { staleNotificationSeconds: -1 }, { staleNotificationSeconds: 90_000 }]) {
      expect((await owner.req('PATCH', `${base()}/alert-rules/${created.json.id}`, bad)).status, JSON.stringify(bad)).toBe(400);
      expect((await owner.req('POST', `${base()}/alert-rules`, ruleBody({ ...bad }))).status, JSON.stringify(bad)).toBe(400);
    }
    for (const c of [viewer, engineer]) expect((await c.req('PATCH', `${base()}/alert-rules/${created.json.id}`, { missedPolicy: 'skip' })).status).toBe(403);
    // the status the UI shows is written by the worker: counters and a missing field on an old document
    await h.db.c.alertConfig.updateOne({ _id: created.json.id }, { $set: { missed: { total: 9, replayed: 5, skipped: 4, lastAt: new Date('2026-11-04T10:00:00Z') } } });
    expect((await viewer.req('GET', `${base()}/alert-rules/${created.json.id}`)).json.missedEvaluations).toEqual({ total: 9, replayed: 5, skipped: 4, lastAt: '2026-11-04T10:00:00.000Z' });
    await h.db.c.alertConfig.updateOne({ _id: created.json.id }, { $unset: { missed: '', missedPolicy: '', maxReplayEvaluations: '', staleNotificationSeconds: '' } });
    expect((await viewer.req('GET', `${base()}/alert-rules/${created.json.id}`)).json).toMatchObject({ missedPolicy: 'skip', maxReplayEvaluations: 5, staleNotificationSeconds: 900, missedEvaluations: { total: 0, lastAt: null } });
  });
});
