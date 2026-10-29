import { createHash } from 'node:crypto';
import { MAX_SPANS_PER_TRACE_RESPONSE, type DependencyEdge, type TraceQuery } from '@nexus/contracts';
import type { Database, SpanDoc, TraceSummaryDoc } from '@nexus/database';
import { buildTraceFilter, encodeCursor, type Scope } from './query.js';
import { SLIM_PROJECTION, startNs, summarizeTrace, type SpanSlim } from './summary.js';

export const QUERY_TIMEOUT_MS = 8_000;
/** More spans than this in ONE trace: the summary is computed from the first part only and the trace is flagged by its span count. */
export const MAX_SUMMARY_SPANS = 20_000;
/** Traces recomputed per write batch are bounded by the batch size; this caps one bulk write. */
const SUMMARY_WRITE_CHUNK = 500;

export interface SpanInsertResult { inserted: number; duplicates: number; tracesUpdated: number }
export interface SearchResult { items: TraceSummaryDoc[]; nextCursor: string | null }
export interface TraceBundle { summary: TraceSummaryDoc; spans: SpanDoc[]; totalSpans: number; truncated: boolean }

/** Per-service statistics derived from SERVER spans (labelled "trace-derived" wherever shown: they depend on what was sampled). */
export interface ServerSpanStats {
  service: string; spans: number; errors: number; lastSpanAt: Date | null;
  /** A bounded, newest-first sample of durations (ns) used for percentiles; `sampled` says whether it is the complete set. */
  durationsNs: number[]; sampled: boolean;
}

/** Storage contract for spans. MongoDB implements it today; ClickHouse (ADR-0005) could replace it without touching callers. */
export interface TraceStore {
  /** Idempotent: spans already stored are counted as duplicates. Affected trace summaries are recomputed. */
  insert(docs: SpanDoc[]): Promise<SpanInsertResult>;
  search(scope: Scope, q: TraceQuery): Promise<SearchResult>;
  getTrace(scope: Scope, traceId: string, limit?: number): Promise<TraceBundle | null>;
  getSpan(scope: Scope, traceId: string, spanId: string): Promise<SpanDoc | null>;
  /** Which of these trace ids have at least one stored span (used to tell "not arrived" from "known"). */
  knownTraces(scope: Scope, traceIds: string[]): Promise<Set<string>>;
  serverSpanStats(scope: Scope, from: Date, to: Date, sampleLimit?: number): Promise<ServerSpanStats[]>;
  /** Requests and errors per service per window, from SERVER spans (trace-derived). Windows with no spans are absent, never zero. */
  serverSpanTimeline(scope: Scope, from: Date, to: Date, stepMs: number): Promise<{ service: string; t: number; count: number; errors: number }[]>;
  dependencies(scope: Scope, from: Date, to: Date): Promise<{ edges: DependencyEdge[]; sampled: boolean }>;
}

const isDup = (e: unknown) => (e as { code?: number })?.code === 11000;
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
// The organization is part of every id: tenants can never collide even if project/environment ids were ever reused.
export const spanId = (orgId: string, projectId: string, environmentId: string, traceId: string, span: string) => sha1(`${orgId}|${projectId}|${environmentId}|${traceId}|${span}`);
export const summaryId = (orgId: string, projectId: string, environmentId: string, traceId: string) => sha1(`${orgId}|${projectId}|${environmentId}|${traceId}|summary`);

export class MongoTraceStore implements TraceStore {
  constructor(private readonly db: Database, private readonly now: () => Date = () => new Date()) {}

  async insert(docs: SpanDoc[]): Promise<SpanInsertResult> {
    if (!docs.length) return { inserted: 0, duplicates: 0, tracesUpdated: 0 };
    let inserted = docs.length, duplicates = 0;
    try {
      await this.db.c.spans.insertMany(docs, { ordered: false });
    } catch (e) {
      // A span stored before (retransmission, or the same span arriving through a second path) hits the unique _id: idempotency, not failure.
      const errs = (e as { writeErrors?: { code?: number }[] }).writeErrors ?? [];
      if (isDup(e) || (errs.length > 0 && errs.every((w) => w.code === 11000))) {
        duplicates = Math.max(errs.length, 1);
        inserted = docs.length - duplicates;
      } else throw e;
    }
    // Even a batch of pure duplicates recomputes: it is cheap and makes a crash between the span write and the summary write self-healing.
    const tracesUpdated = await this.recompute(docs);
    return { inserted, duplicates, tracesUpdated };
  }

  /** Recomputes the summary of every (environment, trace) touched by `docs` from the spans in storage. Order, batching and duplicates cannot matter. */
  private async recompute(docs: SpanDoc[]): Promise<number> {
    const groups = new Map<string, { orgId: string; projectId: string; environmentId: string; traceIds: Set<string> }>();
    for (const d of docs) {
      const k = `${d.orgId}|${d.projectId}|${d.environmentId}`;
      const g = groups.get(k) ?? { orgId: d.orgId, projectId: d.projectId, environmentId: d.environmentId, traceIds: new Set<string>() };
      g.traceIds.add(d.traceId);
      groups.set(k, g);
    }
    const now = this.now();
    const writes: { replaceOne: { filter: { _id: string }; replacement: TraceSummaryDoc; upsert: true } }[] = [];
    for (const g of groups.values()) {
      const rows = await this.db.c.spans
        .find({ orgId: g.orgId, projectId: g.projectId, environmentId: g.environmentId, traceId: { $in: [...g.traceIds] } }, { projection: { ...SLIM_PROJECTION, traceId: 1 } })
        .limit(MAX_SUMMARY_SPANS * Math.min(g.traceIds.size, 4)).maxTimeMS(QUERY_TIMEOUT_MS).toArray();
      const byTrace = new Map<string, (SpanSlim & { traceId: string })[]>();
      for (const r of rows as unknown as (SpanSlim & { traceId: string })[]) {
        const list = byTrace.get(r.traceId) ?? [];
        if (list.length < MAX_SUMMARY_SPANS) list.push(r);
        byTrace.set(r.traceId, list);
      }
      for (const [traceId, spans] of byTrace) {
        const s = summarizeTrace({ _id: summaryId(g.orgId, g.projectId, g.environmentId, traceId), orgId: g.orgId, projectId: g.projectId, environmentId: g.environmentId, traceId }, spans, now);
        if (s) writes.push({ replaceOne: { filter: { _id: s._id }, replacement: s, upsert: true } });
      }
    }
    for (let i = 0; i < writes.length; i += SUMMARY_WRITE_CHUNK) await this.db.c.traceSummaries.bulkWrite(writes.slice(i, i + SUMMARY_WRITE_CHUNK), { ordered: false });
    return writes.length;
  }

  async search(scope: Scope, q: TraceQuery): Promise<SearchResult> {
    const sort: Record<string, 1 | -1> = q.sort === 'slowest' ? { durationNs: -1, _id: -1 } : { start: -1, _id: -1 };
    const rows = await this.db.c.traceSummaries.find(buildTraceFilter(q, scope) as never).sort(sort).limit(q.limit + 1).maxTimeMS(QUERY_TIMEOUT_MS).toArray();
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    const next = rows.length > q.limit && last ? encodeCursor(q.sort === 'slowest' ? last.durationNs : last.start.getTime(), last._id) : null;
    return { items: page, nextCursor: next };
  }

  async getTrace(scope: Scope, traceId: string, limit = MAX_SPANS_PER_TRACE_RESPONSE): Promise<TraceBundle | null> {
    const base = { orgId: scope.orgId, projectId: scope.projectId, environmentId: { $in: scope.environmentIds }, traceId };
    const summary = await this.db.c.traceSummaries.find(base as never).sort({ start: 1 }).limit(1).maxTimeMS(QUERY_TIMEOUT_MS).next();
    if (!summary) return null;
    // Spans are read in start order up to the response limit; the summary says how many exist.
    const spans = await this.db.c.spans.find({ ...base, environmentId: summary.environmentId } as never).sort({ start: 1 }).limit(limit).maxTimeMS(QUERY_TIMEOUT_MS).toArray();
    spans.sort((a, b) => (startNs(a) < startNs(b) ? -1 : startNs(a) > startNs(b) ? 1 : 0));
    return { summary, spans, totalSpans: summary.spanCount, truncated: summary.spanCount > spans.length };
  }

  async getSpan(scope: Scope, traceId: string, span: string): Promise<SpanDoc | null> {
    return this.db.c.spans.findOne({ orgId: scope.orgId, projectId: scope.projectId, environmentId: { $in: scope.environmentIds }, traceId, spanId: span } as never, { maxTimeMS: QUERY_TIMEOUT_MS });
  }

  async knownTraces(scope: Scope, traceIds: string[]): Promise<Set<string>> {
    if (!traceIds.length) return new Set();
    const rows = await this.db.c.traceSummaries
      .find({ orgId: scope.orgId, projectId: scope.projectId, environmentId: { $in: scope.environmentIds }, traceId: { $in: traceIds.slice(0, 500) } } as never, { projection: { traceId: 1 } })
      .limit(500).maxTimeMS(QUERY_TIMEOUT_MS).toArray();
    return new Set(rows.map((r) => r.traceId));
  }

  async serverSpanStats(scope: Scope, from: Date, to: Date, sampleLimit = 50_000): Promise<ServerSpanStats[]> {
    const match = { orgId: scope.orgId, projectId: scope.projectId, environmentId: { $in: scope.environmentIds }, start: { $gte: from, $lte: to }, kind: 'server' };
    // Covered by spans_scope_start_cover: counts come from index entries only.
    const groups = await this.db.c.spans.aggregate<{ _id: string | null; spans: number; errors: number; last: Date }>([
      { $match: match },
      { $group: { _id: '$service', spans: { $sum: 1 }, errors: { $sum: { $cond: [{ $eq: ['$statusCode', 'error'] }, 1, 0] } }, last: { $max: '$start' } } },
    ], { maxTimeMS: QUERY_TIMEOUT_MS }).toArray();
    // ONE covered pass over the newest spans (service + duration are in the index) instead of one query per service. Durations with no valid
    // end are absent (durationNs null) and never counted. The sample is capped per service and overall; `sampled` says when it is not complete.
    const perService = Math.min(sampleLimit, 50_000);
    const cap = perService * Math.min(Math.max(groups.length, 1), 4);
    const rows = await this.db.c.spans.find({ ...match, durationNs: { $ne: null } } as never, { projection: { service: 1, durationNs: 1, _id: 0 } })
      .sort({ start: -1 }).limit(cap).maxTimeMS(QUERY_TIMEOUT_MS).toArray();
    const durs = new Map<string, number[]>();
    for (const r of rows) {
      if (!r.service) continue;
      const list = durs.get(r.service) ?? [];
      if (list.length < perService) list.push(r.durationNs as number);
      durs.set(r.service, list);
    }
    const out: ServerSpanStats[] = [];
    for (const g of groups) {
      if (!g._id) continue; // spans without a service name cannot be attributed; never lumped under an invented name
      const list = durs.get(g._id) ?? [];
      out.push({ service: g._id, spans: g.spans, errors: g.errors, lastSpanAt: g.last, durationsNs: list, sampled: g.spans > list.length });
    }
    return out;
  }

  async serverSpanTimeline(scope: Scope, from: Date, to: Date, stepMs: number) {
    const rows = await this.db.c.spans.aggregate<{ _id: { s: string | null; b: number }; count: number; errors: number }>([
      { $match: { orgId: scope.orgId, projectId: scope.projectId, environmentId: { $in: scope.environmentIds }, start: { $gte: from, $lte: to }, kind: 'server' } },
      { $group: { _id: { s: '$service', b: { $subtract: [{ $toLong: '$start' }, { $mod: [{ $toLong: '$start' }, stepMs] }] } }, count: { $sum: 1 }, errors: { $sum: { $cond: [{ $eq: ['$statusCode', 'error'] }, 1, 0] } } } },
    ], { maxTimeMS: QUERY_TIMEOUT_MS }).toArray();
    return rows.filter((r) => r._id.s).map((r) => ({ service: r._id.s as string, t: r._id.b, count: r.count, errors: r.errors })).sort((a, b) => a.t - b.t);
  }

  /**
   * Observed relationships only. `parent-child`: a CLIENT span whose child is a span of ANOTHER service (the strongest evidence);
   * `span-attribute`: a CLIENT span naming a datastore (db.system) or an external peer. Inference beyond that is not attempted.
   */
  async dependencies(scope: Scope, from: Date, to: Date): Promise<{ edges: DependencyEdge[]; sampled: boolean }> {
    const LIMIT = 20_000;
    const base = { orgId: scope.orgId, projectId: scope.projectId, environmentId: { $in: scope.environmentIds } };
    const clients = await this.db.c.spans.find({ ...base, start: { $gte: from, $lte: to }, kind: 'client' } as never,
      { projection: { traceId: 1, spanId: 1, service: 1, dbSystem: 1, peerService: 1, statusCode: 1 } }).limit(LIMIT).maxTimeMS(QUERY_TIMEOUT_MS).toArray();
    const sampled = clients.length >= LIMIT;
    const edges = new Map<string, DependencyEdge>();
    const bump = (e: Omit<DependencyEdge, 'calls' | 'errors'>, error: boolean) => {
      const key = `${e.from}|${e.to}|${e.kind}|${e.basis}`;
      const cur = edges.get(key) ?? { ...e, calls: 0, errors: 0 };
      cur.calls++; if (error) cur.errors++;
      edges.set(key, cur);
    };
    const byParent = new Map<string, (typeof clients)[number]>();
    for (const c of clients) byParent.set(`${c.traceId}|${c.spanId}`, c);
    if (clients.length) {
      const children = await this.db.c.spans.find({ ...base, traceId: { $in: [...new Set(clients.map((c) => c.traceId))] }, parentSpanId: { $in: clients.map((c) => c.spanId) } } as never,
        { projection: { traceId: 1, parentSpanId: 1, service: 1 } }).limit(LIMIT * 2).maxTimeMS(QUERY_TIMEOUT_MS).toArray();
      const linked = new Set<string>();
      for (const ch of children) {
        const parent = byParent.get(`${ch.traceId}|${ch.parentSpanId}`);
        if (!parent?.service || !ch.service || parent.service === ch.service) continue;
        linked.add(`${parent.traceId}|${parent.spanId}`);
        bump({ from: parent.service, to: ch.service, kind: 'service', basis: 'parent-child' }, parent.statusCode === 'error');
      }
      for (const c of clients) {
        if (!c.service || linked.has(`${c.traceId}|${c.spanId}`)) continue;
        if (c.dbSystem) bump({ from: c.service, to: c.dbSystem, kind: 'database', basis: 'span-attribute' }, c.statusCode === 'error');
        else if (c.peerService) bump({ from: c.service, to: c.peerService, kind: 'external', basis: 'span-attribute' }, c.statusCode === 'error');
      }
    }
    return { edges: [...edges.values()].sort((a, b) => b.calls - a.calls).slice(0, 200), sampled };
  }
}
