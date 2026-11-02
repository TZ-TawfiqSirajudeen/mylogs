import type { Collection, Db } from 'mongodb';

export type OrgRole = 'owner' | 'admin' | 'member' | 'auditor';
export type ProjectRole = 'project_admin' | 'engineer' | 'viewer';

/** All ids are UUID strings (not ObjectIds) so they are stable, opaque and DTO-friendly. */
export interface OrganizationDoc {
  _id: string; slug: string; name: string; createdAt: Date;
  /** Written inside transactions that remove an owner, so concurrent owner changes conflict instead of both succeeding (write skew). */
  ownerLockAt?: Date;
}
export interface UserDoc {
  _id: string; email: string; emailLower: string; displayName: string;
  /** OIDC identity binding: the provider's issuer and the user's stable `sub` there (never the email, which can change). */
  externalIssuer?: string | null; externalSubject: string | null; createdAt: Date; disabledAt: Date | null;
}
export interface OrgMembershipDoc { _id: string; orgId: string; userId: string; role: OrgRole; createdAt: Date }
export interface ProjectDoc {
  _id: string; orgId: string; slug: string; name: string; description: string; owningTeam: string;
  createdBy: string; createdAt: Date; updatedAt: Date;
}
export interface EnvironmentDoc {
  _id: string; orgId: string; projectId: string; slug: string; name: string; isProduction: boolean; createdAt: Date;
}
export interface ProjectMembershipDoc {
  _id: string; orgId: string; projectId: string; userId: string; role: ProjectRole;
  /** null = all environments of the project; otherwise restricted to these environment ids. */
  environmentIds: string[] | null; createdAt: Date;
}
export interface SessionDoc {
  _id: string; tokenHash: string; userId: string; orgId: string; csrfToken: string;
  createdAt: Date; lastSeenAt: Date; idleExpiresAt: Date; expiresAt: Date; revokedAt: Date | null;
}
export interface AuditEventDoc {
  _id: string; seq: number; orgId: string; actorUserId: string | null; actorType: 'user' | 'system';
  action: string; targetType: string; targetId: string | null; projectId: string | null;
  environmentId: string | null; requestId: string | null; metadata: Record<string, unknown>; createdAt: Date;
}
/** Envelope-encrypted secret. Only ciphertext + wrapped key live here; the KEK never touches the database. */
export interface SecretDoc {
  _id: string; orgId: string; connectionId: string; name: string; version: number;
  alg: 'AES-256-GCM/v1'; keyId: string;
  wrappedDek: string; dekIv: string; dekTag: string;
  iv: string; tag: string; ciphertext: string;
  createdBy: string | null; createdAt: Date; updatedAt: Date;
}

export type ConnectionLifecycle = 'draft' | 'active' | 'disconnected';
export type ConnectionHealthState =
  | 'pending' | 'connecting' | 'healthy' | 'degraded' | 'permission_denied' | 'authentication_expired'
  | 'unreachable' | 'misconfigured' | 'disconnected';

export interface ConnectionErrorRecord { at: Date; kind: string; message: string; remediation: string }
export interface StoredStep { id: string; label: string; status: string; detail?: string; remediation?: string; durationMs?: number }
export interface StoredCapability { id: string; label: string; available: boolean; signal?: string; reason?: string }
export interface StoredResource {
  id: string; type: string; name: string; attributes: Record<string, string | number | boolean | null>; signals: string[];
}

export interface ConnectionDoc {
  _id: string; orgId: string; projectId: string; environmentId: string;
  connectorType: string; name: string; authMethod: string;
  lifecycle: ConnectionLifecycle;
  /** Non-secret configuration, validated by the connector's schema. */
  config: Record<string, unknown>;
  /** Names + timestamps only. Values are in `secrets` and are never returned by any API. */
  secretFields: Record<string, { updatedAt: Date }>;
  discovered: { at: Date; resources: StoredResource[]; truncated: boolean } | null;
  capabilities: StoredCapability[];
  selection: { resourceIds: string[]; signals: string[] } | null;
  settings: { pollIntervalSeconds: number; sampling: number; retentionDays: number; redaction: { enabled: boolean; extraKeys: string[] } } | null;
  lastTest: { at: Date; ok: boolean; steps: StoredStep[]; facts: Record<string, string | number | boolean>; durationMs: number; configVersion: number } | null;
  health: {
    state: ConnectionHealthState;
    lastCheckAt: Date | null; lastSuccessAt: Date | null; lastCheckDurationMs: number | null;
    consecutiveFailures: number; nextCheckAt: Date | null;
    lastError: ConnectionErrorRecord | null; recentErrors: ConnectionErrorRecord[];
    /** Stored as 0 after a successful collection; the API computes the live lag from `collection.lastSuccessfulCollectionAt`. */
    collectionLagSeconds: number | null;
  };
  collection: {
    /** not_implemented: the connector cannot collect. not_selected: it can, but the metrics signal was not chosen. */
    status: 'not_implemented' | 'not_selected' | 'not_started' | 'running' | 'stopped';
    lastSuccessfulCollectionAt: Date | null;
    /** The fields below are absent on connections created before collection existed. */
    lastAttemptAt?: Date | null;
    consecutiveFailures?: number;
    lastError?: ConnectionErrorRecord | null;
    /** Series (name + labels) returned by the last successful collection. */
    lastSeries?: number | null;
    /** Partial failures and dropped-series notices of the last successful collection (bounded). */
    lastNotes?: string[];
  };
  /** Lease so several workers never check the same connection at once. */
  lease: { owner: string; until: Date } | null;
  /** Bumped whenever config, auth method or credentials change; a passing test is only valid for the version it ran against. */
  configVersion: number;
  version: number;
  createdBy: string; createdAt: Date; updatedAt: Date; activatedAt: Date | null; disconnectedAt: Date | null;
}

// ---------------------------------------------------------------- telemetry (phase 3)

export type TelemetrySignal = 'logs' | 'traces' | 'metrics';
export const ALL_SIGNALS: TelemetrySignal[] = ['logs', 'traces', 'metrics'];

export interface IngestTokenDoc {
  _id: string; orgId: string; projectId: string; environmentId: string;
  name: string;
  /** First characters of the token, shown in the UI to tell tokens apart. The token itself is never stored, only its hash. */
  prefix: string; tokenHash: string;
  /** Which signals this token may send. Tokens created before phase 4 are logs-only and are NOT widened implicitly. */
  scopes: TelemetrySignal[];
  retentionDays: number;
  redaction: { enabled: boolean; extraKeys: string[] };
  /** Per-token override of the platform default rate limit; null = default. */
  recordsPerMinute: number | null;
  createdBy: string; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null;
}

export interface KV { k: string; v: string }

/** Normalized, redacted log record. Tenant fields come from the ingestion token, never from the client payload. */
export interface LogDoc {
  _id: string; orgId: string; projectId: string; environmentId: string; tokenId: string;
  ts: Date; tsSource: 'event' | 'observed' | 'received'; tsAdjusted: 'future' | null; receivedAt: Date; expireAt: Date;
  severity: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal'; level: number; severityText: string | null;
  message: string; messageTruncated: boolean;
  /** Lowercased message + error type + exception message for indexed free-text search (see search-text.ts). */
  searchText: string;
  service: string | null; serviceVersion: string | null; deployment: string | null; host: string | null; container: string | null;
  traceId: string | null; spanId: string | null; requestId: string | null;
  httpMethod: string | null; httpRoute: string | null; httpStatus: number | null; durationMs: number | null;
  errorType: string | null; exceptionMessage: string | null; stack: string | null;
  scope: string | null; source: 'otlp' | 'json';
  attrs: KV[]; resource: KV[]; attrsTruncated: boolean; redactions: number;
}

// ---------------------------------------------------------------- traces and metrics (phase 4)

export type SpanKindName = 'unspecified' | 'internal' | 'server' | 'client' | 'producer' | 'consumer';
export type SpanStatusName = 'unset' | 'ok' | 'error';

export interface SpanEventDoc { ts: Date; /** Nanoseconds within the millisecond of `ts` (precision is not lost). */ tsNsFrac: number; name: string; attrs: KV[]; droppedAttrs: number }
export interface SpanLinkDoc { traceId: string; spanId: string; traceState: string | null; attrs: KV[]; droppedAttrs: number }

/**
 * One OTLP span, as observed. Absent facts are null, never invented: a missing parent stays missing, a missing end time makes
 * `timingValid` false rather than producing a made-up duration.
 */
export interface SpanDoc {
  /** sha1(project|environment|traceId|spanId): a replayed span is a duplicate by construction. */
  _id: string; orgId: string; projectId: string; environmentId: string; tokenId: string;
  traceId: string; spanId: string; parentSpanId: string | null;
  name: string; kind: SpanKindName;
  start: Date; end: Date;
  /** Nanoseconds within the millisecond of `start` / `end`: together with the Date they hold the full OTLP nanosecond timestamp. */
  startNsFrac: number; endNsFrac: number;
  /** end - start in nanoseconds; null when the timestamps are missing or end < start (see timingValid). */
  durationNs: number | null; timingValid: boolean;
  statusCode: SpanStatusName; statusMessage: string | null;
  service: string | null; serviceVersion: string | null; host: string | null; deployment: string | null;
  scopeName: string | null; scopeVersion: string | null; traceState: string | null; flags: number | null;
  attrs: KV[]; resource: KV[]; events: SpanEventDoc[]; links: SpanLinkDoc[];
  droppedAttrs: number; droppedEvents: number; droppedLinks: number; attrsTruncated: boolean;
  // Extracted for filtering (the full attribute list is kept in `attrs`).
  httpMethod: string | null; httpRoute: string | null; httpStatus: number | null;
  dbSystem: string | null; peerService: string | null; exceptionType: string | null;
  receivedAt: Date; expireAt: Date; redactions: number;
}

/** One small document per trace, RECOMPUTED from the stored spans after every write that touches the trace (never incremented). */
export interface TraceSummaryDoc {
  _id: string; orgId: string; projectId: string; environmentId: string; traceId: string;
  start: Date; end: Date; durationNs: number; spanCount: number; errorCount: number;
  services: string[]; names: string[]; dbSystems: string[]; exceptionTypes: string[];
  rootSpanId: string | null; rootName: string | null; rootService: string | null;
  httpMethod: string | null; httpRoute: string | null; httpStatus: number | null;
  /** A parentless span is stored. */
  hasRoot: boolean;
  /** Stored spans whose parent span is not stored (late, dropped, or uninstrumented). */
  orphanCount: number;
  /** Spans with missing/invalid timestamps (excluded from the duration). */
  invalidTimingCount: number;
  updatedAt: Date; expireAt: Date;
}

export type MetricType = 'gauge' | 'sum' | 'histogram';
export interface MetricSeriesDoc {
  /** Hash of (environment, name, service, attributes, type, temporality, bounds): any change of identity starts a new series. */
  _id: string; orgId: string; projectId: string; environmentId: string;
  name: string; unit: string | null; description: string | null;
  type: MetricType; temporality: 'delta' | 'cumulative' | null; monotonic: boolean | null;
  service: string | null; serviceVersion: string | null;
  /** service.instance.id (or host / pod): cumulative counters of different instances must never share state. */
  instance: string | null;
  attrs: KV[];
  /** Histogram explicit bucket bounds (upper bounds; the last bucket is +Inf). */
  bounds: number[] | null;
  firstSeen: Date; lastSeen: Date;
  /** Time of the newest accepted data point. Points not newer than this are duplicates (retransmissions) and are ignored: ingestion is idempotent per series. */
  lastPoint: Date;
  /** Timestamps (ms) of the most recent data points, newest last (bounded). Delta and gauge series reject a point whose timestamp is already here, so a
   *  retransmission is a duplicate while an OUT-OF-ORDER (but new) point is still accepted. Cumulative series use `lastPoint` instead. */
  recent: number[];
  /** Last cumulative observation, used to turn cumulative series into deltas (reset-aware). Null for delta/gauge series. */
  cumulative: { time: Date; startTime: Date | null; value: number; count: number; sum: number; buckets: number[] | null } | null;
  expireAt: Date;
}
export interface MetricExemplarDoc { traceId: string; spanId: string | null; value: number; ts: Date }
/** Pre-aggregated measurements of one series in one minute. Histograms keep bucket counts, so percentiles can be merged correctly. */
export interface MetricPointDoc {
  _id: string; seriesId: string; orgId: string; projectId: string; environmentId: string;
  metric: string; service: string | null; type: MetricType; minute: Date;
  /** gauge: samples; sum: data points; histogram: observations */
  count: number;
  /** gauge/sum: sum of values (sum: of DELTAS); histogram: sum of observations */
  sum: number;
  min: number | null; max: number | null; last: number | null; lastAt: Date | null;
  buckets: number[] | null;
  exemplars: MetricExemplarDoc[];
  expireAt: Date;
}

/** Service inventory: one row per service per environment, maintained from valid `service.name` resources on ingest. */
export interface ServiceDoc {
  _id: string; orgId: string; projectId: string; environmentId: string; name: string;
  version: string | null; firstSeen: Date;
  lastSpanAt: Date | null; lastMetricAt: Date | null; lastLogAt: Date | null;
}

/** Per-minute ingestion accounting: what arrived, what was refused and why. Loss is reported, never silent. */
export interface IngestStatDoc {
  _id: string; orgId: string; projectId: string; environmentId: string; minute: Date; expireAt: Date;
  /** Absent on records written before phase 4 (= logs). */
  signal?: TelemetrySignal;
  requests: number; bytes: number; accepted: number; duplicates: number;
  rejectedInvalid: number; rejectedQuota: number; rejectedOverload: number; rejectedStorage: number; redactions: number;
}

export interface SavedQueryDoc {
  _id: string; orgId: string; projectId: string; ownerId: string; name: string;
  query: Record<string, unknown>; shared: boolean; createdAt: Date;
}
export interface QueryHistoryDoc {
  _id: string; orgId: string; projectId: string; userId: string; query: Record<string, unknown>; at: Date; expireAt: Date;
}

/** A login in progress. Server-side, one-time, short-lived: binds the browser (flow cookie) to the state/nonce/PKCE verifier. */
export interface AuthFlowDoc {
  _id: string; stateHash: string; nonce: string; codeVerifier: string; returnTo: string; createdAt: Date; expireAt: Date;
}

export interface CounterDoc { _id: string; value: number }

export interface Collections {
  organizations: Collection<OrganizationDoc>;
  users: Collection<UserDoc>;
  orgMemberships: Collection<OrgMembershipDoc>;
  projects: Collection<ProjectDoc>;
  environments: Collection<EnvironmentDoc>;
  projectMemberships: Collection<ProjectMembershipDoc>;
  sessions: Collection<SessionDoc>;
  auditEvents: Collection<AuditEventDoc>;
  counters: Collection<CounterDoc>;
  secrets: Collection<SecretDoc>;
  connections: Collection<ConnectionDoc>;
  ingestTokens: Collection<IngestTokenDoc>;
  logs: Collection<LogDoc>;
  ingestStats: Collection<IngestStatDoc>;
  savedQueries: Collection<SavedQueryDoc>;
  queryHistory: Collection<QueryHistoryDoc>;
  authFlows: Collection<AuthFlowDoc>;
  spans: Collection<SpanDoc>;
  traceSummaries: Collection<TraceSummaryDoc>;
  metricSeries: Collection<MetricSeriesDoc>;
  metricPoints: Collection<MetricPointDoc>;
  services: Collection<ServiceDoc>;
}

export function collections(db: Db): Collections {
  return {
    organizations: db.collection('organizations'),
    users: db.collection('users'),
    orgMemberships: db.collection('org_memberships'),
    projects: db.collection('projects'),
    environments: db.collection('environments'),
    projectMemberships: db.collection('project_memberships'),
    sessions: db.collection('sessions'),
    auditEvents: db.collection('audit_events'),
    counters: db.collection('counters'),
    secrets: db.collection('secrets'),
    connections: db.collection('connections'),
    ingestTokens: db.collection('ingest_tokens'),
    logs: db.collection('logs'),
    ingestStats: db.collection('ingest_stats'),
    savedQueries: db.collection('saved_queries'),
    queryHistory: db.collection('query_history'),
    authFlows: db.collection('auth_flows'),
    spans: db.collection('spans'),
    traceSummaries: db.collection('trace_summaries'),
    metricSeries: db.collection('metric_series'),
    metricPoints: db.collection('metric_points'),
    services: db.collection('services'),
  };
}
