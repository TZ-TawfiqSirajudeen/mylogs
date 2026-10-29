import { MetricQuery } from '@nexus/contracts';
import type { Database } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import type { MetricPointDraft } from '@nexus/telemetry';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MAX_SERIES_PER_METRIC, MetricQueryError, MongoMetricStore, seriesIdOf, type MetricContext, type Scope } from './store.js';

test('the default limits are sized for a fleet, not a demo', () => { expect(MAX_SERIES_PER_METRIC).toBeGreaterThanOrEqual(2000); });

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let db: Database;
let store: MongoMetricStore;

const ORG = 'org-a', OTHER = 'org-b', PROJECT = 'proj-1';
const ENV = '11111111-1111-4111-8111-111111111111', ENV2 = '22222222-2222-4222-8222-222222222222';
const T0 = Math.floor(Date.parse('2026-03-01T12:00:00Z') / 60_000) * 60_000;
const now = new Date(T0 + 3_600_000);
const ctx = (over: Partial<MetricContext> = {}): MetricContext => ({ orgId: ORG, projectId: PROJECT, environmentId: ENV, retentionMs: 30 * 86_400_000, ...over });
const scope: Scope = { orgId: ORG, projectId: PROJECT, environmentIds: [ENV, ENV2] };
const at = (min: number, sec = 0) => new Date(T0 + min * 60_000 + sec * 1000);
const iso = (d: Date) => d.toISOString();
const q = (over: Record<string, unknown> = {}) => MetricQuery.parse({ from: iso(at(0)), to: iso(at(30)), metric: 'm', ...over });

const pt = (over: Partial<MetricPointDraft>): MetricPointDraft => ({
  name: 'm', unit: null, description: null, type: 'gauge', temporality: null, monotonic: null, service: 'gateway', serviceVersion: null, instance: 'i-1', attrs: [],
  time: at(0), startTime: null, value: 0, count: 1, sum: 0, min: null, max: null, bounds: null, buckets: null, exemplars: [], ...over,
});
const gauge = (name: string, min: number, v: number, over: Partial<MetricPointDraft> = {}) => pt({ name, type: 'gauge', time: at(min, 5), value: v, sum: v, ...over });
const delta = (name: string, min: number, v: number, over: Partial<MetricPointDraft> = {}) => pt({ name, type: 'sum', temporality: 'delta', monotonic: true, time: at(min, 5), value: v, sum: v, ...over });
const cum = (name: string, min: number, v: number, over: Partial<MetricPointDraft> = {}) => pt({ name, type: 'sum', temporality: 'cumulative', monotonic: true, time: at(min, 5), startTime: at(-120), value: v, sum: v, ...over });
const BOUNDS = [0.1, 0.5, 1];
const hist = (name: string, min: number, buckets: number[], over: Partial<MetricPointDraft> = {}) => pt({
  name, type: 'histogram', temporality: 'delta', time: at(min, 5), bounds: BOUNDS, buckets, count: buckets.reduce((a, b) => a + b, 0), sum: buckets.reduce((a, b) => a + b, 0) * 0.3, unit: 's', ...over,
});
const lbl = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => ({ k, v }));

const LIMIT = 500; // a small limit keeps the cardinality tests fast; the production default is MAX_SERIES_PER_METRIC
beforeAll(async () => { mongo = await startTestMongo(); db = await freshTestDatabase(mongo.uri); store = new MongoMetricStore(db, { maxSeriesPerMetric: LIMIT }); }, 240_000);
afterAll(async () => { await db?.close(); await mongo?.stop(); });
const values = async (query: Record<string, unknown>, s: Scope = scope) => (await store.query(s, q(query))).series.map((x) => x.points.map((p) => p.v));

describe('ingestion is idempotent and atomic', () => {
  test('retransmitting a request changes nothing (the watermark rejects points that are not newer)', async () => {
    const batch = [delta('idem.count', 1, 5), delta('idem.count', 2, 7)];
    expect(await store.ingest(ctx(), batch, now)).toMatchObject({ accepted: 2, duplicates: 0, rejected: 0 });
    expect(await store.ingest(ctx(), batch, now)).toMatchObject({ accepted: 0, duplicates: 2, rejected: 0 });
    const r = await store.query(scope, q({ metric: 'idem.count', agg: 'sum' }));
    expect(r.series[0]!.points.filter((p) => p.v !== null).map((p) => p.v)).toEqual([5, 7]);
  });

  test('parallel and out-of-order requests for the same series never lose or double count', async () => {
    const reqs = Array.from({ length: 8 }, (_, i) => store.ingest(ctx(), [delta('conc.count', 10 + i, 1)], now));
    const res = await Promise.all(reqs);
    expect(res.reduce((n, r) => n + r.accepted, 0)).toBe(8);
    const out = await store.query(scope, q({ metric: 'conc.count', agg: 'sum' }));
    expect(out.series[0]!.points.reduce((n, p) => n + (p.v ?? 0), 0)).toBe(8);
  });

  test('cumulative counters become increases across batches, handle restarts, and different instances do not share state', async () => {
    await store.ingest(ctx(), [cum('cum.count', 1, 100), cum('cum.count', 1, 1000, { instance: 'i-2' })], now);
    await store.ingest(ctx(), [cum('cum.count', 2, 110), cum('cum.count', 2, 1030, { instance: 'i-2' })], now);
    await store.ingest(ctx(), [cum('cum.count', 3, 5, { startTime: at(2) })], now); // i-1 restarted: its new value is the increase
    const r = await store.query(scope, q({ metric: 'cum.count', agg: 'sum' }));
    const total = r.series[0]!.points.reduce((n, p) => n + (p.v ?? 0), 0);
    expect(total).toBe(10 + 30 + 5);
    expect(await db.c.metricSeries.countDocuments({ name: 'cum.count' })).toBe(2);
  });

  test('a transaction that fails midway leaves neither a series state nor points behind', async () => {
    const before = await db.c.metricSeries.countDocuments({});
    const original = db.c.metricPoints.bulkWrite.bind(db.c.metricPoints);
    (db.c.metricPoints as unknown as { bulkWrite: unknown }).bulkWrite = async () => { throw new Error('disk full'); }; // fail AFTER the series write inside the transaction
    try { await expect(store.ingest(ctx(), [delta('atomic.count', 1, 1)], now)).rejects.toThrow('disk full'); }
    finally { (db.c.metricPoints as unknown as { bulkWrite: unknown }).bulkWrite = original; }
    expect(await db.c.metricSeries.countDocuments({})).toBe(before);
    expect(await db.c.metricPoints.countDocuments({ metric: 'atomic.count' })).toBe(0);
    // ...and a retry of the same data is NOT treated as a duplicate, because nothing was committed
    expect(await store.ingest(ctx(), [delta('atomic.count', 1, 1)], now)).toMatchObject({ accepted: 1, duplicates: 0 });
  });

  test('retention: points and series expire by their own TTL date', async () => {
    await store.ingest(ctx({ retentionMs: 3 * 86_400_000 }), [gauge('ttl.g', 1, 1)], now);
    const p = (await db.c.metricPoints.findOne({ metric: 'ttl.g' }))!;
    expect(p.expireAt.getTime()).toBeGreaterThanOrEqual(at(1).getTime() + 3 * 86_400_000);
    expect(p.expireAt.getTime()).toBeLessThan(at(1).getTime() + 4 * 86_400_000);
  });
});

describe('cardinality control', () => {
  test('a metric cannot create more than the per-metric series limit; the excess is refused, reported, and existing series keep working', async () => {
    const points = Array.from({ length: LIMIT + 25 }, (_, i) => gauge('card.g', 1, i, { attrs: lbl({ 'user.name': `u${i}` }) }));
    const r = await store.ingest(ctx(), points, now);
    expect(r.accepted).toBe(LIMIT);
    expect(r.rejected).toBe(25);
    expect(r.notes.join(' ')).toMatch(/limit of 500 series/);
    expect(await db.c.metricSeries.countDocuments({ name: 'card.g' })).toBe(LIMIT);
    expect((await store.ingest(ctx(), [gauge('card.g', 2, 1, { attrs: lbl({ 'user.name': 'u0' }) })], now)).accepted).toBe(1); // an existing series still accepts data
  });
  test('the limit is per environment: another environment can still create series for the same metric', async () => {
    expect((await store.ingest(ctx({ environmentId: ENV2 }), [gauge('card.g', 1, 1, { attrs: lbl({ 'user.name': 'fresh' }) })], now)).accepted).toBe(1);
  });
  test('diagnostics expose series counts and flag metrics near their limit', async () => {
    const d = await store.diagnostics(scope);
    expect(d.series).toBeGreaterThan(500);
    expect(d.topMetrics[0]).toMatchObject({ name: 'card.g', nearLimit: true });
    expect(d.limits.maxSeriesPerMetric).toBe(LIMIT);
  });
});

describe('queries', () => {
  beforeAll(async () => {
    // two instances of one service report the same histogram; one fast, one slow
    await store.ingest(ctx(), [
      hist('lat', 1, [90, 10, 0, 0], { instance: 'i-1', attrs: lbl({ 'http.route': '/a' }) }), hist('lat', 2, [90, 10, 0, 0], { instance: 'i-1', attrs: lbl({ 'http.route': '/a' }) }),
      hist('lat', 1, [0, 0, 5, 5], { instance: 'i-2', attrs: lbl({ 'http.route': '/a' }) }),
      hist('lat', 1, [10, 0, 0, 0], { instance: 'i-1', attrs: lbl({ 'http.route': '/b' }) }),
      gauge('qdepth', 1, 4), gauge('qdepth', 1, 9, { time: at(1, 30) }), gauge('qdepth', 3, 2),
    ], now);
  });

  test('percentiles come from merged bucket counts across instances', async () => {
    const r = await store.query(scope, q({ metric: 'lat', agg: 'p95', filters: [{ key: 'http.route', value: '/a' }], from: iso(at(0)), to: iso(at(2)) }));
    expect(r.type).toBe('histogram');
    expect(r.series).toHaveLength(1);
    const v = r.series[0]!.points.find((p) => p.v !== null)!.v!;
    // minute 1: 90+0 fast, 10+0 mid, 5, 5 -> 110 observations; p95 rank 104.5 falls in the (0.5,1] bucket
    expect(v).toBeGreaterThan(0.5);
    expect(v).toBeLessThanOrEqual(1);
    expect(r.notes.join(' ')).toMatch(/estimated from histogram bucket counts/);
  });
  test('count, sum, avg and rate for histograms', async () => {
    const base = { metric: 'lat', filters: [{ key: 'http.route', value: '/b' }], stepSeconds: 60 };
    expect((await values({ ...base, agg: 'count' }))[0]!.find((v) => v !== null)).toBe(10);
    expect((await values({ ...base, agg: 'sum' }))[0]!.find((v) => v !== null)).toBeCloseTo(3, 6);
    expect((await values({ ...base, agg: 'avg' }))[0]!.find((v) => v !== null)).toBeCloseTo(0.3, 6);
    const rate = (await values({ ...base, agg: 'rate' }))[0]!.find((v) => v !== null)!;
    expect(rate).toBeCloseTo(10 / 60, 6); // observations per second in a 60 s window
  });
  test('groupBy splits series by label; ranking keeps the largest', async () => {
    const r = await store.query(scope, q({ metric: 'lat', agg: 'count', groupBy: ['http.route'] }));
    expect(r.series.map((s) => s.labels['http.route'])).toEqual(['/a', '/b']);
  });
  test('missing data is null, never zero; the window grid is complete', async () => {
    const r = await store.query(scope, q({ metric: 'qdepth', agg: 'last', from: iso(at(0)), to: iso(at(5)) }));
    const pts = r.series[0]!.points;
    expect(pts.map((p) => p.v)).toEqual([null, 9, null, 2, null, null]); // minute 1 holds the newest (09) sample; gaps stay empty
  });
  test('gauge aggregations: avg, min, max, last, count', async () => {
    const one = async (agg: string) => (await values({ metric: 'qdepth', agg, from: iso(at(1)), to: iso(at(1, 59)) }))[0]![0];
    expect(await one('avg')).toBe(6.5);
    expect(await one('min')).toBe(4);
    expect(await one('max')).toBe(9);
    expect(await one('last')).toBe(9);
    expect(await one('count')).toBe(2);
  });
  test('the number of points never exceeds the limit, whatever step is requested', async () => {
    const r = await store.query(scope, q({ metric: 'qdepth', from: iso(at(0)), to: iso(new Date(T0 + 30 * 86_400_000)), stepSeconds: 60 }));
    expect(r.series[0]!.points.length).toBeLessThanOrEqual(401);
    expect(r.stepMs).toBeGreaterThan(60_000);
  });
  test('aggregations that do not fit the metric type are refused with a useful message', async () => {
    await expect(store.query(scope, q({ metric: 'qdepth', agg: 'p95' }))).rejects.toMatchObject({ status: 400, code: 'unsupported_aggregation' });
    await expect(store.query(scope, q({ metric: 'lat', agg: 'last' }))).rejects.toBeInstanceOf(MetricQueryError);
  });
  test('an unknown metric returns an empty, explained result', async () => {
    const r = await store.query(scope, q({ metric: 'does.not.exist' }));
    expect(r.series).toEqual([]);
    expect(r.notes[0]).toMatch(/No data/);
  });
  test('queries that would scan too much are refused with advice instead of timing out', async () => {
    const small = new MongoMetricStore(db, { maxPointDocsScanned: 3 });
    const err = await small.query(scope, q({ metric: 'lat', agg: 'count' })).catch((e) => e);
    expect(err).toBeInstanceOf(MetricQueryError);
    expect(err).toMatchObject({ status: 422, code: 'query_too_expensive' });
    expect(err.message).toMatch(/Narrow the time range/);
  });
  test('names and labels describe what exists', async () => {
    const names = await store.names(scope);
    expect(names.find((n) => n.name === 'lat')).toMatchObject({ type: 'histogram', unit: 's', services: ['gateway'] });
    const labels = await store.labels(scope, 'lat');
    expect(labels).toEqual([{ key: 'http.route', values: ['/a', '/b'], truncated: false }]);
  });
  test('tenants and environments are isolated in every query', async () => {
    const other: Scope = { orgId: OTHER, projectId: PROJECT, environmentIds: [ENV] };
    expect((await store.query(other, q({ metric: 'lat', agg: 'count' }))).series).toEqual([]);
    expect(await store.names(other)).toEqual([]);
    expect(await store.labels(other, 'lat')).toEqual([]);
    const onlyEnv2: Scope = { ...scope, environmentIds: [ENV2] };
    expect((await store.query(onlyEnv2, q({ metric: 'lat', agg: 'count' }))).series).toEqual([]);
    expect((await store.query(onlyEnv2, q({ metric: 'lat', agg: 'count', environmentIds: [ENV] }))).series).toEqual([]); // forcing another environment cannot widen scope
  });
  test('queries use the series and point indexes', async () => {
    const id = seriesIdOf(ctx(), pt({ name: 'qdepth' }));
    const plan = await db.c.metricPoints.find({ seriesId: { $in: [id] }, minute: { $gte: at(0), $lte: at(10) } }).explain('queryPlanner');
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('mpoints_series_minute');
    const sp = await db.c.metricSeries.find({ orgId: ORG, projectId: PROJECT, environmentId: { $in: [ENV] }, name: 'lat' }).explain('queryPlanner');
    expect(JSON.stringify(sp.queryPlanner.winningPlan)).toContain('mseries_scope_name');
  });
});

describe('server-side aggregation paths', () => {
  test('exemplars (explicit trace references) are returned with the window they belong to', async () => {
    const t = 'a'.repeat(32);
    await store.ingest(ctx(), [hist('ex.lat', 3, [1, 1, 1, 0], { exemplars: [{ traceId: t, spanId: 'b'.repeat(16), value: 0.7, ts: at(3, 5) }] })], now);
    const r = await store.query(scope, q({ metric: 'ex.lat', agg: 'p95' }));
    expect(r.series[0]!.exemplars).toEqual([{ traceId: t, spanId: 'b'.repeat(16), value: 0.7, ts: at(3, 5).toISOString() }]);
  });
  test('more groups than the result limit: the largest are kept, ordered by volume, and the response says it is truncated', async () => {
    const pts: MetricPointDraft[] = [];
    for (let i = 0; i < 60; i++) for (let m = 0; m <= i; m++) pts.push(delta('many.groups', m % 25, 1, { time: at(m % 25, 5 + Math.floor(m / 25)), attrs: lbl({ k: String(i).padStart(2, '0') }) }));
    await store.ingest(ctx(), pts, now);
    const r = await store.query(scope, q({ metric: 'many.groups', agg: 'sum', groupBy: ['k'] }));
    expect(r.series).toHaveLength(50);
    expect(r.truncated).toBe(true);
    expect(r.series[0]!.labels.k).toBe('59'); // the series with the most data comes first
    expect(r.series.some((s) => s.labels.k === '00')).toBe(false);
    const total = r.series[0]!.points.reduce((n, p) => n + (p.v ?? 0), 0);
    expect(total).toBe(60);
  });
  test('series with different bucket layouts are never added together; the dominant layout is used and the mix is reported', async () => {
    await store.ingest(ctx(), [
      hist('mix.lat', 4, [90, 5, 5, 0], { instance: 'a' }),
      pt({ name: 'mix.lat', type: 'histogram', temporality: 'delta', service: 'gateway', instance: 'b', time: at(4, 6), bounds: [1, 2], buckets: [0, 0, 3], count: 3, sum: 9, unit: 's' }),
    ], now);
    const r = await store.query(scope, q({ metric: 'mix.lat', agg: 'p95' }));
    expect(r.notes.join(' ')).toMatch(/different bucket layouts/);
    const v = r.series[0]!.points.find((p) => p.v !== null)!.v!;
    expect(v).toBeLessThanOrEqual(1); // from the 100-observation layout, not polluted by the 3-observation one
  });
  test('the scan guard counts on the index and refuses before reading anything', async () => {
    const tiny = new MongoMetricStore(db, { maxPointDocsScanned: 2 });
    await expect(tiny.query(scope, q({ metric: 'many.groups', agg: 'sum' }))).rejects.toMatchObject({ code: 'query_too_expensive' });
    expect((await tiny.httpOverview(scope, at(0), at(30))).services).toEqual([]); // no HTTP metrics have been ingested yet in this file: nothing to scan, nothing refused
  });
});

describe('HTTP service overview (explicit metrics)', () => {
  const http = (min: number, buckets: number[], route: string, status: string, over: Partial<MetricPointDraft> = {}) =>
    hist('http.server.request.duration', min, buckets, { service: 'shop', attrs: lbl({ 'http.route': route, 'http.response.status_code': status, 'http.request.method': 'GET' }), ...over });
  beforeAll(async () => {
    await store.ingest(ctx(), [
      http(1, [50, 40, 10, 0], '/orders/:id', '200'), http(1, [0, 0, 5, 5], '/orders/:id', '500'), http(2, [100, 0, 0, 0], '/health', '200'), http(2, [0, 3, 0, 0], '/orders/:id', '404'),
      // the legacy metric (milliseconds) for the same service must NOT be added on top of the stable one
      pt({ name: 'http.server.duration', type: 'histogram', temporality: 'delta', unit: 'ms', service: 'shop', time: at(1, 5), bounds: [100, 500, 1000], buckets: [999, 0, 0, 0], count: 999, sum: 1, attrs: lbl({ 'http.route': '/legacy' }) }),
      // a legacy-only service
      pt({ name: 'http.server.duration', type: 'histogram', temporality: 'delta', unit: 'ms', service: 'old-svc', time: at(1, 5), bounds: [100, 500, 1000], buckets: [0, 8, 2, 0], count: 10, sum: 2000, attrs: lbl({ 'http.route': '/x', 'http.status_code': '503' }) }),
    ], now);
  });
  test('requests, errors, status classes, routes and percentiles per service, in milliseconds', async () => {
    const o = await store.httpOverview(scope, at(0), at(10));
    const shop = o.services.find((s) => s.service === 'shop')!;
    expect(shop.metric).toBe('http.server.request.duration');
    expect(shop.requests).toBe(100 + 10 + 100 + 3);
    expect(shop.errors).toBe(10);
    expect(shop.statuses).toEqual({ '2xx': 200, '5xx': 10, '4xx': 3 });
    expect(shop.p95Ms).toBeGreaterThan(0);
    expect(shop.p95Ms!).toBeLessThanOrEqual(1000); // seconds converted to milliseconds, bucket top 1 s
    expect(shop.routes.map((r) => r.route)).toEqual(['/orders/:id', '/health']);
    expect(shop.routes[0]).toMatchObject({ requests: 113, errors: 10 });
    expect(shop.lastDataAt).toEqual(at(2));
    const tl = shop.timeline;
    expect(tl.find((p) => p.t === at(1).getTime() - (at(1).getTime() % o.stepMs))!.requests).toBeGreaterThan(0);
    expect(tl.some((p) => p.requests === null)).toBe(true); // windows without data are null
  });
  test('the legacy metric is not double counted when the stable one exists, and is used alone otherwise', async () => {
    const o = await store.httpOverview(scope, at(0), at(10));
    expect(o.services.find((s) => s.service === 'shop')!.routes.map((r) => r.route)).not.toContain('/legacy');
    const old = o.services.find((s) => s.service === 'old-svc')!;
    expect(old).toMatchObject({ metric: 'http.server.duration', requests: 10, errors: 10 });
    expect(old.p95Ms!).toBeGreaterThan(100); // already milliseconds
  });
  test('another tenant sees none of it', async () => {
    expect((await store.httpOverview({ orgId: OTHER, projectId: PROJECT, environmentIds: [ENV] }, at(0), at(10))).services).toEqual([]);
  });
});
