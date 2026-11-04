import { ALERT_LIMITS, PREVIEW_LIMITS, RulePreviewBody, type RulePreviewInput } from '@nexus/contracts';
import { startTestMongo } from '@nexus/database/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AlertingError } from './common.js';
import type { EvalDeps } from './evaluator.js';
import { RulePreviewService, summarizePreview } from './preview.js';
import { makeWorld, metricRule } from './testkit.js';

const NOW = new Date('2026-03-01T12:00:00Z');
const SCOPE = { orgId: 'org', projectId: 'proj' };
const ENV = crypto.randomUUID();
const RANGE = 7_200; // 2 h, 1-minute interval -> 121 evaluation points
const START = NOW.getTime() - RANGE * 1000;
/** Minutes since the start of the replayed range. */
const minute = (tMs: number) => Math.round((tMs - START) / 60_000);

type Val = number | null;
type Fn = (m: number, t: number) => Val | Record<string, Val>;

/** Stores whose answer depends only on the evaluation time (the `to` of the query), so a replay is fully deterministic. Every call is recorded. */
function fakeStores(fn: Fn, opts: { failAt?: (m: number) => Error | null; hang?: boolean; delayMs?: number } = {}) {
  const calls: { kind: 'query' | 'histogram'; to: string }[] = [];
  const answer = (to: string) => { const t = Date.parse(to); return fn(minute(t), t); };
  const deps: EvalDeps = {
    metrics: {
      async query(_s, q) {
        calls.push({ kind: 'query', to: q.to });
        if (opts.hang) await new Promise(() => undefined);
        if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
        const e = opts.failAt?.(minute(Date.parse(q.to))); if (e) throw e;
        const a = answer(q.to);
        const series = a === null ? [] : typeof a === 'number'
          ? [{ labels: {}, points: [{ t: 0, v: a }], exemplars: [] }]
          : Object.entries(a).map(([service, v]) => ({ labels: { service }, points: [{ t: 0, v }], exemplars: [] }));
        return { stepMs: 60_000, truncated: false, series } as never;
      },
    },
    logs: {
      async histogram(_s, q) {
        calls.push({ kind: 'histogram', to: q.to });
        if (opts.hang) await new Promise(() => undefined);
        const e = opts.failAt?.(minute(Date.parse(q.to))); if (e) throw e;
        const a = answer(q.to);
        return { bucketMs: 1000, buckets: a === null || typeof a !== 'number' ? [] : [{ t: 0, total: a, errors: 0 }] } as never;
      },
    },
  };
  return { deps, calls };
}

const body = (over: Record<string, unknown> = {}, query: Record<string, unknown> = {}, rangeSeconds = RANGE): RulePreviewBody => RulePreviewBody.parse({
  rule: {
    environmentId: ENV, query: 'kind' in query ? query : { kind: 'metric', metric: 'http.errors', agg: 'max', ...query }, condition: { op: 'gt', threshold: 10 },
    windowSeconds: 300, forSeconds: 300, resolveAfterSeconds: 120, noDataPolicy: 'keep', intervalSeconds: 60, ...over,
  },
  rangeSeconds,
});
const svc = (deps: EvalDeps, o: ConstructorParameters<typeof RulePreviewService>[1] = {}) => new RulePreviewService(deps, { now: () => NOW, ...o });
const burst = (from: number, to: number, hi = 50, lo = 1): Fn => (m) => (m >= from && m < to ? hi : lo);

describe('state machine over history (the real evaluator and the real state machine)', () => {
  test('pending for the "must hold for" time, then firing, then resolved only after the clear period', async () => {
    const { deps } = fakeStores(burst(30, 50));
    const r = await svc(deps).preview(SCOPE, body());
    expect(r.times).toHaveLength(121);
    expect(r.times[0]).toBe(START);
    expect(r.times.at(-1)).toBe(NOW.getTime());
    expect(r.groups).toHaveLength(1);
    const g = r.groups[0]!;
    expect(g.states[29]).toBe('ok');
    expect(g.states[30]).toBe('pending');
    expect(g.states[34]).toBe('pending');
    expect(g.states[35]).toBe('firing');     // 300 s after the first breach
    expect(g.states[51]).toBe('firing');     // clear since m50 but resolveAfterSeconds = 120
    expect(g.states[52]).toBe('resolved');
    expect(g.periods).toEqual([
      { kind: 'pending', from: new Date(START + 30 * 60_000).toISOString(), to: new Date(START + 35 * 60_000).toISOString(), ongoing: false },
      { kind: 'firing', from: new Date(START + 35 * 60_000).toISOString(), to: new Date(START + 52 * 60_000).toISOString(), ongoing: false },
    ]);
    expect(g.wouldOpen).toBe(1);
    expect(r.totals).toMatchObject({ wouldOpenIncidents: 1, groupsThatWouldFire: 1, evaluationPoints: 121, evaluatedPoints: 121, skippedPoints: 0, noDataPoints: 0 });
    expect(g.values[30]).toBe(50);
    expect(g.values[10]).toBe(1);
    expect(r.partial).toBe(false);
    expect(summarizePreview(r)).toBe('With > 10 over 5m, this rule would have opened 1 incident in the last 2h.');
  });

  test('a breach that clears before "must hold for" never fires (cancelled pending)', async () => {
    const { deps } = fakeStores(burst(30, 33));
    const r = await svc(deps).preview(SCOPE, body());
    expect(r.groups[0]!.wouldOpen).toBe(0);
    expect(r.groups[0]!.periods).toEqual([{ kind: 'pending', from: new Date(START + 30 * 60_000).toISOString(), to: new Date(START + 33 * 60_000).toISOString(), ongoing: false }]);
    expect(r.totals.groupsThatWouldFire).toBe(0);
  });

  test('flapping inside the resolve window is ONE incident; separate bursts are separate incidents', async () => {
    const flap = await svc(fakeStores((m) => (m >= 30 && m < 50) || (m >= 51 && m < 70) ? 50 : 1).deps).preview(SCOPE, body());
    expect(flap.groups[0]!.wouldOpen).toBe(1);
    expect(flap.groups[0]!.periods.filter((p) => p.kind === 'firing')).toHaveLength(1);
    const two = await svc(fakeStores((m) => (m >= 10 && m < 20) || (m >= 60 && m < 75) ? 50 : 1).deps).preview(SCOPE, body());
    expect(two.groups[0]!.wouldOpen).toBe(2);
    expect(two.totals.wouldOpenIncidents).toBe(2);
    expect(summarizePreview(two)).toContain('opened 2 incidents');
  });

  test('forSeconds = 0 fires on the first breaching point; a breach still running at the end is "ongoing"', async () => {
    const r = await svc(fakeStores(burst(100, 999)).deps).preview(SCOPE, body({ forSeconds: 0 }));
    const g = r.groups[0]!;
    expect(g.states[99]).toBe('ok');
    expect(g.states[100]).toBe('firing');
    expect(g.periods).toEqual([{ kind: 'firing', from: new Date(START + 100 * 60_000).toISOString(), to: new Date(NOW.getTime()).toISOString(), ongoing: true }]);
    expect(g.wouldOpen).toBe(1);
  });

  test('comparison operators come from the rule (lt): a value BELOW the threshold breaches', async () => {
    const r = await svc(fakeStores((m) => (m >= 20 && m < 30 ? 0 : 100)).deps).preview(SCOPE, body({ condition: { op: 'lt', threshold: 5 }, forSeconds: 0 }));
    expect(r.groups[0]!.wouldOpen).toBe(1);
    expect(r.groups[0]!.states[20]).toBe('firing');
  });

  test('groups are tracked separately, one breaching group fires, the other does not', async () => {
    const { deps } = fakeStores((m) => ({ checkout: m >= 20 && m < 40 ? 99 : 0, search: 1 }));
    const r = await svc(deps).preview(SCOPE, body({}, { groupBy: ['service'] }));
    expect(r.groups.map((g) => g.key).sort()).toEqual(['service=checkout', 'service=search']);
    const byKey = Object.fromEntries(r.groups.map((g) => [g.key, g]));
    expect(byKey['service=checkout']!.wouldOpen).toBe(1);
    expect(byKey['service=search']!.wouldOpen).toBe(0);
    expect(byKey['service=checkout']!.labels).toEqual({ service: 'checkout' });
    expect(r.totals).toMatchObject({ wouldOpenIncidents: 1, groupsThatWouldFire: 1 });
  });

  test('more than 20 groups: the first 20 are kept and the result says so', async () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`s${i}`, 1]));
    const r = await svc(fakeStores(() => many).deps).preview(SCOPE, body({}, { groupBy: ['service'] }));
    expect(r.groups).toHaveLength(ALERT_LIMITS.maxGroupsPerRule);
    expect(r.truncatedGroups).toBe(true);
    expect(r.notes.join(' ')).toContain('first 20');
  });

  test('log count rules replay through the log store (zero is a value, not "no data")', async () => {
    const { deps, calls } = fakeStores((m) => (m >= 40 && m < 60 ? 30 : 0));
    const r = await svc(deps).preview(SCOPE, body({ condition: { op: 'gte', threshold: 20 }, forSeconds: 120 }, { kind: 'logs', errorsOnly: true }));
    expect(calls.every((c) => c.kind === 'histogram')).toBe(true);
    expect(r.groups[0]!.wouldOpen).toBe(1);
    expect(r.groups[0]!.values[10]).toBe(0);
    expect(r.totals.noDataPoints).toBe(0);
  });
});

describe('no data', () => {
  const gap: Fn = (m) => (m >= 40 && m < 60 ? null : 50);
  test('"keep": missing points change nothing (a firing rule stays firing), and the note says so', async () => {
    const r = await svc(fakeStores(gap).deps).preview(SCOPE, body({ forSeconds: 0 }));
    expect(r.groups[0]!.wouldOpen).toBe(1);
    expect(r.groups[0]!.states[45]).toBe('firing');
    expect(r.groups[0]!.values[45]).toBeNull();
    expect(r.groups[0]!.noDataPoints).toBe(20);
    expect(r.totals.noDataPoints).toBe(20);
    expect(r.notes.join(' ')).toContain('"keep the current state"');
    expect(r.notes.join(' ')).toContain('never drawn as zero');
  });
  test('"ok": missing data counts as healthy, so the rule resolves and fires again when the data returns', async () => {
    const r = await svc(fakeStores(gap).deps).preview(SCOPE, body({ forSeconds: 0, noDataPolicy: 'ok' }));
    expect(r.groups[0]!.states[41]).toBe('firing');
    expect(r.groups[0]!.states[42]).toBe('resolved'); // clear for resolveAfterSeconds = 120
    expect(r.groups[0]!.wouldOpen).toBe(2);
    expect(r.notes.join(' ')).toContain('as healthy');
  });
  test('"alert": missing data counts as a breach', async () => {
    const r = await svc(fakeStores((m) => (m >= 40 && m < 60 ? null : 1)).deps).preview(SCOPE, body({ forSeconds: 0, noDataPolicy: 'alert' }));
    expect(r.groups[0]!.wouldOpen).toBe(1);
    expect(r.groups[0]!.states[40]).toBe('firing');
    expect(r.notes.join(' ')).toContain('as a problem');
  });
  test('no data anywhere in the range is stated plainly', async () => {
    const r = await svc(fakeStores(() => null).deps).preview(SCOPE, body());
    expect(r.totals).toMatchObject({ noDataPoints: 121, evaluatedPoints: 121, wouldOpenIncidents: 0 });
    expect(r.notes[0]).toContain('no data at all in this range');
  });
});

describe('limits, errors and the clock', () => {
  test('a 24 h range at a 15 s interval is widened to at most 200 evaluation points (and says so)', async () => {
    const { deps, calls } = fakeStores(() => 1);
    const r = await svc(deps).preview(SCOPE, body({ intervalSeconds: 15, windowSeconds: 60 }, {}, 86_400));
    expect(r.times.length).toBeLessThanOrEqual(PREVIEW_LIMITS.maxPoints);
    expect(r.stepSeconds).toBe(Math.ceil(86_400 / 199));
    expect(calls).toHaveLength(r.times.length);
    expect(r.notes.join(' ')).toContain('replayed every');
    expect(r.rangeSeconds).toBe(86_400);
    expect(r.times.every((t, i) => i === 0 || t - r.times[i - 1]! === r.stepSeconds * 1000)).toBe(true);
  });

  test('the step is never finer than the rule interval', async () => {
    const r = await svc(fakeStores(() => 1).deps).preview(SCOPE, body({ intervalSeconds: 300, windowSeconds: 600 }, {}, 3_600));
    expect(r.stepSeconds).toBe(300);
    expect(r.times).toHaveLength(13);
  });

  test('the store-query limit stops the replay and returns the first part, flagged partial', async () => {
    const { deps, calls } = fakeStores(() => 1);
    const r = await svc(deps, { maxStoreQueries: 30 }).preview(SCOPE, body());
    expect(r.partial).toBe(true);
    expect(calls.length).toBeLessThanOrEqual(30);
    expect(r.times.length).toBeLessThanOrEqual(30);
    expect(r.times[0]).toBe(START);
    expect(r.notes.join(' ')).toContain('limit of 30 store queries');
  });

  test('an avg rule costs two store queries per point, and the overall cap holds', async () => {
    const { deps, calls } = fakeStores(() => 1);
    await svc(deps).preview(SCOPE, body({}, { agg: 'avg' }, 3_600));
    expect(calls).toHaveLength(61 * 2);
    expect(61 * 2).toBeLessThanOrEqual(PREVIEW_LIMITS.maxStoreQueries);
  });

  test('the deadline stops the replay (injected clock) and returns what was evaluated', async () => {
    let ms = 0;
    const { deps } = fakeStores(() => 1);
    const slow: EvalDeps = { ...deps, metrics: { query: async (s, q) => { ms += 1_000; return deps.metrics.query(s, q); } } };
    const r = await svc(slow, { clockMs: () => ms, deadlineMs: 20_000, concurrency: 1 }).preview(SCOPE, body());
    expect(r.partial).toBe(true);
    expect(r.times.length).toBeGreaterThan(1);
    expect(r.times.length).toBeLessThan(121);
    expect(r.notes.join(' ')).toContain('ran out of time');
  });

  test('a store that hangs is cut off by the deadline (real timers): error, never an unbounded wait', async () => {
    await expect(svc(fakeStores(() => 1, { hang: true }).deps, { deadlineMs: 80, pointBudgetMs: 5_000 }).preview(SCOPE, body())).rejects.toMatchObject({ status: 504, code: 'preview_timeout' });
    await expect(svc(fakeStores(() => 1, { hang: true }).deps, { deadlineMs: 5_000, pointBudgetMs: 40 }).preview(SCOPE, body())).rejects.toThrow(/time budget/);
  });

  test('a refused query fails the preview ONCE with the store\'s message (no 120 repeated failures)', async () => {
    const f = fakeStores(() => 1, { failAt: () => new Error('unsupported_aggregation: "sum" is not available for a gauge metric') });
    const err = await svc(f.deps).preview(SCOPE, body()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AlertingError);
    expect(err).toMatchObject({ status: 422, code: 'preview_failed' });
    expect((err as Error).message).toContain('unsupported_aggregation');
    expect(f.calls).toHaveLength(1);
  });

  test('a later failing point is skipped, changes no state, and is reported', async () => {
    const { deps } = fakeStores(burst(30, 70), { failAt: (m) => (m === 40 ? new Error('boom') : null) });
    const r = await svc(deps).preview(SCOPE, body());
    expect(r.skipped).toEqual([40]);
    expect(r.totals).toMatchObject({ skippedPoints: 1, evaluatedPoints: 120 });
    expect(r.groups[0]!.states[40]).toBe(r.groups[0]!.states[39]); // state carried over
    expect(r.groups[0]!.values[40]).toBeNull();
    expect(r.groups[0]!.wouldOpen).toBe(1);
    expect(r.notes.join(' ')).toContain('1 evaluation time(s) failed');
  });

  test('previews in flight are limited per process (429 busy), and the slot is released afterwards', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { deps } = fakeStores(() => 1);
    const slow: EvalDeps = { ...deps, metrics: { query: async (s, q) => { await gate; return deps.metrics.query(s, q); } } };
    const s = svc(slow, { maxConcurrentPreviews: 1 });
    const first = s.preview(SCOPE, body({}, {}, 600));
    await expect(s.preview(SCOPE, body())).rejects.toMatchObject({ status: 429, code: 'busy' });
    release();
    await first;
    await expect(s.preview(SCOPE, body({}, {}, 600))).resolves.toBeDefined();
  });

  test('evaluations of one preview run at most `concurrency` at a time', async () => {
    let live = 0, peak = 0;
    const { deps } = fakeStores(() => 1);
    const watched: EvalDeps = { ...deps, metrics: { query: async (s, q) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 2)); try { return await deps.metrics.query(s, q); } finally { live--; } } } };
    await svc(watched, { concurrency: 3 }).preview(SCOPE, body({}, {}, 1_200));
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  test('the evaluator is scoped to the CALLER\'s org and project and the rule environment, never to anything in the body', async () => {
    const seen: unknown[] = [];
    const { deps } = fakeStores(() => 1);
    const spy: EvalDeps = { ...deps, metrics: { query: async (s, q) => { seen.push(s); return deps.metrics.query(s, q); } } };
    await svc(spy).preview({ orgId: 'org-x', projectId: 'proj-y' }, body({}, {}, 600));
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s).toEqual({ orgId: 'org-x', projectId: 'proj-y', environmentIds: [ENV] });
  });
});

describe('request contract', () => {
  const ok = { rule: { environmentId: ENV, query: { kind: 'metric', metric: 'm', agg: 'max' }, condition: { op: 'gt', threshold: 1 }, windowSeconds: 300 } };
  const bad = (over: Record<string, unknown>) => RulePreviewBody.safeParse({ ...ok, ...over });
  test('defaults: 6 h range, rule defaults', () => {
    const b = RulePreviewBody.parse(ok);
    expect(b.rangeSeconds).toBe(21_600);
    expect(b.rule).toMatchObject({ forSeconds: 0, resolveAfterSeconds: 120, noDataPolicy: 'keep', intervalSeconds: 60 });
  });
  test.each([
    ['range below 5 minutes', { rangeSeconds: 60 }], ['range above 24 h', { rangeSeconds: 86_401 }], ['fractional range', { rangeSeconds: 600.5 }], ['string range', { rangeSeconds: '3600' }],
    ['unknown top-level field (cannot select another project)', { projectId: crypto.randomUUID() }],
    ['a name is not accepted (a preview is not a rule)', { rule: { ...ok.rule, name: 'x' } }],
    ['channels are not accepted', { rule: { ...ok.rule, channelIds: [] } }],
    ['percentile aggregation', { rule: { ...ok.rule, query: { kind: 'metric', metric: 'm', agg: 'p95' } } }],
    ['interval much longer than the window (same rule as create)', { rule: { ...ok.rule, windowSeconds: 60, intervalSeconds: 300 } }],
    ['log rule with a fractional threshold', { rule: { ...ok.rule, query: { kind: 'logs' }, condition: { op: 'gt', threshold: 1.5 } } }],
    ['environment id is not a uuid', { rule: { ...ok.rule, environmentId: 'prod' } }],
    ['window too long', { rule: { ...ok.rule, windowSeconds: 90_000 } }],
  ])('rejects: %s', (_n, over) => expect(bad(over).success).toBe(false));
  test('range limits are inclusive', () => {
    expect(bad({ rangeSeconds: 300 }).success).toBe(true);
    expect(bad({ rangeSeconds: 86_400 }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------------- parity with the live engine and "no writes"
describe('parity with the live engine, and nothing is written', () => {
  let mongo: Awaited<ReturnType<typeof startTestMongo>>;
  beforeAll(async () => { mongo = await startTestMongo(); }, 240_000);
  afterAll(async () => { await mongo?.stop(); });

  test('replaying a recorded series gives the same incidents as the real engine ticking through it, and a preview writes nothing', async () => {
    const w = await makeWorld(mongo.uri);
    const start = w.clock.t;
    const pattern = (m: number): number => ((m >= 10 && m < 25) || (m >= 26 && m < 31) || (m >= 60 && m < 64) || (m >= 80 && m < 100) ? 50 : 1);
    const at = (tMs: number) => pattern(Math.round((tMs - start) / 60_000));
    const deps: EvalDeps = {
      metrics: { async query(_s, q) { return { stepMs: 60_000, truncated: false, series: [{ labels: {}, points: [{ t: 0, v: at(Date.parse(q.to)) }], exemplars: [] }] } as never; } },
      logs: { async histogram() { return { bucketMs: 1, buckets: [] } as never; } },
    };
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 120, resolveAfterSeconds: 120, intervalSeconds: 60 }), { requestId: 'r' });
    const engine = w.engine(deps);
    for (let i = 0; i <= 120; i++) { await engine.tick(); if (i < 120) w.clock.advance(60); }
    const live = await w.db.c.incidents.find({ ruleId: rule._id }).sort({ openedAt: 1 }).toArray();

    const counts = async () => ({
      config: await w.db.c.alertConfig.countDocuments({}), incidents: await w.db.c.incidents.countDocuments({}), deliveries: await w.db.c.alertDeliveries.countDocuments({}),
      audit: await w.db.c.auditEvents.countDocuments({}), rule: JSON.stringify(await w.db.c.alertConfig.findOne({ _id: rule._id })),
    });
    const before = await counts();
    const preview = await new RulePreviewService(deps, { now: () => new Date(start + 120 * 60_000) }).preview(
      { orgId: w.orgA, projectId: w.projA },
      RulePreviewBody.parse({ rule: { environmentId: w.envA, query: { kind: 'metric', metric: 'http.errors', agg: 'max' }, condition: { op: 'gt', threshold: 10 }, windowSeconds: 300, forSeconds: 120, resolveAfterSeconds: 120, noDataPolicy: 'keep', intervalSeconds: 60 }, rangeSeconds: 7_200 }),
    );
    expect(await counts()).toEqual(before); // no incident, delivery, rule state or audit event was written

    expect(live.length).toBeGreaterThan(0);
    expect(preview.totals.wouldOpenIncidents).toBe(live.length);
    const firingFrom = preview.groups[0]!.periods.filter((p) => p.kind === 'firing').map((p) => p.from);
    expect(firingFrom).toEqual(live.map((i) => i.openedAt.toISOString()));
    const resolvedAt = preview.groups[0]!.periods.filter((p) => p.kind === 'firing' && !p.ongoing).map((p) => p.to);
    expect(resolvedAt).toEqual(live.filter((i) => i.resolvedAt).map((i) => i.resolvedAt!.toISOString()));
  });
});
