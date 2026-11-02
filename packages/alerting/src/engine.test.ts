import type { AlertRuleDoc } from '@nexus/database';
import { startTestMongo } from '@nexus/database/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ruleCol } from './common.js';
import { AlertEngine } from './engine.js';
import { metricRule, makeWorld, scriptedStores, type World } from './testkit.js';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
beforeAll(async () => { mongo = await startTestMongo(); }, 240_000);
afterAll(async () => { await mongo?.stop(); });

const incidentsOf = (w: World, ruleId: string) => w.db.c.incidents.find({ ruleId }).sort({ openedAt: 1 }).toArray();
const ruleOf = async (w: World, id: string): Promise<AlertRuleDoc> => (await ruleCol(w.db).findOne({ _id: id }))!;

describe('evaluation lifecycle with an injected clock', () => {
  test('ok -> pending -> firing (one incident) -> hysteresis -> auto-resolved, with a full timeline and audit trail', async () => {
    const w = await makeWorld(mongo.uri);
    const { state, deps } = scriptedStores();
    const engine = w.engine(deps);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 120, resolveAfterSeconds: 120, intervalSeconds: 60 }), { requestId: 'r' });

    const tick = async (value: number, advance = 60) => { w.clock.advance(advance); state.series = [{ labels: {}, value }]; await engine.tick(); return ruleOf(w, rule._id); };
    state.series = [{ labels: {}, value: 50 }];
    let r = await engine.tick().then(() => ruleOf(w, rule._id)); // t=0: breaching -> pending
    expect(r.groups[0]).toMatchObject({ status: 'pending', lastValue: 50 });
    expect(r.health).toBe('ok');
    expect(await incidentsOf(w, rule._id)).toHaveLength(0);

    r = await tick(50); // t=60: still pending
    expect(r.groups[0]!.status).toBe('pending');
    expect(await incidentsOf(w, rule._id)).toHaveLength(0);

    r = await tick(60); // t=120: for-duration reached -> firing
    expect(r.groups[0]!.status).toBe('firing');
    let incs = await incidentsOf(w, rule._id);
    expect(incs).toHaveLength(1);
    expect(incs[0]).toMatchObject({ status: 'open', active: true, severity: 'critical', environmentId: w.envA, lastValue: 60, groupKey: '' });
    expect(incs[0]!.timeline.map((e) => e.type)).toEqual(['opened']);
    expect(r.groups[0]!.incidentId).toBe(incs[0]!._id);

    r = await tick(70); // t=180: still breaching: NO second incident, value is tracked
    expect(await incidentsOf(w, rule._id)).toHaveLength(1);
    expect((await incidentsOf(w, rule._id))[0]!.lastValue).toBe(70);

    r = await tick(1); // t=240: clear, but hysteresis keeps it firing
    expect(r.groups[0]!.status).toBe('firing');
    expect((await incidentsOf(w, rule._id))[0]!.status).toBe('open');
    r = await tick(1, 60); // t=300: clear for only 60 s
    expect(r.groups[0]!.status).toBe('firing');
    r = await tick(1, 60); // t=360: clear for 120 s -> resolved
    expect(r.groups[0]).toMatchObject({ status: 'resolved', incidentId: null });
    incs = await incidentsOf(w, rule._id);
    expect(incs).toHaveLength(1);
    expect(incs[0]).toMatchObject({ status: 'resolved', active: false, resolvedBy: { kind: 'auto', userId: null, reason: 'recovered' } });
    expect(incs[0]!.expireAt).toBeInstanceOf(Date);
    expect(incs[0]!.timeline.map((e) => e.type)).toEqual(['opened', 'auto_resolved']);

    const audit = await w.db.c.auditEvents.find({ projectId: w.projA, action: { $in: ['incident.opened', 'incident.auto_resolved'] } }).sort({ seq: 1 }).toArray();
    expect(audit.map((a) => [a.action, a.actorType])).toEqual([['incident.opened', 'system'], ['incident.auto_resolved', 'system']]);

    // flapping after recovery: a new breach starts a NEW incident (the old one is closed)
    await tick(99, 60); await tick(99, 120);
    incs = await incidentsOf(w, rule._id);
    expect(incs).toHaveLength(2);
    expect(incs[1]!.active).toBe(true);
  });

  test('the evaluation queries exactly the rule\'s own organization, project and environment', async () => {
    const w = await makeWorld(mongo.uri);
    const { state, deps } = scriptedStores();
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w), { requestId: 'r' });
    await w.engine(deps).tick();
    const call = state.calls.find(() => true)!;
    expect(call.scope).toEqual({ orgId: w.orgA, projectId: w.projA, environmentIds: [w.envA] });
    expect((call.query as { environmentIds: string[] }).environmentIds).toEqual([w.envA]);
    expect(rule.environmentId).toBe(w.envA);
  });

  test('log rules count matching records and fire above the threshold (zero is a measurement, not "no data")', async () => {
    const w = await makeWorld(mongo.uri);
    const { state, deps } = scriptedStores();
    const engine = w.engine(deps);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { query: { kind: 'logs', errorsOnly: true, services: ['checkout'], filters: [{ field: 'httpStatus', op: 'gte', value: 500 }] }, condition: { op: 'gt', threshold: 5 }, forSeconds: 0, noDataPolicy: 'alert' }), { requestId: 'r' });
    state.logCount = 0; await engine.tick();
    expect((await ruleOf(w, rule._id)).groups).toHaveLength(0); // count 0 is "ok", even with noDataPolicy=alert
    w.clock.advance(60); state.logCount = 12; await engine.tick();
    expect((await incidentsOf(w, rule._id))).toHaveLength(1);
    const q = state.calls.at(-1)!.query as { errorsOnly: boolean; services: string[]; filters: unknown[]; environmentIds: string[] };
    expect(q).toMatchObject({ errorsOnly: true, services: ['checkout'], environmentIds: [w.envA] });
  });
});

describe('no data and evaluation errors', () => {
  test.each([
    ['keep', 'firing'], ['ok', 'resolved'], ['alert', 'firing'],
  ] as const)('a firing rule with noDataPolicy=%s ends up %s after data disappears for longer than the resolve delay', async (policy, expected) => {
    const w = await makeWorld(mongo.uri);
    const { state, deps } = scriptedStores();
    const engine = w.engine(deps);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0, resolveAfterSeconds: 60, noDataPolicy: policy }), { requestId: 'r' });
    state.series = [{ labels: {}, value: 99 }]; await engine.tick();
    expect((await ruleOf(w, rule._id)).groups[0]!.status).toBe('firing');
    state.series = [{ labels: {}, value: null }];
    for (let i = 0; i < 4; i++) { w.clock.advance(60); await engine.tick(); }
    const r = await ruleOf(w, rule._id);
    expect(r.groups[0]!.status).toBe(expected);
    expect(r.noDataSince).not.toBeNull();
  });

  test('noDataPolicy=alert opens an incident when a series never reported at all', async () => {
    const w = await makeWorld(mongo.uri);
    const { state, deps } = scriptedStores();
    state.series = []; // the metric does not exist
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0, noDataPolicy: 'alert' }), { requestId: 'r' });
    await w.engine(deps).tick();
    const [inc] = await incidentsOf(w, rule._id);
    expect(inc!.timeline[0]!.message).toMatch(/no data/i);
  });

  test('an evaluation ERROR never resolves an incident and never fires one; the error is recorded and the rule is rescheduled', async () => {
    const w = await makeWorld(mongo.uri);
    const { state, deps } = scriptedStores();
    const engine = w.engine(deps);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0, resolveAfterSeconds: 0 }), { requestId: 'r' });
    state.series = [{ labels: {}, value: 99 }]; await engine.tick();
    expect(await incidentsOf(w, rule._id)).toHaveLength(1);

    state.fail = new Error('query_too_expensive: More than 2000 series match');
    for (let i = 0; i < 3; i++) { w.clock.advance(60); await engine.tick(); }
    const r = await ruleOf(w, rule._id);
    expect(r.health).toBe('error');
    expect(r.lastError!.message).toMatch(/too_expensive/);
    expect(r.groups[0]!.status).toBe('firing'); // untouched
    expect((await incidentsOf(w, rule._id))[0]!.status).toBe('open');
    expect(r.nextEvalAt!.getTime()).toBe(w.clock.t + 60_000); // still scheduled

    state.fail = null; state.series = [{ labels: {}, value: 1 }]; w.clock.advance(60); await engine.tick();
    expect((await ruleOf(w, rule._id)).health).toBe('ok');
    expect((await incidentsOf(w, rule._id))[0]!.status).toBe('resolved'); // resolveAfter=0: recovers once the query works again

    // and an error on a quiet rule opens nothing
    const quiet = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0, noDataPolicy: 'alert' }), { requestId: 'r' });
    state.fail = new Error('boom'); w.clock.advance(60); await engine.tick();
    expect(await incidentsOf(w, quiet._id)).toHaveLength(0);
  });
});

describe('bounded work and fairness', () => {
  test('a rule that exceeds its time budget is abandoned and does not delay the others', async () => {
    const w = await makeWorld(mongo.uri);
    const { state, deps } = scriptedStores();
    const hanging = await w.svc.rules.create(w.scopeA, metricRule(w, { name: 'aaa-hangs', query: { kind: 'metric', metric: 'slow.metric', filters: [], groupBy: [], agg: 'max' }, forSeconds: 0 }), { requestId: 'r' });
    const healthy = await w.svc.rules.create(w.scopeA, metricRule(w, { name: 'bbb-fine', forSeconds: 0 }), { requestId: 'r' });
    await ruleCol(w.db).updateOne({ _id: hanging._id }, { $set: { nextEvalAt: new Date(w.clock.t - 1000) } }); // hanging rule is due first
    const slowDeps = { ...deps, metrics: { query: (s: unknown, q: { metric: string }) => (q.metric === 'slow.metric' ? new Promise<never>(() => undefined) : deps.metrics.query(s as never, q as never)) } };
    state.series = [{ labels: {}, value: 99 }];
    const t0 = Date.now();
    const out = await w.engine(slowDeps as never, { ruleBudgetMs: 150, concurrency: 1 }).tick();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(out.map((o) => [o.ruleId === hanging._id, o.ok])).toEqual([[true, false], [false, true]]);
    expect((await ruleOf(w, hanging._id)).lastError!.message).toMatch(/time budget/);
    expect((await ruleOf(w, hanging._id)).nextEvalAt!.getTime()).toBeGreaterThan(w.clock.t); // rescheduled: cannot hog the queue
    expect(await incidentsOf(w, healthy._id)).toHaveLength(1);
  });

  test('a tick evaluates at most maxRulesPerTick rules, oldest due first, and the backlog drains over the next ticks', async () => {
    const w = await makeWorld(mongo.uri);
    const { deps } = scriptedStores();
    const engine = w.engine(deps, { maxRulesPerTick: 3, concurrency: 2 });
    const rules = [];
    for (let i = 0; i < 8; i++) rules.push(await w.svc.rules.create(w.scopeA, metricRule(w, { name: `bulk-${i}` }), { requestId: 'r' }));
    // make rule i due at a distinct time (rule 0 the most overdue)
    for (const [i, r] of rules.entries()) await ruleCol(w.db).updateOne({ _id: r._id }, { $set: { nextEvalAt: new Date(w.clock.t - (100 - i) * 1000) } });
    const seen: string[] = [];
    for (let t = 0; t < 3; t++) {
      const out = await engine.tick();
      expect(out.length).toBeLessThanOrEqual(3);
      seen.push(...out.map((o) => o.ruleId));
    }
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8); // nothing evaluated twice, nothing starved
    expect(seen.slice(0, 3).sort()).toEqual(rules.slice(0, 3).map((r) => r._id).sort()); // most overdue first
  });

  test('two workers never evaluate the same rule at the same time (leases)', async () => {
    const w = await makeWorld(mongo.uri);
    const { state, deps } = scriptedStores();
    for (let i = 0; i < 12; i++) await w.svc.rules.create(w.scopeA, metricRule(w, { name: `lease-${i}` }), { requestId: 'r' });
    const slow = { ...deps, metrics: { query: async (s: never, q: never) => { await new Promise((r) => setTimeout(r, 20)); return deps.metrics.query(s, q); } } };
    const e1 = w.engine(slow, { owner: 'w1', concurrency: 4 }), e2 = w.engine(slow, { owner: 'w2', concurrency: 4 });
    const [a, b] = await Promise.all([e1.tick(), e2.tick()]);
    expect(a.length + b.length).toBe(12);
    expect(state.calls).toHaveLength(12);
    expect(new Set([...a, ...b].map((o) => o.ruleId)).size).toBe(12);
  });

  test('a crashed worker\'s lease expires and the rule is picked up again', async () => {
    const w = await makeWorld(mongo.uri);
    const { deps } = scriptedStores();
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w), { requestId: 'r' });
    await ruleCol(w.db).updateOne({ _id: rule._id }, { $set: { lease: { owner: 'dead-worker', until: new Date(w.clock.t + 30_000) } } });
    expect(await w.engine(deps).tick()).toHaveLength(0); // leased by someone alive
    w.clock.advance(31);
    expect(await w.engine(deps).tick()).toHaveLength(1);
  });

  test('disabled rules are never evaluated', async () => {
    const w = await makeWorld(mongo.uri);
    const { state, deps } = scriptedStores();
    await w.svc.rules.create(w.scopeA, metricRule(w, { enabled: false }), { requestId: 'r' });
    expect(await w.engine(deps).tick()).toHaveLength(0);
    expect(state.calls).toHaveLength(0);
  });

  test('the scheduler only scans enabled rules through the due-index (no collection scan)', async () => {
    const w = await makeWorld(mongo.uri);
    await w.svc.rules.create(w.scopeA, metricRule(w), { requestId: 'r' });
    const plan = JSON.stringify(await w.db.c.alertConfig.find({ kind: 'rule', enabled: true, nextEvalAt: { $lte: new Date() }, $or: [{ lease: null }, { 'lease.until': { $lt: new Date() } }] } as never).sort({ nextEvalAt: 1 }).explain('queryPlanner'));
    expect(plan).toContain('acfg_rule_due');
    expect(plan).not.toContain('COLLSCAN');
  });
});

describe('groups', () => {
  test('each group value has its own state and incident; a group that stops reporting keeps its state under "keep"', async () => {
    const w = await makeWorld(mongo.uri);
    const { state, deps } = scriptedStores();
    const engine = w.engine(deps);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0, query: { kind: 'metric', metric: 'http.errors', filters: [], groupBy: ['service'], agg: 'max' } }), { requestId: 'r' });
    state.series = [{ labels: { service: 'checkout' }, value: 50 }, { labels: { service: 'search' }, value: 1 }];
    await engine.tick();
    let incs = await incidentsOf(w, rule._id);
    expect(incs.map((i) => [i.groupKey, i.title])).toEqual([['service=checkout', `${rule.name} (service=checkout)`]]);
    expect(incs[0]!.groupLabels).toEqual({ service: 'checkout' });

    w.clock.advance(60); state.series = [{ labels: { service: 'checkout' }, value: 50 }, { labels: { service: 'search' }, value: 80 }];
    await engine.tick();
    incs = await incidentsOf(w, rule._id);
    expect(incs).toHaveLength(2); // search opened a second, independent incident; checkout was not duplicated
    expect(new Set(incs.map((i) => i.groupKey))).toEqual(new Set(['service=checkout', 'service=search']));

    w.clock.advance(60); state.series = [{ labels: { service: 'search' }, value: 80 }]; // checkout stopped reporting
    await engine.tick();
    expect((await incidentsOf(w, rule._id)).every((i) => i.status === 'open')).toBe(true);
    expect((await ruleOf(w, rule._id)).groups.map((g) => g.key).sort()).toEqual(['service=checkout', 'service=search']);
  });

  test('the number of tracked groups per rule is bounded and the overflow is reported', async () => {
    const w = await makeWorld(mongo.uri);
    const { state, deps } = scriptedStores();
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0, query: { kind: 'metric', metric: 'm', filters: [], groupBy: ['pod'], agg: 'max' } }), { requestId: 'r' });
    state.series = Array.from({ length: 35 }, (_, i) => ({ labels: { pod: `p${i}` }, value: 99 }));
    await w.engine(deps).tick();
    const r = await ruleOf(w, rule._id);
    expect(r.groups).toHaveLength(20);
    expect(r.truncatedGroups).toBe(true);
    expect(await incidentsOf(w, rule._id)).toHaveLength(20);
  });
});

describe('interaction with people and edits', () => {
  test('resolving by hand while the condition still holds: the next evaluation judges the group afresh (new incident after the for-duration)', async () => {
    const w = await makeWorld(mongo.uri);
    const { state, deps } = scriptedStores();
    const engine = w.engine(deps);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 60 }), { requestId: 'r' });
    state.series = [{ labels: {}, value: 99 }];
    await engine.tick(); w.clock.advance(60); await engine.tick();
    const [first] = await incidentsOf(w, rule._id);
    await w.svc.incidents.resolve(w.scopeA, first!._id, 'false alarm', { requestId: 'r' });
    w.clock.advance(60); await engine.tick(); // reset to pending (not firing, so no duplicate yet)
    expect((await ruleOf(w, rule._id)).groups[0]!.status).toBe('pending');
    expect(await incidentsOf(w, rule._id)).toHaveLength(1);
    w.clock.advance(60); await engine.tick();
    const incs = await incidentsOf(w, rule._id);
    expect(incs).toHaveLength(2);
    expect(incs.map((i) => i.status)).toEqual(['resolved', 'open']);
  });

  test('editing what a rule measures resets its state and closes its live incidents; cosmetic edits keep them', async () => {
    const w = await makeWorld(mongo.uri);
    const { state, deps } = scriptedStores();
    const engine = w.engine(deps);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0 }), { requestId: 'r' });
    state.series = [{ labels: {}, value: 99 }]; await engine.tick();
    await w.svc.rules.update(w.scopeA, rule._id, { description: 'now with a description', severity: 'warning' }, { requestId: 'r' });
    expect((await incidentsOf(w, rule._id))[0]!.status).toBe('open');
    expect((await ruleOf(w, rule._id)).groups).toHaveLength(1);

    const updated = await w.svc.rules.update(w.scopeA, rule._id, { condition: { op: 'gt', threshold: 500 } }, { requestId: 'r' });
    expect(updated.groups).toHaveLength(0);
    expect(updated.version).toBe(3);
    const [inc] = await incidentsOf(w, rule._id);
    expect(inc).toMatchObject({ status: 'resolved', resolvedBy: { kind: 'auto', reason: 'rule_changed' } });
  });

  test('disabling closes live incidents, stops evaluation, and enabling schedules an immediate evaluation', async () => {
    const w = await makeWorld(mongo.uri);
    const { state, deps } = scriptedStores();
    state.series = [{ labels: {}, value: 99 }];
    const engine = w.engine(deps);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0 }), { requestId: 'r' });
    await engine.tick();
    const off = await w.svc.rules.update(w.scopeA, rule._id, { enabled: false }, { requestId: 'r' });
    expect(off.nextEvalAt).toBeNull();
    expect((await incidentsOf(w, rule._id))[0]).toMatchObject({ status: 'resolved', resolvedBy: { reason: 'rule_disabled' } });
    w.clock.advance(600);
    expect(await engine.tick()).toHaveLength(0);
    const on = await w.svc.rules.update(w.scopeA, rule._id, { enabled: true }, { requestId: 'r' });
    expect(on.nextEvalAt!.getTime()).toBe(w.clock.t);
    expect(await engine.tick()).toHaveLength(1);
  });

  test('deleting a rule closes its live incidents (history is kept)', async () => {
    const w = await makeWorld(mongo.uri);
    const { state, deps } = scriptedStores();
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0 }), { requestId: 'r' });
    state.series = [{ labels: {}, value: 99 }]; await w.engine(deps).tick();
    await w.svc.rules.remove(w.scopeA, rule._id, { requestId: 'r' });
    expect(await ruleCol(w.db).countDocuments({ _id: rule._id })).toBe(0);
    expect((await incidentsOf(w, rule._id))[0]).toMatchObject({ status: 'resolved', resolvedBy: { reason: 'rule_deleted' } });
  });

  test('a rule edited WHILE it is being evaluated discards that (stale) evaluation', async () => {
    const w = await makeWorld(mongo.uri);
    const { state, deps } = scriptedStores();
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0 }), { requestId: 'r' });
    state.series = [{ labels: {}, value: 99 }];
    state.hook = async () => { await w.svc.rules.update(w.scopeA, rule._id, { condition: { op: 'gt', threshold: 1000 } }, { requestId: 'r' }); };
    await w.engine(deps).tick();
    const r = await ruleOf(w, rule._id);
    expect(r.groups).toHaveLength(0); // the stale firing state was not written
    expect(r.condition.threshold).toBe(1000);
  });
});

describe('deduplication invariant (database-enforced)', () => {
  test('ten concurrent attempts to open the same rule+group yield exactly one live incident', async () => {
    const w = await makeWorld(mongo.uri);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w), { requestId: 'r' });
    const results = await Promise.all(Array.from({ length: 10 }, () => w.svc.incidents.open(rule, { key: '', labels: {} }, 99, w.clock.now())));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.incident._id)).size).toBe(1);
    expect(await w.db.c.incidents.countDocuments({ ruleId: rule._id, active: true })).toBe(1);
  });
  test('the unique index rejects a second live incident and allows a new one once the first is resolved; other groups and rules are independent', async () => {
    const w = await makeWorld(mongo.uri);
    const r1 = await w.svc.rules.create(w.scopeA, metricRule(w), { requestId: 'r' });
    const r2 = await w.svc.rules.create(w.scopeA, metricRule(w), { requestId: 'r' });
    const { incident } = await w.svc.incidents.open(r1, { key: 'service=a', labels: { service: 'a' } }, 1, w.clock.now());
    const dup = { ...incident, _id: crypto.randomUUID() };
    await expect(w.db.c.incidents.insertOne(dup)).rejects.toMatchObject({ code: 11000 });
    await w.svc.incidents.open(r1, { key: 'service=b', labels: { service: 'b' } }, 1, w.clock.now());
    await w.svc.incidents.open(r2, { key: 'service=a', labels: { service: 'a' } }, 1, w.clock.now());
    expect(await w.db.c.incidents.countDocuments({ active: true })).toBeGreaterThanOrEqual(3);
    await w.svc.incidents.resolve(w.scopeA, incident._id, undefined, { requestId: 'r' });
    await expect(w.db.c.incidents.insertOne({ ...dup, _id: crypto.randomUUID() })).resolves.toBeTruthy();
  });
});

describe('engine class is reusable', () => {
  test('constructing the engine does no work until tick() is called', async () => {
    const w = await makeWorld(mongo.uri);
    const { state, deps } = scriptedStores();
    await w.svc.rules.create(w.scopeA, metricRule(w), { requestId: 'r' });
    const e = new AlertEngine(w.db, deps, w.svc.incidents, { owner: 'x', now: () => w.clock.now() });
    expect(state.calls).toHaveLength(0);
    expect(e.metrics.ticks).toBe(0);
  });
});
