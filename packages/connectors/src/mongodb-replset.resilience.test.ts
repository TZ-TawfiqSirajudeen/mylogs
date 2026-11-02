import { testContext, type MetricSample } from '@nexus/connector-sdk';
import { STRICT_POLICY, type NetworkPolicy } from '@nexus/security';
import { MongoClient, type Document } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mongoTuning, mongodbConnector as c, replicationSamples } from './mongodb.js';
import { FaultProxy } from './testing/fault-proxy.js';

// REAL 3-member replica set (three mongod 8.2.6 processes, keyfile auth). Slow by nature (about 40 s); run with `pnpm --filter @nexus/connectors test:resilience`.
// Tests run in file order on purpose: read-only and healthy-set checks first, then the destructive ones (step-down, killing members).
const dev: NetworkPolicy = { ...STRICT_POLICY, allowLoopback: true };
const ROOT = { user: 'root', pwd: 'root-pass-123' };
const MON = { password: 'monitor-pass-123' };
const SECRET_DOC = 'secret-customer-data@example.com';

let rs: MongoMemoryReplSet;
let ports: number[] = [];
const addr = (p: number) => `127.0.0.1:${p}`;
const hostsOf = (ps: number[]) => ps.map((port) => ({ host: '127.0.0.1', port }));
const cfg = (ps: number[], extra: object = {}) => c.configSchema.parse({ hosts: hostsOf(ps), tls: false, username: 'monitor', authSource: 'admin', ...extra });
const collect = (ps: number[], ids: string[], creds: Record<string, string> = MON, extra: object = {}, signal?: AbortSignal) =>
  c.collect!(signal ? { ...testContext(dev), signal } : testContext(dev), cfg(ps, extra), creds, { resourceIds: ids, signals: ['metrics'] });
const instances = (ps: number[]) => ps.map((p) => `instance:${addr(p)}`);
const forMember = (samples: MetricSample[], port: number, name: string) => samples.find((s) => s.name === name && s.attributes['server.address'] === addr(port));

async function asRoot<T>(port: number, fn: (cl: MongoClient) => Promise<T>): Promise<T> {
  const cl = await new MongoClient(`mongodb://${ROOT.user}:${ROOT.pwd}@127.0.0.1:${port}/?authSource=admin&directConnection=true`).connect();
  try { return await fn(cl); } finally { await cl.close(true); }
}
const status = (port: number) => asRoot(port, (cl) => cl.db('admin').command({ replSetGetStatus: 1 }));
async function primaryPort(candidates = ports): Promise<number> {
  for (let i = 0; i < 60; i++) {
    for (const p of candidates) {
      try { const h = await asRoot(p, (cl) => cl.db('admin').command({ hello: 1 })); if (h.isWritablePrimary) return p; } catch { /* member down or mid-election */ }
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('no primary elected');
}
let deadPort = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const saved = { ...mongoTuning };
beforeAll(async () => {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 3, auth: { enable: true, customRootName: ROOT.user, customRootPwd: ROOT.pwd } } });
  ports = rs.servers.map((s) => Number(new URL(s.getUri()).port));
  const primary = await primaryPort();
  await asRoot(primary, async (cl) => {
    const admin = cl.db('admin');
    await admin.command({ createUser: 'monitor', pwd: MON.password, roles: [{ role: 'clusterMonitor', db: 'admin' }] });
    await admin.command({ createUser: 'reader', pwd: 'reader-pass-123', roles: [{ role: 'read', db: 'appdata' }] });
    // serverStatus and dbStats on appdata, and nothing else: no replSetGetStatus, no dbStats elsewhere
    await admin.command({ createRole: 'statusOnly', privileges: [{ resource: { cluster: true }, actions: ['serverStatus'] }, { resource: { db: 'appdata', collection: '' }, actions: ['dbStats'] }], roles: [] });
    await admin.command({ createUser: 'partial', pwd: 'partial-pass-123', roles: [{ role: 'statusOnly', db: 'admin' }] });
    await cl.db('appdata').collection('customers').insertMany(Array.from({ length: 5 }, (_, i) => ({ email: SECRET_DOC, i })), { writeConcern: { w: 'majority' } });
    await cl.db('other').collection('things').insertOne({ x: 1 }, { writeConcern: { w: 'majority' } });
  });
}, 240_000);
afterAll(async () => {
  Object.assign(mongoTuning, saved);
  // members killed by the destructive tests are already gone; stop whatever is left, then let the library remove its temp files
  for (const s of rs?.servers ?? []) if (s.state === 'running') await s.stop().catch(() => undefined);
  await rs?.stop().catch(() => undefined);
}, 60_000);

/** kill -9 equivalent (TerminateProcess on Windows): no clean shutdown, sockets just vanish */
const hardKill = (idx: number) => { const proc = (rs.servers[idx] as unknown as { instanceInfo?: { instance: { mongodProcess?: { kill(sig: string): void } } } }).instanceInfo?.instance.mongodProcess; proc?.kill('SIGKILL'); };

describe('3-member replica set: healthy', () => {
  test('collect() samples every member: states 1/2/2, lag only on secondaries, every member under its own address', async () => {
    const r = await collect(ports, instances(ports));
    const prim = await primaryPort();
    for (const p of ports) {
      expect(forMember(r.samples, p, 'mongodb.connections.current'), addr(p)).toBeDefined();
      const state = forMember(r.samples, p, 'mongodb.replication.member_state')!;
      expect(state.value).toBe(p === prim ? 1 : 2);
      expect(state.attributes['mongodb.replica_set']).toBe('testset');
      const lag = forMember(r.samples, p, 'mongodb.replication.lag');
      if (p === prim) expect(lag).toBeUndefined(); else { expect(lag).toBeDefined(); expect(lag!.value).toBeGreaterThanOrEqual(0); expect(lag!.value).toBeLessThan(5); }
    }
    expect(r.notes).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(MON.password);
  });

  test('test() and discover() see all three members, one writable primary, the replica-set name, and the databases', async () => {
    const rep = await c.test(testContext(dev), cfg(ports), MON);
    expect(rep.ok, JSON.stringify(rep.failure)).toBe(true);
    expect(rep.facts).toMatchObject({ topology: 'replica set', hostsChecked: 3 });
    const d = await c.discover(testContext(dev), cfg(ports), MON);
    const inst = d.resources.filter((x) => x.type === 'mongodb_instance');
    expect(inst).toHaveLength(3);
    expect(inst.filter((x) => x.attributes.writablePrimary === true)).toHaveLength(1);
    expect(inst.every((x) => x.attributes.replicaSet === 'testset')).toBe(true);
    expect(d.resources.filter((x) => x.type === 'mongodb_database').some((x) => x.name === 'appdata')).toBe(true);
  });

  test('read-only on every member: no write reaches the oplog, no insert/update/delete counter moves, whatever the read preference does', async () => {
    const writes = async (p: number) => asRoot(p, async (cl) => {
      const oplog = await cl.db('local').collection('oplog.rs').countDocuments({ op: { $ne: 'n' } }); // noops are the server's own heartbeat
      const ops = (await cl.db('admin').command({ serverStatus: 1, repl: 0, metrics: 0, locks: 0, wiredTiger: 0 })).opcounters as Document;
      return { oplog, insert: ops.insert, update: ops.update, delete: ops.delete };
    });
    const before = await Promise.all(ports.map(writes));
    for (let i = 0; i < 3; i++) await collect(ports, [...instances(ports), `db:${addr(ports[0]!)}:appdata`, `db:${addr(ports[1]!)}:appdata`, `db:${addr(ports[2]!)}:nonexistent_db`]);
    const after = await Promise.all(ports.map(writes));
    expect(after).toEqual(before);
    // a dbStats on a database that does not exist must not create it
    const names = await asRoot(await primaryPort(), (cl) => cl.db('admin').admin().listDatabases({ nameOnly: true }));
    expect(names.databases.map((x: { name: string }) => x.name)).not.toContain('nonexistent_db');
  });

  test('a secondary (read preference "secondaryPreferred", direct connection) answers by itself: collecting only from it works and never needs the primary', async () => {
    const prim = await primaryPort();
    const sec = ports.find((p) => p !== prim)!;
    const r = await collect([sec], [`instance:${addr(sec)}`, `db:${addr(sec)}:appdata`]);
    expect(forMember(r.samples, sec, 'mongodb.replication.member_state')!.value).toBe(2);
    const db = r.samples.filter((s) => s.name.startsWith('mongodb.database.'));
    expect(db.length).toBeGreaterThan(0);
    expect(db.every((s) => s.attributes['db.namespace'] === 'appdata')).toBe(true);
  });

  test('config mistakes against a replica set: the standalone list "one member only" works, a wrong-port entry degrades but does not hide the others', async () => {
    const dead = ports[0]! + 20000 > 65000 ? 1025 : ports[0]! + 20000;
    mongoTuning.serverSelectionMs = 600; mongoTuning.connectMs = 600;
    try {
      const r = await collect([...ports.slice(0, 2), dead], [...instances(ports.slice(0, 2)), `instance:${addr(dead)}`]);
      expect(r.samples.some((s) => s.attributes['server.address'] === addr(ports[0]!))).toBe(true);
      expect(r.notes.join('\n')).toContain(addr(dead));
      expect(r.samples.some((s) => s.attributes['server.address'] === addr(dead))).toBe(false);
    } finally { Object.assign(mongoTuning, saved); }
  });
});

describe('credentials and permissions on the replica set: partial results, never a crash', () => {
  test('wrong password -> authentication; user with no monitoring rights -> permission_denied; neither leaks the password', async () => {
    const bad = await collect(ports, instances(ports), { password: 'definitely-wrong-pass' }).catch((e) => e);
    expect(bad).toMatchObject({ kind: 'authentication' });
    expect(String(bad.message)).not.toContain('definitely-wrong-pass');
    const denied = await collect(ports, instances(ports), { password: 'reader-pass-123' }, { username: 'reader' }).catch((e) => e);
    expect(denied).toMatchObject({ kind: 'permission_denied' });
    expect(denied.remediation).toMatch(/clusterMonitor/);
    const rep = await c.test(testContext(dev), cfg(ports, { username: 'reader' }), { password: 'reader-pass-123' });
    expect(rep.ok).toBe(false);
    expect(rep.failure!.kind).toBe('permission_denied');
  });

  test('a user who can run serverStatus but not replSetGetStatus / dbStats elsewhere: collection succeeds with server metrics and clear notes', async () => {
    const prim = await primaryPort();
    const r = await collect([prim], [`instance:${addr(prim)}`, `db:${addr(prim)}:appdata`, `db:${addr(prim)}:other`], { password: 'partial-pass-123' }, { username: 'partial' });
    expect(r.samples.some((s) => s.name === 'mongodb.connections.current')).toBe(true);
    expect(r.samples.some((s) => s.name.startsWith('mongodb.replication'))).toBe(false);
    expect(r.samples.some((s) => s.name === 'mongodb.database.data_size' && s.attributes['db.namespace'] === 'appdata')).toBe(true);
    expect(r.samples.some((s) => s.attributes['db.namespace'] === 'other')).toBe(false);
    expect(r.notes.join('\n')).toMatch(/replication status unavailable \(The user is authenticated but not authorized/);
    expect(r.notes.join('\n')).toMatch(/statistics for database "other" unavailable/);
    expect(JSON.stringify(r)).not.toContain('partial-pass-123');
  });
});

describe('slow and silent members: bounded, and they do not take the healthy members down with them', () => {
  test('a member behind a firewall that drops packets costs its own budget, once; the other members are still collected', async () => {
    const proxy = await FaultProxy.start(ports[0]!);
    proxy.mode = 'blackhole';
    Object.assign(mongoTuning, { serverSelectionMs: 700, connectMs: 700, socketMs: 700, hostBudgetMs: 1_500 });
    try {
      const t0 = Date.now();
      const r = await collect([proxy.port, ports[1]!, ports[2]!], [`instance:${addr(proxy.port)}`, ...instances(ports.slice(1))]);
      const took = Date.now() - t0;
      expect(took).toBeLessThan(4_000); // concurrent: one budget, not one per member
      expect(r.samples.some((s) => s.attributes['server.address'] === addr(ports[1]!))).toBe(true);
      expect(r.samples.some((s) => s.attributes['server.address'] === addr(ports[2]!))).toBe(true);
      expect(r.samples.some((s) => s.attributes['server.address'] === addr(proxy.port))).toBe(false);
      expect(r.notes.join('\n')).toContain(addr(proxy.port));
    } finally { Object.assign(mongoTuning, saved); await proxy.stop(); }
  }, 20_000);

  test('a command that hangs after the handshake is cut at the member budget (not the 10 s socket timeout), keeping what the member answered earlier', async () => {
    const proxy = await FaultProxy.start(ports[1]!);
    Object.assign(mongoTuning, { serverSelectionMs: 3_000, connectMs: 3_000, socketMs: 30_000, hostBudgetMs: 2_500 });
    try {
      const ids = [`instance:${addr(proxy.port)}`, `db:${addr(proxy.port)}:appdata`];
      // measure how many bytes a full run needs, then mute the server partway: after serverStatus, before dbStats finishes
      proxy.muteAfterServerBytes = 6_000;
      const t0 = Date.now();
      const r: Awaited<ReturnType<typeof collect>> | Error = await collect([proxy.port, ports[2]!], [...ids, ...instances([ports[2]!])]).catch((e: Error) => e);
      const took = Date.now() - t0;
      expect(took).toBeLessThan(6_000);
      if (r instanceof Error) throw r;
      expect(r.samples.some((s) => s.attributes['server.address'] === addr(ports[2]!))).toBe(true);
      expect(r.notes.join('\n')).toMatch(/did not finish within|timed out/);
    } finally { Object.assign(mongoTuning, saved); await proxy.stop(); }
  }, 20_000);

  test('when the whole run is cancelled (deadline / shutdown) after one member answered, that member\'s samples are returned instead of being thrown away', async () => {
    const proxy = await FaultProxy.start(ports[0]!);
    proxy.mode = 'blackhole';
    Object.assign(mongoTuning, { serverSelectionMs: 30_000, connectMs: 30_000, socketMs: 30_000, hostBudgetMs: 30_000 });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 1_500);
    try {
      const t0 = Date.now();
      const r = await collect([proxy.port, ports[1]!], [`instance:${addr(proxy.port)}`, `instance:${addr(ports[1]!)}`], MON, {}, ctl.signal);
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(r.samples.some((s) => s.attributes['server.address'] === addr(ports[1]!))).toBe(true);
      expect(r.notes.join('\n')).toContain('Cancelled');
    } finally { Object.assign(mongoTuning, saved); await proxy.stop(); }
  }, 20_000);

  test('cancelling when NOTHING was gathered is a cancellation (the service turns it into a timeout), promptly', async () => {
    const proxy = await FaultProxy.start(ports[0]!);
    proxy.mode = 'blackhole';
    Object.assign(mongoTuning, { serverSelectionMs: 30_000, connectMs: 30_000, socketMs: 30_000, hostBudgetMs: 30_000 });
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 500);
    try {
      const t0 = Date.now();
      await expect(collect([proxy.port], [`instance:${addr(proxy.port)}`], MON, {}, ctl.signal)).rejects.toMatchObject({ kind: 'cancelled' });
      expect(Date.now() - t0).toBeLessThan(3_000);
    } finally { Object.assign(mongoTuning, saved); await proxy.stop(); }
  }, 20_000);
});

describe('replication lag with real member data', () => {
  test('a delayed secondary (secondaryDelaySecs 4) reports about the lag the primary itself sees; an undelayed one stays near zero', async () => {
    const prim = await primaryPort();
    const [delayed, normal] = ports.filter((p) => p !== prim) as [number, number];
    await asRoot(prim, async (cl) => {
      const conf = (await cl.db('admin').command({ replSetGetConfig: 1 })).config as Document;
      const m = (conf.members as Document[]).find((x) => String(x.host).endsWith(`:${delayed}`))!;
      m.priority = 0; m.secondaryDelaySecs = 4;
      conf.version = (conf.version as number) + 1;
      await cl.db('admin').command({ replSetReconfig: conf });
    });
    const stop = { v: false };
    const writer = (async () => {
      await asRoot(await primaryPort(), async (cl) => {
        for (let i = 0; !stop.v; i++) { await cl.db('appdata').collection('ticks').insertOne({ i }, { writeConcern: { w: 1 } }); await sleep(250); }
      });
    })();
    try {
      let lag = 0, other = 0, truth = 0;
      for (let i = 0; i < 40 && lag < 2.5; i++) {
        await sleep(500);
        const r = await collect([delayed, normal], [`instance:${addr(delayed)}`, `instance:${addr(normal)}`]);
        lag = forMember(r.samples, delayed, 'mongodb.replication.lag')?.value ?? 0;
        other = forMember(r.samples, normal, 'mongodb.replication.lag')?.value ?? 0;
      }
      const st = await status(await primaryPort());
      const wall = (port: number) => (st.members as Document[]).find((x) => String(x.name).endsWith(`:${port}`))!.lastAppliedWallTime as Date;
      truth = (wall(await primaryPort()).getTime() - wall(delayed).getTime()) / 1000;
      console.info(`OBSERVED delayed lag=${lag.toFixed(2)}s primary-view=${truth.toFixed(2)}s undelayed=${other.toFixed(2)}s`);
      expect(lag).toBeGreaterThan(2.5);
      expect(lag).toBeLessThan(9);
      expect(Math.abs(lag - truth)).toBeLessThan(4); // two independent views of the same quantity (heartbeat staleness allowed)
      expect(other).toBeLessThan(2.5);
    } finally { stop.v = true; await writer; }
  }, 90_000);

  test('(pure, on a real replSetGetStatus document) millisecond wall times are used, and the answer is never negative', async () => {
    const prim = await primaryPort();
    const sec = ports.find((p) => p !== prim)!;
    const doc = await status(sec);
    const out = replicationSamples(doc, addr(sec));
    const lag = out.find((s) => s.name === 'mongodb.replication.lag')!;
    expect(lag.value).toBeGreaterThanOrEqual(0);
    // a fractional-second value is only possible when wall times (ms) are used; optimeDate would give whole seconds
    const self = (doc.members as Document[]).find((m) => m.self)!;
    const primary = (doc.members as Document[]).find((m) => m.stateStr === 'PRIMARY')!;
    expect(lag.value).toBeCloseTo(Math.max(0, (primary.lastAppliedWallTime.getTime() - self.lastAppliedWallTime.getTime()) / 1000), 6);
  });
});

describe('primary step-down and member loss (destructive: runs last)', () => {
  test('collecting repeatedly through a primary step-down: every run returns data, never throws, and states are what the servers say', async () => {
    const prim = await primaryPort();
    const results: { samples: MetricSample[]; notes: string[] }[] = [];
    const errors: unknown[] = [];
    let done = false;
    const loop = (async () => {
      while (!done) {
        try { results.push(await collect(ports, instances(ports))); } catch (e) { errors.push(e); }
        await sleep(150);
      }
    })();
    await sleep(300);
    // step down and refuse to be re-elected for a few seconds; the command itself drops the connection, which is expected
    await asRoot(prim, (cl) => cl.db('admin').command({ replSetStepDown: 4, force: true }).catch(() => undefined));
    const newPrim = await (async () => { for (let i = 0; i < 40; i++) { const p = await primaryPort(); if (p !== prim) return p; await sleep(300); } return prim; })();
    await sleep(500);
    done = true; await loop;
    expect(errors).toEqual([]);
    expect(results.length).toBeGreaterThan(3);
    expect(newPrim).not.toBe(prim); // an election really happened
    for (const r of results) expect(new Set(r.samples.map((s) => s.attributes['server.address'])).size).toBeGreaterThanOrEqual(2); // at least two members answered each run
    const states = results.flatMap((r) => r.samples.filter((s) => s.name === 'mongodb.replication.member_state').map((s) => s.value));
    expect(states.every((v) => [1, 2, 3, 5, 7, 8, 9, 10].includes(v))).toBe(true);
    // after the dust settles exactly one member reports PRIMARY and the old primary reports lag like any other secondary
    const final = await collect(ports, instances(ports));
    expect(final.samples.filter((s) => s.name === 'mongodb.replication.member_state' && s.value === 1)).toHaveLength(1);
    expect(forMember(final.samples, prim, 'mongodb.replication.member_state')!.value).toBe(2);
  }, 60_000);

  test('a member killed between runs: the others are collected, the dead one is named in a note, test() says "unhealthy" (not a crash), and it stays bounded', async () => {
    const prim = await primaryPort();
    const victimIdx = ports.findIndex((p) => p !== prim);
    const victim = ports[victimIdx]!;
    deadPort = victim;
    Object.assign(mongoTuning, { serverSelectionMs: 800, connectMs: 800, socketMs: 2_000, hostBudgetMs: 3_000 });
    try {
      hardKill(victimIdx);
      const t0 = Date.now();
      const r = await collect(ports, instances(ports));
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(r.samples.some((s) => s.attributes['server.address'] === addr(victim))).toBe(false);
      for (const p of ports.filter((x) => x !== victim)) expect(forMember(r.samples, p, 'mongodb.uptime')).toBeDefined();
      expect(r.notes.join('\n')).toContain(addr(victim));
      const rep = await c.test(testContext(dev), cfg(ports), MON);
      expect(rep.ok).toBe(false);
      expect(rep.failure!.kind).toBe('unhealthy');
      expect(rep.failure!.message).toContain('At least one configured host failed');
      // the survivors still agree on one primary and the dead member is not invented as a secondary
      const again = await collect(ports.filter((p) => p !== victim), instances(ports.filter((p) => p !== victim)));
      expect(again.samples.filter((s) => s.name === 'mongodb.replication.member_state' && s.value === 1)).toHaveLength(1);
    } finally { Object.assign(mongoTuning, saved); }
  }, 60_000);

  test('the primary killed too (only one member left, no quorum): the survivor is reported as a secondary with NO lag figure; all members down -> unreachable', async () => {
    const alive = ports.filter((p) => p !== deadPort);
    expect(alive).toHaveLength(2);
    const prim = await primaryPort(alive);
    const survivor = alive.find((p) => p !== prim)!;
    const idx = ports.indexOf(prim);
    Object.assign(mongoTuning, { serverSelectionMs: 800, connectMs: 800, socketMs: 2_000, hostBudgetMs: 3_000 });
    try {
      hardKill(idx);
      // no quorum: the survivor steps down to SECONDARY once it notices (up to ~10 s). Poll the connector, not the server.
      // The survivor keeps its SECONDARY state throughout, but for the first seconds after the kill it has not noticed the primary is gone (heartbeat timeout).
      // Poll until the connector stops reporting a lag figure, and require that to happen: a lag against a dead primary must never be reported for long.
      let r = await collect([survivor], [`instance:${addr(survivor)}`]);
      for (let i = 0; i < 60 && forMember(r.samples, survivor, 'mongodb.replication.lag'); i++) { await sleep(500); r = await collect([survivor], [`instance:${addr(survivor)}`]); }
      expect(forMember(r.samples, survivor, 'mongodb.replication.member_state')!.value).toBe(2);
      expect(forMember(r.samples, survivor, 'mongodb.replication.lag')).toBeUndefined(); // there is no primary to be behind: never an invented number
      for (let i = 0; i < ports.length; i++) hardKill(i);
      await expect(collect(ports, instances(ports))).rejects.toMatchObject({ kind: expect.stringMatching(/unreachable|timeout/) });
      const rep = await c.test(testContext(dev), cfg(ports), MON);
      expect(rep.ok).toBe(false);
      expect(['unreachable', 'timeout']).toContain(rep.failure!.kind);
    } finally { Object.assign(mongoTuning, saved); }
  }, 120_000);
});
