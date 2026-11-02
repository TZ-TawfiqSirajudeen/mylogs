import { isIP } from 'node:net';
import { resolveSafeTarget } from '@nexus/security';
import {
  capSeries, ConnectorError, REMEDIATION, type CollectionResult, type Connector, type ConnectorContext, type ConnectorDescriptor, type DetectedCapability,
  type DiscoveredResource, type DiscoveryResult, type MetricSample, type SelectionInput, type TestReport,
} from '@nexus/connector-sdk';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { fromTargetRejection, guarded, Run } from './run.js';

export const RedisConfig = z.strictObject({
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535).default(6379),
  /** ACL user (Redis 6+). Omit for the default user. */
  username: z.string().min(1).max(128).optional(),
  tls: z.boolean().default(true),
});
export type RedisConfig = z.infer<typeof RedisConfig>;

const creds = { password: z.strictObject({ password: z.string().min(1).max(1024) }), none: z.strictObject({}) };
export type RedisCreds = Partial<{ password: string }>;

const INFO_SECTIONS = new Set(['server', 'clients', 'memory', 'stats', 'replication', 'keyspace', 'cluster']);
const CONFIG_KEYS = new Set(['maxmemory', 'maxmemory-policy']);

/**
 * The only commands this connector can send. All are read-only, none returns key names or values:
 *   PING, INFO <section>, SLOWLOG LEN (a count, not the entries), CONFIG GET maxmemory|maxmemory-policy, ACL WHOAMI.
 * No SCAN/KEYS/GET/etc. exist in the allow-list, so keys and values can never be collected.
 */
export function isAllowedRedisCommand(args: string[]): boolean {
  const [cmd, a, b] = args.map((x) => x.toLowerCase());
  switch (cmd) {
    case 'ping': return args.length === 1;
    case 'info': return args.length === 2 && INFO_SECTIONS.has(a ?? '');
    case 'slowlog': return args.length === 2 && a === 'len';
    case 'config': return args.length === 3 && a === 'get' && CONFIG_KEYS.has(b ?? '');
    case 'acl': return args.length === 2 && a === 'whoami';
    default: return false;
  }
}

export async function safeRedisCall(client: Pick<Redis, 'call'>, ...args: string[]): Promise<unknown> {
  if (!isAllowedRedisCommand(args)) throw new Error(`Command "${args[0] ?? ''}" is not permitted for monitoring connections`);
  return client.call(args[0]!, ...args.slice(1));
}

const descriptor: ConnectorDescriptor = {
  type: 'redis',
  displayName: 'Redis / Redis-compatible',
  category: 'cache',
  status: 'implemented',
  collection: 'implemented',
  signals: [
    { signal: 'metrics', availability: 'supported', note: 'Sampled on the polling interval from INFO: memory, clients, commands and ops/sec, keyspace hits/misses, evictions, expirations, network bytes, replication offset/link, and key counts of the databases you select. Counters become per-interval increases.' },
    { signal: 'inventory', availability: 'supported', note: 'Instance and keyspace key COUNTS per logical database (never key names or values).' },
    { signal: 'logs', availability: 'unsupported' }, { signal: 'traces', availability: 'unsupported', note: 'Redis operations appear in application traces.' },
    { signal: 'events', availability: 'requires_config', note: 'Slow-log entries are not read; only the slow-log length is available (planned).' },
  ],
  deploymentTypes: ['standalone', 'primary/replica (each node listed individually)', 'managed Redis-compatible services (direct endpoint)'],
  authMethods: [
    { id: 'password', label: 'Password / ACL user', recommended: true, description: 'Use a dedicated ACL user limited to the monitoring commands (Redis 6+). Older versions only support the shared requirepass.', secretFields: [{ name: 'password', label: 'Password' }] },
    { id: 'none', label: 'No authentication', recommended: false, description: 'Only for local development instances.', secretFields: [] },
  ],
  requiredPermissions: [
    { scope: 'ACL', permission: '+ping +info +slowlog|len +config|get +acl|whoami', why: 'The only commands the connector issues. No key access (~*) is needed.' },
  ],
  operations: ['PING', 'INFO', 'SLOWLOG LEN', 'CONFIG GET maxmemory*', 'ACL WHOAMI'],
  configRequirements: ['One host:port per connection (add each primary/replica separately)', 'TLS enabled (default)'],
  limitations: [
    'Cluster topology is not discovered; connect to each node',
    'No key scans, no key/value reads, ever',
    'Metrics are collected only for the instance and logical databases you select, at most 500 series per connection',
    'Counter restarts are detected by the value decreasing; a restart is missed only if the counter has already passed its old value',
    'Hostnames are pinned to the validated IP; TLS verifies the certificate against the configured hostname',
  ],
  leastPrivilegeGuide: [
    'Redis 6+ — create a monitoring user that cannot touch data:',
    '',
    '  ACL SETUSER nexus_monitor on >CHANGE_ME resetkeys -@all +ping +info +slowlog|len +config|get +acl|whoami',
    '',
    'Older Redis only has the shared password (requirepass); prefer upgrading or placing the instance behind a private agent.',
  ].join('\n'),
};

function mapError(e: unknown): ConnectorError {
  if (e instanceof ConnectorError) return e;
  const err = e as { message?: string; code?: string; name?: string };
  const m = err.message ?? '';
  if (/WRONGPASS|NOAUTH|invalid password|invalid username-password|Authentication required|AUTH.*(failed|called without)/i.test(m)) {
    return new ConnectorError('authentication', 'Redis rejected the credentials or requires authentication');
  }
  if (/NOPERM|no permissions|not allowed to run/i.test(m)) return new ConnectorError('permission_denied', 'The ACL user is not allowed to run a required command', { remediation: 'Grant +ping and +info (and, optionally, +slowlog|len +config|get +acl|whoami) to the monitoring ACL user. See "Required permissions".' });
  // Redis answers "-ERR max number of clients reached" and hangs up: from the outside that looks like a dead server, but it is an overloaded one.
  if (/max number of clients|maxclients/i.test(m)) return new ConnectorError('unhealthy', 'Redis refused the connection: its client limit (maxclients) is reached', { remediation: 'Close idle clients or raise maxclients on the Redis server; the platform will retry with back-off.' });
  if (/timed? ?out|ETIMEDOUT/i.test(m) || err.code === 'ETIMEDOUT') return new ConnectorError('timeout', 'The connection to Redis timed out');
  // A reset is what Redis builds without the "max number of clients" reply do when they are full; it is also what a restart or a proxy does. Say all three.
  if (/ECONNRESET/.test(m) || err.code === 'ECONNRESET') {
    return new ConnectorError('unreachable', 'Redis reset the connection (client limit reached, server restarting, or a proxy dropped it)', { remediation: 'Check whether Redis is at its maxclients limit (INFO clients, CONFIG GET maxclients), restarting, or behind a proxy that closes idle or excess connections. The platform retries with back-off.' });
  }
  if (/ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|ENETUNREACH|Connection is closed|closed the connection|EPIPE/i.test(m) || /ECONN|ENOTFOUND/.test(err.code ?? '')) {
    return new ConnectorError('unreachable', 'Redis is not reachable at the given address');
  }
  if (/ssl|tls|certificate|handshake|wrong version number/i.test(m)) {
    return new ConnectorError('misconfigured', 'TLS handshake with Redis failed', { remediation: 'Check that the endpoint speaks TLS with a trusted certificate that matches the host name, or that TLS is disabled for a non-TLS dev instance.' });
  }
  if (err.name === 'AbortError') return new ConnectorError('cancelled', 'Cancelled');
  return new ConnectorError('internal', 'Unexpected Redis error');
}

/**
 * Limits in one place so failure-injection tests can shrink them.
 *  - `runBudgetMs` bounds a whole connection's work (connect + every command), so a server that answers slowly cannot hold a run for 6 x commandMs;
 *  - `maxResponseBytes` bounds what one run will read from the socket. A real INFO is a few KB; an endpoint that streams more is not a Redis we should buffer.
 */
export const redisTuning = { connectMs: 5_000, commandMs: 5_000, runBudgetMs: 12_000, maxResponseBytes: 2 * 1024 * 1024 };

async function withRedis<T>(ctx: ConnectorContext, config: RedisConfig, c: RedisCreds, fn: (r: Redis) => Promise<T>): Promise<T> {
  if (ctx.signal.aborted) throw new ConnectorError('cancelled', 'Cancelled');
  let target;
  try { target = await resolveSafeTarget(config.host, config.port, ctx.network); } catch (e) { throw fromTargetRejection(e); }
  const ip = target.addresses[0]!;
  const hostIsName = !isIP(target.host);
  const client = new Redis({
    // Connect to the validated IP, never to the name (no second DNS resolution -> no rebinding window).
    host: ip, port: target.port,
    ...(config.username ? { username: config.username } : {}),
    ...(c.password ? { password: c.password } : {}),
    // TLS certificate validation stays on and is checked against the configured host NAME.
    ...(config.tls ? { tls: { ...(hostIsName ? { servername: target.host } : {}) } } : {}),
    lazyConnect: true, connectTimeout: redisTuning.connectMs, commandTimeout: redisTuning.commandMs,
    maxRetriesPerRequest: 0, retryStrategy: () => null, reconnectOnError: () => false,
    enableOfflineQueue: false, autoResubscribe: false, connectionName: 'nexus-monitor',
  });
  // ioredis reports the REAL cause (WRONGPASS, NOAUTH, NOPERM, ECONNREFUSED...) as an 'error' event and then fails the
  // awaited call with a generic "Connection is closed.". Keep the event: it also prevents an unhandled 'error' crash.
  let lastEvent: unknown;
  client.on('error', (e) => { lastEvent = e; });
  const onAbort = () => client.disconnect();
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  let oversize = false;
  let budgetSpent = false;
  let timer: NodeJS.Timeout | undefined;
  const spent = new Promise<never>((_, reject) => { timer = setTimeout(() => { budgetSpent = true; client.disconnect(); reject(new ConnectorError('timeout', `Redis did not finish within ${Math.round(redisTuning.runBudgetMs / 1000)}s`, { remediation: REMEDIATION.timeout })); }, redisTuning.runBudgetMs); });
  spent.catch(() => undefined);
  const watchBytes = () => {
    let total = 0;
    client.stream?.on('data', (d: Buffer) => {
      total += d.length;
      if (total > redisTuning.maxResponseBytes && !oversize) { oversize = true; client.disconnect(); }
    });
  };
  // attached on the socket as soon as it exists: the ready check (an INFO sent by ioredis itself) is part of what must be bounded
  client.once('connect', watchBytes);
  try {
    const work = (async () => { await client.connect(); return fn(client); })();
    work.catch(() => undefined);
    return await Promise.race([work, spent]);
  } catch (e) {
    if (ctx.signal.aborted) throw new ConnectorError('cancelled', 'Cancelled');
    if (oversize) throw new ConnectorError('misconfigured', `The endpoint sent more than ${Math.round(redisTuning.maxResponseBytes / 1024)} KiB; a Redis INFO reply is a few kilobytes`, { remediation: 'This does not look like a Redis server (or it is misbehaving). Check the host and port.' });
    if (budgetSpent) throw e;
    const fromEvent = lastEvent ? mapError(lastEvent) : null;
    // The event is more specific than the generic "Connection is closed" unless it is itself unclassifiable.
    const mapped = fromEvent && fromEvent.kind !== 'internal' ? fromEvent : mapError(e);
    // A TLS client talking to a plaintext port just hangs in the handshake; say so instead of a bare "timed out".
    if (config.tls && mapped.kind === 'timeout') {
      throw new ConnectorError('timeout', 'The TLS handshake with Redis did not complete in time', {
        remediation: 'The endpoint did not answer the TLS handshake. If it does not use TLS, turn TLS off (acceptable only for local development); otherwise check the port and certificate.',
      });
    }
    throw mapped;
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);
    client.disconnect();
  }
}

type Info = Record<string, string>;
function parseInfo(raw: unknown): Info {
  const out: Info = {};
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

interface Probe { version: string; mode: string; role: string; caps: DetectedCapability[]; info: Info; keyspace: { db: string; keys: number; expires: number }[] }

async function probe(client: Redis): Promise<Probe> {
  await safeRedisCall(client, 'PING');
  const server = parseInfo(await safeRedisCall(client, 'INFO', 'server'));
  const caps: DetectedCapability[] = [];
  const info: Info = { ...server };
  for (const [section, cap, label] of [
    ['memory', 'memory', 'Memory usage'], ['clients', 'clients', 'Connected clients'], ['stats', 'stats', 'Operation rate, hit/miss, evictions, expirations'],
    ['replication', 'replication', 'Replication role and health'], ['keyspace', 'keyspace', 'Key counts per database'],
  ] as const) {
    try {
      Object.assign(info, parseInfo(await safeRedisCall(client, 'INFO', section)));
      caps.push({ id: cap, label, available: true, signal: cap === 'keyspace' ? 'inventory' : 'metrics' });
    } catch (e) {
      const m = mapError(e);
      caps.push({ id: cap, label, available: false, signal: cap === 'keyspace' ? 'inventory' : 'metrics', reason: m.kind === 'permission_denied' ? 'Missing ACL permission +info' : m.message });
    }
  }
  for (const [id, label, args] of [
    ['slowlog_len', 'Slow-log length', ['SLOWLOG', 'LEN']], ['config_memory', 'Memory limit and eviction policy', ['CONFIG', 'GET', 'maxmemory']], ['acl_whoami', 'ACL identity', ['ACL', 'WHOAMI']],
  ] as const) {
    try { await safeRedisCall(client, ...args); caps.push({ id, label, available: true, signal: 'metrics' }); } catch (e) {
      const m = mapError(e);
      caps.push({ id, label, available: false, signal: 'metrics', reason: /unknown command|ERR unknown/i.test((e as Error).message) ? 'Not supported by this Redis version' : m.kind === 'permission_denied' ? 'Missing ACL permission' : m.message });
    }
  }
  const keyspace = Object.entries(info).filter(([k]) => /^db\d+$/.test(k)).map(([db, v]) => {
    const keys = /keys=(\d+)/.exec(v)?.[1];
    const expires = /expires=(\d+)/.exec(v)?.[1];
    return { db, keys: Number(keys ?? 0), expires: Number(expires ?? 0) };
  });
  return { version: info.redis_version ?? 'unknown', mode: info.redis_mode ?? 'standalone', role: info.role ?? 'unknown', caps, info, keyspace };
}

// ---------------------------------------------------------------- collection

const finite = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Samples from parsed INFO fields. Only fields the server returned are emitted (older Redis versions lack some). */
export function redisSamples(info: Info, address: string): MetricSample[] {
  const out: MetricSample[] = [];
  const at = { 'server.address': address };
  const add = (name: string, unit: string, description: string, kind: MetricSample['kind'], field: string, extra: Record<string, string> = {}, only?: (n: number) => boolean) => {
    const v = finite(info[field]);
    if (v !== null && (!only || only(v))) out.push({ name, unit, description, kind, value: v, attributes: { ...at, ...extra } });
  };
  add('redis.clients.connected', '{client}', 'Connected client connections (replicas excluded)', 'gauge', 'connected_clients');
  add('redis.clients.blocked', '{client}', 'Clients blocked on a blocking call', 'gauge', 'blocked_clients');
  add('redis.memory.used', 'By', 'Memory allocated by Redis', 'gauge', 'used_memory');
  add('redis.memory.rss', 'By', 'Memory held by the Redis process as seen by the operating system', 'gauge', 'used_memory_rss');
  add('redis.memory.limit', 'By', 'Configured maxmemory (only reported when a limit is set)', 'gauge', 'maxmemory', {}, (n) => n > 0);
  add('redis.commands.processed', '{command}', 'Commands processed since the server started', 'sum', 'total_commands_processed');
  add('redis.commands.rate', '{command}/s', 'Instantaneous commands per second as reported by Redis', 'gauge', 'instantaneous_ops_per_sec');
  add('redis.keyspace.hits', '{lookup}', 'Successful key lookups since the server started', 'sum', 'keyspace_hits');
  add('redis.keyspace.misses', '{lookup}', 'Failed key lookups since the server started', 'sum', 'keyspace_misses');
  add('redis.keys.evicted', '{key}', 'Keys evicted because of the memory limit since the server started', 'sum', 'evicted_keys');
  add('redis.keys.expired', '{key}', 'Keys removed by expiry since the server started', 'sum', 'expired_keys');
  add('redis.connections.received', '{connection}', 'Connections accepted since the server started', 'sum', 'total_connections_received');
  add('redis.connections.rejected', '{connection}', 'Connections refused (maxclients) since the server started', 'sum', 'rejected_connections');
  add('redis.network.io', 'By', 'Bytes transferred over the network since the server started', 'sum', 'total_net_input_bytes', { direction: 'in' });
  add('redis.network.io', 'By', 'Bytes transferred over the network since the server started', 'sum', 'total_net_output_bytes', { direction: 'out' });
  add('redis.uptime', 's', 'Seconds since the server started', 'gauge', 'uptime_in_seconds');
  const role = info.role === 'master' || info.role === 'slave' ? info.role : null;
  if (role) {
    const r = { 'redis.role': role === 'slave' ? 'replica' : 'primary' };
    add('redis.replication.offset', '{byte}', 'Replication stream offset of this node', 'gauge', 'master_repl_offset', r);
    if (role === 'master') add('redis.replication.connected_replicas', '{replica}', 'Replicas currently connected to this primary', 'gauge', 'connected_slaves', r);
    if (role === 'slave' && (info.master_link_status === 'up' || info.master_link_status === 'down')) {
      out.push({ name: 'redis.replication.link_up', unit: '1', description: 'Whether this replica\'s link to its primary is up (1) or down (0)', kind: 'gauge', value: info.master_link_status === 'up' ? 1 : 0, attributes: { ...at, ...r } });
    }
  }
  return out;
}

export function redisKeyspaceSamples(info: Info, address: string, dbs: string[]): MetricSample[] {
  const out: MetricSample[] = [];
  for (const db of dbs) {
    const line = info[db];
    const keys = finite(/keys=(\d+)/.exec(line ?? '')?.[1]);
    const expires = finite(/expires=(\d+)/.exec(line ?? '')?.[1]);
    const at = { 'server.address': address, 'db.namespace': db };
    // A selected database that has no keys disappears from INFO keyspace: report 0 keys (a measurement), not a gap.
    out.push({ name: 'redis.db.keys', unit: '{key}', description: 'Keys in the logical database (a count; names and values are never read)', kind: 'gauge', value: keys ?? 0, attributes: at });
    out.push({ name: 'redis.db.keys_with_expiry', unit: '{key}', description: 'Keys in the logical database that have an expiry', kind: 'gauge', value: expires ?? 0, attributes: at });
  }
  return out;
}

/** What the user chose: the instance (server metrics) and/or logical databases (key counts). Stale ids are ignored. */
export function redisTargets(config: RedisConfig, sel: SelectionInput) {
  const name = `${config.host}:${config.port}`;
  const prefix = `db:${name}:`;
  return {
    address: name,
    server: sel.resourceIds.includes(`instance:${name}`),
    dbs: [...new Set(sel.resourceIds.filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length)).filter((d) => /^db\d+$/.test(d)))],
  };
}

export const redisConnector: Connector<RedisConfig, RedisCreds> = {
  descriptor,
  configSchema: RedisConfig as never,
  credentialSchema: (m) => (m in creds ? (creds[m as keyof typeof creds] as never) : undefined),

  validateConfig(config, authMethod) {
    const issues: string[] = [];
    if (authMethod === 'none' && config.username) issues.push('Remove the username when no authentication is used');
    return issues;
  },

  async test(ctx, config, c): Promise<TestReport> {
    const run = new Run(Object.values(c).filter((v): v is string => typeof v === 'string'));
    return guarded(run, async () => {
      if (!config.tls) run.warn('tls', 'Transport security', 'TLS is disabled: the password and metrics cross the network unencrypted.', 'Enable TLS unless this is a local development instance.');
      const p = await run.step('probe', `Connect, authenticate and probe ${config.host}:${config.port}`, () => withRedis(ctx, config, c, probe),
        (r) => `Redis ${r.version}, ${r.mode}, role ${r.role}`);
      for (const cap of p.caps) run.capability(cap);
      run.facts.version = p.version;
      run.facts.mode = p.mode;
      run.facts.role = p.role;
      run.facts.connectedClients = Number(p.info.connected_clients ?? 0);
      if (!p.caps.find((x) => x.id === 'memory')?.available || !p.caps.find((x) => x.id === 'stats')?.available) {
        throw new ConnectorError('permission_denied', 'The user cannot run INFO memory/stats, which are required for monitoring', {
          remediation: 'Grant +info (and +ping) to the monitoring ACL user. See "Required permissions".',
        });
      }
    });
  },

  async collect(ctx, config, c, sel): Promise<CollectionResult> {
    const t = redisTargets(config, sel);
    if (!t.server && t.dbs.length === 0) throw new ConnectorError('misconfigured', 'None of the selected resources belongs to this connection', { remediation: 'Open the connection, run discovery again and re-select the instance and databases to monitor.' });
    const notes: string[] = [];
    const info: Info = {};
    let ok = 0;
    let firstErr: unknown;
    try {
      await withRedis(ctx, config, c, async (client) => {
        const sections = [...(t.server ? ['server', 'clients', 'memory', 'stats', 'replication'] : []), ...(t.dbs.length ? ['keyspace'] : [])];
        for (const section of sections) {
          try { Object.assign(info, parseInfo(await safeRedisCall(client, 'INFO', section))); ok++; } catch (e) {
            if (ctx.signal.aborted) throw e;
            const m = mapError(e);
            firstErr ??= e;
            notes.push(`INFO ${section} unavailable (${m.message})`);
            // A hung or dropped connection will fail every remaining section the same way, each after its own timeout: stop here and keep what we have.
            if (m.kind === 'timeout' || m.kind === 'unreachable') break;
          }
        }
        if (ok === 0) throw firstErr;
      });
    } catch (e) {
      // A run cut short (deadline, shutdown, connection lost) still returns the sections that did arrive; only an empty-handed run fails.
      if (ok === 0) throw e;
      notes.push(`Collection was cut short: ${mapError(e).message}`);
    }
    const capped = capSeries([...(t.server ? redisSamples(info, t.address) : []), ...redisKeyspaceSamples(info, t.address, t.dbs)]);
    if (capped.samples.length === 0) throw new ConnectorError('permission_denied', 'Redis answered but returned no measurements', { remediation: 'Grant +info to the monitoring ACL user. See "Required permissions".' });
    return { samples: capped.samples, dropped: capped.dropped, notes };
  },

  async discover(ctx, config, c): Promise<DiscoveryResult> {
    const p = await withRedis(ctx, config, c, probe);
    const name = `${config.host}:${config.port}`;
    const resources: DiscoveredResource[] = [{
      id: `instance:${name}`, type: 'redis_instance', name,
      attributes: { version: p.version, mode: p.mode, role: p.role, usedMemoryHuman: p.info.used_memory_human ?? null, connectedClients: Number(p.info.connected_clients ?? 0) },
      signals: ['metrics', 'inventory'],
    }];
    // Key COUNTS only. Names/values are never requested (the allow-list has no command that could return them).
    for (const k of p.keyspace.slice(0, 64)) {
      resources.push({ id: `db:${name}:${k.db}`, type: 'redis_database', name: k.db, attributes: { keys: k.keys, keysWithExpiry: k.expires, instance: name }, signals: ['metrics', 'inventory'] });
    }
    return { resources, capabilities: p.caps, truncated: p.keyspace.length > 64 };
  },
};
