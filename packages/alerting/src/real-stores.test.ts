import type { LogDoc } from '@nexus/database';
import { buildSearchText } from '@nexus/database';
import { startTestMongo } from '@nexus/database/testing';
import { MongoLogStore } from '@nexus/logstore';
import { MongoMetricStore, type MetricContext } from '@nexus/metricstore';
import type { MetricPointDraft } from '@nexus/telemetry';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { evaluateQuery } from './evaluator.js';
import { metricRule, makeWorld, type World } from './testkit.js';

/**
 * The evaluator against the REAL MetricStore and LogStore (MongoDB), not scripted fakes: proves the window maths, the aggregations, the
 * grouping and the tenant scoping hold with the stores' actual behaviour.
 */
let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let w: World;
let metrics: MongoMetricStore, logs: MongoLogStore;
beforeAll(async () => {
  mongo = await startTestMongo();
  w = await makeWorld(mongo.uri);
  metrics = new MongoMetricStore(w.db);
  logs = new MongoLogStore(w.db);
}, 240_000);
afterAll(async () => { await mongo?.stop(); });

const NOW = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 30_000); // 30 s into a minute
const minutesAgo = (m: number, sec = 5) => new Date(NOW.getTime() - m * 60_000 - 30_000 + sec * 1000);
const ctx = (o: Partial<MetricContext> = {}): MetricContext => ({ orgId: w.orgA, projectId: w.projA, environmentId: w.envA, retentionMs: 30 * 86_400_000, ...o });
const pt = (over: Partial<MetricPointDraft>): MetricPointDraft => ({
  name: 'm', unit: null, description: null, type: 'gauge', temporality: null, monotonic: null, service: 'checkout', serviceVersion: null, instance: 'i-1', attrs: [],
  time: minutesAgo(1), startTime: null, value: 0, count: 1, sum: 0, min: null, max: null, bounds: null, buckets: null, exemplars: [], ...over,
});
const gauge = (name: string, minAgo: number, v: number, over: Partial<MetricPointDraft> = {}) => pt({ name, type: 'gauge', time: minutesAgo(minAgo), value: v, sum: v, ...over });
const delta = (name: string, minAgo: number, v: number, over: Partial<MetricPointDraft> = {}) => pt({ name, type: 'sum', temporality: 'delta', monotonic: true, time: minutesAgo(minAgo), value: v, sum: v, ...over });
const rule = (query: Record<string, unknown>, env = w.envA, windowSeconds = 300) => ({ orgId: w.orgA, projectId: w.projA, environmentId: env, windowSeconds, query: query as never });
const m = (metric: string, agg: string, extra: Record<string, unknown> = {}) => ({ kind: 'metric', metric, filters: [], groupBy: [], agg, ...extra });
const deps = () => ({ metrics, logs });

describe('metric rules against the real metric store', () => {
  test('aggregations over a sliding window; samples outside the window do not count', async () => {
    await metrics.ingest(ctx(), [gauge('cpu', 1, 10), gauge('cpu', 2, 30), gauge('cpu', 3, 20), gauge('cpu', 30, 999)], NOW); // 999 is far outside a 5 minute window
    const get = async (agg: string) => (await evaluateQuery(rule(m('cpu', agg)), deps(), NOW)).groups[0]!.obs;
    expect(await get('max')).toEqual({ kind: 'value', value: 30 });
    expect(await get('min')).toEqual({ kind: 'value', value: 10 });
    expect(await get('avg')).toEqual({ kind: 'value', value: 20 });
    expect(await get('last')).toEqual({ kind: 'value', value: 10 }); // newest sample: 1 minute ago
    expect(await get('count')).toEqual({ kind: 'value', value: 3 });
    expect(await get('sum')).toEqual({ kind: 'value', value: 60 });
  });

  test('counter increases: sum and rate over the window', async () => {
    await metrics.ingest(ctx(), [delta('reqs', 1, 60), delta('reqs', 2, 120), delta('reqs', 3, 120)], NOW);
    expect(await evaluateQuery(rule(m('reqs', 'sum')), deps(), NOW).then((r) => r.groups[0]!.obs)).toEqual({ kind: 'value', value: 300 });
    const rate = (await evaluateQuery(rule(m('reqs', 'rate')), deps(), NOW)).groups[0]!.obs;
    expect(rate).toEqual({ kind: 'value', value: 1 }); // 300 requests over a 300 s window
  });

  test('an unknown metric is no data; an unsupported aggregation for the metric type is an error the engine records', async () => {
    expect((await evaluateQuery(rule(m('does.not.exist', 'max')), deps(), NOW)).groups[0]!.obs).toEqual({ kind: 'no_data' });
    await expect(evaluateQuery(rule(m('reqs', 'avg')), deps(), NOW)).rejects.toThrow(/not available/); // avg is not defined for a counter
  });

  test('grouping by a label gives one observation per value; label filters narrow the series', async () => {
    await metrics.ingest(ctx(), [
      gauge('queue', 1, 5, { attrs: [{ k: 'queue', v: 'emails' }], instance: 'i-1' }), gauge('queue', 1, 500, { attrs: [{ k: 'queue', v: 'billing' }], instance: 'i-1' }),
    ], NOW);
    const r = await evaluateQuery(rule(m('queue', 'max', { groupBy: ['queue'] })), deps(), NOW);
    expect(Object.fromEntries(r.groups.map((g) => [g.key, g.obs]))).toEqual({ 'queue=emails': { kind: 'value', value: 5 }, 'queue=billing': { kind: 'value', value: 500 } });
    const filtered = await evaluateQuery(rule(m('queue', 'max', { filters: [{ key: 'queue', value: 'emails' }] })), deps(), NOW);
    expect(filtered.groups[0]!.obs).toEqual({ kind: 'value', value: 5 });
  });

  test('other tenants\' and other environments\' data with the same metric name never leaks into a rule\'s value', async () => {
    await metrics.ingest(ctx({ orgId: w.orgB, projectId: w.projB, environmentId: w.envB }), [gauge('leak', 1, 1_000_000)], NOW);
    await metrics.ingest(ctx({ environmentId: w.envA2 }), [gauge('leak', 1, 2_000_000)], NOW); // same project, OTHER environment
    await metrics.ingest(ctx(), [gauge('leak', 1, 7)], NOW);
    expect((await evaluateQuery(rule(m('leak', 'max')), deps(), NOW)).groups[0]!.obs).toEqual({ kind: 'value', value: 7 });
    expect((await evaluateQuery(rule(m('leak', 'max'), w.envA2), deps(), NOW)).groups[0]!.obs).toEqual({ kind: 'value', value: 2_000_000 });
    const asB = { ...rule(m('leak', 'max'), w.envB), orgId: w.orgB, projectId: w.projB };
    expect((await evaluateQuery(asB, deps(), NOW)).groups[0]!.obs).toEqual({ kind: 'value', value: 1_000_000 });
    // a rule whose stored org/project do not own the environment finds nothing (it cannot reach into another tenant's environment)
    const crossed = { ...rule(m('leak', 'max'), w.envB), orgId: w.orgA, projectId: w.projA };
    expect((await evaluateQuery(crossed, deps(), NOW)).groups[0]!.obs).toEqual({ kind: 'no_data' });
  });
});

describe('log rules against the real log store', () => {
  let n = 0;
  const log = (over: Partial<LogDoc>): LogDoc => {
    const message = over.message ?? `m${n}`;
    return {
      _id: `alert-log-${n++}`, orgId: w.orgA, projectId: w.projA, environmentId: w.envA, tokenId: 't', ts: minutesAgo(1), tsSource: 'event', tsAdjusted: null, receivedAt: NOW, expireAt: new Date(NOW.getTime() + 86_400_000),
      severity: 'info', level: 2, severityText: null, message, messageTruncated: false, searchText: buildSearchText(message, null, null),
      service: 'checkout', serviceVersion: null, deployment: null, host: 'h', container: null, traceId: null, spanId: null, requestId: null, httpMethod: null, httpRoute: null, httpStatus: null,
      durationMs: null, errorType: null, exceptionMessage: null, stack: null, scope: null, source: 'otlp', attrs: [], resource: [], attrsTruncated: false, redactions: 0, ...over,
    };
  };
  beforeAll(async () => {
    await logs.insert([
      ...Array.from({ length: 7 }, () => log({ severity: 'error', level: 4, httpStatus: 503, message: 'upstream timeout' })),
      ...Array.from({ length: 3 }, () => log({ severity: 'error', level: 4, httpStatus: 500, service: 'search', message: 'boom' })),
      ...Array.from({ length: 20 }, () => log({ message: 'ordinary' })),
      log({ severity: 'error', level: 4, ts: minutesAgo(60), message: 'old error outside the window' }),
      log({ severity: 'error', level: 4, environmentId: w.envA2, message: 'prod error' }),
      log({ severity: 'error', level: 4, orgId: w.orgB, projectId: w.projB, environmentId: w.envB, message: 'other tenant error' }),
    ]);
  });
  const count = async (query: Record<string, unknown>, env = w.envA) => (await evaluateQuery(rule({ kind: 'logs', filters: [], ...query }, env), deps(), NOW)).groups[0]!.obs;
  test('counts records matching the explorer filters inside the window, in the rule\'s environment only', async () => {
    expect(await count({ errorsOnly: true })).toEqual({ kind: 'value', value: 10 });
    expect(await count({ errorsOnly: true, services: ['search'] })).toEqual({ kind: 'value', value: 3 });
    expect(await count({ filters: [{ field: 'httpStatus', op: 'gte', value: 503 }] })).toEqual({ kind: 'value', value: 7 });
    expect(await count({ text: 'upstream timeout' })).toEqual({ kind: 'value', value: 7 });
    expect(await count({})).toEqual({ kind: 'value', value: 30 });
    expect(await count({ errorsOnly: true }, w.envA2)).toEqual({ kind: 'value', value: 1 });
    expect(await count({ text: 'nothing matches this' })).toEqual({ kind: 'value', value: 0 }); // zero is a value
  });
  test('a rule whose environment belongs to another tenant counts nothing', async () => {
    const crossed = { ...rule({ kind: 'logs', filters: [], errorsOnly: true }, w.envB), orgId: w.orgA, projectId: w.projA };
    expect((await evaluateQuery(crossed, deps(), NOW)).groups[0]!.obs).toEqual({ kind: 'value', value: 0 });
  });
});

describe('end to end with the real stores', () => {
  test('metric data makes a rule fire and the incident carries the real value; clearing resolves it', async () => {
    const world = await makeWorld(mongo.uri);
    const mstore = new MongoMetricStore(world.db), lstore = new MongoLogStore(world.db);
    const c = { orgId: world.orgA, projectId: world.projA, environmentId: world.envA, retentionMs: 30 * 86_400_000 };
    const now = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 30_000);
    world.clock.t = now.getTime();
    await mstore.ingest(c, [gauge('errors.rate', 1, 42)].map((p) => ({ ...p, time: new Date(now.getTime() - 60_000) })), now);
    const r = await world.svc.rules.create(world.scopeA, metricRule(world, { forSeconds: 0, resolveAfterSeconds: 0, windowSeconds: 120, query: { kind: 'metric', metric: 'errors.rate', filters: [], groupBy: [], agg: 'max' }, condition: { op: 'gt', threshold: 10 } }), { requestId: 'r' });
    await world.engine({ metrics: mstore, logs: lstore }).tick();
    const inc = await world.db.c.incidents.findOne({ ruleId: r._id });
    expect(inc).toMatchObject({ status: 'open', lastValue: 42 });
    // three minutes later the old sample has left the 2 minute window and a low value arrives
    world.clock.advance(180);
    await mstore.ingest(c, [{ ...gauge('errors.rate', 0, 1), time: new Date(world.clock.t - 30_000) }], new Date(world.clock.t));
    await world.engine({ metrics: mstore, logs: lstore }).tick();
    expect((await world.db.c.incidents.findOne({ ruleId: r._id }))).toMatchObject({ status: 'resolved', resolvedBy: { kind: 'auto' } });
  });
});
