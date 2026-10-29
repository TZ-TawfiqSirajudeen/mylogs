import { gzipSync } from 'node:zlib';
import { AuditService, type Database } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import { IngestTokenService, TokenCreate } from '@nexus/ingest';
import { MongoMetricStore } from '@nexus/metricstore';
import { encodeMetricsRequest, encodeTracesRequest } from '@nexus/telemetry';
import { MongoTraceStore, type TraceStore } from '@nexus/tracestore';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildIngestApp, DEFAULT_APP_CONFIG, type IngestAppConfig } from '../src/app.js';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let db: Database;
let tokens: IngestTokenService;
const ORG = 'org-a', PROJECT = 'proj-1', ENV = 'env-a', ENV_B = 'env-b';
const T: Record<string, string> = {};
const NOW = Date.now();
const nsOf = (ms: number, frac = 0) => String(BigInt(ms) * 1_000_000n + BigInt(frac));
const tid = (n: number) => n.toString(16).padStart(32, 'a');
const sid = (n: number) => n.toString(16).padStart(16, 'b');
const span = (n: number, over: object = {}) => ({ traceId: tid(1), spanId: sid(n), name: `op-${n}`, kind: 2, startTimeUnixNano: nsOf(NOW - 2000, 123), endTimeUnixNano: nsOf(NOW - 1500, 456), attributes: [], ...over });
const tracesBody = (spans: object[], service = 'gateway') => ({ resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }, { key: 'deployment.environment', value: { stringValue: 'production-claimed' } }] }, scopeSpans: [{ scope: { name: 'http' }, spans }] }] });
const mp = (over: object = {}) => ({ name: 'http.server.request.duration', unit: 's', histogram: { aggregationTemporality: 1, dataPoints: [{ timeUnixNano: nsOf(NOW - 1000), count: '4', sum: 1.2, bucketCounts: ['1', '2', '1'], explicitBounds: [0.1, 0.5], attributes: [{ key: 'http.route', value: { stringValue: '/x' } }] }] }, ...over });
const metricsBody = (metrics: object[], service = 'gateway') => ({ resourceMetrics: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] }, scopeMetrics: [{ metrics }] }] });

async function app(cfg: Partial<IngestAppConfig> = {}, deps: Parameters<typeof buildIngestApp>[2] = {}) {
  // a small series limit keeps the cardinality test fast (the default is sized for fleets)
  return buildIngestApp(db, { ...DEFAULT_APP_CONFIG, logLevel: 'silent', ...cfg }, { metricStore: new MongoMetricStore(db, { maxSeriesPerMetric: 500 }), ...deps });
}
type A = Awaited<ReturnType<typeof app>>;
const auth = (t = T.all) => ({ authorization: `Bearer ${t}` });
const json = { 'content-type': 'application/json' };
const proto = { 'content-type': 'application/x-protobuf' };
const post = (a: A, url: string, payload: string | Buffer, headers: Record<string, string>) => a.app.inject({ method: 'POST', url, payload, headers });
const sendTraces = (a: A, spans: object[], headers = { ...json, ...auth() }, service?: string) => post(a, '/v1/traces', JSON.stringify(tracesBody(spans, service)), headers);

beforeAll(async () => {
  mongo = await startTestMongo();
  db = await freshTestDatabase(mongo.uri);
  tokens = new IngestTokenService(db, new AuditService(db));
  for (const e of [ENV, ENV_B]) await db.c.environments.insertOne({ _id: e, orgId: ORG, projectId: PROJECT, slug: e, name: e, isProduction: false, createdAt: new Date() });
  const mk = async (name: string, env: string, signals: ('logs' | 'traces' | 'metrics')[], extra: object = {}) =>
    (await tokens.create({ orgId: ORG, projectId: PROJECT, environmentIds: null }, env, { userId: 'u', ctx: { requestId: 'req-setup-01' } }, TokenCreate.parse({ name, signals, recordsPerMinute: 1_000_000, ...extra }))).token;
  T.all = await mk('all', ENV, ['logs', 'traces', 'metrics']);
  T.logsOnly = await mk('logs-only', ENV, ['logs']);
  T.tracesOnly = await mk('traces-only', ENV, ['traces']);
  T.envB = await mk('env-b', ENV_B, ['logs', 'traces', 'metrics']);
}, 300_000);
afterAll(async () => { await db?.close(); await mongo?.stop(); });

describe('authentication and token scope', () => {
  test('no token or an unknown token: 401 on both signals, with no detail about why', async () => {
    const a = await app();
    for (const url of ['/v1/traces', '/v1/metrics']) {
      const none = await post(a, url, '{}', json);
      const bad = await post(a, url, '{}', { ...json, ...auth('nxi_' + 'x'.repeat(43)) });
      expect(none.statusCode).toBe(401);
      expect(bad.statusCode).toBe(401);
      expect(bad.json().message).toBe(none.json().message);
    }
    await a.app.close();
  });
  test('a logs-only token cannot write spans or metrics; a traces-only token cannot write logs or metrics', async () => {
    const a = await app();
    const b = JSON.stringify(tracesBody([span(2)]));
    expect((await post(a, '/v1/traces', b, { ...json, ...auth(T.logsOnly) })).statusCode).toBe(403);
    expect((await post(a, '/v1/metrics', JSON.stringify(metricsBody([mp()])), { ...json, ...auth(T.logsOnly) })).json().error).toBe('forbidden_signal');
    expect((await post(a, '/v1/logs', '{"resourceLogs":[]}', { ...json, ...auth(T.tracesOnly) })).statusCode).toBe(403);
    expect((await post(a, '/v1/metrics', JSON.stringify(metricsBody([mp()])), { ...json, ...auth(T.tracesOnly) })).statusCode).toBe(403);
    expect((await post(a, '/v1/traces', b, { ...json, ...auth(T.tracesOnly) })).statusCode).toBe(200);
    expect(await db.c.spans.countDocuments({ spanId: sid(2), tokenId: { $exists: true } })).toBe(1);
    await a.app.close();
  });
  test('tokens never appear in error responses', async () => {
    const a = await app();
    const r = await post(a, '/v1/traces', '{not json', { ...json, ...auth() });
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain(T.all);
    await a.app.close();
  });
  test('a revoked-looking or malformed token is refused identically', async () => {
    const a = await app();
    for (const t of ['', 'Bearer', 'nxi_short', T.all!.slice(0, -1)]) {
      expect((await post(a, '/v1/traces', '{}', { ...json, authorization: t.startsWith('Bearer') ? t : `Bearer ${t}` })).statusCode).toBe(401);
    }
    await a.app.close();
  });
});

describe('OTLP traces over HTTP', () => {
  test('JSON: stored under the token\'s tenant, whatever the payload claims; nanosecond precision survives', async () => {
    const a = await app();
    const r = await sendTraces(a, [span(10, { parentSpanId: undefined, attributes: [{ key: 'organization.id', value: { stringValue: 'someone-else' } }] })]);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({});
    const s = (await db.c.spans.findOne({ spanId: sid(10) }))!;
    expect(s).toMatchObject({ orgId: ORG, projectId: PROJECT, environmentId: ENV, service: 'gateway', startNsFrac: 123, endNsFrac: 456, durationNs: 500_000_000 + 333 });
    expect(s.deployment).toBe('production-claimed'); // kept as data, never used for placement
    expect(await db.c.traceSummaries.countDocuments({ traceId: tid(1) })).toBeGreaterThanOrEqual(1);
    await a.app.close();
  });

  test('protobuf (what SDK exporters and the Collector send), plain and gzip', async () => {
    const a = await app();
    const pb = (n: number) => encodeTracesRequest({
      resource_spans: [{ resource: { attributes: [{ key: 'service.name', value: { string_value: 'proto-svc' } }] }, scope_spans: [{ spans: [{
        trace_id: Buffer.from(tid(2), 'hex'), span_id: Buffer.from(sid(n), 'hex'), name: 'proto-op', kind: 3, start_time_unix_nano: nsOf(NOW - 900), end_time_unix_nano: nsOf(NOW - 800),
        status: { code: 2, message: 'boom' },
      }] }] }],
    });
    const r1 = await post(a, '/v1/traces', Buffer.from(pb(20)), { ...proto, ...auth() });
    expect(r1.statusCode).toBe(200);
    expect(r1.headers['content-type']).toContain('application/x-protobuf');
    const r2 = await post(a, '/v1/traces', gzipSync(Buffer.from(pb(21))), { ...proto, 'content-encoding': 'gzip', ...auth() });
    expect(r2.statusCode).toBe(200);
    expect(await db.c.spans.find({ traceId: tid(2) }).toArray()).toHaveLength(2);
    expect(await db.c.spans.findOne({ spanId: sid(20) })).toMatchObject({ service: 'proto-svc', kind: 'client', statusCode: 'error', statusMessage: 'boom' });
    await a.app.close();
  });

  test('invalid spans are refused individually and reported as OTLP partial success; valid siblings are stored', async () => {
    const a = await app();
    const r = await sendTraces(a, [span(30), span(31, { traceId: 'short' }), span(32, { startTimeUnixNano: undefined })]);
    expect(r.statusCode).toBe(200);
    expect(r.json().partialSuccess).toMatchObject({ rejectedSpans: '2' });
    expect(await db.c.spans.countDocuments({ spanId: { $in: [sid(30), sid(31), sid(32)] } })).toBe(1);
    await a.app.close();
  });

  test('a request with only invalid spans is a 400 that says why', async () => {
    const a = await app();
    const r = await sendTraces(a, [span(33, { spanId: 'zz' })]);
    expect(r.statusCode).toBe(400);
    expect(r.json().message).toMatch(/spanId/);
    await a.app.close();
  });

  test('malformed JSON and malformed protobuf are 400s, never crashes', async () => {
    const a = await app();
    expect((await post(a, '/v1/traces', '{oops', { ...json, ...auth() })).statusCode).toBe(400);
    expect((await post(a, '/v1/traces', Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), { ...proto, ...auth() })).statusCode).toBe(400);
    expect((await post(a, '/v1/traces', Buffer.from('not gzip'), { ...json, 'content-encoding': 'gzip', ...auth() })).statusCode).toBe(400);
    expect((await post(a, '/v1/traces', '{}', { 'content-type': 'text/xml', ...auth() })).statusCode).toBe(415);
    expect((await app().then((x) => x.app.inject({ method: 'GET', url: '/healthz' }))).statusCode).toBe(200);
    await a.app.close();
  });

  test('oversized bodies and decompression bombs are refused (413) before they are decoded', async () => {
    const a = await app({ maxBodyBytes: 20_000 });
    const big = JSON.stringify(tracesBody(Array.from({ length: 400 }, (_, i) => span(100 + i, { name: 'x'.repeat(100) }))));
    expect(big.length).toBeGreaterThan(20_000);
    expect((await post(a, '/v1/traces', big, { ...json, ...auth() })).statusCode).toBe(413);
    const bomb = gzipSync(Buffer.alloc(5_000_000, 0x20));
    expect(bomb.length).toBeLessThan(20_000);
    expect((await post(a, '/v1/traces', bomb, { ...json, 'content-encoding': 'gzip', ...auth() })).statusCode).toBe(413);
    await a.app.close();
  });

  test('retransmission is idempotent: the same request twice stores each span once and reports the duplicates', async () => {
    const a = await app();
    const body = JSON.stringify(tracesBody([span(40), span(41, { parentSpanId: sid(40) })]));
    expect((await post(a, '/v1/traces', body, { ...json, ...auth() })).statusCode).toBe(200);
    expect((await post(a, '/v1/traces', body, { ...json, ...auth() })).statusCode).toBe(200);
    expect(await db.c.spans.countDocuments({ spanId: { $in: [sid(40), sid(41)] } })).toBe(2);
    expect(a.tracePipeline.metrics.duplicates).toBe(2);
    expect(a.tracePipeline.metrics.accepted).toBe(2);
    await a.app.close();
  });

  test('the same trace and span ids sent to a DIFFERENT environment are a different span (no cross-environment collision)', async () => {
    const a = await app();
    await sendTraces(a, [span(50)]);
    await sendTraces(a, [span(50)], { ...json, ...auth(T.envB) });
    const rows = await db.c.spans.find({ spanId: sid(50) }).toArray();
    expect(rows.map((r) => r.environmentId).sort()).toEqual([ENV, ENV_B]);
  });

  test('delayed and out-of-order spans: the summary converges whatever the arrival order', async () => {
    const a = await app();
    const T3 = 3;
    const mk = (n: number, parent?: number, off = 0) => span(60 + n, { traceId: tid(T3), parentSpanId: parent === undefined ? undefined : sid(60 + parent), startTimeUnixNano: nsOf(NOW - 3000 + off), endTimeUnixNano: nsOf(NOW - 2900 + off) });
    await sendTraces(a, [mk(3, 2, 20)]);                     // grandchild first
    await sendTraces(a, [mk(2, 1, 10)]);                     // then the child
    let s = (await db.c.traceSummaries.findOne({ traceId: tid(T3), environmentId: ENV }))!;
    expect(s).toMatchObject({ hasRoot: false, orphanCount: 1, spanCount: 2 });
    await sendTraces(a, [mk(1)]);                            // the root arrives last
    s = (await db.c.traceSummaries.findOne({ traceId: tid(T3), environmentId: ENV }))!;
    expect(s).toMatchObject({ hasRoot: true, orphanCount: 0, spanCount: 3, rootSpanId: sid(61) });
    await a.app.close();
  });

  test('credentials are redacted BEFORE persistence (URL query, userinfo, authorization headers, exception text, db connection strings)', async () => {
    const a = await app();
    const attrs = [
      { key: 'url.full', value: { stringValue: 'https://bob:hunter2pw@api.test/x?access_token=abc123xyz&page=1' } },
      { key: 'http.request.header.authorization', value: { stringValue: 'Bearer abcdefghijklmnopqrstuv' } },
      { key: 'db.connection_string', value: { stringValue: 'mongodb://u:pw@h/db' } },
      { key: 'db.statement', value: { stringValue: 'SELECT * FROM t WHERE token = \'sk_live_abcdefghijklmnop\'' } },
    ];
    await sendTraces(a, [span(70, { attributes: attrs, events: [{ name: 'exception', timeUnixNano: nsOf(NOW - 1600), attributes: [{ key: 'exception.stacktrace', value: { stringValue: 'Error\n  password=hunter2hunter2' } }] }] })]);
    const dump = JSON.stringify(await db.c.spans.findOne({ spanId: sid(70) }));
    for (const secret of ['hunter2pw', 'abc123xyz', 'abcdefghijklmnopqrstuv', 'sk_live_abcdefghijklmnop', 'hunter2hunter2', 'mongodb://u:pw']) expect(dump, secret).not.toContain(secret);
    expect(dump).toContain('page=1');
    expect((await db.c.spans.findOne({ spanId: sid(70) }))!.redactions).toBeGreaterThanOrEqual(5);
    await a.app.close();
  });

  test('per-signal ingest statistics are recorded (accepted, duplicates, rejected) and never mixed with logs', async () => {
    const stats = await db.c.ingestStats.find({ environmentId: ENV, signal: 'traces' }).toArray();
    const sum = (k: 'accepted' | 'duplicates' | 'rejectedInvalid') => stats.reduce((n, s) => n + (s[k] ?? 0), 0);
    expect(sum('accepted')).toBeGreaterThan(5);
    expect(sum('duplicates')).toBeGreaterThanOrEqual(2);
    expect(sum('rejectedInvalid')).toBeGreaterThanOrEqual(3);
    expect(stats.every((s) => s._id.includes(':traces:'))).toBe(true);
  });

  test('services are inventoried from valid service.name resources', async () => {
    await new Promise((r) => setTimeout(r, 200)); // inventory is written after the response (best effort)
    const svc = await db.c.services.findOne({ environmentId: ENV, name: 'gateway' });
    expect(svc).toMatchObject({ orgId: ORG, projectId: PROJECT });
    expect(svc!.lastSpanAt).toBeInstanceOf(Date);
    expect(await db.c.services.findOne({ environmentId: ENV, name: 'proto-svc' })).toBeTruthy();
  });
});

describe('backpressure and recovery', () => {
  const failing = (real: TraceStore, state: { fail: boolean; delayMs: number }): TraceStore => ({
    ...real, search: real.search.bind(real), getTrace: real.getTrace.bind(real), getSpan: real.getSpan.bind(real), knownTraces: real.knownTraces.bind(real),
    serverSpanStats: real.serverSpanStats.bind(real), dependencies: real.dependencies.bind(real),
    insert: async (docs) => {
      if (state.delayMs) await new Promise((r) => setTimeout(r, state.delayMs));
      if (state.fail) throw new Error('storage down');
      return real.insert(docs);
    },
  });

  test('storage unavailable: 503 + Retry-After, nothing is claimed as accepted, and the SAME request succeeds once storage is back', async () => {
    const state = { fail: true, delayMs: 0 };
    const a = await app({ ingest: { ...DEFAULT_APP_CONFIG.ingest, storeRetries: 1, retryBaseMs: 1 } }, { traceStore: failing(new MongoTraceStore(db), state) });
    const body = JSON.stringify(tracesBody([span(80)]));
    const down = await post(a, '/v1/traces', body, { ...json, ...auth() });
    expect(down.statusCode).toBe(503);
    expect(down.headers['retry-after']).toBeTruthy();
    expect(await db.c.spans.countDocuments({ spanId: sid(80) })).toBe(0);
    expect(a.tracePipeline.metrics.rejectedStorage).toBe(1);
    expect(a.tracePipeline.metrics.storeErrors).toBeGreaterThanOrEqual(2);
    state.fail = false;
    expect((await post(a, '/v1/traces', body, { ...json, ...auth() })).statusCode).toBe(200);
    expect(await db.c.spans.countDocuments({ spanId: sid(80) })).toBe(1);
    expect((await db.c.ingestStats.find({ environmentId: ENV, signal: 'traces', rejectedStorage: { $gt: 0 } }).toArray()).length).toBeGreaterThan(0);
    await a.app.close();
  });

  test('overload: a bounded queue answers 503 instead of buffering without limit, then recovers', async () => {
    const state = { fail: false, delayMs: 300 };
    const a = await app({ ingest: { ...DEFAULT_APP_CONFIG.ingest, maxInflightWrites: 1, maxQueuedWrites: 0 } }, { traceStore: failing(new MongoTraceStore(db), state) });
    const send = (n: number) => post(a, '/v1/traces', JSON.stringify(tracesBody([span(90 + n)])), { ...json, ...auth() });
    const results = await Promise.all([send(1), send(2), send(3)]);
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 200).length).toBe(1);
    expect(codes.filter((c) => c === 503).length).toBe(2);
    expect(results.find((r) => r.statusCode === 503)!.headers['retry-after']).toBeTruthy();
    expect(a.tracePipeline.metrics.rejectedOverload).toBe(2);
    state.delayMs = 0;
    expect((await send(4)).statusCode).toBe(200);
    expect(a.tracePipeline.queued).toBe(0);
    expect(a.tracePipeline.inflight).toBe(0);
    await a.app.close();
  });

  test('quota: the token budget is enforced per signal with Retry-After', async () => {
    const low = (await tokens.create({ orgId: ORG, projectId: PROJECT, environmentIds: null }, ENV, { userId: 'u', ctx: { requestId: 'req-setup-02' } }, TokenCreate.parse({ name: 'low', recordsPerMinute: 100 }))).token;
    const a = await app();
    const many = Array.from({ length: 150 }, (_, i) => span(200 + i));
    const r = await sendTraces(a, many, { ...json, ...auth(low) });
    expect(r.statusCode).toBe(429);
    expect(r.headers['retry-after']).toBeTruthy();
    expect(await db.c.spans.countDocuments({ spanId: sid(200) })).toBe(0);
    await a.app.close();
  });
});

describe('OTLP metrics over HTTP', () => {
  test('JSON and protobuf histograms are stored, pre-aggregated per series and minute', async () => {
    const a = await app();
    expect((await post(a, '/v1/metrics', JSON.stringify(metricsBody([mp()])), { ...json, ...auth() })).statusCode).toBe(200);
    const pb = encodeMetricsRequest({ resource_metrics: [{ resource: { attributes: [{ key: 'service.name', value: { string_value: 'pb-svc' } }] }, scope_metrics: [{ metrics: [{
      name: 'queue.depth', gauge: { data_points: [{ time_unix_nano: nsOf(NOW - 500), as_int: 7 }] },
    }] }] }] });
    expect((await post(a, '/v1/metrics', Buffer.from(pb), { ...proto, ...auth() })).statusCode).toBe(200);
    const h = await db.c.metricPoints.findOne({ metric: 'http.server.request.duration' });
    expect(h).toMatchObject({ orgId: ORG, environmentId: ENV, service: 'gateway', type: 'histogram', count: 4, buckets: [1, 2, 1] });
    expect(await db.c.metricPoints.findOne({ metric: 'queue.depth' })).toMatchObject({ service: 'pb-svc', last: 7 });
    await a.app.close();
  });

  test('unsupported metric types are refused and counted as OTLP partial success; supported ones in the same request still pass', async () => {
    const a = await app();
    const r = await post(a, '/v1/metrics', JSON.stringify(metricsBody([
      { name: 'expo', exponentialHistogram: { aggregationTemporality: 1, dataPoints: [{}, {}, {}] } }, { name: 'sumry', summary: { dataPoints: [{}] } },
      { name: 'unspec', sum: { aggregationTemporality: 0, dataPoints: [{ timeUnixNano: nsOf(NOW - 500), asInt: '1' }] } },
      { name: 'supported.gauge', gauge: { dataPoints: [{ timeUnixNano: nsOf(NOW - 500), asInt: '3' }] } },
    ])), { ...json, ...auth() });
    expect(r.statusCode).toBe(200);
    expect(r.json().partialSuccess.rejectedDataPoints).toBe('5');
    expect(r.json().partialSuccess.errorMessage).toMatch(/not supported|unspecified/);
    expect(a.metricPipeline.unsupported).toBe(5);
    expect(await db.c.metricPoints.countDocuments({ metric: 'supported.gauge' })).toBe(1);
    await a.app.close();
  });

  test('retransmitted metric requests are idempotent', async () => {
    const a = await app();
    const body = JSON.stringify(metricsBody([{ name: 'replay.count', sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [{ timeUnixNano: nsOf(NOW - 700), asInt: '5' }] } }]));
    await post(a, '/v1/metrics', body, { ...json, ...auth() });
    await post(a, '/v1/metrics', body, { ...json, ...auth() });
    expect((await db.c.metricPoints.findOne({ metric: 'replay.count' }))!.sum).toBe(5);
    expect(a.metricPipeline.metrics.duplicates).toBe(1);
    await a.app.close();
  });

  test('cardinality: too many label combinations are refused with an explanation, not stored', async () => {
    const a = await app();
    const dps = Array.from({ length: 520 }, (_, i) => ({ timeUnixNano: nsOf(NOW - 600), asInt: '1', attributes: [{ key: 'tenant.name', value: { stringValue: `t${i}` } }] }));
    const r = await post(a, '/v1/metrics', JSON.stringify(metricsBody([{ name: 'cardinality.test', gauge: { dataPoints: dps } }])), { ...json, ...auth() });
    expect(r.statusCode).toBe(200);
    expect(r.json().partialSuccess.rejectedDataPoints).toBe('20');
    expect(r.json().partialSuccess.errorMessage).toMatch(/limit of 500 series/);
    expect(await db.c.metricSeries.countDocuments({ name: 'cardinality.test' })).toBe(500);
    await a.app.close();
  });

  test('a metrics-only failure of storage is a 503 and does not affect the logs path', async () => {
    const down: MongoMetricStore = Object.assign(new MongoMetricStore(db), { ingest: async () => { throw new Error('metrics storage down'); } });
    const a = await app({ ingest: { ...DEFAULT_APP_CONFIG.ingest, storeRetries: 0 } }, { metricStore: down });
    expect((await post(a, '/v1/metrics', JSON.stringify(metricsBody([mp()])), { ...json, ...auth() })).statusCode).toBe(503);
    const logs = { resourceLogs: [{ resource: { attributes: [] }, scopeLogs: [{ logRecords: [{ timeUnixNano: nsOf(NOW - 100), severityNumber: 9, body: { stringValue: 'logs still work' } }] }] }] };
    expect((await post(a, '/v1/logs', JSON.stringify(logs), { ...json, ...auth() })).statusCode).toBe(200);
    expect(await db.c.logs.countDocuments({ message: 'logs still work' })).toBe(1);
    await a.app.close();
  });
});

describe('operational metrics', () => {
  test('/metrics exposes per-signal counters', async () => {
    const a = await app();
    await sendTraces(a, [span(300)]);
    const r = await a.app.inject('/metrics');
    expect(r.body).toMatch(/nexus_ingest_spans_accepted_total 1/);
    expect(r.body).toMatch(/nexus_ingest_datapoints_accepted_total 0/);
    expect(r.body).toContain('nexus_ingest_metric_datapoints_unsupported_total');
    expect(r.body).not.toContain(T.all);
    await a.app.close();
  });
});
