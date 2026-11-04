import type { Collection, Db } from 'mongodb';
import { buildSearchText } from './search-text.js';

export interface Migration {
  version: number;
  name: string;
  up(db: Db): Promise<void>;
  /** Documented rollback. Must only undo what `up` created. */
  down(db: Db): Promise<void>;
}

const V1_INDEXES: Record<string, string[]> = {
  organizations: ['org_slug_uq'],
  users: ['user_email_uq'],
  org_memberships: ['orgm_uq', 'orgm_user'],
  projects: ['project_slug_uq'],
  environments: ['env_slug_uq', 'env_org_project'],
  project_memberships: ['projm_uq', 'projm_user'],
  sessions: ['session_token_uq', 'session_ttl'],
  audit_events: ['audit_org_seq', 'audit_org_project_seq'],
};

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'control-plane-indexes',
    async up(db) {
      // Collections must exist before any transaction touches them.
      for (const name of [...Object.keys(V1_INDEXES), 'counters']) {
        await db.createCollection(name).catch(() => undefined);
      }
      await db.collection('organizations').createIndex({ slug: 1 }, { unique: true, name: 'org_slug_uq' });
      await db.collection('users').createIndex({ emailLower: 1 }, { unique: true, name: 'user_email_uq' });
      await db.collection('org_memberships').createIndex({ orgId: 1, userId: 1 }, { unique: true, name: 'orgm_uq' });
      await db.collection('org_memberships').createIndex({ userId: 1 }, { name: 'orgm_user' });
      await db.collection('projects').createIndex({ orgId: 1, slug: 1 }, { unique: true, name: 'project_slug_uq' });
      await db.collection('environments').createIndex({ projectId: 1, slug: 1 }, { unique: true, name: 'env_slug_uq' });
      await db.collection('environments').createIndex({ orgId: 1, projectId: 1 }, { name: 'env_org_project' });
      await db.collection('project_memberships').createIndex({ projectId: 1, userId: 1 }, { unique: true, name: 'projm_uq' });
      await db.collection('project_memberships').createIndex({ orgId: 1, userId: 1 }, { name: 'projm_user' });
      await db.collection('sessions').createIndex({ tokenHash: 1 }, { unique: true, name: 'session_token_uq' });
      // TTL: expired sessions are physically removed (revoked ones at their natural expiry).
      await db.collection('sessions').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'session_ttl' });
      await db.collection('audit_events').createIndex({ orgId: 1, seq: -1 }, { unique: true, name: 'audit_org_seq' });
      await db.collection('audit_events').createIndex({ orgId: 1, projectId: 1, seq: -1 }, { name: 'audit_org_project_seq' });
    },
    async down(db) {
      for (const [coll, names] of Object.entries(V1_INDEXES)) {
        for (const n of names) await db.collection(coll).dropIndex(n).catch(() => undefined);
      }
    },
  },
  {
    version: 2,
    name: 'connections-and-secrets',
    async up(db) {
      for (const name of ['secrets', 'connections']) await db.createCollection(name).catch(() => undefined);
      await db.collection('secrets').createIndex({ orgId: 1, connectionId: 1, name: 1 }, { unique: true, name: 'secret_scope_uq' });
      await db.collection('connections').createIndex({ orgId: 1, projectId: 1, environmentId: 1 }, { name: 'conn_scope' });
      await db.collection('connections').createIndex({ orgId: 1, projectId: 1, environmentId: 1, name: 1 }, { unique: true, name: 'conn_name_uq' });
      // worker claim query: active connections that are due for a health check
      await db.collection('connections').createIndex({ lifecycle: 1, 'health.nextCheckAt': 1 }, { name: 'conn_due' });
    },
    async down(db) {
      for (const [c, n] of [['secrets', 'secret_scope_uq'], ['connections', 'conn_scope'], ['connections', 'conn_name_uq'], ['connections', 'conn_due']] as const) {
        await db.collection(c).dropIndex(n).catch(() => undefined);
      }
    },
  },
  {
    version: 3,
    name: 'telemetry-logs',
    async up(db) {
      for (const name of ['ingest_tokens', 'logs', 'ingest_stats', 'saved_queries', 'query_history']) await db.createCollection(name).catch(() => undefined);
      await db.collection('ingest_tokens').createIndex({ tokenHash: 1 }, { unique: true, name: 'ingtok_hash_uq' });
      await db.collection('ingest_tokens').createIndex({ orgId: 1, projectId: 1, environmentId: 1 }, { name: 'ingtok_scope' });
      const scope = { orgId: 1, projectId: 1, environmentId: 1 } as const;
      // The primary access path: tenant scope + time, newest first (also the keyset-pagination order).
      await db.collection('logs').createIndex({ ...scope, ts: -1, _id: -1 }, { name: 'logs_scope_ts' });
      await db.collection('logs').createIndex({ ...scope, service: 1, ts: -1 }, { name: 'logs_scope_service_ts' });
      await db.collection('logs').createIndex({ ...scope, level: 1, ts: -1 }, { name: 'logs_scope_level_ts' });
      // Live tail follows arrival order (receivedAt), so late-arriving older events are not missed.
      await db.collection('logs').createIndex({ ...scope, receivedAt: -1, _id: -1 }, { name: 'logs_scope_received' });
      // Plain (not partial) indexes: MongoDB cannot use a partial index for a plain equality query, so the lookups would scan.
      await db.collection('logs').createIndex({ ...scope, traceId: 1, ts: -1 }, { name: 'logs_scope_trace' });
      await db.collection('logs').createIndex({ ...scope, requestId: 1, ts: -1 }, { name: 'logs_scope_request' });
      // Retention: each record carries its own expiry (ts + token retention), removed by MongoDB's TTL monitor.
      await db.collection('logs').createIndex({ expireAt: 1 }, { expireAfterSeconds: 0, name: 'logs_ttl' });
      await db.collection('ingest_stats').createIndex({ ...scope, minute: -1 }, { name: 'stats_scope_minute' });
      await db.collection('ingest_stats').createIndex({ expireAt: 1 }, { expireAfterSeconds: 0, name: 'stats_ttl' });
      await db.collection('saved_queries').createIndex({ orgId: 1, projectId: 1, ownerId: 1 }, { name: 'savedq_scope' });
      await db.collection('query_history').createIndex({ orgId: 1, projectId: 1, userId: 1, at: -1 }, { name: 'qhist_scope' });
      await db.collection('query_history').createIndex({ expireAt: 1 }, { expireAfterSeconds: 0, name: 'qhist_ttl' });
    },
    async down(db) {
      for (const [c, n] of [
        ['ingest_tokens', 'ingtok_hash_uq'], ['ingest_tokens', 'ingtok_scope'], ['logs', 'logs_scope_ts'], ['logs', 'logs_scope_service_ts'],
        ['logs', 'logs_scope_level_ts'], ['logs', 'logs_scope_received'], ['logs', 'logs_scope_trace'], ['logs', 'logs_scope_request'], ['logs', 'logs_ttl'],
        ['ingest_stats', 'stats_scope_minute'], ['ingest_stats', 'stats_ttl'], ['saved_queries', 'savedq_scope'],
        ['query_history', 'qhist_scope'], ['query_history', 'qhist_ttl'],
      ] as const) await db.collection(c).dropIndex(n).catch(() => undefined);
    },
  },
  {
    version: 4,
    name: 'oidc-identities-and-flows',
    async up(db) {
      await db.createCollection('auth_flows').catch(() => undefined);
      // One account per (issuer, subject): the same IdP identity can never be bound to two users.
      await db.collection('users').createIndex({ externalIssuer: 1, externalSubject: 1 }, { unique: true, name: 'user_identity_uq', partialFilterExpression: { externalSubject: { $type: 'string' } } });
      await db.collection('auth_flows').createIndex({ expireAt: 1 }, { expireAfterSeconds: 0, name: 'authflow_ttl' });
      await db.collection('auth_flows').createIndex({ stateHash: 1 }, { name: 'authflow_state' });
    },
    async down(db) {
      for (const [c, n] of [['users', 'user_identity_uq'], ['auth_flows', 'authflow_ttl'], ['auth_flows', 'authflow_state']] as const) await db.collection(c).dropIndex(n).catch(() => undefined);
    },
  },
  {
    version: 5,
    name: 'logs-query-performance',
    async up(db) {
      const scope = { orgId: 1, projectId: 1, environmentId: 1 } as const;
      const logs = db.collection('logs');
      // Covering index for the histogram and facets: they only need ts, service and level, so they never touch a document.
      await logs.createIndex({ ...scope, ts: -1, service: 1, level: 1 }, { name: 'logs_scope_ts_svc_lvl' });
      // Free-text search filters on `searchText` inside the index and fetches only the matching documents. It also serves every
      // "newest first" query, so it REPLACES logs_scope_ts (an index is a per-record write cost; this keeps the count flat).
      await logs.createIndex({ ...scope, ts: -1, _id: -1, searchText: 1 }, { name: 'logs_scope_ts_search' });
      // Backfill records written before this migration. Idempotent: only records without the field are touched.
      for (;;) {
        const batch = await logs.find({ searchText: { $exists: false } }, { projection: { message: 1, errorType: 1, exceptionMessage: 1 } }).limit(2000).toArray();
        if (batch.length === 0) break;
        await logs.bulkWrite(batch.map((d) => ({
          updateOne: { filter: { _id: d._id }, update: { $set: { searchText: buildSearchText(String(d.message ?? ''), d.errorType ?? null, d.exceptionMessage ?? null) } } },
        })), { ordered: false });
      }
      await logs.dropIndex('logs_scope_ts').catch(() => undefined);
    },
    async down(db) {
      const scope = { orgId: 1, projectId: 1, environmentId: 1 } as const;
      const logs = db.collection('logs');
      await logs.createIndex({ ...scope, ts: -1, _id: -1 }, { name: 'logs_scope_ts' });
      for (const n of ['logs_scope_ts_svc_lvl', 'logs_scope_ts_search']) await logs.dropIndex(n).catch(() => undefined);
    },
  },
  {
    version: 6,
    name: 'traces-and-metrics',
    async up(db) {
      for (const name of ['spans', 'trace_summaries', 'metric_series', 'metric_points', 'services']) await db.createCollection(name).catch(() => undefined);
      const scope = { orgId: 1, projectId: 1, environmentId: 1 } as const;
      const spans = db.collection('spans');
      // The waterfall: every span of one trace, in start order.
      await spans.createIndex({ ...scope, traceId: 1, start: 1 }, { name: 'spans_scope_trace' });
      // Trace-derived service statistics read only index entries (kind, time, service, status, duration), never documents. `kind` comes first so
      // a query for SERVER (or CLIENT) spans walks only those entries instead of every span in the time range.
      await spans.createIndex({ ...scope, kind: 1, start: -1, service: 1, statusCode: 1, durationNs: 1 }, { name: 'spans_scope_kind_start_cover' });
      await spans.createIndex({ ...scope, service: 1, start: -1 }, { name: 'spans_scope_service_start' });
      await spans.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0, name: 'spans_ttl' });
      const sums = db.collection('trace_summaries');
      await sums.createIndex({ ...scope, traceId: 1 }, { name: 'tsum_scope_trace' });
      // _id is part of both sort indexes: results are read in index order (no blocking sort) and keyset pagination is an index range.
      await sums.createIndex({ ...scope, start: -1, _id: -1 }, { name: 'tsum_scope_start' });
      await sums.createIndex({ ...scope, durationNs: -1, _id: -1 }, { name: 'tsum_scope_duration' });
      await sums.createIndex({ ...scope, services: 1, start: -1 }, { name: 'tsum_scope_service_start' });
      await sums.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0, name: 'tsum_ttl' });
      const series = db.collection('metric_series');
      await series.createIndex({ ...scope, name: 1, service: 1 }, { name: 'mseries_scope_name' });
      await series.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0, name: 'mseries_ttl' });
      const points = db.collection('metric_points');
      await points.createIndex({ ...scope, metric: 1, service: 1, minute: 1 }, { name: 'mpoints_scope_metric_minute' });
      await points.createIndex({ seriesId: 1, minute: 1 }, { name: 'mpoints_series_minute' });
      await points.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0, name: 'mpoints_ttl' });
      await db.collection('services').createIndex({ ...scope, name: 1 }, { name: 'services_scope_name' });
    },
    async down(db) {
      for (const [c, n] of [
        ['spans', 'spans_scope_trace'], ['spans', 'spans_scope_kind_start_cover'], ['spans', 'spans_scope_service_start'], ['spans', 'spans_ttl'],
        ['trace_summaries', 'tsum_scope_trace'], ['trace_summaries', 'tsum_scope_start'], ['trace_summaries', 'tsum_scope_duration'],
        ['trace_summaries', 'tsum_scope_service_start'], ['trace_summaries', 'tsum_ttl'],
        ['metric_series', 'mseries_scope_name'], ['metric_series', 'mseries_ttl'],
        ['metric_points', 'mpoints_scope_metric_minute'], ['metric_points', 'mpoints_series_minute'], ['metric_points', 'mpoints_ttl'],
        ['services', 'services_scope_name'],
      ] as const) await db.collection(c).dropIndex(n).catch(() => undefined);
    },
  },
  {
    // Version 20 (not the next free number) so that migrations added concurrently by other work streams (7..19) never collide with it.
    version: 20,
    name: 'alerting-and-incidents',
    async up(db) {
      for (const name of ['alert_config', 'incidents', 'alert_deliveries']) await db.createCollection(name).catch(() => undefined);
      const cfg = db.collection('alert_config');
      // Rules and channels have a name that is unique per project and kind (silences have none).
      await cfg.createIndex({ orgId: 1, projectId: 1, kind: 1, nameLower: 1 }, { name: 'acfg_name_uq', unique: true, partialFilterExpression: { nameLower: { $exists: true } } });
      await cfg.createIndex({ orgId: 1, projectId: 1, kind: 1, createdAt: -1, _id: -1 }, { name: 'acfg_scope_kind' });
      // The evaluation scheduler only ever scans enabled rules, oldest due first.
      await cfg.createIndex({ nextEvalAt: 1 }, { name: 'acfg_rule_due', partialFilterExpression: { kind: 'rule', enabled: true } });
      await cfg.createIndex({ expireAt: 1 }, { name: 'acfg_silence_ttl', expireAfterSeconds: 0 });
      const inc = db.collection('incidents');
      // THE deduplication invariant: at most one live (not resolved) incident per rule and group, enforced by the database.
      await inc.createIndex({ orgId: 1, projectId: 1, ruleId: 1, groupKey: 1 }, { name: 'inc_active_uq', unique: true, partialFilterExpression: { active: true } });
      await inc.createIndex({ orgId: 1, projectId: 1, openedAt: -1, _id: -1 }, { name: 'inc_scope_opened' });
      await inc.createIndex({ orgId: 1, projectId: 1, status: 1, openedAt: -1, _id: -1 }, { name: 'inc_scope_status' });
      await inc.createIndex({ orgId: 1, projectId: 1, ruleId: 1, openedAt: -1 }, { name: 'inc_rule' });
      await inc.createIndex({ expireAt: 1 }, { name: 'inc_ttl', expireAfterSeconds: 0 });
      const del = db.collection('alert_deliveries');
      await del.createIndex({ nextAttemptAt: 1 }, { name: 'adel_due', partialFilterExpression: { status: 'pending' } });
      await del.createIndex({ orgId: 1, projectId: 1, incidentId: 1, createdAt: 1 }, { name: 'adel_incident' });
      await del.createIndex({ orgId: 1, projectId: 1, channelId: 1, createdAt: -1 }, { name: 'adel_channel_created' });
      await del.createIndex({ expireAt: 1 }, { name: 'adel_ttl', expireAfterSeconds: 0 });
    },
    async down(db) {
      for (const [c, n] of [
        ['alert_config', 'acfg_name_uq'], ['alert_config', 'acfg_scope_kind'], ['alert_config', 'acfg_rule_due'], ['alert_config', 'acfg_silence_ttl'],
        ['incidents', 'inc_active_uq'], ['incidents', 'inc_scope_opened'], ['incidents', 'inc_scope_status'], ['incidents', 'inc_rule'], ['incidents', 'inc_ttl'],
        ['alert_deliveries', 'adel_due'], ['alert_deliveries', 'adel_incident'], ['alert_deliveries', 'adel_channel_created'], ['alert_deliveries', 'adel_ttl'],
      ] as const) await db.collection(c).dropIndex(n).catch(() => undefined);
    },
  },
  {
    // Version numbers are not contiguous on purpose: parallel work streams reserve their own (20 = alerting, 30 = metric rollups); see ADR-0007.
    version: 30,
    name: 'metric-rollups',
    async up(db) {
      await db.createCollection('metric_rollups').catch(() => undefined);
      const roll = db.collection('metric_rollups');
      // One query shape: the series ids of a query, one tier, a bucket range.
      await roll.createIndex({ seriesId: 1, tier: 1, minute: 1 }, { name: 'mroll_series_tier_minute' });
      await roll.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0, name: 'mroll_ttl' });
      // The compactor finds work through the (small) set of series with unprocessed minutes; the index only holds series that have some.
      await db.collection('metric_series').createIndex({ rollFrom: 1 }, { name: 'mseries_roll_pending', partialFilterExpression: { rollFrom: { $exists: true } } });
    },
    async down(db) {
      await db.collection('metric_rollups').dropIndex('mroll_series_tier_minute').catch(() => undefined);
      await db.collection('metric_rollups').dropIndex('mroll_ttl').catch(() => undefined);
      await db.collection('metric_series').dropIndex('mseries_roll_pending').catch(() => undefined);
    },
  },
  {
    // Version 32 is reserved for deployments (ADR-0011); 31 belongs to another work stream. Order in the array is what matters.
    version: 32,
    name: 'deployments',
    async up(db) {
      await db.createCollection('deployments').catch(() => undefined);
      const dep = db.collection('deployments');
      // List, marker window and the 24 h write counter: scope, then newest first. `_id` makes the keyset cursor total.
      await dep.createIndex({ orgId: 1, projectId: 1, environmentId: 1, startedAt: -1, _id: -1 }, { name: 'dep_scope_started' });
      // Service filter and incident correlation.
      await dep.createIndex({ orgId: 1, projectId: 1, environmentId: 1, service: 1, startedAt: -1, _id: -1 }, { name: 'dep_scope_service_started' });
      // Idempotency: one deployment per (tenant, environment, key). Only records that carry a key take part.
      await dep.createIndex({ orgId: 1, environmentId: 1, idempotencyKey: 1 }, { name: 'dep_idem_uq', unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
      await dep.createIndex({ expireAt: 1 }, { name: 'dep_ttl', expireAfterSeconds: 0 });
    },
    async down(db) {
      for (const n of ['dep_scope_started', 'dep_scope_service_started', 'dep_idem_uq', 'dep_ttl']) await db.collection('deployments').dropIndex(n).catch(() => undefined);
    },
  },
];

const LOCK_ID = 'migration-lock';

const STALE_LOCK_MS = 5 * 60_000;

export interface MigrateOptions {
  target?: number;
  /** How long to wait for another runner (e.g. a sibling replica) to finish before giving up. */
  lockWaitMs?: number;
  /** Test hook: lock considered stale after this many ms. */
  staleLockMs?: number;
}

/**
 * Acquires the migration lock atomically. Either we take over a stale lock with a conditional update (only one racer
 * can match), or we insert a fresh one (the unique _id makes the others fail). Returns our owner token.
 */
async function acquireLock(meta: Collection<any>, waitMs: number, staleMs: number): Promise<string> {
  const owner = crypto.randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    const now = new Date();
    const took = await meta.updateOne(
      { _id: LOCK_ID, lockedAt: { $lt: new Date(now.getTime() - staleMs) } },
      { $set: { lockedAt: now, owner } },
    );
    if (took.modifiedCount === 1) return owner;
    try {
      await meta.insertOne({ _id: LOCK_ID, lockedAt: now, owner });
      return owner;
    } catch (e) {
      if ((e as { code?: number }).code !== 11000) throw e;
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for another migration run to finish');
    await new Promise((r) => setTimeout(r, 200));
  }
}

/**
 * Applies pending migrations in order. Concurrent runners (several API replicas starting together) queue on the lock;
 * the ones that wait then find everything applied and do nothing.
 */
export async function migrateUp(db: Db, opts: MigrateOptions = {}): Promise<number[]> {
  const target = opts.target ?? Infinity;
  const meta = db.collection<any>('schema_migrations');
  const owner = await acquireLock(meta, opts.lockWaitMs ?? 60_000, opts.staleLockMs ?? STALE_LOCK_MS);
  const applied: number[] = [];
  try {
    const done = new Set((await meta.find({ _id: { $type: 'number' } }).toArray()).map((d) => d._id as number));
    for (const m of migrations) {
      if (m.version > target || done.has(m.version)) continue;
      await m.up(db);
      await meta.insertOne({ _id: m.version, name: m.name, appliedAt: new Date() });
      applied.push(m.version);
    }
  } finally {
    // Only release a lock we still own (it may have been taken over if we stalled past the stale threshold).
    await meta.deleteOne({ _id: LOCK_ID, owner });
  }
  return applied;
}

/** Rolls back the most recently applied migration. */
export async function migrateDownOne(db: Db): Promise<number | null> {
  const meta = db.collection<any>('schema_migrations');
  const last = await meta.find({ _id: { $type: 'number' } }).sort({ _id: -1 }).limit(1).next();
  if (!last) return null;
  const m = migrations.find((x) => x.version === last._id);
  if (!m) throw new Error(`No migration module for applied version ${String(last._id)}`);
  await m.down(db);
  await meta.deleteOne({ _id: last._id });
  return m.version;
}



