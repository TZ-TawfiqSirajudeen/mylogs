import { randomUUID } from 'node:crypto';
import type { Database, MetricRollupDoc, MetricSeriesDoc } from '@nexus/database';
import { MINUTE } from './process.js';

/**
 * Metric rollups (ADR-0007): coarser copies of the per-series per-minute documents, so long windows read 5x to 60x fewer documents.
 *
 * FRESHNESS / INVALIDATION (the part that must be right):
 *  - The write path never touches a rollup. In the SAME update that already changes the series state it does `$min: { rollFrom: <earliest minute written> }`.
 *    The series document is therefore a durable, atomic "something changed from minute X on" marker: it commits together with the minute documents
 *    it describes (one transaction) and a concurrent write conflicts and retries, exactly as for the rest of the series state.
 *  - A compactor (see `MetricRollupCompactor`) claims marked series, recomputes every bucket from the first changed one up to the sealed boundary
 *    from the minute documents (idempotent: a bucket is REPLACED by its recomputation, never incremented), then publishes `rolled5/rolled60`.
 *  - A reader trusts a rollup only below `cut = min(rolled, floor(earliest pending marker))` of each series, and reads the minute documents for
 *    everything above. So late data, a crashed compactor, a half-finished backfill or a missing rollup can only make a query slower, never wrong.
 */
export const HOUR = 60 * MINUTE;
/** Rollup tiers in minutes, coarsest first. */
export const ROLLUP_TIERS = [60, 5] as const;
export type RollupTier = (typeof ROLLUP_TIERS)[number];
/** A claimed series carries this "pending" value in `rollFrom`, so the pending index still finds it if the claimant dies. */
export const CLAIM_SENTINEL = new Date('9999-01-01T00:00:00.000Z');

/** One time range of a query plan: minute documents (tier 1) or rollup buckets of the given tier, `lo` inclusive, `hi` exclusive, both in ms. */
export interface Piece { tier: 1 | RollupTier; lo: number; hi: number }
export interface PlanGroup<S extends PlanSeries = PlanSeries> { series: S[]; pieces: Piece[] }
export type PlanSeries = Pick<MetricSeriesDoc, '_id' | 'lastPoint' | 'rolled5' | 'rolled60' | 'rollFrom' | 'rollWork'>;

export const floorTo = (t: number, size: number) => Math.floor(t / size) * size;
export const ceilTo = (t: number, size: number) => Math.ceil(t / size) * size;

/**
 * Step snapping: a window must be a whole number of rollup buckets, so automatic steps are rounded UP to 5 minutes (from 3) and to 1 hour (from 25
 * minutes). Never finer than requested, so the points-per-series limit still holds.
 */
export function snapStep(stepMs: number): number {
  if (stepMs < 3 * MINUTE) return stepMs;
  return stepMs < 25 * MINUTE ? ceilTo(stepMs, 5 * MINUTE) : ceilTo(stepMs, HOUR);
}

/**
 * Up to which instant (exclusive, ms) the tier can be trusted for this series: everything BEFORE it is covered by rollups that are known to be
 * current. 0 = not at all; Infinity = the series has no minute document at or after any instant the rollup could miss.
 */
export function coverageOf(s: PlanSeries, tier: RollupTier): number {
  const rolled = tier === 5 ? s.rolled5 : s.rolled60;
  if (!rolled) return 0;
  let cut = floorTo(rolled.getTime(), tier * MINUTE);
  for (const d of [s.rollFrom, s.rollWork]) if (d && d.getTime() < CLAIM_SENTINEL.getTime()) cut = Math.min(cut, floorTo(d.getTime(), tier * MINUTE));
  // Minute documents never lie beyond the minute of the newest accepted point: nothing exists above the cut, so nothing can be missing.
  const newest = s.lastPoint.getTime() > 0 ? floorTo(s.lastPoint.getTime(), MINUTE) : -1;
  return newest < cut ? Number.POSITIVE_INFINITY : cut;
}

/** Cuts [lo, hi) into rollup pieces (coarse tiers in the middle) and minute-document pieces (the edges and whatever the rollups do not cover). */
function cover(lo: number, hi: number, tiers: RollupTier[], cuts: Map<RollupTier, number>, out: Piece[]): void {
  if (lo >= hi) return;
  const [tier, ...rest] = tiers;
  if (tier === undefined) { out.push({ tier: 1, lo, hi }); return; }
  const size = tier * MINUTE;
  const a = ceilTo(lo, size), b = Math.min(floorTo(hi, size), cuts.get(tier) ?? 0);
  if (a < b) { cover(lo, a, rest, cuts, out); out.push({ tier, lo: a, hi: b }); cover(b, hi, rest, cuts, out); } else cover(lo, hi, rest, cuts, out);
}

/**
 * The query planner. Reads minute documents in [from, endExclusive) (ms), choosing for each series the coarsest tiers it can use:
 *  - `stepMs` set: query windows are `stepMs` long and aligned to multiples of it, so only tiers that divide the step are usable (a bucket must lie
 *    inside ONE window). `null`: no windows (totals), every tier is usable.
 *  - a tier is used only on whole buckets inside the range and below the series' coverage; the rest is read from the next finer tier or the minute docs.
 * Series with the same plan share one group. At most `maxGroups` distinct plans are kept (the rest read minute documents): bounded planning cost
 * and bounded number of pipelines, whatever the state of the series.
 */
export function planGroups<S extends PlanSeries>(series: S[], from: number, endExclusive: number, stepMs: number | null, opts: { enabled?: boolean; maxGroups?: number } = {}): PlanGroup<S>[] {
  const raw: Piece[] = endExclusive > from ? [{ tier: 1, lo: from, hi: endExclusive }] : [];
  const tiers = ROLLUP_TIERS.filter((t) => opts.enabled !== false && (stepMs === null || stepMs % (t * MINUTE) === 0));
  if (!tiers.length || endExclusive <= from) return series.length ? [{ series, pieces: raw }] : [];
  const bounds = new Map(tiers.map((t) => [t, { a: ceilTo(from, t * MINUTE), b: floorTo(endExclusive, t * MINUTE) }] as const));
  const byKey = new Map<string, { series: S[]; cuts: Map<RollupTier, number> }>();
  for (const s of series) {
    const cuts = new Map<RollupTier, number>();
    for (const t of tiers) { const r = bounds.get(t)!; cuts.set(t, Math.min(Math.max(coverageOf(s, t), r.a), r.b)); } // clamped: equal plans share a key
    const key = tiers.map((t) => cuts.get(t)).join('|');
    const g = byKey.get(key);
    if (g) g.series.push(s); else byKey.set(key, { series: [s], cuts });
  }
  const groups = [...byKey.values()].sort((x, y) => y.series.length - x.series.length);
  const maxGroups = opts.maxGroups ?? 3;
  const out: PlanGroup<S>[] = [];
  const leftovers: S[] = [];
  groups.forEach((g, i) => {
    if (i >= maxGroups) { leftovers.push(...g.series); return; }
    const pieces: Piece[] = [];
    cover(from, endExclusive, tiers, g.cuts, pieces);
    out.push({ series: g.series, pieces });
  });
  if (leftovers.length) out.push({ series: leftovers, pieces: raw });
  return out;
}

/** Upper bound of the documents a plan group reads (series x buckets): the cheap half of the scan guard. */
export const pieceDocs = (p: Piece) => Math.ceil((p.hi - p.lo) / ((p.tier === 1 ? 1 : p.tier) * MINUTE));

// ============================================================================================================== the compactor
export interface RollupRunResult { claimed: number; buckets5: number; buckets60: number; removed: number; rounds: number }
export interface CompactorOptions {
  /** A bucket is rolled up only once it ended this long ago (not a correctness rule: late data is handled by the markers). Default 2 minutes. */
  lagMs?: number;
  /** Series claimed and processed together. */
  batch?: number;
  leaseMs?: number;
  owner?: string;
}
const CHUNK: Record<RollupTier, number> = { 5: 24 * HOUR, 60: 7 * 24 * HOUR };

/** `full`: a first build or an operator rebuild (stale buckets whose minute documents are gone must be removed); a routine recomputation skips that. */
interface Job { s: MetricSeriesDoc; tier: RollupTier; cur: number; hi: number; full: boolean }

export class MetricRollupCompactor {
  private readonly lagMs: number;
  private readonly batch: number;
  private readonly leaseMs: number;
  private readonly owner: string;
  constructor(private readonly db: Database, opts: CompactorOptions = {}) {
    this.lagMs = opts.lagMs ?? 2 * MINUTE;
    this.batch = opts.batch ?? 50;
    this.leaseMs = opts.leaseMs ?? 5 * MINUTE;
    this.owner = opts.owner ?? randomUUID();
  }

  /** Idempotent; the same definitions as migration v30 (a deployment whose application user may not create indexes relies on the migration). */
  async ensureIndexes(): Promise<void> {
    await this.db.c.metricRollups.createIndex({ seriesId: 1, tier: 1, minute: 1 }, { name: 'mroll_series_tier_minute' });
    await this.db.c.metricRollups.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0, name: 'mroll_ttl' });
    await this.db.c.metricSeries.createIndex({ rollFrom: 1 }, { name: 'mseries_roll_pending', partialFilterExpression: { rollFrom: { $exists: true } } });
  }

  /**
   * Backfill discovery: marks every series that has never been rolled up and has no pending marker (series that existed before rollups did).
   * Series created later carry a marker from their first write. Safe to call repeatedly.
   */
  async markUnrolled(): Promise<number> {
    const r = await this.db.c.metricSeries.updateMany({ rolled5: { $exists: false }, rollFrom: { $exists: false }, rollWork: { $exists: false } }, { $set: { rollFrom: new Date(0) } });
    return r.modifiedCount;
  }

  /** Operator repair: forget the rollups of the matching series (queries read minute documents again) and rebuild them from the first minute document. */
  async requestRebuild(filter: { orgId?: string; projectId?: string; environmentId?: string; seriesIds?: string[] } = {}): Promise<number> {
    const f: Record<string, unknown> = {};
    if (filter.orgId) f.orgId = filter.orgId;
    if (filter.projectId) f.projectId = filter.projectId;
    if (filter.environmentId) f.environmentId = filter.environmentId;
    if (filter.seriesIds) f._id = { $in: filter.seriesIds };
    const r = await this.db.c.metricSeries.updateMany(f, { $set: { rollFrom: new Date(0) }, $unset: { rolled5: '', rolled60: '' } });
    return r.modifiedCount;
  }

  /** How much work is waiting: series with pending markers older than the sealed boundary. */
  async pending(now = new Date()): Promise<number> {
    return this.db.c.metricSeries.countDocuments({ rollFrom: { $lt: new Date(floorTo(now.getTime() - this.lagMs, 5 * MINUTE)) } });
  }

  /** Processes claimable series until none is left or the time budget is used. */
  async runOnce(now = new Date(), budgetMs = 30_000): Promise<RollupRunResult> {
    const started = Date.now();
    const deadline = started + budgetMs;
    // `now` is the caller's clock (tests drive it); it keeps advancing with real elapsed time so leases are renewed on the same clock they were taken on.
    const clock = () => new Date(now.getTime() + Date.now() - started);
    const sealed: Record<RollupTier, number> = { 5: floorTo(now.getTime() - this.lagMs, 5 * MINUTE), 60: floorTo(now.getTime() - this.lagMs, HOUR) };
    const res: RollupRunResult = { claimed: 0, buckets5: 0, buckets60: 0, removed: 0, rounds: 0 };
    // Every run holds its own lease identity, so two overlapping runs (even of one instance) can never both work on one series.
    const owner = `${this.owner}:${randomUUID()}`;
    while (Date.now() < deadline) {
      const claimed = await this.claim(now, sealed[5], owner);
      if (!claimed.length) break;
      res.claimed += claimed.length;
      await this.process(claimed, sealed, clock, res, owner);
    }
    return res;
  }

  private async claim(now: Date, sealed5: number, owner = this.owner): Promise<MetricSeriesDoc[]> {
    const free = { $or: [{ rollLease: { $exists: false } }, { 'rollLease.until': { $lt: now } }] };
    const cands = await this.db.c.metricSeries.find({
      $and: [{ $or: [{ rollFrom: { $lt: new Date(sealed5) } }, { rollFrom: CLAIM_SENTINEL }] }, free],
    }, { projection: { _id: 1 } }).limit(this.batch).maxTimeMS(20_000).toArray();
    if (!cands.length) return [];
    const lease = { owner, until: new Date(now.getTime() + this.leaseMs) };
    // ONE atomic update per series: the earliest pending minute moves from `rollFrom` to `rollWork`, and `rollFrom` becomes the sentinel. A write that
    // commits afterwards lowers `rollFrom` again (a new pending marker); one that committed before is already inside `rollWork`.
    await this.db.c.metricSeries.bulkWrite(cands.map((c) => ({
      updateOne: { filter: { _id: c._id, ...free }, update: [{ $set: { rollWork: { $min: ['$rollWork', '$rollFrom'] } } }, { $set: { rollFrom: CLAIM_SENTINEL, rollLease: lease } }] },
    })) as never, { ordered: false });
    return this.db.c.metricSeries.find({ _id: { $in: cands.map((c) => c._id) }, 'rollLease.owner': owner }).toArray();
  }

  private async process(claimed: MetricSeriesDoc[], sealed: Record<RollupTier, number>, clock: () => Date, res: RollupRunResult, owner: string): Promise<void> {
    // The first minute document of each series bounds the work (and a requested rebuild starts there instead of at 1970).
    // Routine recomputations (coverage exists and the marker is recent) need no lookup: they start at the marker.
    const routine = (s: MetricSeriesDoc) => !!s.rolled5 && !!s.rolled60 && !!s.rollWork && s.rollWork.getTime() > sealed[5] - 2 * 24 * HOUR;
    const origins = await Promise.all(claimed.map(async (s) => (routine(s) ? Number.NEGATIVE_INFINITY : (await this.db.c.metricPoints.find({ seriesId: s._id }, { projection: { minute: 1 } }).sort({ minute: 1 }).limit(1).next())?.minute.getTime() ?? null)));
    const jobs: Job[] = [];
    const targets = new Map<string, { r5: number; r60: number }>();
    claimed.forEach((s, i) => {
      const origin = origins[i];
      const target = { r5: Math.max(sealed[5], s.rolled5?.getTime() ?? 0), r60: Math.max(sealed[60], s.rolled60?.getTime() ?? 0) };
      targets.set(s._id, target);
      if (origin === null || origin === undefined) return; // no minute documents: nothing to cover
      for (const tier of [5, 60] as RollupTier[]) {
        const size = tier * MINUTE;
        const rolled = (tier === 5 ? s.rolled5 : s.rolled60)?.getTime();
        const work = s.rollWork ? floorTo(s.rollWork.getTime(), size) : Number.POSITIVE_INFINITY;
        const start = Math.max(floorTo(origin, size), rolled === undefined ? Number.NEGATIVE_INFINITY : Math.min(rolled, work));
        const hi = tier === 5 ? target.r5 : target.r60;
        if (start < hi) jobs.push({ s, tier, cur: start, hi, full: !routine(s) });
      }
    });
    // Chunked in time so one pipeline never reads more than a day (5 min tier) or a week (1 h tier) per series; each chunk is written before the next.
    for (;;) {
      const round = jobs.filter((j) => j.cur < j.hi);
      if (!round.length) break;
      res.rounds++;
      await this.db.c.metricSeries.updateMany({ _id: { $in: claimed.map((s) => s._id) }, 'rollLease.owner': owner }, { $set: { 'rollLease.until': new Date(clock().getTime() + this.leaseMs) } });
      for (const tier of [5, 60] as RollupTier[]) {
        const part = round.filter((j) => j.tier === tier);
        // the pipeline's accumulators depend on the series' shape: histograms (bucket layout), gauges (newest value)
        const shapes = new Map<string, Job[]>();
        for (const j of part) { const k = `${j.s.type === 'gauge' ? 'g' : j.s.type === 'histogram' ? 'h' : 's'}${j.s.bounds ? j.s.bounds.length + 1 : 0}`; (shapes.get(k) ?? shapes.set(k, []).get(k)!).push(j); }
        for (const group of shapes.values()) {
          const ranges = group.map((j) => ({ j, lo: j.cur, hi: Math.min(j.hi, j.cur + CHUNK[tier]) }));
          const { written, removed } = await this.rollChunk(tier, ranges);
          if (tier === 5) res.buckets5 += written; else res.buckets60 += written;
          res.removed += removed;
          for (const r of ranges) r.j.cur = r.hi;
        }
      }
    }
    // Publish: coverage moves forward only now, and the claim is released unless a newer write re-marked the series meanwhile (that marker stays).
    await this.db.c.metricSeries.bulkWrite(claimed.map((s) => {
      const t = targets.get(s._id)!;
      return {
        updateOne: {
          filter: { _id: s._id, 'rollLease.owner': owner },
          update: [
            { $set: { rolled5: new Date(t.r5), rolled60: new Date(t.r60) } },
            { $unset: ['rollWork', 'rollLease'] },
            { $set: { rollFrom: { $cond: [{ $eq: ['$rollFrom', CLAIM_SENTINEL] }, '$$REMOVE', '$rollFrom'] } } },
          ],
        },
      };
    }) as never, { ordered: false });
  }

  private async rollChunk(tier: RollupTier, ranges: { j: Job; lo: number; hi: number }[]): Promise<{ written: number; removed: number }> {
    const size = tier * MINUTE;
    const first = ranges[0]!.j.s;
    const n = first.bounds ? first.bounds.length + 1 : 0;
    const gauge = first.type === 'gauge';
    const bucketFields = Object.fromEntries(Array.from({ length: n }, (_, i) => [`b${i}`, { $sum: { $ifNull: [{ $arrayElemAt: ['$buckets', i] }, 0] } }]));
    const rows = await this.db.c.metricPoints.aggregate<Record<string, unknown> & { _id: { s: string; b: number } }>([
      { $match: { $or: ranges.map((r) => ({ seriesId: r.j.s._id, minute: { $gte: new Date(r.lo), $lt: new Date(r.hi) } })) } },
      {
        $group: {
          _id: { s: '$seriesId', b: { $subtract: [{ $toLong: '$minute' }, { $mod: [{ $toLong: '$minute' }, size] }] } },
          count: { $sum: '$count' }, sum: { $sum: '$sum' }, min: { $min: '$min' }, max: { $max: '$max' }, lastMinute: { $max: '$minute' }, expireAt: { $max: '$expireAt' }, ...bucketFields,
          ...(gauge ? { lastAt: { $max: '$lastAt' }, last: { $top: { sortBy: { lastAt: -1 }, output: '$last' } } } : {}),
          ...(n ? { ex: { $top: { sortBy: { minute: -1 }, output: '$exemplars' } } } : {}),
        },
      },
    ], { allowDiskUse: true, maxTimeMS: 120_000 }).toArray();
    const bySeries = new Map<string, MetricRollupDoc[]>();
    for (const r of rows) {
      const s = ranges.find((x) => x.j.s._id === r._id.s)!.j.s;
      const doc: MetricRollupDoc = {
        _id: `${s._id}:${tier}:${r._id.b}`, seriesId: s._id, orgId: s.orgId, projectId: s.projectId, environmentId: s.environmentId, metric: s.name, service: s.service, type: s.type,
        minute: new Date(r._id.b), tier, count: Number(r.count), sum: Number(r.sum), min: (r.min as number | null) ?? null, max: (r.max as number | null) ?? null,
        last: gauge ? ((r.last as number | null | undefined) ?? null) : null, lastAt: gauge && r.lastAt instanceof Date ? r.lastAt : null,
        buckets: n ? Array.from({ length: n }, (_, i) => Number(r[`b${i}`] ?? 0)) : null,
        exemplars: Array.isArray(r.ex) ? (r.ex as MetricRollupDoc['exemplars']).slice(-5) : [], expireAt: r.expireAt as Date, lastMinute: r.lastMinute as Date,
      };
      (bySeries.get(s._id) ?? bySeries.set(s._id, []).get(s._id)!).push(doc);
    }
    const ops: unknown[] = [];
    let written = 0;
    if (!ranges.length) return { written, removed: 0 };
    for (const r of ranges) {
      const docs = bySeries.get(r.j.s._id) ?? [];
      written += docs.length;
      for (const d of docs) ops.push({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } });
      // A bucket whose minute documents are all gone (expired, deleted) must not survive as a stale rollup.
      if (r.j.full) ops.push({ deleteMany: { filter: { seriesId: r.j.s._id, tier, minute: { $gte: new Date(r.lo), $lt: new Date(r.hi) }, _id: { $nin: docs.map((d) => d._id) } } } });
    }
    if (!ops.length) return { written: 0, removed: 0 };
    const out = await this.db.c.metricRollups.bulkWrite(ops as never, { ordered: false });
    return { written, removed: out.deletedCount };
  }
}

/** Runs the compactor on a timer (worker process). One run at a time; errors are reported and retried on the next tick. Returns a stop function. */
export function startRollupCompactor(db: Database, opts: CompactorOptions & { intervalMs?: number; discoverEveryMs?: number; log?: (level: 'info' | 'warn', msg: string, fields?: Record<string, unknown>) => void } = {}): () => Promise<void> {
  const compactor = new MetricRollupCompactor(db, opts);
  const log = opts.log ?? (() => undefined);
  const interval = opts.intervalMs ?? 30_000, discoverEvery = opts.discoverEveryMs ?? 30 * 60_000;
  let stopped = false, running: Promise<void> = Promise.resolve(), timer: NodeJS.Timeout | undefined, lastDiscover = 0;
  const tick = async () => {
    try {
      if (Date.now() - lastDiscover >= discoverEvery) {
        lastDiscover = Date.now();
        await compactor.ensureIndexes().catch(() => undefined); // best effort: migration v30 normally did it
        const marked = await compactor.markUnrolled();
        if (marked) log('info', 'metric rollups: series queued for backfill', { series: marked });
      }
      const r = await compactor.runOnce(new Date(), Math.max(5_000, interval));
      if (r.claimed) log('info', 'metric rollups compacted', { ...r });
    } catch (e) { log('warn', 'metric rollup compaction failed; will retry', { error: e instanceof Error ? e.message : String(e) }); }
    if (!stopped) timer = setTimeout(() => { running = tick(); }, interval);
  };
  running = tick();
  return async () => { stopped = true; if (timer) clearTimeout(timer); await running; };
}
