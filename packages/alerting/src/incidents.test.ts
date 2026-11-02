import { startTestMongo } from '@nexus/database/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ruleCol, type ActorScope } from './common.js';
import { IncidentService } from './incidents.js';
import { Notifier } from './notifier.js';
import { metricRule, makeWorld, scriptedStores, type World } from './testkit.js';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
beforeAll(async () => { mongo = await startTestMongo(); }, 240_000);
afterAll(async () => { await mongo?.stop(); });
const ctx = { requestId: 'req-1' };

async function incident(w: World, over: Record<string, unknown> = {}, scope: ActorScope = w.scopeA) {
  const rule = await w.svc.rules.create(scope, metricRule(w, { forSeconds: 0, ...over }), ctx);
  const { incident: inc } = await w.svc.incidents.open(rule, { key: '', labels: {} }, 99, w.clock.now());
  return { rule, inc };
}

describe('acknowledge, resolve, comment', () => {
  test('acknowledging records who and when, appears on the timeline and in the audit log; repeating it is a conflict', async () => {
    const w = await makeWorld(mongo.uri);
    const { inc } = await incident(w);
    const after = await w.svc.incidents.acknowledge(w.scopeA, inc._id, 'looking', ctx);
    expect(after).toMatchObject({ status: 'acknowledged', acknowledgedBy: w.userA, active: true });
    const { incident: full, actors } = await w.svc.incidents.get(w.scopeA, inc._id);
    expect(full.timeline.map((e) => e.type)).toEqual(['opened', 'acknowledged']);
    expect(full.timeline[1]).toMatchObject({ actorUserId: w.userA, message: 'Acknowledged: looking' });
    expect(actors.get(w.userA)).toBe('a');
    expect(await w.db.c.auditEvents.countDocuments({ action: 'incident.acknowledged', targetId: inc._id, actorUserId: w.userA })).toBe(1);
    await expect(w.svc.incidents.acknowledge(w.scopeA, inc._id, undefined, ctx)).rejects.toMatchObject({ status: 409 });
    expect(await w.db.c.auditEvents.countDocuments({ action: 'incident.acknowledged', targetId: inc._id })).toBe(1); // the refused attempt left no trace
  });

  test('resolving by hand closes the incident (still-active rule state is the engine\'s business), frees the dedup slot, and cannot be repeated; an acknowledged incident can be resolved', async () => {
    const w = await makeWorld(mongo.uri);
    const { rule, inc } = await incident(w);
    await w.svc.incidents.acknowledge(w.scopeA, inc._id, undefined, ctx);
    const done = await w.svc.incidents.resolve(w.scopeA, inc._id, 'fixed', ctx);
    expect(done).toMatchObject({ status: 'resolved', active: false, resolvedBy: { kind: 'user', userId: w.userA } });
    expect(done.timeline.map((e) => e.type)).toEqual(['opened', 'acknowledged', 'resolved']);
    await expect(w.svc.incidents.resolve(w.scopeA, inc._id, undefined, ctx)).rejects.toMatchObject({ status: 409 });
    await expect(w.svc.incidents.acknowledge(w.scopeA, inc._id, undefined, ctx)).rejects.toMatchObject({ status: 409 });
    expect((await w.svc.incidents.open(rule, { key: '', labels: {} }, 5, w.clock.now())).created).toBe(true); // a new live incident is possible again
    expect(await w.db.c.auditEvents.countDocuments({ action: 'incident.resolved', targetId: inc._id })).toBe(1);
  });

  test('comments are appended with their author, allowed after resolution, bounded in number, and their text is not copied into the audit trail', async () => {
    const w = await makeWorld(mongo.uri);
    const { inc } = await incident(w);
    await w.svc.incidents.comment(w.scopeA, inc._id, 'password is hunter2 (oops)', ctx);
    await w.svc.incidents.resolve(w.scopeA, inc._id, undefined, ctx);
    const c = await w.svc.incidents.comment(w.scopeA, inc._id, 'post-mortem: bad deploy', ctx);
    expect(c.commentCount).toBe(2);
    const { incident: full } = await w.svc.incidents.get(w.scopeA, inc._id);
    expect(full.timeline.filter((e) => e.type === 'comment').map((e) => e.message)).toEqual(['password is hunter2 (oops)', 'post-mortem: bad deploy']);
    expect(JSON.stringify(await w.db.c.auditEvents.find({ action: 'incident.commented' }).toArray())).not.toContain('hunter2');
    const w2 = await makeWorld(mongo.uri);
    const { inc: i2 } = await incident(w2);
    for (let n = 0; n < 100; n++) await w2.svc.incidents.comment(w2.scopeA, i2._id, `c${n}`, ctx);
    await expect(w2.svc.incidents.comment(w2.scopeA, i2._id, 'one too many', ctx)).rejects.toMatchObject({ status: 422, code: 'comment_limit' });
  }, 120_000);

  test('the timeline is bounded: the newest events are kept', async () => {
    const w = await makeWorld(mongo.uri);
    const small = new IncidentService(w.db, w.audit, new Notifier(w.db), { maxTimeline: 4, now: () => w.clock.now() });
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0 }), ctx);
    const { incident: inc } = await small.open(rule, { key: '', labels: {} }, 1, w.clock.now());
    for (let i = 0; i < 6; i++) await small.comment(w.scopeA, inc._id, `n${i}`, ctx);
    const { incident } = await small.get(w.scopeA, inc._id);
    expect(incident.timeline.map((e) => e.message)).toEqual(['n2', 'n3', 'n4', 'n5']);
    expect(incident.eventCount).toBe(7);
  });
});

describe('listing and pagination', () => {
  test('keyset pagination returns every incident exactly once, newest first, with filters', async () => {
    const w = await makeWorld(mongo.uri);
    const rules = [];
    for (let i = 0; i < 3; i++) rules.push(await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0, severity: i === 0 ? 'warning' : 'critical' }), ctx));
    for (let i = 0; i < 9; i++) { w.clock.advance(1); await w.svc.incidents.open(rules[i % 3]!, { key: `g${i}`, labels: { g: String(i) } }, 1, w.clock.now()); }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const p = await w.svc.incidents.list(w.scopeA, { limit: 4, cursor });
      expect(p.items.length).toBeLessThanOrEqual(4);
      seen.push(...p.items.map((i) => i._id));
      cursor = p.nextCursor ?? undefined; pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(new Set(seen).size).toBe(9);
    const all = await w.db.c.incidents.find({ projectId: w.projA }).sort({ openedAt: -1, _id: -1 }).toArray();
    expect(seen).toEqual(all.map((i) => i._id));
    expect((await w.svc.incidents.list(w.scopeA, { limit: 50, severity: 'warning' })).items).toHaveLength(3);
    expect((await w.svc.incidents.list(w.scopeA, { limit: 50, ruleId: rules[1]!._id })).items).toHaveLength(3);
    await w.svc.incidents.resolve(w.scopeA, seen[0]!, undefined, ctx);
    expect((await w.svc.incidents.list(w.scopeA, { limit: 50, status: 'active' })).items).toHaveLength(8);
    expect((await w.svc.incidents.list(w.scopeA, { limit: 50, status: 'resolved' })).items).toHaveLength(1);
    expect((await w.svc.incidents.list(w.scopeA, { limit: 50, cursor: 'not-a-cursor' })).items).toHaveLength(9); // a bad cursor is ignored, never an injection vector
    // the list does not ship timelines
    expect((await w.svc.incidents.list(w.scopeA, { limit: 1 })).items[0]).not.toHaveProperty('timeline', expect.anything());
  });

  test('list and rule queries use their indexes (no collection scans)', async () => {
    const w = await makeWorld(mongo.uri);
    await incident(w);
    const plan = async (p: Promise<any>) => JSON.stringify((await p).queryPlanner.winningPlan); // the chosen plan only (rejected candidates may sort)
    const a = await plan(w.db.c.incidents.find({ orgId: w.orgA, projectId: w.projA }).sort({ openedAt: -1, _id: -1 }).explain('queryPlanner'));
    const b = await plan(w.db.c.incidents.find({ orgId: w.orgA, projectId: w.projA, status: 'open' }).sort({ openedAt: -1, _id: -1 }).explain('queryPlanner'));
    const c = await plan(w.db.c.alertConfig.find({ orgId: w.orgA, projectId: w.projA, kind: 'rule' } as never).sort({ createdAt: -1, _id: -1 }).explain('queryPlanner'));
    for (const p of [a, b, c]) { expect(p).not.toContain('COLLSCAN'); expect(p).not.toContain('"SORT"'); }
    expect(a).toContain('inc_scope_opened'); expect(b).toContain('inc_scope_status'); expect(c).toContain('acfg_scope_kind');
  });
});

describe('tenant isolation: project B can never read, acknowledge, resolve, comment on or notify about project A', () => {
  test('incidents of another organization/project are invisible and immutable (404, never 403, and nothing changes)', async () => {
    const w = await makeWorld(mongo.uri);
    const { inc } = await incident(w);
    const ch = await w.svc.channels.create(w.scopeA, { name: 'c', url: 'https://hooks.example.com/x', signingSecret: 'x'.repeat(20), enabled: true, rateLimitPerMinute: 5 }, ctx);
    for (const op of [
      () => w.svc.incidents.get(w.scopeB, inc._id), () => w.svc.incidents.acknowledge(w.scopeB, inc._id, undefined, ctx), () => w.svc.incidents.resolve(w.scopeB, inc._id, undefined, ctx),
      () => w.svc.incidents.comment(w.scopeB, inc._id, 'hi', ctx), () => w.svc.incidents.deliveries(w.scopeB, inc._id),
    ]) await expect(op()).rejects.toMatchObject({ status: 404 });
    // same org, different project
    const sameOtherProject: ActorScope = { ...w.scopeA, projectId: w.projB };
    await expect(w.svc.incidents.get(sameOtherProject, inc._id)).rejects.toMatchObject({ status: 404 });
    // and a scope with the right project but the wrong organization
    await expect(w.svc.incidents.acknowledge({ ...w.scopeA, orgId: w.orgB }, inc._id, undefined, ctx)).rejects.toMatchObject({ status: 404 });
    expect((await w.svc.incidents.list(w.scopeB, { limit: 50 })).items).toHaveLength(0);
    expect(await w.db.c.incidents.findOne({ _id: inc._id })).toMatchObject({ status: 'open', acknowledgedBy: null, commentCount: 0 });
    expect(await w.db.c.auditEvents.countDocuments({ targetId: inc._id, action: { $in: ['incident.acknowledged', 'incident.resolved', 'incident.commented'] } })).toBe(0);

    await expect(w.svc.channels.get(w.scopeB, ch._id)).rejects.toMatchObject({ status: 404 });
    await expect(w.svc.channels.update(w.scopeB, ch._id, { enabled: false }, ctx)).rejects.toMatchObject({ status: 404 });
    await expect(w.svc.channels.test(w.scopeB, ch._id, ctx)).rejects.toMatchObject({ status: 404 });
    await expect(w.svc.channels.remove(w.scopeB, ch._id, ctx)).rejects.toMatchObject({ status: 404 });
    expect(w.sent).toHaveLength(0); // no notification was ever sent on B's behalf
    expect((await w.svc.channels.list(w.scopeB, { limit: 50 })).items).toHaveLength(0);
    expect(await w.secrets.has({ orgId: w.orgA, connectionId: `alert-channel:${ch._id}`, name: 'signing' })).toBe(true);
  });

  test('rules: B cannot read, edit, delete or list A\'s rules; cannot create rules in A\'s environments or attach A\'s channels', async () => {
    const w = await makeWorld(mongo.uri);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w), ctx);
    const chA = await w.svc.channels.create(w.scopeA, { name: 'c', url: 'https://hooks.example.com/x', signingSecret: 'x'.repeat(20), enabled: true, rateLimitPerMinute: 5 }, ctx);
    await expect(w.svc.rules.get(w.scopeB, rule._id)).rejects.toMatchObject({ status: 404 });
    await expect(w.svc.rules.update(w.scopeB, rule._id, { enabled: false }, ctx)).rejects.toMatchObject({ status: 404 });
    await expect(w.svc.rules.remove(w.scopeB, rule._id, ctx)).rejects.toMatchObject({ status: 404 });
    expect((await w.svc.rules.list(w.scopeB, { limit: 50 })).items).toHaveLength(0);
    await expect(w.svc.rules.create(w.scopeB, metricRule(w, { environmentId: w.envA }), ctx)).rejects.toMatchObject({ status: 404 }); // A's environment
    await expect(w.svc.rules.create(w.scopeB, metricRule({ envA: w.envB }, { channelIds: [chA._id] }), ctx)).rejects.toMatchObject({ status: 422 }); // A's channel
    await expect(w.svc.silences.create(w.scopeB, { comment: 'x', startsAt: w.clock.now().toISOString(), endsAt: new Date(w.clock.t + 3600_000).toISOString(), matchers: { ruleIds: [rule._id] } }, ctx)).rejects.toMatchObject({ status: 422 });
    expect(await ruleCol(w.db).findOne({ _id: rule._id })).toMatchObject({ enabled: true, version: 1 });
  });

  test('every rule is evaluated strictly inside its own tenant even when two tenants own identical rules', async () => {
    const w = await makeWorld(mongo.uri);
    const { state, deps } = scriptedStores();
    state.series = [{ labels: {}, value: 99 }];
    const ra = await w.svc.rules.create(w.scopeA, metricRule(w, { name: 'same-name', forSeconds: 0 }), ctx);
    const rb = await w.svc.rules.create(w.scopeB, metricRule({ envA: w.envB }, { name: 'same-name', forSeconds: 0 }), ctx);
    await w.engine(deps).tick();
    const scopes = state.calls.map((c) => JSON.stringify((c.scope as { orgId: string; projectId: string; environmentIds: string[] })));
    expect(new Set(scopes)).toEqual(new Set([
      JSON.stringify({ orgId: w.orgA, projectId: w.projA, environmentIds: [w.envA] }),
      JSON.stringify({ orgId: w.orgB, projectId: w.projB, environmentIds: [w.envB] }),
    ]));
    const ia = await w.db.c.incidents.findOne({ ruleId: ra._id }), ib = await w.db.c.incidents.findOne({ ruleId: rb._id });
    expect([ia!.orgId, ia!.projectId, ib!.orgId, ib!.projectId]).toEqual([w.orgA, w.projA, w.orgB, w.projB]);
  });

  test('environment-restricted callers see and change only incidents and rules of their environments', async () => {
    const w = await makeWorld(mongo.uri);
    const onlyDev: ActorScope = { ...w.scopeA, environmentIds: [w.envA] };
    const { inc: devInc } = await incident(w);
    const { inc: prodInc } = await incident(w, { environmentId: w.envA2 });
    const prodRule = (await w.db.c.incidents.findOne({ _id: prodInc._id }))!.ruleId;
    expect((await w.svc.incidents.list(onlyDev, { limit: 50 })).items.map((i) => i._id)).toEqual([devInc._id]);
    expect((await w.svc.incidents.list(onlyDev, { limit: 50, environmentId: w.envA2 })).items).toHaveLength(0);
    await expect(w.svc.incidents.get(onlyDev, prodInc._id)).rejects.toMatchObject({ status: 404 });
    await expect(w.svc.incidents.acknowledge(onlyDev, prodInc._id, undefined, ctx)).rejects.toMatchObject({ status: 404 });
    await expect(w.svc.incidents.resolve(onlyDev, prodInc._id, undefined, ctx)).rejects.toMatchObject({ status: 404 });
    await expect(w.svc.incidents.comment(onlyDev, prodInc._id, 'x', ctx)).rejects.toMatchObject({ status: 404 });
    await expect(w.svc.rules.get(onlyDev, prodRule)).rejects.toMatchObject({ status: 404 });
    await expect(w.svc.rules.update(onlyDev, prodRule, { enabled: false }, ctx)).rejects.toMatchObject({ status: 404 });
    await expect(w.svc.rules.create(onlyDev, metricRule(w, { environmentId: w.envA2 }), ctx)).rejects.toMatchObject({ status: 404 });
    expect((await w.svc.rules.list(onlyDev, { limit: 50 })).items.every((r) => r.environmentId === w.envA)).toBe(true);
    expect(await w.svc.incidents.acknowledge(onlyDev, devInc._id, undefined, ctx)).toMatchObject({ status: 'acknowledged' });
  });
});

describe('quotas and validation in the service layer', () => {
  test('a project holds at most 100 rules (atomic quota); names are unique; invalid cross-field combinations are refused', async () => {
    const w = await makeWorld(mongo.uri);
    for (let i = 0; i < 100; i++) await w.svc.rules.create(w.scopeA, metricRule(w, { name: `r-${i}`, enabled: false }), ctx);
    await expect(w.svc.rules.create(w.scopeA, metricRule(w, { name: 'r-100' }), ctx)).rejects.toMatchObject({ status: 422, code: 'limit_reached' });
    await expect(w.svc.rules.create(w.scopeA, metricRule(w, { name: 'R-5' }), ctx)).rejects.toMatchObject({ status: 422 }); // quota is checked first inside the transaction
    expect(await w.db.c.alertConfig.countDocuments({ kind: 'rule', projectId: w.projA })).toBe(100);
    // another project is unaffected
    await expect(w.svc.rules.create(w.scopeB, metricRule({ envA: w.envB }, { name: 'r-0' }), ctx)).resolves.toBeTruthy();
    // deleting frees a slot
    const first = (await w.svc.rules.list(w.scopeA, { limit: 1 })).items[0]!;
    await w.svc.rules.remove(w.scopeA, first._id, ctx);
    await expect(w.svc.rules.create(w.scopeA, metricRule(w, { name: 'r-100' }), ctx)).resolves.toBeTruthy();
    await expect(w.svc.rules.create(w.scopeA, metricRule(w, { name: 'r-7' }), ctx)).rejects.toMatchObject({ status: 422 });
  }, 240_000);

  test('duplicate rule names conflict with 409 and an update cannot move a rule to another environment', async () => {
    const w = await makeWorld(mongo.uri);
    await w.svc.rules.create(w.scopeA, metricRule(w, { name: 'Dup' }), ctx);
    await expect(w.svc.rules.create(w.scopeA, metricRule(w, { name: 'dup' }), ctx)).rejects.toMatchObject({ status: 409 });
    const r = await w.svc.rules.create(w.scopeA, metricRule(w, { name: 'mover' }), ctx);
    await expect(w.svc.rules.update(w.scopeA, r._id, { environmentId: w.envA2 }, ctx)).rejects.toMatchObject({ status: 422 });
    await expect(w.svc.rules.update(w.scopeA, r._id, { name: 'DUP' }, ctx)).rejects.toMatchObject({ status: 409 });
    await expect(w.svc.rules.update(w.scopeA, r._id, { query: { kind: 'logs', filters: [] }, condition: { op: 'gt', threshold: 1.5 } }, ctx)).rejects.toMatchObject({ status: 422 });
  });

  test('rule creation, update and deletion are audited with the actor', async () => {
    const w = await makeWorld(mongo.uri);
    const r = await w.svc.rules.create(w.scopeA, metricRule(w), ctx);
    await w.svc.rules.update(w.scopeA, r._id, { severity: 'info' }, ctx);
    await w.svc.rules.remove(w.scopeA, r._id, ctx);
    const events = await w.db.c.auditEvents.find({ projectId: w.projA, targetId: r._id }).sort({ seq: 1 }).toArray();
    expect(events.map((e) => [e.action, e.actorUserId])).toEqual([['alert.rule.created', w.userA], ['alert.rule.updated', w.userA], ['alert.rule.deleted', w.userA]]);
  });
});
