import { createDefaultRegistry } from '@nexus/connectors';
import { ConnectorError, ConnectorRegistry, type CollectionResult, type Connector, type ConnectorDescriptor, type SelectionInput } from '@nexus/connector-sdk';
import { AuditService, type Database } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import { generateKeyBase64, parseKeyring, SecretStore } from '@nexus/secrets';
import { STRICT_POLICY, type NetworkPolicy } from '@nexus/security';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ConnectionService, type Actor, type CollectedBatch, type CollectionSink, type Scope } from './service.js';

const dev: NetworkPolicy = { ...STRICT_POLICY, allowLoopback: true, allowInsecureHttp: true };
const ORG = 'org-c', PROJECT = 'proj-c', ENV = 'env-c';
const scope: Scope = { orgId: ORG, projectId: PROJECT, environmentIds: null };
const actor: Actor = { userId: 'user-c', ctx: { requestId: 'req-collect-1' } };
const PW = 'collect-secret-pw-98765';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let db: Database;
let secrets: SecretStore;

type Mode = 'ok' | 'throw-secret' | 'hang' | 'partial' | 'many';
const desc: ConnectorDescriptor = {
  type: 'fakedb', displayName: 'Fake DB', category: 'database', status: 'implemented', collection: 'implemented',
  signals: [{ signal: 'metrics', availability: 'supported' }, { signal: 'inventory', availability: 'supported' }],
  deploymentTypes: [], operations: [], configRequirements: [], limitations: [], requiredPermissions: [],
  authMethods: [{ id: 'pw', label: 'Password', recommended: true, description: '', secretFields: [{ name: 'password', label: 'Password' }] }],
};
const calls: { sel: SelectionInput; creds: { password: string } }[] = [];
let mode: Mode = 'ok';
let hostUp = true;
const fake: Connector<{ x?: string }, { password: string }> = {
  descriptor: desc,
  configSchema: z.strictObject({ x: z.string().optional() }) as never,
  credentialSchema: () => z.object({ password: z.string().min(1) }) as never,
  async test() {
    if (!hostUp) return { ok: false, steps: [], capabilities: [], facts: {}, durationMs: 1, failure: { kind: 'unreachable' as const, message: 'down', remediation: 'start it' } };
    return { ok: true, steps: [{ id: 's', label: 'ok', status: 'pass' as const }], capabilities: [{ id: 'c', label: 'c', available: true }], facts: {}, durationMs: 1 };
  },
  async discover() {
    return { resources: [
      { id: 'inst', type: 'fake_instance', name: 'inst', attributes: {}, signals: ['metrics' as const, 'inventory' as const] },
      { id: 'db1', type: 'fake_database', name: 'db1', attributes: {}, signals: ['metrics' as const, 'inventory' as const] },
    ], capabilities: [], truncated: false };
  },
  async collect(ctx, _config, creds, sel): Promise<CollectionResult> {
    calls.push({ sel, creds });
    if (mode === 'throw-secret') throw new ConnectorError('permission_denied', `not allowed with password ${creds.password}`, { remediation: 'grant the role' });
    if (mode === 'hang') await new Promise((_, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('aborted'))));
    const samples = [{ name: 'fake.value', unit: '1', description: 'd', kind: 'gauge' as const, value: 7, attributes: { a: 'b' } }];
    if (mode === 'partial') return { samples, dropped: 3, notes: ['db1: statistics unavailable (permission)'] };
    return { samples, dropped: 0, notes: [] };
  },
};
const registry = new ConnectorRegistry().register(fake);
const written: { ctx: { orgId: string; projectId: string; environmentId: string; retentionMs: number }; batch: CollectedBatch; now: Date }[] = [];
let sinkResult = { accepted: 1, rejected: 0, notes: [] as string[] };
const sink: CollectionSink = { async write(ctx, batch, now) { written.push({ ctx, batch, now }); return sinkResult; } };
const make = (withSink = true, over: { collectTimeoutMs?: number } = {}) => new ConnectionService({
  db, secrets, registry, audit: new AuditService(db), network: dev, testTimeoutMs: 2_000, ...(withSink ? { sink } : {}), ...over,
});

beforeAll(async () => {
  mongo = await startTestMongo();
  db = await freshTestDatabase(mongo.uri);
  secrets = new SecretStore(db, parseKeyring(`k1:${generateKeyBase64()}`, 'k1'));
  const now = new Date();
  await db.c.organizations.insertOne({ _id: ORG, slug: 'c', name: 'C', createdAt: now });
  await db.c.projects.insertOne({ _id: PROJECT, orgId: ORG, slug: 'p', name: 'P', description: '', owningTeam: '', createdBy: 'user-c', createdAt: now, updatedAt: now });
  await db.c.environments.insertOne({ _id: ENV, orgId: ORG, projectId: PROJECT, slug: 'prod', name: 'Prod', isProduction: false, createdAt: now });
}, 300_000);
afterAll(async () => { await db?.close(); await mongo?.stop(); });

/** Walks the real wizard path to an ACTIVE connection. */
async function activeConnection(name: string, signals: string[] = ['metrics'], svc = make()) {
  const c = await svc.create(scope, ENV, actor, { connectorType: 'fakedb', name, authMethod: 'pw', config: {}, secrets: { password: PW } });
  await svc.test(scope, c.id, actor);
  await svc.discover(scope, c.id, actor);
  await svc.setSelection(scope, c.id, actor, { resourceIds: ['inst', 'db1'], signals });
  await svc.setSettings(scope, c.id, actor, { pollIntervalSeconds: 30, sampling: 1, retentionDays: 7, redaction: { enabled: true, extraKeys: [] } });
  const a = await svc.activate(scope, c.id, actor);
  return { id: c.id, activated: a };
}
async function runDue(id: string, svc = make()) {
  await db.c.connections.updateOne({ _id: id }, { $set: { 'health.nextCheckAt': new Date(Date.now() - 1000), lease: null } });
  const [doc] = await svc.claimDue('test', 1);
  expect(doc?._id).toBe(id);
  await svc.runMonitorCheck(doc!, 'test');
  return svc.get(scope, id);
}

describe('activation records what will happen', () => {
  test('a collecting connector with metrics selected waits for its first collection; without metrics it says nothing is collected', async () => {
    const withMetrics = await activeConnection('act-metrics');
    expect(withMetrics.activated.collection.status).toBe('not_started');
    expect(withMetrics.activated.collection.note).toMatch(/Waiting for the first collection/);
    const inventoryOnly = await activeConnection('act-inventory', ['inventory']);
    expect(inventoryOnly.activated.collection.status).toBe('not_selected');
    expect(inventoryOnly.activated.collection.note).toMatch(/metrics signal is not selected/);
    expect((await make().preview(scope, inventoryOnly.id)).warnings.join(' ')).toMatch(/metrics signal is not selected/);
  });

  test('a connector without collect() is reported as not collecting, never as running', async () => {
    const real = new ConnectionService({ db, secrets, registry: createDefaultRegistry(), audit: new AuditService(db), network: dev, testTimeoutMs: 2_000, sink });
    const c = await real.create(scope, ENV, actor, { connectorType: 'http-health', name: 'http', authMethod: 'none', config: { url: 'http://127.0.0.1:1/h' }, secrets: {} });
    expect(c.collection.status).toBe('not_implemented');
    expect(c.collection.note).toMatch(/not implemented for this connector/);
  });
});

describe('a monitor run collects after a healthy check', () => {
  test('samples go to the sink scoped to the connection, with the stored selection, retention and decrypted credentials; status and lag are recorded', async () => {
    mode = 'ok'; hostUp = true; written.length = 0; calls.length = 0;
    const { id } = await activeConnection('collect-ok');
    const dto = await runDue(id);
    expect(written).toHaveLength(1);
    const w = written[0]!;
    expect(w.ctx).toEqual({ orgId: ORG, projectId: PROJECT, environmentId: ENV, retentionMs: 7 * 86_400_000 });
    expect(w.batch).toMatchObject({ connectionId: id, connectionName: 'collect-ok', connectorType: 'fakedb' });
    expect(w.batch.samples).toHaveLength(1);
    expect(calls[0]!.sel).toEqual({ resourceIds: ['inst', 'db1'], signals: ['metrics'] });
    expect(calls[0]!.creds.password).toBe(PW); // decrypted for the call only
    expect(dto.collection).toMatchObject({ status: 'running', lastError: null, consecutiveFailures: 0, lastSeries: 1, notes: [] });
    expect(dto.collection.lastSuccessfulCollectionAt).toBeTruthy();
    expect(dto.health.collectionLagSeconds).toBeLessThan(5);
    expect(dto.collection.note).toMatch(/Collecting every 30s, 1 series per collection/);
    expect(JSON.stringify(dto)).not.toContain(PW);
  });

  test('without a sink (e.g. the API process) nothing is collected and the state is untouched', async () => {
    written.length = 0;
    const { id } = await activeConnection('no-sink');
    const dto = await runDue(id, make(false));
    expect(written).toHaveLength(0);
    expect(dto.collection.status).toBe('not_started');
    expect(dto.health.state).toBe('healthy'); // health monitoring still works
  });

  test('metrics not selected: health is checked, collect() is never called', async () => {
    calls.length = 0;
    const { id } = await activeConnection('inventory-only', ['inventory']);
    const dto = await runDue(id);
    expect(calls).toHaveLength(0);
    expect(dto.collection.status).toBe('not_selected');
    expect(dto.health.state).toBe('healthy');
  });

  test('partial results are successful but their notes, dropped series and refused points are shown', async () => {
    mode = 'partial'; sinkResult = { accepted: 0, rejected: 2, notes: ['Metric series refused: metric "fake.value" reached its limit'] };
    const { id } = await activeConnection('partial');
    const dto = await runDue(id);
    expect(dto.collection.status).toBe('running');
    expect(dto.collection.notes.join(' | ')).toMatch(/statistics unavailable/);
    expect(dto.collection.notes.join(' | ')).toMatch(/3 series were dropped.*at most 500/);
    expect(dto.collection.notes.join(' | ')).toMatch(/2 points were refused by the metric store/);
    mode = 'ok'; sinkResult = { accepted: 1, rejected: 0, notes: [] };
  });
});

describe('changing the settings of an active connection', () => {
  test('clears the selection, so collection stops and is reported as such instead of staying "running" with a growing lag', async () => {
    mode = 'ok'; hostUp = true; calls.length = 0;
    const { id } = await activeConnection('edited');
    expect((await runDue(id)).collection.status).toBe('running');
    const patched = await make().updateConfig(scope, id, actor, { config: { x: 'changed' } });
    expect(patched.selection).toBeNull();
    expect(patched.collection.status).toBe('not_selected');
    calls.length = 0;
    await runDue(id);
    expect(calls).toHaveLength(0); // nothing selected: never collected
  });
});

describe('failures are recorded, backed off, and never leak the credential', () => {
  test('a failing collection stops (with the reason), backs off, and recovers on the next success', async () => {
    mode = 'ok'; hostUp = true;
    const { id } = await activeConnection('fails-then-recovers');
    await runDue(id); // running
    mode = 'throw-secret';
    const before = Date.now();
    const failed = await runDue(id);
    expect(failed.collection.status).toBe('stopped');
    expect(failed.collection.consecutiveFailures).toBe(1);
    expect(failed.collection.lastError).toMatchObject({ kind: 'permission_denied', remediation: 'grant the role' });
    expect(failed.collection.note).toMatch(/Collection is failing/);
    expect(failed.health.state).toBe('healthy'); // the target answered the health check
    expect(JSON.stringify(failed)).not.toContain(PW);
    expect(JSON.stringify(await db.c.connections.findOne({ _id: id }))).not.toContain(PW);
    const next = (await db.c.connections.findOne({ _id: id }))!.health.nextCheckAt!.getTime();
    expect(next).toBeGreaterThan(before + 30_000 * 0.8); // at least about one interval away (exponential backoff with jitter on top)
    mode = 'ok';
    const ok = await runDue(id);
    expect(ok.collection).toMatchObject({ status: 'running', consecutiveFailures: 0, lastError: null });
  });

  test('a hanging collection is cut off at its deadline and recorded as a timeout', async () => {
    mode = 'hang';
    const svc = make(true, { collectTimeoutMs: 400 });
    const { id } = await activeConnection('hangs', ['metrics'], svc);
    const t0 = Date.now();
    const dto = await runDue(id, svc);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(dto.collection.status).toBe('stopped');
    expect(dto.collection.lastError?.kind).toBe('timeout');
    mode = 'ok';
  });

  test('when the health check fails, collection is paused (not silently left "running")', async () => {
    mode = 'ok'; hostUp = true;
    const { id } = await activeConnection('goes-down');
    expect((await runDue(id)).collection.status).toBe('running');
    hostUp = false;
    written.length = 0;
    const dto = await runDue(id);
    expect(written).toHaveLength(0);
    expect(dto.health.state).toBe('unreachable');
    expect(dto.collection.status).toBe('stopped');
    expect(dto.collection.note).toMatch(/Collection is paused because the connection check is failing/);
    hostUp = true;
  });
});
