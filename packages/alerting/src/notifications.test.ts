import { startTestMongo } from '@nexus/database/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { channelCol, ruleCol } from './common.js';
import { DeliveryProcessor, defaultBackoffMs } from './delivery.js';
import { metricRule, makeWorld, scriptedStores, type World } from './testkit.js';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
beforeAll(async () => { mongo = await startTestMongo(); }, 240_000);
afterAll(async () => { await mongo?.stop(); });

const SECRET = 'whsec_super-secret-signing-value-123';
const URL_WITH_TOKEN = 'https://hooks.example.com/services/T000/B000/XXXXTOKENXXXX';
const ctx = { requestId: 'req-1' };
const channel = (w: World, over: Record<string, unknown> = {}) =>
  w.svc.channels.create(w.scopeA, { name: `ch-${Math.random().toString(36).slice(2, 7)}`, url: URL_WITH_TOKEN, signingSecret: SECRET, enabled: true, rateLimitPerMinute: 20, ...over }, ctx);
const processor = (w: World, over: Record<string, unknown> = {}) =>
  new DeliveryProcessor(w.db, w.secrets, { owner: 'p1', policy: { allowLoopback: false, allowPrivateCidrs: [], allowInsecureHttp: true, resolver: async () => ['93.184.216.34'] }, now: () => w.clock.now(), sender: async (req) => { w.sent.push({ url: req.url, body: req.body, event: req.event, deliveryId: req.deliveryId }); return w.senderResult.current; }, ...over });

async function fireIncident(w: World, channelIds: string[], ruleOver: Record<string, unknown> = {}) {
  const { state, deps } = scriptedStores();
  state.series = [{ labels: {}, value: 99 }];
  const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0, channelIds, ...ruleOver }), ctx);
  await w.engine(deps).tick();
  const incident = (await w.db.c.incidents.findOne({ ruleId: rule._id }))!;
  return { rule, incident, state, deps };
}

describe('channels: secrets', () => {
  test('the URL and the signing secret are stored encrypted, never in the channel document, never returned, never audited', async () => {
    const w = await makeWorld(mongo.uri);
    const ch = await channel(w);
    // the API-facing shape
    const { toChannelDto } = await import('./channels.js');
    const dto = toChannelDto(ch);
    const wire = JSON.stringify(dto);
    expect(wire).not.toContain(SECRET); expect(wire).not.toContain('XXXXTOKENXXXX'); expect(wire).not.toContain('/services/');
    expect(dto).toMatchObject({ urlDisplay: 'https://hooks.example.com/…', hasSigningSecret: true });
    // the stored channel document
    const stored = JSON.stringify(await channelCol(w.db).findOne({ _id: ch._id }));
    expect(stored).not.toContain(SECRET); expect(stored).not.toContain('XXXXTOKENXXXX');
    // the secrets collection holds ciphertext only
    const rows = await w.db.c.secrets.find({ connectionId: `alert-channel:${ch._id}` }).toArray();
    expect(rows.map((r) => r.name).sort()).toEqual(['signing', 'url']);
    for (const r of rows) { const s = JSON.stringify(r); expect(s).not.toContain(SECRET); expect(s).not.toContain('XXXXTOKENXXXX'); expect(r.alg).toBe('AES-256-GCM/v1'); }
    // ...and decrypts for the right owner only
    expect(await w.secrets.get({ orgId: w.orgA, connectionId: `alert-channel:${ch._id}`, name: 'signing' })).toBe(SECRET);
    await expect(w.secrets.get({ orgId: w.orgB, connectionId: `alert-channel:${ch._id}`, name: 'signing' })).rejects.toThrow();
    // audit trail has the event, not the values
    const audit = JSON.stringify(await w.db.c.auditEvents.find({ projectId: w.projA }).toArray());
    expect(audit).toContain('alert.channel.created');
    expect(audit).not.toContain(SECRET); expect(audit).not.toContain('XXXXTOKENXXXX');
  });

  test('updating a channel rotates the secret and records only field names; deleting removes the secrets and detaches the channel from rules', async () => {
    const w = await makeWorld(mongo.uri);
    const ch = await channel(w);
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { channelIds: [ch._id] }), ctx);
    await w.svc.channels.update(w.scopeA, ch._id, { signingSecret: 'rotated-secret-value-456', rateLimitPerMinute: 5 }, ctx);
    expect(await w.secrets.get({ orgId: w.orgA, connectionId: `alert-channel:${ch._id}`, name: 'signing' })).toBe('rotated-secret-value-456');
    const upd = await w.db.c.auditEvents.findOne({ action: 'alert.channel.updated' });
    expect(upd!.metadata).toEqual({ fields: ['signingSecret', 'rateLimitPerMinute'] });
    await w.svc.channels.remove(w.scopeA, ch._id, ctx);
    expect(await w.db.c.secrets.countDocuments({ connectionId: `alert-channel:${ch._id}` })).toBe(0);
    expect((await ruleCol(w.db).findOne({ _id: rule._id }))!.channelIds).toEqual([]);
  });

  test('channel URLs are validated when saved: private addresses and plain http (in production policy) are refused', async () => {
    const w = await makeWorld(mongo.uri, { allowLoopback: false, allowPrivateCidrs: [], allowInsecureHttp: false, resolver: async (h) => (h === 'internal.example.com' ? ['10.0.0.5'] : ['93.184.216.34']) });
    await expect(channel(w, { url: 'http://hooks.example.com/x' })).rejects.toMatchObject({ status: 422 });
    await expect(channel(w, { url: 'https://internal.example.com/x' })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/not permitted/) });
    await expect(channel(w, { url: 'https://169.254.169.254/latest' })).rejects.toMatchObject({ status: 422 });
    await expect(channel(w, { url: 'https://localhost/x' })).rejects.toMatchObject({ status: 422 });
    await expect(channel(w, { url: 'https://hooks.example.com/ok' })).resolves.toBeTruthy();
  });

  test('a project holds at most 10 channels (atomic quota) and channel names are unique', async () => {
    const w = await makeWorld(mongo.uri);
    for (let i = 0; i < 9; i++) await channel(w, { name: `q-${i}` });
    await expect(channel(w, { name: 'Q-3' })).rejects.toMatchObject({ status: 409 }); // names are unique case-insensitively
    await channel(w, { name: 'q-9' });
    await expect(channel(w, { name: 'q-10' })).rejects.toMatchObject({ status: 422, code: 'limit_reached' });
    expect(await w.db.c.alertConfig.countDocuments({ kind: 'channel', projectId: w.projA })).toBe(10); // the refused creations left nothing behind
    expect((await w.db.c.counters.findOne({ _id: `alerting:channels:${w.orgA}:${w.projA}` }))!.value).toBe(10);
  });

  test('environment-restricted callers cannot manage channels or silences', async () => {
    const w = await makeWorld(mongo.uri);
    const restricted = { ...w.scopeA, environmentIds: [w.envA] };
    await expect(channel(w, {})).resolves.toBeTruthy();
    await expect(w.svc.channels.create(restricted, { name: 'x', url: URL_WITH_TOKEN, signingSecret: SECRET, enabled: true, rateLimitPerMinute: 5 }, ctx)).rejects.toMatchObject({ status: 403 });
    await expect(w.svc.silences.create(restricted, { comment: 'x', startsAt: w.clock.now().toISOString(), endsAt: new Date(w.clock.t + 3600_000).toISOString(), matchers: {} }, ctx)).rejects.toMatchObject({ status: 403 });
  });
});

describe('test send', () => {
  test('sends one signed test notification through the same code path, records it, and never retries', async () => {
    const w = await makeWorld(mongo.uri);
    const ch = await channel(w);
    const r = await w.svc.channels.test(w.scopeA, ch._id, ctx);
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0]).toMatchObject({ url: URL_WITH_TOKEN, event: 'test' });
    expect(JSON.parse(w.sent[0]!.body)).toMatchObject({ event: 'test' });
    expect((await channelCol(w.db).findOne({ _id: ch._id }))!.lastTest).toMatchObject({ ok: true });
    w.senderResult.current = { ok: false, httpStatus: 503, code: 'http_server_error', message: 'The receiver failed (HTTP 503)', retryable: true };
    const bad = await w.svc.channels.test(w.scopeA, ch._id, ctx);
    expect(bad).toMatchObject({ ok: false, status: 503 });
    expect(bad.delivery).toMatchObject({ status: 'failed', attempts: 1, nextAttemptAt: null }); // a test is a single attempt
    w.senderResult.current = { ok: true, httpStatus: 200, code: null, message: 'Delivered (HTTP 200)', retryable: false };
  });

  test('is limited to 5 per minute per channel', async () => {
    const w = await makeWorld(mongo.uri);
    const ch = await channel(w);
    for (let i = 0; i < 5; i++) await w.svc.channels.test(w.scopeA, ch._id, ctx);
    await expect(w.svc.channels.test(w.scopeA, ch._id, ctx)).rejects.toMatchObject({ status: 429 });
    w.clock.advance(61);
    await expect(w.svc.channels.test(w.scopeA, ch._id, ctx)).resolves.toBeTruthy();
  });
});

describe('notifications for incidents', () => {
  test('opening queues one delivery per enabled channel; the sender posts a bounded payload; the timeline records "notified"', async () => {
    const w = await makeWorld(mongo.uri);
    const a = await channel(w, { name: 'a' }), b = await channel(w, { name: 'b' }), off = await channel(w, { name: 'off', enabled: false });
    const { incident } = await fireIncident(w, [a._id, b._id, off._id]);
    const queued = await w.db.c.alertDeliveries.find({ incidentId: incident._id }).toArray();
    expect(queued.map((d) => [d.channelName, d.status, d.event]).sort()).toEqual([['a', 'pending', 'incident.opened'], ['b', 'pending', 'incident.opened']]);
    const p = processor(w);
    expect(await p.tick()).toBe(2);
    expect(w.sent).toHaveLength(2);
    const body = JSON.parse(w.sent[0]!.body);
    expect(body).toMatchObject({ event: 'incident.opened', incident: { id: incident._id, severity: 'critical', environmentId: w.envA, status: 'open' } });
    expect(JSON.stringify(body)).not.toContain(SECRET);
    const after = (await w.db.c.incidents.findOne({ _id: incident._id }))!;
    expect(after.timeline.filter((e) => e.type === 'notified')).toHaveLength(2);
    expect((await w.db.c.alertDeliveries.find({ incidentId: incident._id }).toArray()).every((d) => d.status === 'delivered' && d.attempts === 1)).toBe(true);
  });

  test('retries with backoff, then fails for good and says so on the timeline; non-retryable errors fail at once', async () => {
    const w = await makeWorld(mongo.uri);
    const ch = await channel(w);
    const { incident } = await fireIncident(w, [ch._id]);
    w.senderResult.current = { ok: false, httpStatus: 503, code: 'http_server_error', message: 'The receiver failed (HTTP 503)', retryable: true };
    const p = processor(w, { backoffMs: (n: number) => n * 60_000, maxAttempts: 3 });
    await p.tick();
    let d = (await w.db.c.alertDeliveries.findOne({ incidentId: incident._id }))!;
    expect(d).toMatchObject({ status: 'pending', attempts: 1, lastError: { code: 'http_server_error' } });
    expect(d.nextAttemptAt!.getTime()).toBe(w.clock.t + 60_000);
    expect(await p.tick()).toBe(0); // not due yet
    w.clock.advance(61); await p.tick();
    d = (await w.db.c.alertDeliveries.findOne({ incidentId: incident._id }))!;
    expect(d).toMatchObject({ status: 'pending', attempts: 2 });
    expect(d.nextAttemptAt!.getTime()).toBe(w.clock.t + 120_000);
    w.clock.advance(121); await p.tick();
    d = (await w.db.c.alertDeliveries.findOne({ incidentId: incident._id }))!;
    expect(d).toMatchObject({ status: 'failed', attempts: 3, nextAttemptAt: null });
    const inc = (await w.db.c.incidents.findOne({ _id: incident._id }))!;
    expect(inc.timeline.at(-1)).toMatchObject({ type: 'notification_failed' });
    expect(inc.timeline.at(-1)!.message).toMatch(/after 3 attempts/);
    expect(JSON.stringify(inc.timeline)).not.toContain('XXXXTOKENXXXX');

    const ch2 = await channel(w, { name: 'perm' });
    const f = await fireIncident(w, [ch2._id]);
    w.senderResult.current = { ok: false, httpStatus: 400, code: 'http_client_error', message: 'The receiver rejected the notification (HTTP 400)', retryable: false };
    await processor(w).tick();
    expect((await w.db.c.alertDeliveries.findOne({ incidentId: f.incident._id, channelId: ch2._id }))).toMatchObject({ status: 'failed', attempts: 1 });
    w.senderResult.current = { ok: true, httpStatus: 200, code: null, message: 'Delivered (HTTP 200)', retryable: false };
  });

  test('default backoff grows and is capped', () => {
    const d = [1, 2, 3, 4, 5, 9].map((n) => defaultBackoffMs(n, () => 0));
    expect(d).toEqual([30_000, 120_000, 600_000, 1_800_000, 1_800_000, 1_800_000]);
    expect(defaultBackoffMs(1, () => 1)).toBe(36_000);
  });

  test('two processors never send the same delivery twice (lease), and a crashed sender\'s lease expires', async () => {
    const w = await makeWorld(mongo.uri);
    const ch = await channel(w);
    await fireIncident(w, [ch._id]);
    const slow = (owner: string) => processor(w, { owner, sender: async (req: { url: string; body: string; event: string; deliveryId: string }) => { await new Promise((r) => setTimeout(r, 50)); w.sent.push({ url: req.url, body: req.body, event: req.event, deliveryId: req.deliveryId }); return w.senderResult.current; } });
    await Promise.all([slow('p1').tick(), slow('p2').tick(), slow('p3').tick()]);
    expect(w.sent).toHaveLength(1);
    const ch2 = await channel(w, { name: 'crash' });
    const f = await fireIncident(w, [ch2._id]);
    await w.db.c.alertDeliveries.updateOne({ incidentId: f.incident._id }, { $set: { lease: { owner: 'dead', until: new Date(w.clock.t + 30_000) } } });
    const before = w.sent.length;
    expect(await processor(w).tick()).toBe(0);
    w.clock.advance(31);
    expect(await processor(w).tick()).toBe(1);
    expect(w.sent.length).toBe(before + 1);
  });

  test('resolving notifies only the channels that heard about the opening; manual and automatic resolution both notify', async () => {
    const w = await makeWorld(mongo.uri);
    const ch = await channel(w, { name: 'heard' });
    const { incident } = await fireIncident(w, [ch._id], { resolveAfterSeconds: 0 });
    await processor(w).tick();
    w.sent.length = 0;
    await w.svc.incidents.resolve(w.scopeA, incident._id, 'done', ctx);
    expect(await processor(w).tick()).toBe(1);
    expect(JSON.parse(w.sent[0]!.body)).toMatchObject({ event: 'incident.resolved', incident: { status: 'resolved', resolvedBy: 'user' } });
  });

  test('a channel rate limit stops a notification storm: excess deliveries are recorded as rate_limited and not sent', async () => {
    const w = await makeWorld(mongo.uri);
    const ch = await channel(w, { rateLimitPerMinute: 2 });
    const { state, deps } = scriptedStores();
    state.series = [{ labels: {}, value: 99 }];
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0, channelIds: [ch._id], query: { kind: 'metric', metric: 'm', filters: [], groupBy: ['pod'], agg: 'max' } }), ctx);
    state.series = Array.from({ length: 6 }, (_, i) => ({ labels: { pod: `p${i}` }, value: 99 }));
    await w.engine(deps).tick();
    const ds = await w.db.c.alertDeliveries.find({ channelId: ch._id }).toArray();
    expect(ds.filter((d) => d.status === 'pending')).toHaveLength(2);
    expect(ds.filter((d) => d.status === 'rate_limited')).toHaveLength(4);
    await processor(w).tick();
    expect(w.sent).toHaveLength(2);
    const incs = await w.db.c.incidents.find({ ruleId: rule._id }).toArray();
    expect(incs).toHaveLength(6); // incidents are still all recorded
    expect(incs.some((i) => i.timeline.some((e) => e.type === 'notification_suppressed' && e.data.reason === 'rate_limited'))).toBe(true);
    // the limit is per minute: a minute later the channel can send again
    w.clock.advance(61);
    const n = await fireIncident(w, [ch._id]);
    expect((await w.db.c.alertDeliveries.findOne({ incidentId: n.incident._id }))!.status).toBe('pending');
  });
});

describe('silences', () => {
  const silence = (w: World, matchers: Record<string, unknown> = {}, startOffset = -60, endOffset = 3600) =>
    w.svc.silences.create(w.scopeA, { comment: 'planned maintenance', startsAt: new Date(w.clock.t + startOffset * 1000).toISOString(), endsAt: new Date(w.clock.t + endOffset * 1000).toISOString(), matchers }, ctx);

  test('an active silence suppresses the notification but the incident is still recorded, with the reason on its timeline', async () => {
    const w = await makeWorld(mongo.uri);
    const ch = await channel(w);
    const s = await silence(w);
    const { incident } = await fireIncident(w, [ch._id]);
    expect(incident.status).toBe('open');
    const d = (await w.db.c.alertDeliveries.findOne({ incidentId: incident._id }))!;
    expect(d).toMatchObject({ status: 'suppressed', silenceId: s._id, nextAttemptAt: null });
    expect(await processor(w).tick()).toBe(0);
    expect(w.sent).toHaveLength(0);
    expect(incident.timeline.map((e) => e.type)).toEqual(['opened', 'notification_suppressed']);
    expect(incident.timeline[1]!.message).toMatch(/planned maintenance/);
  });

  test('a silence only applies inside its time window and only to matching rules, severities and environments', async () => {
    const w = await makeWorld(mongo.uri);
    const ch = await channel(w);
    const other = await w.svc.rules.create(w.scopeA, metricRule(w, { name: 'other-rule' }), ctx);
    await silence(w, { ruleIds: [other._id] });                  // different rule
    await silence(w, { severities: ['info'] });                  // different severity
    await silence(w, { environmentIds: [w.envA2] });             // different environment
    await silence(w, {}, 600, 3600);                             // not started yet
    const f1 = await fireIncident(w, [ch._id]);
    expect((await w.db.c.alertDeliveries.findOne({ incidentId: f1.incident._id }))!.status).toBe('pending');
    // matching combination
    await silence(w, { severities: ['critical'], environmentIds: [w.envA], ruleIds: [f1.rule._id] });
    w.clock.advance(1);
    await w.db.c.incidents.updateOne({ _id: f1.incident._id }, { $set: { active: false, status: 'resolved' } });
    await ruleCol(w.db).updateOne({ _id: f1.rule._id }, { $set: { groups: [], nextEvalAt: w.clock.now() } });
    await w.engine(f1.deps).tick();
    const second = (await w.db.c.incidents.find({ ruleId: f1.rule._id }).sort({ openedAt: -1 }).toArray())[0]!;
    expect((await w.db.c.alertDeliveries.findOne({ incidentId: second._id }))!.status).toBe('suppressed');
    // expired
    const w2 = await makeWorld(mongo.uri);
    const ch2 = await channel(w2);
    await w2.db.c.alertConfig.insertOne({ _id: crypto.randomUUID(), kind: 'silence', orgId: w2.orgA, projectId: w2.projA, comment: 'over', startsAt: new Date(w2.clock.t - 7200_000), endsAt: new Date(w2.clock.t - 3600_000), matchers: {}, createdBy: w2.userA, createdAt: new Date(), expireAt: new Date(w2.clock.t + 86_400_000) } as never);
    const f2 = await fireIncident(w2, [ch2._id]);
    expect((await w2.db.c.alertDeliveries.findOne({ incidentId: f2.incident._id }))!.status).toBe('pending');
  });

  test('silences are validated and bounded; deleting one ends the suppression immediately', async () => {
    const w = await makeWorld(mongo.uri);
    await expect(silence(w, {}, -60, -1)).rejects.toMatchObject({ status: 422 });                // already over
    await expect(silence(w, { ruleIds: [crypto.randomUUID()] })).rejects.toMatchObject({ status: 422 }); // unknown rule
    await expect(silence(w, { environmentIds: [w.envB] })).rejects.toMatchObject({ status: 422 });       // another project's environment
    const s = await silence(w);
    const ch = await channel(w);
    await w.svc.silences.remove(w.scopeA, s._id, ctx);
    const f = await fireIncident(w, [ch._id]);
    expect((await w.db.c.alertDeliveries.findOne({ incidentId: f.incident._id }))!.status).toBe('pending');
    await expect(w.svc.silences.remove(w.scopeA, s._id, ctx)).rejects.toMatchObject({ status: 404 });
    for (let i = 0; i < 50; i++) await silence(w, { severities: ['info'] });
    await expect(silence(w)).rejects.toMatchObject({ status: 422, code: 'limit_reached' });
  });
});
