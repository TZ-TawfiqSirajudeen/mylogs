import { MetricQuery } from '@nexus/contracts';
import type { Database } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import type { MetricPointDraft } from '@nexus/telemetry';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { histogramQuantile } from './histogram.js';
import { MINUTE, processSeriesPoints, type MinuteAgg } from './process.js';
import { MetricQueryError, MongoMetricStore, seriesIdOf, type MetricContext, type Scope } from './store.js';

// The write path writes a minute document in ONE operation when the series state proves it does not exist yet, and increments an existing one
// without creating it first. These tests check that every route produces exactly the documents a plain reference aggregation would, for every
// temporality, in order and out of order, split into requests at arbitrary places (including the awkward case of a cumulative baseline and its
// first increase sharing a minute).

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let db: Database;
let store: MongoMetricStore;
const ORG = 'org-w', PROJECT = 'proj-w', ENV = '33333333-3333-4333-8333-333333333333';
const T0 = Math.floor(Date.parse('2026-03-01T12:00:00Z') / MINUTE) * MINUTE;
const now = new Date(T0 + 3_600_000);
const ctx: MetricContext = { orgId: ORG, projectId: PROJECT, environmentId: ENV, retentionMs: 30 * 86_400_000 };
const scope: Scope = { orgId: ORG, projectId: PROJECT, environmentIds: [ENV] };
const BOUNDS = [0.1, 0.5, 1];

beforeAll(async () => { mongo = await startTestMongo(); db = await freshTestDatabase(mongo.uri); store = new MongoMetricStore(db, { maxSeriesPerMetric: 2000 }); }, 240_000);
afterAll(async () => { await db?.close(); await mongo?.stop(); });

// small deterministic generator so a failure reproduces
const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

const base = (over: Partial<MetricPointDraft>): MetricPointDraft => ({
  name: 'wp', unit: null, description: null, type: 'gauge', temporality: null, monotonic: null, service: 'svc', serviceVersion: null, instance: 'i-1', attrs: [],
  time: new Date(T0), startTime: null, value: 0, count: 1, sum: 0, min: null, max: null, bounds: null, buckets: null, exemplars: [], ...over,
});

type Kind = 'gauge' | 'delta-sum' | 'cumulative-sum' | 'delta-hist' | 'cumulative-hist';
function points(kind: Kind, name: string, n: number, everySec: number, r: () => number): MetricPointDraft[] {
  const out: MetricPointDraft[] = [];
  let cumValue = 0; let cumBuckets = [0, 0, 0, 0]; let cumCount = 0; let cumSum = 0;
  for (let i = 0; i < n; i++) {
    const time = new Date(T0 + 7_000 + i * everySec * 1000);
    const v = Math.floor(r() * 20);
    const b = [Math.floor(r() * 5), Math.floor(r() * 5), Math.floor(r() * 5), Math.floor(r() * 5)];
    const dCount = b.reduce((a, c) => a + c, 0);
    if (kind === 'gauge') out.push(base({ name, type: 'gauge', time, value: v, sum: v }));
    else if (kind === 'delta-sum') out.push(base({ name, type: 'sum', temporality: 'delta', monotonic: true, time, value: v, sum: v }));
    else if (kind === 'cumulative-sum') { cumValue += v; out.push(base({ name, type: 'sum', temporality: 'cumulative', monotonic: true, time, startTime: new Date(T0 - 7_200_000), value: cumValue, sum: cumValue })); }
    else if (kind === 'delta-hist') out.push(base({ name, type: 'histogram', temporality: 'delta', time, bounds: BOUNDS, buckets: b, count: dCount, sum: dCount * 0.3, min: 0.01, max: 2 }));
    else { cumBuckets = cumBuckets.map((x, k) => x + b[k]!); cumCount += dCount; cumSum += dCount * 0.3; out.push(base({ name, type: 'histogram', temporality: 'cumulative', time, startTime: new Date(T0 - 7_200_000), bounds: BOUNDS, buckets: [...cumBuckets], count: cumCount, sum: cumSum })); }
  }
  return out;
}

/** What a plain, single-pass aggregation of all the points yields (the model the stored documents must equal). */
function reference(pts: MetricPointDraft[]): Map<number, MinuteAgg> {
  const sorted = [...pts].sort((a, b) => a.time.getTime() - b.time.getTime());
  const first = sorted[0]!;
  return processSeriesPoints({ type: first.type, temporality: first.temporality, monotonic: first.monotonic, bounds: first.bounds }, { lastPoint: null, cumulative: null, recent: [] }, sorted).aggs;
}

const norm = (v: unknown) => (v === undefined ? null : v);
async function expectDocsEqual(pts: MetricPointDraft[]) {
  const id = seriesIdOf(ctx, pts[0]!);
  const expected = [...reference(pts).values()].filter((a) => !(a.count === 0 && a.sum === 0 && !a.buckets)).sort((a, b) => a.minute - b.minute);
  const stored = await db.c.metricPoints.find({ seriesId: id }).sort({ minute: 1 }).toArray();
  expect(stored.map((d) => d.minute.getTime())).toEqual(expected.map((a) => a.minute));
  for (const [i, a] of expected.entries()) {
    const d = stored[i]!;
    expect({ count: d.count, sum: Math.round(d.sum * 1e9) / 1e9, min: norm(d.min), max: norm(d.max), buckets: norm(d.buckets), last: norm(d.last) }, `minute ${a.minute}`)
      .toEqual({ count: a.count, sum: Math.round(a.sum * 1e9) / 1e9, min: norm(a.min), max: norm(a.max), buckets: norm(a.buckets), last: norm(a.last) });
  }
}

/** Cuts a list into consecutive requests of random size. */
function split<T>(xs: T[], r: () => number): T[][] {
  const out: T[][] = []; let i = 0;
  while (i < xs.length) { const k = 1 + Math.floor(r() * 7); out.push(xs.slice(i, i + k)); i += k; }
  return out;
}

describe('minute documents equal the reference aggregation, whichever write route they took', () => {
  const kinds: Kind[] = ['gauge', 'delta-sum', 'cumulative-sum', 'delta-hist', 'cumulative-hist'];
  for (const kind of kinds) {
    test(`${kind}: in-order requests split at random places (several points per minute, baseline and first increase in one minute)`, async () => {
      for (const seed of [1, 2, 3]) {
        const name = `wp.inorder.${kind}.${seed}`;
        const r = rng(seed * 101 + kinds.indexOf(kind));
        const pts = points(kind, name, 70, 6, r); // ~7 minutes, 10 points per minute
        for (const req of split(pts, r)) await store.ingest(ctx, req, now);
        await expectDocsEqual(pts);
      }
    });
  }
  for (const kind of ['gauge', 'delta-sum', 'delta-hist'] as Kind[]) {
    test(`${kind}: requests arriving out of order (older minutes after newer ones) lose and double-count nothing`, async () => {
      for (const seed of [11, 12, 13]) {
        const name = `wp.shuffled.${kind}.${seed}`;
        const r = rng(seed * 977);
        const pts = points(kind, name, 70, 6, r);
        const shuffled = [...pts].sort(() => r() - 0.5);
        for (const req of split(shuffled, r)) await store.ingest(ctx, req, now);
        await expectDocsEqual(pts);
      }
    });
  }
  for (const kind of ['cumulative-sum', 'cumulative-hist'] as Kind[]) {
    test(`${kind}: a baseline alone in one request, then the first increase in the SAME minute in the next request, is not lost`, async () => {
      // The baseline moves the series' last point into this minute but writes no document; the next point must therefore create it.
      const pts = points(kind, `wp.baseline.${kind}`, 5, 6, rng(99));
      await store.ingest(ctx, [pts[0]!], now);
      expect(await db.c.metricPoints.countDocuments({ metric: `wp.baseline.${kind}` })).toBe(0);
      for (const p of pts.slice(1)) await store.ingest(ctx, [p], now); // one point per request: every route is exercised
      await expectDocsEqual(pts);
      expect(await db.c.metricPoints.countDocuments({ metric: `wp.baseline.${kind}` })).toBeGreaterThan(0);
    });
  }
  test('a retransmitted request changes no document (idempotent across all three routes)', async () => {
    const pts = points('delta-hist', 'wp.retransmit', 40, 6, rng(7));
    const reqs = split(pts, rng(8));
    for (const req of reqs) await store.ingest(ctx, req, now);
    const before = await db.c.metricPoints.find({ metric: 'wp.retransmit' }).sort({ minute: 1 }).toArray();
    for (const req of reqs) expect((await store.ingest(ctx, req, now)).accepted).toBe(0);
    expect(await db.c.metricPoints.find({ metric: 'wp.retransmit' }).sort({ minute: 1 }).toArray()).toEqual(before);
  });
  test('documents written by the single-operation route have the same fields as the incremental route (no null min/max, arrays only for histograms)', async () => {
    await store.ingest(ctx, [base({ name: 'wp.shape.sum', type: 'sum', temporality: 'delta', monotonic: true, time: new Date(T0 + 5000), value: 3, sum: 3 })], now);
    await store.ingest(ctx, [base({ name: 'wp.shape.sum', type: 'sum', temporality: 'delta', monotonic: true, time: new Date(T0 + 9000), value: 4, sum: 4 })], now);
    const sum = (await db.c.metricPoints.findOne({ metric: 'wp.shape.sum' }))!;
    expect(sum).toMatchObject({ count: 2, sum: 7, buckets: null, last: null, lastAt: null, exemplars: [] });
    expect('min' in sum || 'max' in sum).toBe(false);
    const h = points('delta-hist', 'wp.shape.hist', 2, 6, rng(3));
    await store.ingest(ctx, [h[0]!], now); await store.ingest(ctx, [h[1]!], now);
    const hist = (await db.c.metricPoints.findOne({ metric: 'wp.shape.hist' }))!;
    expect(hist.buckets).toHaveLength(BOUNDS.length + 1);
    expect(hist.count).toBe(h[0]!.count + h[1]!.count);
  });
});

describe('chunked parallel aggregation returns exactly what a single aggregation returns', () => {
  test('histogram percentiles, gauges (newest value wins), counters and the HTTP overview, with and without chunking', async () => {
    const r = rng(42);
    const pts: MetricPointDraft[] = [];
    const routes = ['/a', '/b', '/c', '/d'], codes = ['200', '500'];
    let uniq = 0; // unique timestamps per series: equal timestamps make "the newest value" a tie whose winner may legitimately differ
    for (let svc = 0; svc < 6; svc++) for (let inst = 0; inst < 3; inst++) for (const [ri, route] of routes.entries()) for (const code of codes) for (let m = 0, off = ++uniq * 13; m < 4; m++) {
      const b = [Math.floor(r() * 9), Math.floor(r() * 9), Math.floor(r() * 9), Math.floor(r() * 4)];
      const attrs = [{ k: 'http.route', v: route }, { k: 'http.response.status_code', v: code }];
      const common = { service: `svc-${svc}`, instance: `svc-${svc}-${inst}`, attrs, time: new Date(T0 + m * MINUTE + 5000 + off) };
      pts.push(base({ ...common, name: 'chunk.http.server.request.duration', type: 'histogram', temporality: 'delta', unit: 's', bounds: BOUNDS, buckets: b, count: b.reduce((a, c) => a + c, 0), sum: b.reduce((a, c) => a + c, 0) * 0.2 }));
      pts.push(base({ ...common, name: 'chunk.gauge', type: 'gauge', value: Math.floor(r() * 100), sum: 0 }));
      pts.push(base({ ...common, name: 'chunk.count', type: 'sum', temporality: 'delta', monotonic: true, value: Math.floor(r() * 10), sum: 0 }));
    }
    for (const p of pts) p.sum = p.type === 'histogram' ? p.sum : p.value;
    // the HTTP overview reads the standard metric name: store a copy under it too
    for (const p of pts.filter((x) => x.name === 'chunk.http.server.request.duration')) pts.push({ ...p, name: 'http.server.request.duration' });
    for (let i = 0; i < pts.length; i += 400) await store.ingest(ctx, pts.slice(i, i + 400), now);

    const whole = new MongoMetricStore(db, { chunkSeries: 1_000_000 });
    const chunked = new MongoMetricStore(db, { chunkSeries: 7 }); // forces many small parallel chunks
    const from = new Date(T0).toISOString(), to = new Date(T0 + 5 * MINUTE).toISOString();
    const q = (over: object) => MetricQuery.parse({ from, to, ...over });
    const strip = (x: unknown) => JSON.stringify(x, (k, v) => (k === 'exemplars' ? undefined : v));
    const cases = [
      q({ metric: 'chunk.http.server.request.duration', agg: 'p95' }), q({ metric: 'chunk.http.server.request.duration', agg: 'p99', groupBy: ['http.route'] }),
      q({ metric: 'chunk.http.server.request.duration', agg: 'rate', groupBy: ['service'] }), q({ metric: 'chunk.http.server.request.duration', agg: 'count', groupBy: ['http.route', 'http.response.status_code'] }),
      q({ metric: 'chunk.gauge', agg: 'last' }), q({ metric: 'chunk.gauge', agg: 'avg', groupBy: ['service'] }), q({ metric: 'chunk.gauge', agg: 'min' }), q({ metric: 'chunk.gauge', agg: 'max' }),
      q({ metric: 'chunk.count', agg: 'sum', groupBy: ['http.route'] }), q({ metric: 'chunk.count', agg: 'rate' }),
    ];
    for (const c of cases) {
      const a = await whole.query(scope, c), b = await chunked.query(scope, c);
      expect(strip(b), `${c.metric} ${c.agg} ${c.groupBy.join(',')}`).toEqual(strip(a));
      expect(a.series.some((s) => s.points.some((p) => p.v !== null))).toBe(true);
    }
    const oa = await whole.httpOverview(scope, new Date(T0), new Date(T0 + 5 * MINUTE)), ob = await chunked.httpOverview(scope, new Date(T0), new Date(T0 + 5 * MINUTE));
    expect(strip(ob)).toEqual(strip(oa));
    expect(oa.services).toHaveLength(6);
    expect(oa.services.every((s) => s.requests > 0 && s.p95Ms !== null)).toBe(true);
  });

  test('count, rate and avg of a histogram ignore bucket counts entirely (and still equal the percentile query\'s totals)', async () => {
    const from = new Date(T0).toISOString(), to = new Date(T0 + 5 * MINUTE).toISOString();
    const cnt = await store.query(scope, MetricQuery.parse({ from, to, metric: 'chunk.http.server.request.duration', agg: 'count' }));
    const total = cnt.series[0]!.points.reduce((n, p) => n + (p.v ?? 0), 0);
    const expected = (await db.c.metricPoints.find({ metric: 'chunk.http.server.request.duration' }).toArray()).reduce((n, d) => n + d.count, 0);
    expect(total).toBe(expected);
    expect(cnt.notes.join(' ')).not.toMatch(/estimated from histogram/); // no percentile was computed
  });
});

describe('the scan guard no longer counts when the answer cannot exceed the limit', () => {
  test('series x minutes within the limit: no count; above it: the real count decides (sparse data passes, dense data is refused)', async () => {
    const tight = new MongoMetricStore(db, { maxPointDocsScanned: 40 });
    await store.ingest(ctx, Array.from({ length: 5 }, (_, i) => base({ name: 'guard.g', time: new Date(T0 + 1000 + i * MINUTE), value: i, sum: i })), now);
    const wide = MetricQuery.parse({ from: new Date(T0).toISOString(), to: new Date(T0 + 59 * MINUTE).toISOString(), metric: 'guard.g', agg: 'max' });
    // 1 series x 60 minutes = 60 > 40: the real count (5 documents) is checked and allowed
    expect((await tight.query(scope, wide)).series[0]!.points.some((p) => p.v === 4)).toBe(true);
    // dense: 50 minutes of data for 1 series > 40 stored documents -> refused with advice
    await store.ingest(ctx, Array.from({ length: 50 }, (_, i) => base({ name: 'guard.dense', time: new Date(T0 + 1000 + i * MINUTE), value: i, sum: i })), now);
    const dense = MetricQuery.parse({ from: new Date(T0).toISOString(), to: new Date(T0 + 59 * MINUTE).toISOString(), metric: 'guard.dense', agg: 'max' });
    await expect(tight.query(scope, dense)).rejects.toBeInstanceOf(MetricQueryError);
    // a window small enough that ids x minutes <= limit passes without any count
    const small = MetricQuery.parse({ from: new Date(T0).toISOString(), to: new Date(T0 + 10 * MINUTE).toISOString(), metric: 'guard.dense', agg: 'max' });
    expect((await tight.query(scope, small)).series).toHaveLength(1);
  });
});

describe('two-stage window aggregation equals a plain recomputation from the stored documents', () => {
  test('gauges, counters and histograms, steps of 1, 7 and 26 minutes (not divisors of a day), several series', async () => {
    const r = rng(2026);
    const pts: MetricPointDraft[] = [];
    let seriesNo = 0; // a unique offset per series: with equal timestamps "the newest value" would be a tie, and either answer is right
    for (const svc of ['a', 'b']) for (const inst of [1, 2, 3]) for (const route of ['/x', '/y']) for (let i = 0, off = ++seriesNo * 11; i < 90 * 3; i++) {
      const common = { service: svc, instance: `${svc}${inst}`, attrs: [{ k: 'http.route', v: route }], time: new Date(T0 + 4_000 + i * 20_000 + off) };
      const v = Math.floor(r() * 50), b = [Math.floor(r() * 4), Math.floor(r() * 4), Math.floor(r() * 4), Math.floor(r() * 4)];
      pts.push(base({ ...common, name: 'oracle.g', type: 'gauge', value: v, sum: v }));
      pts.push(base({ ...common, name: 'oracle.c', type: 'sum', temporality: 'delta', monotonic: true, value: v, sum: v }));
      pts.push(base({ ...common, name: 'oracle.h', type: 'histogram', temporality: 'delta', unit: 's', bounds: BOUNDS, buckets: b, count: b.reduce((a, c) => a + c, 0), sum: b.reduce((a, c) => a + c, 0) * 0.25, min: 0.01, max: 3 }));
    }
    for (let i = 0; i < pts.length; i += 300) await store.ingest(ctx, pts.slice(i, i + 300), now);

    const from = new Date(T0), to = new Date(T0 + 89 * MINUTE);
    const mq = (over: object) => MetricQuery.parse({ from: from.toISOString(), to: to.toISOString(), ...over });
    for (const stepMin of [1, 7, 26]) {
      const docsOf = async (metric: string) => (await db.c.metricPoints.find({ metric, minute: { $gte: from, $lte: to } }).toArray());
      const windowOf = (m: Date, stepMs: number) => m.getTime() - (m.getTime() % stepMs);
      const check = async (metric: string, agg: string, expectFn: (docs: Awaited<ReturnType<typeof docsOf>>) => number | null) => {
        const res = await store.query(scope, mq({ metric, agg, stepSeconds: stepMin * 60 }));
        const stepMs = res.stepMs;
        const byWindow = new Map<number, Awaited<ReturnType<typeof docsOf>>>();
        for (const d of await docsOf(metric)) { const w = windowOf(d.minute, stepMs); byWindow.set(w, [...(byWindow.get(w) ?? []), d]); }
        const got = new Map(res.series[0]!.points.filter((p) => p.v !== null).map((p) => [p.t, p.v!]));
        expect(got.size, `${metric} ${agg} step ${stepMin}m: window count`).toBe(byWindow.size);
        for (const [w, docs] of byWindow) {
          const e = expectFn(docs);
          if (e === null) continue;
          expect(got.get(w), `${metric} ${agg} step ${stepMin}m window ${new Date(w).toISOString()}`).toBeCloseTo(e, 6);
        }
      };
      await check('oracle.g', 'min', (d) => Math.min(...d.map((x) => x.min!)));
      await check('oracle.g', 'max', (d) => Math.max(...d.map((x) => x.max!)));
      await check('oracle.g', 'count', (d) => d.reduce((n, x) => n + x.count, 0));
      await check('oracle.g', 'avg', (d) => d.reduce((n, x) => n + x.sum, 0) / d.reduce((n, x) => n + x.count, 0));
      await check('oracle.g', 'last', (d) => { const newest = d.reduce((a, x) => (x.lastAt!.getTime() > a.lastAt!.getTime() ? x : a)); return newest.last; });
      await check('oracle.c', 'sum', (d) => d.reduce((n, x) => n + x.sum, 0));
      await check('oracle.h', 'count', (d) => d.reduce((n, x) => n + x.count, 0));
      await check('oracle.h', 'p95', (d) => {
        const counts = BOUNDS.map((_, i) => 0).concat([0]).map((_, i) => d.reduce((n, x) => n + (x.buckets![i] ?? 0), 0));
        const mins = d.map((x) => x.min).filter((v): v is number => v !== null && v !== undefined), maxs = d.map((x) => x.max).filter((v): v is number => v !== null && v !== undefined);
        return histogramQuantile(BOUNDS, counts, 0.95, { min: mins.length ? Math.min(...mins) : null, max: maxs.length ? Math.max(...maxs) : null })?.value ?? null;
      });
    }
  });
});
