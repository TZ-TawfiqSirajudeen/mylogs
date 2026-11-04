import net from 'node:net';
import { STRICT_POLICY, type NetworkPolicy } from '@nexus/security';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { buildEmailMessage } from './email.js';
import { checkSmtpTarget, dotStuff, sendSmtp, type SmtpRequest } from './smtp.js';
import { makeSelfSignedCert, startFakeSmtp, type FakeSmtp, type FakeSmtpOptions } from './smtp-testkit.js';
import { WebhookUrlError } from './webhook.js';

const PASS = 'canary-smtp-password-7731';
const USER = 'mailer-user';
const dev: NetworkPolicy = { ...STRICT_POLICY, allowLoopback: true, allowInsecureHttp: true };
const now = new Date('2026-11-04T10:00:00Z');
const payload = { event: 'incident.opened', incident: { id: 'inc-1', title: 'Line one\n.dot-start line\n..two dots', severity: 'critical', status: 'open', ruleName: 'r', group: {}, value: 1, condition: '> 1 over 5m', openedAt: now.toISOString(), url: 'https://n.example.com/i' } };
const { raw } = buildEmailMessage({ from: 'alerts@example.com', to: ['a@example.com', 'b@example.org'], deliveryId: 'd-1', event: 'incident.opened', now }, payload);

const cert = makeSelfSignedCert();
const needsTls = cert ? test : test.skip;

let servers: FakeSmtp[] = [];
const start = async (o: FakeSmtpOptions = {}) => { const s = await startFakeSmtp(o); servers.push(s); return s; };
afterAll(async () => { await Promise.all(servers.map((s) => s.close())); });
const req = (s: FakeSmtp, over: Partial<SmtpRequest> = {}): SmtpRequest => ({ host: '127.0.0.1', port: s.port, security: 'none', from: 'alerts@example.com', to: ['a@example.com', 'b@example.org'], message: raw, ...over });
const send = (r: SmtpRequest, policy = dev, extra: { tlsCa?: string; totalTimeoutMs?: number; connectTimeoutMs?: number } = {}) => sendSmtp(r, { policy, ...(cert ? { tlsCa: cert.cert } : {}), ...extra });
const noLeak = (...vals: unknown[]) => { const s = JSON.stringify(vals); expect(s).not.toContain(PASS); expect(s).not.toContain(Buffer.from(PASS).toString('base64')); };

describe('SMTP client against an in-process server (development policy)', () => {
  test('delivers one message to every recipient: envelope, headers, MIME and dot-stuffing survive the trip', async () => {
    const s = await start();
    const r = await send(req(s));
    expect(r).toMatchObject({ ok: true, httpStatus: null, code: null });
    expect(s.messages).toHaveLength(1);
    const m = s.messages[0]!;
    expect(m.from).toBe('alerts@example.com'); expect(m.to).toEqual(['a@example.com', 'b@example.org']);
    expect(m.data.replace(/\r\n/g, '\n').trimEnd()).toBe(raw.replace(/\r\n/g, '\n').trimEnd());
    expect(s.commands.filter((c) => /^EHLO/.test(c))).toHaveLength(1);
    await vi.waitFor(() => expect(s.commands).toContain('QUIT')); // the client does not wait for the server's goodbye
  });
  test('dot-stuffing: a body line that starts with a dot cannot end the DATA phase early', () => {
    expect(dotStuff('a\r\n.b\r\n..c\r\n')).toBe('a\r\n..b\r\n...c\r\n.\r\n');
    expect(dotStuff('x\r\n.\r\ny')).toBe('x\r\n..\r\ny\r\n.\r\n');
  });
  test('a hostile body line ".\\r\\nMAIL FROM:<x>" is delivered as data, not as a command', async () => {
    const s = await start();
    const evil = `${raw}\r\n.\r\nMAIL FROM:<attacker@evil.example>\r\nRCPT TO:<victim@example.com>\r\n`;
    expect(await send(req(s, { message: evil }))).toMatchObject({ ok: true });
    expect(s.messages).toHaveLength(1);
    expect(s.commands.filter((c) => c.startsWith('MAIL FROM'))).toHaveLength(1);
  });
  test('AUTH PLAIN and AUTH LOGIN succeed with the right credentials; the password reaches only the AUTH exchange', async () => {
    for (const mech of ['PLAIN', 'LOGIN'] as const) {
      const s = await start({ auth: [mech], credentials: { user: USER, pass: PASS }, authOnlyOverTls: false });
      const r = await send(req(s, { username: USER, password: PASS }));
      expect(r, mech).toMatchObject({ ok: true });
      expect(s.authAttempts).toEqual([{ mech, user: USER, pass: PASS }]);
      expect(s.messages[0]!.authenticated).toBe(true);
      expect(JSON.stringify(s.commands)).not.toContain(PASS);
      noLeak(r);
    }
  });
  test('wrong credentials fail at once (non-retryable) with a message that contains neither the password nor the server text', async () => {
    const s = await start({ auth: ['PLAIN'], credentials: { user: USER, pass: 'something-else' }, authOnlyOverTls: false });
    const r = await send(req(s, { username: USER, password: PASS }));
    expect(r).toMatchObject({ ok: false, code: 'smtp_auth_failed', retryable: false });
    expect(r.message).not.toContain('credentials invalid'); noLeak(r);
    expect(s.messages).toHaveLength(0);
  });
  test('a server that offers no AUTH mechanism we support is a configuration failure', async () => {
    const s = await start({ auth: [] });
    expect(await send(req(s, { username: USER, password: PASS }))).toMatchObject({ ok: false, code: 'smtp_auth_failed', retryable: false });
  });
  test('recipient handling: partial refusal still delivers (and says so); total permanent refusal fails; total temporary refusal retries', async () => {
    const partial = await start({ rcpt: (a) => (a.startsWith('b@') ? 550 : null) });
    const p = await send(req(partial));
    expect(p).toMatchObject({ ok: true }); expect(p.message).toMatch(/1 of 2 recipients were refused/);
    expect(partial.messages[0]!.to).toEqual(['a@example.com']);
    const none = await start({ rcpt: () => 550 });
    expect(await send(req(none))).toMatchObject({ ok: false, code: 'recipients_rejected', retryable: false });
    const temp = await start({ rcpt: () => 451 });
    expect(await send(req(temp))).toMatchObject({ ok: false, code: 'smtp_temporary_failure', retryable: true });
  });
  test('reply classification: 4xx retryable, 5xx permanent, at each stage', async () => {
    expect(await send(req(await start({ greetingCode: 554 })))).toMatchObject({ ok: false, code: 'smtp_rejected', retryable: false });
    expect(await send(req(await start({ greetingCode: 421 })))).toMatchObject({ ok: false, code: 'smtp_temporary_failure', retryable: true });
    expect(await send(req(await start({ mailCode: 452 })))).toMatchObject({ ok: false, code: 'smtp_temporary_failure', retryable: true });
    expect(await send(req(await start({ mailCode: 553 })))).toMatchObject({ ok: false, code: 'smtp_rejected', retryable: false });
    expect(await send(req(await start({ dataCode: 451 })))).toMatchObject({ ok: false, code: 'smtp_temporary_failure', retryable: true });
    expect(await send(req(await start({ dataCode: 554 })))).toMatchObject({ ok: false, code: 'smtp_rejected', retryable: false });
  });
  test('connection refused is retryable; a silent server times out (retryable) within the bounded time', async () => {
    const closed = await start(); await closed.close();
    expect(await send(req(closed))).toMatchObject({ ok: false, code: 'connection_failed', retryable: true });
    const silent = await start({ silent: true });
    const t0 = Date.now();
    expect(await send(req(silent), dev, { totalTimeoutMs: 400 })).toMatchObject({ ok: false, code: 'timeout', retryable: true });
    expect(Date.now() - t0).toBeLessThan(3_000);
  });
  test('an oversized reply line is a protocol error, not unbounded memory', async () => {
    const s = await start({ hugeLine: true });
    expect(await send(req(s))).toMatchObject({ ok: false, code: 'smtp_protocol_error' });
  });
  test('addresses with CR/LF or angle brackets never reach the wire (backstop behind the contract)', async () => {
    const s = await start();
    for (const bad of ['a@example.com\r\nRCPT TO:<x@evil.example>', 'a@example.com>\r\nDATA', '<a@example.com>', 'a b@example.com']) {
      expect(await send(req(s, { to: [bad] })), bad).toMatchObject({ ok: false, code: 'invalid_address', retryable: false });
    }
    expect(await send(req(s, { from: 'x@example.com\r\nQUIT' }))).toMatchObject({ ok: false, code: 'invalid_address' });
    expect(await send(req(s, { to: Array.from({ length: 21 }, (_, i) => `u${i}@example.com`) }))).toMatchObject({ ok: false, code: 'invalid_address' });
    expect(s.connections).toBe(0); // nothing was even dialled
  });
  test('unencrypted SMTP is refused outside development, and credentials never go over it', async () => {
    const s = await start({ auth: ['PLAIN'], credentials: { user: USER, pass: PASS }, authOnlyOverTls: false });
    const prod: NetworkPolicy = { ...STRICT_POLICY, allowLoopback: true, allowInsecureHttp: false };
    expect(await send(req(s, { port: 587 }), prod)).toMatchObject({ ok: false, code: 'smtp_tls_required', retryable: false });
    expect(s.connections).toBe(0);
  });
});

describe('TLS (certificate generated with the openssl CLI at test time)', () => {
  needsTls('STARTTLS: upgrades before AUTH, verifies the certificate, and the message is delivered over TLS', async () => {
    const s = await start({ starttls: true, cert: cert!, auth: ['PLAIN'], credentials: { user: USER, pass: PASS } });
    const r = await send(req(s, { security: 'starttls', username: USER, password: PASS }));
    expect(r).toMatchObject({ ok: true });
    expect(s.tlsUpgrades).toBe(1);
    expect(s.messages[0]).toMatchObject({ secure: true, authenticated: true });
    expect(s.commands.filter((c) => c.startsWith('EHLO'))).toHaveLength(2); // once before and once after the upgrade
    expect(s.commands.indexOf('STARTTLS')).toBeLessThan(s.commands.findIndex((c) => c.startsWith('AUTH')));
    noLeak(r);
  });
  needsTls('STARTTLS is REQUIRED: a server that does not offer it is a failure, never a silent downgrade, and no credentials are sent', async () => {
    const s = await start({ starttls: false, auth: ['PLAIN'], credentials: { user: USER, pass: PASS }, authOnlyOverTls: false });
    const r = await send(req(s, { security: 'starttls', username: USER, password: PASS }));
    expect(r).toMatchObject({ ok: false, code: 'smtp_tls_required', retryable: false });
    expect(s.authAttempts).toHaveLength(0); expect(s.messages).toHaveLength(0);
  });
  needsTls('implicit TLS (port-465 style) works', async () => {
    const s = await start({ implicitTls: true, cert: cert!, auth: ['LOGIN'], credentials: { user: USER, pass: PASS } });
    expect(await send(req(s, { security: 'tls', username: USER, password: PASS }))).toMatchObject({ ok: true });
    expect(s.messages[0]!.secure).toBe(true);
  });
  needsTls('an untrusted certificate is a TLS error and nothing is sent (certificate verification cannot be turned off)', async () => {
    const s = await start({ starttls: true, cert: cert!, auth: ['PLAIN'], credentials: { user: USER, pass: PASS } });
    const r = await sendSmtp(req(s, { security: 'starttls', username: USER, password: PASS }), { policy: dev }); // no tlsCa: the self-signed certificate is not trusted
    expect(r).toMatchObject({ ok: false, code: 'tls_error', retryable: false });
    expect(s.authAttempts).toHaveLength(0); expect(s.messages).toHaveLength(0);
    noLeak(r);
    const implicit = await start({ implicitTls: true, cert: cert!, auth: ['PLAIN'], credentials: { user: USER, pass: PASS } });
    expect(await sendSmtp(req(implicit, { security: 'tls' }), { policy: dev })).toMatchObject({ ok: false, code: 'tls_error' });
  });
  needsTls('a hostname that is not in the certificate is refused', async () => {
    const s = await start({ implicitTls: true, cert: cert!, auth: [] });
    const policy: NetworkPolicy = { ...dev, resolver: async () => ['127.0.0.1'] };
    expect(await send(req(s, { host: 'wrong-name.example.com', security: 'tls' }), policy)).toMatchObject({ ok: false, code: 'tls_error' });
    expect(await send(req(s, { host: 'smtp.example.com', security: 'tls' }), policy)).toMatchObject({ ok: true }); // the certificate names smtp.example.com, and DNS is pinned to the validated address
  });
  needsTls('plaintext injected right after the STARTTLS reply is refused (STARTTLS injection)', async () => {
    const s = await start({ starttls: true, cert: cert!, injectAfterStartTls: true });
    expect(await send(req(s, { security: 'starttls' }))).toMatchObject({ ok: false, code: 'smtp_protocol_error' });
    expect(s.messages).toHaveLength(0);
  });
});

describe('SSRF: the SMTP host goes through the platform guard (resolve, classify every address, pin)', () => {
  const resolving = (map: Record<string, string[]>, over: Partial<NetworkPolicy> = {}): NetworkPolicy => ({ ...STRICT_POLICY, ...over, resolver: async (h) => { const r = map[h]; if (!r) throw new Error('ENOTFOUND'); return r; } });
  const policy = resolving({ 'smtp.public.example.com': ['93.184.216.34'], 'smtp.internal.example.com': ['10.0.0.9'], 'smtp.loop.example.com': ['127.0.0.1'], 'meta.example.com': ['169.254.169.254'], 'mixed.example.com': ['93.184.216.34', '10.1.2.3'] });
  const codeOf = async (p: Promise<unknown>) => { try { await p; return 'allowed'; } catch (e) { return e instanceof WebhookUrlError ? e.code : `other:${(e as Error).message}`; } };

  test('public hosts on the submission ports are accepted', async () => {
    for (const port of [587, 465, 2525]) expect(await codeOf(checkSmtpTarget('smtp.public.example.com', port, policy)), String(port)).toBe('allowed');
  });
  test.each([
    ['literal loopback', '127.0.0.1'], ['literal private', '10.0.0.5'], ['literal 192.168', '192.168.1.10'], ['metadata', '169.254.169.254'], ['link-local v6', '[fe80::1]'], ['loopback v6', '[::1]'],
    ['IPv4-mapped loopback', '[::ffff:127.0.0.1]'], ['decimal shorthand', '2130706433'], ['localhost', 'localhost'], ['*.internal', 'mail.internal'], ['*.local', 'mail.local'], ['metadata name', 'metadata.google.internal'],
    ['resolves to private', 'smtp.internal.example.com'], ['resolves to loopback', 'smtp.loop.example.com'], ['resolves to metadata', 'meta.example.com'], ['mixed public+private answers', 'mixed.example.com'],
  ])('%s is blocked', async (_n, host) => { expect(await codeOf(checkSmtpTarget(host, 587, policy))).toBe('blocked_target'); });
  test('unresolvable names are DNS failures', async () => { expect(await codeOf(checkSmtpTarget('nope.example.com', 587, policy))).toBe('dns_failure'); });
  test.each([[25], [22], [3306], [5432], [6379], [80], [443], [8080], [143], [993]])('port %i is refused outside development', async (port) => {
    expect(await codeOf(checkSmtpTarget('smtp.public.example.com', port, policy))).toBe('blocked_port');
  });
  test('an approved private CIDR allows an internal relay, but metadata stays blocked', async () => {
    const p = resolving({ 'relay.corp.example.com': ['10.0.0.9'], 'meta.example.com': ['169.254.169.254'] }, { allowPrivateCidrs: ['10.0.0.0/8', '169.254.0.0/16'] });
    expect(await codeOf(checkSmtpTarget('relay.corp.example.com', 587, p))).toBe('allowed');
    expect(await codeOf(checkSmtpTarget('meta.example.com', 587, p))).toBe('blocked_target');
  });
  test('sending re-checks the target on every send (DNS changed after save time) and never dials a blocked address', async () => {
    let calls = 0;
    const flip: NetworkPolicy = { ...STRICT_POLICY, resolver: async () => (++calls === 1 ? ['93.184.216.34'] : ['127.0.0.1']) };
    await checkSmtpTarget('smtp.example.com', 587, flip); // "saved" while it pointed at a public address
    const r = await sendSmtp({ host: 'smtp.example.com', port: 587, security: 'starttls', from: 'a@example.com', to: ['b@example.com'], message: raw }, { policy: flip });
    expect(r).toMatchObject({ ok: false, code: 'blocked_target', retryable: false });
  });
  test('the connection is pinned to the validated address, not re-resolved (DNS rebinding)', async () => {
    const s = await start();
    // the name resolves (once, at validation) to loopback, which the development policy allows; the socket must go there, not to whatever DNS says later
    const policy2: NetworkPolicy = { ...dev, resolver: async () => ['127.0.0.1'] };
    expect(await send(req(s, { host: 'relay.rebind-test.example.com' }), policy2)).toMatchObject({ ok: true });
    expect(s.connections).toBe(1);
  });
  test('a server that listens only on a blocked port is never contacted in production mode', async () => {
    const hits: number[] = [];
    const srv = net.createServer((c) => { hits.push(1); c.destroy(); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const port = (srv.address() as net.AddressInfo).port;
    const prodLoop: NetworkPolicy = { ...STRICT_POLICY, allowLoopback: true, allowInsecureHttp: false };
    expect(await sendSmtp({ host: '127.0.0.1', port, security: 'starttls', from: 'a@example.com', to: ['b@example.com'], message: raw }, { policy: prodLoop })).toMatchObject({ ok: false, code: 'blocked_port' });
    expect(hits).toHaveLength(0);
    await new Promise<void>((r) => srv.close(() => r()));
  });
});

beforeAll(() => { /* servers start per test */ });
