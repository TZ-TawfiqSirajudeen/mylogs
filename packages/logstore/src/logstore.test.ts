import { buildSearchText, SEARCH_INDEX, type Database, type LogDoc } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildFilter, decodeCursor, encodeCursor, LogQuery, searchTerms, type Scope } from './query.js';
import { MongoLogStore } from './store.js';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let db: Database;
let store: MongoLogStore;

const ORG = 'org-a', OTHER_ORG = 'org-b', PROJECT = 'proj-1', ENV_PROD = 'env-prod', ENV_DEV = 'env-dev';
const scope: Scope = { orgId: ORG, projectId: PROJECT, environmentIds: [ENV_PROD, ENV_DEV] };
const T0 = Date.parse('2026-03-01T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

let n = 0;
function log(over: Partial<LogDoc> = {}): LogDoc {
  const i = n++;
  const ts = new Date(over.ts ?? T0 - i * 1000);
  const doc: LogDoc = {
    _id: `log-${String(i).padStart(6, '0')}`, orgId: ORG, projectId: PROJECT, environmentId: ENV_PROD, tokenId: 't1',
    ts, tsSource: 'event', tsAdjusted: null, receivedAt: new Date(over.receivedAt ?? ts), expireAt: new Date(T0 + 30 * 86400_000),
    severity: 'info', level: 2, severityText: null, message: `message ${i}`, messageTruncated: false,
    service: 'checkout', serviceVersion: null, deployment: null, host: 'web-1', container: null, traceId: null, spanId: null, requestId: null,
    httpMethod: null, httpRoute: null, httpStatus: null, durationMs: null, errorType: null, exceptionMessage: null, stack: null,
    searchText: '', scope: null, source: 'otlp', attrs: [], resource: [], attrsTruncated: false, redactions: 0, ...over,
  };
  return { ...doc, searchText: over.searchText ?? buildSearchText(doc.message, doc.errorType, doc.exceptionMessage) };
}
const q = (over: Record<string, unknown> = {}) => LogQuery.parse({ from: iso(T0 - 6 * 3600_000), to: iso(T0 + 60_000), ...over });

beforeAll(async () => {
  mongo = await startTestMongo();
  db = await freshTestDatabase(mongo.uri);
  store = new MongoLogStore(db);
  const docs: LogDoc[] = [];
  for (let i = 0; i < 1200; i++) docs.push(log({ severity: i % 10 === 0 ? 'error' : 'info', level: i % 10 === 0 ? 4 : 2, service: i % 3 === 0 ? 'payments' : 'checkout' }));
  docs.push(
    log({ _id: 'special-1', message: 'Order failed: price (EUR) [x] * .+ ?', severity: 'error', level: 4, httpStatus: 500, httpMethod: 'POST', httpRoute: '/orders/:id', durationMs: 850, errorType: 'TypeError', exceptionMessage: 'cannot read x', stack: 'TypeError: x\n at y', traceId: 'a'.repeat(32), requestId: 'req-42', attrs: [{ k: 'customer.tier', v: 'gold' }, { k: 'region', v: 'eu-west' }] }),
    log({ _id: 'special-2', message: 'second line of the same request', traceId: 'a'.repeat(32), requestId: 'req-42', ts: new Date(T0 - 10 * 1000 + 500), httpStatus: 200, durationMs: 12, attrs: [{ k: 'customer.tier', v: 'silver' }] }),
    log({ _id: 'dev-1', environmentId: ENV_DEV, message: 'only in dev', service: 'checkout' }),
    log({ _id: 'secret-other-org', orgId: OTHER_ORG, message: 'other tenant secret' }),
    log({ _id: 'secret-other-project', projectId: 'proj-2', message: 'other project secret' }),
    log({ _id: 'secret-other-env', environmentId: 'env-hidden', message: 'hidden environment secret' }),
  );
  await store.insert(docs);
}, 300_000);
afterAll(async () => { await db?.close(); await mongo?.stop(); });

describe('query validation', () => {
  test('time range must be ordered and at most 31 days', () => {
    expect(() => q({ from: iso(T0), to: iso(T0 - 1000) })).toThrow(/before/);
    expect(() => q({ from: iso(T0 - 40 * 86400_000), to: iso(T0) })).toThrow(/31 days/);
    expect(() => LogQuery.parse({ from: 'yesterday', to: 'today' })).toThrow();
  });
  test('only allow-listed fields and operators for their type', () => {
    expect(() => q({ filters: [{ field: 'orgId', op: 'eq', value: 'x' }] })).toThrow(/unknown field/);
    expect(() => q({ filters: [{ field: '$where', op: 'eq', value: 'x' }] })).toThrow();
    expect(() => q({ filters: [{ field: 'attr:a b', op: 'eq', value: 'x' }] })).toThrow();
    expect(() => q({ filters: [{ field: 'service', op: 'gt', value: 'x' }] })).toThrow(/not valid/);
    expect(() => q({ filters: [{ field: 'httpStatus', op: 'contains', value: '5' }] })).toThrow(/not valid/);
    expect(() => q({ filters: [{ field: 'httpStatus', op: 'eq', value: 'abc' }] })).toThrow(/number/);
    expect(() => q({ filters: [{ field: 'service', op: 'eq' }] })).toThrow(/value is required/);
    expect(() => q({ filters: Array.from({ length: 11 }, () => ({ field: 'service', op: 'eq', value: 'x' })) })).toThrow();
    expect(() => q({ limit: 501 })).toThrow();
  });
  test('search terms: phrases, caps', () => {
    expect(searchTerms('error "payment failed" timeout')).toEqual(['error', 'payment failed', 'timeout']);
    expect(searchTerms('a b c d e f g')).toHaveLength(5);
    expect(searchTerms(undefined)).toEqual([]);
  });
  test('cursor encoding round-trips and rejects junk', () => {
    expect(decodeCursor(encodeCursor(123, 'abc'))).toEqual([123, 'abc']);
    for (const bad of ['', 'x', Buffer.from('{"a":1}').toString('base64url'), Buffer.from('[1,{"$ne":1}]').toString('base64url')]) expect(decodeCursor(bad)).toBeNull();
  });
});

describe('tenant isolation', () => {
  test('a search never returns another org, project or an environment outside the caller\'s scope', async () => {
    const r = await store.search(scope, q({ limit: 500, text: 'secret' }));
    expect(r.items).toEqual([]);
    const all = await store.search(scope, q({ limit: 500 }));
    expect(all.items.some((i) => i._id.startsWith('secret-'))).toBe(false);
  });
  test('environment restriction: a caller scoped to prod cannot see dev, and asking for dev explicitly returns nothing', async () => {
    const prodOnly: Scope = { ...scope, environmentIds: [ENV_PROD] };
    expect((await store.search(prodOnly, q({ text: 'only in dev' }))).items).toEqual([]);
    expect((await store.search(prodOnly, q({ text: 'only in dev', environmentIds: [crypto.randomUUID()] }))).items).toEqual([]);
    expect((await store.search(scope, q({ text: 'only in dev' }))).items).toHaveLength(1);
  });
  test('direct lookups, related and neighbors are scoped too', async () => {
    expect(await store.get({ ...scope, orgId: OTHER_ORG }, 'special-1')).toBeNull();
    expect(await store.get({ ...scope, environmentIds: [ENV_DEV] }, 'special-1')).toBeNull();
    expect(await store.get(scope, 'secret-other-org')).toBeNull();
    expect((await store.get(scope, 'special-1'))?._id).toBe('special-1');
  });
  test('the generated filter always carries the tenant scope first, whatever the user supplies', () => {
    const f = buildFilter(q({ filters: [{ field: 'service', op: 'eq', value: 'x' }], text: 'a' }), scope) as Record<string, unknown>;
    expect(f.orgId).toBe(ORG);
    expect(f.projectId).toBe(PROJECT);
    expect(f.environmentId).toEqual({ $in: [ENV_PROD, ENV_DEV] });
  });
});

describe('injection resistance', () => {
  test('operator objects and regex metacharacters in values are inert literals', async () => {
    // would match everything if interpreted as a Mongo operator or a regex
    for (const value of ['{"$ne":null}', '.*', '^', '$ne', '(?i).*', '\\']) {
      const r = await store.search(scope, q({ filters: [{ field: 'service', op: 'eq', value }] }));
      expect(r.items, value).toEqual([]);
      const c = await store.search(scope, q({ filters: [{ field: 'service', op: 'contains', value }] }));
      expect(c.items.length, value).toBe(0);
    }
    expect((await store.search(scope, q({ text: '.*' }))).items).toEqual([]);
    expect((await store.search(scope, q({ text: '(EUR) [x] * .+ ?' }))).items).toHaveLength(1); // the literal text really is findable
  });
  test('attribute filters only match the named key and value', async () => {
    expect((await store.search(scope, q({ filters: [{ field: 'attr:customer.tier', op: 'eq', value: 'gold' }] }))).items.map((i) => i._id)).toEqual(['special-1']);
    expect((await store.search(scope, q({ filters: [{ field: 'attr:region', op: 'eq', value: 'gold' }] }))).items).toEqual([]);
    expect((await store.search(scope, q({ filters: [{ field: 'attr:customer.tier', op: 'ne', value: 'gold' }, { field: 'attr:customer.tier', op: 'exists' }] }))).items.map((i) => i._id)).toEqual(['special-2']);
  });
});

describe('filters', () => {
  test('severity, errors only, services, text, numeric and string operators', async () => {
    const errors = await store.search(scope, q({ errorsOnly: true, limit: 500 }));
    expect(errors.items.every((i) => i.severity === 'error')).toBe(true);
    expect(errors.items.length).toBe(121);
    expect((await store.search(scope, q({ minSeverity: 'warn', limit: 500 }))).items.length).toBe(121);
    const pay = await store.search(scope, q({ services: ['payments'], limit: 500 }));
    expect(pay.items.every((i) => i.service === 'payments')).toBe(true);
    expect((await store.search(scope, q({ text: 'ORDER FAILED' }))).items).toHaveLength(1); // case-insensitive, all terms
    expect((await store.search(scope, q({ text: 'order nonexistentword' }))).items).toHaveLength(0);
    expect((await store.search(scope, q({ text: 'cannot read' }))).items.map((i) => i._id)).toEqual(['special-1']); // exception text searched too
    expect((await store.search(scope, q({ filters: [{ field: 'httpStatus', op: 'gte', value: 500 }] }))).items.map((i) => i._id)).toEqual(['special-1']);
    expect((await store.search(scope, q({ filters: [{ field: 'durationMs', op: 'lt', value: 100 }] }))).items.map((i) => i._id)).toEqual(['special-2']);
    expect((await store.search(scope, q({ filters: [{ field: 'httpRoute', op: 'contains', value: 'ORDERS' }] }))).items).toHaveLength(1);
    expect((await store.search(scope, q({ filters: [{ field: 'requestId', op: 'eq', value: 'req-42' }, { field: 'httpStatus', op: 'exists' }] }))).items).toHaveLength(2);
  });
  test('time bounds are honoured', async () => {
    const r = await store.search(scope, q({ from: iso(T0 - 5000), to: iso(T0), limit: 500 }));
    expect(r.items.length).toBeGreaterThan(0);
    expect(r.items.every((i) => i.ts.getTime() >= T0 - 5000 && i.ts.getTime() <= T0)).toBe(true);
  });
});

describe('pagination', () => {
  test('keyset pages cover every record exactly once, in order, in both directions', async () => {
    for (const sort of ['desc', 'asc'] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      let pages = 0;
      do {
        const r = await store.search(scope, q({ limit: 97, sort, cursor }));
        seen.push(...r.items.map((i) => i._id));
        cursor = r.nextCursor ?? undefined;
        pages++;
      } while (cursor && pages < 100);
      expect(new Set(seen).size).toBe(seen.length); // no duplicates
      const total = await db.c.logs.countDocuments({ orgId: ORG, projectId: PROJECT, environmentId: { $in: [ENV_PROD, ENV_DEV] }, ts: { $gte: new Date(T0 - 6 * 3600_000), $lte: new Date(T0 + 60_000) } });
      expect(seen.length).toBe(total);
    }
  });
  test('records sharing the same timestamp are not skipped or repeated across page boundaries', async () => {
    const sameTs = new Date(T0 - 3 * 3600_000);
    await store.insert(Array.from({ length: 25 }, (_, i) => log({ _id: `tie-${String(i).padStart(2, '0')}`, ts: sameTs, message: 'tie' })));
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await store.search(scope, q({ text: 'tie', limit: 7, cursor }));
      seen.push(...r.items.map((i) => i._id));
      cursor = r.nextCursor ?? undefined;
    } while (cursor);
    expect(seen.sort()).toEqual(Array.from({ length: 25 }, (_, i) => `tie-${String(i).padStart(2, '0')}`));
  });
  test('a forged cursor cannot widen the scope', async () => {
    const forged = Buffer.from(JSON.stringify([T0, 'zzzz'])).toString('base64url');
    const r = await store.search(scope, q({ cursor: forged, limit: 500 }));
    expect(r.items.some((i) => i._id.startsWith('secret-'))).toBe(false);
  });
});

describe('detail, related and neighbors', () => {
  test('related events share a trace or request; ordered oldest first', async () => {
    const doc = (await store.get(scope, 'special-1'))!;
    const rel = await store.related(scope, doc);
    expect(rel.by).toBe('traceId');
    expect(rel.items.map((i) => i._id).sort()).toEqual(['special-1', 'special-2']);
    expect(rel.items[0]!.ts.getTime()).toBeLessThanOrEqual(rel.items[1]!.ts.getTime());
    expect((await store.related(scope, (await store.get(scope, 'dev-1'))!)).items).toEqual([]); // nothing to correlate on: say so, do not guess
  });
  test('neighbors come from the same service and host, before and after', async () => {
    const doc = (await store.get(scope, 'special-2'))!;
    const nb = await store.neighbors(scope, doc, 3);
    expect(nb.before.length + nb.after.length).toBeGreaterThan(0);
    for (const x of [...nb.before, ...nb.after]) { expect(x.service).toBe(doc.service); expect(x._id).not.toBe(doc._id); }
  });
});

describe('aggregates', () => {
  test('histogram buckets cover the range and split errors', async () => {
    const h = await store.histogram(scope, q({ from: iso(T0 - 1200_000), to: iso(T0 + 1000) }), 20);
    expect(h.bucketMs).toBeGreaterThanOrEqual(1000);
    expect(h.buckets.length).toBeGreaterThan(5);
    const total = h.buckets.reduce((s, b) => s + b.total, 0);
    const errors = h.buckets.reduce((s, b) => s + b.errors, 0);
    expect(total).toBeGreaterThan(1000);
    expect(errors).toBeGreaterThan(100);
    expect(h.buckets.every((b, i, a) => i === 0 || a[i - 1]!.t < b.t)).toBe(true);
  });
  test('facets list services and severities with counts', async () => {
    const f = await store.facets(scope, q());
    expect(f.services.map((s) => s.value)).toEqual(expect.arrayContaining(['checkout', 'payments']));
    expect(f.severities.find((s) => s.value === 'error')!.count).toBeGreaterThan(100);
  });
});

describe('ingestion-side behaviour', () => {
  test('re-inserting the same ids is idempotent (retransmitted batches are deduplicated, not duplicated or failed)', async () => {
    const batch = Array.from({ length: 5 }, (_, i) => log({ _id: `idem-${i}`, message: 'idem' }));
    expect(await store.insert(batch)).toEqual({ inserted: 5, duplicates: 0 });
    const again = await store.insert([...batch, log({ _id: 'idem-new', message: 'idem' })]);
    expect(again).toEqual({ inserted: 1, duplicates: 5 });
    expect(await db.c.logs.countDocuments({ message: 'idem' })).toBe(6);
  });
  test('tail follows ARRIVAL order, so a late-arriving old event is still delivered', async () => {
    const base = Date.now();
    const first = await store.tail(scope, q({ from: iso(base - 60_000), to: iso(base + 60_000), limit: 100 }));
    const cursor = first.nextCursor ?? encodeCursor(base - 1, '');
    await store.insert([log({ _id: 'late-new', message: 'fresh', ts: new Date(base), receivedAt: new Date(base + 100) })]);
    await store.insert([log({ _id: 'late-old', message: 'delayed by the network', ts: new Date(base - 3600_000), receivedAt: new Date(base + 200) })]);
    const next = await store.tail(scope, q({ from: iso(base - 60_000), to: iso(base + 60_000), cursor, limit: 100 }));
    expect(next.items.map((i) => i._id)).toEqual(['late-new', 'late-old']); // the old-timestamped event arrived later and is not missed
    const none = await store.tail(scope, q({ from: iso(base - 60_000), to: iso(base + 60_000), cursor: next.nextCursor!, limit: 100 }));
    expect(none.items).toEqual([]);
  });
  test('export is capped at the requested number of rows and scoped', async () => {
    const rows: string[] = [];
    for await (const d of store.exportRows(scope, q(), 50)) rows.push(d._id);
    expect(rows).toHaveLength(50);
    expect(rows.some((r) => r.startsWith('secret-'))).toBe(false);
  });
  test('retention: every record carries its own expiry and a TTL index removes it', async () => {
    const idx = await db.c.logs.indexes();
    expect(idx.find((i) => i.name === 'logs_ttl')?.expireAfterSeconds).toBe(0);
    const names = idx.map((i) => i.name);
    for (const need of ['logs_scope_ts_search', 'logs_scope_ts_svc_lvl', 'logs_scope_trace', 'logs_scope_request', 'logs_scope_received']) expect(names).toContain(need);
  });
  test('searches use the tenant/time index rather than scanning the collection', async () => {
    const plan = await db.c.logs.find(buildFilter(q({ limit: 100 }), scope) as never).sort({ ts: -1, _id: -1 }).limit(100).explain('queryPlanner');
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain('logs_scope_ts_search');
    expect(JSON.stringify(plan.queryPlanner.winningPlan)).not.toContain('COLLSCAN');
  });

  describe('performance paths stay correct', () => {
    const asAgg = (qq: ReturnType<typeof q>) => (store as unknown as { histogramByAggregation(s: Scope, q: unknown, b: number): Promise<{ buckets: unknown[] }> });
    test.each([
      ['no filters', {}],
      ['errors only', { errorsOnly: true }],
      ['min severity warn', { minSeverity: 'warn' }],
      ['min severity fatal', { minSeverity: 'fatal' }],
      ['service filter', { services: ['payments'] }],
      ['service + errors', { services: ['payments'], errorsOnly: true }],
      ['narrow range with unaligned edges', { from: iso(T0 - 7 * 60_000 - 123), to: iso(T0 - 2 * 60_000 + 77) }],
    ])('histogram by index counts equals the aggregation (%s)', async (_name, over) => {
      const query = q(over);
      const fast = await store.histogram(scope, query);
      const bucketMs = fast.bucketMs;
      const slow = await asAgg(query).histogramByAggregation.call(store, scope, query, bucketMs);
      expect(fast.buckets).toEqual(slow.buckets);
      const total = fast.buckets.reduce((n, b) => n + b.total, 0);
      expect(total).toBe((await store.search(scope, { ...query, limit: 1 })).items.length ? await db.c.logs.countDocuments(buildFilter(query, scope) as never) : 0);
    });

    test('histogram by index counts respects a caller restricted to one environment', async () => {
      const dev: Scope = { ...scope, environmentIds: [ENV_DEV] };
      const fast = await store.histogram(dev, q());
      const slow = await asAgg(q()).histogramByAggregation.call(store, dev, q(), fast.bucketMs);
      expect(fast.buckets).toEqual(slow.buckets);
      expect(fast.buckets.reduce((n, b) => n + b.total, 0)).toBe(1); // only the dev record, never prod volume
    });

    test('histogram falls back to the aggregation when a filter needs document fields, and stays correct', async () => {
      const h = await store.histogram(scope, q({ text: 'order failed' }));
      expect(h.buckets.reduce((n, b) => n + b.total, 0)).toBe(1);
      const g = await store.histogram(scope, q({ filters: [{ field: 'attr:customer.tier', op: 'eq', value: 'gold' }] }));
      expect(g.buckets.reduce((n, b) => n + b.total, 0)).toBe(1);
    });

    test('facets (single covered pass) agree with direct counts', async () => {
      const f = await store.facets(scope, q());
      const byService = Object.fromEntries(f.services.map((x) => [x.value, x.count]));
      for (const svc of Object.keys(byService)) expect(byService[svc]).toBe(await db.c.logs.countDocuments(buildFilter(q({ services: [svc] }), scope) as never));
      const bySev = Object.fromEntries(f.severities.map((x) => [x.value, x.count]));
      expect(bySev.error).toBe(await db.c.logs.countDocuments({ ...(buildFilter(q(), scope) as object), severity: 'error' } as never));
      expect(f.services.map((x) => x.count)).toEqual([...f.services.map((x) => x.count)].sort((a, b) => b - a)); // most frequent first
    });

    test('the covered histogram/facets scan reads no documents', async () => {
      const plan = await db.c.logs.aggregate([{ $match: buildFilter(q(), scope) }, { $group: { _id: { s: '$service', l: '$level' }, count: { $sum: 1 } } }], { hint: 'logs_scope_ts_svc_lvl' }).explain('executionStats') as any;
      const text = JSON.stringify(plan);
      expect(text).not.toContain('"FETCH"');
      expect(text).toContain('"totalDocsExamined":0');
    });

    test('free-text search: case-insensitive, Unicode-aware, phrases, literal metacharacters, never across field boundaries', async () => {
      await store.insert([
        log({ _id: 'txt-1', message: 'Zahlung ÜBERFÄLLIG für Straße 5', errorType: 'PaymentError' }),
        log({ _id: 'txt-2', message: 'ends with foo', errorType: 'bar' }),
        log({ _id: 'txt-3', message: 'sync stalled', exceptionMessage: 'Timeout talking to Redis (10s)' }),
      ]);
      const ids = async (text: string) => (await store.search(scope, q({ text, limit: 100 }))).items.map((i) => i._id).sort();
      expect(await ids('überfällig')).toEqual(['txt-1']);       // Unicode lower-casing is symmetric between index and query
      expect(await ids('ZAHLUNG straße')).toEqual(['txt-1']);   // all terms, any case
      expect(await ids('paymenterror')).toEqual(['txt-1']);     // error type is searchable
      expect(await ids('"redis (10s)"')).toEqual(['txt-3']);    // phrase + regex metacharacters are literal
      expect(await ids('".*"')).toEqual([]);
      expect(await ids('"foo bar"')).toEqual([]);               // message + error type must not combine into a phrase
      expect(await ids('foo bar')).toEqual(['txt-2']);          // …but as separate terms they match
    });

    test('free-text search is answered from the index: a miss fetches no documents', async () => {
      const plan = await db.c.logs.find(buildFilter(q({ text: 'zzz-no-such-text', limit: 100 }), scope) as never, { hint: SEARCH_INDEX }).sort({ ts: -1, _id: -1 }).limit(101).explain('executionStats') as any;
      expect(plan.executionStats.totalDocsExamined).toBe(0);
      expect(plan.executionStats.nReturned).toBe(0);
    });

    test('a missing hinted index degrades to the planner instead of failing the request', async () => {
      await db.c.logs.dropIndex('logs_scope_ts_svc_lvl');
      try {
        const f = await store.facets(scope, q());
        expect(f.services.length).toBeGreaterThan(0);
        expect((await store.histogram(scope, q())).buckets.length).toBeGreaterThan(0);
      } finally {
        await db.c.logs.createIndex({ orgId: 1, projectId: 1, environmentId: 1, ts: -1, service: 1, level: 1 }, { name: 'logs_scope_ts_svc_lvl' });
      }
    });
  });
});
