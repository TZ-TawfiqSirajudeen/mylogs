import { SEARCH_INDEX, type Database, type LogDoc } from '@nexus/database';
import { SEVERITIES } from '@nexus/contracts';
import { buildFilter, decodeCursor, encodeCursor, searchTerms, type LogQuery, type Scope } from './query.js';

export const QUERY_TIMEOUT_MS = 8_000;
/** Covers (scope, ts, service, level): histogram and facets read only index entries, never documents. */
export const COVERING_INDEX = 'logs_scope_ts_svc_lvl';
const LEVEL_INDEX = 'logs_scope_level_ts';
const ERROR_LEVEL = SEVERITIES.indexOf('error');
/** Concurrent per-bucket counts one histogram request may run (keeps a single request from monopolising the connection pool). */
const HISTOGRAM_PARALLELISM = 12;

/** Runs `fn` with a hint; if the hinted index does not exist (e.g. a rollback), runs it again letting the planner choose. */
async function hinted<T>(hint: string | undefined, fn: (hint: string | undefined) => Promise<T>): Promise<T> {
  try { return await fn(hint); } catch (e) {
    if (hint && /hint provided does not correspond to an existing index|bad hint/i.test(String((e as Error)?.message))) return fn(undefined);
    throw e;
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) { const i = next++; if (i >= items.length) return; out[i] = await fn(items[i]!); }
  }));
  return out;
}

/** What the list view needs; the full record (stack, attributes) is fetched on demand. */
export type LogSummary = Pick<LogDoc,
  '_id' | 'ts' | 'severity' | 'service' | 'host' | 'traceId' | 'spanId' | 'requestId' | 'httpMethod' | 'httpRoute' | 'httpStatus' |
  'durationMs' | 'errorType' | 'environmentId' | 'redactions'> & { message: string; hasStack: boolean };

const SUMMARY_PROJECTION = {
  ts: 1, severity: 1, service: 1, host: 1, traceId: 1, spanId: 1, requestId: 1, httpMethod: 1, httpRoute: 1, httpStatus: 1,
  durationMs: 1, errorType: 1, environmentId: 1, redactions: 1, message: 1, stack: 1,
} as const;

export interface SearchResult { items: LogSummary[]; nextCursor: string | null }
export interface Histogram { bucketMs: number; buckets: { t: number; total: number; errors: number }[] }
export interface Facets { services: { value: string; count: number }[]; severities: { value: string; count: number }[] }
export interface InsertResult { inserted: number; duplicates: number }

/** Storage contract for logs. MongoDB implements it today; a ClickHouse implementation can replace it without touching callers. */
export interface LogStore {
  insert(docs: LogDoc[]): Promise<InsertResult>;
  search(scope: Scope, q: LogQuery): Promise<SearchResult>;
  get(scope: Scope, id: string): Promise<LogDoc | null>;
  related(scope: Scope, doc: LogDoc, limit?: number): Promise<{ by: 'traceId' | 'requestId' | null; items: LogSummary[] }>;
  neighbors(scope: Scope, doc: LogDoc, each?: number): Promise<{ before: LogSummary[]; after: LogSummary[] }>;
  histogram(scope: Scope, q: LogQuery, buckets?: number): Promise<Histogram>;
  facets(scope: Scope, q: LogQuery): Promise<Facets>;
  /** Records that arrived after `cursor` (arrival order), for live tail. */
  tail(scope: Scope, q: LogQuery): Promise<SearchResult>;
  /** Streams matching records for export; never more than `maxRows`. */
  exportRows(scope: Scope, q: LogQuery, maxRows: number): AsyncIterable<LogDoc>;
}

const toSummary = (d: LogDoc & { stack?: string | null }): LogSummary => ({
  _id: d._id, ts: d.ts, severity: d.severity, service: d.service, host: d.host, traceId: d.traceId, spanId: d.spanId, requestId: d.requestId,
  httpMethod: d.httpMethod, httpRoute: d.httpRoute, httpStatus: d.httpStatus, durationMs: d.durationMs, errorType: d.errorType,
  environmentId: d.environmentId, redactions: d.redactions, message: d.message.length > 600 ? `${d.message.slice(0, 600)}…` : d.message, hasStack: !!d.stack,
});

const isDup = (e: unknown) => (e as { code?: number })?.code === 11000;

export class MongoLogStore implements LogStore {
  constructor(private readonly db: Database) {}

  async insert(docs: LogDoc[]): Promise<InsertResult> {
    if (!docs.length) return { inserted: 0, duplicates: 0 };
    try {
      const r = await this.db.c.logs.insertMany(docs, { ordered: false });
      return { inserted: r.insertedCount, duplicates: 0 };
    } catch (e) {
      // Retransmitted batches hit the unique _id: that is idempotency working, not a failure.
      const err = e as { code?: number; writeErrors?: { code?: number }[]; result?: { insertedCount?: number }; insertedCount?: number };
      const errs = err.writeErrors ?? [];
      if (isDup(e) || (errs.length > 0 && errs.every((w) => w.code === 11000))) {
        const dups = Math.max(errs.length, 1);
        return { inserted: docs.length - dups, duplicates: dups };
      }
      throw e;
    }
  }

  async search(scope: Scope, q: LogQuery): Promise<SearchResult> {
    const filter = buildFilter(q, scope);
    // Free-text terms are matched inside the index (searchText); the planner would otherwise pick a plan that fetches every document.
    const rows = await hinted(searchTerms(q.text).length ? SEARCH_INDEX : undefined, (hint) => this.db.c.logs
      .find(filter as never, { projection: SUMMARY_PROJECTION, ...(hint ? { hint } : {}) })
      .sort({ ts: q.sort === 'desc' ? -1 : 1, _id: q.sort === 'desc' ? -1 : 1 })
      .limit(q.limit + 1).maxTimeMS(QUERY_TIMEOUT_MS).toArray());
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { items: page.map(toSummary), nextCursor: rows.length > q.limit && last ? encodeCursor(last.ts.getTime(), last._id) : null };
  }

  async get(scope: Scope, id: string): Promise<LogDoc | null> {
    return this.db.c.logs.findOne({ _id: id, orgId: scope.orgId, projectId: scope.projectId, environmentId: { $in: scope.environmentIds } }, { maxTimeMS: QUERY_TIMEOUT_MS });
  }

  async related(scope: Scope, doc: LogDoc, limit = 200) {
    const by: 'traceId' | 'requestId' | null = doc.traceId ? 'traceId' : doc.requestId ? 'requestId' : null;
    if (!by) return { by: null, items: [] };
    const windowMs = 3600_000;
    const rows = await this.db.c.logs.find({
      orgId: scope.orgId, projectId: scope.projectId, environmentId: doc.environmentId, [by]: doc[by],
      ts: { $gte: new Date(doc.ts.getTime() - windowMs), $lte: new Date(doc.ts.getTime() + windowMs) },
    } as never, { projection: SUMMARY_PROJECTION }).sort({ ts: 1, _id: 1 }).limit(limit).maxTimeMS(QUERY_TIMEOUT_MS).toArray();
    return { by, items: rows.map(toSummary) };
  }

  async neighbors(scope: Scope, doc: LogDoc, each = 5) {
    const base = { orgId: scope.orgId, projectId: scope.projectId, environmentId: doc.environmentId, service: doc.service, host: doc.host, _id: { $ne: doc._id } };
    const [before, after] = await Promise.all([
      this.db.c.logs.find({ ...base, ts: { $lte: doc.ts } } as never, { projection: SUMMARY_PROJECTION }).sort({ ts: -1, _id: -1 }).limit(each).maxTimeMS(QUERY_TIMEOUT_MS).toArray(),
      this.db.c.logs.find({ ...base, ts: { $gt: doc.ts } } as never, { projection: SUMMARY_PROJECTION }).sort({ ts: 1, _id: 1 }).limit(each).maxTimeMS(QUERY_TIMEOUT_MS).toArray(),
    ]);
    return { before: before.reverse().map(toSummary), after: after.map(toSummary) };
  }

  /**
   * Volume over time. When the filter can be answered from the covering index alone (scope, time, severity, service) each bucket is
   * an index-range COUNT run in parallel (~10x faster than grouping every record). Filters that need document fields (free text,
   * attribute and field filters) fall back to a single aggregation, which is correct but linear in the matching records.
   */
  async histogram(scope: Scope, q: LogQuery, buckets = 60): Promise<Histogram> {
    const fromMs = Date.parse(q.from), toMs = Date.parse(q.to);
    const bucketMs = Math.max(1000, Math.ceil((toMs - fromMs) / buckets / 1000) * 1000);
    const indexOnly = searchTerms(q.text).length === 0 && q.filters.length === 0;
    return indexOnly ? this.histogramByCounts(scope, q, bucketMs, fromMs, toMs) : this.histogramByAggregation(scope, q, bucketMs);
  }

  private async histogramByCounts(scope: Scope, q: LogQuery, bucketMs: number, fromMs: number, toMs: number): Promise<Histogram> {
    const base = buildFilter({ ...q, cursor: undefined }, scope);
    const baseAnd = (base.$and as unknown[] | undefined) ?? [];
    const errorsImplied = !!q.errorsOnly || (!!q.minSeverity && SEVERITIES.indexOf(q.minSeverity) >= ERROR_LEVEL);
    const errorsHint = q.services?.length ? COVERING_INDEX : LEVEL_INDEX;
    const starts: number[] = [];
    for (let t = Math.floor(fromMs / bucketMs) * bucketMs; t <= toMs; t += bucketMs) starts.push(t);
    const rows = await mapLimit(starts, HISTOGRAM_PARALLELISM, async (t) => {
      const ts = { $gte: new Date(Math.max(t, fromMs)), $lte: new Date(Math.min(t + bucketMs - 1, toMs)) };
      const total = await hinted(COVERING_INDEX, (hint) => this.db.c.logs.countDocuments({ ...base, ts } as never, { maxTimeMS: QUERY_TIMEOUT_MS, ...(hint ? { hint } : {}) }));
      if (total === 0) return { t, total: 0, errors: 0 };
      const errors = errorsImplied ? total : await hinted(errorsHint, (hint) =>
        this.db.c.logs.countDocuments({ ...base, ts, $and: [...baseAnd, { level: { $gte: ERROR_LEVEL } }] } as never, { maxTimeMS: QUERY_TIMEOUT_MS, ...(hint ? { hint } : {}) }));
      return { t, total, errors };
    });
    return { bucketMs, buckets: rows.filter((r) => r.total > 0) };
  }

  private async histogramByAggregation(scope: Scope, q: LogQuery, bucketMs: number): Promise<Histogram> {
    const rows = await this.db.c.logs.aggregate<{ _id: number; total: number; errors: number }>([
      { $match: buildFilter({ ...q, cursor: undefined }, scope) },
      { $group: { _id: { $subtract: [{ $toLong: '$ts' }, { $mod: [{ $toLong: '$ts' }, bucketMs] }] }, total: { $sum: 1 }, errors: { $sum: { $cond: [{ $gte: ['$level', ERROR_LEVEL] }, 1, 0] } } } },
      { $sort: { _id: 1 } },
    ], { maxTimeMS: QUERY_TIMEOUT_MS }).toArray();
    return { bucketMs, buckets: rows.map((r) => ({ t: r._id, total: r.total, errors: r.errors })) };
  }

  /** One pass over (service, level) groups feeds both facets; with only index-answerable filters it is a covered scan. */
  async facets(scope: Scope, q: LogQuery): Promise<Facets> {
    const match = { $match: buildFilter({ ...q, cursor: undefined }, scope) };
    const hint = searchTerms(q.text).length ? SEARCH_INDEX : q.filters.length ? undefined : COVERING_INDEX;
    const rows = await hinted(hint, (h) => this.db.c.logs.aggregate<{ _id: { s: string | null; l: number }; count: number }>(
      [match, { $group: { _id: { s: '$service', l: '$level' }, count: { $sum: 1 } } }],
      { maxTimeMS: QUERY_TIMEOUT_MS, ...(h ? { hint: h } : {}) },
    ).toArray());
    const services = new Map<string, number>();
    const severities = new Map<string, number>();
    for (const r of rows) {
      if (r._id.s !== null && r._id.s !== undefined) services.set(r._id.s, (services.get(r._id.s) ?? 0) + r.count);
      const sev = SEVERITIES[r._id.l];
      if (sev) severities.set(sev, (severities.get(sev) ?? 0) + r.count);
    }
    return {
      services: [...services].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 50).map(([value, count]) => ({ value, count })),
      severities: [...severities].map(([value, count]) => ({ value, count })),
    };
  }

  async tail(scope: Scope, q: LogQuery): Promise<SearchResult> {
    const filter = buildFilter({ ...q, sort: 'asc' }, scope, { timeField: 'receivedAt' });
    const rows = await this.db.c.logs.find(filter as never, { projection: { ...SUMMARY_PROJECTION, receivedAt: 1 } })
      .sort({ receivedAt: 1, _id: 1 }).limit(q.limit).maxTimeMS(QUERY_TIMEOUT_MS).toArray();
    const last = rows[rows.length - 1] as (LogDoc | undefined);
    return { items: rows.map(toSummary), nextCursor: last ? encodeCursor(last.receivedAt.getTime(), last._id) : (q.cursor && decodeCursor(q.cursor) ? q.cursor : null) };
  }

  async *exportRows(scope: Scope, q: LogQuery, maxRows: number): AsyncIterable<LogDoc> {
    const cursor = this.db.c.logs.find(buildFilter({ ...q, cursor: undefined }, scope) as never)
      .sort({ ts: q.sort === 'desc' ? -1 : 1, _id: 1 }).limit(maxRows).maxTimeMS(60_000).batchSize(500);
    try { for await (const d of cursor) yield d; } finally { await cursor.close(); }
  }
}
