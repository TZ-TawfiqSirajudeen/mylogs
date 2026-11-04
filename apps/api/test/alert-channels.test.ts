import type { EmailSender, SlackSender } from '@nexus/alerting';
import { startTestMongo } from '@nexus/database/testing';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { harness, type Client, type Harness } from './helpers.js';

const SLACK_TOKEN = 'XXXXAPISLACKTOKENCANARYXXXX';
const SMTP_PASS = 'canary-api-smtp-password-4410';
const SMTP_USER = 'canary-api-smtp-user-8821';
// IP literals: validation resolves host names through real DNS, which a test must not depend on
const SLACK_URL = `https://93.184.216.34/services/T000/B000/${SLACK_TOKEN}`;

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let h: Harness, strict: Harness;
let owner: Client, engineer: Client, viewer: Client, globex: Client, strictOwner: Client;
let projectId: string;
const bodies: string[] = [];
const slackSent: { url: string; body: string }[] = [];
const emailSent: { host: string; port: number; username?: string | undefined; password?: string | undefined; to: string[]; message: string }[] = [];
const slackSender: SlackSender = async (req) => { slackSent.push({ url: req.url, body: req.body }); return { ok: true, httpStatus: 200, code: null, message: 'Delivered (HTTP 200)', retryable: false }; };
const emailSender: EmailSender = async (req) => { emailSent.push({ host: req.host, port: req.port, username: req.username, password: req.password, to: req.to, message: req.message }); return { ok: true, httpStatus: null, code: null, message: 'Delivered (accepted by the SMTP server)', retryable: false }; };

const base = () => `/api/v1/projects/${projectId}`;
const slackBody = (over: Record<string, unknown> = {}) => ({ type: 'slack', name: `slack-${Math.random().toString(36).slice(2, 7)}`, url: SLACK_URL, ...over });
const emailBody = (over: Record<string, unknown> = {}) => ({
  type: 'email', name: `mail-${Math.random().toString(36).slice(2, 7)}`,
  smtp: { host: '93.184.216.34', port: 587, security: 'starttls', username: SMTP_USER, password: SMTP_PASS }, from: 'alerts@example.com', recipients: ['oncall@example.com', 'sre@example.org'], ...over,
});

beforeAll(async () => {
  mongo = await startTestMongo();
  h = await harness(mongo.uri, {}, { slackSender, emailSender });
  strict = await harness(mongo.uri, { NETWORK_ALLOW_LOOPBACK: 'false', NETWORK_ALLOW_INSECURE_HTTP: 'false' });
  [owner, engineer, viewer, globex] = await Promise.all([h.login('owner@acme.test'), h.login('engineer@acme.test'), h.login('viewer@acme.test'), h.login('owner@globex.test')]);
  strictOwner = await strict.login('owner@globex.test');
  for (const c of [owner, engineer, viewer, globex, strictOwner]) {
    const orig = c.req.bind(c);
    c.req = async (...a) => { const r = await orig(...a); bodies.push(JSON.stringify(r.json)); return r; };
  }
  const p = (await owner.req('POST', '/api/v1/projects', { name: 'Channels project', environments: [{ name: 'Dev' }] })).json;
  projectId = p.id;
  await owner.req('PUT', `${base()}/members/${engineer.userId}`, { role: 'engineer' });
  await owner.req('PUT', `${base()}/members/${viewer.userId}`, { role: 'viewer' });
}, 300_000);
afterAll(async () => { await h?.app.close(); await h?.db.close(); await strict?.app.close(); await strict?.db.close(); await mongo?.stop(); });

describe('Slack and e-mail channels over the API', () => {
  test('create returns a DTO with no secret material; the list masks recipients; HTTP bodies never contain a canary', async () => {
    const s = await owner.req('POST', `${base()}/alert-channels`, slackBody({ name: 'api-slack' }));
    expect(s.status).toBe(201);
    expect(s.json).toMatchObject({ type: 'slack', name: 'api-slack', urlDisplay: 'https://93.184.216.34/…', hasSigningSecret: false, enabled: true });
    expect(s.json).not.toHaveProperty('smtp'); expect(s.json).not.toHaveProperty('recipientsMasked'); expect(s.json).not.toHaveProperty('from');
    const e = await owner.req('POST', `${base()}/alert-channels`, emailBody({ name: 'api-mail' }));
    expect(e.status).toBe(201);
    expect(e.json).toMatchObject({ type: 'email', urlDisplay: 'smtp://93.184.216.34:587', hasSmtpCredentials: true, hasSigningSecret: false, from: 'alerts@example.com', recipientsMasked: ['o***@example.com', 's***@example.org'], smtp: { host: '93.184.216.34', port: 587, security: 'starttls' } });
    for (const c of [owner, viewer]) {
      const list = (await c.req('GET', `${base()}/alert-channels?limit=100`)).json.items as { name: string; type: string }[];
      expect(list.map((x) => x.type)).toEqual(expect.arrayContaining(['slack', 'email']));
    }
    expect(await h.db.c.secrets.find({ connectionId: `alert-channel:${e.json.id}` }).toArray().then((r) => r.map((x) => x.name).sort())).toEqual(['smtp-pass', 'smtp-user']);
    expect(await h.db.c.secrets.find({ connectionId: `alert-channel:${s.json.id}` }).toArray().then((r) => r.map((x) => x.name))).toEqual(['url']);
    // nothing the API ever answered (including every error body) contains a secret, the Slack token path or a full recipient address
    const wire = bodies.join('\n');
    for (const v of [SLACK_TOKEN, SMTP_PASS, SMTP_USER, 'oncall@example.com', 'sre@example.org', '/services/T000']) expect(wire).not.toContain(v);
  });

  test('RBAC: viewers and engineers read channels but cannot create, change, delete or test them', async () => {
    const ch = (await owner.req('POST', `${base()}/alert-channels`, emailBody())).json;
    for (const c of [viewer, engineer]) {
      expect((await c.req('GET', `${base()}/alert-channels`)).status).toBe(200);
      expect((await c.req('POST', `${base()}/alert-channels`, slackBody())).status).toBe(403);
      expect((await c.req('POST', `${base()}/alert-channels`, emailBody())).status).toBe(403);
      expect((await c.req('PATCH', `${base()}/alert-channels/${ch.id}`, { recipients: ['x@example.com'] })).status).toBe(403);
      expect((await c.req('POST', `${base()}/alert-channels/${ch.id}/test`)).status).toBe(403);
      expect((await c.req('DELETE', `${base()}/alert-channels/${ch.id}`)).status).toBe(403);
    }
    expect(emailSent.filter((m) => m.to.length > 0 && m.message.includes('Test notification'))).toHaveLength(0);
  });

  test('tenant isolation: another organisation cannot see, edit, test or delete these channels (404), and cannot create into this project', async () => {
    const ch = (await owner.req('POST', `${base()}/alert-channels`, slackBody())).json;
    expect((await globex.req('GET', `${base()}/alert-channels`)).status).toBe(404);
    expect((await globex.req('PATCH', `${base()}/alert-channels/${ch.id}`, { enabled: false })).status).toBe(404);
    expect((await globex.req('POST', `${base()}/alert-channels/${ch.id}/test`)).status).toBe(404);
    expect((await globex.req('DELETE', `${base()}/alert-channels/${ch.id}`)).status).toBe(404);
    expect((await globex.req('POST', `${base()}/alert-channels`, slackBody())).status).toBe(404);
    expect((await owner.req('GET', `${base()}/alert-channels`)).json.items.some((c: { id: string }) => c.id === ch.id)).toBe(true);
  });

  test('validation is a 400 with details: bad types, unknown fields, recipient limits and header injection never reach the service', async () => {
    const url = `${base()}/alert-channels`;
    const many = Array.from({ length: 21 }, (_, i) => `u${i}@example.com`);
    const bad: Record<string, unknown>[] = [
      { type: 'sms', name: 'x' }, slackBody({ extra: 1 }), slackBody({ signingSecret: 'x'.repeat(20) }), emailBody({ recipients: many }), emailBody({ recipients: [] }),
      emailBody({ recipients: ['a@example.com\r\nBcc: evil@example.net'] }), emailBody({ recipients: ['a@example.com,b@example.com'] }), emailBody({ from: 'x@example.com\nSubject: hi' }),
      emailBody({ smtp: { host: '93.184.216.34', username: 'u' } }), emailBody({ smtp: { host: 'smtp example.com' } }), emailBody({ smtp: { host: '93.184.216.34', port: 70000 } }), emailBody({ smtp: { host: '93.184.216.34', security: 'ssl' } }),
      emailBody({ url: 'https://x.example.com' }), emailBody({ signingSecret: 'x'.repeat(20) }),
    ];
    for (const b of bad) {
      const r = await owner.req('POST', url, b);
      expect(r.status, JSON.stringify(b).slice(0, 120)).toBe(400);
      expect(r.json.error.code).toBe('validation_error');
    }
    expect((await owner.req('POST', url, emailBody({ recipients: many.slice(0, 20), name: 'twenty' }))).status).toBe(201);
    // PATCH: a recipient list is validated too, and an unrelated field for the type is a 422
    const ch = (await owner.req('POST', url, emailBody())).json;
    expect((await owner.req('PATCH', `${url}/${ch.id}`, { recipients: ['a@example.com\r\nBcc: x@example.net'] })).status).toBe(400);
    expect((await owner.req('PATCH', `${url}/${ch.id}`, { url: 'https://93.184.216.34/x' })).status).toBe(422);
    expect((await owner.req('PATCH', `${url}/${ch.id}`, { smtp: { password: 'only-a-password' } })).status).toBe(400);
  });

  test('update and rotate: credentials are replaced write-only, recipients and from are re-validated, an unrelated PATCH keeps the rate limit', async () => {
    const url = `${base()}/alert-channels`;
    const ch = (await owner.req('POST', url, emailBody({ rateLimitPerMinute: 9 }))).json;
    const off = await owner.req('PATCH', `${url}/${ch.id}`, { enabled: false });
    expect(off.json).toMatchObject({ enabled: false, rateLimitPerMinute: 9 });
    const upd = await owner.req('PATCH', `${url}/${ch.id}`, { smtp: { username: 'rotated-user', password: 'rotated-pass-123' }, recipients: ['New@Example.com'] });
    expect(upd.status).toBe(200);
    expect(upd.json).toMatchObject({ recipientsMasked: ['n***@example.com'], hasSmtpCredentials: true });
    expect(JSON.stringify(upd.json)).not.toContain('rotated');
    const cleared = await owner.req('PATCH', `${url}/${ch.id}`, { clearSmtpCredentials: true });
    expect(cleared.json).toMatchObject({ hasSmtpCredentials: false });
    expect(await h.db.c.secrets.countDocuments({ connectionId: `alert-channel:${ch.id}` })).toBe(0);
    const audit = await owner.req('GET', `/api/v1/audit?projectId=${projectId}&limit=200`);
    const mine = audit.json.items.filter((e: { targetId: string }) => e.targetId === ch.id);
    expect(mine.map((e: { action: string }) => e.action)).toEqual(expect.arrayContaining(['alert.channel.created', 'alert.channel.updated']));
    const trail = JSON.stringify(mine);
    for (const v of ['rotated', 'new@example.com', 'oncall@example.com', SMTP_PASS]) expect(trail.toLowerCase()).not.toContain(v.toLowerCase());
  });

  test('test-send uses the channel real transport with the stored secrets (decrypted only inside the server) and records the result', async () => {
    const s = (await owner.req('POST', `${base()}/alert-channels`, slackBody({ name: 'ts-slack' }))).json;
    const e = (await owner.req('POST', `${base()}/alert-channels`, emailBody({ name: 'ts-mail' }))).json;
    const rs = await owner.req('POST', `${base()}/alert-channels/${s.id}/test`);
    expect(rs.status).toBe(200);
    expect(rs.json).toMatchObject({ ok: true, status: 200, delivery: { channelId: s.id, event: 'test', status: 'delivered' } });
    expect(slackSent.at(-1)).toMatchObject({ url: SLACK_URL });
    expect(JSON.parse(slackSent.at(-1)!.body).blocks).toHaveLength(2);
    const re = await owner.req('POST', `${base()}/alert-channels/${e.id}/test`);
    expect(re.status).toBe(200);
    expect(re.json).toMatchObject({ ok: true, status: null, message: 'Delivered (accepted by the SMTP server)', delivery: { channelId: e.id, event: 'test', status: 'delivered', httpStatus: null } });
    expect(emailSent.at(-1)).toMatchObject({ host: '93.184.216.34', port: 587, username: SMTP_USER, password: SMTP_PASS, to: ['oncall@example.com', 'sre@example.org'] });
    expect(emailSent.at(-1)!.message).toContain('Subject: [Nexus] Test notification');
    expect(JSON.stringify([rs.json, re.json])).not.toMatch(new RegExp(`${SLACK_TOKEN}|${SMTP_PASS}|${SMTP_USER}|oncall@example.com`));
    const list = (await owner.req('GET', `${base()}/alert-channels?limit=100`)).json.items;
    expect(list.find((c: { id: string }) => c.id === e.id).lastTest).toMatchObject({ ok: true });
  });

  test('SSRF at the API (production network policy): Slack URLs and SMTP hosts/ports are refused when saving, and the refused saves leave nothing behind', async () => {
    const p = (await strictOwner.req('POST', '/api/v1/projects', { name: 'Strict channels', environments: [{ name: 'Dev' }] })).json;
    const url = `/api/v1/projects/${p.id}/alert-channels`;
    for (const bad of ['http://93.184.216.34/hook', 'https://127.0.0.1/hook', 'https://10.0.0.5/hook', 'https://169.254.169.254/latest/', 'https://localhost/x', 'https://[::1]/x', 'https://2130706433/', 'https://user:pw@93.184.216.34/x', 'https://93.184.216.34:25/']) {
      const r = await strictOwner.req('POST', url, slackBody({ name: `s-${Math.random().toString(36).slice(2, 7)}`, url: bad }));
      expect(r.status, bad).toBe(422);
      expect(JSON.stringify(r.json)).not.toContain('XXXX');
    }
    const mail = (smtp: Record<string, unknown>) => strictOwner.req('POST', url, emailBody({ name: `m-${Math.random().toString(36).slice(2, 7)}`, smtp: { host: '93.184.216.34', port: 587, security: 'starttls', username: SMTP_USER, password: SMTP_PASS, ...smtp } }));
    for (const smtp of [{ host: '127.0.0.1' }, { host: '10.0.0.5' }, { host: '169.254.169.254' }, { host: 'localhost' }, { host: 'mail.internal' }, { host: '192.168.1.1' }, { port: 25 }, { port: 22 }, { port: 3306 }, { port: 6379 }, { port: 8080 }, { security: 'none' }]) {
      const r = await mail(smtp);
      expect(r.status, JSON.stringify(smtp)).toBe(422);
      expect(JSON.stringify(r.json)).not.toContain(SMTP_PASS);
    }
    expect(await strict.db.c.alertConfig.countDocuments({ projectId: p.id })).toBe(0);
    expect(await strict.db.c.secrets.countDocuments({ connectionId: { $regex: '^alert-channel:' } })).toBe(0);
    expect((await mail({ port: 465, security: 'tls' })).status).toBe(201);
    expect((await strictOwner.req('POST', url, slackBody({ name: 'ok-slack' }))).status).toBe(201);
    // editing an existing e-mail channel onto a blocked host or port is refused and changes nothing
    const ch = (await strictOwner.req('GET', url)).json.items.find((c: { type: string }) => c.type === 'email');
    expect((await strictOwner.req('PATCH', `${url}/${ch.id}`, { smtp: { host: '10.0.0.1' } })).status).toBe(422);
    expect((await strictOwner.req('PATCH', `${url}/${ch.id}`, { smtp: { port: 25 } })).status).toBe(422);
    expect((await strictOwner.req('GET', url)).json.items.find((c: { id: string }) => c.id === ch.id)).toMatchObject({ urlDisplay: 'smtp://93.184.216.34:465' });
  });

  test('the OpenAPI document describes the channel union and never lists a secret in a response', async () => {
    const spec = (h.app as unknown as { swagger(): { paths: Record<string, Record<string, { requestBody?: unknown; responses?: Record<string, unknown> }>> } }).swagger();
    const post = spec.paths[`/api/v1/projects/{projectId}/alert-channels`]!.post!;
    const req = JSON.stringify(post.requestBody);
    for (const f of ['slack', 'email', 'recipients', 'smtp', 'password', 'signingSecret']) expect(req).toContain(f);
    const resp = JSON.stringify(post.responses!['201']);
    for (const f of ['password', 'username', 'signingSecret']) expect(resp).not.toContain(`"${f}"`);
    expect(resp).toContain('recipientsMasked');
  });
});
