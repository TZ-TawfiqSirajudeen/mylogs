import { resolveSafeTarget } from '@nexus/security';
import {
  capSeries, ConnectorError, type CollectionResult, type Connector, type ConnectorContext, type ConnectorDescriptor, type DetectedCapability,
  type DiscoveredResource, type DiscoveryResult, type MetricSample, type SelectionInput, type TestReport,
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
  collection: 'implemented',
  signals: [
    { signal: 'metrics', availability: 'supported', note: 'Sampled on the polling interval from serverStatus (connections, operation counters, memory, network, uptime), replSetGetStatus (replica-set state and lag) and dbStats for the databases you select. Counters become per-interval increases; nothing is read from your collections.' },
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
    'Metrics are collected only for the members and databases you select, at most 500 series per connection (extra series are dropped and reported)',
    'Counter restarts are detected by the value decreasing; a restart is missed only if the counter has already passed its old value',
    'Memory comes from whatever the server version reports: mem.resident/virtual (MongoDB up to 8.1) or the allocator figures (8.x); a field the server does not return is not shown',
    'Atlas shared tiers (M0/M2/M5) may refuse some commands (e.g. replSetGetStatus); those metrics are then skipped and noted, not invented',
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
    return new ConnectorError('permission_denied', 'The user is authenticated but not authorized for a required command', { remediation: 'Grant the clusterMonitor role to the monitoring user (see "Required permissions"); it does not allow reading any collection.' });
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

/**
 * Timeouts, in one place so failure-injection tests can shrink them. `hostBudgetMs` bounds EVERYTHING one member costs in one run
 * (connect + every command): a member that accepts the connection and then goes silent must not eat the whole collection deadline.
 */
export const mongoTuning = { serverSelectionMs: 5_000, connectMs: 5_000, socketMs: 10_000, hostBudgetMs: 12_000 };

/** Opens a client to ONE validated host and guarantees it is closed (also on cancellation and when this member's own time budget is spent). */
async function withClient<T>(ctx: ConnectorContext, config: MongoConfig, host: { host: string; port: number }, c: MongoCreds, fn: (client: MongoClient) => Promise<T>): Promise<T> {
  if (ctx.signal.aborted) throw new ConnectorError('cancelled', 'Cancelled');
  let target;
  try {
    // Re-validated on every run. The driver resolves the name again when connecting (see threat model T2).
    target = await resolveSafeTarget(host.host, host.port, ctx.network);
  } catch (e) { throw fromTargetRejection(e); }
  const client = new MongoClient(`mongodb://${target.host.includes(':') ? `[${target.host}]` : target.host}:${target.port}/`, {
    directConnection: true, tls: config.tls, maxPoolSize: 1, appName: 'nexus-monitor',
    serverSelectionTimeoutMS: mongoTuning.serverSelectionMs, connectTimeoutMS: mongoTuning.connectMs, socketTimeoutMS: mongoTuning.socketMs, retryWrites: false, retryReads: false,
    readPreference: 'secondaryPreferred',
    ...(config.username && c.password ? { auth: { username: config.username, password: c.password }, authSource: config.authSource } : {}),
  });
  const budgetError = () => new ConnectorError('timeout', `${hostLabel(host)} did not finish within ${Math.round(mongoTuning.hostBudgetMs / 1000)}s`, {
    remediation: 'The member accepted the connection but stopped answering. Check its load and that no firewall silently drops its packets.',
  });
  let timer: NodeJS.Timeout | undefined;
  const spent = new Promise<never>((_, reject) => { timer = setTimeout(() => { void client.close(true).catch(() => undefined); reject(budgetError()); }, mongoTuning.hostBudgetMs); });
  spent.catch(() => undefined);
  const onAbort = () => { void client.close(true).catch(() => undefined); };
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  try {
    // Racing the work against an explicit timer means a silent member cannot hold this call open even if the driver never rejects.
    const work = (async () => { await client.connect(); return fn(client); })();
    work.catch(() => undefined);
    return await Promise.race([work, spent]);
  } catch (e) {
    if (ctx.signal.aborted) throw new ConnectorError('cancelled', 'Cancelled');
    throw mapError(e, config.tls);
  } finally {
    clearTimeout(timer);
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

// ---------------------------------------------------------------- collection

const OPERATIONS = ['insert', 'query', 'update', 'delete', 'getmore', 'command'] as const;
const MIB = 1024 * 1024;
const finite = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : v && typeof (v as { toNumber?: unknown }).toNumber === 'function' ? (v as { toNumber(): number }).toNumber() : NaN;
  return Number.isFinite(n) ? n : null;
};
const label = (s: string) => (s.length > 128 ? s.slice(0, 128) : s);

/** The serverStatus-derived samples of ONE member. Only fields the server actually returned are emitted. */
export function serverSamples(status: Document, address: string): MetricSample[] {
  const out: MetricSample[] = [];
  const at = { 'server.address': label(address) };
  const add = (name: string, unit: string, description: string, kind: MetricSample['kind'], raw: unknown, extra: Record<string, string> = {}, scale = 1) => {
    const v = finite(raw);
    if (v !== null) out.push({ name, unit, description, kind, value: v * scale, attributes: { ...at, ...extra } });
  };
  const conn = (status.connections ?? {}) as Document;
  add('mongodb.connections.current', '{connection}', 'Open client connections', 'gauge', conn.current);
  add('mongodb.connections.available', '{connection}', 'Connections still available before the limit', 'gauge', conn.available);
  add('mongodb.connections.created', '{connection}', 'Connections opened since the server started', 'sum', conn.totalCreated);
  const ops = (status.opcounters ?? {}) as Document;
  for (const op of OPERATIONS) add('mongodb.operations', '{operation}', 'Operations executed since the server started', 'sum', ops[op], { operation: op });
  const mem = (status.mem ?? {}) as Document;
  add('mongodb.memory.resident', 'By', 'Resident memory of the mongod process', 'gauge', mem.resident, {}, MIB);
  add('mongodb.memory.virtual', 'By', 'Virtual memory of the mongod process', 'gauge', mem.virtual, {}, MIB);
  // MongoDB 8.x no longer returns `mem`; the allocator section is what it reports instead. Each is emitted only if the server returned it.
  const tc = ((status.tcmalloc ?? {}) as Document).generic as Document | undefined;
  add('mongodb.memory.allocated', 'By', 'Memory currently allocated by the mongod allocator (tcmalloc)', 'gauge', tc?.current_allocated_bytes);
  add('mongodb.memory.heap', 'By', 'Heap size reserved by the mongod allocator (tcmalloc)', 'gauge', tc?.heap_size);
  const net = (status.network ?? {}) as Document;
  add('mongodb.network.io', 'By', 'Bytes transferred over the network since the server started', 'sum', net.bytesIn, { direction: 'in' });
  add('mongodb.network.io', 'By', 'Bytes transferred over the network since the server started', 'sum', net.bytesOut, { direction: 'out' });
  add('mongodb.network.requests', '{request}', 'Requests received since the server started', 'sum', net.numRequests);
  add('mongodb.uptime', 's', 'Seconds since the server started', 'gauge', status.uptime);
  return out;
}

/** Replica-set samples of the member that answered. `self` is the member this connection is to. */
export function replicationSamples(rs: Document, address: string): MetricSample[] {
  const out: MetricSample[] = [];
  const at = { 'server.address': label(address), 'mongodb.replica_set': label(String(rs.set ?? '')) };
  const state = finite(rs.myState);
  if (state !== null) out.push({ name: 'mongodb.replication.member_state', unit: '1', description: 'Replica-set member state code as reported by the server (1 = PRIMARY, 2 = SECONDARY, others per the MongoDB documentation)', kind: 'gauge', value: state, attributes: at });
  const members = Array.isArray(rs.members) ? (rs.members as Document[]) : [];
  const self = members.find((m) => m.self === true);
  const primary = members.find((m) => m.stateStr === 'PRIMARY');
  // `lastAppliedWallTime` has millisecond resolution; `optimeDate` only whole seconds (and on an idle set can sit seconds behind the wall time of the last
  // applied operation). Prefer the wall time when BOTH members report one, otherwise fall back to optimeDate for older servers.
  // A primary this member's heartbeats mark as down (health 0) has a frozen optime: the "lag" against it would just grow while it is unreachable. Report nothing instead.
  if (self && primary && self !== primary && primary.health !== 0) {
    const useWall = self.lastAppliedWallTime instanceof Date && primary.lastAppliedWallTime instanceof Date;
    const mine = useWall ? self.lastAppliedWallTime : self.optimeDate;
    const theirs = useWall ? primary.lastAppliedWallTime : primary.optimeDate;
    if (mine instanceof Date && theirs instanceof Date) {
      out.push({ name: 'mongodb.replication.lag', unit: 's', description: "How far this secondary's last applied operation is behind the primary's (as this member last saw it; the primary's figure arrives with heartbeats, about every 2 s)", kind: 'gauge', value: Math.max(0, (theirs.getTime() - mine.getTime()) / 1000), attributes: at });
    }
  }
  return out;
}

export function databaseSamples(stats: Document, address: string, db: string): MetricSample[] {
  const out: MetricSample[] = [];
  const at = { 'server.address': label(address), 'db.namespace': label(db) };
  const add = (name: string, unit: string, description: string, raw: unknown) => { const v = finite(raw); if (v !== null) out.push({ name, unit, description, kind: 'gauge', value: v, attributes: at }); };
  add('mongodb.database.data_size', 'By', 'Uncompressed size of the data in the database', stats.dataSize);
  add('mongodb.database.storage_size', 'By', "Disk space allocated to the database's collections", stats.storageSize);
  add('mongodb.database.index_size', 'By', "Disk space used by the database's indexes", stats.indexSize);
  add('mongodb.database.collections', '{collection}', 'Collections in the database', stats.collections);
  add('mongodb.database.objects', '{document}', 'Documents in the database', stats.objects);
  return out;
}

/** Which members and databases the user chose. An unknown or stale id is ignored, never guessed at. */
export function mongoTargets(config: MongoConfig, sel: SelectionInput) {
  const chosen = new Set(sel.resourceIds);
  return config.hosts.map((h) => {
    const l = hostLabel(h);
    const prefix = `db:${l}:`;
    const dbs = sel.resourceIds.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length)).filter(Boolean);
    return { host: h, label: l, server: chosen.has(`instance:${l}`), dbs: [...new Set(dbs)] };
  }).filter((t) => t.server || t.dbs.length > 0);
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

  async collect(ctx, config, c, sel): Promise<CollectionResult> {
    const targets = mongoTargets(config, sel);
    if (targets.length === 0) throw new ConnectorError('misconfigured', 'None of the selected resources belongs to a configured host', { remediation: 'Open the connection, run discovery again and re-select the members and databases to monitor.' });
    // Members are sampled concurrently (at most 7), each inside its own time budget and with its own result buffers: a dead or silent member costs
    // its own budget once instead of delaying the others, and work that outlives a timed-out member can never write into the result.
    const settled = await Promise.all(targets.map(async (t) => {
      const mine = { server: [] as MetricSample[], db: [] as MetricSample[], notes: [] as string[] };
      try {
        await withClient(ctx, config, t.host, c, async (client) => {
          const local = mine;
          if (t.server) {
            local.server.push(...serverSamples(await safeAdminCommand(client, { serverStatus: 1, repl: 0, metrics: 0, locks: 0, wiredTiger: 0 }), t.label));
            try {
              const hello = await safeAdminCommand(client, { hello: 1 });
              if (hello.setName) local.server.push(...replicationSamples(await safeAdminCommand(client, { replSetGetStatus: 1 }), t.label));
            } catch (e) { local.notes.push(`${t.label}: replication status unavailable (${mapError(e, config.tls).message})`); }
          }
          for (const db of t.dbs) {
            try { local.db.push(...databaseSamples(await safeAdminCommand(client, { dbStats: 1, scale: 1 }, db), t.label, db)); } catch (e) { local.notes.push(`${t.label}: statistics for database "${truncate(db, 60)}" unavailable (${mapError(e, config.tls).message})`); }
          }
        });
        return { ok: true as const, server: [...mine.server], db: [...mine.db], notes: [...mine.notes] };
      } catch (e) {
        const err = e instanceof ConnectorError ? e : mapError(e, config.tls);
        // What the member answered before it failed is kept (copied: work that outlives a timed-out member must not touch the result).
        return { ok: false as const, err, server: [...mine.server], db: [...mine.db], notes: [...mine.notes, `${t.label}: ${err.message}`] };
      }
    }));
    const gathered = settled.some((r) => r.server.length + r.db.length > 0);
    const failures = settled.flatMap((r) => (r.ok ? [] : [r.err]));
    if (!gathered && settled.every((r) => !r.ok)) {
      // Cancelled (deadline or shutdown) wins over anything else only if nothing at all was gathered.
      throw failures.find((f) => f.kind === 'cancelled') ?? failures[0] ?? new ConnectorError('unreachable', 'No selected member could be reached');
    }
    const notes = settled.flatMap((r) => r.notes);
    const capped = capSeries([...settled.flatMap((r) => r.server), ...settled.flatMap((r) => r.db)]);
    if (capped.samples.length === 0) throw new ConnectorError('permission_denied', 'The server answered but returned no measurements', { remediation: 'Grant the clusterMonitor role to the monitoring user (see "Required permissions").' });
    return { samples: capped.samples, dropped: capped.dropped, notes };
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
