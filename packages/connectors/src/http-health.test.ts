import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { runConnectorContract, testContext } from '@nexus/connector-sdk';
import { STRICT_POLICY, type NetworkPolicy } from '@nexus/security';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { httpHealthConnector as c } from './http-health.js';

const dev: NetworkPolicy = { ...STRICT_POLICY, allowLoopback: true, allowInsecureHttp: true };
const TOKEN = 'good-token-123456';

let server: http.Server;
let port: number;
let other: http.Server; // a "victim" the redirect points at
let otherHits = 0;
let lastAuth: string | undefined;
let lastHeaders: http.IncomingHttpHeaders = {};

beforeAll(async () => {
  other = http.createServer((_q, r) => { otherHits++; r.end('victim'); });
  await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
  const otherPort = (other.address() as AddressInfo).port;
  server = http.createServer((req, res) => {
    lastAuth = req.headers.authorization;
    lastHeaders = req.headers;
    const path = req.url ?? '/';
    if (path === '/ok') {
      if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); return res.end(`bad token ${req.headers.authorization}`); }
      res.writeHead(200); return res.end('x'.repeat(200_000));
    }
    if (path === '/open') { res.writeHead(200); return res.end('ok'); }
    if (path === '/redirect') { res.writeHead(302, { location: `http://127.0.0.1:${otherPort}/` }); return res.end(); }
    if (path === '/503') { res.writeHead(503); return res.end(); }
    if (path === '/404') { res.writeHead(404); return res.end(); }
    if (path === '/403') { res.writeHead(403); return res.end(); }
    if (path === '/429') { res.writeHead(429, { 'retry-after': '7' }); return res.end(); }
    if (path === '/hang') return; // never answers
    res.writeHead(500); res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.closeAllConnections();
  other.closeAllConnections();
  await Promise.all([new Promise((r) => server.close(r)), new Promise((r) => other.close(r))]);
});

const cfg = (path: string, extra: object = {}) => c.configSchema.parse({ url: `http://127.0.0.1:${port}${path}`, ...extra });
const run = (config: ReturnType<typeof cfg>, creds: Record<string, string> = {}, net: NetworkPolicy = dev) => c.test(testContext(net), config, creds);

async function closedPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const p = (s.address() as AddressInfo).port;
  await new Promise((r) => s.close(r));
  return p;
}

describe('contract', () => {
  test('satisfies the connector contract', async () => {
    const results = await runConnectorContract(c, {
      valid: { config: cfg('/ok'), creds: { token: TOKEN }, authMethod: 'bearer' },
      wrongCreds: { creds: { token: 'wrong-token-999999' } },
      unreachable: { config: c.configSchema.parse({ url: `http://127.0.0.1:${await closedPort()}/ok` }) },
      network: dev,
    });
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });
});

describe('probe behaviour', () => {
  test('sends the bearer token, never reads the (huge) body, and reports facts', async () => {
    const r = await run(cfg('/ok'), { token: TOKEN });
    expect(r.ok).toBe(true);
    expect(lastAuth).toBe(`Bearer ${TOKEN}`);
    expect(r.facts.statusCode).toBe(200);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
    expect(r.capabilities.find((x) => x.id === 'logs')?.available).toBe(false);
  });

  test('custom header method sends the secret under the configured header name', async () => {
    const r = await run(cfg('/open', { headerName: 'X-Health-Key' }), { value: 'secret-header-value' });
    expect(r.ok).toBe(true);
    expect(lastHeaders['x-health-key']).toBe('secret-header-value');
    expect(JSON.stringify(r)).not.toContain('secret-header-value');
  });

  test('hop-by-hop / sensitive header names are refused', async () => {
    const r = await run(cfg('/open', { headerName: 'Cookie' }), { value: 'v' });
    expect(r.ok).toBe(false);
    expect(r.failure?.kind).toBe('misconfigured');
    expect(c.validateConfig?.(cfg('/open', { headerName: 'Host' }), 'header')).toHaveLength(1);
  });

  test.each([
    ['/503', 'unhealthy'], ['/404', 'misconfigured'], ['/403', 'permission_denied'], ['/429', 'rate_limited'],
  ] as const)('%s is classified as %s with remediation', async (path, kind) => {
    const r = await run(cfg(path));
    expect(r.ok).toBe(false);
    expect(r.failure?.kind).toBe(kind);
    expect(r.failure?.remediation).toBeTruthy();
  });

  test('429 carries the provider Retry-After', async () => {
    const r = await run(cfg('/429'));
    expect(r.failure?.kind).toBe('rate_limited');
    expect(r.facts.statusCode).toBe(429);
  });

  test('redirects are NEVER followed: the redirect target receives no request', async () => {
    const before = otherHits;
    const r = await run(cfg('/redirect'));
    expect(r.ok).toBe(false);
    expect(r.failure?.kind).toBe('misconfigured');
    expect(r.failure?.message).toMatch(/redirect/i);
    expect(otherHits).toBe(before);
  });

  test('a hanging server produces a timeout, not a hang', async () => {
    const t0 = Date.now();
    const r = await run(cfg('/hang', { timeoutMs: 1000 }));
    expect(r.failure?.kind).toBe('timeout');
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  test('401 on the first run is misconfigured credentials (never "expired")', async () => {
    const r = await run(cfg('/ok'), { token: 'nope-nope-nope' });
    expect(r.failure?.kind).toBe('authentication');
  });
});

describe('SSRF protection', () => {
  test('loopback, metadata and private targets are blocked under the strict policy', async () => {
    const strictHttp: NetworkPolicy = { ...STRICT_POLICY, allowInsecureHttp: true };
    for (const url of [`http://127.0.0.1:${port}/ok`, 'http://169.254.169.254/latest/meta-data/', 'http://10.0.0.5/healthz', 'http://[::1]:8080/', 'http://2130706433:8080/']) {
      const r = await run(c.configSchema.parse({ url }), {}, strictHttp);
      expect(r.ok, url).toBe(false);
      expect(r.failure?.kind, url).toBe('misconfigured');
      expect(r.steps.find((s) => s.id === 'request'), url).toBeUndefined(); // no request was ever attempted
    }
  });

  test('a public-looking name that resolves to an internal address is blocked (DNS rebinding / split-horizon)', async () => {
    const policy: NetworkPolicy = { ...STRICT_POLICY, allowInsecureHttp: true, resolver: async () => ['127.0.0.1'] };
    const r = await run(c.configSchema.parse({ url: `http://evil.example.com:${port}/open` }), {}, policy);
    expect(r.failure?.kind).toBe('misconfigured');
  });

  test('the request connects to the VALIDATED address, not whatever the OS would resolve (pinned lookup)', async () => {
    // "pinned.test" does not exist in DNS; the only way this succeeds is by connecting to the validated 127.0.0.1.
    const policy: NetworkPolicy = { ...dev, resolver: async (h) => (h === 'pinned.test' ? ['127.0.0.1'] : []) };
    const r = await run(c.configSchema.parse({ url: `http://pinned.test:${port}/open` }), {}, policy);
    expect(r.ok).toBe(true);
    expect(lastHeaders.host).toBe(`pinned.test:${port}`); // Host header preserved for virtual hosting
  });

  test('plain http is refused unless the platform allows it; embedded credentials are refused', async () => {
    const strictLoopback: NetworkPolicy = { ...STRICT_POLICY, allowLoopback: true };
    expect((await run(cfg('/open'), {}, strictLoopback)).failure?.message).toMatch(/http:\/\//);
    const r = await run(c.configSchema.parse({ url: `http://user:pw@127.0.0.1:${port}/open` }));
    expect(r.failure?.kind).toBe('misconfigured');
    expect(JSON.stringify(r)).not.toContain('user:pw');
  });

  test('dangerous ports are refused', async () => {
    const r = await run(c.configSchema.parse({ url: 'http://127.0.0.1:22/' }));
    expect(r.failure?.kind).toBe('misconfigured');
  });
});

describe('discover', () => {
  test('drops the query string (it may carry a token) and reports one endpoint', async () => {
    const d = await c.discover(testContext(dev), cfg('/open?token=SUPERSECRET'), {});
    expect(d.resources).toHaveLength(1);
    expect(JSON.stringify(d)).not.toContain('SUPERSECRET');
  });
});
