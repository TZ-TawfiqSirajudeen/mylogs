import { TraceQuery } from '@nexus/contracts';
import type { Database, SpanDoc } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildTraceFilter, decodeCursor, encodeCursor, type Scope } from './query.js';
import { MongoTraceStore, spanId as spanDocId } from './store.js';
import { completenessWarnings, endNs, startNs, summarizeTrace } from './summary.js';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let db: Database;
let store: MongoTraceStore;

const ORG = 'org-a', OTHER_ORG = 'org-b', PROJECT = 'proj-1';
const ENV = '11111111-1111-4111-8111-111111111111', ENV2 = '22222222-2222-4222-8222-222222222222';
const scope: Scope = { orgId: ORG, projectId: PROJECT, environmentIds: [ENV, ENV2] };
const T0 = Date.parse('2026-03-01T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const tid = (n: number) => n.toString(16).padStart(32, '0');
const sid = (n: number) => n.toString(16).padStart(16, '0');
const q = (over: Record<string, unknown> = {}) => TraceQuery.parse({ from: iso(T0 - 6 * 3600_000), to: iso(T0 + 3600_000), ...over });

interface Opts extends Partial<SpanDoc> { t: number; s: number; startMs?: number; durMs?: number; fracStart?: number; fracEnd?: number }
function span(o: Opts): SpanDoc {
  const { t, s, startMs = T0, durMs = 10, fracStart = 0, fracEnd = 0, ...rest } = o;
  const env = rest.environmentId ?? ENV;
  const org = rest.orgId ?? ORG;
  return {
    _id: spanDocId(org, rest.projectId ?? PROJECT, env, tid(t), sid(s)), orgId: org, projectId: PROJECT, environmentId: env, tokenId: 'tok',
    traceId: tid(t), spanId: sid(s), parentSpanId: null, name: `op-${s}`, kind: 'internal',
    start: new Date(startMs), end: new Date(startMs + durMs), startNsFrac: fracStart, endNsFrac: fracEnd, durationNs: durMs * 1e6 + fracEnd - fracStart, timingValid: true,
    statusCode: 'unset', statusMessage: null, service: 'gateway', serviceVersion: null, host: null, deployment: null, scopeName: null, scopeVersion: null,
    traceState: null, flags: null, attrs: [], resource: [], events: [], links: [], droppedAttrs: 0, droppedEvents: 0, droppedLinks: 0, attrsTruncated: false,
    httpMethod: null, httpRoute: null, httpStatus: null, dbSystem: null, peerService: null, exceptionType: null,
    receivedAt: new Date(T0), expireAt: new Date(T0 + 30 * 86400_000), redactions: 0, ...rest,
  } as SpanDoc;
}

beforeAll(async () => {
  mongo = await startTestMongo();
  db = await freshTestDatabase(mongo.uri);
  store = new MongoTraceStore(db, () => new Date(T0 + 1000));
}, 240_000);
afterAll(async () => { await db?.close(); await mongo?.stop(); });

describe('summarizeTrace (pure)', () => {
  const key = { _id: 'k', orgId: ORG, projectId: PROJECT, environmentId: ENV, traceId: tid(1) };
  const now = new Date(T0);
  test('is independent of the order spans arrive in', () => {
    const spans = [
      span({ t: 1, s: 1, name: 'root', kind: 'server', httpRoute: '/r', httpStatus: 200, httpMethod: 'GET' }),
      span({ t: 1, s: 2, parentSpanId: sid(1), startMs: T0 + 5, durMs: 20, service: 'backend', statusCode: 'error' }),
      span({ t: 1, s: 3, parentSpanId: sid(2), startMs: T0 + 8, durMs: 4, service: 'backend', dbSystem: 'mongodb' }),
    ];
    const a = summarizeTrace(key, spans, now);
    const b = summarizeTrace(key, [...spans].reverse(), now);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ spanCount: 3, errorCount: 1, services: ['gateway', 'backend'], rootSpanId: sid(1), rootName: 'root', hasRoot: true, orphanCount: 0, httpRoute: '/r', httpStatus: 200 });
    expect(a!.durationNs).toBe(25 * 1e6); // child ends at +25ms, later than the root's +10ms: the trace is as long as its latest end
  });
  test('uses exact nanoseconds: sub-millisecond fractions are part of start, end and duration', () => {
    const s = summarizeTrace(key, [span({ t: 1, s: 1, durMs: 1, fracStart: 999_999, fracEnd: 1 })], now)!;
    expect(s.durationNs).toBe(1_000_000 + 1 - 999_999);
    const sp = span({ t: 1, s: 1, fracStart: 123_456 });
    expect(startNs(sp) % 1_000_000n).toBe(123_456n);
    expect(endNs(sp) - startNs(sp)).toBe(10_000_000n - 123_456n + 0n);
  });
  test('a missing parent is reported as an orphan; no root is invented', () => {
    const s = summarizeTrace(key, [span({ t: 1, s: 2, parentSpanId: sid(99) })], now)!;
    expect(s).toMatchObject({ hasRoot: false, orphanCount: 1, rootSpanId: null, rootName: null });
    expect(completenessWarnings(s, false, 1).join(' ')).toMatch(/No root span.*parent span that has not been received/s);
  });
  test('spans with invalid timing do not stretch the trace and are counted', () => {
    const bad = span({ t: 1, s: 2, parentSpanId: sid(1), startMs: T0 + 5, durMs: 0, timingValid: false, durationNs: null });
    const s = summarizeTrace(key, [span({ t: 1, s: 1 }), { ...bad, end: new Date(T0 + 500_000) }], now)!;
    expect(s.invalidTimingCount).toBe(1);
    expect(s.durationNs).toBe(10 * 1e6);
  });
  test('nothing stored -> no summary', () => { expect(summarizeTrace(key, [], now)).toBeNull(); });
  test('complete traces carry no warnings', () => {
    const s = summarizeTrace(key, [span({ t: 1, s: 1 }), span({ t: 1, s: 2, parentSpanId: sid(1) })], now)!;
    expect(completenessWarnings(s, false, 2)).toEqual([]);
  });
});

describe('ingestion into the store', () => {
  test('inserting is idempotent: a replayed span is a duplicate and counts do not change', async () => {
    const spans = [span({ t: 10, s: 1 }), span({ t: 10, s: 2, parentSpanId: sid(1) })];
    expect(await store.insert(spans)).toEqual({ inserted: 2, duplicates: 0, tracesUpdated: 1 });
    expect(await store.insert(spans)).toEqual({ inserted: 0, duplicates: 2, tracesUpdated: 1 });
    expect(await store.insert([spans[0]!, span({ t: 10, s: 3, parentSpanId: sid(1) })])).toMatchObject({ inserted: 1, duplicates: 1 });
    const t = (await store.getTrace(scope, tid(10)))!;
    expect(t.summary.spanCount).toBe(3);
    expect(t.spans.map((s) => s.spanId).sort()).toEqual([sid(1), sid(2), sid(3)]);
  });

  test('late and out-of-order spans: a child arriving first makes an orphan, the root arriving later repairs the summary', async () => {
    await store.insert([span({ t: 11, s: 2, parentSpanId: sid(1), startMs: T0 + 3, durMs: 5, service: 'backend' })]);
    let s = (await store.getTrace(scope, tid(11)))!.summary;
    expect(s).toMatchObject({ hasRoot: false, orphanCount: 1, spanCount: 1 });
    await store.insert([span({ t: 11, s: 1, durMs: 20, kind: 'server', name: 'GET /x' })]);
    s = (await store.getTrace(scope, tid(11)))!.summary;
    expect(s).toMatchObject({ hasRoot: true, orphanCount: 0, spanCount: 2, rootName: 'GET /x' });
    expect(s.services.sort()).toEqual(['backend', 'gateway']);
  });

  test('partial traces across several batches converge to the same summary as one batch', async () => {
    const all = [span({ t: 12, s: 1, durMs: 30 }), ...[2, 3, 4, 5].map((n) => span({ t: 12, s: n, parentSpanId: sid(1), startMs: T0 + n, durMs: 3, service: n % 2 ? 'a' : 'b' }))];
    await store.insert(all.slice(3)); await store.insert(all.slice(1, 3)); await store.insert(all.slice(0, 1));
    const split = (await store.getTrace(scope, tid(12)))!.summary;
    const { updatedAt: _u, _id: _i, ...splitRest } = split;
    const key = { _id: 'x', orgId: ORG, projectId: PROJECT, environmentId: ENV, traceId: tid(12) };
    const { updatedAt: _u2, _id: _i2, ...oneShot } = summarizeTrace(key, all, new Date())!;
    expect(splitRest).toEqual(oneShot);
  });

  test('spans of the same trace id in different tenants or environments never mix', async () => {
    await store.insert([
      span({ t: 13, s: 1, environmentId: ENV }), span({ t: 13, s: 2, environmentId: ENV2, parentSpanId: sid(1) }),
      span({ t: 13, s: 3, orgId: OTHER_ORG, name: 'other tenant secret' }),
    ]);
    const s = (await store.getTrace({ ...scope, environmentIds: [ENV] }, tid(13)))!;
    expect(s.summary.spanCount).toBe(1);
    expect(s.spans.map((x) => x.name)).not.toContain('other tenant secret');
    expect(await store.getTrace({ orgId: OTHER_ORG, projectId: PROJECT, environmentIds: [ENV] }, tid(13)).then((x) => x?.spans.map((y) => y.spanId))).toEqual([sid(3)]);
    expect(await store.getTrace({ orgId: 'nobody', projectId: PROJECT, environmentIds: [ENV] }, tid(13))).toBeNull();
  });

  test('a large trace is returned truncated, in start order, with the true span count', async () => {
    await store.insert(Array.from({ length: 60 }, (_, i) => span({ t: 14, s: i + 1, parentSpanId: i ? sid(1) : null, startMs: T0 + i })));
    const t = (await store.getTrace(scope, tid(14), 25))!;
    expect(t.spans).toHaveLength(25);
    expect(t.totalSpans).toBe(60);
    expect(t.truncated).toBe(true);
    expect(t.spans[0]!.spanId).toBe(sid(1));
  });

  test('spans survive without an end time: stored as evidence, never as a fabricated duration', async () => {
    await store.insert([span({ t: 15, s: 1, timingValid: false, durationNs: null })]);
    const t = (await store.getTrace(scope, tid(15)))!;
    expect(t.spans[0]!.durationNs).toBeNull();
    expect(t.summary.invalidTimingCount).toBe(1);
  });
});

describe('search', () => {
  beforeAll(async () => {
    const docs: SpanDoc[] = [];
    for (let i = 0; i < 40; i++) {
      const t = 100 + i;
      const failing = i % 5 === 0;
      docs.push(
        span({ t, s: 1, startMs: T0 - i * 60_000, durMs: 100 + i * 10, kind: 'server', name: 'GET /orders/:id', httpMethod: 'GET', httpRoute: '/orders/:id', httpStatus: failing ? 500 : 200, statusCode: failing ? 'error' : 'unset' }),
        span({ t, s: 2, parentSpanId: sid(1), startMs: T0 - i * 60_000 + 5, durMs: 20, service: 'backend', name: i % 2 ? 'db.query' : 'cache.get', dbSystem: i % 2 ? 'mongodb' : 'redis', ...(failing ? { exceptionType: 'TimeoutError', statusCode: 'error' as const } : {}) }),
      );
    }
    await store.insert(docs);
  });
  const ids = async (over: Record<string, unknown>) => (await store.search(scope, q({ limit: 200, ...over }))).items.map((i) => i.traceId);

  test('newest first by default, with a stable keyset cursor that never repeats or skips', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await store.search(scope, q({ limit: 7, cursor, services: ['backend'] }));
      seen.push(...r.items.map((i) => i.traceId));
      if (!r.nextCursor) break;
      cursor = r.nextCursor;
    }
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThanOrEqual(40);
    const all = (await store.search(scope, q({ limit: 200, services: ['backend'] }))).items;
    expect(seen).toEqual(all.map((i) => i.traceId));
    expect(all.map((i) => i.start.getTime())).toEqual([...all.map((i) => i.start.getTime())].sort((a, b) => b - a));
  });
  test('slowest first, paginated by duration', async () => {
    const r1 = await store.search(scope, q({ sort: 'slowest', limit: 5, services: ['backend'] }));
    const r2 = await store.search(scope, q({ sort: 'slowest', limit: 5, cursor: r1.nextCursor!, services: ['backend'] }));
    const d = [...r1.items, ...r2.items].map((i) => i.durationNs);
    expect(d).toEqual([...d].sort((a, b) => b - a));
    expect(new Set([...r1.items, ...r2.items].map((i) => i.traceId)).size).toBe(10);
  });
  test('filters: errors, ok, duration window, http, db, exception, span name, service, trace id', async () => {
    expect((await ids({ errorsOnly: true })).length).toBe(8);
    expect((await ids({ okOnly: true, services: ['backend'] })).length).toBeGreaterThanOrEqual(32);
    const slow = await store.search(scope, q({ minDurationMs: 400, limit: 200, services: ['backend'] }));
    expect(slow.items.every((i) => i.durationNs >= 400e6)).toBe(true);
    const fast = await store.search(scope, q({ maxDurationMs: 150, limit: 200, services: ['backend'] }));
    expect(fast.items.every((i) => i.durationNs <= 150e6)).toBe(true);
    expect((await ids({ httpStatus: 500 })).length).toBe(8);
    expect((await ids({ httpMethod: 'get', httpRoute: 'ORDERS', services: ['backend'] })).length).toBeGreaterThanOrEqual(40);
    expect((await ids({ dbSystem: 'mongodb', services: ['backend'] })).length).toBe(20);
    expect((await ids({ exceptionType: 'timeout' })).length).toBe(8);
    expect((await ids({ spanName: 'DB.QUERY', services: ['backend'] })).length).toBe(20);
    expect(await ids({ traceId: tid(105) })).toEqual([tid(105)]);
    expect(await ids({ services: ['nonexistent'] })).toEqual([]);
  });
  test('time range is honoured on the trace start', async () => {
    const r = await store.search(scope, q({ from: iso(T0 - 10 * 60_000 - 1), to: iso(T0 + 1), services: ['backend'], limit: 200 }));
    const mine = r.items.filter((i) => i.traceId >= tid(100) && i.traceId < tid(140));
    expect(mine.length).toBe(11); // traces 100..110 start at T0 - i minutes
    expect(r.items.every((i) => i.start.getTime() >= T0 - 10 * 60_000 - 1 && i.start.getTime() <= T0 + 1)).toBe(true);
  });
  test('the caller\'s environments bound the results; asking for another environment yields nothing, not an error', async () => {
    const only = await store.search({ ...scope, environmentIds: [ENV2] }, q({ limit: 200, services: ['backend'] }));
    expect(only.items.every((i) => i.environmentId === ENV2)).toBe(true);
    const forced = await store.search({ ...scope, environmentIds: [ENV2] }, q({ environmentIds: [ENV], services: ['backend'] }));
    expect(forced.items).toEqual([]);
    const other = await store.search({ orgId: OTHER_ORG, projectId: PROJECT, environmentIds: [ENV, ENV2] }, q({ services: ['backend'] }));
    expect(other.items).toEqual([]);
  });
  test('user input cannot inject query operators or regular expressions', async () => {
    expect(await ids({ spanName: '.*' })).toEqual([]);
    expect(await ids({ httpRoute: '(' })).toEqual([]);
    const f = buildTraceFilter(q({ spanName: '$where' }), scope);
    expect(JSON.stringify(f)).not.toContain('"$where":');
    expect(decodeCursor('not-a-cursor')).toBeNull();
    expect(decodeCursor(encodeCursor(5, 'x'))).toEqual([5, 'x']);
    expect(TraceQuery.safeParse({ from: iso(T0), to: iso(T0 + 1000), traceId: 'nope' }).success).toBe(false);
    expect(TraceQuery.safeParse({ from: iso(T0), to: iso(T0 + 40 * 86400_000) }).success).toBe(false);
    expect(TraceQuery.safeParse({ from: iso(T0), to: iso(T0 + 1000), errorsOnly: true, okOnly: true }).success).toBe(false);
  });
  test('search uses indexes (no collection scan) for the default and the slowest sort', async () => {
    for (const sort of ['recent', 'slowest'] as const) {
      const query = q({ sort, limit: 50 });
      const plan = await db.c.traceSummaries.find(buildTraceFilter(query, scope) as never).sort(sort === 'slowest' ? { durationNs: -1, _id: -1 } : { start: -1, _id: -1 }).limit(51).explain('queryPlanner');
      expect(JSON.stringify(plan.queryPlanner.winningPlan), sort).not.toContain('COLLSCAN');
    }
  });
  test('knownTraces distinguishes traces that arrived from ones that have not', async () => {
    const known = await store.knownTraces(scope, [tid(100), tid(99999)]);
    expect([...known]).toEqual([tid(100)]);
    expect((await store.knownTraces({ ...scope, orgId: OTHER_ORG }, [tid(100)])).size).toBe(0);
  });
});

describe('derived service views', () => {
  test('server span statistics per service come from server spans only, with errors and a duration sample', async () => {
    const stats = await store.serverSpanStats(scope, new Date(T0 - 6 * 3600_000), new Date(T0 + 3600_000));
    const gw = stats.find((s) => s.service === 'gateway')!;
    const inDb = await db.c.spans.countDocuments({ orgId: ORG, kind: 'server', service: 'gateway', environmentId: { $in: [ENV, ENV2] } });
    expect(gw.spans).toBe(inDb);
    expect(gw.spans).toBeGreaterThanOrEqual(40);
    expect(gw.errors).toBe(8);
    expect(gw.durationsNs.length).toBe(inDb);
    expect(gw.sampled).toBe(false);
    expect(stats.find((s) => s.service === 'backend')).toBeUndefined(); // backend spans are not SERVER kind
  });
  test('dependencies are observed relationships, labelled by how they were observed', async () => {
    await store.insert([
      span({ t: 300, s: 1, kind: 'server', service: 'gateway' }),
      span({ t: 300, s: 2, parentSpanId: sid(1), kind: 'client', service: 'gateway', startMs: T0 + 1 }),
      span({ t: 300, s: 3, parentSpanId: sid(2), kind: 'server', service: 'backend', startMs: T0 + 2 }),
      span({ t: 300, s: 4, parentSpanId: sid(3), kind: 'client', service: 'backend', dbSystem: 'mongodb', startMs: T0 + 3 }),
      span({ t: 300, s: 5, parentSpanId: sid(3), kind: 'client', service: 'backend', peerService: 'payments.example.com', startMs: T0 + 4, statusCode: 'error' }),
    ]);
    const { edges } = await store.dependencies(scope, new Date(T0 - 1000), new Date(T0 + 1000));
    expect(edges).toContainEqual({ from: 'gateway', to: 'backend', kind: 'service', basis: 'parent-child', calls: 1, errors: 0 });
    expect(edges).toContainEqual({ from: 'backend', to: 'mongodb', kind: 'database', basis: 'span-attribute', calls: 1, errors: 0 });
    expect(edges).toContainEqual({ from: 'backend', to: 'payments.example.com', kind: 'external', basis: 'span-attribute', calls: 1, errors: 1 });
    expect(edges.filter((e) => e.from === 'gateway' && e.to === 'backend')).toHaveLength(1); // not additionally reported by attribute
  });
});

describe('storage layout', () => {
  test('the documented indexes exist and spans expire by TTL', async () => {
    const spanIdx = (await db.c.spans.indexes()).map((i) => i.name);
    for (const n of ['spans_scope_trace', 'spans_scope_kind_start_cover', 'spans_scope_service_start', 'spans_ttl']) expect(spanIdx).toContain(n);
    const sumIdx = (await db.c.traceSummaries.indexes()).map((i) => i.name);
    for (const n of ['tsum_scope_trace', 'tsum_scope_start', 'tsum_scope_duration', 'tsum_scope_service_start', 'tsum_ttl']) expect(sumIdx).toContain(n);
  });
  test('a trace lookup by id uses the trace index', async () => {
    const plan = await db.c.spans.find({ orgId: ORG, projectId: PROJECT, environmentId: { $in: [ENV] }, traceId: tid(100) }).sort({ start: 1 }).explain('queryPlanner');
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('spans_scope_trace');
  });
  test('the per-service statistics scan reads index entries, not documents', async () => {
    const plan = await db.c.spans.aggregate([
      { $match: { orgId: ORG, projectId: PROJECT, environmentId: { $in: [ENV] }, start: { $gte: new Date(0), $lte: new Date(T0 * 2) }, kind: 'server' } },
      { $group: { _id: '$service', spans: { $sum: 1 }, errors: { $sum: { $cond: [{ $eq: ['$statusCode', 'error'] }, 1, 0] } }, last: { $max: '$start' } } },
    ]).explain('executionStats') as any;
    expect(JSON.stringify(plan)).toContain('"totalDocsExamined":0');
  });
});
