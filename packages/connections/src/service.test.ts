import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createDefaultRegistry } from '@nexus/connectors';
import { ConnectorError, ConnectorRegistry, type Connector, type ConnectorDescriptor } from '@nexus/connector-sdk';
import { AuditService, type Database } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import { generateKeyBase64, parseKeyring, SecretStore } from '@nexus/secrets';
import { STRICT_POLICY, type NetworkPolicy } from '@nexus/security';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ConnectionService, type Actor, type Scope } from './service.js';
import { ServiceError } from './errors.js';

const TOKEN = 'live-token-aaaaaaaa';
const NEW_TOKEN = 'rotated-token-bbbbbbbb';
const dev: NetworkPolicy = { ...STRICT_POLICY, allowLoopback: true, allowInsecureHttp: true };

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let db: Database;
let secrets: SecretStore;
let svc: ConnectionService;
let server: http.Server;
let port: number;
let mode: 'ok' | '503' | 'reject' = 'ok';
let acceptedToken = TOKEN;

const ORG = 'org-a', OTHER_ORG = 'org-b', PROJECT = 'proj-1', ENV = 'env-1', ENV2 = 'env-2';
const scope: Scope = { orgId: ORG, projectId: PROJECT, environmentIds: null };
const actor: Actor = { userId: 'user-1', ctx: { requestId: 'req-test-0001' } };
const input = (over: Record<string, unknown> = {}) => ({
  connectorType: 'http-health', name: 'prod api', authMethod: 'bearer',
  config: { url: `http://127.0.0.1:${port}/healthz` }, secrets: { token: TOKEN }, ...over,
});
const code = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e instanceof ServiceError ? `${e.status}:${e.code}` : `other:${String(e)}`; } return 'no-error'; };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (mode === '503') { res.writeHead(503); return res.end(); }
    if (mode === 'reject' || req.headers.authorization !== `Bearer ${acceptedToken}`) { res.writeHead(401); return res.end(); }
    res.writeHead(200); res.end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  mongo = await startTestMongo();
  db = await freshTestDatabase(mongo.uri);
  secrets = new SecretStore(db, parseKeyring(`k1:${generateKeyBase64()}`, 'k1'));
  svc = new ConnectionService({ db, secrets, registry: createDefaultRegistry(), audit: new AuditService(db), network: dev, testTimeoutMs: 5_000 });
  const now = new Date();
  await db.c.organizations.insertMany([{ _id: ORG, slug: 'a', name: 'A', createdAt: now }, { _id: OTHER_ORG, slug: 'b', name: 'B', createdAt: now }]);
  await db.c.projects.insertOne({ _id: PROJECT, orgId: ORG, slug: 'p', name: 'P', description: '', owningTeam: '', createdBy: 'user-1', createdAt: now, updatedAt: now });
  await db.c.environments.insertMany([
    { _id: ENV, orgId: ORG, projectId: PROJECT, slug: 'prod', name: 'Prod', isProduction: true, createdAt: now },
    { _id: ENV2, orgId: ORG, projectId: PROJECT, slug: 'dev', name: 'Dev', isProduction: false, createdAt: now },
  ]);
}, 300_000);
afterAll(async () => {
  server?.closeAllConnections();
  await new Promise((r) => server?.close(r));
  await db?.close();
  await mongo?.stop();
});

describe('creation and validation', () => {
  test('creates a draft; the credential is encrypted at rest and appears nowhere in the DTO, DB document or audit', async () => {
    const c = await svc.create(scope, ENV, actor, input());
    expect(c.lifecycle).toBe('draft');
    expect(c.health.state).toBe('pending');
    expect(c.secrets).toEqual({ token: { set: true, updatedAt: expect.any(String) } });
    expect(JSON.stringify(c)).not.toContain(TOKEN);
    expect(JSON.stringify(await db.c.connections.findOne({ _id: c.id }))).not.toContain(TOKEN);
    expect(JSON.stringify(await db.c.secrets.find({}).toArray())).not.toContain(TOKEN);
    expect(JSON.stringify(await db.c.auditEvents.find({}).toArray())).not.toContain(TOKEN);
    const ev = await db.c.auditEvents.findOne({ action: 'connection.created', targetId: c.id });
    expect(ev?.metadata.fieldNames).toEqual(['token']); // names only, never values
    expect(ev?.actorUserId).toBe('user-1');
    await svc.remove(scope, c.id, actor);
  });

  test('rejects invalid config, wrong secret fields, unknown/planned connectors and bad auth methods', async () => {
    expect(await code(svc.create(scope, ENV, actor, input({ config: { url: 'x', surprise: 1 } })))).toBe('400:invalid_config');
    expect(await code(svc.create(scope, ENV, actor, input({ secrets: { token: TOKEN, extra: 'x' } })))).toBe('400:invalid_secrets');
    expect(await code(svc.create(scope, ENV, actor, input({ secrets: {} })))).toBe('400:invalid_secrets');
    expect(await code(svc.create(scope, ENV, actor, input({ authMethod: 'kerberos' })))).toBe('400:invalid_auth_method');
    expect(await code(svc.create(scope, ENV, actor, input({ connectorType: 'nope' })))).toBe('404:unknown_connector');
    expect(await code(svc.create(scope, ENV, actor, input({ connectorType: 'aws-cloudwatch', authMethod: 'iam-role', secrets: {} })))).toBe('501:connector_not_implemented');
    expect(await code(svc.create(scope, ENV, actor, input({ authMethod: 'header' , secrets: { value: 'v' } })))).toBe('400:invalid_config'); // header name required
    expect(await db.c.connections.countDocuments({})).toBe(0);
    expect(await db.c.secrets.countDocuments({})).toBe(0); // nothing leaked from failed creations
  });

  test('names are unique per environment; the per-environment limit applies', async () => {
    const a = await svc.create(scope, ENV, actor, input({ name: 'dup' }));
    expect(await code(svc.create(scope, ENV, actor, input({ name: 'dup' })))).toBe('409:conflict');
    await svc.create(scope, ENV2, actor, input({ name: 'dup' })); // different environment: fine
    const tiny = new ConnectionService({ db, secrets, registry: createDefaultRegistry(), audit: new AuditService(db), network: dev, maxConnectionsPerEnvironment: 1 });
    expect(await code(tiny.create(scope, ENV, actor, input({ name: 'second' })))).toBe('409:limit_reached');
    await svc.remove(scope, a.id, actor);
    for (const c of await svc.list(scope)) await svc.remove(scope, c.id, actor);
  });
});

describe('full lifecycle: test -> discover -> select -> configure -> activate -> monitor -> rotate -> disconnect -> delete', () => {
  let id: string;

  test('first test with a wrong token is misconfigured (not "expired"), with remediation and no secret leak', async () => {
    const c = await svc.create(scope, ENV, actor, input({ name: 'lifecycle', secrets: { token: 'wrong-token-zzzzzzzz' } }));
    id = c.id;
    const { report, connection } = await svc.test(scope, id, actor);
    expect(report.ok).toBe(false);
    expect(report.failure?.kind).toBe('authentication');
    expect(connection.health.state).toBe('misconfigured');
    expect(connection.health.remediation).toBeTruthy();
    expect(connection.health.lastError?.kind).toBe('authentication');
    expect(connection.lastTest?.ok).toBe(false);
    expect(JSON.stringify({ report, connection })).not.toContain('wrong-token-zzzzzzzz');
  });

  test('rotating to a valid credential revalidates immediately and reports healthy', async () => {
    const { report, connection } = await svc.rotate(scope, id, actor, { token: TOKEN });
    expect(report.ok).toBe(true);
    expect(connection.health.state).toBe('healthy');
    expect(connection.health.lastSuccessAt).toBeTruthy();
    expect(connection.health.consecutiveFailures).toBe(0);
    expect(connection.health.recentErrors).toHaveLength(1); // earlier failure kept for diagnosis
    expect(connection.capabilities.some((x) => x.id === 'availability' && x.available)).toBe(true);
    const ev = await db.c.auditEvents.findOne({ action: 'connection.credentials_rotated', targetId: id });
    expect(JSON.stringify(ev)).not.toContain(TOKEN);
    expect(await secrets.get({ orgId: ORG, connectionId: id, name: 'token' })).toBe(TOKEN);
  });

  test('cannot start before discovery/selection/settings are done', async () => {
    const e = await svc.activate(scope, id, actor).catch((x) => x as ServiceError);
    expect((e as ServiceError).code).toBe('precondition_failed');
    expect(((e as ServiceError).details as { missing: string[] }).missing.join()).toMatch(/selected resources/);
  });

  test('discovery stores resources; selection is validated against them and against supported signals', async () => {
    expect(await code(svc.setSelection(scope, id, actor, { resourceIds: ['endpoint'], signals: ['metrics'] }))).toBe('409:not_discovered');
    const { discovery } = await svc.discover(scope, id, actor);
    expect(discovery.resources.map((r) => r.id)).toEqual(['endpoint']);
    expect(await code(svc.setSelection(scope, id, actor, { resourceIds: ['ghost'], signals: ['metrics'] }))).toBe('400:unknown_resource');
    expect(await code(svc.setSelection(scope, id, actor, { resourceIds: ['endpoint'], signals: ['logs'] }))).toBe('400:unsupported_signal');
    const c = await svc.setSelection(scope, id, actor, { resourceIds: ['endpoint'], signals: ['metrics'] });
    expect(c.selection).toEqual({ resourceIds: ['endpoint'], signals: ['metrics'] });
  });

  test('settings are validated (bounds) and preview shows exactly what will run, honestly', async () => {
    expect(await code(svc.setSettings(scope, id, actor, { pollIntervalSeconds: 5 }))).toBe('400:invalid_settings');
    expect(await code(svc.setSettings(scope, id, actor, { sampling: 7 }))).toBe('400:invalid_settings');
    await svc.setSettings(scope, id, actor, { pollIntervalSeconds: 30, sampling: 0.5, retentionDays: 14, redaction: { enabled: true, extraKeys: ['x-internal-id'] } });
    const p = await svc.preview(scope, id);
    expect(p.connector).toMatch(/health check/i);
    expect(p.credentials).toEqual([{ field: 'Token', set: true }]);
    expect(JSON.stringify(p)).not.toContain(TOKEN);
    expect(p.warnings.join(' ')).toMatch(/not implemented/i); // says clearly that nothing is collected yet
    expect(p.collection).toMatch(/Not collected/);
  });

  test('activation requires a recent passing test for the CURRENT configuration', async () => {
    // changing the config invalidates the earlier passing test and the discovery results
    await svc.updateConfig(scope, id, actor, { config: { url: `http://127.0.0.1:${port}/healthz`, timeoutMs: 5000 } });
    expect(await code(svc.activate(scope, id, actor))).toBe('409:precondition_failed');
    expect((await svc.test(scope, id, actor)).report.ok).toBe(true);
    await svc.discover(scope, id, actor);
    await svc.setSelection(scope, id, actor, { resourceIds: ['endpoint'], signals: ['metrics'] });
    const c = await svc.activate(scope, id, actor);
    expect(c.lifecycle).toBe('active');
    expect(c.health.nextCheckAt).toBeTruthy();
    expect(c.collection.status).toBe('not_implemented');
    expect(c.collection.note).toMatch(/no data is being collected/);
    expect(c.health.collectionLagSeconds).toBeNull();
  });

  test('monitor: failures change state with backoff and audited transitions; recovery returns to healthy', async () => {
    const run = async () => {
      await db.c.connections.updateOne({ _id: id }, { $set: { 'health.nextCheckAt': new Date(Date.now() - 1000) } });
      const claimed = await svc.claimDue('worker-1', 5);
      expect(claimed.map((c) => c._id)).toEqual([id]);
      const state = await svc.runMonitorCheck(claimed[0]!, 'worker-1');
      return { state, doc: (await db.c.connections.findOne({ _id: id }))! };
    };

    mode = '503';
    let r = await run();
    expect(r.state).toBe('degraded');
    expect(r.doc.health.consecutiveFailures).toBe(1);
    expect(r.doc.lease).toBeNull(); // lease always released
    const firstDelay = r.doc.health.nextCheckAt!.getTime() - r.doc.health.lastCheckAt!.getTime();
    r = await run();
    expect(r.doc.health.consecutiveFailures).toBe(2);
    expect(r.doc.health.nextCheckAt!.getTime() - r.doc.health.lastCheckAt!.getTime()).toBeGreaterThan(firstDelay * 0.9); // backing off

    mode = 'reject'; // token now refused: it worked before, so this is an EXPIRED credential, not a misconfiguration
    r = await run();
    expect(r.state).toBe('authentication_expired');

    mode = 'ok';
    r = await run();
    expect(r.state).toBe('healthy');
    expect(r.doc.health.consecutiveFailures).toBe(0);

    const changes = (await db.c.auditEvents.find({ action: 'connection.health_changed', targetId: id, actorType: 'system' }).sort({ seq: 1 }).toArray()).map((e) => `${e.metadata.from}>${e.metadata.to}`);
    expect(changes).toEqual(['healthy>degraded', 'degraded>authentication_expired', 'authentication_expired>healthy']);
    const sys = await db.c.auditEvents.find({ action: 'connection.health_changed', targetId: id, actorType: 'system' }).toArray();
    expect(sys.every((e) => e.actorUserId === null && e.requestId === 'worker:worker-1')).toBe(true);
  });

  test('stale monitor is visible: no check for many intervals marks the connection stale', async () => {
    await db.c.connections.updateOne({ _id: id }, { $set: { 'health.lastCheckAt': new Date(Date.now() - 3600_000) } });
    expect((await svc.get(scope, id)).health.stale).toBe(true);
    await db.c.connections.updateOne({ _id: id }, { $set: { 'health.lastCheckAt': new Date() } });
    expect((await svc.get(scope, id)).health.stale).toBe(false);
  });

  test('rotating an ACTIVE connection replaces the credential, bumps the version and revalidates', async () => {
    acceptedToken = NEW_TOKEN;
    const before = (await db.c.connections.findOne({ _id: id }))!;
    const { report, connection } = await svc.rotate(scope, id, actor, { token: NEW_TOKEN });
    expect(report.ok).toBe(true);
    expect(connection.lifecycle).toBe('active');
    expect((await db.c.connections.findOne({ _id: id }))!.configVersion).toBeGreaterThan(before.configVersion);
    expect(await secrets.get({ orgId: ORG, connectionId: id, name: 'token' })).toBe(NEW_TOKEN);
    expect(await db.c.secrets.countDocuments({ connectionId: id })).toBe(1); // replaced, old value not retained
  });

  test('disconnect revokes: secrets are deleted, monitoring stops, tests are refused; rotation brings it back as a draft', async () => {
    const c = await svc.disconnect(scope, id, actor);
    expect(c.lifecycle).toBe('disconnected');
    expect(c.health.state).toBe('disconnected');
    expect(c.health.nextCheckAt).toBeNull();
    expect(c.secrets).toEqual({});
    expect(await db.c.secrets.countDocuments({ connectionId: id })).toBe(0);
    expect(await code(svc.test(scope, id, actor))).toBe('409:disconnected');
    expect(await svc.claimDue('w', 10)).toEqual([]); // not scheduled any more
    const back = await svc.rotate(scope, id, actor, { token: NEW_TOKEN });
    expect(back.connection.lifecycle).toBe('draft');
    expect(back.report.ok).toBe(true);
  });

  test('delete removes the connection and its secrets and is audited without values', async () => {
    await svc.remove(scope, id, actor);
    expect(await db.c.connections.countDocuments({ _id: id })).toBe(0);
    expect(await db.c.secrets.countDocuments({ connectionId: id })).toBe(0);
    expect(await code(svc.get(scope, id))).toBe('404:not_found');
    const actions = (await db.c.auditEvents.find({ targetId: id }).sort({ seq: 1 }).toArray()).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['connection.created', 'connection.tested', 'connection.discovered', 'connection.activated', 'connection.credentials_rotated', 'connection.disconnected', 'connection.deleted']));
    expect(JSON.stringify(await db.c.auditEvents.find({}).toArray())).not.toMatch(/live-token|rotated-token|wrong-token/);
  });
});

describe('tenant, project and environment isolation', () => {
  let id: string;
  beforeAll(async () => { id = (await svc.create(scope, ENV, actor, input({ name: 'isolated' }))).id; });

  test('another organization or project cannot see or touch the connection (IDOR)', async () => {
    for (const s of [{ ...scope, orgId: OTHER_ORG }, { ...scope, projectId: 'other-project' }]) {
      expect(await code(svc.get(s, id))).toBe('404:not_found');
      expect(await code(svc.test(s, id, actor))).toBe('404:not_found');
      expect(await code(svc.discover(s, id, actor))).toBe('404:not_found');
      expect(await code(svc.rotate(s, id, actor, { token: 'hijack-token-1' }))).toBe('404:not_found');
      expect(await code(svc.disconnect(s, id, actor))).toBe('404:not_found');
      expect(await code(svc.remove(s, id, actor))).toBe('404:not_found');
      expect(await svc.list(s)).toEqual([]);
    }
    expect(await secrets.get({ orgId: ORG, connectionId: id, name: 'token' })).toBe(TOKEN); // untouched
  });

  test('environment-restricted callers only see and manage connections in their environments', async () => {
    const devOnly: Scope = { ...scope, environmentIds: [ENV2] };
    expect(await svc.list(devOnly)).toEqual([]);
    expect(await code(svc.get(devOnly, id))).toBe('404:not_found');
    expect(await code(svc.create(devOnly, ENV, actor, input({ name: 'sneaky' })))).toBe('404:not_found');
    expect(await code(svc.remove(devOnly, id, actor))).toBe('404:not_found');
    expect((await svc.list({ ...scope, environmentIds: [ENV] })).map((c) => c.id)).toEqual([id]);
  });

  test('an environment that belongs to a different project/org cannot be targeted', async () => {
    await db.c.environments.insertOne({ _id: 'foreign-env', orgId: OTHER_ORG, projectId: 'foreign-project', slug: 'x', name: 'X', isProduction: false, createdAt: new Date() });
    expect(await code(svc.create(scope, 'foreign-env', actor, input({ name: 'cross' })))).toBe('404:not_found');
  });

  test('a stored secret copied to another connection or org cannot be used there (AAD binding, end to end)', async () => {
    const other = await svc.create(scope, ENV2, actor, input({ name: 'thief', secrets: { token: 'placeholder-token-1' } }));
    const row = (await db.c.secrets.findOne({ connectionId: id, name: 'token' }))!;
    const { _id, ...rest } = row;
    await db.c.secrets.updateOne({ connectionId: other.id, name: 'token' }, { $set: { ...rest, connectionId: other.id } });
    const { report } = await svc.test(scope, other.id, actor);
    expect(report.ok).toBe(false);
    expect(report.failure?.remediation).toMatch(/Re-enter the credentials/);
    expect(JSON.stringify(report)).not.toContain(TOKEN);
  });
});

describe('scheduler claim/lease', () => {
  test('two workers never claim the same connection; expired leases are reclaimed', async () => {
    await db.c.connections.deleteMany({});
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const c = await svc.create(scope, ENV, actor, input({ name: `due-${i}` }));
      ids.push(c.id);
      await db.c.connections.updateOne({ _id: c.id }, { $set: { lifecycle: 'active', settings: { pollIntervalSeconds: 60, sampling: 1, retentionDays: 30, redaction: { enabled: true, extraKeys: [] } }, 'health.nextCheckAt': new Date(Date.now() - 1000) } });
    }
    const [a, b] = await Promise.all([svc.claimDue('w-a', 6), svc.claimDue('w-b', 6)]);
    const all = [...a, ...b].map((c) => c._id);
    expect(new Set(all).size).toBe(all.length); // no duplicates
    expect(all.sort()).toEqual([...ids].sort()); // everything claimed exactly once
    expect(await svc.claimDue('w-c', 6)).toEqual([]); // leased: nothing left
    await db.c.connections.updateMany({}, { $set: { 'lease.until': new Date(Date.now() - 1000) } }); // a worker crashed
    expect((await svc.claimDue('w-c', 6)).length).toBe(6);
  });

  test('a connection checked by one worker is not due again until its next check time', async () => {
    await db.c.connections.deleteMany({});
    const c = await svc.create(scope, ENV, actor, input({ name: 'once' }));
    await db.c.connections.updateOne({ _id: c.id }, { $set: { lifecycle: 'active', settings: { pollIntervalSeconds: 60, sampling: 1, retentionDays: 30, redaction: { enabled: true, extraKeys: [] } }, 'health.nextCheckAt': new Date(Date.now() - 1000) } });
    const [claimed] = await svc.claimDue('w1', 1);
    await svc.runMonitorCheck(claimed!, 'w1');
    expect(await svc.claimDue('w2', 5)).toEqual([]);
  });
});

describe('abandoned drafts', () => {
  test('stale drafts and their encrypted credentials are purged; active connections and fresh drafts are kept', async () => {
    await db.c.connections.deleteMany({});
    await db.c.secrets.deleteMany({});
    const old = await svc.create(scope, ENV, actor, input({ name: 'old draft' }));
    const fresh = await svc.create(scope, ENV, actor, input({ name: 'fresh draft' }));
    const active = await svc.create(scope, ENV, actor, input({ name: 'old but active' }));
    await db.c.connections.updateOne({ _id: old.id }, { $set: { updatedAt: new Date(Date.now() - 48 * 3600_000) } });
    await db.c.connections.updateOne({ _id: active.id }, { $set: { lifecycle: 'active', updatedAt: new Date(Date.now() - 48 * 3600_000) } });
    expect(await svc.purgeStaleDrafts()).toBe(1);
    expect(await db.c.connections.countDocuments({ _id: old.id })).toBe(0);
    expect(await db.c.secrets.countDocuments({ connectionId: old.id })).toBe(0);
    expect(await db.c.connections.countDocuments({ _id: { $in: [fresh.id, active.id] } })).toBe(2);
    expect((await db.c.auditEvents.findOne({ action: 'connection.draft_purged' }))?.actorType).toBe('system');
  });
});

describe('defence in depth against misbehaving connectors', () => {
  const desc: ConnectorDescriptor = {
    type: 'leaky', displayName: 'Leaky', category: 'application', status: 'implemented', collection: 'not_implemented',
    signals: [{ signal: 'metrics', availability: 'supported' }], deploymentTypes: [], operations: [], configRequirements: [], limitations: [], requiredPermissions: [],
    authMethods: [{ id: 'pw', label: 'Password', recommended: true, description: '', secretFields: [{ name: 'password', label: 'Password' }] }],
  };
  type Cfg = { mode: 'throw-secret' | 'hang' | 'echo-in-report' | 'bump-version' };
  const leaky: Connector<Cfg, { password: string }> = {
    descriptor: desc,
    configSchema: z.strictObject({ mode: z.enum(['throw-secret', 'hang', 'echo-in-report', 'bump-version']) }) as never,
    credentialSchema: () => z.object({ password: z.string().min(1) }) as never,
    async test(ctx, config, creds) {
      if (config.mode === 'throw-secret') throw new Error(`login failed for password ${creds.password} at mongodb://u:${creds.password}@h/x`);
      if (config.mode === 'hang') await new Promise((_, rej) => ctx.signal.addEventListener('abort', () => rej(new Error('aborted'))));
      if (config.mode === 'bump-version') await db.c.connections.updateMany({ connectorType: 'leaky' }, { $inc: { configVersion: 1 } });
      return { ok: true, steps: [{ id: 's', label: `connected using ${creds.password}`, status: 'pass', detail: `token=${creds.password}` }], capabilities: [{ id: 'c', label: 'c', available: true }], facts: { note: `pw:${creds.password}` }, durationMs: 1 };
    },
    async discover(_c, config, creds) {
      if (config.mode === 'throw-secret') throw new ConnectorError('internal', `boom ${creds.password}`);
      return { resources: [{ id: 'r', type: 't', name: `leak-${creds.password}`, attributes: {}, signals: ['metrics'] }], capabilities: [], truncated: false };
    },
  };
  const registry = new ConnectorRegistry().register(leaky);
  const lsvc = () => new ConnectionService({ db, secrets, registry, audit: new AuditService(db), network: dev, testTimeoutMs: 800 });
  const PW = 'super-secret-pw-12345';
  const make = (mode: Cfg['mode']) => lsvc().create(scope, ENV, actor, { connectorType: 'leaky', name: `leaky-${mode}`, authMethod: 'pw', config: { mode }, secrets: { password: PW } });

  test('a connector that throws with the password in its message cannot leak it', async () => {
    const c = await make('throw-secret');
    const { report, connection } = await lsvc().test(scope, c.id, actor);
    expect(report.ok).toBe(false);
    expect(JSON.stringify({ report, connection })).not.toContain(PW);
    const d = await lsvc().discover(scope, c.id, actor).catch((e) => e as ServiceError);
    expect((d as ServiceError).code).toBe('discovery_failed');
    expect(JSON.stringify(d) + (d as Error).message).not.toContain(PW);
    expect(JSON.stringify(await db.c.auditEvents.find({}).toArray())).not.toContain(PW);
  });

  test('a connector that echoes the password into its report is scrubbed by the platform', async () => {
    const c = await make('echo-in-report');
    const { report, connection } = await lsvc().test(scope, c.id, actor);
    expect(report.ok).toBe(true);
    expect(JSON.stringify({ report, connection })).not.toContain(PW);
    const { discovery } = await lsvc().discover(scope, c.id, actor);
    expect(JSON.stringify(discovery)).not.toContain(PW);
    expect(JSON.stringify(await db.c.connections.findOne({ _id: c.id }))).not.toContain(PW);
  });

  test('a hanging connector is cut off at the deadline and reported as a timeout', async () => {
    const c = await make('hang');
    const t0 = Date.now();
    const { report, connection } = await lsvc().test(scope, c.id, actor);
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect(report.failure?.kind).toBe('timeout');
    expect(connection.health.state).toBe('unreachable');
  });

  test('results of a check are discarded if the connection changed while it ran', async () => {
    const c = await make('bump-version');
    expect(await code(lsvc().test(scope, c.id, actor))).toBe('409:connection_changed');
    expect((await db.c.connections.findOne({ _id: c.id }))!.lastTest).toBeNull(); // the stale result was not stored
  });
});
