import type { NetworkPolicy } from '@nexus/security';
import type { ZodType } from 'zod';

// ---------------------------------------------------------------- connection state

export const CONNECTION_STATES = [
  'pending', 'connecting', 'healthy', 'degraded', 'permission_denied', 'authentication_expired',
  'unreachable', 'misconfigured', 'disconnected',
] as const;
export type ConnectionState = (typeof CONNECTION_STATES)[number];

export type Signal = 'logs' | 'metrics' | 'traces' | 'events' | 'inventory';
export const SIGNALS: readonly Signal[] = ['logs', 'metrics', 'traces', 'events', 'inventory'];

/** What a connector can offer for a signal — declared statically, never inferred from the provider's name. */
export type SignalAvailability = 'supported' | 'requires_config' | 'planned' | 'unsupported';

export type ImplementationStatus = 'implemented' | 'planned';

// ---------------------------------------------------------------- descriptor (the capability-matrix row)

export interface AuthMethod {
  id: string;
  label: string;
  recommended: boolean;
  description: string;
  /** Names of write-only secret fields collected for this method. */
  secretFields: { name: string; label: string }[];
}

export interface PermissionRequirement {
  scope: string;
  permission: string;
  why: string;
  optional?: boolean;
}

export interface ConnectorDescriptor {
  type: string;
  displayName: string;
  category: 'application' | 'cloud' | 'infrastructure' | 'database' | 'cache';
  status: ImplementationStatus;
  /**
   * pull (default): the platform connects to the target (test/discover/monitor).
   * push: senders deliver data to the platform's ingestion endpoint with a token; there is nothing to connect to.
   */
  mode?: 'pull' | 'push';
  /** Whether the connector samples metrics on a schedule (`collect`). `not_implemented` = verified and health-monitored only. */
  collection: 'not_implemented' | 'implemented';
  signals: { signal: Signal; availability: SignalAvailability; note?: string }[];
  deploymentTypes: string[];
  authMethods: AuthMethod[];
  requiredPermissions: PermissionRequirement[];
  operations: string[];
  configRequirements: string[];
  limitations: string[];
  /** Copy-pasteable least-privilege setup instructions shown in the wizard. */
  leastPrivilegeGuide?: string;
}

// ---------------------------------------------------------------- errors

export type ConnectorErrorKind =
  | 'misconfigured' | 'unreachable' | 'authentication' | 'permission_denied' | 'rate_limited'
  | 'timeout' | 'unhealthy' | 'unsupported' | 'cancelled' | 'internal';

export class ConnectorError extends Error {
  constructor(
    readonly kind: ConnectorErrorKind,
    message: string,
    readonly opts: { remediation?: string; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'ConnectorError';
  }
  get remediation() { return this.opts.remediation; }
  get retryAfterMs() { return this.opts.retryAfterMs; }
}

/**
 * Maps a failure to a user-visible connection state. A first-time authentication failure is a configuration
 * mistake; after the connection has been healthy once, the same failure means the credential expired or was revoked.
 */
export function stateForError(kind: ConnectorErrorKind, hadSuccess: boolean): ConnectionState {
  switch (kind) {
    case 'authentication': return hadSuccess ? 'authentication_expired' : 'misconfigured';
    case 'permission_denied': return 'permission_denied';
    case 'unreachable': case 'timeout': return 'unreachable';
    case 'rate_limited': case 'unhealthy': return 'degraded';
    case 'misconfigured': case 'unsupported': return 'misconfigured';
    case 'cancelled': return 'degraded';
    case 'internal': return 'degraded';
  }
}

export const REMEDIATION: Record<ConnectorErrorKind, string> = {
  misconfigured: 'Check the connection settings (host, port, TLS, options) and run the test again.',
  unreachable: 'The target could not be reached. Verify the address, firewall/security-group rules and that the service is running.',
  authentication: 'The credentials were rejected. Rotate the credential and make sure the account is enabled and not expired.',
  permission_denied: 'The credential works but lacks a required permission. Grant the permissions listed in "Required permissions" (least privilege).',
  rate_limited: 'The provider is throttling requests. The platform will back off and retry; consider a longer polling interval.',
  timeout: 'The target did not answer in time. Check network latency and target load.',
  unhealthy: 'The target is reachable but reports itself unhealthy. Check the service and its dependencies.',
  unsupported: 'This target version or deployment type is not supported by the connector.',
  cancelled: 'The check was cancelled before it finished.',
  internal: 'Unexpected connector failure. The error was recorded; retry, and contact the platform team if it persists.',
};

// ---------------------------------------------------------------- run context, reports

export interface ConnectorLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
}

export interface ConnectorContext {
  /** Aborted on timeout or cancellation; every I/O call must honour it. */
  signal: AbortSignal;
  network: NetworkPolicy;
  now(): Date;
  logger: ConnectorLogger;
}

export type StepStatus = 'pass' | 'fail' | 'skipped' | 'warn';

export interface TestStep {
  id: string;
  label: string;
  status: StepStatus;
  detail?: string;
  remediation?: string;
  durationMs?: number;
}

export interface DetectedCapability {
  id: string;
  label: string;
  available: boolean;
  signal?: Signal;
  /** Why it is unavailable (permission, version, deployment type). */
  reason?: string;
}

export interface TestReport {
  ok: boolean;
  /** Present when !ok — the failure that determines the connection state. */
  failure?: { kind: ConnectorErrorKind; message: string; remediation: string; retryAfterMs?: number };
  steps: TestStep[];
  capabilities: DetectedCapability[];
  /** Non-secret facts learned during the test (server version, latency). */
  facts: Record<string, string | number | boolean>;
  durationMs: number;
}

export interface DiscoveredResource {
  id: string;
  type: string;
  name: string;
  attributes: Record<string, string | number | boolean | null>;
  /** Signals this specific resource can provide, given permissions and configuration. */
  signals: Signal[];
}

export interface DiscoveryResult {
  resources: DiscoveredResource[];
  capabilities: DetectedCapability[];
  truncated: boolean;
}

export interface SelectionInput {
  resourceIds: string[];
  signals: Signal[];
}

// ---------------------------------------------------------------- collection (pull connectors: read-only metric sampling)

/**
 * One measurement a pull connector read from its target. Only two shapes exist so nothing can be mistaken for something else:
 * a `gauge` (a value at an instant) and a cumulative monotonic `sum` (a counter that only grows until the target restarts; the platform
 * turns it into per-interval increases and handles resets). Values are always numbers the target actually reported.
 */
export interface MetricSample {
  /** Dotted metric name, e.g. `mongodb.connections.current`. */
  name: string;
  /** UCUM-style unit: `By`, `s`, `1`, or a `{annotation}` such as `{connection}`. */
  unit: string;
  description: string;
  kind: 'gauge' | 'sum';
  value: number;
  /** Bounded labels (e.g. `operation=insert`, `db.namespace=orders`). Never values read from the target's data. */
  attributes: Record<string, string>;
}

export interface CollectionResult {
  samples: MetricSample[];
  /** Samples not returned because the per-connection series cap was reached. */
  dropped: number;
  /** Plain-language partial failures (e.g. one command refused by the target); the collection still counts as successful if any sample exists. */
  notes: string[];
}

/** Hard ceiling on distinct series (name + labels) a single connection may produce per collection. */
export const MAX_SERIES_PER_CONNECTION = 500;

/** Keeps the first `max` distinct series, in the order given; later ones are counted as dropped. */
export function capSeries(samples: MetricSample[], max = MAX_SERIES_PER_CONNECTION): { samples: MetricSample[]; dropped: number } {
  const seen = new Set<string>();
  const kept: MetricSample[] = [];
  let dropped = 0;
  for (const s of samples) {
    const key = `${s.name}${Object.entries(s.attributes).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('')}`;
    if (seen.has(key)) continue; // an exact duplicate adds nothing
    if (seen.size >= max) { dropped++; continue; }
    seen.add(key);
    kept.push(s);
  }
  return { samples: kept, dropped };
}

// ---------------------------------------------------------------- the connector contract

export interface Connector<Config = unknown, Creds = Record<string, string>> {
  readonly descriptor: ConnectorDescriptor;
  /** Zod schema of non-secret configuration; the single source of truth for validation. */
  readonly configSchema: ZodType<Config>;
  /** Zod schema of the secret fields for an auth method. Unknown method -> undefined. */
  credentialSchema(authMethod: string): ZodType<Creds> | undefined;

  /** Cross-field/semantic checks beyond the schema. Must not do network I/O. */
  validateConfig?(config: Config, authMethod: string): string[];
  /** Connectivity + authentication + permission probe. Must be read-only and must never throw for expected failures. */
  test(ctx: ConnectorContext, config: Config, creds: Creds): Promise<TestReport>;
  discover(ctx: ConnectorContext, config: Config, creds: Creds): Promise<DiscoveryResult>;

  /**
   * Read-only sampling of the resources the user selected (`sel`). Present only when `descriptor.collection === 'implemented'`.
   * Must respect the connector's command allow-list, must never read user data, must honour `ctx.signal`, and must throw a
   * ConnectorError only when NOTHING could be collected (partial results are returned with `notes`).
   */
  collect?(ctx: ConnectorContext, config: Config, creds: Creds, sel: SelectionInput): Promise<CollectionResult>;

  /** Called after credentials were replaced (e.g. to drop pooled clients). */
  onCredentialRotation?(config: Config): Promise<void>;
  /** Best-effort remote cleanup on disconnect/delete (e.g. deregister a webhook). Must not require extra permissions. */
  onDisconnect?(ctx: ConnectorContext, config: Config, creds: Creds | null): Promise<void>;
}
