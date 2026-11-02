import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import { ConnectionService } from '@nexus/connections';
import { createDefaultRegistry } from '@nexus/connectors';
import { MetricQuery } from '@nexus/contracts';
import { AuditService, type Database } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import { connectorMetricSink, MongoMetricStore } from '@nexus/metricstore';
import { generateKeyBase64, parseKeyring, SecretStore } from '@nexus/secrets';
import { STRICT_POLICY } from '@nexus/security';
import { MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MonitorWorker } from '../src/monitor.js';

// Everything here is real: the platform database, a monitored mongod, a monitored redis-server (when installed), the worker loop and the metric store.
const hasRedis = spawnSync('redis-server', ['--version']).status === 0;
const ORG = 'o', PROJECT = 'p', ENV = 'e';
const scope = { orgId: ORG, projectId: PROJECT, environmentIds: null };
const actor = { userId: 'u', ctx: { requestId: 'req-collect-worker' } };
const mscope = { orgId: ORG, projectId: PROJECT, environmentIds: [ENV] };

let platform: Awaited<ReturnType<typeof startTestMongo>>;
let target: MongoMemoryServer;
let targetPort = 0;
let db: Database;
let svc: ConnectionService;
let store: MongoMetricStore;
const procs: ChildProcess[] = [];
let redisProc: ChildProcess | null = null;
let redisPort = 0;

async function freePort(): Promise<number> {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
}
async function waitForPort(port: number, up = true) {
  for (let i = 0; i < 100; i++) {
    const ok = await new Promise<boolean>((r) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); r(true); }); s.once('error', () => r(false)); });
    if (ok === up) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`port ${port} did not become ${up ? 'reachable' : 'unreachable'}`);
}

beforeAll(async () => {
  platform = await startTestMongo();
  db = await freshTestDatabase(platform.uri);
  store = new MongoMetricStore(db);
  svc = new ConnectionService({
    db, secrets: new SecretStore(db, parseKeyring(`k:${generateKeyBase64()}`, 'k')), registry: createDefaultRegistry(), audit: new AuditService(db),
    network: { ...STRICT_POLICY, allowLoopback: true }, testTimeoutMs: 10_000, sink: connectorMetricSink(store),
  });
  const now = new Date();
  await db.c.organizations.insertOne({ _id: ORG, slug: 'o', name: 'O', createdAt: now });
  await db.c.projects.insertOne({ _id: PROJECT, orgId: ORG, slug: 'p', name: 'P', description: '', owningTeam: '', createdBy: 'u', createdAt: now, updatedAt: now });
  await db.c.environments.insertOne({ _id: ENV, orgId: ORG, projectId: PROJECT, slug: 'e', name: 'E', isProduction: false, createdAt: now });
  target = await MongoMemoryServer.create();
  targetPort = Number(new URL(target.getUri()).port);
  const t = await new MongoClient(target.getUri()).connect();
  await t.db('shop').collection('orders').insertMany(Array.from({ length: 12 }, (_, i) => ({ n: i, email: 'secret-customer@example.com' })));
  await t.close();
  if (hasRedis) {
    redisPort = await freePort();
    redisProc = spawn('redis-server', ['--port', String(redisPort), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
    procs.push(redisProc);
    await waitForPort(redisPort);
    const r = new Redis({ port: redisPort });
    await r.set('k1', 'v1'); await r.set('k2', 'v2');
    await r.quit();
  }
}, 300_000);
afterAll(async () => {
  for (const p of procs) p.kill();
  await db?.close(); await platform?.stop(); await target?.stop();
});

const worker = () => new MonitorWorker(svc, { owner: 'collect-worker', concurrency: 4, tickMs: 1000, draftPurgeEveryMs: 1e12 });
const due = (id: string) => db.c.connections.updateOne({ _id: id }, { $set: { 'health.nextCheckAt': new Date(Date.now() - 1000), lease: null } });
async function runOnce(id: string) { await due(id); const w = worker(); await w.tick(); await w.idle(); return svc.get(scope, id); }

/** The real wizard path: test, discover, choose resources + signals, settings, start. */
async function start(type: 'mongodb' | 'redis', name: string, pick: (ids: string[]) => string[], signals = ['metrics']) {
  const body = type === 'mongodb'
    ? { connectorType: 'mongodb', name, authMethod: 'none', config: { hosts: [{ host: '127.0.0.1', port: targetPort }], tls: false }, secrets: {} }
    : { connectorType: 'redis', name, authMethod: 'none', config: { host: '127.0.0.1', port: redisPort, tls: false }, secrets: {} };
  const c = await svc.create(scope, ENV, actor, body);
  expect((await svc.test(scope, c.id, actor)).report.ok).toBe(true);
  const { discovery } = await svc.discover(scope, c.id, actor);
  await svc.setSelection(scope, c.id, actor, { resourceIds: pick(discovery.resources.map((r) => r.id)), signals });
  await svc.setSettings(scope, c.id, actor, { pollIntervalSeconds: 30, sampling: 1, retentionDays: 3, redaction: { enabled: true, extraKeys: [] } });
  await svc.activate(scope, c.id, actor);
  return c.id;
}
const q = (over: Record<string, unknown>) => MetricQuery.parse({ from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date(Date.now() + 120_000).toISOString(), stepSeconds: 60, ...over });

describe('MongoDB: a worker tick collects the selected members and databases into the metric store', () => {
  let id = '';
  test('first tick: the connection becomes running, metrics exist, labelled as a connector source; unselected databases are absent; no data from collections', async () => {
    id = await start('mongodb', 'shop-mongo', (ids) => ids.filter((x) => x.startsWith('instance:') || x.endsWith(':shop')));
    const dto = await runOnce(id);
    expect(dto.health.state).toBe('healthy');
    expect(dto.collection).toMatchObject({ status: 'running', lastError: null, consecutiveFailures: 0 });
    expect(dto.collection.lastSuccessfulCollectionAt).toBeTruthy();
    expect(dto.collection.lastSeries).toBeGreaterThan(10);
    expect(dto.health.collectionLagSeconds).toBeLessThan(10);

    const names = (await store.names(mscope)).map((n) => n.name);
    for (const want of ['mongodb.connections.current', 'mongodb.operations', 'mongodb.uptime', 'mongodb.database.objects', 'mongodb.database.data_size']) expect(names, want).toContain(want);
    // (a query may group by at most two labels; the others are matched with exact filters, which is also how the Metrics page narrows to connector data)
    const objects = await store.query(mscope, q({ metric: 'mongodb.database.objects', agg: 'last', groupBy: ['db.namespace', 'nexus.connection.name'], filters: [{ key: 'nexus.source', value: 'connector' }, { key: 'db.system', value: 'mongodb' }] }));
    expect(objects.series).toHaveLength(1); // only the selected database
    expect(objects.series[0]!.labels).toMatchObject({ 'db.namespace': 'shop', 'nexus.connection.name': 'shop-mongo' });
    expect(objects.series[0]!.points.find((p) => p.v !== null)!.v).toBe(12);
    expect(JSON.stringify(await db.c.metricSeries.find({}).toArray())).not.toContain('secret-customer@example.com');
    expect((await store.names(mscope)).find((n) => n.name === 'mongodb.uptime')!.services).toEqual([]);
    expect(await db.c.services.countDocuments({})).toBe(0); // connector sources never enter the Services inventory
  });

  test('a healthy connection is not collected again before its interval; when due again, counters are recorded as increases', async () => {
    const w = worker();
    expect(await w.tick()).toBe(0); // not due
    const t = await new MongoClient(target.getUri()).connect();
    await t.db('shop').collection('orders').insertMany(Array.from({ length: 5 }, (_, i) => ({ n: 100 + i }))); // 5 more inserts
    await t.close();
    await new Promise((r) => setTimeout(r, 1100)); // distinct timestamp for the second reading
    const dto = await runOnce(id);
    expect(dto.collection.status).toBe('running');
    const inserts = await store.query(mscope, q({ metric: 'mongodb.operations', agg: 'sum', groupBy: ['operation'], filters: [{ key: 'operation', value: 'insert' }] }));
    const total = inserts.series[0]!.points.reduce((a, p) => a + (p.v ?? 0), 0);
    expect(total).toBe(5); // increase between the two readings; the first reading was only a baseline
    const objects = await store.query(mscope, q({ metric: 'mongodb.database.objects', agg: 'last' }));
    expect(objects.series[0]!.points.filter((p) => p.v !== null).at(-1)!.v).toBe(17);
  });

  test('deselecting metrics (inventory only) collects nothing and says so', async () => {
    const other = await start('mongodb', 'inventory-only', (ids) => ids.filter((x) => x.startsWith('instance:')), ['inventory']);
    const dto = await runOnce(other);
    expect(dto.collection.status).toBe('not_selected');
    expect(dto.health.state).toBe('healthy');
    expect((await db.c.metricSeries.countDocuments({ 'attrs': { $elemMatch: { k: 'nexus.connection.id', v: other } } }))).toBe(0);
  });
});

(hasRedis ? describe : describe.skip)('Redis (real redis-server): same path', () => {
  let id = '';
  test('instance + one database collected; the key count is a real count; no key names or values stored', async () => {
    id = await start('redis', 'cache', (ids) => ids.filter((x) => x.startsWith('instance:') || x.endsWith(':db0')));
    const dto = await runOnce(id);
    expect(dto.collection).toMatchObject({ status: 'running', lastError: null });
    const keys = await store.query(mscope, q({ metric: 'redis.db.keys', agg: 'last', groupBy: ['db.namespace', 'nexus.source'] }));
    expect(keys.series).toHaveLength(1);
    expect(keys.series[0]!.labels).toMatchObject({ 'db.namespace': 'db0', 'nexus.source': 'connector' });
    expect(keys.series[0]!.points.find((p) => p.v !== null)!.v).toBe(2);
    const names = (await store.names(mscope)).map((n) => n.name);
    for (const want of ['redis.clients.connected', 'redis.memory.used', 'redis.commands.processed', 'redis.uptime']) expect(names, want).toContain(want);
    const stored = JSON.stringify(await db.c.metricSeries.find({ name: /^redis\./ }).toArray());
    for (const secret of ['k1', 'v1', 'k2', 'v2']) expect(stored.includes(`"${secret}"`), secret).toBe(false);
  });

  test('when the target goes away the connection is unhealthy and collection is paused (never left "running"); it resumes after recovery', async () => {
    redisProc!.kill();
    await waitForPort(redisPort, false);
    const down = await runOnce(id);
    expect(down.health.state).toBe('unreachable');
    expect(down.collection.status).toBe('stopped');
    expect(down.collection.note).toMatch(/paused because the connection check is failing/);
    redisProc = spawn('redis-server', ['--port', String(redisPort), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
    procs.push(redisProc);
    await waitForPort(redisPort);
    // the failing check backed off; make it due and run again
    const back = await runOnce(id);
    expect(back.health.state).toBe('healthy');
    expect(back.collection.status).toBe('running');
    expect(back.collection.lastError).toBeNull();
  });
});
