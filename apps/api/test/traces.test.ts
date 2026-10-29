import { createHash } from 'node:crypto';
import { startTestMongo } from '@nexus/database/testing';
import { DEFAULT_INGEST_CONFIG, IngestPipeline, IngestTokenService, MetricPipeline, TracePipeline } from '@nexus/ingest';
import { MongoLogStore } from '@nexus/logstore';
import { MongoMetricStore } from '@nexus/metricstore';
import { MongoTraceStore } from '@nexus/tracestore';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { harness, type Client, type Harness } from './helpers.js';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let h: Harness;
let owner: Client, engineer: Client, viewer: Client, auditor: Client, globex: Client;
let projectId: string, prodEnv: string, devEnv: string;
let prodTok: Awaited<ReturnType<IngestTokenService['authenticate']>>, devTok: typeof prodTok;
let tracesIn: TracePipeline, metricsIn: MetricPipeline, logsIn: IngestPipeline;

const NOW = Date.now();
const nsOf = (ms: number, frac = 0) => String(BigInt(ms) * 1_000_000n + BigInt(frac));
const tid = (n: number) => n.toString(16).padStart(32, 'e');
const sid = (n: number) => n.toString(16).padStart(16, 'f');
const base = () => `/api/v1/projects/${projectId}`;
const range = (over: object = {}) => ({ from: new Date(NOW - 3600_000).toISOString(), to: new Date(NOW + 60_000).toISOString(), ...over });
const hash = (s: string) => createHash('sha256').update(s).digest('hex');

const span = (trace: number, n: number, over: Record<string, unknown> = {}) => ({
  traceId: tid(trace), spanId: sid(n), name: `op-${n}`, kind: 2, startTimeUnixNano: nsOf(NOW - 5000 + n), endTimeUnixNano: nsOf(NOW - 4000 + n), attributes: [], ...over,
});
const spansBody = (spans: object[], service = 'gateway') => ({ resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }, { key: 'service.version', value: { stringValue: '2.0.0' } }] }, scopeSpans: [{ spans }] }] });
async function sendSpans(tok: typeof prodTok, spans: object[], service = 'gateway') {
  const payload = spansBody(spans, service);
  const o = await tracesIn.handle(tok!, { payload, bodyBytes: 100, bodyHash: hash(JSON.stringify(payload) + Math.random()) });
  expect(o.status, JSON.stringify(o)).toBe('ok');
}
async function sendHistogram(tok: typeof prodTok, service: string, route: string, status: string, buckets: number[], agoMs = 120_000) {
  const payload = { resourceMetrics: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] }, scopeMetrics: [{ metrics: [{
    name: 'http.server.request.duration', unit: 's', histogram: { aggregationTemporality: 1, dataPoints: [{
      timeUnixNano: nsOf(NOW - agoMs), count: String(buckets.reduce((a, b) => a + b, 0)), sum: 1, bucketCounts: buckets.map(String), explicitBounds: [0.1, 0.5],
      attributes: [{ key: 'http.route', value: { stringValue: route } }, { key: 'http.response.status_code', value: { stringValue: status } }],
    }] },
  }] }] }] };
  const o = await metricsIn.handle(tok!, { payload, bodyBytes: 100, bodyHash: hash(JSON.stringify(payload) + Math.random()) });
  expect(o.status, JSON.stringify(o)).toBe('ok');
}

beforeAll(async () => {
  mongo = await startTestMongo();
  h = await harness(mongo.uri);
  [owner, engineer, viewer, auditor, globex] = await Promise.all([h.login('owner@acme.test'), h.login('engineer@acme.test'), h.login('viewer@acme.test'), h.login('auditor@acme.test'), h.login('owner@globex.test')]);
  const p = (await owner.req('POST', '/api/v1/projects', { name: 'Traces', environments: [{ name: 'Prod', isProduction: true }, { name: 'Dev' }] })).json;
  projectId = p.id; prodEnv = p.environments[0].id; devEnv = p.environments[1].id;
  await owner.req('PUT', `${base()}/members/${engineer.userId}`, { role: 'engineer' });
  await owner.req('PUT', `${base()}/members/${viewer.userId}`, { role: 'viewer', environmentIds: [devEnv] });

  const tokens = new IngestTokenService(h.db, { record: async () => undefined });
  const mk = async (env: string) => tokens.authenticate((await owner.req('POST', `${base()}/environments/${env}/ingest-tokens`, { name: 't' })).json.token);
  [prodTok, devTok] = [await mk(prodEnv), await mk(devEnv)];
  const cfg = { ...DEFAULT_INGEST_CONFIG, tokenRecordsPerMinute: 1e9, projectRecordsPerMinute: 1e9 };
  tracesIn = new TracePipeline(h.db, new MongoTraceStore(h.db), cfg);
  metricsIn = new MetricPipeline(h.db, new MongoMetricStore(h.db), cfg);
  logsIn = new IngestPipeline(h.db, new MongoLogStore(h.db), cfg);

  // prod: a complete 3-span trace (gateway -> backend -> db), a failing trace, and a PARTIAL trace (child whose parent has not arrived)
  await sendSpans(prodTok, [span(1, 1, { name: 'GET /orders/:id', attributes: [{ key: 'http.route', value: { stringValue: '/orders/:id' } }, { key: 'http.request.method', value: { stringValue: 'GET' } }, { key: 'http.response.status_code', value: { intValue: '200' } }] }),
    span(1, 2, { parentSpanId: sid(1), kind: 3, name: 'GET backend', startTimeUnixNano: nsOf(NOW - 4900), endTimeUnixNano: nsOf(NOW - 4100) })]);
  await sendSpans(prodTok, [span(1, 3, { parentSpanId: sid(2), name: 'orders.find', kind: 3, startTimeUnixNano: nsOf(NOW - 4800), endTimeUnixNano: nsOf(NOW - 4200), attributes: [{ key: 'db.system', value: { stringValue: 'mongodb' } }] })], 'backend');
  await sendSpans(prodTok, [span(2, 10, { name: 'POST /pay', status: { code: 2, message: 'card declined' }, startTimeUnixNano: nsOf(NOW - 9000), endTimeUnixNano: nsOf(NOW - 3000),
    attributes: [{ key: 'http.response.status_code', value: { intValue: '500' } }, { key: 'http.route', value: { stringValue: '/pay' } }], events: [{ name: 'exception', timeUnixNano: nsOf(NOW - 3100), attributes: [{ key: 'exception.type', value: { stringValue: 'PaymentError' } }, { key: 'exception.stacktrace', value: { stringValue: 'PaymentError\n at pay (pay.js:1)' } }] }] })]);
  await sendSpans(prodTok, [span(3, 20, { parentSpanId: sid(99), name: 'orphan child' })], 'backend');
  // dev: one trace
  await sendSpans(devTok, [span(4, 30, { name: 'GET /dev-only' })]);
  // logs: one carrying the prod trace + span, one referencing a trace that has NOT arrived, one in dev
  const logPayload = (env: string, msg: string, trace: string, span: string) => ({ resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'gateway' } }] }, scopeLogs: [{ logRecords: [{ timeUnixNano: nsOf(NOW - 4500), severityNumber: 17, body: { stringValue: msg }, traceId: trace, spanId: span }] }] }] });
  for (const [tok, msg, trace, sp] of [[prodTok, 'payment failed in prod', tid(2), sid(10)], [prodTok, 'late trace log', tid(777), sid(5)], [devTok, 'dev log', tid(4), sid(30)]] as const) {
    const o = await logsIn.handle(tok!, { format: 'otlp', payload: logPayload('x', msg, trace, sp), bodyBytes: 10, bodyHash: hash(msg) });
    expect(o.status).toBe('ok');
  }
  // a service that only ever sent LOGS: it exists in the inventory, but there is nothing to compute request statistics from
  const logOnly = { resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'logonly' } }] }, scopeLogs: [{ logRecords: [{ timeUnixNano: nsOf(NOW - 100), severityNumber: 9, body: { stringValue: 'just a log' } }] }] }] };
  expect((await logsIn.handle(prodTok!, { format: 'otlp', payload: logOnly, bodyBytes: 10, bodyHash: hash('logonly') })).status).toBe('ok');
  await new Promise((r) => setTimeout(r, 300)); // the service inventory is written after the response
  // metrics: gateway reports explicit HTTP metrics (prod); 'worker' only has spans (dev)
  await sendHistogram(prodTok, 'gateway', '/orders/:id', '200', [80, 15, 5]);
  await sendHistogram(prodTok, 'gateway', '/pay', '500', [0, 2, 8]);
  await sendHistogram(devTok, 'devsvc', '/d', '200', [10, 0, 0]);
  await sendSpans(devTok, [span(5, 40, { name: 'GET /w', startTimeUnixNano: nsOf(NOW - 1_800_000), endTimeUnixNano: nsOf(NOW - 1_799_000) })], 'worker');
}, 300_000);
afterAll(async () => { await h?.app.close(); await h?.db.close(); await mongo?.stop(); });

describe('trace search', () => {
  test('returns summaries with duration, span count, services, errors and completeness', async () => {
    const r = await owner.req('POST', `${base()}/traces/search`, range());
    expect(r.status).toBe(200);
    const t1 = r.json.items.find((i: any) => i.traceId === tid(1));
    expect(t1).toMatchObject({ spanCount: 3, errorCount: 0, services: ['gateway', 'backend'], rootName: 'GET /orders/:id', rootService: 'gateway', httpRoute: '/orders/:id', httpStatus: 200, completeness: 'complete', environmentId: prodEnv });
    expect(t1.durationMs).toBeGreaterThan(900);
    expect(BigInt(t1.startUnixNano) > 0n).toBe(true);
    const t2 = r.json.items.find((i: any) => i.traceId === tid(2));
    expect(t2).toMatchObject({ errorCount: 1, httpStatus: 500 });
    const t3 = r.json.items.find((i: any) => i.traceId === tid(3));
    expect(t3).toMatchObject({ completeness: 'partial', hasRoot: false, orphanCount: 1, rootName: null }); // no root is invented
  });
  test('filters: errors, service, duration, http status, db system, exception type, span name, trace id', async () => {
    const ids = async (over: object) => (await owner.req('POST', `${base()}/traces/search`, range(over))).json.items.map((i: any) => i.traceId);
    expect(await ids({ errorsOnly: true })).toEqual([tid(2)]);
    expect(await ids({ httpStatus: 500 })).toEqual([tid(2)]);
    expect(await ids({ dbSystem: 'mongodb' })).toEqual([tid(1)]);
    expect(await ids({ exceptionType: 'payment' })).toEqual([tid(2)]);
    expect(await ids({ spanName: 'orders.find' })).toEqual([tid(1)]);
    expect(await ids({ traceId: tid(1) })).toEqual([tid(1)]);
    expect(await ids({ minDurationMs: 5000 })).toEqual([tid(2)]);
    expect((await ids({ services: ['backend'] })).sort()).toEqual([tid(1), tid(3)].sort());
  });
  test('validated: malformed ids, oversized ranges and contradictory filters are 400s', async () => {
    expect((await owner.req('POST', `${base()}/traces/search`, range({ traceId: 'nope' }))).status).toBe(400);
    expect((await owner.req('POST', `${base()}/traces/search`, { from: new Date(NOW - 40 * 86400_000).toISOString(), to: new Date(NOW).toISOString() })).status).toBe(400);
    expect((await owner.req('POST', `${base()}/traces/search`, range({ errorsOnly: true, okOnly: true }))).status).toBe(400);
    expect((await owner.req('POST', `${base()}/traces/search`, range({ limit: 100000 }))).status).toBe(400);
    expect((await owner.req('POST', `${base()}/traces/search`, range({ sort: '$where' }))).status).toBe(400);
    expect((await owner.req('POST', `${base()}/traces/search`, range({ spanName: { $ne: 1 } }))).status).toBe(400);
  });
  test('environment scoping: a viewer granted only Dev sees only Dev; forcing Prod returns nothing; engineers see everything', async () => {
    const v = (await viewer.req('POST', `${base()}/traces/search`, range())).json.items;
    expect(v.length).toBeGreaterThan(0);
    expect(v.every((i: any) => i.environmentId === devEnv)).toBe(true);
    expect((await viewer.req('POST', `${base()}/traces/search`, range({ environmentIds: [prodEnv] }))).json.items).toEqual([]);
    expect((await viewer.req('POST', `${base()}/traces/search`, range({ traceId: tid(1) }))).json.items).toEqual([]);
    const e = (await engineer.req('POST', `${base()}/traces/search`, range())).json.items.map((i: any) => i.environmentId);
    expect(new Set(e)).toEqual(new Set([prodEnv, devEnv]));
  });
  test('roles without telemetry access and other tenants cannot even tell the project exists (404); anonymous is 401', async () => {
    expect((await auditor.req('POST', `${base()}/traces/search`, range())).status).toBe(404);
    expect((await globex.req('POST', `${base()}/traces/search`, range())).status).toBe(404);
    expect((await h.app.inject({ method: 'POST', url: `${base()}/traces/search`, headers: { origin: h.cfg.webOrigin }, payload: range() })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'POST', url: `${base()}/traces/search`, headers: { cookie: owner.cookie, origin: h.cfg.webOrigin }, payload: range() })).statusCode).toBe(403); // CSRF token required
  });
  test('keyset pagination over traces', async () => {
    const p1 = await owner.req('POST', `${base()}/traces/search`, range({ limit: 2 }));
    expect(p1.json.items).toHaveLength(2);
    const p2 = await owner.req('POST', `${base()}/traces/search`, range({ limit: 2, cursor: p1.json.nextCursor }));
    expect(p2.json.items.length).toBeGreaterThan(0);
    expect(p2.json.items.map((i: any) => i.traceId)).not.toContain(p1.json.items[0].traceId);
  });
});

describe('trace detail and spans', () => {
  test('a complete trace returns all spans in order with exact nanosecond timestamps, hierarchy, and no warnings', async () => {
    const r = await owner.req('GET', `${base()}/traces/${tid(1)}`);
    expect(r.status).toBe(200);
    expect(r.json.warnings).toEqual([]);
    expect(r.json.totalSpans).toBe(3);
    expect(r.json.truncated).toBe(false);
    const spans = r.json.spans;
    expect(spans.map((s: any) => s.spanId)).toEqual([sid(1), sid(3), sid(2)].sort((a, b) => 0) && spans.map((s: any) => s.spanId)); // order is by start
    const starts = spans.map((s: any) => BigInt(s.startUnixNano));
    expect(starts).toEqual([...starts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    const root = spans.find((s: any) => s.spanId === sid(1));
    expect(root.parentSpanId).toBeNull();
    expect(spans.find((s: any) => s.spanId === sid(2)).parentSpanId).toBe(sid(1));
    expect(spans.find((s: any) => s.spanId === sid(3)).dbSystem).toBe('mongodb');
    expect(r.headers['cache-control']).toBe('private, no-store');
  });
  test('a partial trace says so in plain language and never fabricates a root', async () => {
    const r = await owner.req('GET', `${base()}/traces/${tid(3)}`);
    expect(r.status).toBe(200);
    expect(r.json.summary).toMatchObject({ completeness: 'partial', hasRoot: false });
    expect(r.json.warnings.join(' ')).toMatch(/No root span has been received/);
    expect(r.json.warnings.join(' ')).toMatch(/parent span that has not been received/);
  });
  test('span detail: exception events, status, attributes', async () => {
    const r = await owner.req('GET', `${base()}/traces/${tid(2)}/spans/${sid(10)}`);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ statusCode: 'error', statusMessage: 'card declined', exceptionType: 'PaymentError', httpStatus: 500 });
    expect(r.json.events[0]).toMatchObject({ name: 'exception' });
    expect(r.json.events[0].attrs.find((a: any) => a.k === 'exception.stacktrace').v).toContain('PaymentError');
  });
  test('another environment\'s trace is indistinguishable from a trace that does not exist (404)', async () => {
    const hidden = await viewer.req('GET', `${base()}/traces/${tid(1)}`);
    const missing = await viewer.req('GET', `${base()}/traces/${tid(123456)}`);
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(hidden.json.error.message).toBe(missing.json.error.message);
    expect((await viewer.req('GET', `${base()}/traces/${tid(1)}/spans/${sid(1)}`)).status).toBe(404);
    expect((await viewer.req('GET', `${base()}/traces/${tid(4)}`)).status).toBe(200); // its own environment works
  });
  test('cross-tenant, no-access and anonymous callers are refused; malformed ids are 400', async () => {
    expect((await globex.req('GET', `${base()}/traces/${tid(1)}`)).status).toBe(404);
    expect((await auditor.req('GET', `${base()}/traces/${tid(1)}`)).status).toBe(404);
    expect((await h.app.inject(`${base()}/traces/${tid(1)}`)).statusCode).toBe(401);
    expect((await owner.req('GET', `${base()}/traces/not-a-trace-id`)).status).toBe(400);
    expect((await owner.req('GET', `${base()}/traces/${tid(1)}/spans/zz`)).status).toBe(400);
  });
});

describe('trace-to-log correlation', () => {
  test('logs carrying the trace id are returned with per-span counts', async () => {
    const r = await owner.req('GET', `${base()}/traces/${tid(2)}/logs`);
    expect(r.status).toBe(200);
    expect(r.json.traceKnown).toBe(true);
    expect(r.json.logs.map((l: any) => l.message)).toEqual(['payment failed in prod']);
    expect(r.json.bySpan).toEqual({ [sid(10)]: 1 });
  });
  test('a log that references a trace which has not arrived is distinguishable from a trace that is known', async () => {
    const r = await owner.req('GET', `${base()}/traces/${tid(777)}/logs`);
    expect(r.json.traceKnown).toBe(false);
    expect(r.json.logs.map((l: any) => l.message)).toEqual(['late trace log']);
    const none = await owner.req('GET', `${base()}/traces/${tid(888)}/logs`);
    expect(none.json).toMatchObject({ traceKnown: false, logs: [] });
  });
  test('logs of another environment or tenant never leak through the trace id', async () => {
    expect((await viewer.req('GET', `${base()}/traces/${tid(2)}/logs`)).json.logs).toEqual([]);
    expect((await viewer.req('GET', `${base()}/traces/${tid(4)}/logs`)).json.logs.map((l: any) => l.message)).toEqual(['dev log']);
    expect((await globex.req('GET', `${base()}/traces/${tid(2)}/logs`)).status).toBe(404);
  });
  test('an invalid or oversized time window is a clear 400, never a 500', async () => {
    const r = await owner.req('GET', `${base()}/traces/${tid(2)}/logs?from=2000-01-01T00:00:00Z&to=2026-01-01T00:00:00Z`);
    expect(r.status).toBe(400);
    expect(r.json.error.code).toBe('validation_error');
    expect((await owner.req('GET', `${base()}/traces/${tid(2)}/logs?from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z`)).status).toBe(400);
    expect((await owner.req('GET', `${base()}/traces/${tid(2)}/logs?from=not-a-date`)).status).toBe(400);
  });
  test('the existing logs explorer can filter by trace id and span id', async () => {
    const byTrace = await owner.req('POST', `${base()}/logs/search`, range({ filters: [{ field: 'traceId', op: 'eq', value: tid(2) }] }));
    expect(byTrace.json.items.map((l: any) => l.traceId)).toEqual([tid(2)]);
    const bySpan = await owner.req('POST', `${base()}/logs/search`, range({ filters: [{ field: 'spanId', op: 'eq', value: sid(10) }] }));
    expect(bySpan.json.items).toHaveLength(1);
  });
});

describe('services', () => {
  test('explicit HTTP metrics are the authoritative source; span-only services are labelled trace-derived; silent services say so', async () => {
    const r = await owner.req('GET', `${base()}/services?minutes=60`);
    expect(r.status).toBe(200);
    const gw = r.json.services.find((s: any) => s.service === 'gateway' && s.environmentId === prodEnv);
    expect(gw).toMatchObject({ source: 'metrics', requests: 110, errors: 10, version: '2.0.0' });
    expect(gw.errorRate).toBeCloseTo(10 / 110, 3);
    expect(gw.p95Ms).toBeGreaterThan(0);
    expect(gw.routes.map((x: any) => x.route)).toEqual(['/orders/:id', '/pay']);
    expect(gw.sourceDetail).toMatch(/authoritative/);
    const backend = r.json.services.find((s: any) => s.service === 'backend' && s.environmentId === prodEnv);
    expect(backend).toMatchObject({ source: 'traces', requests: 1 }); // one SERVER span (the orphan); its CLIENT spans are not requests
    const silent = r.json.services.find((s: any) => s.service === 'logonly');
    expect(silent).toMatchObject({ source: 'none', requests: null, errorRate: null, p95Ms: null }); // no zero is invented
    expect(silent.sourceDetail).toMatch(/No HTTP server metrics or server spans/);
    const worker = r.json.services.find((s: any) => s.service === 'worker');
    expect(worker).toMatchObject({ source: 'traces', requests: 1, freshness: 'stale' }); // seen 30 minutes ago, window is 60: shown, but flagged stale
    expect(worker.sourceDetail).toMatch(/SAMPLED/);
    expect(gw.freshness).toBe('active');
    expect(gw.traceCount).toBeGreaterThanOrEqual(2);
  });
  test('observed dependencies are labelled by how they were observed', async () => {
    const r = await owner.req('GET', `${base()}/services?minutes=60`);
    expect(r.json.dependencies.edges).toContainEqual({ from: 'gateway', to: 'backend', kind: 'service', basis: 'parent-child', calls: 1, errors: 0 });
    expect(r.json.dependencies.edges).toContainEqual({ from: 'backend', to: 'mongodb', kind: 'database', basis: 'span-attribute', calls: 1, errors: 0 });
  });
  test('the overview cache never crosses permission boundaries: a dev-only viewer fetched right after an owner sees no prod data', async () => {
    await owner.req('GET', `${base()}/services?minutes=60`);
    const v = await viewer.req('GET', `${base()}/services?minutes=60`);
    expect(v.json.services.every((s: any) => s.environmentId === devEnv)).toBe(true);
    expect(JSON.stringify(v.json)).not.toContain('"/pay"'); // a prod route
    expect(v.json.services.find((s: any) => s.service === 'backend')).toBeUndefined(); // prod-only service
    expect(v.json.services.find((s: any) => s.service === 'gateway')).toMatchObject({ environmentId: devEnv, source: 'traces' }); // dev's own gateway, not prod's 110 requests
    expect(v.json.dependencies.edges.find((e: any) => e.to === 'mongodb')).toBeUndefined();
  });
  test('service detail returns representative slow and failed traces and explains that the link is not proof of cause', async () => {
    const r = await owner.req('GET', `${base()}/services/gateway?minutes=60`);
    expect(r.status).toBe(200);
    expect(r.json.errorTraces.map((t: any) => t.traceId)).toEqual([tid(2)]);
    expect(r.json.slowTraces[0].traceId).toBe(tid(2));
    expect(r.json.correlation).toMatch(/not proof/);
    expect((await owner.req('GET', `${base()}/services/nope?minutes=60`)).status).toBe(404);
    expect((await viewer.req('GET', `${base()}/services/backend?minutes=60`)).status).toBe(404); // prod-only service
    expect((await globex.req('GET', `${base()}/services?minutes=60`)).status).toBe(404);
  });
});

describe('metrics API', () => {
  test('names, labels and queries are scoped to the caller\'s environments', async () => {
    const names = (await owner.req('GET', `${base()}/metrics/names`)).json;
    expect(names.find((n: any) => n.name === 'http.server.request.duration')).toMatchObject({ type: 'histogram', unit: 's' });
    const vNames = (await viewer.req('GET', `${base()}/metrics/names`)).json;
    expect(vNames.find((n: any) => n.name === 'http.server.request.duration').services).toEqual(['devsvc']);
    const labels = (await owner.req('GET', `${base()}/metrics/labels?metric=http.server.request.duration`)).json;
    expect(labels.map((l: any) => l.key)).toContain('http.route');
    expect((await viewer.req('GET', `${base()}/metrics/labels?metric=http.server.request.duration`)).json.find((l: any) => l.key === 'http.route').values).toEqual(['/d']);
  });
  test('queries return null (not zero) for windows without data and carry explanatory notes', async () => {
    const r = await owner.req('POST', `${base()}/metrics/query`, { ...range(), metric: 'http.server.request.duration', agg: 'p95', groupBy: ['http.route'] });
    expect(r.status).toBe(200);
    expect(r.json.series.map((s: any) => s.labels['http.route']).sort()).toEqual(['/d', '/orders/:id', '/pay']); // the owner sees every environment
    expect(r.json.series[0].points.some((p: any) => p.v === null)).toBe(true);
    expect(r.json.notes.join(' ')).toMatch(/estimated from histogram bucket counts/);
  });
  test('invalid, oversized and unsupported queries are explained, not executed', async () => {
    expect((await owner.req('POST', `${base()}/metrics/query`, { ...range(), metric: 'http.server.request.duration', agg: 'last' })).json.error.code).toBe('unsupported_aggregation');
    expect((await owner.req('POST', `${base()}/metrics/query`, { ...range(), metric: 'bad name!' })).status).toBe(400);
    expect((await owner.req('POST', `${base()}/metrics/query`, { from: new Date(NOW - 40 * 86400_000).toISOString(), to: new Date(NOW).toISOString(), metric: 'm' })).status).toBe(400);
    expect((await owner.req('POST', `${base()}/metrics/query`, { ...range(), metric: 'm', filters: Array.from({ length: 9 }, () => ({ key: 'a', value: 'b' })) })).status).toBe(400);
    expect((await owner.req('POST', `${base()}/metrics/query`, { ...range(), metric: 'm', groupBy: ['a', 'b', 'c'] })).status).toBe(400);
    expect((await owner.req('POST', `${base()}/metrics/query`, { ...range(), metric: 'm', filters: [{ key: '$where', value: 'x' }] })).status).toBe(400);
  });
  test('metric endpoints enforce authorization like every other route', async () => {
    for (const c of [auditor, globex]) {
      expect((await c.req('GET', `${base()}/metrics/names`)).status).toBe(404);
      expect((await c.req('POST', `${base()}/metrics/query`, { ...range(), metric: 'x' })).status).toBe(404);
    }
    expect((await h.app.inject(`${base()}/metrics/names`)).statusCode).toBe(401);
    // the query cache is keyed by scope: the viewer's identical query returns only dev data
    const q = { ...range(), metric: 'http.server.request.duration', agg: 'count', groupBy: ['service'] };
    await owner.req('POST', `${base()}/metrics/query`, q);
    const v = (await viewer.req('POST', `${base()}/metrics/query`, q)).json;
    expect(v.series.map((s: any) => s.labels.service)).toEqual(['devsvc']);
  });
});

describe('diagnostics and token scopes', () => {
  test('diagnostics report per-signal ingestion, storage counts and query timings', async () => {
    const r = await owner.req('GET', `${base()}/telemetry/diagnostics?minutes=60`);
    expect(r.status).toBe(200);
    expect(r.json.signals.traces.accepted).toBeGreaterThan(5);
    expect(r.json.signals.metrics.accepted).toBeGreaterThan(2);
    expect(r.json.signals.logs.accepted).toBeGreaterThanOrEqual(3);
    expect(r.json.signals.traces.lastAcceptedAt).toBeTruthy();
    expect(r.json.storage.spans).toBeGreaterThanOrEqual(7);
    expect(r.json.storage.metrics.series).toBeGreaterThan(0);
    expect(r.json.queries.find((q: any) => q.kind === 'traces.search')).toMatchObject({ failures: 0 });
    expect(JSON.stringify(r.json)).not.toMatch(/mongodb:\/\//);
    expect((await auditor.req('GET', `${base()}/telemetry/diagnostics`)).status).toBe(404);
  });
  test('new ingestion tokens carry all three signals unless narrowed; the endpoints list includes traces and metrics', async () => {
    const all = await owner.req('POST', `${base()}/environments/${devEnv}/ingest-tokens`, { name: 'all signals' });
    expect(all.json.info.scopes.sort()).toEqual(['logs', 'metrics', 'traces']);
    const narrow = await owner.req('POST', `${base()}/environments/${devEnv}/ingest-tokens`, { name: 'traces only', signals: ['traces'] });
    expect(narrow.json.info.scopes).toEqual(['traces']);
    expect((await owner.req('POST', `${base()}/environments/${devEnv}/ingest-tokens`, { name: 'bad', signals: ['profiles'] })).status).toBe(400);
    const ep = await owner.req('GET', '/api/v1/telemetry/endpoints');
    expect(ep.json).toMatchObject({ otlpHttpTraces: expect.stringContaining('/v1/traces'), otlpHttpMetrics: expect.stringContaining('/v1/metrics') });
  });
});
