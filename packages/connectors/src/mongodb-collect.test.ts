import { capSeries, MAX_SERIES_PER_CONNECTION, testContext, type MetricSample } from '@nexus/connector-sdk';
import { STRICT_POLICY, type NetworkPolicy } from '@nexus/security';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { databaseSamples, mongodbConnector as c, mongoTargets, replicationSamples, serverSamples } from './mongodb.js';

const dev: NetworkPolicy = { ...STRICT_POLICY, allowLoopback: true };
const ROOT = { user: 'root', pwd: 'root-pass-123' };
const SECRET_DOC = 'secret-customer-data@example.com';

let auth: MongoMemoryServer;
let rs: MongoMemoryReplSet;
let authPort = 0;
let rsPort = 0;

const cfg = (port: number, extra: object = {}) => c.configSchema.parse({ hosts: [{ host: '127.0.0.1', port }], tls: false, ...extra });
const label = (port: number) => `127.0.0.1:${port}`;
const collect = (config: ReturnType<typeof cfg>, creds: Record<string, string>, resourceIds: string[]) =>
  c.collect!(testContext(dev), config, creds, { resourceIds, signals: ['metrics'] });
const names = (samples: MetricSample[]) => [...new Set(samples.map((s) => s.name))].sort();

async function admin<T>(port: number, fn: (c: MongoClient) => Promise<T>): Promise<T> {
  const client = new MongoClient(`mongodb://${ROOT.user}:${ROOT.pwd}@127.0.0.1:${port}/?authSource=admin&directConnection=true`);
  await client.connect();
  try { return await fn(client); } finally { await client.close(); }
}

beforeAll(async () => {
  auth = await MongoMemoryServer.create({ auth: { enable: true, customRootName: ROOT.user, customRootPwd: ROOT.pwd } });
  authPort = Number(new URL(auth.getUri()).port);
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  rsPort = Number(new URL(rs.getUri()).port);
  await admin(authPort, async (cl) => {
    await cl.db('admin').command({ createUser: 'monitor', pwd: 'monitor-pass-123', roles: [{ role: 'clusterMonitor', db: 'admin' }] });
    await cl.db('admin').command({ createUser: 'reader', pwd: 'reader-pass-123', roles: [{ role: 'read', db: 'appdata' }] });
    await cl.db('appdata').collection('customers').insertMany(Array.from({ length: 5 }, (_, i) => ({ email: SECRET_DOC, i })));
    await cl.db('other').collection('things').insertOne({ x: 1 });
  });
}, 300_000);
afterAll(async () => { await auth?.stop(); await rs?.stop(); });

const MON = { password: 'monitor-pass-123' };
const monCfg = () => cfg(authPort, { username: 'monitor', authSource: 'admin' });

describe('collect(): what is sampled, with the least-privilege clusterMonitor user (real mongod)', () => {
  test('the instance selection yields server metrics only: no database metrics, no other members, no values from collections', async () => {
    const r = await collect(monCfg(), MON, [`instance:${label(authPort)}`]);
    const base = ['mongodb.connections.available', 'mongodb.connections.created', 'mongodb.connections.current', 'mongodb.network.io', 'mongodb.network.requests', 'mongodb.operations', 'mongodb.uptime'];
    const memory = names(r.samples).filter((n) => n.startsWith('mongodb.memory.'));
    expect(names(r.samples)).toEqual([...base, ...memory].sort());
    // memory metrics depend on the server version (mem.* up to 8.1, allocator figures on 8.x): at least one must exist, none may be invented
    expect(memory.length).toBeGreaterThan(0);
    expect(memory.every((n) => ['mongodb.memory.resident', 'mongodb.memory.virtual', 'mongodb.memory.allocated', 'mongodb.memory.heap'].includes(n))).toBe(true);
    expect(r.samples.every((s) => s.attributes['server.address'] === label(authPort))).toBe(true);
    expect(r.dropped).toBe(0);
    const ops = r.samples.filter((s) => s.name === 'mongodb.operations').map((s) => s.attributes.operation).sort();
    expect(ops).toEqual(['command', 'delete', 'getmore', 'insert', 'query', 'update']);
    const io = r.samples.filter((s) => s.name === 'mongodb.network.io').map((s) => s.attributes.direction).sort();
    expect(io).toEqual(['in', 'out']);
    expect(JSON.stringify(r)).not.toContain(SECRET_DOC);
    expect(JSON.stringify(r)).not.toContain(MON.password);
  });

  test('values are real: units, kinds and magnitudes come from the server (memory in bytes, counters cumulative, gauges instantaneous)', async () => {
    const r = await collect(monCfg(), MON, [`instance:${label(authPort)}`]);
    const get = (n: string, extra?: (s: MetricSample) => boolean) => r.samples.find((s) => s.name === n && (!extra || extra(s)))!;
    expect(get('mongodb.connections.current')).toMatchObject({ kind: 'gauge', unit: '{connection}' });
    expect(get('mongodb.connections.current').value).toBeGreaterThanOrEqual(1);
    expect(get('mongodb.connections.created')).toMatchObject({ kind: 'sum' });
    expect(get('mongodb.operations', (s) => s.attributes.operation === 'command')).toMatchObject({ kind: 'sum', unit: '{operation}' });
    const mem = r.samples.find((s) => s.name.startsWith('mongodb.memory.'))!;
    expect(mem).toMatchObject({ kind: 'gauge', unit: 'By' });
    expect(mem.value).toBeGreaterThan(10 * 1024 * 1024); // a running mongod holds more than 10 MiB, expressed in BYTES
    expect(get('mongodb.uptime').value).toBeGreaterThanOrEqual(0);
    expect(r.samples.every((s) => Number.isFinite(s.value))).toBe(true);
  });

  test('database selection yields statistics for exactly the chosen databases', async () => {
    const r = await collect(monCfg(), MON, [`db:${label(authPort)}:appdata`]);
    expect(names(r.samples)).toEqual(['mongodb.database.collections', 'mongodb.database.data_size', 'mongodb.database.index_size', 'mongodb.database.objects', 'mongodb.database.storage_size']);
    expect(r.samples.every((s) => s.attributes['db.namespace'] === 'appdata')).toBe(true);
    expect(r.samples.find((s) => s.name === 'mongodb.database.objects')!.value).toBe(5);
    expect(r.samples.find((s) => s.name === 'mongodb.database.collections')!.value).toBe(1);
    expect(r.samples.find((s) => s.name === 'mongodb.database.data_size')!.value).toBeGreaterThan(0);
    expect(JSON.stringify(r)).not.toContain('other'); // the unselected database never appears
    expect(JSON.stringify(r)).not.toContain(SECRET_DOC);
  });

  test('instance + two databases together; an id for a member that is not configured is ignored, not guessed', async () => {
    const r = await collect(monCfg(), MON, [`instance:${label(authPort)}`, `db:${label(authPort)}:appdata`, `db:${label(authPort)}:other`, 'instance:10.9.9.9:27017', 'db:10.9.9.9:27017:evil']);
    expect(new Set(r.samples.filter((s) => s.attributes['db.namespace']).map((s) => s.attributes['db.namespace']))).toEqual(new Set(['appdata', 'other']));
    expect(JSON.stringify(r)).not.toContain('10.9.9.9');
    expect(mongoTargets(monCfg(), { resourceIds: ['instance:10.9.9.9:27017'], signals: ['metrics'] })).toEqual([]);
  });

  test('collecting reads no documents: the server\'s own query counter does not move (commands only)', async () => {
    const queries = async () => (await admin(authPort, (cl) => cl.db('admin').command({ serverStatus: 1 }))).opcounters.query as number;
    const before = await queries();
    await collect(monCfg(), MON, [`instance:${label(authPort)}`, `db:${label(authPort)}:appdata`, `db:${label(authPort)}:other`]);
    const after = await queries();
    expect(after).toBe(before);
  });

  test('a selection that names no configured member is a configuration error with advice', async () => {
    await expect(collect(monCfg(), MON, ['instance:10.9.9.9:27017'])).rejects.toMatchObject({ kind: 'misconfigured' });
    await expect(collect(monCfg(), MON, [])).rejects.toMatchObject({ kind: 'misconfigured' });
  });

  test('wrong password -> authentication; a user without clusterMonitor -> permission_denied with remediation; nothing leaks', async () => {
    await expect(collect(cfg(authPort, { username: 'monitor' }), { password: 'wrong-wrong-1' }, [`instance:${label(authPort)}`])).rejects.toMatchObject({ kind: 'authentication' });
    const denied = await collect(cfg(authPort, { username: 'reader' }), { password: 'reader-pass-123' }, [`instance:${label(authPort)}`]).catch((e) => e);
    expect(denied).toMatchObject({ kind: 'permission_denied' }); // the service layer adds the standard remediation for this kind
    expect(JSON.stringify({ m: denied.message, r: denied.remediation })).not.toContain('reader-pass-123');
  });

  test('an unreachable member is unreachable (nothing invented); a cancelled run is cancelled', async () => {
    await expect(c.collect!(testContext(dev), cfg(1), {}, { resourceIds: [`instance:${label(1)}`], signals: ['metrics'] })).rejects.toMatchObject({ kind: expect.stringMatching(/unreachable|timeout/) });
    const ctl = new AbortController(); ctl.abort();
    await expect(c.collect!(testContext(dev, ctl.signal), monCfg(), MON, { resourceIds: [`instance:${label(authPort)}`], signals: ['metrics'] })).rejects.toMatchObject({ kind: 'cancelled' });
  });
});

describe('replica set (real single-node replica set)', () => {
  test('reports the member state as the server states it (1 = primary); a primary has no lag sample', async () => {
    const r = await collect(cfg(rsPort), {}, [`instance:${label(rsPort)}`]);
    const st = r.samples.find((s) => s.name === 'mongodb.replication.member_state')!;
    expect(st).toMatchObject({ kind: 'gauge', value: 1 });
    expect(st.attributes['mongodb.replica_set']).toBeTruthy();
    expect(r.samples.some((s) => s.name === 'mongodb.replication.lag')).toBe(false);
  });
});

describe('sample builders and the series cap (pure)', () => {
  test('a secondary reports lag in seconds behind the primary; a primary or a missing optime reports none; absent fields are not invented', () => {
    const t = new Date('2026-01-01T00:00:10Z');
    const rsDoc = { set: 'rs0', myState: 2, members: [{ stateStr: 'PRIMARY', optimeDate: t }, { self: true, stateStr: 'SECONDARY', optimeDate: new Date(t.getTime() - 4500) }] };
    const lag = replicationSamples(rsDoc, 'h:1').find((s) => s.name === 'mongodb.replication.lag')!;
    expect(lag.value).toBe(4.5);
    expect(replicationSamples({ set: 'rs0', myState: 2, members: [{ stateStr: 'PRIMARY' }, { self: true, stateStr: 'SECONDARY' }] }, 'h:1').some((s) => s.name === 'mongodb.replication.lag')).toBe(false);
    expect(serverSamples({}, 'h:1')).toEqual([]);
    expect(serverSamples({ tcmalloc: { generic: { current_allocated_bytes: 5 } } }, 'h:1').map((s) => s.name)).toEqual(['mongodb.memory.allocated']);
    expect(serverSamples({ mem: { resident: 2 } }, 'h:1')[0]).toMatchObject({ name: 'mongodb.memory.resident', value: 2 * 1024 * 1024 });
    expect(serverSamples({ connections: { current: 'NaN-ish', available: 5 } }, 'h:1').map((s) => s.name)).toEqual(['mongodb.connections.available']);
    expect(databaseSamples({ dataSize: 10 }, 'h:1', 'd').map((s) => s.name)).toEqual(['mongodb.database.data_size']);
  });

  test('the series cap keeps the first 500 distinct series (server metrics first), counts the rest, and ignores exact duplicates', () => {
    const mk = (i: number): MetricSample => ({ name: 'm', unit: '1', description: '', kind: 'gauge', value: i, attributes: { id: String(i) } });
    const many = Array.from({ length: MAX_SERIES_PER_CONNECTION + 25 }, (_, i) => mk(i));
    const r = capSeries([...many, mk(3)]);
    expect(r.samples).toHaveLength(MAX_SERIES_PER_CONNECTION);
    expect(r.dropped).toBe(25);
    expect(r.samples[0]!.attributes.id).toBe('0');
    expect(capSeries([mk(1), mk(1)]).samples).toHaveLength(1);
  });
});
