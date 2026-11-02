import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { testContext, type ConnectorError, type MetricSample } from '@nexus/connector-sdk';
import { STRICT_POLICY, type NetworkPolicy } from '@nexus/security';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { redisConnector as c, redisTuning } from './redis.js';
import { bulk, err, fakeRedis, ok as OK, pong } from './testing/fake-redis.js';
import { FaultProxy, freePort } from './testing/fault-proxy.js';

// Real redis-server (5.0.14 on the development machine) for everything a real server can show; a small RESP fake only where a real Redis 5 cannot
// (ACL denials, oversized replies, TLS-speaking endpoints) - those tests say "fake" in their names.
const hasRedis = spawnSync('redis-server', ['--version']).status === 0;
const real = hasRedis ? describe : describe.skip;
const dev: NetworkPolicy = { ...STRICT_POLICY, allowLoopback: true };
const PASSWORD = 'redis-faults-pass-123';
const saved = { ...redisTuning };

const procs = new Map<number, ChildProcess>();
async function waitPort(port: number, up: boolean) {
  for (let i = 0; i < 100; i++) {
    const reachable = await new Promise<boolean>((r) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });
    if (reachable === up) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`port ${port} did not become ${up ? 'reachable' : 'unreachable'}`);
}
async function startRedis(extra: string[] = [], port?: number): Promise<number> {
  const p = port ?? await freePort();
  procs.set(p, spawn('redis-server', ['--port', String(p), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', ...extra], { stdio: 'ignore' }));
  await waitPort(p, true);
  return p;
}
async function killRedis(port: number) { procs.get(port)?.kill('SIGKILL'); procs.delete(port); await waitPort(port, false); }

const cfg = (port: number, extra: object = {}) => c.configSchema.parse({ host: '127.0.0.1', port, tls: false, ...extra });
const addr = (p: number) => `127.0.0.1:${p}`;
const collect = (port: number, creds: Record<string, string> = {}, extra: object = {}, signal?: AbortSignal) =>
  c.collect!(signal ? testContext(dev, signal) : testContext(dev), cfg(port, extra), creds, { resourceIds: [`instance:${addr(port)}`, `db:${addr(port)}:db0`], signals: ['metrics'] });
const settle = (p: Promise<{ samples: MetricSample[]; notes: string[] }>) => p.then((r) => ({ ok: true as const, r }), (e: ConnectorError) => ({ ok: false as const, e }));
const names = (s: MetricSample[]) => new Set(s.map((x) => x.name));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shrink = (o: Partial<typeof redisTuning>) => Object.assign(redisTuning, o);

let port = 0;
let certDir = '';
beforeAll(async () => {
  if (!hasRedis) return;
  port = await startRedis();
  const seed = new Redis({ port });
  await seed.set('k1', 'v1'); await seed.set('k2', 'v2');
  await seed.quit();
  certDir = mkdtempSync(path.join(tmpdir(), 'nexus-redis-tls-'));
  spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem'), '-days', '2', '-subj', '/CN=not-the-host.example', '-addext', 'subjectAltName=DNS:not-the-host.example'], { stdio: 'ignore' });
}, 60_000);
afterAll(() => { Object.assign(redisTuning, saved); for (const p of procs.values()) p.kill('SIGKILL'); if (certDir) rmSync(certDir, { recursive: true, force: true }); });

real('connection faults against a real redis-server', () => {
  test('connection cut at EVERY point of the conversation: always either a clear "unreachable" failure or a partial result with a note - never a crash, never a hang', async () => {
    const proxy = await FaultProxy.start(port);
    try {
      const outcomes: string[] = [];
      for (const cut of [0, 60, 400, 1_500, 2_500, 3_500, 5_000, 9_000, 14_000, 1e9]) {
        proxy.cutAfterServerBytes = cut;
        const t0 = Date.now();
        const o = await settle(collect(proxy.port));
        expect(Date.now() - t0, `cut ${cut}`).toBeLessThan(4_000);
        if (o.ok) {
          expect(o.r.samples.every((s) => Number.isFinite(s.value)), `cut ${cut}`).toBe(true);
          outcomes.push(o.r.notes.length ? 'partial' : 'full');
          if (o.r.notes.length) expect(o.r.notes.join(' '), `cut ${cut}`).toMatch(/unavailable|cut short/);
        } else {
          outcomes.push(`fail:${o.e.kind}`);
          expect(['unreachable', 'timeout'], `cut ${cut}: ${o.e.message}`).toContain(o.e.kind);
        }
      }
      expect(outcomes).toContain('full');
      expect(outcomes.some((x) => x.startsWith('fail:'))).toBe(true);
      expect(outcomes).toContain('partial'); // a reset after some sections arrived keeps those sections
    } finally { await proxy.stop(); }
  });

  test('a reset in the middle of a run that already has server metrics keeps them and says what is missing', async () => {
    const proxy = await FaultProxy.start(port);
    try {
      // bytes needed to get through the ready check and the first sections: find the smallest cut that yields a partial result
      let found: { samples: MetricSample[]; notes: string[] } | null = null;
      for (let cut = 800; cut <= 20_000 && !found; cut += 400) {
        proxy.cutAfterServerBytes = cut;
        const o = await settle(collect(proxy.port));
        if (o.ok && o.r.notes.length) found = o.r;
      }
      expect(found).not.toBeNull();
      expect(found!.samples.length).toBeGreaterThan(0);
      expect(found!.notes.join(' ')).toMatch(/INFO \w+ unavailable|cut short/);
    } finally { await proxy.stop(); }
  });

  test('server killed (SIGKILL) and restarted on the same port: unreachable while down, fully working after, counters visibly restart', async () => {
    const p = await startRedis();
    try {
      const before = await collect(p);
      const processed = before.samples.find((s) => s.name === 'redis.commands.processed')!.value;
      const uptime = before.samples.find((s) => s.name === 'redis.uptime')!.value;
      await sleep(1_100);
      await killRedis(p);
      const t0 = Date.now();
      await expect(collect(p)).rejects.toMatchObject({ kind: 'unreachable' });
      expect(Date.now() - t0).toBeLessThan(3_000);
      await startRedis([], p);
      const after = await collect(p);
      expect(after.notes).toEqual([]);
      expect(after.samples.find((s) => s.name === 'redis.uptime')!.value).toBeLessThan(uptime + 1.1); // a fresh process
      expect(after.samples.find((s) => s.name === 'redis.commands.processed')!.value).toBeLessThan(processed + 10); // the counter restarted (the sink detects this as a reset)
    } finally { await killRedis(p).catch(() => undefined); }
  });

  test('slow INFO (every reply delayed beyond the command timeout): one timeout, bounded - not one per section - and classified as a timeout', async () => {
    const proxy = await FaultProxy.start(port);
    proxy.mode = 'delay'; proxy.delayMs = 800;
    shrink({ connectMs: 300, commandMs: 300, runBudgetMs: 3_000 });
    try {
      const t0 = Date.now();
      await expect(collect(proxy.port)).rejects.toMatchObject({ kind: expect.stringMatching(/timeout|unreachable/) });
      expect(Date.now() - t0).toBeLessThan(2_500);
    } finally { Object.assign(redisTuning, saved); await proxy.stop(); }
  });

  test('a server that answers some sections and then goes silent: the run is cut at the run budget (not 6 x the command timeout) and keeps the sections it got', async () => {
    const proxy = await FaultProxy.start(port);
    shrink({ connectMs: 500, commandMs: 500, runBudgetMs: 2_000 });
    try {
      let partial: { samples: MetricSample[]; notes: string[] } | null = null;
      let worst = 0;
      for (const mute of [3_000, 4_000, 5_000, 6_000, 8_000, 12_000]) {
        proxy.muteAfterServerBytes = mute;
        const t0 = Date.now();
        const o = await settle(collect(proxy.port));
        worst = Math.max(worst, Date.now() - t0);
        if (o.ok && o.r.notes.length) partial ??= o.r;
      }
      expect(worst).toBeLessThan(3_500); // run budget 2 s + teardown; never commandMs x sections
      expect(partial).not.toBeNull();
      expect(partial!.samples.length).toBeGreaterThan(0);
      expect(partial!.notes.join(' ')).toMatch(/timed out|cut short|did not finish/);
    } finally { Object.assign(redisTuning, saved); await proxy.stop(); }
  });

  test('cancelling a run (deadline or shutdown) closes the socket on the server, promptly', async () => {
    const proxy = await FaultProxy.start(port);
    proxy.mode = 'delay'; proxy.delayMs = 5_000;
    const probe = new Redis({ port });
    try {
      const ctl = new AbortController();
      setTimeout(() => ctl.abort(), 300);
      const t0 = Date.now();
      await expect(collect(proxy.port, {}, {}, ctl.signal)).rejects.toMatchObject({ kind: 'cancelled' });
      expect(Date.now() - t0).toBeLessThan(2_000);
      await sleep(200);
      const clients = Number((/connected_clients:(\d+)/.exec(await probe.info('clients')))![1]);
      expect(clients).toBe(1); // only the probe itself: nothing leaked by the cancelled run
    } finally { probe.disconnect(); await proxy.stop(); }
  });

  test('AUTH: a wrong password and a missing password are authentication errors that say so and never echo the secret; a password sent to a server that has none is ignored by Redis and the run succeeds', async () => {
    const authPort = await startRedis(['--requirepass', PASSWORD]);
    try {
      const wrong = await settle(collect(authPort, { password: 'not-the-password-1' }));
      const missing = await settle(collect(authPort, {}));
      for (const [label, o] of [['wrong', wrong], ['missing', missing]] as const) {
        expect(o.ok, label).toBe(false);
        if (o.ok) continue;
        expect(o.e.kind, `${label}: ${o.e.message}`).toBe('authentication');
        expect(`${o.e.message} ${o.e.remediation ?? ''}`).not.toMatch(/not-the-password-1|a-password-for-no-auth-9|redis-faults-pass/);
      }
      const extra = await collect(port, { password: 'a-password-for-no-auth-9' });
      expect(extra.samples.length).toBeGreaterThan(5); // observed: ioredis only warns
      expect(JSON.stringify(extra)).not.toContain('a-password-for-no-auth-9');
      // the same through test(): a failed report, not an exception
      const rep = await c.test(testContext(dev), cfg(authPort), { password: 'not-the-password-1' });
      expect(rep.ok).toBe(false);
      expect(rep.failure!.kind).toBe('authentication');
    } finally { await killRedis(authPort); }
  });

  test('MAXCLIENTS reached: a refused connection is reported as such (not "unexpected error"), recovers once a slot frees', async () => {
    const limited = await startRedis(['--maxclients', '3']);
    const holders: Redis[] = [];
    try {
      // fill every slot: the server reserves some for itself on some builds, so keep opening until it refuses
      for (let i = 0; i < 40; i++) {
        const h = new Redis({ port: limited, maxRetriesPerRequest: 0, retryStrategy: () => null, lazyConnect: true });
        h.on('error', () => undefined);
        try { await h.connect(); await h.ping(); holders.push(h); } catch { h.disconnect(); break; }
      }
      expect(holders.length).toBeGreaterThan(0);
      const o = await settle(collect(limited));
      expect(o.ok).toBe(false);
      if (!o.ok) {
        expect(o.e.kind, o.e.message).not.toBe('internal');
        // observed: this Redis build (5.0.14 for Windows) just resets the connection when full, with no "max number of clients" reply
        expect(`${o.e.message} ${o.e.remediation ?? ''}`).toMatch(/maxclients/i);
      }
      for (const h of holders) h.disconnect();
      await sleep(200);
      const again = await collect(limited);
      expect(again.samples.length).toBeGreaterThan(5);
    } finally { for (const h of holders) h.disconnect(); await killRedis(limited); }
  });
});

describe('TLS misconfiguration (real TLS endpoint built with node:tls, self-signed certificate)', () => {
  const tlsEndpoint = async () => {
    const sockets = new Set<net.Socket>();
    const srv = tls.createServer({ key: readFileSync(path.join(certDir, 'key.pem')), cert: readFileSync(path.join(certDir, 'cert.pem')) }, (s) => { sockets.add(s); s.on('error', () => undefined); s.on('data', () => s.write(pong)); });
    srv.on('tlsClientError', () => undefined);
    srv.on('connection', (s) => { sockets.add(s); s.on('error', () => undefined); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    return { port: (srv.address() as net.AddressInfo).port, close: async () => { for (const s of sockets) s.destroy(); await new Promise<void>((r) => srv.close(() => r())); } };
  };

  test('tls=true against a TLS endpoint with an untrusted/mismatched certificate: misconfigured, with a certificate hint (verification is never switched off)', async () => {
    if (!certDir) return;
    const ep = await tlsEndpoint();
    shrink({ connectMs: 1_500, commandMs: 1_500, runBudgetMs: 4_000 });
    try {
      const o = await settle(collect(ep.port, {}, { tls: true }));
      expect(o.ok).toBe(false);
      if (!o.ok) { expect(o.e.kind, o.e.message).toBe('misconfigured'); expect(`${o.e.message} ${o.e.remediation}`).toMatch(/TLS|certificate/i); }
    } finally { Object.assign(redisTuning, saved); await ep.close(); }
  });

  test('tls=false against a TLS endpoint (plaintext into a TLS port): a clear error within the budget, not "unexpected"', async () => {
    if (!certDir) return;
    const ep = await tlsEndpoint();
    shrink({ connectMs: 1_000, commandMs: 1_000, runBudgetMs: 3_000 });
    try {
      const t0 = Date.now();
      const o = await settle(collect(ep.port, {}, { tls: false }));
      expect(Date.now() - t0).toBeLessThan(4_000);
      expect(o.ok).toBe(false);
      if (!o.ok) expect(o.e.kind, o.e.message).not.toBe('internal');
    } finally { Object.assign(redisTuning, saved); await ep.close(); }
  });

  real('tls=true against a plaintext Redis: a TLS-specific timeout message and remediation, not a bare "timed out"', () => {
    test('plaintext port', async () => {
      shrink({ connectMs: 600, commandMs: 600, runBudgetMs: 3_000 });
      try {
        const t0 = Date.now();
        const o = await settle(collect(port, {}, { tls: true }));
        expect(Date.now() - t0).toBeLessThan(3_500);
        expect(o.ok).toBe(false);
        if (!o.ok) { expect(['timeout', 'misconfigured']).toContain(o.e.kind); expect(`${o.e.message} ${o.e.remediation}`).toMatch(/TLS/); }
      } finally { Object.assign(redisTuning, saved); }
    });
  });
});

describe('hostile or limited endpoints (RESP fake - Redis 5 cannot do these)', () => {
  const SECTIONS: Record<string, string> = {
    '': 'redis_version:7.2.4\r\nredis_mode:standalone\r\nconnected_clients:3\r\nused_memory:1048576\r\n', // the ready check (INFO without a section)
    server: 'redis_version:7.2.4\r\nredis_mode:standalone\r\nuptime_in_seconds:50\r\n', clients: 'connected_clients:3\r\nblocked_clients:0\r\n',
    memory: 'used_memory:1048576\r\nused_memory_rss:2097152\r\n', stats: 'total_commands_processed:100\r\ninstantaneous_ops_per_sec:2\r\n', replication: 'role:master\r\nconnected_slaves:0\r\nmaster_repl_offset:0\r\n',
  };
  const info = (section = '', extra = '') => `# ${section || 'All'}\r\n${SECTIONS[section] ?? ''}${extra}`;
  const aclDenied = "NOPERM User nexus_monitor has no permissions to run the 'info' command";

  test('an ACL user that may INFO some sections but not others (e.g. +info|server only): partial result, a note naming the permission, never a crash', async () => {
    const f = await fakeRedis((a) => {
      const [cmd, sec] = [a[0]!.toLowerCase(), (a[1] ?? '').toLowerCase()];
      if (cmd === 'client') return OK;
      if (cmd === 'ping') return pong;
      if (cmd === 'info' && (sec === '' || sec === 'server' || sec === 'clients')) return bulk(info(sec));
      if (cmd === 'info') return err(aclDenied);
      return err('ERR unknown command');
    });
    try {
      const r = await collect(f.port);
      expect(names(r.samples).has('redis.clients.connected')).toBe(true);
      expect(names(r.samples).has('redis.memory.used')).toBe(false); // from INFO memory, which was refused: absent, not zero
      expect(r.notes.join(' ')).toMatch(/INFO memory unavailable \(The ACL user is not allowed to run a required command\)/);
      const rep = await c.test(testContext(dev), cfg(f.port), {});
      expect(rep.ok).toBe(false);
      expect(rep.failure!.kind).toBe('permission_denied');
      expect(rep.failure!.remediation).toMatch(/\+info/);
    } finally { await f.close(); }
  });

  test('an ACL user with no INFO at all: permission_denied (not "internal"), whether the refusal comes at connect time or at the first command', async () => {
    const f = await fakeRedis((a) => (a[0]!.toLowerCase() === 'ping' ? pong : err(aclDenied)));
    try {
      const o = await settle(collect(f.port));
      expect(o.ok).toBe(false);
      if (!o.ok) { expect(o.e.kind, o.e.message).toBe('permission_denied'); expect(o.e.remediation ?? '').toMatch(/info/i); }
    } finally { await f.close(); }
  });

  test('an endpoint that streams a huge INFO reply: cut at the response cap, fast, with an explanation - the reply is not buffered or parsed', async () => {
    // announces 64 MiB and really sends 8 MiB (more than any cap below 8 MiB can let through)
    const huge = Buffer.concat([Buffer.from(`$${64 * 1024 * 1024}\r\n`), Buffer.from('junk:value\r\n'.repeat(Math.ceil(8 * 1024 * 1024 / 12)))]);
    const f = await fakeRedis((a) => {
      if (a[0]!.toLowerCase() === 'info') return huge;
      return 'close';
    });
    shrink({ maxResponseBytes: 256 * 1024 });
    try {
      // keep feeding bytes after the header, as a real oversized reply would
      const t0 = Date.now();
      const o = await settle(collect(f.port));
      expect(o.ok).toBe(false);
      expect(Date.now() - t0).toBeLessThan(5_000);
      if (!o.ok) { expect(o.e.kind).toBe('misconfigured'); expect(o.e.message).toMatch(/more than 256 KiB/); }
    } finally { Object.assign(redisTuning, saved); await f.close(); }
  });

  test('an INFO reply with a pathological number of fields and keyspace databases still yields at most 500 series, in a deterministic order', async () => {
    const dbs = Array.from({ length: 5000 }, (_, i) => `db${i}:keys=${i},expires=0,avg_ttl=0`).join('\r\n');
    const f = await fakeRedis((a) => {
      const cmd = a[0]!.toLowerCase();
      if (cmd === 'ping') return pong;
      if (cmd === 'info') return bulk(info(a[1]?.toLowerCase() ?? '', `${dbs}\r\n`));
      return err('ERR unknown command');
    });
    try {
      const ids = [`instance:${addr(f.port)}`, ...Array.from({ length: 5000 }, (_, i) => `db:${addr(f.port)}:db${i}`)];
      const run = () => c.collect!(testContext(dev), cfg(f.port), {}, { resourceIds: ids, signals: ['metrics'] });
      const a = await run();
      const b = await run();
      expect(a.samples.length).toBe(500);
      expect(a.dropped).toBeGreaterThan(9_000);
      expect(a.samples.map((s) => `${s.name}|${s.attributes['db.namespace'] ?? ''}`)).toEqual(b.samples.map((s) => `${s.name}|${s.attributes['db.namespace'] ?? ''}`));
      expect(a.samples.some((s) => s.name === 'redis.uptime')).toBe(true); // server metrics come first, so the instance is never what gets dropped
    } finally { await f.close(); }
  });
});
