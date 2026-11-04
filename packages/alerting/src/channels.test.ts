import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ChannelUpdate } from '@nexus/contracts';
import { startTestMongo } from '@nexus/database/testing';
import { STRICT_POLICY, type NetworkPolicy } from '@nexus/security';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { channelCol } from './common.js';
import { toChannelDto } from './channels.js';
import { DeliveryProcessor } from './delivery.js';
import { startFakeSmtp, type FakeSmtp, type FakeSmtpOptions } from './smtp-testkit.js';
import { makeWorld, metricRule, scriptedStores, type World } from './testkit.js';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
const smtps: FakeSmtp[] = [];
let slackServer: http.Server;
let slackPort: number;
const slackHits: { url: string; body: string; headers: http.IncomingHttpHeaders }[] = [];
let slackStatus = 200;

beforeAll(async () => {
  mongo = await startTestMongo();
  slackServer = http.createServer((req, res) => {
    const chunks: Buffer[] = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => { slackHits.push({ url: req.url ?? '', body: Buffer.concat(chunks).toString(), headers: req.headers }); res.writeHead(slackStatus); res.end(slackStatus === 200 ? 'ok' : 'error'); });
  });
  await new Promise<void>((r) => slackServer.listen(0, '127.0.0.1', r));
  slackPort = (slackServer.address() as AddressInfo).port;
}, 240_000);
afterAll(async () => { await Promise.all(smtps.map((s) => s.close())); await new Promise<void>((r) => slackServer?.close(() => r())); await mongo?.stop(); });

const PASS = 'canary-smtp-password-9912';
const SMTP_USER = 'canary-smtp-user-5521';
const SLACK_TOKEN = 'XXXXSLACKTOKENCANARYXXXX';
const slackUrl = () => `http://127.0.0.1:${slackPort}/services/T000/B000/${SLACK_TOKEN}`;
const ctx = { requestId: 'req-1' };
/** Development policy: loopback and plain http are allowed so the in-process receivers can be reached; everything else is the production guard. */
const DEV: NetworkPolicy = { ...STRICT_POLICY, allowLoopback: true, allowInsecureHttp: true };
/** Production-like policy with a controllable resolver. */
const PROD = (map: Record<string, string[]> = {}): NetworkPolicy => ({ ...STRICT_POLICY, resolver: async (h) => map[h] ?? ['93.184.216.34'] });

const smtp = async (o: FakeSmtpOptions = {}) => { const s = await startFakeSmtp(o); smtps.push(s); return s; };
const slackCh = (w: World, over: Record<string, unknown> = {}) => w.svc.channels.create(w.scopeA, { type: 'slack', name: `slack-${Math.random().toString(36).slice(2, 7)}`, url: slackUrl(), enabled: true, rateLimitPerMinute: 20, ...over } as never, ctx);
const emailCh = (w: World, s: FakeSmtp | null, over: Record<string, unknown> = {}) => w.svc.channels.create(w.scopeA, {
  type: 'email', name: `mail-${Math.random().toString(36).slice(2, 7)}`, enabled: true, rateLimitPerMinute: 20,
  smtp: { host: '127.0.0.1', port: s?.port ?? 587, security: 'none', username: SMTP_USER, password: PASS }, from: 'alerts@example.com', recipients: ['oncall@example.com', 'second@example.org'], ...over,
} as never, ctx);
/** The delivery processor as the worker runs it: the REAL Slack and SMTP transports. */
const worker = (w: World, over: Record<string, unknown> = {}) => new DeliveryProcessor(w.db, w.secrets, { owner: 'w1', policy: DEV, now: () => w.clock.now(), ...over });
const dump = async (w: World) => {
  const all: unknown[] = [];
  for (const col of Object.values(w.db.c) as { find(f: object): { toArray(): Promise<unknown[]> } }[]) all.push(await col.find({}).toArray());
  return JSON.stringify(all);
};

async function fireIncident(w: World, channelIds: string[], ruleOver: Record<string, unknown> = {}) {
  const { state, deps } = scriptedStores();
  state.series = [{ labels: {}, value: 99 }];
  const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0, resolveAfterSeconds: 0, channelIds, ...ruleOver }), ctx);
  await w.engine(deps).tick();
  return { rule, incident: (await w.db.c.incidents.findOne({ ruleId: rule._id }))!, state, deps };
}

describe('Slack channels', () => {
  test('the webhook URL is envelope-encrypted, write-only, never in the document, DTO, audit or any collection in clear', async () => {
    const w = await makeWorld(mongo.uri, DEV);
    const ch = await slackCh(w);
    expect(ch.type).toBe('slack');
    const dto = toChannelDto(ch);
    expect(dto).toMatchObject({ type: 'slack', urlDisplay: `http://127.0.0.1:${slackPort}/…`, hasSigningSecret: false });
    expect(dto).not.toHaveProperty('smtp'); expect(dto).not.toHaveProperty('recipientsMasked'); expect(dto).not.toHaveProperty('hasSmtpCredentials');
    expect(JSON.stringify(dto)).not.toContain(SLACK_TOKEN);
    const rows = await w.db.c.secrets.find({ connectionId: `alert-channel:${ch._id}` }).toArray();
    expect(rows.map((r) => r.name)).toEqual(['url']); // no signing secret for Slack
    expect(await w.secrets.get({ orgId: w.orgA, connectionId: `alert-channel:${ch._id}`, name: 'url' })).toBe(slackUrl());
    await expect(w.secrets.get({ orgId: w.orgB, connectionId: `alert-channel:${ch._id}`, name: 'url' })).rejects.toThrow();
    const all = await dump(w);
    expect(all).toContain(ch._id); expect(all).toContain('AES-256-GCM'); // the scan really covers the channel and the secrets collection
    expect(all).not.toContain(SLACK_TOKEN);
    const audit = await w.db.c.auditEvents.findOne({ action: 'alert.channel.created' });
    expect(audit!.metadata).toEqual({ name: ch.name, type: 'slack', target: `http://127.0.0.1:${slackPort}/…` });
  });

  test('validation: the SSRF guard applies at save time (production policy), fields of other channel types are refused', async () => {
    const w = await makeWorld(mongo.uri, PROD({ 'hooks.internal-corp.example.com': ['10.0.0.8'] }));
    await expect(slackCh(w, { url: 'http://hooks.slack.com/services/x' })).rejects.toMatchObject({ status: 422 });
    await expect(slackCh(w, { url: 'https://hooks.internal-corp.example.com/services/x' })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/not permitted/) });
    await expect(slackCh(w, { url: 'https://169.254.169.254/latest' })).rejects.toMatchObject({ status: 422 });
    await expect(slackCh(w, { url: 'https://127.0.0.1/x' })).rejects.toMatchObject({ status: 422 });
    await expect(slackCh(w, { url: 'https://user:pw@hooks.slack.com/x' })).rejects.toMatchObject({ status: 422 });
    const ok = await slackCh(w, { url: 'https://hooks.slack.com/services/T0/B0/abc' });
    await expect(w.svc.channels.update(w.scopeA, ok._id, { signingSecret: 'x'.repeat(20) }, ctx)).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/signingSecret does not apply to slack/) });
    await expect(w.svc.channels.update(w.scopeA, ok._id, { recipients: ['a@example.com'] }, ctx)).rejects.toMatchObject({ status: 422 });
    await w.svc.channels.update(w.scopeA, ok._id, { url: 'https://hooks.slack.com/services/T0/B0/rotated' }, ctx);
    expect(await w.secrets.get({ orgId: w.orgA, connectionId: `alert-channel:${ok._id}`, name: 'url' })).toBe('https://hooks.slack.com/services/T0/B0/rotated');
    await w.svc.channels.remove(w.scopeA, ok._id, ctx);
    expect(await w.db.c.secrets.countDocuments({ connectionId: `alert-channel:${ok._id}` })).toBe(0);
  });

  test('an incident is delivered to a real HTTP receiver as Block Kit, with a link back; the resolution follows; the timeline says "notified"', async () => {
    const w = await makeWorld(mongo.uri, DEV);
    const ch = await slackCh(w);
    // the services built by makeWorld have no public URL; wire a notifier that has one so the message carries a link
    const { Notifier } = await import('./notifier.js');
    const { IncidentService } = await import('./incidents.js');
    const incidents = new IncidentService(w.db, w.audit, new Notifier(w.db, { publicUrl: 'https://nexus.example.com' }), { now: () => w.clock.now() });
    const { state, deps } = scriptedStores(); state.series = [{ labels: {}, value: 99 }];
    const rule = await w.svc.rules.create(w.scopeA, metricRule(w, { forSeconds: 0, resolveAfterSeconds: 0, channelIds: [ch._id] }), ctx);
    const { AlertEngine } = await import('./engine.js');
    await new AlertEngine(w.db, deps, incidents, { owner: 'e', now: () => w.clock.now() }).tick();
    const incident = (await w.db.c.incidents.findOne({ ruleId: rule._id }))!;
    slackHits.length = 0; slackStatus = 200;
    expect(await worker(w).tick()).toBe(1);
    expect(slackHits).toHaveLength(1);
    expect(slackHits[0]!.url).toBe(`/services/T000/B000/${SLACK_TOKEN}`);
    expect(slackHits[0]!.headers['x-nexus-signature']).toBeUndefined();
    const msg = JSON.parse(slackHits[0]!.body);
    expect(msg.blocks[0].type).toBe('header');
    expect(JSON.stringify(msg)).toContain(`https://nexus.example.com/incidents/${incident._id}?p=${w.projA}`);
    expect(JSON.stringify(msg)).not.toContain(SLACK_TOKEN);
    expect((await w.db.c.incidents.findOne({ _id: incident._id }))!.timeline.some((e) => e.type === 'notified' && /HTTP 200/.test(e.message))).toBe(true);
    // resolution notifies the same channel
    await incidents.resolve(w.scopeA, incident._id, 'done', ctx);
    await worker(w).tick();
    expect(slackHits).toHaveLength(2);
    expect(JSON.parse(slackHits[1]!.body).text).toMatch(/^Resolved:/);
  });

  test('retry classification: 5xx retries with backoff, 404 fails at once; errors and timeline never include the URL token', async () => {
    const w = await makeWorld(mongo.uri, DEV);
    const ch = await slackCh(w);
    const { incident } = await fireIncident(w, [ch._id]);
    slackStatus = 503;
    const p = worker(w, { backoffMs: (n: number) => n * 60_000, maxAttempts: 2 });
    await p.tick();
    expect(await w.db.c.alertDeliveries.findOne({ incidentId: incident._id })).toMatchObject({ status: 'pending', attempts: 1, lastError: { code: 'http_server_error' } });
    w.clock.advance(61); await p.tick();
    expect(await w.db.c.alertDeliveries.findOne({ incidentId: incident._id })).toMatchObject({ status: 'failed', attempts: 2 });
    slackStatus = 404;
    const ch2 = await slackCh(w); const f = await fireIncident(w, [ch2._id]);
    await worker(w).tick();
    expect(await w.db.c.alertDeliveries.findOne({ incidentId: f.incident._id, channelId: ch2._id })).toMatchObject({ status: 'failed', attempts: 1, lastError: { code: 'http_client_error' } });
    slackStatus = 200;
    const rows = JSON.stringify([await w.db.c.alertDeliveries.find({}).toArray(), await w.db.c.incidents.find({}).toArray()]);
    expect(rows).not.toContain(SLACK_TOKEN);
  });

  test('test-send goes through the real transport, is rate limited to 5/min and recorded', async () => {
    const w = await makeWorld(mongo.uri, DEV);
    const ch = await slackCh(w);
    slackHits.length = 0; slackStatus = 200;
    const r = await w.svc.channels.test(w.scopeA, ch._id, ctx);
    expect(r).toMatchObject({ ok: true, status: 200 });
    expect(JSON.parse(slackHits[0]!.body).blocks).toHaveLength(2);
    expect((await channelCol(w.db).findOne({ _id: ch._id }))!.lastTest).toMatchObject({ ok: true });
    for (let i = 0; i < 4; i++) await w.svc.channels.test(w.scopeA, ch._id, ctx);
    await expect(w.svc.channels.test(w.scopeA, ch._id, ctx)).rejects.toMatchObject({ status: 429 });
  });
});

describe('E-mail channels: configuration', () => {
  test('SMTP credentials are encrypted and write-only; recipients are masked for readers; nothing sensitive in the document, audit or any collection', async () => {
    const s = await smtp();
    const w = await makeWorld(mongo.uri, DEV);
    const ch = await emailCh(w, s);
    const dto = toChannelDto(ch);
    expect(dto).toMatchObject({ type: 'email', urlDisplay: `smtp://127.0.0.1:${s.port}`, hasSigningSecret: false, hasSmtpCredentials: true, from: 'alerts@example.com', recipientsMasked: ['o***@example.com', 's***@example.org'], smtp: { host: '127.0.0.1', port: s.port, security: 'none' } });
    const wire = JSON.stringify(dto);
    for (const v of [PASS, SMTP_USER, 'oncall@example.com', 'second@example.org']) expect(wire).not.toContain(v);
    const rows = await w.db.c.secrets.find({ connectionId: `alert-channel:${ch._id}` }).toArray();
    expect(rows.map((r) => r.name).sort()).toEqual(['smtp-pass', 'smtp-user']);
    for (const r of rows) expect(r.alg).toBe('AES-256-GCM/v1');
    expect(await w.secrets.get({ orgId: w.orgA, connectionId: `alert-channel:${ch._id}`, name: 'smtp-pass' })).toBe(PASS);
    await expect(w.secrets.get({ orgId: w.orgB, connectionId: `alert-channel:${ch._id}`, name: 'smtp-pass' })).rejects.toThrow();
    const everything = await dump(w);
    expect(everything).not.toContain(PASS); expect(everything).not.toContain(SMTP_USER);
    const audit = JSON.stringify(await w.db.c.auditEvents.find({ projectId: w.projA }).toArray());
    expect(audit).toContain('alert.channel.created'); expect(audit).not.toContain('oncall@example.com');
  });

  test('update: credentials rotate, fields of other types are refused, the audit trail has field names only, and an unrelated PATCH keeps the rate limit', async () => {
    const s = await smtp();
    const w = await makeWorld(mongo.uri, DEV);
    const ch = await emailCh(w, s, { rateLimitPerMinute: 7 });
    await w.svc.channels.update(w.scopeA, ch._id, { enabled: false }, ctx);
    expect((await w.svc.channels.get(w.scopeA, ch._id)).rateLimitPerMinute).toBe(7);
    // the contract does not inject a default rate limit into a partial update either
    expect(ChannelUpdate.parse({ enabled: false })).toEqual({ enabled: false });
    await expect(w.svc.channels.update(w.scopeA, ch._id, { url: 'https://hooks.slack.com/x' }, ctx)).rejects.toMatchObject({ status: 422 });
    await expect(w.svc.channels.update(w.scopeA, ch._id, { signingSecret: 'x'.repeat(20) }, ctx)).rejects.toMatchObject({ status: 422 });
    await w.svc.channels.update(w.scopeA, ch._id, { smtp: { username: 'new-user', password: 'new-pass-8831' }, recipients: ['Ops@Example.com', 'ops@example.com'] }, ctx);
    expect(await w.secrets.get({ orgId: w.orgA, connectionId: `alert-channel:${ch._id}`, name: 'smtp-pass' })).toBe('new-pass-8831');
    expect((await w.svc.channels.get(w.scopeA, ch._id)).email!.recipients).toEqual(['ops@example.com']); // normalised and de-duplicated
    const upd = await w.db.c.auditEvents.find({ action: 'alert.channel.updated' }).toArray();
    expect(upd.map((u) => u.metadata)).toEqual([{ fields: ['enabled'] }, { fields: ['smtp.username', 'smtp.password', 'recipients'] }]);
    expect(JSON.stringify(upd)).not.toContain('new-pass-8831'); expect(JSON.stringify(upd)).not.toContain('ops@example.com');
    // clearing credentials destroys them
    await w.svc.channels.update(w.scopeA, ch._id, { clearSmtpCredentials: true }, ctx);
    expect(await w.db.c.secrets.countDocuments({ connectionId: `alert-channel:${ch._id}` })).toBe(0);
    expect(toChannelDto(await w.svc.channels.get(w.scopeA, ch._id)).hasSmtpCredentials).toBe(false);
    await w.svc.channels.remove(w.scopeA, ch._id, ctx);
  });

  test('recipients: at most 20, at least one, plain addresses only (no CR/LF header or command injection), also when the service is called directly', async () => {
    const s = await smtp();
    const w = await makeWorld(mongo.uri, DEV);
    await expect(emailCh(w, s, { recipients: Array.from({ length: 21 }, (_, i) => `u${i}@example.com`) })).rejects.toMatchObject({ status: 422 });
    await expect(emailCh(w, s, { recipients: [] })).rejects.toMatchObject({ status: 422 });
    for (const bad of ['a@example.com\r\nBcc: evil@example.net', 'a@example.com\nRCPT TO:<x@y.zz>', 'Name <a@example.com>', '"a b"@example.com', 'a@example.com,b@example.com', 'a@localhost']) {
      await expect(emailCh(w, s, { recipients: [bad] }), bad).rejects.toMatchObject({ status: 422 });
    }
    await expect(emailCh(w, s, { from: 'x@example.com\r\nBcc: e@e.zz' })).rejects.toMatchObject({ status: 422 });
    const ok = await emailCh(w, s, { recipients: Array.from({ length: 20 }, (_, i) => `u${i}@example.com`) });
    await expect(w.svc.channels.update(w.scopeA, ok._id, { recipients: ['x@example.com\r\nBcc: y@example.com'] }, ctx)).rejects.toMatchObject({ status: 422 });
    expect(await w.db.c.alertConfig.countDocuments({ kind: 'channel', projectId: w.projA })).toBe(1); // refused creations left nothing behind
  });

  test('SSRF at save time (production policy): private and loopback hosts, metadata, wrong ports, plain SMTP are refused; a public host is accepted', async () => {
    const w = await makeWorld(mongo.uri, PROD({ 'smtp.internal-corp.example.com': ['10.0.0.9'], 'mixed.example.com': ['93.184.216.34', '10.0.0.9'] }));
    const mk = (smtpOver: Record<string, unknown>) => emailCh(w, null, { smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', username: SMTP_USER, password: PASS, ...smtpOver } });
    for (const host of ['127.0.0.1', 'localhost', '10.1.2.3', '192.168.0.4', '169.254.169.254', '::1', 'smtp.internal-corp.example.com', 'mixed.example.com', 'mail.internal', 'mail.local', '2130706433']) {
      await expect(mk({ host }), host).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/not permitted|resolved|port/i) });
    }
    for (const port of [25, 22, 3306, 6379, 8080, 80, 443]) await expect(mk({ port }), String(port)).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/port/i) });
    await expect(mk({ security: 'none' })).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/development/) });
    await expect(mk({ port: 465, security: 'tls' })).resolves.toBeTruthy();
    const ch = await mk({});
    await expect(w.svc.channels.update(w.scopeA, ch._id, { smtp: { host: '10.0.0.1' } }, ctx)).rejects.toMatchObject({ status: 422 });
    await expect(w.svc.channels.update(w.scopeA, ch._id, { smtp: { port: 25 } }, ctx)).rejects.toMatchObject({ status: 422 });
    await expect(w.svc.channels.update(w.scopeA, ch._id, { smtp: { security: 'none' } }, ctx)).rejects.toMatchObject({ status: 422 });
    expect((await w.svc.channels.get(w.scopeA, ch._id)).email).toMatchObject({ host: 'smtp.example.com', port: 587, security: 'starttls' }); // the refused edits changed nothing
  });

  test('environment-restricted callers cannot create or edit e-mail/Slack channels; the project quota is shared by every type', async () => {
    const s = await smtp();
    const w = await makeWorld(mongo.uri, DEV);
    const restricted = { ...w.scopeA, environmentIds: [w.envA] };
    await expect(w.svc.channels.create(restricted, { type: 'slack', name: 'x', url: slackUrl(), enabled: true, rateLimitPerMinute: 5 }, ctx)).rejects.toMatchObject({ status: 403 });
    for (let i = 0; i < 5; i++) await slackCh(w);
    for (let i = 0; i < 5; i++) await emailCh(w, s);
    await expect(slackCh(w)).rejects.toMatchObject({ status: 422, code: 'limit_reached' });
    await expect(emailCh(w, s)).rejects.toMatchObject({ status: 422, code: 'limit_reached' });
  });
});

describe('E-mail channels: delivery through a real SMTP conversation with an in-process server', () => {
  test('opening and resolution are e-mailed to every recipient; the timeline says "notified"; the password is only ever in the AUTH exchange', async () => {
    const s = await smtp({ auth: ['PLAIN'], credentials: { user: SMTP_USER, pass: PASS }, authOnlyOverTls: false });
    const w = await makeWorld(mongo.uri, DEV);
    const ch = await emailCh(w, s);
    const { incident } = await fireIncident(w, [ch._id]);
    expect(await worker(w).tick()).toBe(1);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({ from: 'alerts@example.com', to: ['oncall@example.com', 'second@example.org'], authenticated: true });
    expect(s.messages[0]!.data).toContain('Subject: [Nexus] CRITICAL:');
    expect(s.authAttempts).toEqual([{ mech: 'PLAIN', user: SMTP_USER, pass: PASS }]);
    const d = (await w.db.c.alertDeliveries.findOne({ incidentId: incident._id }))!;
    expect(d).toMatchObject({ status: 'delivered', attempts: 1, httpStatus: null });
    expect((await w.db.c.incidents.findOne({ _id: incident._id }))!.timeline.find((e) => e.type === 'notified')!.message).toMatch(/Notified ".*" \(opened, accepted\)/);
    await w.svc.incidents.resolve(w.scopeA, incident._id, 'done', ctx);
    await worker(w).tick();
    expect(s.messages).toHaveLength(2);
    expect(s.messages[1]!.data).toContain('Subject: [Nexus] RESOLVED:');
    const everything = await dump(w);
    expect(everything).not.toContain(PASS); expect(everything).not.toContain(SMTP_USER);
  });

  test('retry classification: 451 retries with backoff and then succeeds; 550 fails at once; wrong password fails at once; none of it leaks the password', async () => {
    const s = await smtp({ auth: ['PLAIN'], credentials: { user: SMTP_USER, pass: PASS }, authOnlyOverTls: false, dataCode: 451 });
    const w = await makeWorld(mongo.uri, DEV);
    const ch = await emailCh(w, s);
    const { incident } = await fireIncident(w, [ch._id]);
    const p = worker(w, { backoffMs: (n: number) => n * 60_000, maxAttempts: 3 });
    await p.tick();
    expect(await w.db.c.alertDeliveries.findOne({ incidentId: incident._id })).toMatchObject({ status: 'pending', attempts: 1, lastError: { code: 'smtp_temporary_failure' } });
    expect(await p.tick()).toBe(0); // not due
    // the server recovers
    const s2 = await smtp({ auth: ['PLAIN'], credentials: { user: SMTP_USER, pass: PASS }, authOnlyOverTls: false });
    await w.svc.channels.update(w.scopeA, ch._id, { smtp: { port: s2.port } }, ctx);
    w.clock.advance(61); await p.tick();
    expect(await w.db.c.alertDeliveries.findOne({ incidentId: incident._id })).toMatchObject({ status: 'delivered', attempts: 2 });
    expect(s2.messages).toHaveLength(1);

    const perm = await smtp({ auth: ['PLAIN'], credentials: { user: SMTP_USER, pass: PASS }, authOnlyOverTls: false, dataCode: 550 });
    const ch2 = await emailCh(w, perm); const f = await fireIncident(w, [ch2._id]);
    await worker(w).tick();
    expect(await w.db.c.alertDeliveries.findOne({ incidentId: f.incident._id, channelId: ch2._id })).toMatchObject({ status: 'failed', attempts: 1, lastError: { code: 'smtp_rejected' } });
    expect((await w.db.c.incidents.findOne({ _id: f.incident._id }))!.timeline.at(-1)).toMatchObject({ type: 'notification_failed' });

    const wrong = await smtp({ auth: ['PLAIN'], credentials: { user: SMTP_USER, pass: 'not-the-password' }, authOnlyOverTls: false });
    const ch3 = await emailCh(w, wrong); const g = await fireIncident(w, [ch3._id]);
    await worker(w).tick();
    expect(await w.db.c.alertDeliveries.findOne({ incidentId: g.incident._id, channelId: ch3._id })).toMatchObject({ status: 'failed', attempts: 1, lastError: { code: 'smtp_auth_failed' } });
    const everything = await dump(w);
    expect(everything).not.toContain(PASS); expect(everything).not.toContain(SMTP_USER);
  });

  test('silences and the per-channel rate limit apply to e-mail exactly as to webhooks: recorded, nothing sent', async () => {
    const s = await smtp();
    const w = await makeWorld(mongo.uri, DEV);
    const ch = await emailCh(w, s, { smtp: { host: '127.0.0.1', port: s.port, security: 'none' }, rateLimitPerMinute: 1 });
    await w.svc.silences.create(w.scopeA, { comment: 'maintenance', startsAt: w.clock.now().toISOString(), endsAt: new Date(w.clock.t + 3600_000).toISOString(), matchers: {} }, ctx);
    const quiet = await fireIncident(w, [ch._id]);
    expect(await w.db.c.alertDeliveries.findOne({ incidentId: quiet.incident._id })).toMatchObject({ status: 'suppressed' });
    expect((await w.db.c.incidents.findOne({ _id: quiet.incident._id }))!.timeline.some((e) => e.type === 'notification_suppressed')).toBe(true);
    await worker(w).tick();
    expect(s.connections).toBe(0); // a suppressed e-mail never even opens a connection

    const w2 = await makeWorld(mongo.uri, DEV);
    const ch2 = await emailCh(w2, s, { smtp: { host: '127.0.0.1', port: s.port, security: 'none' }, rateLimitPerMinute: 1 });
    const a = await fireIncident(w2, [ch2._id]); const b = await fireIncident(w2, [ch2._id]);
    expect(await w2.db.c.alertDeliveries.findOne({ incidentId: a.incident._id })).toMatchObject({ status: 'pending' });
    expect(await w2.db.c.alertDeliveries.findOne({ incidentId: b.incident._id })).toMatchObject({ status: 'rate_limited' });
    await worker(w2).tick();
    expect(s.messages).toHaveLength(1);
  });

  test('test-send e-mails the recipients and records the result; a refused connection reports a clear, secret-free message', async () => {
    const s = await smtp({ auth: ['PLAIN'], credentials: { user: SMTP_USER, pass: PASS }, authOnlyOverTls: false });
    const w = await makeWorld(mongo.uri, DEV);
    const ch = await emailCh(w, s);
    const r = await w.svc.channels.test(w.scopeA, ch._id, ctx);
    expect(r).toMatchObject({ ok: true, status: null, message: 'Delivered (accepted by the SMTP server)' });
    expect(s.messages[0]!.data).toContain('Subject: [Nexus] Test notification');
    expect(s.messages[0]!.to).toHaveLength(2);
    expect((await channelCol(w.db).findOne({ _id: ch._id }))!.lastTest).toMatchObject({ ok: true });
    await s.close();
    const bad = await w.svc.channels.test(w.scopeA, ch._id, ctx);
    expect(bad).toMatchObject({ ok: false });
    expect(bad.message).toMatch(/SMTP connection failed/); expect(JSON.stringify(bad)).not.toContain(PASS);
    expect(bad.delivery).toMatchObject({ status: 'failed', attempts: 1, nextAttemptAt: null });
  });

  test('delivery re-checks the SSRF guard on every send: a host that now resolves to a private address fails at once and is never dialled', async () => {
    const s = await smtp();
    let mode: 'public' | 'private' = 'public';
    const policy: NetworkPolicy = { ...STRICT_POLICY, allowLoopback: true, allowInsecureHttp: true, resolver: async (h) => (h === 'smtp.example.com' ? (mode === 'public' ? ['127.0.0.1'] : ['10.0.0.9']) : ['127.0.0.1']) };
    const w = await makeWorld(mongo.uri, policy);
    const ch = await emailCh(w, s, { smtp: { host: 'smtp.example.com', port: s.port, security: 'none' } });
    mode = 'private';
    const { incident } = await fireIncident(w, [ch._id]);
    await worker(w, { policy }).tick();
    expect(await w.db.c.alertDeliveries.findOne({ incidentId: incident._id })).toMatchObject({ status: 'failed', attempts: 1, lastError: { code: 'blocked_target' } });
    expect(s.connections).toBe(0);
  });

  test('a stored document with an injected recipient (edited in the database) is refused at send time', async () => {
    const s = await smtp();
    const w = await makeWorld(mongo.uri, DEV);
    const ch = await emailCh(w, s, { smtp: { host: '127.0.0.1', port: s.port, security: 'none' } });
    await channelCol(w.db).updateOne({ _id: ch._id }, { $set: { 'email.recipients': ['a@example.com\r\nBcc: evil@example.net'] } });
    const { incident } = await fireIncident(w, [ch._id]);
    await worker(w).tick();
    expect(await w.db.c.alertDeliveries.findOne({ incidentId: incident._id })).toMatchObject({ status: 'failed', lastError: { code: 'invalid_address' } });
    expect(s.connections).toBe(0);
  });

  test('a channel whose secrets cannot be decrypted reports a generic, retryable error (no key names, no secrets)', async () => {
    const s = await smtp();
    const w = await makeWorld(mongo.uri, DEV);
    const ch = await emailCh(w, s);
    await w.db.c.secrets.deleteMany({ connectionId: `alert-channel:${ch._id}` });
    const { incident } = await fireIncident(w, [ch._id]);
    await worker(w, { maxAttempts: 1 }).tick();
    const d = (await w.db.c.alertDeliveries.findOne({ incidentId: incident._id }))!;
    expect(d.lastError).toEqual({ code: 'connection_failed', message: 'The channel configuration could not be loaded' });
  });
});
