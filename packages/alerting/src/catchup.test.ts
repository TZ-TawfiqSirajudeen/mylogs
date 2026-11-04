import type { AlertRuleDoc } from '@nexus/database';
import { startTestMongo } from '@nexus/database/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ruleCol } from './common.js';
import type { EvalDeps } from './evaluator.js';
import { metricRule, makeWorld, type World } from './testkit.js';

/**
 * Missed evaluations and the replay policy (ADR-0010), driven by the fake clock: the worker "is down" while the clock jumps, then a tick runs.
 * The stores answer from a function of the evaluation's END instant, so a replayed boundary sees what the data said at that time.
 */
let mongo: Awaited<ReturnType<typeof startTestMongo>>;
beforeAll(async () => { mongo = await startTestMongo(); }, 240_000);
afterAll(async () => { await mongo?.stop(); });

const ctx = { requestId: 'r' };
const SECRET = 'whsec_super-secret-signing-value-123';

function timedStores(valueAt: (at: Date) => number | null) {
  const calls: { from: Date; to: Date }[] = [];
  const hooks: { onQuery?: (to: Date) => Promise<void> } = {};
  const deps: EvalDeps = {
    metrics: {
      async query(_scope, q) {
        const to = new Date(q.to);
        calls.push({ from: new Date(q.from), to });
        await hooks.onQuery?.(to);
        const v = valueAt(to);
        return { metric: q.metric, type: 'gauge', unit: null, agg: q.agg ?? null, stepMs: 60_000, from: q.from, to: q.to, truncated: false, notes: [], series: [{ labels: {}, points: [{ t: 0, v }], exemplars: [] }] } as never;
      },
    },
    logs: { async histogram() { return { bucketMs: 1000, buckets: [{ t: 0, total: 0, errors: 0 }] }; } },
  };
  return { deps, calls, hooks };
}

const channel = (w: World, name = 'hook') => w.svc.channels.create(w.scopeA, { name, url: 'https://hooks.example.com/x', signingSecret: SECRET, enabled: true, rateLimitPerMinute: 60 }, ctx);
const ruleOf = async (w: World, id: string): Promise<AlertRuleDoc> => (await ruleCol(w.db).findOne({ _id: id }))!;
const incidentsOf = (w: World, ruleId: string) => w.db.c.incidents.find({ ruleId }).sort({ openedAt: 1 }).toArray();
const deliveriesOf = (w: World, incidentId: string) => w.db.c.alertDeliveries.find({ incidentId }).sort({ createdAt: 1, _id: 1 }).toArray();
type W2 = World & { clock: World['clock'] & { t0: number } };
const s = (w: W2, sec: number) => new Date(w.clock.t0 + sec * 1000);
const pairs = (ds: { event: string; status: string }[]) => ds.map((d) => `${d.event}/${d.status}`).sort();
async function world(): Promise<W2> { const w = (await makeWorld(mongo.uri)) as W2; w.clock.t0 = w.clock.t; return w; }
const outage = (w: World, seconds: number) => w.clock.advance(seconds);

describe('skip (the default) only counts what was missed', () => {
  test('after an outage the rule is judged at the current time; the gap is counted and nothing is replayed', async () => {
    const w = await world();
    const T = (sec: number) => w.clock.t0 + sec * 1000;
    const { deps } = timedStores((at) => (at.getTime() >= T(300) ? 99 : 0));
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 120, intervalSeconds: 60, windowSeconds: 300 }), ctx);
    expect(rule.missedPolicy).toBe('skip');
    const engine = w.engine(deps);
    await engine.tick();                      // T0: ok
    expect((await ruleOf(w, rule._id)).missed).toMatchObject({ total: 0 });
    outage(w, 600);                           // the worker was down for ten minutes
    const [o] = await engine.tick();
    expect(o).toMatchObject({ ok: true, missed: 9, replayed: 0 });
    const r = await ruleOf(w, rule._id);
    expect(r.missed).toMatchObject({ total: 9, replayed: 0, skipped: 9, lastAt: w.clock.now() });
    expect(r.groups[0]).toMatchObject({ status: 'pending', since: w.clock.now() }); // the breach is only noticed now, and its for-duration starts now
    expect(await incidentsOf(w, rule._id)).toHaveLength(0);
    expect(engine.metrics.evaluationsMissed).toBe(9);
    expect(engine.metrics.evaluationsReplayed).toBe(0);
  });

  test('being a few seconds late, or evaluating on time, is not a missed evaluation', async () => {
    const w = await world();
    const { deps } = timedStores(() => 0);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { intervalSeconds: 60 }), ctx);
    const engine = w.engine(deps);
    await engine.tick();
    for (const gap of [60, 63, 119]) { w.clock.advance(gap); await engine.tick(); }
    const r = await ruleOf(w, rule._id);
    expect(r.missed?.total ?? 0).toBe(0);
    expect(engine.metrics.evaluationsMissed).toBe(0);
  });
});

describe('replay re-evaluates the latest missed boundaries in order, with event-time windows', () => {
  test('a breach that began and was confirmed during the outage opens its incident at the boundary where it happened', async () => {
    const w = await world();
    const T = (sec: number) => w.clock.t0 + sec * 1000;
    const { deps, calls } = timedStores((at) => (at.getTime() >= T(300) ? 99 : 0));
    const ch = await channel(w);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 120, intervalSeconds: 60, windowSeconds: 300, missedPolicy: 'replay', maxReplayEvaluations: 5, channelIds: [ch._id] }), ctx);
    const engine = w.engine(deps);
    await engine.tick();
    outage(w, 600);
    calls.length = 0;
    const [o] = await engine.tick();
    expect(o).toMatchObject({ ok: true, missed: 9, replayed: 5, opened: 1 });

    // the evaluation windows END at the replayed boundaries, oldest first, then at "now": event time, not processing time
    expect(calls.map((c) => (c.to.getTime() - w.clock.t0) / 1000)).toEqual([300, 360, 420, 480, 540, 600]);
    for (const c of calls) expect(c.to.getTime() - c.from.getTime()).toBe(300_000);

    const [inc] = await incidentsOf(w, rule._id);
    expect(inc).toMatchObject({ status: 'open', active: true });
    expect(inc!.openedAt).toEqual(s(w, 420));          // pending at 300, for-duration reached at 420
    expect(inc!.timeline[0]).toMatchObject({ type: 'opened', at: s(w, 420), data: { replayed: true, evaluatedAt: s(w, 420).toISOString(), processedAt: w.clock.now().toISOString() } });

    const r = await ruleOf(w, rule._id);
    expect(r.groups[0]).toMatchObject({ status: 'firing', since: s(w, 420), incidentId: inc!._id });
    expect(r.missed).toMatchObject({ total: 9, replayed: 5, skipped: 4 });
    expect(r.lastEvaluatedAt).toEqual(w.clock.now());
    expect(r.nextEvalAt).toEqual(s(w, 660));
    expect(r.lease).toBeNull();

    // the transition is 3 minutes old: younger than the stale limit (15 min), so it is notified normally
    const ds = await deliveriesOf(w, inc!._id);
    expect(ds.map((d) => [d.event, d.status])).toEqual([['incident.opened', 'pending']]);
    expect(await w.svc.delivery.tick()).toBe(1);
    expect(w.sent.map((x) => x.event)).toEqual(['incident.opened']);
    expect(engine.metrics).toMatchObject({ evaluationsMissed: 9, evaluationsReplayed: 5, catchUpNotices: 0 });
  });

  test('the same outage with skip opens nothing yet: replay is what makes the state reflect the gap', async () => {
    const w = await world();
    const T = (sec: number) => w.clock.t0 + sec * 1000;
    const { deps } = timedStores((at) => (at.getTime() >= T(300) ? 99 : 0));
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 120, intervalSeconds: 60, windowSeconds: 300 }), ctx);
    const engine = w.engine(deps);
    await engine.tick(); outage(w, 600); await engine.tick();
    expect(await incidentsOf(w, rule._id)).toHaveLength(0);
  });

  test('recovery during the outage is replayed too: pending is cancelled, firing resolves after the hysteresis, all at event time', async () => {
    const w = await world();
    const T = (sec: number) => w.clock.t0 + sec * 1000;
    // breaching until T+240, clear afterwards
    const { deps } = timedStores((at) => (at.getTime() < T(240) ? 99 : 0));
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0, resolveAfterSeconds: 120, intervalSeconds: 60, windowSeconds: 300, missedPolicy: 'replay', maxReplayEvaluations: 20 }), ctx);
    const engine = w.engine(deps);
    await engine.tick();                      // fires at T0
    expect((await incidentsOf(w, rule._id))).toHaveLength(1);
    outage(w, 900);                           // down for 15 minutes
    const [o] = await engine.tick();
    expect(o).toMatchObject({ missed: 14, replayed: 14, resolved: 1 });
    const [inc] = await incidentsOf(w, rule._id);
    expect(inc).toMatchObject({ status: 'resolved', active: false });
    // first clear observation at T+240, resolved 120 s of continuous clear later: T+360 (event time), not at the processing time T+900
    expect(inc!.resolvedAt).toEqual(s(w, 360));
    expect(inc!.timeline.at(-1)).toMatchObject({ type: 'auto_resolved', at: s(w, 360), data: { replayed: true } });
    expect((await ruleOf(w, rule._id)).groups[0]).toMatchObject({ status: 'resolved', since: s(w, 360) });
  });

  test('replays at most N boundaries (the latest ones); the older ones are only counted', async () => {
    const w = await world();
    const { deps, calls } = timedStores(() => 0);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { intervalSeconds: 60, missedPolicy: 'replay', maxReplayEvaluations: 3 }), ctx);
    const engine = w.engine(deps);
    await engine.tick(); outage(w, 60 * 30); calls.length = 0;
    const [o] = await engine.tick();
    expect(o).toMatchObject({ missed: 29, replayed: 3 });
    expect(calls).toHaveLength(4); // 3 replayed boundaries + the evaluation now
    expect(calls.slice(0, 3).map((c) => (c.to.getTime() - w.clock.t0) / 60_000)).toEqual([27, 28, 29]);
    expect((await ruleOf(w, rule._id)).missed).toMatchObject({ total: 29, replayed: 3, skipped: 26 });
  });

  test('a failing replayed evaluation changes nothing and is counted as skipped; the others still run', async () => {
    const w = await world();
    const T = (sec: number) => w.clock.t0 + sec * 1000;
    const { deps, hooks } = timedStores(() => 99);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0, intervalSeconds: 60, missedPolicy: 'replay', maxReplayEvaluations: 4 }), ctx);
    const engine = w.engine(deps);
    hooks.onQuery = async () => undefined;
    await engine.tick();
    outage(w, 300);
    hooks.onQuery = async (to) => { if (to.getTime() === T(180)) throw new Error('store unavailable'); };
    const [o] = await engine.tick();
    expect(o).toMatchObject({ ok: true, replayed: 3, missed: 4 });
    expect((await ruleOf(w, rule._id)).missed).toMatchObject({ replayed: 3, skipped: 1 });
    expect(await incidentsOf(w, rule._id)).toHaveLength(1); // still exactly one: the error neither resolved nor re-opened anything
  });

  test('the overall replay budget bounds the work: when it is exhausted the rest is skipped and the evaluation now still runs', async () => {
    const w = await world();
    const { deps } = timedStores(() => 0);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { intervalSeconds: 60, missedPolicy: 'replay', maxReplayEvaluations: 5 }), ctx);
    const engine = w.engine(deps, { replayBudgetMs: 0 });
    await engine.tick(); outage(w, 600);
    const [o] = await engine.tick();
    expect(o).toMatchObject({ ok: true, replayed: 0, missed: 9 });
    expect((await ruleOf(w, rule._id)).missed).toMatchObject({ total: 9, replayed: 0, skipped: 9 });
    expect((await ruleOf(w, rule._id)).health).toBe('ok');
  });
});

describe('no notification storm after a long outage', () => {
  test('stale replayed transitions are recorded as "stale" and not sent; a still-firing incident gets ONE catch-up notice', async () => {
    const w = await world();
    const T = (sec: number) => w.clock.t0 + sec * 1000;
    // two hours down, 5-minute interval; breach 30-50 min, then again from minute 100 until now
    const { deps } = timedStores((at) => { const m = (at.getTime() - T(0)) / 60_000; return (m >= 30 && m < 50) || m >= 100 ? 99 : 0; });
    const ch = await channel(w);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, {
      forSeconds: 0, resolveAfterSeconds: 0, intervalSeconds: 300, windowSeconds: 600, missedPolicy: 'replay', maxReplayEvaluations: 20, staleNotificationSeconds: 900, channelIds: [ch._id],
    }), ctx);
    const engine = w.engine(deps);
    await engine.tick();
    outage(w, 7200);
    const [o] = await engine.tick();
    expect(o).toMatchObject({ ok: true, missed: 23, replayed: 20, opened: 2, resolved: 1 });

    const [a, b] = await incidentsOf(w, rule._id);
    expect(a).toMatchObject({ status: 'resolved' });
    expect(a!.openedAt).toEqual(s(w, 1800)); expect(a!.resolvedAt).toEqual(s(w, 3000));
    expect(b).toMatchObject({ status: 'open', active: true }); expect(b!.openedAt).toEqual(s(w, 6000));

    // incident A lived and died inside the outage: its opening was stale, so nobody was ever told, and there is nothing to "resolve" for anyone
    const da = await deliveriesOf(w, a!._id);
    expect(pairs(da)).toEqual(['incident.opened/stale']);
    expect(da[0]!.lastError).toMatchObject({ code: 'stale' });
    expect(a!.timeline.filter((e) => e.type === 'notification_suppressed')).toHaveLength(1);
    expect(a!.timeline.find((e) => e.type === 'notification_suppressed')).toMatchObject({ data: { reason: 'stale', event: 'incident.opened' } });

    // incident B is still firing: the stale opening is recorded, then exactly one catch-up notice describes its CURRENT state
    const db = await deliveriesOf(w, b!._id);
    expect(pairs(db)).toEqual(['incident.opened/pending', 'incident.opened/stale']);
    expect(db.find((d) => d.status === 'pending')!.payload).toMatchObject({ catchUp: true, event: 'incident.opened' });
    expect(db.find((d) => d.status === 'stale')!.payload).not.toHaveProperty('catchUp');
    expect(engine.metrics.catchUpNotices).toBe(1);

    expect(await w.svc.delivery.tick()).toBe(1);
    expect(w.sent).toHaveLength(1);                       // one notification for the whole outage, not one per replayed transition
    expect(JSON.parse(w.sent[0]!.body)).toMatchObject({ event: 'incident.opened', incident: { id: b!._id } });
    // a second evaluation does not repeat it
    w.clock.advance(300); await engine.tick();
    expect(await w.svc.delivery.tick()).toBe(0);
    expect(await w.db.c.alertDeliveries.countDocuments({ status: { $in: ['pending', 'delivered'] } })).toBe(1);
  });

  test('an incident that was announced before the outage and recovered during it gets one catch-up "resolved" notice', async () => {
    const w = await world();
    const T = (sec: number) => w.clock.t0 + sec * 1000;
    const { deps } = timedStores((at) => (at.getTime() < T(600) ? 99 : 0));
    const ch = await channel(w);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0, resolveAfterSeconds: 0, intervalSeconds: 300, windowSeconds: 600, missedPolicy: 'replay', maxReplayEvaluations: 20, channelIds: [ch._id] }), ctx);
    const engine = w.engine(deps);
    await engine.tick();                                  // opens at T0, notified
    expect(await w.svc.delivery.tick()).toBe(1);
    outage(w, 7200);
    await engine.tick();
    const [inc] = await incidentsOf(w, rule._id);
    expect(inc).toMatchObject({ status: 'resolved' });
    expect(inc!.resolvedAt!.getTime()).toBeLessThan(w.clock.t - 3600_000); // resolved long ago in event time
    const ds = await deliveriesOf(w, inc!._id);
    expect(pairs(ds)).toEqual(['incident.opened/delivered', 'incident.resolved/pending', 'incident.resolved/stale']);
    expect(ds.find((d) => d.status === 'pending')!.payload).toMatchObject({ catchUp: true });
    expect(await w.svc.delivery.tick()).toBe(1);
    expect(w.sent.map((x) => x.event)).toEqual(['incident.opened', 'incident.resolved']);
  });

  test('transitions younger than the limit are sent normally, silences and the channel rate limit still apply', async () => {
    const w = await world();
    const T = (sec: number) => w.clock.t0 + sec * 1000;
    const { deps } = timedStores((at) => (at.getTime() >= T(120) ? 99 : 0));
    const ch = await channel(w);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0, intervalSeconds: 60, windowSeconds: 300, missedPolicy: 'replay', staleNotificationSeconds: 900, channelIds: [ch._id] }), ctx);
    await w.svc.silences.create(w.scopeA, { comment: 'planned', startsAt: new Date(w.clock.t - 1000).toISOString(), endsAt: new Date(w.clock.t + 3_600_000).toISOString(), matchers: {} }, ctx);
    const engine = w.engine(deps);
    await engine.tick(); outage(w, 300); await engine.tick();
    const [inc] = await incidentsOf(w, rule._id);
    expect(inc!.openedAt).toEqual(s(w, 120)); // 3 minutes old
    expect((await deliveriesOf(w, inc!._id)).map((d) => d.status)).toEqual(['suppressed']); // not stale: the silence decided
  });

  test('stale limit 0 treats every replayed transition as stale; a huge limit never does', async () => {
    for (const [limit, expected] of [[0, 'stale'], [86_400, 'pending']] as const) {
      const w = await world();
      const T = (sec: number) => w.clock.t0 + sec * 1000;
      const { deps } = timedStores((at) => (at.getTime() >= T(120) ? 99 : 0));
      const ch = await channel(w);
      const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0, intervalSeconds: 60, windowSeconds: 300, missedPolicy: 'replay', staleNotificationSeconds: limit, channelIds: [ch._id] }), ctx);
      const engine = w.engine(deps);
      await engine.tick(); outage(w, 300); await engine.tick();
      const [inc] = await incidentsOf(w, rule._id);
      const ds = await deliveriesOf(w, inc!._id);
      if (expected === 'stale') expect(ds.map((d) => d.status), `limit ${limit}`).toContain('stale'); // (the still-firing incident then also gets its one catch-up notice)
      else expect(ds.map((d) => d.status), `limit ${limit}`).toEqual(['pending']);
    }
  });
});

describe('maintenance windows and replay', () => {
  test('a replayed transition that happened inside a window is suppressed even though the window has ended when it is processed', async () => {
    const w = await world();
    const T = (sec: number) => w.clock.t0 + sec * 1000;
    const { deps } = timedStores((at) => (at.getTime() >= T(120) ? 99 : 0));
    const ch = await channel(w);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0, intervalSeconds: 60, windowSeconds: 300, missedPolicy: 'replay', channelIds: [ch._id] }), ctx);
    const win = await w.svc.maintenance.create(w.scopeA, {
      name: 'night work', comment: '', enabled: true, matchers: {},
      schedule: { type: 'once', startsAt: new Date(T(60)).toISOString(), endsAt: new Date(T(200)).toISOString() },
    }, ctx);
    const engine = w.engine(deps);
    await engine.tick(); outage(w, 300); await engine.tick();
    expect(w.clock.t).toBeGreaterThan(T(200));   // the window is over now
    const [inc] = await incidentsOf(w, rule._id);
    expect(inc!.openedAt).toEqual(s(w, 120));    // but the incident opened inside it
    const ds = await deliveriesOf(w, inc!._id);
    expect(ds).toHaveLength(1);
    expect(ds[0]).toMatchObject({ status: 'suppressed', maintenanceId: win._id, silenceId: null });
    expect(inc!.timeline.find((e) => e.type === 'notification_suppressed')).toMatchObject({ data: { reason: 'maintenance', maintenanceId: win._id } });
  });
});

describe('idempotency and two workers', () => {
  test('progress is persisted after every replayed boundary; a worker that stalls is taken over and cannot corrupt or duplicate anything', async () => {
    const w = await world();
    const T = (sec: number) => w.clock.t0 + sec * 1000;
    const { deps, hooks } = timedStores((at) => (at.getTime() > T(100) ? 99 : 0));
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0, intervalSeconds: 60, windowSeconds: 300, missedPolicy: 'replay', maxReplayEvaluations: 5 }), ctx);
    const a = w.engine(deps, { owner: 'worker-a' });
    const b = w.engine(deps, { owner: 'worker-b' });
    await a.tick();
    outage(w, 600);

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let reached!: () => void;
    const atGate = new Promise<void>((r) => { reached = r; });
    let first = true;
    hooks.onQuery = async (to) => { if (to.getTime() === T(420) && first) { first = false; reached(); await gate; } };

    const tickA = a.tick();                  // worker A claims the rule and starts replaying 300, 360, 420, ...
    await atGate;                            // ... and stalls inside the query for boundary 420
    const mid = await ruleOf(w, rule._id);
    expect(mid.lease?.owner).toBe('worker-a');
    expect(mid.nextEvalAt).toEqual(s(w, 420));                      // boundaries 300 and 360 are already persisted
    expect(mid.lastEvaluatedAt).toEqual(s(w, 360));
    expect(mid.groups[0]).toMatchObject({ status: 'firing', since: s(w, 300) });
    expect(mid.missed).toMatchObject({ replayed: 2 });
    expect(await b.tick()).toHaveLength(0);                         // A's lease is alive: B may not touch the rule

    w.clock.advance(100);                                           // A's lease expires
    hooks.onQuery = async () => undefined;
    const [ob] = await b.tick();                                    // B takes over and resumes AT the next boundary
    expect(ob).toMatchObject({ ok: true, replayed: 4 });            // 420, 480, 540, 600 (the plan is recomputed from the persisted nextEvalAt)
    const afterB = await ruleOf(w, rule._id);

    release();                                                      // A wakes up
    const [oa] = await tickA;
    expect(oa).toMatchObject({ aborted: true });                    // its guarded write matched nothing: the rule is not its any more
    const final = await ruleOf(w, rule._id);
    expect(final.lastEvaluatedAt).toEqual(afterB.lastEvaluatedAt);
    expect(final.nextEvalAt).toEqual(afterB.nextEvalAt);
    expect(final.version).toBe(afterB.version);
    expect(final.lease).toBeNull();
    expect(final.groups[0]).toMatchObject({ status: 'firing' });
    const incs = await incidentsOf(w, rule._id);
    expect(incs).toHaveLength(1);                                   // the dedup index: one live incident, however many workers replayed
    expect(incs[0]!.openedAt).toEqual(s(w, 300));
    expect(final.missed?.replayed).toBe(2 + 4);                     // no boundary counted twice
  });

  test('a rule edited during a replay discards the rest: nothing more is written', async () => {
    const w = await world();
    const T = (sec: number) => w.clock.t0 + sec * 1000;
    const { deps, hooks } = timedStores(() => 99);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0, intervalSeconds: 60, missedPolicy: 'replay', maxReplayEvaluations: 5 }), ctx);
    const engine = w.engine(deps);
    await engine.tick();
    outage(w, 600);
    hooks.onQuery = async (to) => { if (to.getTime() === T(420)) await w.svc.rules.update(w.scopeA, rule._id, { description: 'edited while replaying' }, ctx); };
    const [o] = await engine.tick();
    expect(o).toMatchObject({ aborted: true });
    const r = await ruleOf(w, rule._id);
    expect(r.description).toBe('edited while replaying');
    expect(r.version).toBe(2);
    expect(r.lastEvaluatedAt).toEqual(s(w, 360)); // boundary 420 was evaluated but never persisted
  });

  test('replaying the same outage from the same stored state twice yields the same incidents (no duplicates)', async () => {
    const w = await world();
    const T = (sec: number) => w.clock.t0 + sec * 1000;
    const { deps } = timedStores((at) => (at.getTime() >= T(300) ? 99 : 0));
    const ch = await channel(w);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 60, intervalSeconds: 60, windowSeconds: 300, missedPolicy: 'replay', maxReplayEvaluations: 5, channelIds: [ch._id] }), ctx);
    const engine = w.engine(deps);
    await engine.tick();
    const snapshot = await ruleOf(w, rule._id);
    outage(w, 600);
    await engine.tick();
    const first = await incidentsOf(w, rule._id);
    expect(first).toHaveLength(1);
    // simulate "the persisted write of the rule was lost" (crash after the incident write): restore the pre-replay rule state and run again
    await ruleCol(w.db).updateOne({ _id: rule._id }, { $set: { groups: snapshot.groups, nextEvalAt: snapshot.nextEvalAt, lastEvaluatedAt: snapshot.lastEvaluatedAt, lease: null } });
    await engine.tick();
    const second = await incidentsOf(w, rule._id);
    expect(second).toHaveLength(1);                       // unique partial index: the repeated "fire" found the live incident
    expect(second[0]!._id).toBe(first[0]!._id);
    expect(await w.db.c.alertDeliveries.countDocuments({ incidentId: first[0]!._id })).toBe(1);
  });
});

describe('rule configuration', () => {
  test('defaults, status fields, and changing the policy neither resets state nor closes incidents', async () => {
    const w = await world();
    const { deps } = timedStores(() => 99);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0 }), ctx);
    const { toRuleDto } = await import('./config.js');
    expect(toRuleDto(rule)).toMatchObject({ missedPolicy: 'skip', maxReplayEvaluations: 5, staleNotificationSeconds: 900, missedEvaluations: { total: 0, replayed: 0, skipped: 0, lastAt: null } });
    await w.engine(deps).tick();
    expect(await incidentsOf(w, rule._id)).toHaveLength(1);
    const updated = await w.svc.rules.update(w.scopeA, rule._id, { missedPolicy: 'replay', maxReplayEvaluations: 20, staleNotificationSeconds: 60 }, ctx);
    expect(updated).toMatchObject({ missedPolicy: 'replay', maxReplayEvaluations: 20, staleNotificationSeconds: 60 });
    expect(updated.groups).toHaveLength(1);
    expect((await incidentsOf(w, rule._id))[0]).toMatchObject({ active: true });
  });

  test('a stored rule from before this feature (no replay fields) behaves as skip with the documented defaults', async () => {
    const w = await world();
    const { deps } = timedStores(() => 0);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, {}), ctx);
    await ruleCol(w.db).updateOne({ _id: rule._id }, { $unset: { missedPolicy: '', maxReplayEvaluations: '', staleNotificationSeconds: '', missed: '' } });
    const engine = w.engine(deps);
    await engine.tick(); outage(w, 600);
    const [o] = await engine.tick();
    expect(o).toMatchObject({ ok: true, missed: 9, replayed: 0 });
    const r = await ruleOf(w, rule._id);
    const { toRuleDto } = await import('./config.js');
    expect(toRuleDto(r)).toMatchObject({ missedPolicy: 'skip', missedEvaluations: { total: 9, skipped: 9 } });
  });
});
