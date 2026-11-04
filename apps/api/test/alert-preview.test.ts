import type { MetricStore } from '@nexus/metricstore';
import { startTestMongo } from '@nexus/database/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { harness, type Client, type Harness } from './helpers.js';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let h: Harness;
let owner: Client, engineer: Client, viewer: Client, devAdmin: Client, globex: Client;
let projectId: string, devEnv: string, prodEnv: string, gEnv: string;
const scopesSeen: { orgId: string; projectId: string; environmentIds: string[] }[] = [];
let queryFails = false;

/** A metric store that breaches (50) between 60 and 120 minutes ago and is quiet otherwise; it only ever READS. */
const metricStore = {
  async query(scope: (typeof scopesSeen)[number], q: { to: string }) {
    scopesSeen.push(scope);
    if (queryFails) throw Object.assign(new Error('unsupported_aggregation: not available for this metric'), { code: 'unsupported_aggregation' });
    const agoMin = (Date.now() - Date.parse(q.to)) / 60_000;
    return { metric: 'http.errors', type: 'gauge', unit: null, agg: 'max', stepMs: 60_000, from: q.to, to: q.to, truncated: false, notes: [],
      series: [{ labels: {}, points: [{ t: 0, v: agoMin >= 60 && agoMin < 120 ? 50 : 1 }], exemplars: [] }] };
  },
} as unknown as MetricStore;

const base = () => `/api/v1/projects/${projectId}`;
const preview = (over: Record<string, unknown> = {}, rule: Record<string, unknown> = {}) => ({
  rule: {
    environmentId: devEnv, query: { kind: 'metric', metric: 'http.errors', agg: 'max' }, condition: { op: 'gt', threshold: 10 },
    windowSeconds: 300, forSeconds: 300, resolveAfterSeconds: 120, intervalSeconds: 60, noDataPolicy: 'keep', ...rule,
  },
  rangeSeconds: 10_800, ...over,
});
const counts = async () => ({
  config: await h.db.c.alertConfig.countDocuments({}), incidents: await h.db.c.incidents.countDocuments({}), deliveries: await h.db.c.alertDeliveries.countDocuments({}),
  audit: await h.db.c.auditEvents.countDocuments({}), counters: await h.db.c.counters.countDocuments({}),
});

beforeAll(async () => {
  mongo = await startTestMongo();
  h = await harness(mongo.uri, {}, { metricStore });
  [owner, engineer, viewer, devAdmin, globex] = await Promise.all([
    h.login('owner@acme.test'), h.login('engineer@acme.test'), h.login('viewer@acme.test'), h.login('auditor@acme.test'), h.login('owner@globex.test'),
  ]);
  const p = (await owner.req('POST', '/api/v1/projects', { name: 'Preview project', environments: [{ name: 'Dev' }, { name: 'Prod', isProduction: true }] })).json;
  projectId = p.id; devEnv = p.environments[0].id; prodEnv = p.environments[1].id;
  await owner.req('PUT', `${base()}/members/${engineer.userId}`, { role: 'engineer' });
  await owner.req('PUT', `${base()}/members/${viewer.userId}`, { role: 'viewer' });
  expect((await owner.req('PUT', `${base()}/members/${devAdmin.userId}`, { role: 'project_admin', environmentIds: [devEnv] })).status).toBeLessThan(300);
  gEnv = (await globex.req('POST', '/api/v1/projects', { name: 'Globex project', environments: [{ name: 'Dev' }] })).json.environments[0].id;
}, 300_000);

afterAll(async () => { await h?.app.close(); await h?.db.close(); await mongo?.stop(); });

describe('POST /alert-rules/preview', () => {
  test('a project admin gets the replay: series, would-fire periods and the count of incidents, read-only and scoped to the rule environment', async () => {
    scopesSeen.length = 0;
    const before = await counts();
    const res = await owner.req('POST', `${base()}/alert-rules/preview`, preview());
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/json');
    const r = res.json;
    expect(r.rangeSeconds).toBe(10_800);
    expect(r.stepSeconds).toBe(60);
    expect(r.times).toHaveLength(181);
    expect(r.totals).toMatchObject({ wouldOpenIncidents: 1, groupsThatWouldFire: 1, skippedPoints: 0, evaluatedPoints: 181 });
    expect(r.groups).toHaveLength(1);
    expect(r.groups[0].periods.map((p: { kind: string }) => p.kind)).toEqual(['pending', 'firing']);
    expect(r.groups[0].periods[1].ongoing).toBe(false);
    expect(r.condition).toEqual({ op: 'gt', threshold: 10 });
    expect(r.notes.join(' ')).toContain('starts from "ok"');
    expect(r.partial).toBe(false);
    // scoped to the session's org and project and the rule's environment, nothing else
    expect(scopesSeen.length).toBeGreaterThan(100);
    for (const s of scopesSeen) expect(s).toEqual({ orgId: expect.any(String), projectId, environmentIds: [devEnv] });
    // nothing was written: no rule, incident, delivery, counter or audit event
    expect(await counts()).toEqual(before);
    expect(res.headers['cache-control'] ?? '').not.toContain('public');
  });

  test('log-count rules preview through the real log store (an empty store counts zero, which is a value, not "no data")', async () => {
    const res = await owner.req('POST', `${base()}/alert-rules/preview`, preview({ rangeSeconds: 600 }, { query: { kind: 'logs', errorsOnly: true }, condition: { op: 'gt', threshold: 5 } }));
    expect(res.status).toBe(200);
    expect(res.json.groups[0].values.every((v: number | null) => v === 0)).toBe(true);
    expect(res.json.totals).toMatchObject({ wouldOpenIncidents: 0, noDataPoints: 0 });
  });

  test('the same RBAC as rule create: engineers and viewers get 403, outsiders and anonymous callers are refused', async () => {
    for (const c of [engineer, viewer]) expect((await c.req('POST', `${base()}/alert-rules/preview`, preview())).status).toBe(403);
    expect((await globex.req('POST', `${base()}/alert-rules/preview`, preview())).status).toBe(404);
    const anon = await h.app.inject({ method: 'POST', url: `${base()}/alert-rules/preview`, payload: preview() });
    expect(anon.statusCode).toBe(401);
    const noCsrf = await h.app.inject({ method: 'POST', url: `${base()}/alert-rules/preview`, headers: { cookie: owner.cookie, origin: h.cfg.webOrigin }, payload: preview() });
    expect(noCsrf.statusCode).toBe(403);
  });

  test('an environment-restricted admin can preview inside their environments only; other, foreign or unknown environments are 404 and read nothing', async () => {
    scopesSeen.length = 0;
    expect((await devAdmin.req('POST', `${base()}/alert-rules/preview`, preview({ rangeSeconds: 600 }))).status).toBe(200);
    scopesSeen.length = 0;
    for (const env of [prodEnv, gEnv, crypto.randomUUID()]) {
      const res = await devAdmin.req('POST', `${base()}/alert-rules/preview`, preview({ rangeSeconds: 600 }, { environmentId: env }));
      expect(res.status, env).toBe(404);
    }
    expect(scopesSeen).toEqual([]);
    // the unrestricted admin may use the other environment, but not another tenant's
    expect((await owner.req('POST', `${base()}/alert-rules/preview`, preview({ rangeSeconds: 600 }, { environmentId: prodEnv }))).status).toBe(200);
    expect((await owner.req('POST', `${base()}/alert-rules/preview`, preview({ rangeSeconds: 600 }, { environmentId: gEnv }))).status).toBe(404);
    expect(scopesSeen.every((s) => s.projectId === projectId && s.environmentIds.length === 1)).toBe(true);
  });

  test.each([
    ['range below the minimum', { rangeSeconds: 60 }], ['range above 24 h', { rangeSeconds: 86_401 }], ['negative range', { rangeSeconds: -5 }], ['fractional range', { rangeSeconds: 600.5 }],
    ['range as text', { rangeSeconds: '3600' }], ['explicit from/to are not accepted', { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' }],
    ['another project id in the body', { projectId: crypto.randomUUID() }],
  ])('invalid range or body: %s -> 400', async (_n, over) => {
    const res = await (await h.login('owner@acme.test')).req('POST', `${base()}/alert-rules/preview`, preview(over));
    expect(res.status).toBe(400);
    expect(res.json.error.code).toBe('validation_error');
  });

  test('an invalid rule is 400 with the same validation as create (percentile, fractional log threshold, name field)', async () => {
    const o = await h.login('owner@acme.test');
    for (const rule of [
      { query: { kind: 'metric', metric: 'm', agg: 'p95' } }, { query: { kind: 'logs' }, condition: { op: 'gt', threshold: 1.5 } }, { name: 'x' }, { windowSeconds: 60, intervalSeconds: 600 },
    ]) expect((await o.req('POST', `${base()}/alert-rules/preview`, preview({}, rule))).status, JSON.stringify(rule)).toBe(400);
  });

  test('a query the store refuses is reported once as a 422 with the reason (never a 500, never "ok")', async () => {
    queryFails = true;
    try {
      const res = await (await h.login('owner@acme.test')).req('POST', `${base()}/alert-rules/preview`, preview({ rangeSeconds: 600 }));
      expect(res.status).toBe(422);
      expect(res.json.error.code).toBe('preview_failed');
      expect(res.json.error.message).toContain('unsupported_aggregation');
    } finally { queryFails = false; }
  });

  test('the route is in the OpenAPI document and rate-limited per session (10 per minute)', async () => {
    const route = h.app.routeTable.find((r) => r.url.endsWith('/alert-rules/preview') && r.method === 'POST');
    expect(route?.authenticated).toBe(true);
    const fresh = await h.login('owner@acme.test'); // a new session has its own bucket
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) statuses.push((await fresh.req('POST', `${base()}/alert-rules/preview`, preview({ rangeSeconds: 300 }))).status);
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
  });
});
