import { MetricQuery, type MetricQueryResult } from '@nexus/contracts';
import type { Database } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import type { MetricPointDraft } from '@nexus/telemetry';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { MINUTE } from './process.js';
import { CLAIM_SENTINEL, coverageOf, floorTo, HOUR, MetricRollupCompactor, planGroups, snapStep, type Piece, type PlanSeries } from './rollup.js';
import { MetricQueryError, MongoMetricStore, seriesIdOf, type MetricContext, type Scope } from './store.js';

/**
 * ORACLE tests for metric rollups (ADR-0007): every query type is answered twice on the same database, once by a store that never reads rollups
 * ("raw": the minute documents, the behaviour that was correct before rollups existed) and once by the store that plans over rollups, and the
 * answers must be identical (values within float rounding; percentiles are computed from integer bucket counts and match exactly). Data and queries are
 * random but seeded, so a failure names its seed. The scenarios cover resets, gaps, late and out-of-order data, histograms with different layouts,
 * windows and steps that do not line up with tier boundaries, writes racing the compactor, crashed compactors, backfill and rebuild.
 */
let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let db: Database;
beforeAll(async () => { mongo = await startTestMongo(); }, 240_000);
beforeEach(async () => { db = await freshTestDatabase(mongo.uri); await new MetricRollupCompactor(db).ensureIndexes(); }, 60_000); // every test has its own database
afterEach(async () => { await db?.close(); });
afterAll(async () => { await mongo?.stop(); });

const rng = (seed: number) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const T0 = Date.parse('2026-03-01T00:00:00Z');
const HISTORY_H = 30;
const NOW = T0 + HISTORY_H * HOUR;
const ENV = '44444444-4444-4444-8444-444444444444';
const B1 = [0.1, 0.5, 1], B2 = [0.2, 2], B3 = [0.01, 0.05, 0.1, 0.5, 1];

interface Spec { name: string; kind: 'gauge' | 'delta-sum' | 'cumulative-sum' | 'delta-hist' | 'cumulative-hist'; service: string; route: string; bounds?: number[]; unit?: string; status?: string; everySec: number }
const SPECS: Spec[] = [
  { name: 'r.gauge', kind: 'gauge', service: 'a', route: '/x', everySec: 170 },
  { name: 'r.gauge', kind: 'gauge', service: 'b', route: '/y', everySec: 230 },
  { name: 'r.count', kind: 'delta-sum', service: 'a', route: '/x', everySec: 90 },
  { name: 'r.count', kind: 'delta-sum', service: 'b', route: '/y', everySec: 400 },
  { name: 'r.cum', kind: 'cumulative-sum', service: 'a', route: '/x', everySec: 120 },
  { name: 'r.lat', kind: 'delta-hist', service: 'a', route: '/x', bounds: B1, everySec: 100 },
  { name: 'r.lat', kind: 'delta-hist', service: 'b', route: '/y', bounds: B2, everySec: 150 }, // a second bucket layout under the same metric name
  { name: 'r.cumlat', kind: 'cumulative-hist', service: 'a', route: '/x', bounds: B1, everySec: 130 },
  { name: 'http.server.request.duration', kind: 'delta-hist', service: 'a', route: '/x', bounds: B3, unit: 's', status: '200', everySec: 60 },
  { name: 'http.server.request.duration', kind: 'delta-hist', service: 'a', route: '/x', bounds: B3, unit: 's', status: '500', everySec: 300 },
  { name: 'http.server.request.duration', kind: 'delta-hist', service: 'b', route: '/y', bounds: B3, unit: 's', status: '200', everySec: 75 },
];

/** Produces the points of one series; cumulative series keep their running state (with random counter resets) across calls. */
class Gen {
  private cumV = 0; private cumB: number[]; private cumC = 0; private cumS = 0; private start = T0 - 3_600_000;
  constructor(readonly spec: Spec, private readonly r: () => number) { this.cumB = new Array((spec.bounds?.length ?? 0) + 1).fill(0); }
  point(time: number): MetricPointDraft {
    const { spec, r } = this;
    const base: MetricPointDraft = {
      name: spec.name, unit: spec.unit ?? null, description: null, type: 'gauge', temporality: null, monotonic: null, service: spec.service, serviceVersion: null, instance: `${spec.service}-1`,
      attrs: [{ k: 'http.route', v: spec.route }, ...(spec.status ? [{ k: 'http.response.status_code', v: spec.status }] : [])],
      time: new Date(time), startTime: null, value: 0, count: 1, sum: 0, min: null, max: null, bounds: null, buckets: null, exemplars: [],
    };
    const v = Math.floor(r() * 40) + (r() < 0.3 ? 0.5 : 0);
    const bk = () => (spec.bounds ?? []).concat([0]).map(() => Math.floor(r() * 6));
    switch (spec.kind) {
      case 'gauge': return { ...base, type: 'gauge', value: v, sum: v };
      case 'delta-sum': return { ...base, type: 'sum', temporality: 'delta', monotonic: true, value: v, sum: v };
      case 'cumulative-sum': {
        if (r() < 0.03) { this.cumV = 0; this.start = time; }
        this.cumV += v;
        return { ...base, type: 'sum', temporality: 'cumulative', monotonic: true, startTime: new Date(this.start), value: this.cumV, sum: this.cumV };
      }
      case 'delta-hist': { const b = bk(); const c = b.reduce((x, y) => x + y, 0); return { ...base, type: 'histogram', temporality: 'delta', bounds: spec.bounds!, buckets: b, count: c, sum: c * 0.3 + r(), min: 0.005 + r() * 0.01, max: 1 + r() * 3 }; }
      default: {
        if (r() < 0.03) { this.cumB = this.cumB.map(() => 0); this.cumC = 0; this.cumS = 0; this.start = time; }
        const b = bk(); this.cumB = this.cumB.map((x, i) => x + b[i]!); const c = b.reduce((x, y) => x + y, 0); this.cumC += c; this.cumS += c * 0.3;
        return { ...base, type: 'histogram', temporality: 'cumulative', bounds: spec.bounds!, buckets: [...this.cumB], count: this.cumC, sum: this.cumS, startTime: new Date(this.start) };
      }
    }
  }
}

/** In-order history for [from, to): per series an interval with jitter, random gaps and one long outage. Returns points sorted by time. */
function history(gens: Gen[], r: () => number, from: number, to: number): MetricPointDraft[] {
  const out: MetricPointDraft[] = [];
  for (const g of gens) {
    const outageAt = from + Math.floor(r() * (to - from) * 0.8), outageLen = Math.floor(r() * 4 * HOUR);
    let t = from + Math.floor(r() * g.spec.everySec * 1000);
    while (t < to) {
      if (!(t > outageAt && t < outageAt + outageLen) && r() > 0.12) out.push(g.point(t));
      t += Math.floor(g.spec.everySec * 1000 * (0.6 + r() * 0.9));
    }
  }
  return out.sort((a, b) => a.time.getTime() - b.time.getTime());
}

function mkCtx(org: string): { ctx: MetricContext; scope: Scope } {
  // retention is long on purpose: the data is from March 2026 and a short one would let the TTL monitor delete it in the middle of a test
  return { ctx: { orgId: org, projectId: 'p', environmentId: ENV, retentionMs: 3650 * 86_400_000 }, scope: { orgId: org, projectId: 'p', environmentIds: [ENV] } };
}
async function ingestAll(store: MongoMetricStore, ctx: MetricContext, pts: MetricPointDraft[], r: () => number) {
  for (let i = 0; i < pts.length;) { const k = 20 + Math.floor(r() * 180); await store.ingest(ctx, pts.slice(i, i + k), new Date(NOW)); i += k; }
}

const AGGS: Record<string, string[]> = {
  'r.gauge': ['avg', 'min', 'max', 'last', 'count', 'sum'], 'r.count': ['sum', 'rate'], 'r.cum': ['sum', 'rate'],
  'r.lat': ['count', 'sum', 'avg', 'rate', 'p50', 'p90', 'p95', 'p99', 'min', 'max'], 'r.cumlat': ['count', 'sum', 'avg', 'rate', 'p50', 'p95', 'p99'],
  'http.server.request.duration': ['count', 'avg', 'rate', 'p50', 'p95', 'p99'],
};
const pick = <T,>(r: () => number, xs: T[]) => xs[Math.floor(r() * xs.length)]!;
function randomQuery(r: () => number, horizon: number) {
  const metric = pick(r, Object.keys(AGGS));
  const dur = pick(r, [40 * MINUTE, 3 * HOUR + 17 * MINUTE, 7 * HOUR, 13 * HOUR + 11 * MINUTE, 26 * HOUR, 29.5 * HOUR]);
  const from = T0 + Math.floor(r() * 26 * HOUR / 1000) * 1000 + (r() < 0.5 ? 0 : 37_000);
  const to = Math.min(from + dur + Math.floor(r() * 90) * 1000, horizon + 2 * HOUR);
  return MetricQuery.parse({
    from: new Date(from).toISOString(), to: new Date(to).toISOString(), metric, agg: pick(r, AGGS[metric]!),
    groupBy: pick(r, [[], ['service'], ['http.route'], ['service', 'http.route']]),
    ...(r() < 0.25 ? { service: pick(r, ['a', 'b']) } : {}), ...(r() < 0.2 ? { filters: [{ key: 'http.route', value: pick(r, ['/x', '/y']) }] } : {}),
    ...(r() < 0.7 ? { stepSeconds: pick(r, [60, 300, 900, 1200, 3600, 7200, 420, 600]) } : {}),
  });
}

const close = (x: number | null, y: number | null) => (x === null || y === null ? x === y : Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x), Math.abs(y)));
function expectSame(fast: MetricQueryResult, raw: MetricQueryResult, label: string) {
  expect(fast.stepMs, label).toBe(raw.stepMs);
  expect(fast.truncated, label).toBe(raw.truncated);
  expect(fast.notes, label).toEqual(raw.notes);
  expect([fast.type, fast.agg, fast.unit], label).toEqual([raw.type, raw.agg, raw.unit]);
  const key = (s: { labels: Record<string, string> }) => JSON.stringify(s.labels);
  const f = [...fast.series].sort((a, b) => key(a).localeCompare(key(b))), w = [...raw.series].sort((a, b) => key(a).localeCompare(key(b)));
  expect(f.map(key), label).toEqual(w.map(key));
  f.forEach((s, i) => {
    expect(s.points.length, label).toBe(w[i]!.points.length);
    s.points.forEach((p, k) => {
      const q = w[i]!.points[k]!;
      expect(p.t, label).toBe(q.t);
      if (!close(p.v, q.v)) expect.fail(`${label}: series ${key(s)} at ${new Date(p.t).toISOString()}: rollup ${p.v} vs minute documents ${q.v}`);
    });
  });
}

/** Runs N random queries (and the HTTP overview) through both stores and compares. Returns how many of them read at least one rollup bucket. */
async function compare(opts: { raw: MongoMetricStore; fast: MongoMetricStore; plans: Piece[][]; scope: Scope; r: () => number; n: number; horizon: number; tag: string }): Promise<number> {
  let usedRollups = 0;
  for (let i = 0; i < opts.n; i++) {
    const q = randomQuery(opts.r, opts.horizon);
    opts.plans.length = 0;
    const [raw, fast] = [await opts.raw.query(opts.scope, q).catch((e) => e), await opts.fast.query(opts.scope, q).catch((e) => e)];
    if (opts.plans.some((p) => p.some((x) => x.tier !== 1))) usedRollups++;
    const label = `${opts.tag} query #${i} ${JSON.stringify({ ...q, from: q.from.slice(5, 19), to: q.to.slice(5, 19) })}`;
    if (raw instanceof Error || fast instanceof Error) { expect(String(fast), label).toBe(String(raw)); continue; }
    expectSame(fast, raw, label);
  }
  for (const [from, to] of [[NOW - 3 * HOUR, NOW], [NOW - 26 * HOUR - 13 * 60_000, NOW - 59_000], [T0 + 7 * HOUR, T0 + 8 * HOUR + 30 * MINUTE]] as [number, number][]) {
    opts.plans.length = 0;
    const raw = await opts.raw.httpOverview(opts.scope, new Date(from), new Date(to)), fast = await opts.fast.httpOverview(opts.scope, new Date(from), new Date(to));
    if (opts.plans.some((p) => p.some((x) => x.tier !== 1))) usedRollups++;
    expect(fast.stepMs).toBe(raw.stepMs);
    expect(fast.services.map((s) => [s.service, s.metric, s.requests, s.errors, s.p50Ms, s.p95Ms, s.p99Ms, s.statuses, s.routes, s.lastDataAt?.getTime() ?? null]), `${opts.tag} overview ${from}`)
      .toEqual(raw.services.map((s) => [s.service, s.metric, s.requests, s.errors, s.p50Ms, s.p95Ms, s.p99Ms, s.statuses, s.routes, s.lastDataAt?.getTime() ?? null]));
    expect(fast.services.map((s) => s.timeline), `${opts.tag} overview timeline ${from}`).toEqual(raw.services.map((s) => s.timeline));
  }
  return usedRollups;
}

describe('oracle: every query type through rollups equals the minute documents', () => {
  for (const seed of [1, 2, 3, 4]) {
    test(`seed ${seed}: history, then late and out-of-order data, then writers racing the compactor`, async () => {
      const r = rng(seed * 7919);
      const org = `org-oracle-${seed}`;
      const { ctx, scope } = mkCtx(org);
      const plans: Piece[][] = [];
      const raw = new MongoMetricStore(db, { rollups: false });
      const fast = new MongoMetricStore(db, { onPlan: (g) => { plans.push(g.flatMap((x) => x.pieces)); } });
      const compactor = new MetricRollupCompactor(db, { lagMs: 0, batch: 4 });
      const gens = SPECS.map((s) => new Gen(s, r));

      // ---- A: history. Nothing is rolled up yet: the planner must read minute documents only, and agree trivially.
      await ingestAll(fast, ctx, history(gens, r, T0, NOW), r);
      let used = await compare({ raw, fast, plans, scope, r, n: 12, horizon: NOW, tag: `seed ${seed} A (not compacted)` });
      expect(used, 'no rollup exists yet').toBe(0);
      expect(await compactor.pending(new Date(NOW))).toBeGreaterThan(0);

      // ---- B: compaction (backfill of the whole history), then the same queries
      const run = await compactor.runOnce(new Date(NOW), 120_000);
      expect(run.claimed).toBe(await db.c.metricSeries.countDocuments({ orgId: org }));
      expect(await compactor.pending(new Date(NOW))).toBe(0);
      used = await compare({ raw, fast, plans, scope, r, n: 40, horizon: NOW, tag: `seed ${seed} B (compacted)` });
      expect(used, 'rollups were actually used').toBeGreaterThan(10);

      // ---- C: LATE data (old minutes, accepted because their timestamps are new) makes the rollups stale: queries must not use them until recompacted
      const late: MetricPointDraft[] = [];
      for (let i = 0; i < 160; i++) {
        const g = pick(r, gens.filter((x) => x.spec.kind === 'gauge' || x.spec.kind === 'delta-sum' || x.spec.kind === 'delta-hist'));
        late.push(g.point(T0 + Math.floor(r() * (NOW - T0 - 5 * MINUTE)) + 1 + Math.floor(r() * 997)));
      }
      await ingestAll(fast, ctx, late, r);
      await compare({ raw, fast, plans, scope, r, n: 30, horizon: NOW, tag: `seed ${seed} C (late data, stale rollups)` });
      await compactor.runOnce(new Date(NOW), 120_000);
      expect(await compactor.pending(new Date(NOW))).toBe(0);
      used = await compare({ raw, fast, plans, scope, r, n: 30, horizon: NOW, tag: `seed ${seed} C (late data, recompacted)` });
      expect(used).toBeGreaterThan(8);

      // ---- D: new data and more late data arriving WHILE the compactor runs; compared whenever the writers are quiet (no final compaction first)
      for (let round = 0; round < 3; round++) {
        const horizon = NOW + (round + 1) * 40 * MINUTE;
        const fresh = history(gens, r, NOW + round * 40 * MINUTE, horizon);
        const lateAgain: MetricPointDraft[] = [];
        for (let i = 0; i < 60; i++) lateAgain.push(pick(r, gens.filter((x) => x.spec.kind === 'gauge' || x.spec.kind === 'delta-sum')).point(T0 + Math.floor(r() * (horizon - T0 - 10 * MINUTE)) + 3 + Math.floor(r() * 991)));
        const half = Math.floor(fresh.length / 2);
        await Promise.all([
          ingestAll(fast, ctx, fresh.slice(0, half).concat(lateAgain), rng(seed + round)),
          compactor.runOnce(new Date(horizon), 60_000),
          ingestAll(fast, ctx, fresh.slice(half), rng(seed * 3 + round)),
          compactor.runOnce(new Date(horizon), 60_000),
        ]);
        await compare({ raw, fast, plans, scope, r, n: 18, horizon, tag: `seed ${seed} D round ${round} (after racing the compactor)` });
      }
      await compactor.runOnce(new Date(NOW + 3 * HOUR), 120_000);
      const leftovers = await db.c.metricSeries.find({ orgId: org, $or: [{ rollWork: { $exists: true } }, { rollLease: { $exists: true } }, { rollFrom: { $exists: true } }] }).toArray();
      expect(leftovers.filter((s) => s.rollLease || s.rollWork || (s.rollFrom && s.rollFrom.getTime() < NOW)), 'every claim was released').toEqual([]);
      used = await compare({ raw, fast, plans, scope, r, n: 30, horizon: NOW + 3 * HOUR, tag: `seed ${seed} E (final)` });
      expect(used).toBeGreaterThan(8);
    }, 600_000);
  }
});

describe('rollup documents', () => {
  test('are the exact sums of their minute documents, tenant-scoped, and expire with the data', async () => {
    const r = rng(77);
    const { ctx, scope } = mkCtx('org-docs');
    const other = mkCtx('org-docs-other');
    const store = new MongoMetricStore(db);
    const compactor = new MetricRollupCompactor(db, { lagMs: 0 });
    for (const c of [ctx, other.ctx]) await ingestAll(store, c, history(SPECS.map((s) => new Gen(s, r)), r, T0, T0 + 8 * HOUR), r);
    await compactor.runOnce(new Date(T0 + 9 * HOUR), 120_000);
    const sids = (await db.c.metricSeries.find({ orgId: ctx.orgId }).toArray()).map((s) => s._id);
    const rollups = await db.c.metricRollups.find({ seriesId: { $in: sids } }).toArray();
    expect(rollups.length).toBeGreaterThan(100);
    expect(new Set(rollups.map((d) => d.orgId))).toEqual(new Set([ctx.orgId]));
    expect(new Set(rollups.map((d) => d.tier))).toEqual(new Set([5, 60]));
    for (const d of rollups.slice(0, 400)) {
      const size = d.tier * MINUTE;
      const mins = await db.c.metricPoints.find({ seriesId: d.seriesId, minute: { $gte: d.minute, $lt: new Date(d.minute.getTime() + size) } }).toArray();
      expect(d.minute.getTime() % size).toBe(0);
      expect(mins.length).toBeGreaterThan(0);
      expect(d.count).toBe(mins.reduce((n, m) => n + m.count, 0));
      expect(d.sum).toBeCloseTo(mins.reduce((n, m) => n + m.sum, 0), 6);
      expect(d.lastMinute.getTime()).toBe(Math.max(...mins.map((m) => m.minute.getTime())));
      expect(d.expireAt.getTime()).toBe(Math.max(...mins.map((m) => m.expireAt.getTime())));
      if (mins[0]!.buckets) expect(d.buckets).toEqual(mins[0]!.buckets.map((_, i) => mins.reduce((n, m) => n + (m.buckets?.[i] ?? 0), 0)));
    }
    // a query for one tenant never touches the other tenant's rollups, and answers like the minute documents
    const raw = new MongoMetricStore(db, { rollups: false });
    const q = MetricQuery.parse({ from: new Date(T0 + HOUR).toISOString(), to: new Date(T0 + 7 * HOUR).toISOString(), metric: 'r.count', agg: 'sum', stepSeconds: 3600 });
    expectSame(await store.query(scope, q), await raw.query(scope, q), 'tenant');
    expect((await store.query({ ...scope, orgId: 'org-docs-nobody' }, q)).series).toEqual([]);
  });

  test('a compaction is idempotent and a full rebuild reproduces identical documents', async () => {
    const r = rng(5);
    const { ctx } = mkCtx('org-idem');
    const store = new MongoMetricStore(db);
    const compactor = new MetricRollupCompactor(db, { lagMs: 0 });
    await ingestAll(store, ctx, history(SPECS.slice(0, 8).map((s) => new Gen(s, r)), r, T0, T0 + 6 * HOUR), r);
    const snapshot = async () => (await db.c.metricRollups.find({ orgId: ctx.orgId }).sort({ _id: 1 }).toArray());
    await compactor.runOnce(new Date(T0 + 7 * HOUR));
    const first = await snapshot();
    expect(first.length).toBeGreaterThan(50);
    await compactor.runOnce(new Date(T0 + 7 * HOUR));
    expect(await snapshot()).toEqual(first);
    expect(await compactor.requestRebuild({ orgId: ctx.orgId })).toBeGreaterThan(0);
    // while a rebuild is pending the planner reads minute documents only
    const plans: Piece[][] = [];
    const watching = new MongoMetricStore(db, { onPlan: (g) => { plans.push(g.flatMap((x) => x.pieces)); } });
    await watching.query(mkCtx('org-idem').scope, MetricQuery.parse({ from: new Date(T0).toISOString(), to: new Date(T0 + 6 * HOUR).toISOString(), metric: 'r.count', stepSeconds: 3600 }));
    expect(plans.every((p) => p.every((x) => x.tier === 1))).toBe(true);
    await compactor.runOnce(new Date(T0 + 7 * HOUR));
    expect(await snapshot()).toEqual(first);
  });

  test('a rollup whose minute documents are all gone does not survive a recomputation', async () => {
    const r = rng(6);
    const { ctx } = mkCtx('org-gone');
    const store = new MongoMetricStore(db);
    const compactor = new MetricRollupCompactor(db, { lagMs: 0 });
    const g = new Gen(SPECS[2]!, r);
    await ingestAll(store, ctx, Array.from({ length: 240 }, (_, k) => g.point(T0 + k * MINUTE + 500)), r); // one point a minute, no gaps
    await compactor.runOnce(new Date(T0 + 5 * HOUR));
    const sid = (await db.c.metricSeries.findOne({ orgId: ctx.orgId }))!._id;
    const before = await db.c.metricRollups.countDocuments({ seriesId: sid, tier: 5 });
    await db.c.metricPoints.deleteMany({ seriesId: sid, minute: { $gte: new Date(T0 + HOUR), $lt: new Date(T0 + 2 * HOUR) } });
    await compactor.requestRebuild({ seriesIds: [sid] });
    await compactor.runOnce(new Date(T0 + 5 * HOUR));
    expect(await db.c.metricRollups.countDocuments({ seriesId: sid, tier: 5, minute: { $gte: new Date(T0 + HOUR), $lt: new Date(T0 + 2 * HOUR) } })).toBe(0);
    expect(await db.c.metricRollups.countDocuments({ seriesId: sid, tier: 5 })).toBeLessThan(before);
  });
});

describe('backfill, resumption and failure', () => {
  test('series that existed before rollups (no markers, no coverage) are found, backfilled in chunks, and answered identically', async () => {
    const r = rng(9);
    const { ctx, scope } = mkCtx('org-backfill');
    const store = new MongoMetricStore(db);
    const raw = new MongoMetricStore(db, { rollups: false });
    const plans: Piece[][] = [];
    const fast = new MongoMetricStore(db, { onPlan: (g) => { plans.push(g.flatMap((x) => x.pieces)); } });
    await ingestAll(store, ctx, history(SPECS.map((s) => new Gen(s, r)), r, T0, NOW), r);
    // make them look like data written by the version before rollups: no markers, no coverage
    await db.c.metricSeries.updateMany({ orgId: ctx.orgId }, { $unset: { rollFrom: '', rolled5: '', rolled60: '' } });
    const compactor = new MetricRollupCompactor(db, { lagMs: 0, batch: 3 });
    expect(await compactor.pending(new Date(NOW))).toBe(0);
    expect(await compactor.markUnrolled()).toBe(SPECS.length);
    expect(await compactor.markUnrolled()).toBe(0); // idempotent
    const res = await compactor.runOnce(new Date(NOW), 120_000);
    expect(res.claimed).toBe(SPECS.length);
    expect(res.rounds).toBeGreaterThan(1); // the 5-minute tier is chunked by day: 30 h = 2 chunks
    expect(await compare({ raw, fast, plans, scope, r, n: 30, horizon: NOW, tag: 'backfill' })).toBeGreaterThan(8);
    const s = (await db.c.metricSeries.find({ orgId: ctx.orgId }).toArray());
    expect(s.every((x) => x.rolled5 && x.rolled60 && !x.rollFrom && !x.rollWork && !x.rollLease)).toBe(true);
  });

  test('a compactor that dies after claiming leaves queries correct; another one resumes after the lease expires', async () => {
    const r = rng(10);
    const { ctx, scope } = mkCtx('org-crash');
    const store = new MongoMetricStore(db);
    const raw = new MongoMetricStore(db, { rollups: false });
    const plans: Piece[][] = [];
    const fast = new MongoMetricStore(db, { onPlan: (g) => { plans.push(g.flatMap((x) => x.pieces)); } });
    const gens = SPECS.slice(0, 7).map((s) => new Gen(s, r));
    await ingestAll(store, ctx, history(gens, r, T0, T0 + 12 * HOUR), r);
    const a = new MetricRollupCompactor(db, { lagMs: 0, leaseMs: 1_000, owner: 'dies' });
    await a.runOnce(new Date(T0 + 13 * HOUR));
    // late data, then a claim that is never completed
    await ingestAll(store, ctx, [gens[2]!.point(T0 + 2 * HOUR + 1234), gens[5]!.point(T0 + 3 * HOUR + 4321), gens[0]!.point(T0 + 5 * HOUR + 777)], r);
    const claimed = await (a as unknown as { claim(now: Date, sealed5: number): Promise<unknown[]> }).claim(new Date(T0 + 13 * HOUR), floorTo(T0 + 13 * HOUR, 5 * MINUTE));
    expect(claimed.length).toBe(3);
    const mid = await db.c.metricSeries.find({ orgId: ctx.orgId, rollLease: { $exists: true } }).toArray();
    expect(mid.every((x) => x.rollFrom?.getTime() === CLAIM_SENTINEL.getTime() && x.rollWork)).toBe(true);
    await compare({ raw, fast, plans, scope, r, n: 25, horizon: NOW, tag: 'abandoned claim' });
    // the lease has not expired: another compactor leaves the series alone
    const b = new MetricRollupCompactor(db, { lagMs: 0, owner: 'takes-over' });
    expect((await b.runOnce(new Date(T0 + 13 * HOUR - 500))).claimed).toBe(0);
    expect((await b.runOnce(new Date(T0 + 13 * HOUR + 5_000))).claimed).toBe(3);
    expect(await db.c.metricSeries.countDocuments({ orgId: ctx.orgId, $or: [{ rollWork: { $exists: true } }, { rollLease: { $exists: true } }, { rollFrom: { $exists: true } }] })).toBe(0);
    expect(await compare({ raw, fast, plans, scope, r, n: 25, horizon: NOW, tag: 'after resume' })).toBeGreaterThan(5);
  });

  test('cardinality limits still apply and refused series never get rollups', async () => {
    const { ctx, scope } = mkCtx('org-card');
    const store = new MongoMetricStore(db, { maxSeriesPerMetric: 3 });
    const pts = Array.from({ length: 6 }, (_, i) => new Gen({ name: 'card.m', kind: 'delta-sum', service: 'a', route: `/r${i}`, everySec: 60 }, rng(i + 1)).point(T0 + 10 * MINUTE + i * 1000));
    const res = await store.ingest(ctx, pts, new Date(NOW));
    expect([res.accepted, res.rejected]).toEqual([3, 3]);
    const c = new MetricRollupCompactor(db, { lagMs: 0 });
    await c.runOnce(new Date(T0 + 3 * HOUR));
    const ids = new Set((await db.c.metricRollups.find({ orgId: ctx.orgId }).toArray()).map((d) => d.seriesId));
    expect(ids.size).toBe(3);
    expect(await db.c.metricSeries.countDocuments({ orgId: ctx.orgId })).toBe(3);
    expect((await store.query(scope, MetricQuery.parse({ from: new Date(T0).toISOString(), to: new Date(T0 + 2 * HOUR).toISOString(), metric: 'card.m', stepSeconds: 3600, groupBy: ['http.route'] }))).series).toHaveLength(3);
  });

  test('the scan guard counts rollup buckets: a long window the minute documents could not serve is allowed once rolled up, and refused before', async () => {
    const { ctx, scope } = mkCtx('org-guard');
    const small = new MongoMetricStore(db, { maxPointDocsScanned: 1_500 });
    const r = rng(12);
    const gens = Array.from({ length: 8 }, (_, i) => new Gen({ name: 'guard.m', kind: 'delta-sum', service: 'a', route: `/r${i}`, everySec: 60 }, r));
    await ingestAll(small, ctx, history(gens, r, T0, T0 + 12 * HOUR), r);
    const q = MetricQuery.parse({ from: new Date(T0).toISOString(), to: new Date(T0 + 12 * HOUR).toISOString(), metric: 'guard.m', stepSeconds: 3600 });
    await expect(small.query(scope, q)).rejects.toBeInstanceOf(MetricQueryError); // 8 series x 720 minutes = 5,760 > 1,500
    await new MetricRollupCompactor(db, { lagMs: 0 }).runOnce(new Date(T0 + 13 * HOUR));
    expect((await small.query(scope, q)).series).toHaveLength(1); // 8 x 12 hourly buckets (+ edges)
    await expect(new MongoMetricStore(db, { maxPointDocsScanned: 1_500, rollups: false }).query(scope, q)).rejects.toBeInstanceOf(MetricQueryError);
  });

  test('exemplars read from rollups are real exemplars of the window', async () => {
    const { ctx, scope } = mkCtx('org-ex');
    const store = new MongoMetricStore(db);
    const r = rng(14);
    const g = new Gen({ name: 'ex.lat', kind: 'delta-hist', service: 'a', route: '/x', bounds: B1, everySec: 60 }, r);
    const pts = history([g], r, T0, T0 + 3 * HOUR).map((p, i) => ({ ...p, exemplars: [{ traceId: `trace-${i}`.padEnd(32, '0'), spanId: null, value: 0.2, ts: p.time }] }));
    await ingestAll(store, ctx, pts, r);
    await new MetricRollupCompactor(db, { lagMs: 0 }).runOnce(new Date(T0 + 4 * HOUR));
    const res = await store.query(scope, MetricQuery.parse({ from: new Date(T0).toISOString(), to: new Date(T0 + 3 * HOUR).toISOString(), metric: 'ex.lat', agg: 'p95', stepSeconds: 3600 }));
    const known = new Set(pts.map((p) => p.exemplars[0]!.traceId));
    expect(res.series[0]!.exemplars.length).toBeGreaterThan(0);
    for (const e of res.series[0]!.exemplars) expect(known.has(e.traceId)).toBe(true);
  });

  test('the write path only adds a marker to the series update (no extra operation) and keeps it across requests', async () => {
    const { ctx } = mkCtx('org-marker');
    const store = new MongoMetricStore(db);
    const g = new Gen({ name: 'mk.m', kind: 'delta-sum', service: 'a', route: '/x', everySec: 60 }, rng(3));
    await store.ingest(ctx, [g.point(T0 + 10 * MINUTE + 5000)], new Date(NOW));
    await store.ingest(ctx, [g.point(T0 + 12 * MINUTE + 5000)], new Date(NOW));
    let s = (await db.c.metricSeries.findOne({ orgId: ctx.orgId }))!;
    expect(s.rollFrom?.getTime()).toBe(T0 + 10 * MINUTE); // earliest minute since the last claim
    await store.ingest(ctx, [g.point(T0 + 3 * MINUTE + 1234)], new Date(NOW)); // late
    s = (await db.c.metricSeries.findOne({ orgId: ctx.orgId }))!;
    expect(s.rollFrom?.getTime()).toBe(T0 + 3 * MINUTE);
    expect(s.rolled5).toBeUndefined();
    expect(seriesIdOf(ctx, g.point(T0))).toBe(s._id);
  });
});

describe('the planner (pure)', () => {
  const S = (over: Partial<PlanSeries> & { id?: string } = {}): PlanSeries => ({ _id: over.id ?? 's', lastPoint: new Date(T0 + 40 * HOUR), ...over });

  test('step snapping keeps windows a whole number of buckets and never makes a step finer', () => {
    for (const m of [1, 2]) expect(snapStep(m * MINUTE)).toBe(m * MINUTE);
    expect(snapStep(3 * MINUTE)).toBe(5 * MINUTE);
    expect(snapStep(4 * MINUTE)).toBe(5 * MINUTE);
    expect(snapStep(11 * MINUTE)).toBe(15 * MINUTE);
    expect(snapStep(26 * MINUTE)).toBe(HOUR);
    expect(snapStep(61 * MINUTE)).toBe(2 * HOUR);
    for (let m = 1; m < 3000; m += 7) expect(snapStep(m * MINUTE)).toBeGreaterThanOrEqual(m * MINUTE);
  });

  test('coverage: nothing without a watermark, lowered by pending markers, unlimited when no data can lie above it', () => {
    const rolled = new Date(T0 + 10 * HOUR);
    expect(coverageOf(S(), 5)).toBe(0);
    expect(coverageOf(S({ rolled5: rolled }), 5)).toBe(rolled.getTime());
    expect(coverageOf(S({ rolled5: rolled, rollFrom: new Date(T0 + 3 * HOUR + 7 * MINUTE) }), 5)).toBe(T0 + 3 * HOUR + 5 * MINUTE);
    expect(coverageOf(S({ rolled60: rolled, rollWork: new Date(T0 + 3 * HOUR + 7 * MINUTE) }), 60)).toBe(T0 + 3 * HOUR);
    expect(coverageOf(S({ rolled5: rolled, rollFrom: CLAIM_SENTINEL }), 5)).toBe(rolled.getTime()); // a claimed-and-idle marker is not a dirty minute
    expect(coverageOf(S({ rolled5: rolled, lastPoint: new Date(T0 + 9 * HOUR) }), 5)).toBe(Number.POSITIVE_INFINITY);
    expect(coverageOf(S({ rolled5: rolled, lastPoint: new Date(T0 + 9 * HOUR), rollFrom: new Date(T0 + 2 * HOUR) }), 5)).toBe(T0 + 2 * HOUR);
  });

  test('random series states: pieces tile the range exactly, are aligned, divide the step, and never exceed any series\' coverage', () => {
    const r = rng(2024);
    for (let it = 0; it < 4000; it++) {
      const from = T0 + Math.floor(r() * 20 * HOUR / MINUTE) * MINUTE, end = from + (1 + Math.floor(r() * 3000)) * MINUTE;
      const step = r() < 0.2 ? null : pick(r, [MINUTE, 5 * MINUTE, 15 * MINUTE, 20 * MINUTE, HOUR, 2 * HOUR, 7 * MINUTE, 90 * MINUTE]);
      const series: PlanSeries[] = Array.from({ length: 1 + Math.floor(r() * 12) }, (_, i) => S({
        id: `s${i}`, lastPoint: new Date(T0 + Math.floor(r() * 60 * HOUR)),
        ...(r() < 0.8 ? { rolled5: new Date(T0 + Math.floor(r() * 50 * HOUR)) } : {}), ...(r() < 0.8 ? { rolled60: new Date(T0 + Math.floor(r() * 50 * HOUR)) } : {}),
        ...(r() < 0.3 ? { rollFrom: new Date(T0 + Math.floor(r() * 50 * HOUR)) } : {}), ...(r() < 0.2 ? { rollWork: new Date(T0 + Math.floor(r() * 50 * HOUR)) } : {}),
      }));
      const groups = planGroups(series, from, end, step, { maxGroups: 1 + Math.floor(r() * 3) });
      expect(groups.flatMap((g) => g.series.map((s) => s._id)).sort()).toEqual(series.map((s) => s._id).sort());
      for (const g of groups) {
        let at = from;
        for (const p of g.pieces) {
          expect(p.lo).toBe(at); expect(p.hi).toBeGreaterThan(p.lo); at = p.hi;
          if (p.tier !== 1) {
            const size = p.tier * MINUTE;
            expect(p.lo % size).toBe(0); expect(p.hi % size).toBe(0);
            if (step !== null) expect(step % size).toBe(0);
            for (const s of g.series) expect(coverageOf(s, p.tier)).toBeGreaterThanOrEqual(p.hi);
          }
        }
        expect(at).toBe(end);
      }
    }
  });

  test('disabled rollups plan minute documents only', () => {
    const s = [S({ rolled5: new Date(T0 + 10 * HOUR), rolled60: new Date(T0 + 10 * HOUR), lastPoint: new Date(T0 + HOUR) })];
    expect(planGroups(s, T0, T0 + 5 * HOUR, HOUR, { enabled: false })[0]!.pieces).toEqual([{ tier: 1, lo: T0, hi: T0 + 5 * HOUR }]);
    expect(planGroups(s, T0, T0 + 5 * HOUR, HOUR)[0]!.pieces.some((p) => p.tier === 60)).toBe(true);
  });
});
