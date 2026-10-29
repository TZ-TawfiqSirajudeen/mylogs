import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ConnectionService } from '@nexus/connections';
import { createDefaultRegistry } from '@nexus/connectors';
import { AuditService, type Database } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import { generateKeyBase64, parseKeyring, SecretStore } from '@nexus/secrets';
import { STRICT_POLICY } from '@nexus/security';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { MonitorWorker } from '../src/monitor.js';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let db: Database;
let svc: ConnectionService;
let server: http.Server;
let port: number;
let status = 200;
let delayMs = 0;
let concurrent = 0;
let maxConcurrent = 0;

const scope = { orgId: 'o', projectId: 'p', environmentIds: null };
const actor = { userId: 'u', ctx: { requestId: 'req-worker-001' } };

beforeAll(async () => {
  server = http.createServer((_req, res) => {
    concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent);
    setTimeout(() => { res.writeHead(status); res.end(); concurrent--; }, delayMs);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  mongo = await startTestMongo();
  db = await freshTestDatabase(mongo.uri);
  svc = new ConnectionService({
    db, secrets: new SecretStore(db, parseKeyring(`k:${generateKeyBase64()}`, 'k')), registry: createDefaultRegistry(),
    audit: new AuditService(db), network: { ...STRICT_POLICY, allowLoopback: true, allowInsecureHttp: true }, testTimeoutMs: 5_000,
  });
  const now = new Date();
  await db.c.environments.insertOne({ _id: 'e', orgId: 'o', projectId: 'p', slug: 'e', name: 'E', isProduction: false, createdAt: now });
}, 300_000);
afterAll(async () => {
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  await db?.close();
  await mongo?.stop();
});

async function activeConnection(name: string) {
  const c = await svc.create(scope, 'e', actor, { connectorType: 'http-health', name, authMethod: 'none', config: { url: `http://127.0.0.1:${port}/h` }, secrets: {} });
  await db.c.connections.updateOne({ _id: c.id }, { $set: { lifecycle: 'active', 'health.nextCheckAt': new Date(Date.now() - 1000) } });
  return c.id;
}
const state = async (id: string) => (await db.c.connections.findOne({ _id: id }))!.health;
const worker = (o: Partial<ConstructorParameters<typeof MonitorWorker>[1]> = {}) => new MonitorWorker(svc, { owner: 'test-worker', concurrency: 4, tickMs: 1000, draftPurgeEveryMs: 1e12, ...o });

describe('MonitorWorker', () => {
  test('a tick checks due connections and records health; healthy ones are not due again', async () => {
    status = 200; delayMs = 0;
    const id = await activeConnection('basic');
    const w = worker();
    expect(await w.tick()).toBe(1);
    await w.idle();
    expect((await state(id)).state).toBe('healthy');
    expect(await w.tick()).toBe(0);
    expect(w.metrics.checksFinished).toBe(1);
  });

  test('outages and recoveries are picked up on later ticks', async () => {
    const id = await activeConnection('flaky');
    const w = worker();
    status = 503;
    await w.tick(); await w.idle();
    expect((await state(id)).state).toBe('degraded');
    expect(w.metrics.checksUnhealthy).toBe(1);
    status = 200;
    await db.c.connections.updateOne({ _id: id }, { $set: { 'health.nextCheckAt': new Date(Date.now() - 1) } });
    await w.tick(); await w.idle();
    expect((await state(id)).state).toBe('healthy');
  });

  test('concurrency is bounded no matter how large the backlog is', async () => {
    status = 200; delayMs = 150; maxConcurrent = 0;
    await db.c.connections.deleteMany({});
    const ids = await Promise.all(Array.from({ length: 10 }, (_, i) => activeConnection(`bulk-${i}`)));
    const w = worker({ concurrency: 3 });
    for (let i = 0; i < 40 && (await db.c.connections.countDocuments({ 'health.lastCheckAt': null })) > 0; i++) {
      await w.tick();
      await new Promise((r) => setTimeout(r, 50));
    }
    await w.idle();
    expect(maxConcurrent).toBeLessThanOrEqual(3);
    expect(maxConcurrent).toBeGreaterThan(1); // it actually ran in parallel
    for (const id of ids) expect((await state(id)).state).toBe('healthy');
    delayMs = 0;
  });

  test('two workers share the load: every connection is checked exactly once per due time', async () => {
    status = 200; delayMs = 0;
    await db.c.connections.deleteMany({});
    await Promise.all(Array.from({ length: 8 }, (_, i) => activeConnection(`shared-${i}`)));
    const a = worker({ owner: 'a', concurrency: 8 });
    const b = worker({ owner: 'b', concurrency: 8 });
    await Promise.all([a.tick(), b.tick()]);
    await Promise.all([a.idle(), b.idle()]);
    expect(a.metrics.checksStarted + b.metrics.checksStarted).toBe(8);
  });

  test('graceful stop lets in-flight checks finish and then stops claiming', async () => {
    status = 200; delayMs = 300;
    await db.c.connections.deleteMany({});
    const id = await activeConnection('draining');
    const w = worker();
    await w.tick();
    expect(w.metrics.inflight).toBe(1);
    const t0 = Date.now();
    const { drained } = await w.stop(5_000);
    expect(drained).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(150); // it really waited for the running check
    expect((await state(id)).state).toBe('healthy'); // ...and the result was recorded
    await db.c.connections.updateOne({ _id: id }, { $set: { 'health.nextCheckAt': new Date(Date.now() - 1) } });
    expect(await w.tick()).toBe(0); // stopped: no new work
    delayMs = 0;
  });

  test('stop gives up after the grace period instead of hanging forever', async () => {
    status = 200; delayMs = 1500;
    await db.c.connections.deleteMany({});
    await activeConnection('slow');
    const w = worker();
    await w.tick();
    const { drained } = await w.stop(100);
    expect(drained).toBe(false);
    await w.idle();
    delayMs = 0;
  });

  test('a scheduler failure is counted, logged and does not crash the loop', async () => {
    const logs: string[] = [];
    const broken = new MonitorWorker({ claimDue: async () => { throw new Error('mongo went away'); }, purgeStaleDrafts: async () => 0 } as never,
      { owner: 'x', concurrency: 1, tickMs: 1000, log: (_l, m) => logs.push(m) });
    await expect(broken.tick()).resolves.toBe(0);
    expect(broken.metrics.tickErrors).toBe(1);
    expect(logs).toContain('tick failed');
    expect(broken.metrics.lastTickAt).not.toBeNull(); // the loop is still alive
  });

  test('stale drafts are purged periodically', async () => {
    await db.c.connections.deleteMany({});
    const c = await svc.create(scope, 'e', actor, { connectorType: 'http-health', name: 'abandoned', authMethod: 'none', config: { url: `http://127.0.0.1:${port}/h` }, secrets: {} });
    await db.c.connections.updateOne({ _id: c.id }, { $set: { updatedAt: new Date(Date.now() - 48 * 3600_000) } });
    const w = worker({ draftPurgeEveryMs: 0 });
    await w.tick();
    expect(w.metrics.draftsPurged).toBe(1);
  });

  test('liveness/readiness signals and Prometheus metrics reflect the loop', async () => {
    const w = worker({ tickMs: 1000 });
    expect(w.isAlive()).toBe(false); // never ticked
    await w.tick();
    expect(w.isAlive()).toBe(true);
    expect(w.isAlive(Date.now() + 60_000)).toBe(false); // silent for a minute -> not alive
    const m = w.prometheus();
    expect(m).toContain('nexus_worker_checks_started_total');
    expect(m).toContain('# TYPE nexus_worker_inflight_checks gauge');
  });
});
