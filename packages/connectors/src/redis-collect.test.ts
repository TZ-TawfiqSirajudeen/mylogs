import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { testContext, type MetricSample } from '@nexus/connector-sdk';
import { STRICT_POLICY, type NetworkPolicy } from '@nexus/security';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { redisConnector as c, redisKeyspaceSamples, redisSamples, redisTargets } from './redis.js';

// These run against a REAL redis-server when one is installed (it is on the development machine: Redis 5.0.14). Without it only the pure tests run.
const hasRedis = spawnSync('redis-server', ['--version']).status === 0;
const real = hasRedis ? describe : describe.skip;
const dev: NetworkPolicy = { ...STRICT_POLICY, allowLoopback: true };
const PASSWORD = 'redis-collect-pass-123';
const SECRET_VALUE = 'secret-customer-data-xyz';

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

let port = 0;
let authPort = 0;
const cfg = (p: number, extra: object = {}) => c.configSchema.parse({ host: '127.0.0.1', port: p, tls: false, ...extra });
const addr = (p: number) => `127.0.0.1:${p}`;
const collect = (p: number, ids: string[], creds: Record<string, string> = {}) => c.collect!(testContext(dev), cfg(p), creds, { resourceIds: ids, signals: ['metrics'] });
const names = (s: MetricSample[]) => [...new Set(s.map((x) => x.name))].sort();

beforeAll(async () => {
  if (!hasRedis) return;
  port = await startRedis([]);
  authPort = await startRedis(['--requirepass', PASSWORD]);
  const seed = new Redis({ port });
  await seed.set('customer:1', SECRET_VALUE);
  await seed.set('customer:2', SECRET_VALUE);
  await seed.select(1);
  await seed.set('session:abc', SECRET_VALUE);
  await seed.quit();
}, 60_000);
afterAll(() => { for (const p of procs) p.kill(); });

real('collect() against a real redis-server', () => {
  test('instance selection: server metrics with correct kinds and units; no key counts, no key names, no values', async () => {
    const r = await collect(port, [`instance:${addr(port)}`]);
    const n = names(r.samples);
    for (const want of ['redis.clients.connected', 'redis.memory.used', 'redis.commands.processed', 'redis.commands.rate', 'redis.keyspace.hits', 'redis.keyspace.misses', 'redis.keys.evicted', 'redis.keys.expired',
      'redis.network.io', 'redis.uptime', 'redis.connections.received', 'redis.replication.offset']) expect(n, want).toContain(want);
    expect(n.some((x) => x.startsWith('redis.db.'))).toBe(false);
    expect(r.samples.every((s) => s.attributes['server.address'] === addr(port))).toBe(true);
    const get = (name: string) => r.samples.find((s) => s.name === name)!;
    expect(get('redis.clients.connected')).toMatchObject({ kind: 'gauge', unit: '{client}' });
    expect(get('redis.clients.connected').value).toBeGreaterThanOrEqual(1);
    expect(get('redis.memory.used')).toMatchObject({ kind: 'gauge', unit: 'By' });
    expect(get('redis.memory.used').value).toBeGreaterThan(100_000); // a live server uses more than ~100 KB, in bytes
    expect(get('redis.commands.processed')).toMatchObject({ kind: 'sum' });
    expect(get('redis.keyspace.hits')).toMatchObject({ kind: 'sum' });
    expect(r.samples.filter((s) => s.name === 'redis.network.io').map((s) => s.attributes.direction).sort()).toEqual(['in', 'out']);
    expect(r.samples.find((s) => s.name === 'redis.replication.offset')!.attributes['redis.role']).toBe('primary');
    expect(r.samples.some((s) => s.name === 'redis.memory.limit')).toBe(false); // maxmemory 0 = no limit: nothing to report
    expect(JSON.stringify(r)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(r)).not.toContain('customer:1');
    expect(r.samples.every((s) => Number.isFinite(s.value))).toBe(true);
  });

  test('database selection reports key COUNTS for exactly the chosen databases (an empty chosen database is 0, not a gap)', async () => {
    const r = await collect(port, [`db:${addr(port)}:db0`, `db:${addr(port)}:db5`]);
    const keys = (db: string) => r.samples.find((s) => s.name === 'redis.db.keys' && s.attributes['db.namespace'] === db)?.value;
    expect(keys('db0')).toBe(2);
    expect(keys('db5')).toBe(0);
    expect(keys('db1')).toBeUndefined(); // not selected
    expect(names(r.samples)).toEqual(['redis.db.keys', 'redis.db.keys_with_expiry']);
    expect(JSON.stringify(r)).not.toContain(SECRET_VALUE);
  });

  test('collecting never touches data: key-reading command counters on the server do not move', async () => {
    const probe = new Redis({ port });
    const stats = async () => { const raw = await probe.info('commandstats'); const m = new Map<string, number>(); for (const l of raw.split(/\r?\n/)) { const x = /^cmdstat_(\w+):calls=(\d+)/.exec(l); if (x) m.set(x[1]!, Number(x[2])); } return m; };
    const before = await stats();
    await collect(port, [`instance:${addr(port)}`, `db:${addr(port)}:db0`, `db:${addr(port)}:db1`]);
    const after = await stats();
    for (const cmd of ['get', 'set', 'mget', 'keys', 'scan', 'del', 'flushall', 'flushdb', 'config', 'eval', 'debug', 'monitor', 'type', 'ttl', 'hgetall', 'sscan']) {
      expect(after.get(cmd) ?? 0, cmd).toBe(before.get(cmd) ?? 0);
    }
    expect((after.get('info') ?? 0)).toBeGreaterThan(before.get('info') ?? 0); // it did read INFO
    await probe.quit();
  });

  test('works with a password; the wrong password is an authentication error; no secret appears in anything returned', async () => {
    const ok = await collect(authPort, [`instance:${addr(authPort)}`], { password: PASSWORD });
    expect(ok.samples.length).toBeGreaterThan(5);
    expect(JSON.stringify(ok)).not.toContain(PASSWORD);
    const bad = await collect(authPort, [`instance:${addr(authPort)}`], { password: 'wrong-password-1' }).catch((e) => e);
    expect(bad).toMatchObject({ kind: 'authentication' });
    expect(JSON.stringify({ m: bad.message })).not.toContain('wrong-password-1');
  });

  test('a selection that is not this connection is a configuration error; unreachable is unreachable; cancelled is cancelled', async () => {
    await expect(collect(port, [])).rejects.toMatchObject({ kind: 'misconfigured' });
    await expect(collect(port, ['instance:10.9.9.9:6379'])).rejects.toMatchObject({ kind: 'misconfigured' });
    await expect(collect(1, [`instance:${addr(1)}`])).rejects.toMatchObject({ kind: 'unreachable' });
    const ctl = new AbortController(); ctl.abort();
    await expect(c.collect!(testContext(dev, ctl.signal), cfg(port), {}, { resourceIds: [`instance:${addr(port)}`], signals: ['metrics'] })).rejects.toMatchObject({ kind: 'cancelled' });
  });

  test('discovery now offers database key counts as metrics too, so a chosen database can actually be collected', async () => {
    const d = await c.discover(testContext(dev), cfg(port), {});
    const db0 = d.resources.find((r) => r.id === `db:${addr(port)}:db0`)!;
    expect(db0.signals).toEqual(['metrics', 'inventory']);
  });
});

describe('Redis sample builders and selection parsing (pure)', () => {
  test('only fields the server returned are emitted; a replica reports its link; maxmemory 0 is not a limit; junk ids are ignored', () => {
    expect(redisSamples({}, 'h:1')).toEqual([]);
    const replica = redisSamples({ role: 'slave', master_link_status: 'down', master_repl_offset: '42', maxmemory: '1000', used_memory: '10' }, 'h:1');
    expect(replica.find((s) => s.name === 'redis.replication.link_up')).toMatchObject({ value: 0, attributes: { 'redis.role': 'replica' } });
    expect(replica.find((s) => s.name === 'redis.replication.offset')!.value).toBe(42);
    expect(replica.find((s) => s.name === 'redis.memory.limit')!.value).toBe(1000);
    expect(replica.some((s) => s.name === 'redis.replication.connected_replicas')).toBe(false);
    const primary = redisSamples({ role: 'master', connected_slaves: '2', master_repl_offset: '9' }, 'h:1');
    expect(primary.find((s) => s.name === 'redis.replication.connected_replicas')!.value).toBe(2);
    expect(redisSamples({ used_memory: 'not-a-number' }, 'h:1')).toEqual([]);
    expect(redisKeyspaceSamples({ db3: 'keys=7,expires=2,avg_ttl=0' }, 'h:1', ['db3', 'db4']).map((s) => [s.attributes['db.namespace'], s.name, s.value])).toEqual([
      ['db3', 'redis.db.keys', 7], ['db3', 'redis.db.keys_with_expiry', 2], ['db4', 'redis.db.keys', 0], ['db4', 'redis.db.keys_with_expiry', 0],
    ]);
    const t = redisTargets(cfg(6379), { resourceIds: ['instance:127.0.0.1:6379', 'db:127.0.0.1:6379:db2', 'db:127.0.0.1:6379:evil;rm', 'db:other:6379:db1'], signals: ['metrics'] });
    expect(t).toEqual({ address: '127.0.0.1:6379', server: true, dbs: ['db2'] });
  });
});
