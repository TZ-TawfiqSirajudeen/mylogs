import { z } from 'zod';
import { Id } from './common.js';

export const ConnectionState = z.enum([
  'pending', 'connecting', 'healthy', 'degraded', 'permission_denied', 'authentication_expired',
  'unreachable', 'misconfigured', 'disconnected',
]);
export type ConnectionState = z.infer<typeof ConnectionState>;

export const SignalName = z.enum(['logs', 'metrics', 'traces', 'events', 'inventory']);
export const Lifecycle = z.enum(['draft', 'active', 'disconnected']);

// ---------------------------------------------------------------- registry / capability matrix
export const ConnectorDescriptorDto = z.object({
  type: z.string(), displayName: z.string(), category: z.string(),
  status: z.enum(['implemented', 'planned']), mode: z.enum(['pull', 'push']).optional(), collection: z.enum(['not_implemented', 'implemented']),
  signals: z.array(z.object({ signal: SignalName, availability: z.string(), note: z.string().optional() })),
  deploymentTypes: z.array(z.string()),
  authMethods: z.array(z.object({
    id: z.string(), label: z.string(), recommended: z.boolean(), description: z.string(),
    secretFields: z.array(z.object({ name: z.string(), label: z.string() })),
  })),
  requiredPermissions: z.array(z.object({ scope: z.string(), permission: z.string(), why: z.string(), optional: z.boolean().optional() })),
  operations: z.array(z.string()), configRequirements: z.array(z.string()), limitations: z.array(z.string()),
  leastPrivilegeGuide: z.string().optional(),
});
export type ConnectorDescriptorDto = z.infer<typeof ConnectorDescriptorDto>;

// ---------------------------------------------------------------- inputs
const Secrets = z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/), z.string().min(1).max(8192));
export const ConnectionCreate = z.object({
  connectorType: z.string().regex(/^[a-z0-9-]{1,40}$/),
  name: z.string().trim().min(1).max(80),
  authMethod: z.string().regex(/^[a-z0-9-]{1,40}$/),
  /** Non-secret settings, validated server-side by the connector's own schema. */
  config: z.record(z.string(), z.unknown()),
  /** Write-only. Never returned by any endpoint, never logged. */
  secrets: Secrets.default({}),
});
export const ConnectionConfigUpdate = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});
export const ConnectionRotate = z.object({ secrets: Secrets });
export const ConnectionSelection = z.object({
  resourceIds: z.array(z.string().min(1).max(300)).min(1).max(500),
  signals: z.array(SignalName).min(1).max(5),
});
export const ConnectionSettings = z.object({
  pollIntervalSeconds: z.number().int().min(30).max(3600).default(60),
  sampling: z.number().min(0.01).max(1).default(1),
  retentionDays: z.number().int().min(1).max(365).default(30),
  redaction: z.object({
    enabled: z.boolean().default(true),
    extraKeys: z.array(z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/)).max(50).default([]),
  }).default({ enabled: true, extraKeys: [] }),
});

// ---------------------------------------------------------------- outputs
const Step = z.object({ id: z.string(), label: z.string(), status: z.string(), detail: z.string().optional(), remediation: z.string().optional(), durationMs: z.number().optional() });
const Capability = z.object({ id: z.string(), label: z.string(), available: z.boolean(), signal: z.string().optional(), reason: z.string().optional() });
const Resource = z.object({
  id: z.string(), type: z.string(), name: z.string(),
  attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])), signals: z.array(z.string()),
});
const ErrorRecord = z.object({ at: z.iso.datetime(), kind: z.string(), message: z.string(), remediation: z.string() });

export const ConnectionDto = z.object({
  id: Id, projectId: Id, environmentId: Id,
  connectorType: z.string(), connectorName: z.string(), connectorStatus: z.enum(['implemented', 'planned']),
  name: z.string(), authMethod: z.string(), lifecycle: Lifecycle,
  config: z.record(z.string(), z.unknown()),
  /** Which secret fields exist (and when they were last set). Values are never exposed. */
  secrets: z.record(z.string(), z.object({ set: z.literal(true), updatedAt: z.iso.datetime() })),
  signals: z.array(z.object({ signal: SignalName, availability: z.string() })),
  capabilities: z.array(Capability),
  selection: z.object({ resourceIds: z.array(z.string()), signals: z.array(z.string()) }).nullable(),
  settings: ConnectionSettings.nullable(),
  lastTest: z.object({ at: z.iso.datetime(), ok: z.boolean(), steps: z.array(Step), facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])), durationMs: z.number(), stale: z.boolean() }).nullable(),
  health: z.object({
    state: ConnectionState,
    lastCheckAt: z.iso.datetime().nullable(), lastSuccessAt: z.iso.datetime().nullable(), nextCheckAt: z.iso.datetime().nullable(),
    lastCheckDurationMs: z.number().nullable(), consecutiveFailures: z.number(),
    lastError: ErrorRecord.nullable(), recentErrors: z.array(ErrorRecord),
    /** True when an active connection has not been checked for much longer than its interval (the monitor may be down). */
    stale: z.boolean(),
    collectionLagSeconds: z.number().nullable(),
    remediation: z.string().nullable(),
  }),
  collection: z.object({ status: z.enum(['not_implemented', 'not_started', 'running', 'stopped']), lastSuccessfulCollectionAt: z.iso.datetime().nullable(), note: z.string() }),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), activatedAt: z.iso.datetime().nullable(),
});
export type ConnectionDto = z.infer<typeof ConnectionDto>;

export const TestReportDto = z.object({
  ok: z.boolean(),
  failure: z.object({ kind: z.string(), message: z.string(), remediation: z.string() }).nullable(),
  steps: z.array(Step), capabilities: z.array(Capability),
  facts: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])), durationMs: z.number(),
  connection: ConnectionDto,
});
export const DiscoveryDto = z.object({ resources: z.array(Resource), capabilities: z.array(Capability), truncated: z.boolean(), connection: ConnectionDto });
export const PreviewDto = z.object({
  connector: z.string(), authMethod: z.string(), target: z.record(z.string(), z.unknown()),
  credentials: z.array(z.object({ field: z.string(), set: z.boolean() })),
  resources: z.array(z.object({ id: z.string(), name: z.string(), type: z.string() })),
  signals: z.array(z.string()), settings: ConnectionSettings,
  schedule: z.string(), collection: z.string(), warnings: z.array(z.string()),
});

export const ConnectionParams = z.object({ projectId: Id, environmentId: Id });
export const ConnectionIdParams = z.object({ projectId: Id, connectionId: Id });
export const ConnectionListQuery = z.object({ environmentId: Id.optional() });
