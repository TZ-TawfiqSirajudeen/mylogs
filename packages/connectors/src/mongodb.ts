import { resolveSafeTarget } from '@nexus/security';
import {
  ConnectorError, type Connector, type ConnectorContext, type ConnectorDescriptor, type DetectedCapability,
  type DiscoveredResource, type DiscoveryResult, type TestReport,
} from '@nexus/connector-sdk';
import { MongoClient, MongoNetworkTimeoutError, MongoServerSelectionError, type Document } from 'mongodb';
import { z } from 'zod';
import { fromTargetRejection, guarded, Run, truncate } from './run.js';

const Host = z.strictObject({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(27017),
});

export const MongoConfig = z.strictObject({
  /** Every host is monitored individually (directConnection); replica-set discovery is deliberately not used. */
  hosts: z.array(Host).min(1).max(7),
  authSource: z.string().regex(/^[A-Za-z0-9_.$-]{1,64}$/).default('admin'),
  /** Required for the SCRAM method. */
  username: z.string().min(1).max(128).optional(),
  /** TLS is on by default; turning it off requires an explicit choice (and is flagged in the test report). */
  tls: z.boolean().default(true),
});
export type MongoConfig = z.infer<typeof MongoConfig>;

const creds = { scram: z.strictObject({ password: z.string().min(1).max(1024) }), none: z.strictObject({}) };
export type MongoCreds = Partial<{ password: string }>;

/**
 * The ONLY commands this connector can ever send. Everything is read-only metadata/monitoring; no collection data is
 * read and nothing can write. The wrapper below enforces it, so a future code change cannot silently widen access.
 */
const ALLOWED_COMMANDS = new Set(['ping', 'buildInfo', 'hello', 'serverStatus', 'replSetGetStatus', 'listDatabases', 'dbStats', 'connectionStatus']);

export async function safeAdminCommand(client: MongoClient, command: Document, db = 'admin'): Promise<Document> {
  const name = Object.keys(command)[0] ?? '';
  if (!ALLOWED_COMMANDS.has(name)) throw new Error(`Command "${name}" is not permitted for monitoring connections`);
  return client.db(db).command(command);
}

const descriptor: ConnectorDescriptor = {
  type: 'mongodb',
  displayName: 'MongoDB',
  category: 'database',
  status: 'implemented',
  collection: 'not_implemented',
  signals: [
    { signal: 'metrics', availability: 'supported', note: 'serverStatus (connections, opcounters, memory), replication status where applicable, per-database stats. Metric collection itself is not wired yet.' },
    { signal: 'inventory', availability: 'supported', note: 'Instances and database names (never collection contents).' },
    { signal: 'logs', availability: 'unsupported', note: 'Server logs and the profiler need a log-shipping agent / Atlas API source and different permissions; not provided by this connector.' },
    { signal: 'traces', availability: 'unsupported', note: 'Database operations appear in application traces (OpenTelemetry), not from this connector.' },
    { signal: 'events', availability: 'unsupported' },
  ],
  deploymentTypes: ['self-managed standalone', 'self-managed replica set (each member listed individually)', 'MongoDB Atlas (direct member hostnames)'],
  authMethods: [
    { id: 'scram', label: 'Username + password (SCRAM)', recommended: true, description: 'A dedicated monitoring user with only the clusterMonitor role.', secretFields: [{ name: 'password', label: 'Password' }] },
    { id: 'none', label: 'No authentication', recommended: false, description: 'Only for local development instances.', secretFields: [] },
  ],
  requiredPermissions: [
    { scope: 'admin', permission: 'clusterMonitor role', why: 'Allows ping, buildInfo, hello, serverStatus, replSetGetStatus, listDatabases and dbStats — and nothing that reads documents.' },
    { scope: 'any', permission: 'profile / system.profile read', why: 'Slow-operation evidence needs the profiler (not used by this connector).', optional: true },
  ],
  operations: ['ping', 'buildInfo', 'hello', 'serverStatus', 'replSetGetStatus', 'listDatabases', 'dbStats', 'connectionStatus'],
  configRequirements: ['1–7 hostnames/ports reachable from the platform (public, or an approved private network path)', 'TLS enabled (default)'],
  limitations: [
    'Topology discovery is disabled: list every member you want monitored',
    'DNS is resolved by the driver at connect time; network egress rules are still required (see threat model T2)',
    'Collection contents, the profiler and server logs are never read',
  ],
  leastPrivilegeGuide: [
    'Create a dedicated monitoring user (run in mongosh as an admin):',
    '',
    '  use admin',
    '  db.createUser({ user: "nexus_monitor", pwd: passwordPrompt(), roles: [ { role: "clusterMonitor", db: "admin" } ] })',
    '',
    'clusterMonitor grants read-only monitoring commands. It does NOT allow reading any collection.',
  ].join('\n'),
};

function mapError(e: unknown, tls: boolean): ConnectorError {
  if (e instanceof ConnectorError) return e;
  const err = e as { code?: number; codeName?: string; message?: string; name?: string };
  if (err.code === 18 || err.codeName === 'AuthenticationFailed' || err.code === 11) {
    return new ConnectorError('authentication', 'MongoDB rejected the username or password');
  }
  if (err.code === 13 || err.codeName === 'Unauthorized') {
    return new ConnectorError('permission_denied', 'The user is authenticated but not authorized for a required command');
  }
  if (e instanceof MongoNetworkTimeoutError || /timed out/i.test(err.message ?? '')) return new ConnectorError('timeout', 'The connection to MongoDB timed out');
  if (e instanceof MongoServerSelectionError) {
    const tlsHint = tls && /ssl|tls|certificate|handshake/i.test(err.message ?? '');
    return new ConnectorError('unreachable', tlsHint ? 'TLS handshake with MongoDB failed' : 'MongoDB is not reachable at the given address', tlsHint ? { remediation: 'Verify that the server speaks TLS with a trusted certificate, or that TLS is disabled for a non-TLS dev instance.' } : {});
  }
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|ENETUNREACH/.test(err.message ?? '')) return new ConnectorError('unreachable', 'MongoDB is not reachable at the given address');
  if (err.name === 'AbortError') return new ConnectorError('cancelled', 'Cancelled');
  return new ConnectorError('internal', `MongoDB error (${err.codeName ?? err.name ?? 'unknown'})`);
}

/** Opens a client to ONE validated host and guarantees it is closed (also on cancellation). */
async function withClient<T>(ctx: ConnectorContext, config: MongoConfig, host: { host: string; port: number }, c: MongoCreds, fn: (client: MongoClient) => Promise<T>): Promise<T> {
  if (ctx.signal.aborted) throw new ConnectorError('cancelled', 'Cancelled');
  let target;
  try {
    // Re-validated on every run. The driver resolves the name again when connecting (see threat model T2).
    target = await resolveSafeTarget(host.host, host.port, ctx.network);
  } catch (e) { throw fromTargetRejection(e); }
  const client = new MongoClient(`mongodb://${target.host.includes(':') ? `[${target.host}]` : target.host}:${target.port}/`, {
    directConnection: true, tls: config.tls, maxPoolSize: 1, appName: 'nexus-monitor',
    serverSelectionTimeoutMS: 5_000, connectTimeoutMS: 5_000, socketTimeoutMS: 10_000, retryWrites: false, retryReads: false,
    readPreference: 'secondaryPreferred',
    ...(config.username && c.password ? { auth: { username: config.username, password: c.password }, authSource: config.authSource } : {}),
  });
  const onAbort = () => { void client.close(true); };
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  try {
    await client.connect();
    return await fn(client);
  } catch (e) {
    if (ctx.signal.aborted) throw new ConnectorError('cancelled', 'Cancelled');
    throw mapError(e, config.tls);
  } finally {
    ctx.signal.removeEventListener('abort', onAbort);
    await client.close(true).catch(() => undefined);
  }
}

const hostLabel = (h: { host: string; port: number }) => `${h.host}:${h.port}`;

interface Probe { version: string; topology: string; setName: string | null; writable: boolean; caps: DetectedCapability[]; databases: { name: string; sizeOnDisk: number | null }[] | null }

async function probeHost(client: MongoClient): Promise<Probe> {
  await safeAdminCommand(client, { ping: 1 });
  const [build, hello] = await Promise.all([safeAdminCommand(client, { buildInfo: 1 }), safeAdminCommand(client, { hello: 1 })]);
  const topology = hello.msg === 'isdbgrid' ? 'sharded (mongos)' : hello.setName ? 'replica set' : 'standalone';
  const caps: DetectedCapability[] = [];
  const attempt = async <T>(id: string, label: string, signal: DetectedCapability['signal'], fn: () => Promise<T>, unsupportedReason?: (e: ConnectorError) => string | undefined): Promise<T | null> => {
    try {
      const v = await fn();
      caps.push({ id, label, available: true, ...(signal ? { signal } : {}) });
      return v;
    } catch (e) {
      const m = mapError(e, true);
      caps.push({ id, label, available: false, ...(signal ? { signal } : {}), reason: unsupportedReason?.(m) ?? (m.kind === 'permission_denied' ? 'Missing permission (grant the clusterMonitor role)' : m.message) });
      return null;
    }
  };
  await attempt('server_status', 'Server metrics (connections, opcounters, memory)', 'metrics', () => safeAdminCommand(client, { serverStatus: 1, repl: 0, metrics: 0, locks: 0, wiredTiger: 0 }));
  if (hello.setName) await attempt('replication_status', 'Replication status and lag', 'metrics', () => safeAdminCommand(client, { replSetGetStatus: 1 }));
  else caps.push({ id: 'replication_status', label: 'Replication status and lag', available: false, signal: 'metrics', reason: 'Not a replica-set member' });
  const dbs = await attempt('list_databases', 'Database inventory', 'inventory', async () => {
    const r = await safeAdminCommand(client, { listDatabases: 1, nameOnly: false, authorizedDatabases: true });
    return (r.databases as { name: string; sizeOnDisk?: number }[]).map((d) => ({ name: truncate(d.name, 120), sizeOnDisk: typeof d.sizeOnDisk === 'number' ? d.sizeOnDisk : null }));
  });
  return { version: String(build.version), topology, setName: (hello.setName as string | undefined) ?? null, writable: !!hello.isWritablePrimary, caps, databases: dbs };
}

const REQUIRED_CAPABILITY = 'server_status';

export const mongodbConnector: Connector<MongoConfig, MongoCreds> = {
  descriptor,
  configSchema: MongoConfig as never,
  credentialSchema: (m) => (m in creds ? (creds[m as keyof typeof creds] as never) : undefined),

  validateConfig(config, authMethod) {
    const issues: string[] = [];
    if (authMethod === 'scram' && !config.username) issues.push('A username is required for the SCRAM method');
    if (authMethod === 'none' && config.username) issues.push('Remove the username when no authentication is used');
    return issues;
  },

  async test(ctx, config, c): Promise<TestReport> {
    const run = new Run(Object.values(c).filter((v): v is string => typeof v === 'string'));
    return guarded(run, async () => {
      if (!config.tls) run.warn('tls', 'Transport security', 'TLS is disabled: credentials and metrics cross the network unencrypted.', 'Enable TLS unless this is a local development instance.');
      let first: Probe | null = null;
      let firstFailure: ConnectorError | null = null;
      for (const h of config.hosts) {
        try {
          const p = await run.step(`probe:${hostLabel(h)}`, `Connect, authenticate and probe ${hostLabel(h)}`,
            () => withClient(ctx, config, h, c, probeHost), (r) => `MongoDB ${r.version}, ${r.topology}${r.setName ? ` "${r.setName}"` : ''}`);
          first ??= p;
          for (const cap of p.caps) run.capability({ ...cap, id: `${hostLabel(h)}:${cap.id}`, label: `${cap.label} (${hostLabel(h)})` });
        } catch (e) {
          const err = e instanceof ConnectorError ? e : mapError(e, config.tls);
          if (err.kind === 'cancelled') throw err;
          firstFailure ??= err;
        }
      }
      if (!first) throw firstFailure ?? new ConnectorError('unreachable', 'No host could be reached');
      const missing = run.capabilities.filter((x) => x.id.endsWith(`:${REQUIRED_CAPABILITY}`) && !x.available);
      if (firstFailure) {
        // Reachable members + unreachable members: usable, but not healthy.
        throw new ConnectorError(firstFailure.kind === 'authentication' ? 'authentication' : 'unhealthy', `${config.hosts.length - 1 > 0 ? 'At least one configured host failed' : 'Host failed'}: ${firstFailure.message}`, firstFailure.remediation ? { remediation: firstFailure.remediation } : {});
      }
      if (missing.length) {
        throw new ConnectorError('permission_denied', 'The user cannot run serverStatus, which is required for monitoring', {
          remediation: 'Grant the clusterMonitor role to the monitoring user (see "Required permissions"); it does not allow reading any collection.',
        });
      }
      run.facts.version = first.version;
      run.facts.topology = first.topology;
      run.facts.hostsChecked = config.hosts.length;
    });
  },

  async discover(ctx, config, c): Promise<DiscoveryResult> {
    const resources: DiscoveredResource[] = [];
    const capabilities: DetectedCapability[] = [];
    let truncated = false;
    for (const h of config.hosts) {
      const p = await withClient(ctx, config, h, c, probeHost);
      resources.push({
        id: `instance:${hostLabel(h)}`, type: 'mongodb_instance', name: hostLabel(h),
        attributes: { version: p.version, topology: p.topology, replicaSet: p.setName, writablePrimary: p.writable },
        signals: p.caps.some((x) => x.id === 'server_status' && x.available) ? ['metrics', 'inventory'] : ['inventory'],
      });
      for (const cap of p.caps) capabilities.push({ ...cap, id: `${hostLabel(h)}:${cap.id}`, label: `${cap.label} (${hostLabel(h)})` });
      for (const d of (p.databases ?? []).slice(0, 200)) {
        resources.push({ id: `db:${hostLabel(h)}:${d.name}`, type: 'mongodb_database', name: d.name, attributes: { sizeOnDiskBytes: d.sizeOnDisk, instance: hostLabel(h) }, signals: ['metrics', 'inventory'] });
      }
      if ((p.databases?.length ?? 0) > 200) truncated = true;
    }
    return { resources, capabilities, truncated };
  },
};
