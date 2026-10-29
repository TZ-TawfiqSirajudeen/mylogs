import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { runConnectorContract, testContext } from '@nexus/connector-sdk';
import { STRICT_POLICY, type NetworkPolicy } from '@nexus/security';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { isAllowedRedisCommand, redisConnector as c, safeRedisCall } from './redis.js';

const hasRedis = spawnSync('redis-server', ['--version']).status === 0;
const dev: NetworkPolicy = { ...STRICT_POLICY, allowLoopback: true };
const PASSWORD = 'redis-pass-123';

const procs: ChildProcess[] = [];
async function freePort(): Promise<number> {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
}
async function waitForPort(port: number) {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise<boolean>((r) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('redis-server did not start');
}
async function startRedis(extra: string[]): Promise<number> {
  const port = await freePort();
  procs.push(spawn('redis-server', ['--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', ...extra], { stdio: 'ignore' }));
  await waitForPort(port);
  return port;
}

let authPort = 0;
let openPort = 0;

beforeAll(async () => {
  if (!hasRedis) return;
  authPort = await startRedis(['--requirepass', PASSWORD]);
  openPort = await startRedis([]);
  const seed = new Redis({ port: authPort, password: PASSWORD });
  await seed.set('customer:1', 'secret-customer-data');
  await seed.set('session:abc', 'token-xyz');
  await seed.quit();
});
afterAll(() => { for (const p of procs) p.kill(); });

const cfg = (port: number, extra: object = {}) => c.configSchema.parse({ host: '127.0.0.1', port, tls: false, ...extra });
const run = (config: ReturnType<typeof cfg>, creds: Record<string, string> = {}, net: NetworkPolicy = dev) => c.test(testContext(net), config, creds);

describe('command allow-list (pure)', () => {
  test.each([
    [['PING'], true], [['INFO', 'memory'], true], [['info', 'STATS'], true], [['SLOWLOG', 'LEN'], true],
    [['CONFIG', 'GET', 'maxmemory'], true], [['ACL', 'WHOAMI'], true],
    [['GET', 'k'], false], [['KEYS', '*'], false], [['SCAN', '0'], false], [['FLUSHALL'], false], [['FLUSHDB'], false],
    [['CONFIG', 'SET', 'maxmemory', '1'], false], [['CONFIG', 'GET', 'requirepass'], false], [['CONFIG', 'GET', '*'], false],
    [['SLOWLOG', 'GET'], false], [['SLOWLOG', 'RESET'], false], [['INFO', 'commandstats'], false], [['INFO'], false],
    [['CLIENT', 'LIST'], false], [['DEBUG', 'SLEEP', '1'], false], [['EVAL', 'return 1', '0'], false], [['SHUTDOWN'], false],
    [['ACL', 'GETUSER', 'default'], false], [['MONITOR'], false], [['SUBSCRIBE', 'x'], false], [[''], false],
  ] as [string[], boolean][])('%j -> %s', (args, expected) => expect(isAllowedRedisCommand(args)).toBe(expected));

  test('safeRedisCall refuses before touching the client', async () => {
    const fake = { call: () => { throw new Error('should not be called'); } };
    await expect(safeRedisCall(fake as never, 'FLUSHALL')).rejects.toThrow(/not permitted/);
    await expect(safeRedisCall(fake as never, 'KEYS', '*')).rejects.toThrow(/not permitted/);
  });
});

describe.skipIf(!hasRedis)('against a real redis-server', () => {
  test('satisfies the connector contract', async () => {
    const results = await runConnectorContract(c, {
      valid: { config: cfg(authPort), creds: { password: PASSWORD }, authMethod: 'password' },
      wrongCreds: { creds: { password: 'wrong-password-1' } },
      unreachable: { config: cfg(1) },
      network: dev,
    });
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });

  test('reports metrics capabilities and facts; unsupported commands are explained, not hidden', async () => {
    const r = await run(cfg(authPort), { password: PASSWORD });
    expect(r.ok).toBe(true);
    const cap = Object.fromEntries(r.capabilities.map((x) => [x.id, x]));
    expect(cap.memory?.available).toBe(true);
    expect(cap.stats?.available).toBe(true);
    expect(cap.slowlog_len?.available).toBe(true);
    expect(r.facts.role).toBe('master');
    expect(typeof r.facts.version).toBe('string');
    expect(JSON.stringify(r)).not.toContain(PASSWORD);
  });

  test('wrong password and missing password are authentication failures', async () => {
    expect((await run(cfg(authPort), { password: 'nope-nope-nope' })).failure?.kind).toBe('authentication');
    expect((await run(cfg(authPort), {})).failure?.kind).toBe('authentication');
  });

  test('a passwordless instance works with the "none" method', async () => {
    expect((await run(cfg(openPort), {})).ok).toBe(true);
  });

  test('connection refused -> unreachable with remediation', async () => {
    const r = await run(cfg(await freePort()), {});
    expect(r.failure?.kind).toBe('unreachable');
    expect(r.failure?.remediation).toBeTruthy();
  });

  test('discovery returns key COUNTS only — never key names or values', async () => {
    const d = await c.discover(testContext(dev), cfg(authPort), { password: PASSWORD });
    const db0 = d.resources.find((x) => x.id.endsWith(':db0'));
    expect(db0?.attributes.keys).toBe(2);
    const dump = JSON.stringify(d);
    for (const leaked of ['customer:1', 'secret-customer-data', 'session:abc', 'token-xyz', PASSWORD]) expect(dump).not.toContain(leaked);
  });

  test('the monitoring session cannot modify data: nothing was written or changed by testing', async () => {
    await run(cfg(authPort), { password: PASSWORD });
    const check = new Redis({ port: authPort, password: PASSWORD });
    expect(await check.dbsize()).toBe(2);
    expect(await check.get('customer:1')).toBe('secret-customer-data');
    await check.quit();
  });

  test('strict network policy refuses loopback before connecting; TLS against a plain port fails clearly', async () => {
    const strict = await run(cfg(authPort), {}, STRICT_POLICY);
    expect(strict.failure?.kind).toBe('misconfigured');
    expect(strict.steps.some((s) => s.status === 'pass')).toBe(false);
    const tls = await run(cfg(openPort, { tls: true }), {});
    expect(tls.ok).toBe(false);
    expect(['misconfigured', 'unreachable', 'timeout']).toContain(tls.failure?.kind);
    expect(tls.failure?.remediation).toMatch(/TLS/); // actionable, not a bare timeout
  });
});

test('config: TLS is on by default; unknown fields are rejected', () => {
  expect(c.configSchema.parse({ host: 'h' }).tls).toBe(true);
  expect(c.configSchema.safeParse({ host: 'h', db: 3 }).success).toBe(false);
});
