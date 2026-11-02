import { ConnectionService } from '@nexus/connections';
import { MetricQuery } from '@nexus/contracts';
import {
  ConnectorError, ConnectorRegistry, type CollectionResult, type Connector, type ConnectorDescriptor, type ConnectorErrorKind, type TestReport,
} from '@nexus/connector-sdk';
import { AuditService, type Database } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import { connectorMetricSink, MongoMetricStore } from '@nexus/metricstore';
import { generateKeyBase64, parseKeyring, SecretStore } from '@nexus/secrets';
import { STRICT_POLICY } from '@nexus/security';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { MonitorWorker } from '../src/monitor.js';

// Service + worker level failure behaviour, with a scriptable fake database connector (the real connectors' failures are covered in packages/connectors),
// the real worker loop, the real platform database and the REAL metric store behind the sink.
const ORG = 'o', PROJECT = 'p', ENV = 'e';
const scope = { orgId: ORG, projectId: PROJECT, environmentIds: null };
const mscope = { orgId: ORG, projectId: PROJECT, environmentIds: [ENV] };
const actor = { userId: 'u', ctx: { requestId: 'req-resilience' } };

type TestMode = 'ok' | 'unhealthy' | 'unreachable' | 'auth' | 'hang' | 'hang-ignore';
type CollectMode = 'ok' | 'hang' | 'hang-ignore' | 'fail' | 'many' | 'gate';
interface Beh { test: TestMode; collect: CollectMode; counter: number; collects: number; tests: number; aborted: number; gate: Promise<void> | null; failKind: ConnectorErrorKind; series: number; ids: number }
const beh = new Map<string, Beh>();
const B = (tag: string): Beh => { let b = beh.get(tag); if (!b) { b = { test: 'ok', collect: 'ok', counter: 100, collects: 0, tests: 0, aborted: 0, gate: null, failKind: 'unreachable', series: 3000, ids: 0 }; beh.set(tag, b); } return b; };

const desc: ConnectorDescriptor = {
  type: 'fakedb', displayName: 'Fake DB', category: 'database', status: 'implemented', collection: 'implemented',
  signals: [{ signal: 'metrics', availability: 'supported' }, { signal: 'inventory', availability: 'supported' }],
  deploymentTypes: [], operations: [], configRequirements: [], limitations: [], requiredPermissions: [],
  authMethods: [{ id: 'none', label: 'None', recommended: true, description: '', secretFields: [] }],
};
const never = () => new Promise<never>(() => undefined);
const fake: Connector<{ tag: string }, Record<string, string>> = {
  descriptor: desc,
  configSchema: z.strictObject({ tag: z.string() }) as never,
  credentialSchema: () => z.object({}) as never,
  async test(ctx, config): Promise<TestReport> {
    const b = B(config.tag);
    b.tests++;
    const fail = (kind: ConnectorErrorKind, message: string): TestReport => ({ ok: false, steps: [], capabilities: [], facts: {}, durationMs: 1, failure: { kind, message, remediation: 'fix it' } });
    switch (b.test) {
      case 'unhealthy': return fail('unhealthy', 'At least one configured host failed');
      case 'unreachable': return fail('unreachable', 'down');
      case 'auth': return fail('authentication', 'credentials rejected');
      case 'hang': await new Promise((_, rej) => ctx.signal.addEventListener('abort', () => { b.aborted++; rej(new Error('aborted')); })); return fail('internal', 'x');
      case 'hang-ignore': return never();
      default: return { ok: true, steps: [{ id: 's', label: 'ok', status: 'pass' }], capabilities: [{ id: 'c', label: 'c', available: true }], facts: {}, durationMs: 1 };
    }
  },
  async discover() {
    return { resources: [{ id: 'inst', type: 'fake_instance', name: 'inst', attributes: {}, signals: ['metrics' as const, 'inventory' as const] }], capabilities: [], truncated: false };
  },
  async collect(ctx, config): Promise<CollectionResult> {
    const b = B(config.tag);
    b.collects++;
    if (b.collect === 'fail') throw new ConnectorError(b.failKind, 'collection failed', { remediation: 'fix it' });
    if (b.collect === 'hang') await new Promise((_, rej) => ctx.signal.addEventListener('abort', () => { b.aborted++; rej(new Error('aborted')); }));
    if (b.collect === 'hang-ignore') await never();
    if (b.collect === 'gate') await b.gate;
    if (b.collect === 'many') {
      // a connector that forgot to cap its own output: 3000 distinct series
      return { samples: Array.from({ length: b.series }, (_, i) => ({ name: 'fake.value', unit: '1', description: 'd', kind: 'gauge' as const, value: i, attributes: { id: String(i) } })), dropped: 0, notes: [] };
    }
    b.counter += 5;
    return { samples: [
      { name: 'fake.requests', unit: '{request}', description: 'cumulative', kind: 'sum', value: b.counter, attributes: {} },
      { name: 'fake.gauge', unit: '1', description: 'gauge', kind: 'gauge', value: 7, attributes: {} },
    ], dropped: 0, notes: [] };
  },
};

let platform: Awaited<ReturnType<typeof startTestMongo>>;
let db: Database;
let store: MongoMetricStore;
let clock = Date.now();
const writes: { connection: string; now: number; samples: number }[] = [];
let sinkGate: Promise<void> | null = null;

const realSink = () => connectorMetricSink(store);
const sink = {
  async write(ctx: Parameters<ReturnType<typeof realSink>['write']>[0], batch: Parameters<ReturnType<typeof realSink>['write']>[1], now: Date) {
    writes.push({ connection: batch.connectionName, now: now.getTime(), samples: batch.samples.length });
    if (sinkGate) await sinkGate;
    return realSink().write(ctx, batch, now);
  },
};
const make = (over: { testTimeoutMs?: number; collectTimeoutMs?: number; abortGraceMs?: number; fakeClock?: boolean } = {}) => new ConnectionService({
  db, secrets: new SecretStore(db, parseKeyring(`k:${generateKeyBase64()}`, 'k')), registry: new ConnectorRegistry().register(fake), audit: new AuditService(db),
  network: { ...STRICT_POLICY, allowLoopback: true }, testTimeoutMs: over.testTimeoutMs ?? 5_000, maxConnectionsPerEnvironment: 1_000,
  ...(over.collectTimeoutMs ? { collectTimeoutMs: over.collectTimeoutMs } : {}), ...(over.abortGraceMs !== undefined ? { abortGraceMs: over.abortGraceMs } : {}),
  sink, ...(over.fakeClock === false ? {} : { now: () => new Date(clock) }),
});

beforeAll(async () => {
  platform = await startTestMongo();
  db = await freshTestDatabase(platform.uri);
  store = new MongoMetricStore(db);
  const now = new Date();
  await db.c.organizations.insertOne({ _id: ORG, slug: 'o', name: 'O', createdAt: now });
  await db.c.projects.insertOne({ _id: PROJECT, orgId: ORG, slug: 'p', name: 'P', description: '', owningTeam: '', createdBy: 'u', createdAt: now, updatedAt: now });
  await db.c.environments.insertOne({ _id: ENV, orgId: ORG, projectId: PROJECT, slug: 'e', name: 'E', isProduction: false, createdAt: now });
}, 300_000);
afterAll(async () => { await db?.close(); await platform?.stop(); });
// claimDue is global (it takes ANY due connection), so connections left over from earlier tests are parked far in the future first
beforeEach(async () => { await db.c.connections.updateMany({}, { $set: { 'health.nextCheckAt': new Date(Date.now() + 10 * 365 * 86_400_000), lease: null } }); });

/** Walks the real wizard path to an ACTIVE connection (the fake clock decides "now"). */
async function activeConnection(tag: string, svc: ConnectionService, pollSeconds = 30) {
  const c = await svc.create(scope, ENV, actor, { connectorType: 'fakedb', name: tag, authMethod: 'none', config: { tag }, secrets: {} });
  expect((await svc.test(scope, c.id, actor)).report.ok).toBe(true);
  await svc.discover(scope, c.id, actor);
  await svc.setSelection(scope, c.id, actor, { resourceIds: ['inst'], signals: ['metrics'] });
  await svc.setSettings(scope, c.id, actor, { pollIntervalSeconds: pollSeconds, sampling: 1, retentionDays: 7, redaction: { enabled: true, extraKeys: [] } });
  await svc.activate(scope, c.id, actor);
  return c.id;
}
const doc = (id: string) => db.c.connections.findOne({ _id: id }).then((d) => d!);
const makeDue = (id: string) => db.c.connections.updateOne({ _id: id }, { $set: { 'health.nextCheckAt': new Date(clock - 1) } });
const q = (over: Record<string, unknown>) => MetricQuery.parse({ from: new Date(Date.now() - 3_600_000).toISOString(), to: new Date(Date.now() + 3_600_000).toISOString(), stepSeconds: 60, ...over });
const writesFor = (name: string) => writes.filter((w) => w.connection === name);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('leases: a crashed or stalled worker never causes a double collection', () => {
  test('a worker that claims and dies: nobody else may take the connection until the lease expires, then exactly one worker does and collects once', async () => {
    const svc = make();
    const id = await activeConnection('crash-after-claim', svc);
    clock += 31_000; await makeDue(id);
    const a = await svc.claimDue('worker-A', 5);
    expect(a.map((x) => x._id)).toEqual([id]);
    // worker A is killed here: it never runs the check and never releases the lease
    expect(await svc.claimDue('worker-B', 5)).toEqual([]);
    clock += svc.leaseMs() - 1_000;
    expect(await svc.claimDue('worker-B', 5)).toEqual([]); // still inside the lease
    clock += 2_000;
    const takeover = await svc.claimDue('worker-B', 5);
    expect(takeover.map((x) => x._id)).toEqual([id]);
    expect(await svc.claimDue('worker-C', 5)).toEqual([]); // and only one of them
    await svc.runMonitorCheck(takeover[0]!, 'worker-B');
    expect(B('crash-after-claim').collects).toBe(1);
    expect(writesFor('crash-after-claim')).toHaveLength(1);
    expect((await doc(id)).lease).toBeNull();
    expect((await doc(id)).collection.status).toBe('running');
  });

  test('the lease outlasts a run: it is longer than the health-check deadline plus the collection deadline (it used to be a fixed 120 s)', () => {
    expect(make({ testTimeoutMs: 120_000 }).leaseMs()).toBeGreaterThanOrEqual(120_000 + 120_000 + 30_000);
    expect(make({ testTimeoutMs: 5_000 }).leaseMs()).toBe(120_000);
    expect(make({ testTimeoutMs: 30_000, collectTimeoutMs: 90_000 }).leaseMs()).toBeGreaterThanOrEqual(150_000);
  });

  test('a stalled worker that wakes up after its lease was taken over does NOT write its readings or touch the status', async () => {
    const svc = make();
    const id = await activeConnection('stalled-worker', svc);
    const b = B('stalled-worker');
    b.collect = 'gate';
    let release!: () => void;
    b.gate = new Promise<void>((r) => { release = r; });
    clock += 31_000; await makeDue(id);
    const [claimed] = await svc.claimDue('worker-A', 1);
    const aRun = svc.runMonitorCheck(claimed!, 'worker-A'); // health check passes, collection is now blocked in the connector
    for (let i = 0; i < 100 && b.collects === 0; i++) await sleep(20);
    expect(b.collects).toBe(1);
    // A stalls (GC pause, frozen VM). Its lease runs out and worker B takes the connection over and collects.
    clock += svc.leaseMs() + 1_000; await makeDue(id);
    b.collect = 'ok';
    const [taken] = await svc.claimDue('worker-B', 1);
    expect(taken?._id).toBe(id);
    await svc.runMonitorCheck(taken!, 'worker-B');
    const writesBefore = writesFor('stalled-worker').length;
    const statusBefore = (await doc(id)).collection.lastSuccessfulCollectionAt;
    release(); await aRun; // A wakes up with a reading taken before the takeover
    expect(writesFor('stalled-worker')).toHaveLength(writesBefore); // nothing more was written
    expect((await doc(id)).collection.lastSuccessfulCollectionAt).toEqual(statusBefore);
  });

  test('a worker killed MID-collection: after its lease expires and the next due time passes exactly one other worker collects, once', async () => {
    const svc = make();
    const id = await activeConnection('killed-mid-collect', svc);
    const b = B('killed-mid-collect');
    b.collect = 'hang-ignore';
    clock += 31_000; await makeDue(id);
    const [claimed] = await svc.claimDue('worker-A', 1);
    void svc.runMonitorCheck(claimed!, 'worker-A'); // never finishes: the process "died"
    for (let i = 0; i < 100 && b.collects === 0; i++) await sleep(20);
    expect(b.collects).toBe(1);
    const mid = await doc(id);
    expect(mid.health.nextCheckAt!.getTime()).toBeGreaterThan(clock); // the health check was recorded: the next run is a full interval away
    expect(await svc.claimDue('worker-B', 5)).toEqual([]); // no storm: nothing is due, and A still holds the lease
    clock += svc.leaseMs() + 40_000; // lease expired and the connection is due again
    b.collect = 'ok';
    const t = await svc.claimDue('worker-B', 5);
    expect(t.map((x) => x._id)).toEqual([id]);
    expect(await svc.claimDue('worker-C', 5)).toEqual([]);
    await svc.runMonitorCheck(t[0]!, 'worker-B');
    expect(b.collects).toBe(2);
    expect(writesFor('killed-mid-collect')).toHaveLength(1); // A never wrote; B wrote once
  });
});

describe('no duplicate samples, whatever the retries and races', () => {
  test('the same reading delivered twice, an OLDER reading arriving late, and two writers racing on one counter: the stored increase is exactly the true increase', async () => {
    const batch = (value: number) => ({ connectionId: 'c-idem', connectionName: 'idem', connectorType: 'mongodb', samples: [{ name: 'idem.requests', unit: '{request}', description: 'd', kind: 'sum' as const, value, attributes: {} }] });
    const ctx = { orgId: ORG, projectId: PROJECT, environmentId: ENV, retentionMs: 86_400_000 };
    const t0 = Date.now() - 600_000;
    const s = realSink();
    await s.write(ctx, batch(1000), new Date(t0));            // baseline
    await s.write(ctx, batch(1010), new Date(t0 + 60_000));   // +10
    await s.write(ctx, batch(1010), new Date(t0 + 60_000));   // exact replay (a retry): ignored
    await s.write(ctx, batch(1004), new Date(t0 + 30_000));   // older reading arriving late: ignored, must not look like a counter reset
    await s.write(ctx, batch(1020), new Date(t0 + 120_000));  // +10
    // two workers that both took the reading for t0+180s at (almost) the same moment and write concurrently
    await Promise.all([s.write(ctx, batch(1030), new Date(t0 + 180_000)), s.write(ctx, batch(1030), new Date(t0 + 180_500))]);
    const r = await store.query(mscope, q({ metric: 'idem.requests', agg: 'sum' }));
    const total = r.series.flatMap((x) => x.points).reduce((a, p) => a + (p.v ?? 0), 0);
    expect(total).toBe(30); // 1030 - 1000: every unit counted once
  });

  test('collection after a failure: the readings written before and after the outage add up to the true increase (the outage gap is not invented)', async () => {
    const svc = make();
    const id = await activeConnection('gap', svc);
    const b = B('gap');
    const runDue = async () => { clock += 31_000; await makeDue(id); const [c] = await svc.claimDue('w', 1); if (c) await svc.runMonitorCheck(c, 'w'); };
    await runDue(); // baseline: counter 105
    await runDue(); // +5
    b.collect = 'fail'; await runDue(); b.counter += 50; // the target keeps counting while collection fails
    b.collect = 'ok'; clock += 20 * 60_000; await runDue(); // after the back-off: 105+5+50 -> 160 => +5 +50 +5
    const r = await store.query(mscope, q({ metric: 'fake.requests', agg: 'sum', filters: [{ key: 'nexus.connection.name', value: 'gap' }] }));
    const total = r.series.flatMap((x) => x.points).reduce((a, p) => a + (p.v ?? 0), 0);
    expect(total).toBe(b.counter - 105); // everything after the baseline, counted once
  });
});

describe('backoff, jitter and health state transitions', () => {
  test('a collection that keeps failing backs off exponentially with jitter, never beyond 15 minutes, and many failing connections do not synchronise', async () => {
    const svc = make();
    const ids: string[] = [];
    for (let i = 0; i < 12; i++) { const id = await activeConnection(`jitter-${i}`, svc); B(`jitter-${i}`).collect = 'fail'; ids.push(id); }
    const next: number[][] = ids.map(() => []);
    for (let round = 0; round < 9; round++) {
      clock += 16 * 60_000;
      for (const id of ids) await makeDue(id);
      for (const c of await svc.claimDue('w', 50)) await svc.runMonitorCheck(c, 'w');
      for (const [i, id] of ids.entries()) { const d = await doc(id); next[i]!.push(d.health.nextCheckAt!.getTime() - clock); }
    }
    for (const delays of next) expect(Math.max(...delays)).toBeLessThanOrEqual(15 * 60_000);
    const last = next.map((d) => d.at(-1)!);
    expect(new Set(last).size).toBeGreaterThan(8); // spread across the ceiling, not 12 connections hitting the same instant
    const first = next.map((d) => d[0]!);
    expect(Math.min(...first)).toBeGreaterThanOrEqual(30_000); // a failure never polls MORE often than the interval
    const d = await doc(ids[0]!);
    expect(d.collection).toMatchObject({ status: 'stopped' });
    expect(d.collection.consecutiveFailures).toBeGreaterThanOrEqual(9);
  });

  test('a polling interval longer than the back-off ceiling: failures never make polling MORE frequent than a healthy connection', async () => {
    const svc = make();
    const id = await activeConnection('hourly', svc, 3600);
    B('hourly').collect = 'fail';
    clock += 3_601_000; await makeDue(id);
    for (const c of await svc.claimDue('w', 5)) await svc.runMonitorCheck(c, 'w');
    const d = await doc(id);
    expect(d.health.nextCheckAt!.getTime() - clock).toBeGreaterThanOrEqual(3_600_000);
  });

  test('state machine: healthy -> degraded(one member down: still collecting, normal interval) -> unreachable(collection stopped, backing off) -> authentication_expired -> healthy(running again)', async () => {
    const svc = make();
    const id = await activeConnection('lifecycle', svc);
    const b = B('lifecycle');
    const step = async () => { clock += 31_000; await makeDue(id); const [c] = await svc.claimDue('w', 1); expect(c?._id).toBe(id); await svc.runMonitorCheck(c!, 'w'); return doc(id); };
    let d = await step();
    expect(d.health.state).toBe('healthy');
    expect(d.collection.status).toBe('running');
    const collectsBefore = b.collects;

    b.test = 'unhealthy'; // e.g. one replica-set member is down: the survivors must still be collected
    d = await step();
    expect(d.health.state).toBe('degraded');
    expect(b.collects).toBe(collectsBefore + 1);
    expect(d.collection.status).toBe('running');
    expect(d.health.nextCheckAt!.getTime() - clock).toBeLessThan(40_000); // not backed off: the target answers
    d = await step();
    expect(b.collects).toBe(collectsBefore + 2);

    b.test = 'unreachable';
    d = await step();
    expect(d.health.state).toBe('unreachable');
    expect(d.collection.status).toBe('stopped'); // never left "running" with a growing lag
    expect(b.collects).toBe(collectsBefore + 2);
    expect(d.health.nextCheckAt!.getTime() - clock).toBeGreaterThan(40_000); // backing off
    const failing = d.health.consecutiveFailures;

    b.test = 'auth';
    clock += 16 * 60_000; d = await step();
    expect(d.health.state).toBe('authentication_expired'); // it worked before, so this is an expired/revoked credential
    expect(d.health.consecutiveFailures).toBe(failing + 1);

    b.test = 'ok';
    clock += 16 * 60_000; d = await step();
    expect(d.health.state).toBe('healthy');
    expect(d.health.consecutiveFailures).toBe(0);
    expect(d.collection).toMatchObject({ status: 'running', consecutiveFailures: 0, lastError: null });
  });
});

describe('a failing connection cannot starve or stall the others', () => {
  test('hung targets (one that honours cancellation, one that ignores it) occupy worker slots only up to their deadline; healthy connections are then checked, and the hung ones back off', async () => {
    const svc = make({ testTimeoutMs: 400, abortGraceMs: 100, fakeClock: false });
    const hung = ['hung-honours', 'hung-ignores'];
    const healthy = ['ok-1', 'ok-2', 'ok-3', 'ok-4'];
    const ids: Record<string, string> = {};
    for (const t of [...healthy, ...hung]) ids[t] = await activeConnection(t, svc);
    B('hung-honours').test = 'hang'; B('hung-ignores').test = 'hang-ignore'; // the targets hang after the wizard succeeded
    const past = Date.now() - 60_000;
    for (const [i, t] of hung.entries()) await db.c.connections.updateOne({ _id: ids[t]! }, { $set: { 'health.nextCheckAt': new Date(past - 1000 + i) } }); // due FIRST
    for (const t of healthy) await db.c.connections.updateOne({ _id: ids[t]! }, { $set: { 'health.nextCheckAt': new Date(past + 1000) } });
    const w = new MonitorWorker(svc, { owner: 'starve-test', concurrency: 2, tickMs: 100, draftPurgeEveryMs: 1e12 });
    const t0 = Date.now();
    await w.tick();                       // both slots go to the hung connections
    expect(w.metrics.inflight).toBe(2);
    expect(await w.tick()).toBe(0);       // no free slot: nothing else is started, and nothing piles up
    await w.idle();                       // freed at the deadline, not at "never"
    expect(Date.now() - t0).toBeLessThan(3_000);
    for (const t of hung) {
      const d = await doc(ids[t]!);
      expect(d.health.state, t).toBe('unreachable');
      expect(d.health.lastError!.kind).toBe('timeout');
      expect(d.lease, t).toBeNull();
      expect(d.health.nextCheckAt!.getTime(), t).toBeGreaterThan(Date.now() + 30_000); // backed off: they will not be picked first again
    }
    expect(B('hung-honours').aborted).toBe(1); // the honouring connector really was told to stop
    for (let i = 0; i < 5 && healthy.some((t) => B(t).tests < 2); i++) { await w.tick(); await w.idle(); }
    for (const t of healthy) expect((await doc(ids[t]!)).health.state, t).toBe('healthy');
    expect(await w.tick()).toBe(0); // the hung connections are not due: they no longer compete for slots
  }, 30_000);

  test('a collection that ignores its cancellation is cut at the collection deadline: recorded as a timeout, lease released, next run backed off', async () => {
    const svc = make({ collectTimeoutMs: 300, abortGraceMs: 100, fakeClock: false });
    const id = await activeConnection('collect-ignores', svc);
    B('collect-ignores').collect = 'hang-ignore';
    await db.c.connections.updateOne({ _id: id }, { $set: { 'health.nextCheckAt': new Date(Date.now() - 1000) } });
    const t0 = Date.now();
    const [c] = await svc.claimDue('w', 1);
    await svc.runMonitorCheck(c!, 'w');
    expect(Date.now() - t0).toBeLessThan(3_000);
    const d = await doc(id);
    expect(d.collection).toMatchObject({ status: 'stopped', consecutiveFailures: 1 });
    expect(d.collection.lastError).toMatchObject({ kind: 'timeout' });
    expect(d.lease).toBeNull();
    expect(d.health.state).toBe('healthy'); // the health check itself passed; only the collection is failing
  }, 20_000);
});

describe('pathological cardinality', () => {
  test('a connector that returns 3000 distinct series without capping itself: at most 500 reach the store, the overflow is reported, the instance-level series survive', async () => {
    const svc = make();
    const id = await activeConnection('cardinality', svc);
    B('cardinality').collect = 'many';
    clock += 31_000; await makeDue(id);
    const [c] = await svc.claimDue('w', 1);
    await svc.runMonitorCheck(c!, 'w');
    const last = writesFor('cardinality').at(-1)!;
    expect(last.samples).toBe(500);
    const d = await doc(id);
    expect(d.collection.lastSeries).toBe(500);
    expect((d.collection.lastNotes ?? []).join(' ')).toMatch(/2500 series were dropped/);
    expect(d.collection.status).toBe('running');
    const series = await db.c.metricSeries.countDocuments({ name: 'fake.value' });
    expect(series).toBeLessThanOrEqual(500);
  });
});

describe('graceful shutdown in the middle of a collection', () => {
  test('grace period long enough: the in-flight collection finishes and its data is written; nothing new is claimed afterwards', async () => {
    const svc = make();
    const id = await activeConnection('shutdown-patient', svc);
    const b = B('shutdown-patient');
    b.collect = 'gate';
    let release!: () => void;
    b.gate = new Promise<void>((r) => { release = r; });
    clock += 31_000; await makeDue(id);
    const w = new MonitorWorker(svc, { owner: 'shutdown-a', concurrency: 2, tickMs: 100, draftPurgeEveryMs: 1e12 });
    await w.tick();
    for (let i = 0; i < 100 && b.collects === 0; i++) await sleep(20);
    setTimeout(release, 150);
    const { drained } = await w.stop(5_000);
    expect(drained).toBe(true);
    expect(writesFor('shutdown-patient')).toHaveLength(1);
    expect((await doc(id)).collection.status).toBe('running');
    expect((await doc(id)).lease).toBeNull();
  });

  test('grace period exhausted: the collection is ABORTED (socket closed), nothing is recorded as a failure of the target, the lease is released and another worker collects at once', async () => {
    const svc = make();
    const id = await activeConnection('shutdown-impatient', svc);
    const b = B('shutdown-impatient');
    b.collect = 'hang';
    clock += 31_000; await makeDue(id);
    const before = await doc(id);
    const w = new MonitorWorker(svc, { owner: 'shutdown-b', concurrency: 2, tickMs: 100, draftPurgeEveryMs: 1e12 });
    await w.tick();
    for (let i = 0; i < 100 && b.collects === 0; i++) await sleep(20);
    const t0 = Date.now();
    const { drained } = await w.stop(200);
    expect(drained).toBe(false);
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect(b.aborted).toBe(1); // the connector was told to stop talking to its target
    const after = await doc(id);
    expect(after.lease).toBeNull();
    expect(after.collection.consecutiveFailures).toBe(before.collection.consecutiveFailures ?? 0);
    expect(after.collection.lastError ?? null).toBeNull();
    expect(after.collection.status).not.toBe('stopped');
    expect(writesFor('shutdown-impatient')).toHaveLength(0);
    // the health check had already been recorded, so the next run is one normal interval away - NOT a failure back-off - and a replacement worker takes it then
    expect(after.health.nextCheckAt!.getTime() - clock).toBeLessThanOrEqual(30_000);
    b.collect = 'ok';
    clock += 31_000; await makeDue(id);
    const [c] = await svc.claimDue('replacement', 1);
    expect(c?._id).toBe(id);
    await svc.runMonitorCheck(c!, 'replacement');
    expect((await doc(id)).collection.status).toBe('running');
    expect(writesFor('shutdown-impatient')).toHaveLength(1);
  });
});
