import { createHash } from 'node:crypto';
import { METRIC_LIMITS, type MetricAggregation, type MetricQuery, type MetricQueryResult } from '@nexus/contracts';
import type { ClientSession, Database, KV, MetricExemplarDoc, MetricPointDoc, MetricSeriesDoc } from '@nexus/database';
import type { MetricPointDraft } from '@nexus/telemetry';
import { boundsKey, histogramQuantile } from './histogram.js';
import { MINUTE, processSeriesPoints, type MinuteAgg } from './process.js';

export const QUERY_TIMEOUT_MS = 8_000;
/**
 * Cardinality limits (defaults; configurable per store): a metric may create at most this many series per environment, and an environment this
 * many in total. A series is one label combination of one service INSTANCE, so a fleet multiplies it: 40 pods x 10 routes x 5 statuses = 2,000.
 * Queries refuse to read more than METRIC_LIMITS.maxSeriesScanned (2,000) series at once and ask for a filter instead.
 */
export const MAX_SERIES_PER_METRIC = 2_000;
export const MAX_SERIES_PER_ENVIRONMENT = 20_000;
const SERIES_PER_TXN = 400;

export interface Scope { orgId: string; projectId: string; environmentIds: string[] }
export interface MetricContext { orgId: string; projectId: string; environmentId: string; retentionMs: number }
export interface MetricWriteResult {
  accepted: number; duplicates: number;
  /** Data points refused because their series would exceed a cardinality limit. */
  rejected: number; notes: string[];
  baselines: number; resets: number;
}
export class MetricQueryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

export interface MetricNameInfo { name: string; type: MetricSeriesDoc['type']; unit: string | null; description: string | null; temporality: 'delta' | 'cumulative' | null; series: number; services: string[]; lastSeen: Date }

export interface HttpServiceStats {
  service: string; metric: string; requests: number; errors: number;
  p50Ms: number | null; p95Ms: number | null; p99Ms: number | null;
  statuses: Record<string, number>;
  routes: { route: string; requests: number; errors: number; p95Ms: number | null }[];
  timeline: { t: number; requests: number | null; errors: number | null; p95Ms: number | null }[];
  lastDataAt: Date | null;
}
interface WindowRow { t: number; count: number; sum: number; min: number | null; max: number | null; last: number | null; lastAt: number; buckets: number[]; exemplars: MetricExemplarDoc[] }
export interface HttpOverview { stepMs: number; services: HttpServiceStats[]; notes: string[] }

/** Storage contract for metrics. MongoDB implements it today; a Prometheus-compatible or ClickHouse store could replace it. */
export interface MetricStore {
  ingest(ctx: MetricContext, points: MetricPointDraft[], now: Date): Promise<MetricWriteResult>;
  names(scope: Scope): Promise<MetricNameInfo[]>;
  labels(scope: Scope, metric: string): Promise<{ key: string; values: string[]; truncated: boolean }[]>;
  query(scope: Scope, q: MetricQuery): Promise<MetricQueryResult>;
  httpOverview(scope: Scope, from: Date, to: Date): Promise<HttpOverview>;
  diagnostics(scope: Scope): Promise<{ series: number; pointDocs: number; topMetrics: { name: string; series: number; nearLimit: boolean }[]; limits: { maxSeriesPerMetric: number; maxSeriesPerEnvironment: number }; storageBytes: number | null }>;
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const labelsKey = (attrs: KV[]) => attrs.map((a) => `${a.k}=${a.v}`).join('\u0002');
/** Series identity. Everything that changes how values must be interpreted is in it, so incompatible data can never share a series. */
export function seriesIdOf(ctx: Pick<MetricContext, 'orgId' | 'environmentId'>, p: MetricPointDraft): string {
  return sha1([ctx.orgId, ctx.environmentId, p.name, p.service ?? '', p.instance ?? '', p.type, p.temporality ?? '', String(p.monotonic), boundsKey(p.bounds), labelsKey(p.attrs)].join('\u0001'));
}

export const STATUS_KEYS = ['http.response.status_code', 'http.status_code'];
export const ROUTE_KEYS = ['http.route'];
const label = (attrs: KV[], keys: string[]) => { for (const k of keys) { const v = attrs.find((a) => a.k === k)?.v; if (v !== undefined) return v; } return null; };
export const HTTP_DURATION_METRICS = [
  { name: 'http.server.request.duration', toMs: 1000 }, // stable semantic conventions: seconds
  { name: 'http.server.duration', toMs: 1 },            // legacy semantic conventions: milliseconds
] as const;
const statusClass = (s: string | null) => (s && /^\d{3}$/.test(s) ? `${s[0]}xx` : 'other');

function mergeStage(a: MinuteAgg, base: { orgId: string; projectId: string; environmentId: string; seriesId: string; metric: string; service: string | null; type: MetricPointDoc['type'] }, expireAt: Date): Record<string, unknown>[] {
  const keep = (field: string) => `$${field}`;
  const n = a.buckets?.length ?? 0;
  return [{
    $set: {
      seriesId: base.seriesId, orgId: base.orgId, projectId: base.projectId, environmentId: base.environmentId, metric: base.metric, service: base.service, type: base.type, minute: new Date(a.minute),
      count: { $add: [{ $ifNull: ['$count', 0] }, a.count] },
      sum: { $add: [{ $ifNull: ['$sum', 0] }, a.sum] },
      min: a.min === null ? keep('min') : { $min: [keep('min'), a.min] },
      max: a.max === null ? keep('max') : { $max: [keep('max'), a.max] },
      last: a.lastAt ? { $cond: [{ $gte: [{ $literal: a.lastAt }, { $ifNull: ['$lastAt', { $literal: new Date(0) }] }] }, a.last, keep('last')] } : keep('last'),
      lastAt: a.lastAt ? { $max: [{ $ifNull: ['$lastAt', { $literal: new Date(0) }] }, { $literal: a.lastAt }] } : keep('lastAt'),
      buckets: a.buckets
        ? { $cond: [{ $isArray: '$buckets' }, { $map: { input: { $range: [0, n] }, as: 'i', in: { $add: [{ $ifNull: [{ $arrayElemAt: ['$buckets', '$$i'] }, 0] }, { $arrayElemAt: [{ $literal: a.buckets }, '$$i'] }] } } }, { $literal: a.buckets }] }
        : keep('buckets'),
      exemplars: { $slice: [{ $concatArrays: [{ $ifNull: ['$exemplars', []] }, { $literal: a.exemplars }] }, -5] },
      expireAt: { $max: [{ $ifNull: ['$expireAt', { $literal: expireAt }] }, { $literal: expireAt }] },
    },
  }];
}

export class MongoMetricStore implements MetricStore {
  private readonly maxPointDocs: number;
  private readonly maxSeriesPerMetric: number;
  private readonly maxSeriesPerEnvironment: number;
  constructor(private readonly db: Database, opts: { maxPointDocsScanned?: number; maxSeriesPerMetric?: number; maxSeriesPerEnvironment?: number } = {}) {
    this.maxPointDocs = opts.maxPointDocsScanned ?? METRIC_LIMITS.maxPointDocsScanned;
    this.maxSeriesPerMetric = opts.maxSeriesPerMetric ?? MAX_SERIES_PER_METRIC;
    this.maxSeriesPerEnvironment = opts.maxSeriesPerEnvironment ?? MAX_SERIES_PER_ENVIRONMENT;
  }

  // ================================================================== ingestion
  async ingest(ctx: MetricContext, points: MetricPointDraft[], now: Date): Promise<MetricWriteResult> {
    const out: MetricWriteResult = { accepted: 0, duplicates: 0, rejected: 0, notes: [], baselines: 0, resets: 0 };
    if (!points.length) return out;
    const bySeries = new Map<string, MetricPointDraft[]>();
    for (const p of points) {
      const id = seriesIdOf(ctx, p);
      const list = bySeries.get(id) ?? [];
      list.push(p);
      bySeries.set(id, list);
    }
    const entries = [...bySeries];
    for (let i = 0; i < entries.length; i += SERIES_PER_TXN) {
      const chunk = entries.slice(i, i + SERIES_PER_TXN);
      // One transaction per chunk: the series watermark/state and the minute buckets change together, so a retry after a failure can never
      // double-count (watermark) nor lose (atomic) data. A write conflict with a concurrent request is retried by withTransaction.
      const r = await this.db.transaction((session) => this.ingestChunk(ctx, chunk, now, session));
      out.accepted += r.accepted; out.duplicates += r.duplicates; out.rejected += r.rejected; out.baselines += r.baselines; out.resets += r.resets;
      for (const n of r.notes) if (out.notes.length < 5 && !out.notes.includes(n)) out.notes.push(n);
    }
    return out;
  }

  private async ingestChunk(ctx: MetricContext, chunk: [string, MetricPointDraft[]][], now: Date, session: ClientSession): Promise<MetricWriteResult> {
    const res: MetricWriteResult = { accepted: 0, duplicates: 0, rejected: 0, notes: [], baselines: 0, resets: 0 };
    const existing = new Map((await this.db.c.metricSeries.find({ _id: { $in: chunk.map(([id]) => id) } }, { session }).toArray()).map((s) => [s._id, s]));
    const unknown = chunk.filter(([id]) => !existing.has(id));
    // Cardinality: how many series each metric (and the environment) already has, counted inside the transaction.
    const perMetric = new Map<string, number>();
    let envTotal = 0;
    if (unknown.length) {
      envTotal = await this.db.c.metricSeries.countDocuments({ orgId: ctx.orgId, environmentId: ctx.environmentId }, { session });
      for (const name of new Set(unknown.map(([, ps]) => ps[0]!.name))) {
        perMetric.set(name, await this.db.c.metricSeries.countDocuments({ orgId: ctx.orgId, environmentId: ctx.environmentId, name }, { session }));
      }
    }
    const pointWrites: unknown[] = [];
    const seriesWrites: unknown[] = [];
    const createWrites: unknown[] = [];
    const incWrites: unknown[] = [];
    const expireFor = (t: Date) => new Date(t.getTime() + ctx.retentionMs);

    for (const [id, pts] of chunk) {
      const first = pts[0]!;
      pts.sort((a, b) => a.time.getTime() - b.time.getTime());
      let series = existing.get(id) ?? null;
      if (!series) {
        const used = perMetric.get(first.name) ?? 0;
        if (used >= this.maxSeriesPerMetric || envTotal >= this.maxSeriesPerEnvironment) {
          res.rejected += pts.length;
          const why = used >= this.maxSeriesPerMetric ? `metric "${first.name}" reached its limit of ${this.maxSeriesPerMetric} series (too many distinct label combinations)` : `the environment reached its limit of ${this.maxSeriesPerEnvironment} metric series`;
          if (!res.notes.includes(why)) res.notes.push(`Metric series refused: ${why}`);
          continue;
        }
        perMetric.set(first.name, used + 1); envTotal++;
        series = {
          _id: id, orgId: ctx.orgId, projectId: ctx.projectId, environmentId: ctx.environmentId, name: first.name, unit: first.unit, description: first.description,
          type: first.type, temporality: first.temporality, monotonic: first.monotonic, service: first.service, serviceVersion: first.serviceVersion, instance: first.instance,
          attrs: first.attrs, bounds: first.bounds, firstSeen: now, lastSeen: now, lastPoint: new Date(0), recent: [], cumulative: null, expireAt: expireFor(pts[pts.length - 1]!.time),
        };
      }
      const r = processSeriesPoints(series, { lastPoint: series.lastPoint.getTime() === 0 ? null : series.lastPoint, cumulative: series.cumulative, recent: series.recent ?? [] }, pts);
      res.accepted += r.accepted; res.duplicates += r.duplicates; res.baselines += r.baselines; res.resets += r.resets;
      if (r.accepted === 0) continue;
      const newest = r.state.lastPoint!;
      const next: MetricSeriesDoc = {
        ...series, unit: first.unit ?? series.unit, description: first.description ?? series.description, serviceVersion: first.serviceVersion ?? series.serviceVersion,
        lastSeen: now, lastPoint: newest, recent: r.state.recent, cumulative: r.state.cumulative, expireAt: expireFor(newest),
      };
      // Batched: one round trip for all series of the chunk instead of one per series.
      seriesWrites.push(existing.has(id) ? { replaceOne: { filter: { _id: id }, replacement: next } } : { insertOne: { document: next } });
      for (const a of r.aggs.values()) {
        if (a.count === 0 && a.sum === 0 && !a.buckets) continue; // a baseline-only minute holds no measurement
        const base = { orgId: ctx.orgId, projectId: ctx.projectId, environmentId: ctx.environmentId, seriesId: id, metric: first.name, service: first.service, type: first.type };
        const expireAt = expireFor(new Date(a.minute + MINUTE));
        if (a.lastAt) {
          // Gauges: "the newest value wins" is decided by timestamp, which needs the aggregation-pipeline update.
          pointWrites.push({ updateOne: { filter: { _id: `${id}:${a.minute}` }, update: mergeStage(a, base, expireAt), upsert: true } });
        } else {
          // Counters and histograms: plain update operators (much cheaper than a pipeline). The document is created first (empty), then incremented;
          // min/max are left absent until a value exists because $min/$max would otherwise compare against null.
          const n = a.buckets?.length ?? 0;
          createWrites.push({ updateOne: { filter: { _id: `${id}:${a.minute}` }, upsert: true, update: { $setOnInsert: { ...base, minute: new Date(a.minute), count: 0, sum: 0, last: null, lastAt: null, buckets: n ? new Array<number>(n).fill(0) : null, exemplars: [] } } } });
          const inc: Record<string, number> = { count: a.count, sum: a.sum };
          if (a.buckets) a.buckets.forEach((v, i) => { if (v) inc[`buckets.${i}`] = v; });
          incWrites.push({
            updateOne: {
              filter: { _id: `${id}:${a.minute}` },
              update: {
                $inc: inc, $max: { expireAt, ...(a.max !== null ? { max: a.max } : {}) }, ...(a.min !== null ? { $min: { min: a.min } } : {}),
                ...(a.exemplars.length ? { $push: { exemplars: { $each: a.exemplars, $slice: -5 } } } : {}),
              },
            },
          });
        }
      }
    }
    if (seriesWrites.length) await this.db.c.metricSeries.bulkWrite(seriesWrites as never, { session, ordered: false });
    if (createWrites.length) await this.db.c.metricPoints.bulkWrite(createWrites as never, { session, ordered: false });
    if (incWrites.length) await this.db.c.metricPoints.bulkWrite(incWrites as never, { session, ordered: false });
    if (pointWrites.length) await this.db.c.metricPoints.bulkWrite(pointWrites as never, { session, ordered: false });
    return res;
  }

  // ================================================================== catalogue
  async names(scope: Scope): Promise<MetricNameInfo[]> {
    const rows = await this.db.c.metricSeries.aggregate<{ _id: string; type: MetricSeriesDoc['type']; unit: string | null; description: string | null; temporality: 'delta' | 'cumulative' | null; series: number; services: (string | null)[]; lastSeen: Date }>([
      { $match: { orgId: scope.orgId, projectId: scope.projectId, environmentId: { $in: scope.environmentIds } } },
      { $group: { _id: '$name', type: { $first: '$type' }, unit: { $first: '$unit' }, description: { $first: '$description' }, temporality: { $first: '$temporality' }, series: { $sum: 1 }, services: { $addToSet: '$service' }, lastSeen: { $max: '$lastSeen' } } },
      { $sort: { _id: 1 } }, { $limit: 500 },
    ], { maxTimeMS: QUERY_TIMEOUT_MS }).toArray();
    return rows.map((r) => ({ name: r._id, type: r.type, unit: r.unit, description: r.description, temporality: r.temporality, series: r.series, services: r.services.filter((s): s is string => !!s).sort().slice(0, 50), lastSeen: r.lastSeen }));
  }

  async labels(scope: Scope, metric: string): Promise<{ key: string; values: string[]; truncated: boolean }[]> {
    const series = await this.db.c.metricSeries.find({ orgId: scope.orgId, projectId: scope.projectId, environmentId: { $in: scope.environmentIds }, name: metric }, { projection: { attrs: 1 } }).limit(METRIC_LIMITS.maxSeriesScanned).maxTimeMS(QUERY_TIMEOUT_MS).toArray();
    const byKey = new Map<string, Set<string>>();
    for (const s of series) for (const a of s.attrs) { const set = byKey.get(a.k) ?? new Set<string>(); set.add(a.v); byKey.set(a.k, set); }
    return [...byKey].sort((a, b) => a[0].localeCompare(b[0])).map(([key, set]) => ({ key, values: [...set].sort().slice(0, 50), truncated: set.size > 50 }));
  }

  // ================================================================== queries
  private floor(from: Date) { return new Date(Math.floor(from.getTime() / MINUTE) * MINUTE); }

  /**
   * Refuses (with advice) a query that would scan more stored measurements than allowed. The count uses the index only (nothing is read), and
   * stops at the limit, so the guard itself is cheap even when the answer is "far too many".
   */
  private async guardScan(ids: string[], from: Date, to: Date) {
    const n = await this.db.c.metricPoints.countDocuments({ seriesId: { $in: ids }, minute: { $gte: this.floor(from), $lte: to } }, { limit: this.maxPointDocs + 1, maxTimeMS: QUERY_TIMEOUT_MS });
    if (n > this.maxPointDocs) {
      throw new MetricQueryError(422, 'query_too_expensive', `This query would read more than ${this.maxPointDocs.toLocaleString('en')} stored measurements. Narrow the time range, add a service or label filter, or group by fewer labels.`);
    }
  }

  /**
   * Merges stored minute buckets of the given series into query windows INSIDE MongoDB: only one row per window comes back, however many
   * series or minutes are involved. All `ids` must share one histogram bucket layout (`nBuckets` entries), so bucket counts can be added
   * position by position; percentiles are computed later from these merged counts.
   */
  private async aggregateWindows(ids: string[], from: Date, to: Date, stepMs: number, o: { nBuckets: number; gauge?: boolean; exemplars?: boolean }): Promise<WindowRow[]> {
    const bucketFields = Object.fromEntries(Array.from({ length: o.nBuckets }, (_, i) => [`b${i}`, { $sum: { $ifNull: [{ $arrayElemAt: ['$buckets', i] }, 0] } }]));
    const rows = await this.db.c.metricPoints.aggregate<Record<string, unknown> & { _id: number }>([
      { $match: { seriesId: { $in: ids }, minute: { $gte: this.floor(from), $lte: to } } },
      {
        $group: {
          _id: { $subtract: [{ $toLong: '$minute' }, { $mod: [{ $toLong: '$minute' }, stepMs] }] },
          count: { $sum: '$count' }, sum: { $sum: '$sum' }, min: { $min: '$min' }, max: { $max: '$max' }, ...bucketFields,
          ...(o.gauge ? { lastAt: { $max: '$lastAt' }, last: { $top: { sortBy: { lastAt: 1 }, output: '$last' } } } : {}),
          ...(o.exemplars ? { ex: { $top: { sortBy: { minute: -1 }, output: '$exemplars' } } } : {}),
        },
      },
    ], { maxTimeMS: QUERY_TIMEOUT_MS, allowDiskUse: true }).toArray();
    return rows.map((r) => ({
      t: r._id, count: Number(r.count), sum: Number(r.sum), min: (r.min as number | null) ?? null, max: (r.max as number | null) ?? null,
      last: (r.last as number | null | undefined) ?? null, lastAt: r.lastAt instanceof Date ? r.lastAt.getTime() : -1,
      buckets: Array.from({ length: o.nBuckets }, (_, i) => Number(r[`b${i}`] ?? 0)),
      exemplars: Array.isArray(r.ex) ? (r.ex as MetricExemplarDoc[]) : [],
    }));
  }

  private stepFor(from: Date, to: Date, requested?: number): number {
    const span = to.getTime() - from.getTime();
    const auto = Math.ceil(span / METRIC_LIMITS.maxPointsPerSeries / MINUTE) * MINUTE;
    const step = Math.max(MINUTE, Math.ceil((requested ? requested * 1000 : auto) / MINUTE) * MINUTE);
    return Math.max(step, auto); // never more than maxPointsPerSeries points, whatever was asked for
  }

  async query(scope: Scope, q: MetricQuery): Promise<MetricQueryResult> {
    const from = new Date(q.from), to = new Date(q.to);
    const stepMs = this.stepFor(from, to, q.stepSeconds);
    const envs = q.environmentIds?.length ? scope.environmentIds.filter((e) => q.environmentIds!.includes(e)) : scope.environmentIds;
    const empty = (notes: string[]): MetricQueryResult => ({ metric: q.metric, type: null, unit: null, agg: null, stepMs, from: q.from, to: q.to, series: [], truncated: false, notes });

    let series = await this.db.c.metricSeries.find({ orgId: scope.orgId, projectId: scope.projectId, environmentId: { $in: envs }, name: q.metric, ...(q.service ? { service: q.service } : {}) })
      .limit(METRIC_LIMITS.maxSeriesScanned + 1).maxTimeMS(QUERY_TIMEOUT_MS).toArray();
    if (series.length > METRIC_LIMITS.maxSeriesScanned) throw new MetricQueryError(422, 'query_too_expensive', `More than ${METRIC_LIMITS.maxSeriesScanned} series match. Add a service or label filter.`);
    for (const f of q.filters) series = series.filter((s) => s.attrs.some((a) => a.k === f.key && a.v === f.value));
    if (!series.length) return empty(['No data for this metric in the selected scope.']);

    // A metric name is expected to keep one type; if senders disagree, the most common type is queried and the rest are reported.
    const typeCount = new Map<string, number>();
    for (const s of series) typeCount.set(s.type, (typeCount.get(s.type) ?? 0) + 1);
    const type = [...typeCount].sort((a, b) => b[1] - a[1])[0]![0] as MetricSeriesDoc['type'];
    const notes: string[] = [];
    if (typeCount.size > 1) { notes.push(`Senders report this metric with different types (${[...typeCount.keys()].join(', ')}); only "${type}" series are shown.`); series = series.filter((s) => s.type === type); }
    const unit = series.find((s) => s.unit)?.unit ?? null;

    const defaultAgg: MetricAggregation = type === 'gauge' ? 'avg' : type === 'sum' ? 'sum' : 'p95';
    const agg = q.agg ?? defaultAgg;
    const allowed: Record<string, MetricAggregation[]> = {
      gauge: ['avg', 'min', 'max', 'last', 'count', 'sum'], sum: ['sum', 'rate'],
      histogram: ['count', 'sum', 'avg', 'rate', 'p50', 'p90', 'p95', 'p99', 'min', 'max'],
    };
    if (!allowed[type]!.includes(agg)) throw new MetricQueryError(400, 'unsupported_aggregation', `"${agg}" is not available for a ${type} metric. Use one of: ${allowed[type]!.join(', ')}.`);

    const labelOf = (s: MetricSeriesDoc) => {
      const l: Record<string, string> = {};
      for (const k of q.groupBy) l[k] = k === 'service' ? s.service ?? '' : s.attrs.find((a) => a.k === k)?.v ?? '';
      return l;
    };
    const ids = series.map((s) => s._id);
    await this.guardScan(ids, from, to);

    type Cell = { count: number; sum: number; min: number | null; max: number | null; last: number | null; lastAt: number; buckets: Map<string, number[]>; boundsBy: Map<string, number[]> };
    type Ex = { traceId: string; spanId: string | null; value: number; ts: Date };
    type Group = { labels: Record<string, string>; subsets: Map<string, { ids: string[]; bounds: number[] | null }>; cells: Map<number, Cell>; volume: number; exemplars: Ex[] };
    const groups = new Map<string, Group>();
    for (const s of series) {
      const labels = labelOf(s);
      const gk = JSON.stringify(labels);
      let g = groups.get(gk);
      if (!g) { g = { labels, subsets: new Map(), cells: new Map(), volume: 0, exemplars: [] }; groups.set(gk, g); }
      const bk = boundsKey(s.bounds);
      const sub = g.subsets.get(bk);
      if (sub) sub.ids.push(s._id); else g.subsets.set(bk, { ids: [s._id], bounds: s.bounds });
    }

    // Many groups: rank them by volume with ONE cheap server-side pass (per-series totals), then aggregate only the largest.
    let ranked = [...groups.values()];
    let totalGroups = ranked.length;
    if (ranked.length > METRIC_LIMITS.maxResultSeries) {
      const totals = await this.db.c.metricPoints.aggregate<{ _id: string; n: number }>([
        { $match: { seriesId: { $in: ids }, minute: { $gte: this.floor(from), $lte: to } } }, { $group: { _id: '$seriesId', n: { $sum: '$count' } } },
      ], { maxTimeMS: QUERY_TIMEOUT_MS }).toArray();
      const vol = new Map(totals.map((t) => [t._id, t.n]));
      for (const g of ranked) g.volume = [...g.subsets.values()].reduce((n, sub) => n + sub.ids.reduce((m, id) => m + (vol.get(id) ?? 0), 0), 0);
      ranked = ranked.sort((a, b) => b.volume - a.volume).slice(0, METRIC_LIMITS.maxResultSeries);
    }

    const work = ranked.flatMap((g) => [...g.subsets].map(([bk, sub]) => ({ g, bk, sub })));
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, work.length) }, async () => {
      for (;;) {
        const w = work[next++];
        if (!w) return;
        const rows = await this.aggregateWindows(w.sub.ids, from, to, stepMs, { nBuckets: w.sub.bounds ? w.sub.bounds.length + 1 : 0, gauge: type === 'gauge', exemplars: type === 'histogram' });
        for (const r of rows) {
          let c = w.g.cells.get(r.t);
          if (!c) { c = { count: 0, sum: 0, min: null, max: null, last: null, lastAt: -1, buckets: new Map(), boundsBy: new Map() }; w.g.cells.set(r.t, c); }
          c.count += r.count; c.sum += r.sum;
          if (r.min != null) c.min = c.min === null ? r.min : Math.min(c.min, r.min);
          if (r.max != null) c.max = c.max === null ? r.max : Math.max(c.max, r.max);
          if (r.last != null && r.lastAt >= c.lastAt) { c.last = r.last; c.lastAt = r.lastAt; }
          if (w.sub.bounds) {
            const cur = c.buckets.get(w.bk);
            if (cur) { for (let i = 0; i < cur.length; i++) cur[i]! += r.buckets[i] ?? 0; } else { c.buckets.set(w.bk, [...r.buckets]); c.boundsBy.set(w.bk, w.sub.bounds); }
          }
          for (const e of r.exemplars) w.g.exemplars.push({ traceId: e.traceId, spanId: e.spanId, value: e.value, ts: e.ts });
        }
      }
    }));
    for (const g of ranked) if (g.volume === 0) g.volume = [...g.cells.values()].reduce((n, c) => n + c.count, 0);
    totalGroups = groups.size;

    let mixedLayouts = false, estimated = false, floored = false;
    const stepSec = stepMs / 1000;
    const valueOf = (c: Cell): number | null => {
      if (c.count === 0 && agg !== 'sum') return null;
      switch (agg) {
        case 'sum': return c.count === 0 && c.sum === 0 ? null : c.sum;
        case 'rate': return (type === 'histogram' ? c.count : c.sum) / stepSec;
        case 'count': return c.count;
        case 'avg': return c.count ? c.sum / c.count : null;
        case 'min': return c.min; case 'max': return c.max; case 'last': return c.last;
        default: {
          const qv = agg === 'p50' ? 0.5 : agg === 'p90' ? 0.9 : agg === 'p95' ? 0.95 : 0.99;
          if (c.buckets.size === 0) return null;
          if (c.buckets.size > 1) mixedLayouts = true;
          // Merge only histograms with identical bounds; with several layouts use the one holding most observations.
          const [bk, counts] = [...c.buckets].sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0))[0]!;
          const r = histogramQuantile(c.boundsBy.get(bk)!, counts, qv, { min: c.min, max: c.max });
          if (!r) return null;
          estimated = true; if (r.atLeast) floored = true;
          return r.value;
        }
      }
    };
    const kept = ranked.sort((a, b) => b.volume - a.volume);
    const first = Math.floor(from.getTime() / stepMs) * stepMs;
    const result = kept.map((g) => {
      const pts: { t: number; v: number | null }[] = [];
      for (let t = first; t <= to.getTime(); t += stepMs) { const c = g.cells.get(t); pts.push({ t, v: c ? valueOf(c) : null }); }
      const ex = g.exemplars.sort((a, b) => b.ts.getTime() - a.ts.getTime()).slice(0, 5).map((e) => ({ traceId: e.traceId, spanId: e.spanId, value: e.value, ts: e.ts.toISOString() }));
      return { labels: g.labels, points: pts, exemplars: ex };
    });
    if (estimated) notes.push('Percentiles are estimated from histogram bucket counts (linear interpolation inside a bucket), computed from the merged distribution — never from averaged percentiles.');
    if (floored) notes.push('Some values fall in the open-ended top bucket; they are shown as "at least" the last bucket bound.');
    if (mixedLayouts) notes.push('Some series use different bucket layouts; percentiles use the layout holding most observations.');
    if (agg === 'rate') notes.push('Rate = measured increase per second within each window; windows without measurements are empty, not zero.');
    if (type === 'sum') notes.push('Counter series are converted to increases per window (cumulative counters via their previous value; a restart is detected and handled).');
    if (result.every((s) => s.points.every((p) => p.v === null))) notes.push('No measurements fall inside the selected window.');
    return { metric: q.metric, type, unit, agg, stepMs, from: q.from, to: q.to, series: result, truncated: totalGroups > kept.length, notes };
  }

  // ================================================================== service overview (explicit HTTP server metrics)
  async httpOverview(scope: Scope, from: Date, to: Date): Promise<HttpOverview> {
    const stepMs = this.stepFor(from, to);
    const names = HTTP_DURATION_METRICS.map((m) => m.name);
    const series = await this.db.c.metricSeries.find({ orgId: scope.orgId, projectId: scope.projectId, environmentId: { $in: scope.environmentIds }, name: { $in: names }, type: 'histogram' })
      .limit(METRIC_LIMITS.maxSeriesScanned + 1).maxTimeMS(QUERY_TIMEOUT_MS).toArray();
    const notes: string[] = [];
    if (series.length > METRIC_LIMITS.maxSeriesScanned) notes.push(`More than ${METRIC_LIMITS.maxSeriesScanned} HTTP series exist; the overview uses the first ${METRIC_LIMITS.maxSeriesScanned}.`);
    const use = series.slice(0, METRIC_LIMITS.maxSeriesScanned).filter((s) => !!s.service);
    if (!use.length) return { stepMs, services: [], notes };
    const ids = use.map((s) => s._id);
    await this.guardScan(ids, from, to);
    const toMs = (s: MetricSeriesDoc) => (s.unit === 'ms' ? 1 : s.unit === 's' ? 1000 : HTTP_DURATION_METRICS.find((m) => m.name === s.name)!.toMs);

    interface Acc { requests: number; errors: number; buckets: Map<string, number[]>; bounds: Map<string, number[]>; scale: number }
    const newAcc = (scale: number): Acc => ({ requests: 0, errors: 0, buckets: new Map(), bounds: new Map(), scale });
    const addTo = (a: Acc, count: number, buckets: number[] | null, bk: string, bounds: number[] | null, isErr: boolean) => {
      a.requests += count; if (isErr) a.errors += count;
      if (buckets && bounds) {
        const cur = a.buckets.get(bk);
        if (cur) { for (let i = 0; i < cur.length; i++) cur[i]! += buckets[i] ?? 0; } else { a.buckets.set(bk, [...buckets]); a.bounds.set(bk, bounds); }
      }
    };
    const p = (a: Acc, q: number): number | null => {
      if (!a.buckets.size) return null;
      const [bk, counts] = [...a.buckets].sort((x, y) => y[1].reduce((s1, v) => s1 + v, 0) - x[1].reduce((s2, v) => s2 + v, 0))[0]!;
      const r = histogramQuantile(a.bounds.get(bk)!, counts, q);
      return r ? Math.round(r.value * a.scale * 1000) / 1000 : null;
    };

    // ---- 1. per-series totals, summed inside MongoDB: one row per series (hundreds), not one per stored minute (hundreds of thousands)
    const maxLen = Math.max(...use.map((s) => (s.bounds?.length ?? 0) + 1));
    const bucketFields = Object.fromEntries(Array.from({ length: maxLen }, (_, i) => [`b${i}`, { $sum: { $ifNull: [{ $arrayElemAt: ['$buckets', i] }, 0] } }]));
    const totals = await this.db.c.metricPoints.aggregate<Record<string, unknown> & { _id: string }>([
      { $match: { seriesId: { $in: ids }, minute: { $gte: this.floor(from), $lte: to } } },
      { $group: { _id: '$seriesId', count: { $sum: '$count' }, lastMin: { $max: '$minute' }, ...bucketFields } },
    ], { maxTimeMS: QUERY_TIMEOUT_MS, allowDiskUse: true }).toArray();
    const tot = new Map(totals.map((t) => [t._id, t]));

    const info = new Map<string, { s: MetricSeriesDoc; bk: string; isErr: boolean; cls: string; route: string }>();
    const bySvc = new Map<string, { metric: string; total: Acc; statuses: Record<string, number>; routes: Map<string, Acc>; timeline: Map<number, Acc>; last: number }>();
    const rank = (n: string) => (n === HTTP_DURATION_METRICS[0].name ? 0 : 1);
    for (const s of use) {
      if (!tot.has(s._id)) continue;
      const status = label(s.attrs, STATUS_KEYS);
      info.set(s._id, { s, bk: boundsKey(s.bounds), isErr: !!status && /^5\d\d$/.test(status), cls: statusClass(status), route: label(s.attrs, ROUTE_KEYS) ?? 'unknown' });
      // Prefer the stable metric name for a service when both are reported (never add them together: that would double count).
      const cur = bySvc.get(s.service!);
      if (!cur || rank(s.name) < rank(cur.metric)) bySvc.set(s.service!, { metric: s.name, total: newAcc(toMs(s)), statuses: {}, routes: new Map(), timeline: new Map(), last: 0 });
    }
    for (const [id, i] of info) {
      const e = bySvc.get(i.s.service!)!;
      if (i.s.name !== e.metric) continue;
      const t = tot.get(id)!;
      const count = Number(t.count);
      const buckets = i.s.bounds ? Array.from({ length: i.s.bounds.length + 1 }, (_, k) => Number(t[`b${k}`] ?? 0)) : null;
      addTo(e.total, count, buckets, i.bk, i.s.bounds, i.isErr);
      e.statuses[i.cls] = (e.statuses[i.cls] ?? 0) + count;
      let r = e.routes.get(i.route);
      if (!r) { r = newAcc(e.total.scale); e.routes.set(i.route, r); }
      addTo(r, count, buckets, i.bk, i.s.bounds, i.isErr);
      const lm = t.lastMin instanceof Date ? t.lastMin.getTime() : 0;
      if (count > 0 && lm > e.last) e.last = lm;
    }

    // ---- 2. timeline per (service, metric, bucket layout): window rows summed inside MongoDB; 3. the 5xx subset for error counts
    const subsets = new Map<string, { svc: string; ids: string[]; errIds: string[]; bounds: number[] | null; bk: string }>();
    for (const [id, i] of info) {
      if (i.s.name !== bySvc.get(i.s.service!)!.metric) continue;
      const key = `${i.s.service}\u0001${i.bk}`;
      const sub = subsets.get(key) ?? { svc: i.s.service!, ids: [], errIds: [], bounds: i.s.bounds, bk: i.bk };
      sub.ids.push(id); if (i.isErr) sub.errIds.push(id);
      subsets.set(key, sub);
    }
    const work = [...subsets.values()];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(6, work.length) }, async () => {
      for (;;) {
        const w = work[next++];
        if (!w) return;
        const n = w.bounds ? w.bounds.length + 1 : 0;
        const [rows, errRows] = await Promise.all([
          this.aggregateWindows(w.ids, from, to, stepMs, { nBuckets: n }),
          w.errIds.length ? this.aggregateWindows(w.errIds, from, to, stepMs, { nBuckets: 0 }) : Promise.resolve([] as WindowRow[]),
        ]);
        const e = bySvc.get(w.svc)!;
        for (const r of rows) {
          let tl = e.timeline.get(r.t);
          if (!tl) { tl = newAcc(e.total.scale); e.timeline.set(r.t, tl); }
          addTo(tl, r.count, w.bounds ? r.buckets : null, w.bk, w.bounds, false);
        }
        for (const r of errRows) { const tl = e.timeline.get(r.t); if (tl) tl.errors += r.count; }
      }
    }));

    const services: HttpServiceStats[] = [...bySvc].map(([service, e]) => {
      const first = Math.floor(from.getTime() / stepMs) * stepMs;
      const timeline: HttpServiceStats['timeline'] = [];
      for (let t = first; t <= to.getTime(); t += stepMs) { const c = e.timeline.get(t); timeline.push({ t, requests: c ? c.requests : null, errors: c ? c.errors : null, p95Ms: c ? p(c, 0.95) : null }); }
      return {
        service, metric: e.metric, requests: e.total.requests, errors: e.total.errors, p50Ms: p(e.total, 0.5), p95Ms: p(e.total, 0.95), p99Ms: p(e.total, 0.99),
        statuses: e.statuses,
        routes: [...e.routes].map(([route, a]) => ({ route, requests: a.requests, errors: a.errors, p95Ms: p(a, 0.95) })).sort((a, b) => b.requests - a.requests).slice(0, 25),
        timeline, lastDataAt: e.last ? new Date(e.last) : null,
      };
    }).sort((a, b) => b.requests - a.requests);
    return { stepMs, services, notes };
  }

  // ================================================================== diagnostics
  async diagnostics(scope: Scope) {
    const match = { orgId: scope.orgId, projectId: scope.projectId, environmentId: { $in: scope.environmentIds } };
    const [series, pointDocs, top] = await Promise.all([
      this.db.c.metricSeries.countDocuments(match, { maxTimeMS: QUERY_TIMEOUT_MS }),
      this.db.c.metricPoints.countDocuments(match, { maxTimeMS: QUERY_TIMEOUT_MS }),
      this.db.c.metricSeries.aggregate<{ _id: string; series: number }>([{ $match: match }, { $group: { _id: '$name', series: { $sum: 1 } } }, { $sort: { series: -1 } }, { $limit: 10 }], { maxTimeMS: QUERY_TIMEOUT_MS }).toArray(),
    ]);
    let storageBytes: number | null = null;
    try {
      const [a, b] = await Promise.all([this.db.db.command({ collStats: 'metric_points' }), this.db.db.command({ collStats: 'metric_series' })]);
      storageBytes = Number(a.storageSize ?? 0) + Number(b.storageSize ?? 0); // whole collections, not per tenant: a platform-level figure
    } catch { /* not permitted for this user: omitted rather than faked */ }
    return {
      series, pointDocs, storageBytes, limits: { maxSeriesPerMetric: this.maxSeriesPerMetric, maxSeriesPerEnvironment: this.maxSeriesPerEnvironment },
      topMetrics: top.map((t) => ({ name: t._id, series: t.series, nearLimit: t.series >= this.maxSeriesPerMetric * 0.8 })),
    };
  }
}
