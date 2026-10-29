import { runConnectorContract, testContext } from '@nexus/connector-sdk';
import { STRICT_POLICY, type NetworkPolicy } from '@nexus/security';
import { MongoClient } from 'mongodb';
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { mongodbConnector as c, safeAdminCommand } from './mongodb.js';

const dev: NetworkPolicy = { ...STRICT_POLICY, allowLoopback: true };
const ROOT = { user: 'root', pwd: 'root-pass-123' };

let auth: MongoMemoryServer; // standalone with authentication enabled
let rs: MongoMemoryReplSet; // replica set, no auth
let authPort: number;
let rsPort: number;

const cfg = (port: number, extra: object = {}) => c.configSchema.parse({ hosts: [{ host: '127.0.0.1', port }], tls: false, ...extra });
const test_ = (config: ReturnType<typeof cfg>, creds: Record<string, string> = {}, net = dev) => c.test(testContext(net), config, creds);

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
    const a = cl.db('admin');
    await a.command({ createUser: 'monitor', pwd: 'monitor-pass-123', roles: [{ role: 'clusterMonitor', db: 'admin' }] });
    // authenticated, but with a role that does NOT include monitoring commands
    await a.command({ createUser: 'reader', pwd: 'reader-pass-123', roles: [{ role: 'read', db: 'appdata' }] });
    await cl.db('appdata').collection('customers').insertOne({ email: 'secret-customer-data@example.com' });
  });
}, 300_000);
afterAll(async () => { await auth?.stop(); await rs?.stop(); });

describe('contract (real mongod, authentication enabled)', () => {
  test('satisfies the connector contract', async () => {
    const results = await runConnectorContract(c, {
      valid: { config: cfg(authPort, { username: 'monitor' }), creds: { password: 'monitor-pass-123' }, authMethod: 'scram' },
      wrongCreds: { creds: { password: 'wrong-password-1' } },
      unreachable: { config: cfg(1, { username: 'monitor' }) },
      network: dev,
    });
    expect(results.filter((r) => !r.ok)).toEqual([]);
  });
});

describe('least privilege', () => {
  test('a clusterMonitor-only user passes and gets metrics + inventory capabilities', async () => {
    const r = await test_(cfg(authPort, { username: 'monitor' }), { password: 'monitor-pass-123' });
    expect(r.ok).toBe(true);
    const caps = Object.fromEntries(r.capabilities.map((x) => [x.id.split(':').pop(), x.available]));
    expect(caps.server_status).toBe(true);
    expect(caps.list_databases).toBe(true);
    expect(caps.replication_status).toBe(false); // standalone: reported honestly, with a reason
    expect(r.capabilities.find((x) => x.id.endsWith('replication_status'))?.reason).toMatch(/replica-set/);
    expect(r.facts.topology).toBe('standalone');
  });

  test('an authenticated user WITHOUT monitoring privileges is reported as permission_denied (not healthy, not an auth error)', async () => {
    const r = await test_(cfg(authPort, { username: 'reader' }), { password: 'reader-pass-123' });
    expect(r.ok).toBe(false);
    expect(r.failure?.kind).toBe('permission_denied');
    expect(r.failure?.remediation).toMatch(/clusterMonitor/);
    expect(r.capabilities.find((x) => x.id.endsWith('server_status'))?.available).toBe(false);
  });

  test('wrong password -> authentication; wrong user -> authentication', async () => {
    expect((await test_(cfg(authPort, { username: 'monitor' }), { password: 'nope-nope-nope' })).failure?.kind).toBe('authentication');
    expect((await test_(cfg(authPort, { username: 'ghost' }), { password: 'whatever-123' })).failure?.kind).toBe('authentication');
  });

  test('no credentials against an auth-enabled server cannot monitor anything', async () => {
    const r = await test_(cfg(authPort), {});
    expect(r.ok).toBe(false);
    expect(['permission_denied', 'authentication']).toContain(r.failure?.kind);
  });
});

describe('replica set (no auth)', () => {
  test('reports replication capability and topology', async () => {
    const r = await test_(cfg(rsPort), {});
    expect(r.ok).toBe(true);
    expect(r.facts.topology).toBe('replica set');
    expect(r.capabilities.find((x) => x.id.endsWith('replication_status'))?.available).toBe(true);
  });
});

describe('discovery never reads collection contents', () => {
  test('lists the instance and database NAMES only', async () => {
    const d = await c.discover(testContext(dev), cfg(authPort, { username: 'monitor' }), { password: 'monitor-pass-123' });
    const names = d.resources.map((x) => x.name);
    expect(d.resources.find((x) => x.type === 'mongodb_instance')).toBeDefined();
    expect(names).toContain('appdata');
    expect(JSON.stringify(d)).not.toContain('secret-customer-data'); // document contents are never fetched
    expect(JSON.stringify(d)).not.toContain('customers'); // not even collection names
    for (const r of d.resources) expect(r.signals.length).toBeGreaterThan(0);
  });
});

describe('command allow-list', () => {
  test.each(['find', 'insert', 'drop', 'dropDatabase', 'delete', 'update', 'createUser', 'eval', 'shutdown', 'aggregate', 'listCollections', 'currentOp', 'killOp', 'setParameter'])(
    '%s is refused before it reaches the wire', async (name) => {
      const client = new MongoClient(`mongodb://127.0.0.1:${rsPort}/?directConnection=true`);
      try {
        await expect(safeAdminCommand(client, { [name]: 1 })).rejects.toThrow(/not permitted/);
      } finally { await client.close(); }
    });
});

describe('network policy and secrets', () => {
  test('loopback and metadata targets are refused under the strict policy, before any connection', async () => {
    for (const host of ['127.0.0.1', '169.254.169.254', '10.1.2.3']) {
      const r = await test_(c.configSchema.parse({ hosts: [{ host, port: 27017 }], tls: false }), {}, STRICT_POLICY);
      expect(r.ok, host).toBe(false);
      expect(r.failure?.kind, host).toBe('misconfigured');
    }
  });

  test('the password never appears in any report, including failures', async () => {
    const pw = 'monitor-pass-123';
    for (const report of [
      await test_(cfg(authPort, { username: 'monitor' }), { password: pw }),
      await test_(cfg(authPort, { username: 'reader' }), { password: pw }),
      await test_(cfg(1, { username: 'monitor' }), { password: pw }),
    ]) expect(JSON.stringify(report)).not.toContain(pw);
  });

  test('config validation: scram needs a username; unknown fields and absurd host lists are rejected', () => {
    expect(c.validateConfig?.(cfg(1), 'scram')).toHaveLength(1);
    expect(c.validateConfig?.(cfg(1, { username: 'u' }), 'none')).toHaveLength(1);
    expect(c.configSchema.safeParse({ hosts: [{ host: 'a' }], directConnection: false }).success).toBe(false);
    expect(c.configSchema.safeParse({ hosts: Array.from({ length: 8 }, () => ({ host: 'a' })) }).success).toBe(false);
    expect(c.configSchema.parse({ hosts: [{ host: 'a' }] }).tls).toBe(true); // TLS by default
  });
});
