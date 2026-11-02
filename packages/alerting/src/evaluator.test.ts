import { ALERT_LIMITS, AlertRuleCreate, AlertRuleUpdate, ChannelCreate, SilenceCreate } from '@nexus/contracts';
import { describe, expect, test } from 'vitest';
import { evaluateQuery, groupKeyOf, type EvalDeps } from './evaluator.js';

const NOW = new Date('2026-03-01T12:00:00Z');
type Pts = (number | null)[];
/** A metric store that answers per aggregation with per-minute points (stepMs = 60 s). */
function metrics(byAgg: Record<string, { labels?: Record<string, string>; points: Pts }[]>, calls: { agg?: string; from: string; to: string }[] = []): EvalDeps {
  return {
    metrics: { async query(_s, q) { calls.push({ agg: q.agg, from: q.from, to: q.to }); return { stepMs: 60_000, truncated: false, series: (byAgg[q.agg!] ?? []).map((s) => ({ labels: s.labels ?? {}, points: s.points.map((v, i) => ({ t: i * 60_000, v })), exemplars: [] })) } as never; } },
    logs: { async histogram() { return { bucketMs: 1, buckets: [] }; } },
  };
}
const rule = (query: Record<string, unknown>, windowSeconds = 300) => ({ orgId: 'o', projectId: 'p', environmentId: 'e', windowSeconds, query: query as never });
const m = (agg: string, extra: Record<string, unknown> = {}) => ({ kind: 'metric', metric: 'x', filters: [], groupBy: [], agg, ...extra });
const value = async (deps: EvalDeps, q: Record<string, unknown>, window = 300) => {
  const r = await evaluateQuery(rule(q, window), deps, NOW);
  return r.groups[0]!.obs;
};

describe('window aggregation from per-step results', () => {
  test('sum and count add the steps; min, max and last read them; missing steps are ignored (never zero)', async () => {
    expect(await value(metrics({ sum: [{ points: [1, null, 2, 3] }] }), m('sum'))).toEqual({ kind: 'value', value: 6 });
    expect(await value(metrics({ count: [{ points: [10, 20, null] }] }), m('count'))).toEqual({ kind: 'value', value: 30 });
    expect(await value(metrics({ min: [{ points: [5, 2, null, 9] }] }), m('min'))).toEqual({ kind: 'value', value: 2 });
    expect(await value(metrics({ max: [{ points: [5, 2, null, 9, null] }] }), m('max'))).toEqual({ kind: 'value', value: 9 });
    expect(await value(metrics({ last: [{ points: [5, 2, 7, null] }] }), m('last'))).toEqual({ kind: 'value', value: 7 });
  });
  test('avg is total sum / total count (an average of averages would be wrong)', async () => {
    // minute 1: 1 sample averaging 100; minute 2: 99 samples averaging 0 -> the true mean is 1, not 50
    const deps = metrics({ sum: [{ points: [100, 0] }], count: [{ points: [1, 99] }] });
    expect(await value(deps, m('avg'))).toEqual({ kind: 'value', value: 1 });
    expect(await value(metrics({ sum: [{ points: [null] }], count: [{ points: [null] }] }), m('avg'))).toEqual({ kind: 'no_data' });
  });
  test('rate is the increase over the whole window per second', async () => {
    // per-minute rates 1/s and 3/s over a 5 minute window: (1*60 + 3*60) / 300
    expect(await value(metrics({ rate: [{ points: [1, 3] }] }), m('rate'))).toEqual({ kind: 'value', value: 0.8 });
  });
  test('no series, or only empty steps, is "no data"', async () => {
    expect(await value(metrics({}), m('max'))).toEqual({ kind: 'no_data' });
    expect(await value(metrics({ max: [{ points: [null, null] }] }), m('max'))).toEqual({ kind: 'no_data' });
  });
  test('the query covers exactly the window ending now, one environment, and asks for one-minute steps', async () => {
    const calls: { agg?: string; from: string; to: string }[] = [];
    await value(metrics({ max: [{ points: [1] }] }, calls), m('max'), 900);
    expect(calls).toEqual([{ agg: 'max', from: new Date(NOW.getTime() - 900_000).toISOString(), to: NOW.toISOString() }]);
  });
  test('store failures propagate (the engine turns them into an evaluation error, never into "ok")', async () => {
    const deps: EvalDeps = { ...metrics({}), metrics: { query: async () => { throw new Error('unsupported_aggregation'); } } };
    await expect(evaluateQuery(rule(m('max')), deps, NOW)).rejects.toThrow('unsupported_aggregation');
  });
});

describe('groups', () => {
  test('one observation per group, keyed by the sorted label values, bounded', async () => {
    const r = await evaluateQuery(rule(m('max', { groupBy: ['service'] })), metrics({ max: [{ labels: { service: 'b' }, points: [2] }, { labels: { service: 'a' }, points: [null] }] }), NOW);
    expect(r.groups).toEqual([
      { key: 'service=b', labels: { service: 'b' }, obs: { kind: 'value', value: 2 } },
      { key: 'service=a', labels: { service: 'a' }, obs: { kind: 'no_data' } },
    ]);
    const many = Array.from({ length: 30 }, (_, i) => ({ labels: { service: `s${i}` }, points: [1] }));
    const big = await evaluateQuery(rule(m('max', { groupBy: ['service'] })), metrics({ max: many }), NOW);
    expect(big.groups).toHaveLength(ALERT_LIMITS.maxGroupsPerRule);
    expect(big.truncated).toBe(true);
    expect(groupKeyOf({ b: '2', a: '1' })).toBe('a=1,b=2');
    expect(groupKeyOf({})).toBe('');
  });
});

describe('contracts (input validation and limits)', () => {
  const ok = { name: 'High error rate', severity: 'critical', environmentId: crypto.randomUUID(), query: { kind: 'metric', metric: 'http.server.errors', agg: 'rate' }, condition: { op: 'gt', threshold: 5 }, windowSeconds: 300 };
  const bad = (over: Record<string, unknown>) => AlertRuleCreate.safeParse({ ...ok, ...over });
  test('a minimal rule is accepted and gets safe defaults', () => {
    const r = AlertRuleCreate.parse(ok);
    expect(r).toMatchObject({ enabled: true, forSeconds: 0, resolveAfterSeconds: 120, noDataPolicy: 'keep', intervalSeconds: 60, channelIds: [], description: '' });
    expect(r.query).toMatchObject({ filters: [], groupBy: [] });
  });
  test.each([
    ['empty name', { name: '  ' }], ['name too long', { name: 'x'.repeat(101) }], ['bad severity', { severity: 'urgent' }],
    ['percentile aggregation is not supported', { query: { kind: 'metric', metric: 'm', agg: 'p95' } }],
    ['bad metric name', { query: { kind: 'metric', metric: 'a b;drop', agg: 'max' } }],
    ['too many filters', { query: { kind: 'metric', metric: 'm', agg: 'max', filters: Array.from({ length: 6 }, (_, i) => ({ key: `k${i}`, value: 'v' })) } }],
    ['two group-bys', { query: { kind: 'metric', metric: 'm', agg: 'max', groupBy: ['a', 'b'] } }],
    ['unknown query field', { query: { kind: 'metric', metric: 'm', agg: 'max', $where: '1' } }],
    ['unknown top-level field', { projectId: crypto.randomUUID() }],
    ['window too short', { windowSeconds: 30 }], ['window too long', { windowSeconds: 90_000 }], ['for too long', { forSeconds: 90_000 }],
    ['interval too short', { intervalSeconds: 5 }], ['interval too long', { intervalSeconds: 4000 }],
    ['interval much longer than the window', { windowSeconds: 60, intervalSeconds: 300 }],
    ['threshold not finite', { condition: { op: 'gt', threshold: Infinity } }], ['threshold NaN', { condition: { op: 'gt', threshold: NaN } }],
    ['unknown operator', { condition: { op: '$gt', threshold: 1 } }],
    ['too many channels', { channelIds: Array.from({ length: 6 }, () => crypto.randomUUID()) }], ['duplicate channels', { channelIds: (() => { const id = crypto.randomUUID(); return [id, id]; })() }],
    ['channel id is not a uuid', { channelIds: ['../../etc'] }], ['environment id is not a uuid', { environmentId: 'prod' }],
    ['log rule with a fractional threshold', { query: { kind: 'logs' }, condition: { op: 'gt', threshold: 1.5 } }],
    ['log rule with a negative threshold', { query: { kind: 'logs' }, condition: { op: 'gt', threshold: -1 } }],
    ['log rule with an unknown field', { query: { kind: 'logs', filters: [{ field: 'passwordHash', op: 'eq', value: 'x' }] } }],
    ['log rule with an operator not valid for the field', { query: { kind: 'logs', filters: [{ field: 'httpStatus', op: 'contains', value: '5' }] } }],
    ['log rule with too many filters', { query: { kind: 'logs', filters: Array.from({ length: 11 }, () => ({ field: 'service', op: 'eq', value: 'x' })) } }],
  ])('rejects: %s', (_n, over) => expect(bad(over).success).toBe(false));
  test('a valid log rule is accepted', () => {
    expect(bad({ query: { kind: 'logs', errorsOnly: true, services: ['checkout'], filters: [{ field: 'httpStatus', op: 'gte', value: 500 }] }, condition: { op: 'gte', threshold: 10 } }).success).toBe(true);
  });
  test('PATCH bodies never receive server defaults for fields that were not sent', () => {
    expect(AlertRuleUpdate.parse({ severity: 'info' })).toEqual({ severity: 'info' });
    expect(AlertRuleUpdate.safeParse({}).success).toBe(false);
    expect(AlertRuleUpdate.safeParse({ enabled: 'yes' }).success).toBe(false);
  });
  test('channels: the signing secret has a minimum length and the body is strict', () => {
    const c = { type: 'webhook', name: 'ops', url: 'https://hooks.example.com/x', signingSecret: 'x'.repeat(16) };
    expect(ChannelCreate.safeParse(c).success).toBe(true);
    expect(ChannelCreate.safeParse({ ...c, signingSecret: 'short' }).success).toBe(false);
    expect(ChannelCreate.safeParse({ ...c, type: 'email' }).success).toBe(false);
    expect(ChannelCreate.safeParse({ ...c, rateLimitPerMinute: 1000 }).success).toBe(false);
    expect(ChannelCreate.safeParse({ ...c, url: `https://x.com/${'a'.repeat(2100)}` }).success).toBe(false);
    expect(ChannelCreate.safeParse({ ...c, extra: 1 }).success).toBe(false);
  });
  test('silences: must end after they start and last at most 30 days', () => {
    const base = { comment: 'deploy', startsAt: '2026-03-01T12:00:00.000Z', endsAt: '2026-03-01T13:00:00.000Z' };
    expect(SilenceCreate.safeParse(base).success).toBe(true);
    expect(SilenceCreate.safeParse({ ...base, endsAt: base.startsAt }).success).toBe(false);
    expect(SilenceCreate.safeParse({ ...base, endsAt: '2026-04-15T12:00:00.000Z' }).success).toBe(false);
    expect(SilenceCreate.safeParse({ ...base, comment: '' }).success).toBe(false);
    expect(SilenceCreate.safeParse({ ...base, matchers: { ruleIds: ['x'] } }).success).toBe(false);
  });
});
