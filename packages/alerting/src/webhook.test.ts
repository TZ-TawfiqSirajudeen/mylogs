import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { STRICT_POLICY, type NetworkPolicy } from '@nexus/security';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { checkWebhookTarget, parseWebhookUrl, sendWebhook, signPayload, WEBHOOK_LIMITS, WebhookUrlError } from './webhook.js';

const resolving = (map: Record<string, string[]>, over: Partial<NetworkPolicy> = {}): NetworkPolicy => ({
  ...STRICT_POLICY, ...over, resolver: async (h) => { const r = map[h]; if (!r) throw new Error('ENOTFOUND'); return r; },
});
const codeOf = async (p: Promise<unknown>) => { try { await p; return 'allowed'; } catch (e) { return e instanceof WebhookUrlError ? e.code : `other:${(e as Error).message}`; } };

describe('URL validation (no network)', () => {
  test('https is required unless the platform policy allows plain http', () => {
    expect(() => parseWebhookUrl('https://hooks.example.com/x', STRICT_POLICY)).not.toThrow();
    expect(() => parseWebhookUrl('http://hooks.example.com/x', STRICT_POLICY)).toThrow(/https/);
    expect(() => parseWebhookUrl('http://hooks.example.com/x', { allowInsecureHttp: true })).not.toThrow();
  });
  test.each([
    ['ftp://example.com/x'], ['file:///etc/passwd'], ['javascript:alert(1)'], ['gopher://example.com'], ['not a url'], [''],
    ['https://user:pass@example.com/x'], ['https://user@example.com/x'], ['https://example.com/x#frag'], [`https://example.com/${'a'.repeat(2100)}`],
  ])('refuses %s', (u) => expect(() => parseWebhookUrl(u, { allowInsecureHttp: true })).toThrow(WebhookUrlError));
});

describe('SSRF: blocked targets (strict policy, as in production)', () => {
  const policy = resolving({
    'public.example.com': ['93.184.216.34'], 'internal.example.com': ['10.0.0.5'], 'loop.example.com': ['127.0.0.1'], 'meta.example.com': ['169.254.169.254'],
    'mixed.example.com': ['93.184.216.34', '10.1.2.3'], 'v6loop.example.com': ['::1'], 'mapped.example.com': ['::ffff:127.0.0.1'], 'ula.example.com': ['fd00::1'],
    'linklocal6.example.com': ['fe80::1'], 'cgnat.example.com': ['100.64.0.1'], 'zero.example.com': ['0.0.0.0'],
  });
  test('a public address is accepted', async () => {
    expect(await codeOf(checkWebhookTarget('https://public.example.com/hook', policy))).toBe('allowed');
  });
  test.each([
    ['literal loopback', 'https://127.0.0.1/hook'], ['literal loopback v6', 'https://[::1]/hook'], ['literal private 10/8', 'https://10.0.0.5/hook'],
    ['literal private 192.168', 'https://192.168.1.1/hook'], ['literal private 172.16', 'https://172.16.0.9/hook'], ['AWS/Azure/GCP metadata', 'https://169.254.169.254/latest/meta-data/'],
    ['ECS metadata', 'https://169.254.170.2/v2/credentials'], ['Alibaba metadata', 'https://100.100.100.200/'], ['link-local v6', 'https://[fe80::1]/'],
    ['IPv4-mapped loopback', 'https://[::ffff:127.0.0.1]/'], ['IPv4-mapped hex loopback', 'https://[::ffff:7f00:1]/'], ['unspecified', 'https://0.0.0.0/'],
    ['decimal IP shorthand', 'https://2130706433/'], ['hex IP shorthand', 'https://0x7f.1/'], ['localhost', 'https://localhost/hook'], ['sub.localhost', 'https://a.localhost/hook'],
    ['metadata hostname', 'https://metadata.google.internal/computeMetadata/v1/'], ['.internal suffix', 'https://db.internal/'], ['.local suffix', 'https://printer.local/'],
    ['SMTP port', 'https://public.example.com:25/'], ['SSH port', 'https://public.example.com:22/'], ['Redis-ish blocked port', 'https://public.example.com:6666/'],
    ['hostname resolving to private', 'https://internal.example.com/'], ['hostname resolving to loopback', 'https://loop.example.com/'],
    ['hostname resolving to metadata', 'https://meta.example.com/'], ['mixed public+private answers (rebinding-style)', 'https://mixed.example.com/'],
    ['hostname resolving to ::1', 'https://v6loop.example.com/'], ['hostname resolving to mapped loopback', 'https://mapped.example.com/'],
    ['hostname resolving to ULA', 'https://ula.example.com/'], ['hostname resolving to fe80', 'https://linklocal6.example.com/'],
    ['hostname resolving to CGNAT', 'https://cgnat.example.com/'], ['hostname resolving to 0.0.0.0', 'https://zero.example.com/'],
  ])('%s is refused', async (_n, url) => {
    expect(await codeOf(checkWebhookTarget(url, policy))).toBe('blocked_target');
  });
  test('an unresolvable name is a DNS failure, not an allowed target', async () => {
    expect(await codeOf(checkWebhookTarget('https://nope.example.com/', policy))).toBe('dns_failure');
  });
  test('metadata addresses stay blocked even when a private CIDR that covers them is approved', async () => {
    const p = resolving({ 'meta.example.com': ['169.254.169.254'] }, { allowPrivateCidrs: ['169.254.0.0/16', '10.0.0.0/8'] });
    expect(await codeOf(checkWebhookTarget('https://meta.example.com/', p))).toBe('blocked_target');
    expect(await codeOf(checkWebhookTarget('https://169.254.169.254/', p))).toBe('blocked_target');
  });
});

describe('sending (real local receiver, development policy)', () => {
  let server: http.Server;
  let port: number;
  let hits: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  let mode: 'ok' | 'redirect' | '500' | '400' | '429' | 'hang' | 'flood' = 'ok';
  let redirectTargetHits = 0;
  let target: http.Server;
  let targetPort: number;
  const dev = (over: Partial<NetworkPolicy> = {}): NetworkPolicy => ({ ...STRICT_POLICY, allowLoopback: true, allowInsecureHttp: true, ...over });
  const now = new Date('2026-03-01T12:00:00Z');
  const send = (path = '/hook', body = '{"hello":"world"}', policy = dev(), extra: { timeoutMs?: number } = {}) =>
    sendWebhook({ url: `http://127.0.0.1:${port}${path}`, secret: 'topsecret-signing-key-1', event: 'incident.opened', deliveryId: 'd-1', body, now }, { policy, ...extra });

  beforeAll(async () => {
    target = http.createServer((_req, res) => { redirectTargetHits++; res.end('reached'); });
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    targetPort = (target.address() as AddressInfo).port;
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        hits.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() });
        if (mode === 'redirect') { res.writeHead(302, { location: `http://127.0.0.1:${targetPort}/stolen` }); res.end(); return; }
        if (mode === '500') { res.writeHead(500); res.end('boom'); return; }
        if (mode === '400') { res.writeHead(400); res.end('bad'); return; }
        if (mode === '429') { res.writeHead(429); res.end(); return; }
        if (mode === 'hang') return; // never answers
        if (mode === 'flood') { res.writeHead(200); const t = setInterval(() => res.write('x'.repeat(8192)), 1); res.on('close', () => clearInterval(t)); return; }
        res.writeHead(200); res.end('ok');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    for (const s of [server, target]) { s.closeAllConnections(); await new Promise((r) => s.close(r)); }
  });

  test('delivers a signed JSON POST whose signature a receiver can verify', async () => {
    mode = 'ok'; hits = [];
    const r = await send();
    expect(r).toMatchObject({ ok: true, httpStatus: 200, code: null, retryable: false });
    const h = hits[0]!;
    expect(h.headers['content-type']).toBe('application/json');
    expect(h.headers['x-nexus-event']).toBe('incident.opened');
    expect(h.headers['x-nexus-delivery']).toBe('d-1');
    const sig = String(h.headers['x-nexus-signature']);
    const [t, v1] = [/t=(\d+)/.exec(sig)![1]!, /v1=([0-9a-f]{64})/.exec(sig)![1]!];
    expect(Number(t)).toBe(Math.floor(now.getTime() / 1000));
    expect(v1).toBe(createHmac('sha256', 'topsecret-signing-key-1').update(`${t}.${h.body}`).digest('hex'));
    expect(sig).toBe(signPayload('topsecret-signing-key-1', Number(t), h.body));
    expect(JSON.stringify(r)).not.toContain('topsecret');
  });

  test('a different secret produces a different signature (a receiver can tell a forged request)', () => {
    expect(signPayload('a'.repeat(16), 1, '{}')).not.toBe(signPayload('b'.repeat(16), 1, '{}'));
  });

  test('redirects are NEVER followed: the redirect target is not contacted', async () => {
    mode = 'redirect'; redirectTargetHits = 0; hits = [];
    const r = await send();
    expect(r).toMatchObject({ ok: false, code: 'redirect_not_followed', retryable: false, httpStatus: 302 });
    expect(hits).toHaveLength(1);
    expect(redirectTargetHits).toBe(0);
  });

  test('status classification: 5xx and 429 are retryable, other 4xx are not', async () => {
    mode = '500'; expect(await send()).toMatchObject({ ok: false, code: 'http_server_error', retryable: true, httpStatus: 500 });
    mode = '429'; expect(await send()).toMatchObject({ ok: false, code: 'rate_limited_by_receiver', retryable: true });
    mode = '400'; expect(await send()).toMatchObject({ ok: false, code: 'http_client_error', retryable: false });
  });

  test('a receiver that never answers is cut off by the timeout', async () => {
    mode = 'hang';
    const t0 = Date.now();
    const r = await send('/hook', '{}', dev(), { timeoutMs: 300 });
    expect(r).toMatchObject({ ok: false, code: 'timeout', retryable: true });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test('an endless response body is discarded after a small cap and the delivery still completes', async () => {
    mode = 'flood';
    const t0 = Date.now();
    const r = await send('/hook', '{}', dev(), { timeoutMs: 4000 });
    expect(r.httpStatus).toBe(200);
    expect(r.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(3500);
  });

  test('an oversized notification body is refused before any connection is made', async () => {
    mode = 'ok'; hits = [];
    const r = await send('/hook', 'x'.repeat(WEBHOOK_LIMITS.maxBodyBytes + 1));
    expect(r).toMatchObject({ ok: false, code: 'body_too_large', retryable: false });
    expect(hits).toHaveLength(0);
  });

  test('strict policy: loopback receivers and plain http are refused at send time too, without a request', async () => {
    mode = 'ok'; hits = [];
    expect((await send('/hook', '{}', STRICT_POLICY)).code).toBe('insecure_scheme');
    expect((await send('/hook', '{}', { ...STRICT_POLICY, allowInsecureHttp: true })).code).toBe('blocked_target');
    expect(hits).toHaveLength(0);
  });

  test('DNS rebinding: the connection goes to the address that was validated, not to a second lookup', async () => {
    mode = 'ok'; hits = [];
    // 'pinned.example.test' does not exist in real DNS. It can only be reached if the connection uses the validated (resolver) answer.
    const policy = dev({ resolver: async () => ['127.0.0.1'] });
    const r = await sendWebhook({ url: `http://pinned.example.test:${port}/hook`, secret: 'topsecret-signing-key-1', event: 'test', deliveryId: 'd', body: '{}', now }, { policy });
    expect(r.ok).toBe(true);
    expect(hits[0]!.headers.host).toBe(`pinned.example.test:${port}`);
  });

  test('DNS rebinding: a name that flips to a private address after being saved is blocked at send time', async () => {
    mode = 'ok'; hits = [];
    let answers = ['93.184.216.34'];
    const policy: NetworkPolicy = { ...STRICT_POLICY, resolver: async () => answers };
    expect(await codeOf(checkWebhookTarget('https://rebind.example.com/hook', policy))).toBe('allowed'); // save time: public
    answers = ['169.254.169.254']; // the attacker's DNS now answers with the metadata service
    const r = await sendWebhook({ url: 'https://rebind.example.com/hook', secret: 'topsecret-signing-key-1', event: 'test', deliveryId: 'd', body: '{}', now }, { policy });
    expect(r).toMatchObject({ ok: false, code: 'blocked_target', retryable: false });
    expect(hits).toHaveLength(0);
  });
});
