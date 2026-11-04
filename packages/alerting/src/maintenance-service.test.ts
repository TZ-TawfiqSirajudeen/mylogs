import { startTestMongo } from '@nexus/database/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { maintenanceCol, toMaintenanceDto } from './maintenance.js';
import { metricRule, makeWorld, scriptedStores, type World } from './testkit.js';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
beforeAll(async () => { mongo = await startTestMongo(); }, 240_000);
afterAll(async () => { await mongo?.stop(); });

const ctx = { requestId: 'req-1' };
const weekly = (over: Record<string, unknown> = {}) => ({ type: 'weekly' as const, timezone: 'Europe/Berlin', weekdays: ['sun' as const], startTime: '02:00', durationMinutes: 120, ...over });
const once = (w: World, fromSec: number, toSec: number) => ({ type: 'once' as const, startsAt: new Date(w.clock.t + fromSec * 1000).toISOString(), endsAt: new Date(w.clock.t + toSec * 1000).toISOString() });
const create = (w: World, over: Record<string, unknown> = {}) => w.svc.maintenance.create(w.scopeA, { name: `win-${Math.random().toString(36).slice(2, 8)}`, comment: '', enabled: true, matchers: {}, schedule: weekly(), ...over } as never, ctx);
const channel = (w: World) => w.svc.channels.create(w.scopeA, { name: 'hook', url: 'https://hooks.example.com/x', signingSecret: 'whsec_super-secret-signing-value-123', enabled: true, rateLimitPerMinute: 60 }, ctx);

describe('configuration: create, read, edit, delete', () => {
  test('creates recurring and one-off windows, lists them, edits with optimistic locking, deletes, and audits every change', async () => {
    const w = await makeWorld(mongo.uri);
    const a = await create(w, { name: 'Weekly deploy', comment: 'Sunday release', schedule: weekly({ weekdays: ['sun', 'sat'] }) });
    const b = await create(w, { name: 'One-off', schedule: once(w, 60, 3600) });
    expect(a).toMatchObject({ kind: 'maintenance', version: 1, enabled: true, schedule: { type: 'weekly', timezone: 'Europe/Berlin' } });
    expect(a.expireAt).toBeUndefined();                                   // recurring windows never expire
    expect(b.expireAt).toEqual(new Date(w.clock.t + 3600_000 + 86_400_000)); // one-off windows are removed a day after they end

    const page = await w.svc.maintenance.list(w.scopeA, { limit: 10 });
    expect(page.items.map((x) => x.name).sort()).toEqual(['One-off', 'Weekly deploy']);
    expect((await w.svc.maintenance.get(w.scopeA, a._id)).name).toBe('Weekly deploy');

    const upd = await w.svc.maintenance.update(w.scopeA, a._id, { comment: 'Sunday and Saturday release', enabled: false }, ctx);
    expect(upd).toMatchObject({ version: 2, enabled: false, comment: 'Sunday and Saturday release' });
    // changing a recurring window into a one-off one adds the TTL field; back again removes it
    const toOnce = await w.svc.maintenance.update(w.scopeA, a._id, { schedule: once(w, 10, 100) }, ctx);
    expect(toOnce.expireAt).toBeInstanceOf(Date);
    const back = await w.svc.maintenance.update(w.scopeA, a._id, { schedule: weekly() }, ctx);
    expect(back.expireAt).toBeUndefined();
    expect(back.version).toBe(4);

    await w.svc.maintenance.remove(w.scopeA, b._id, ctx);
    await expect(w.svc.maintenance.get(w.scopeA, b._id)).rejects.toMatchObject({ status: 404 });
    await expect(w.svc.maintenance.remove(w.scopeA, b._id, ctx)).rejects.toMatchObject({ status: 404 });

    const audit = await w.db.c.auditEvents.find({ projectId: w.projA, action: /^alert\.maintenance\./ }).sort({ seq: 1 }).toArray();
    expect(audit.map((e) => e.action)).toEqual(['alert.maintenance.created', 'alert.maintenance.created', 'alert.maintenance.updated', 'alert.maintenance.updated', 'alert.maintenance.updated', 'alert.maintenance.deleted']);
    expect(audit[2]!.metadata).toEqual({ name: 'Weekly deploy', fields: ['comment', 'enabled'] });
    expect(audit[0]).toMatchObject({ actorUserId: w.userA, targetType: 'alert_maintenance', targetId: a._id });
  });

  test('a stale edit is a 409 and changes nothing', async () => {
    const w = await makeWorld(mongo.uri);
    const a = await create(w);
    const res = await Promise.allSettled([w.svc.maintenance.update(w.scopeA, a._id, { comment: 'one' }, ctx), w.svc.maintenance.update(w.scopeA, a._id, { comment: 'two' }, ctx)]);
    expect(res.filter((r) => r.status === 'fulfilled')).toHaveLength(1); // exactly one of two concurrent edits wins
    expect(res.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason.status)).toEqual([409]);
    expect((await w.svc.maintenance.get(w.scopeA, a._id)).version).toBe(2);
  });

  test('names are unique per project (case-insensitive) but may repeat across projects', async () => {
    const w = await makeWorld(mongo.uri);
    await create(w, { name: 'Nightly' });
    await expect(create(w, { name: 'nightly' })).rejects.toMatchObject({ status: 409 });
    await expect(w.svc.maintenance.create(w.scopeB, { name: 'Nightly', comment: '', enabled: true, matchers: {}, schedule: weekly() } as never, ctx)).resolves.toBeTruthy();
    const other = await create(w, { name: 'Other' });
    await expect(w.svc.maintenance.update(w.scopeA, other._id, { name: 'NIGHTLY' }, ctx)).rejects.toMatchObject({ status: 409 });
  });

  test('validation is enforced by the service too: unknown zone, bad time, past one-off, foreign rules and environments', async () => {
    const w = await makeWorld(mongo.uri);
    await expect(create(w, { schedule: weekly({ timezone: 'Mars/Olympus' }) })).rejects.toMatchObject({ status: 422 });
    await expect(create(w, { schedule: weekly({ startTime: '25:61' }) })).rejects.toMatchObject({ status: 422 });
    await expect(create(w, { schedule: weekly({ durationMinutes: 5000 }) })).rejects.toMatchObject({ status: 422 });
    await expect(create(w, { schedule: once(w, -7200, -3600) })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/future/) });
    await expect(create(w, { schedule: once(w, 100, 50) })).rejects.toMatchObject({ status: 422 });
    await expect(create(w, { matchers: { ruleIds: [crypto.randomUUID()] } })).rejects.toMatchObject({ status: 422 });
    await expect(create(w, { matchers: { environmentIds: [w.envB] } })).rejects.toMatchObject({ status: 422 });   // another project's environment
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w), ctx);
    await expect(create(w, { matchers: { ruleIds: [rule._id], environmentIds: [w.envA], severities: ['critical'] } })).resolves.toBeTruthy();
    expect(await maintenanceCol(w.db).countDocuments({ kind: 'maintenance', projectId: w.projA })).toBe(1); // none of the refused ones was stored
  });

  test('a project holds at most 20 windows; deleting frees a place; finished one-off windows do not count', async () => {
    const w = await makeWorld(mongo.uri);
    for (let i = 0; i < 20; i++) await create(w, { name: `w${i}` });
    await expect(create(w, { name: 'one too many' })).rejects.toMatchObject({ status: 422, code: 'limit_reached' });
    const list = await w.svc.maintenance.list(w.scopeA, { limit: 100 });
    await w.svc.maintenance.remove(w.scopeA, list.items[0]!._id, ctx);
    await expect(create(w, { name: 'fits now' })).resolves.toBeTruthy();
    await expect(create(w, { name: 'full again' })).rejects.toMatchObject({ code: 'limit_reached' });
    // another project is unaffected
    await expect(w.svc.maintenance.create(w.scopeB, { name: 'b', comment: '', enabled: true, matchers: {}, schedule: weekly() } as never, ctx)).resolves.toBeTruthy();
    // an expired one-off window (TTL not yet run) does not occupy a place
    const w2 = await makeWorld(mongo.uri);
    for (let i = 0; i < 19; i++) await create(w2, { name: `x${i}` });
    const old = await create(w2, { name: 'old once', schedule: once(w2, 10, 20) });
    await maintenanceCol(w2.db).updateOne({ _id: old._id }, { $set: { expireAt: new Date(w2.clock.t - 1000) } });
    await expect(create(w2, { name: 'replacement' })).resolves.toBeTruthy();
  });

  test('tenant isolation and scope: another project cannot read, edit or delete a window; environment-restricted callers cannot manage windows', async () => {
    const w = await makeWorld(mongo.uri);
    const a = await create(w);
    await expect(w.svc.maintenance.get(w.scopeB, a._id)).rejects.toMatchObject({ status: 404 });
    await expect(w.svc.maintenance.update(w.scopeB, a._id, { comment: 'hijack' }, ctx)).rejects.toMatchObject({ status: 404 });
    await expect(w.svc.maintenance.remove(w.scopeB, a._id, ctx)).rejects.toMatchObject({ status: 404 });
    expect((await w.svc.maintenance.list(w.scopeB, { limit: 10 })).items).toHaveLength(0);
    expect(await maintenanceCol(w.db).findOne({ _id: a._id })).toMatchObject({ comment: '' });
    const restricted = { ...w.scopeA, environmentIds: [w.envA] };
    await expect(w.svc.maintenance.create(restricted, { name: 'r', comment: '', enabled: true, matchers: {}, schedule: weekly() } as never, ctx)).rejects.toMatchObject({ status: 403 });
    await expect(w.svc.maintenance.update(restricted, a._id, { comment: 'x' }, ctx)).rejects.toMatchObject({ status: 403 });
    await expect(w.svc.maintenance.remove(restricted, a._id, ctx)).rejects.toMatchObject({ status: 403 });
  });
});

describe('effect on notifications (through the real incident path)', () => {
  const fire = async (w: World, channelIds: string[], ruleOver: Record<string, unknown> = {}) => {
    const { state, deps } = scriptedStores();
    state.series = [{ labels: {}, value: 99 }];
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0, channelIds, ...ruleOver }), ctx);
    await w.engine(deps).tick();
    const incident = (await w.db.c.incidents.findOne({ ruleId: rule._id }))!;
    const deliveries = await w.db.c.alertDeliveries.find({ incidentId: incident._id }).toArray();
    return { rule, incident, deliveries };
  };

  test('an active window suppresses the notification (recorded with the window id) but the incident is still opened', async () => {
    const w = await makeWorld(mongo.uri);
    const ch = await channel(w);
    const win = await create(w, { name: 'Now', schedule: once(w, -60, 3600) });
    const { incident, deliveries } = await fire(w, [ch._id]);
    expect(incident).toMatchObject({ status: 'open', active: true });
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ status: 'suppressed', maintenanceId: win._id, silenceId: null, nextAttemptAt: null });
    expect(incident.timeline.find((e) => e.type === 'notification_suppressed')).toMatchObject({ data: { reason: 'maintenance', maintenanceId: win._id, channelId: ch._id } });
    expect(await w.svc.delivery.tick()).toBe(0);
    expect(w.sent).toHaveLength(0);
    // the delivery API shape carries the window id
    const { toDeliveryDto } = await import('./config.js');
    expect(toDeliveryDto(deliveries[0]!)).toMatchObject({ status: 'suppressed', maintenanceId: win._id });
  });

  test('a recurring window in its time zone is active only inside its occurrence', async () => {
    const w = await makeWorld(mongo.uri);
    const ch = await channel(w);
    // the fake clock sits on some UTC instant; build a daily window around it in Asia/Kolkata (UTC+5:30)
    const local = new Date(w.clock.t + 5.5 * 3_600_000);
    const hh = String(local.getUTCHours()).padStart(2, '0'), mm = String(local.getUTCMinutes()).padStart(2, '0');
    const all = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
    await create(w, { name: 'around now', schedule: weekly({ timezone: 'Asia/Kolkata', weekdays: [...all], startTime: `${hh}:${mm}`, durationMinutes: 30 }) });
    const inside = await fire(w, [ch._id]);
    expect(inside.deliveries[0]).toMatchObject({ status: 'suppressed' });
    // a window that ended 5 minutes ago does not suppress
    const w2 = await makeWorld(mongo.uri);
    const ch2 = await channel(w2);
    const past = new Date(w2.clock.t + 5.5 * 3_600_000 - 35 * 60_000);
    await create(w2, { name: 'ended', schedule: weekly({ timezone: 'Asia/Kolkata', weekdays: [...all], startTime: `${String(past.getUTCHours()).padStart(2, '0')}:${String(past.getUTCMinutes()).padStart(2, '0')}`, durationMinutes: 30 }) });
    const outside = await fire(w2, [ch2._id]);
    expect(outside.deliveries[0]).toMatchObject({ status: 'pending' });
  });

  test('a disabled window, a non-matching window and a window of another project do not suppress', async () => {
    const w = await makeWorld(mongo.uri);
    const ch = await channel(w);
    await create(w, { name: 'disabled', enabled: false, schedule: once(w, -60, 3600) });
    await create(w, { name: 'other severity', matchers: { severities: ['info'] }, schedule: once(w, -60, 3600) });
    await create(w, { name: 'other env', matchers: { environmentIds: [w.envA2] }, schedule: once(w, -60, 3600) });
    await w.svc.maintenance.create(w.scopeB, { name: 'foreign', comment: '', enabled: true, matchers: {}, schedule: once(w, -60, 3600) } as never, ctx);
    const { deliveries } = await fire(w, [ch._id]);
    expect(deliveries[0]).toMatchObject({ status: 'pending', maintenanceId: null });
  });

  test('a matching rule id and severity suppress; deleting the window ends the suppression at once; a silence takes precedence in the record', async () => {
    const w = await makeWorld(mongo.uri);
    const ch = await channel(w);
    const r1 = await w.svc.rules.create(w.scopeA, metricRule(w, { name: 'scoped', forSeconds: 0, resolveAfterSeconds: 0, channelIds: [ch._id] }), ctx);
    const win = await create(w, { name: 'scoped window', matchers: { ruleIds: [r1._id], severities: ['critical'] }, schedule: once(w, -60, 3600) });
    const { state, deps } = scriptedStores(); state.series = [{ labels: {}, value: 99 }];
    const engine = w.engine(deps);
    await engine.tick();
    const inc = (await w.db.c.incidents.findOne({ ruleId: r1._id }))!;
    expect((await w.db.c.alertDeliveries.find({ incidentId: inc._id }).toArray())[0]).toMatchObject({ status: 'suppressed', maintenanceId: win._id });

    // resolve while the window is still on: the resolution notice goes only to channels told about the opening: none, so nothing is sent
    state.series = [{ labels: {}, value: 0 }];
    w.clock.advance(60); await engine.tick();
    expect((await w.db.c.incidents.findOne({ _id: inc._id }))!.status).toBe('resolved');
    expect(await w.db.c.alertDeliveries.countDocuments({ incidentId: inc._id, event: 'incident.resolved' })).toBe(0);

    // a silence and a window both match: the record names the silence
    await w.svc.silences.create(w.scopeA, { comment: 'planned', startsAt: new Date(w.clock.t - 1000).toISOString(), endsAt: new Date(w.clock.t + 3_600_000).toISOString(), matchers: {} }, ctx);
    state.series = [{ labels: {}, value: 99 }];
    w.clock.advance(60); await engine.tick();
    const second = (await w.db.c.incidents.find({ ruleId: r1._id }).sort({ openedAt: -1 }).limit(1).toArray())[0]!;
    expect((await w.db.c.alertDeliveries.find({ incidentId: second._id }).toArray())[0]).toMatchObject({ status: 'suppressed', silenceId: expect.any(String), maintenanceId: null });

    // end of the window: a new incident notifies again
    await w.svc.maintenance.remove(w.scopeA, win._id, ctx);
    const silences = await w.db.c.alertConfig.find({ kind: 'silence' }).toArray();
    for (const s of silences) await w.db.c.alertConfig.deleteOne({ _id: s._id });
    state.series = [{ labels: {}, value: 0 }]; w.clock.advance(60); await engine.tick();
    state.series = [{ labels: {}, value: 99 }]; w.clock.advance(60); await engine.tick();
    const third = (await w.db.c.incidents.find({ ruleId: r1._id }).sort({ openedAt: -1 }).limit(1).toArray())[0]!;
    expect(third._id).not.toBe(second._id);
    expect((await w.db.c.alertDeliveries.find({ incidentId: third._id }).toArray())[0]).toMatchObject({ status: 'pending' });
  });

  test('a stored window with a corrupt schedule never breaks notification planning (it simply does not match)', async () => {
    const w = await makeWorld(mongo.uri);
    const ch = await channel(w);
    const win = await create(w, { name: 'will be corrupted' });
    await maintenanceCol(w.db).updateOne({ _id: win._id }, { $set: { 'schedule.timezone': 'Not/AZone' } });
    const { deliveries, incident } = await fire(w, [ch._id]);
    expect(incident.active).toBe(true);
    expect(deliveries[0]).toMatchObject({ status: 'pending' });
    expect(toMaintenanceDto((await maintenanceCol(w.db).findOne({ _id: win._id }))!, w.clock.now())).toMatchObject({ state: 'disabled' });
  });
});
