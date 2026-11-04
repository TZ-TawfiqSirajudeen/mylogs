import { z } from 'zod';
import { Id } from './common.js';

export const SEVERITIES = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Fields a user may filter on. Anything else is rejected: there is no way to name an arbitrary database field. */
export const FIELD_TYPES = {
  service: 'string', serviceVersion: 'string', host: 'string', container: 'string', traceId: 'string', spanId: 'string',
  requestId: 'string', httpMethod: 'string', httpRoute: 'string', httpStatus: 'number', durationMs: 'number',
  errorType: 'string', deployment: 'string', source: 'string', scope: 'string', severity: 'string',
} as const;
export type FieldName = keyof typeof FIELD_TYPES;

const STRING_OPS = ['eq', 'ne', 'contains', 'exists'] as const;
const NUMBER_OPS = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'exists'] as const;
export const OPERATORS = ['eq', 'ne', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists'] as const;

export const MAX_RANGE_MS = 31 * 24 * 3600_000;
export const MAX_LIMIT = 500;

export const LogFilter = z.object({
  /** A known field name, or `attr:<attribute key>` for provider-specific attributes. */
  field: z.string().max(110).refine((f) => f in FIELD_TYPES || /^attr:[A-Za-z0-9_.\-/]{1,100}$/.test(f), 'unknown field'),
  op: z.enum(OPERATORS),
  value: z.union([z.string().max(256), z.number().finite()]).optional(),
});
export type LogFilter = z.infer<typeof LogFilter>;

export const LogQuery = z.object({
  from: z.iso.datetime(),
  to: z.iso.datetime(),
  text: z.string().trim().max(200).optional(),
  minSeverity: z.enum(SEVERITIES).optional(),
  errorsOnly: z.boolean().optional(),
  services: z.array(z.string().max(128)).max(20).optional(),
  /** Narrow to some environments; the server intersects with what the caller may read. */
  environmentIds: z.array(Id).max(20).optional(),
  filters: z.array(LogFilter).max(10).default([]),
  sort: z.enum(['desc', 'asc']).default('desc'),
  limit: z.number().int().min(1).max(MAX_LIMIT).default(100),
  cursor: z.string().max(300).optional(),
}).superRefine((q, ctx) => {
  const from = Date.parse(q.from), to = Date.parse(q.to);
  if (!(from < to)) ctx.addIssue({ code: 'custom', message: '"from" must be before "to"', path: ['from'] });
  else if (to - from > MAX_RANGE_MS) ctx.addIssue({ code: 'custom', message: 'Time range may not exceed 31 days', path: ['to'] });
  for (const [i, f] of q.filters.entries()) {
    if (f.op !== 'exists' && (f.value === undefined || f.value === '')) ctx.addIssue({ code: 'custom', message: 'A value is required', path: ['filters', i, 'value'] });
    const type = f.field.startsWith('attr:') ? 'string' : FIELD_TYPES[f.field as FieldName];
    const allowed: readonly string[] = type === 'number' ? NUMBER_OPS : STRING_OPS;
    if (!allowed.includes(f.op)) ctx.addIssue({ code: 'custom', message: `Operator "${f.op}" is not valid for ${f.field}`, path: ['filters', i, 'op'] });
    if (type === 'number' && f.op !== 'exists' && f.value !== undefined && !Number.isFinite(Number(f.value))) ctx.addIssue({ code: 'custom', message: `${f.field} needs a number`, path: ['filters', i, 'value'] });
  }
});
export type LogQuery = z.infer<typeof LogQuery>;
export type LogQueryInput = z.input<typeof LogQuery>;

// ---------------------------------------------------------------- outputs
const iso = z.iso.datetime();
export const LogSummary = z.object({
  id: z.string(), ts: iso, severity: z.enum(SEVERITIES), message: z.string(),
  service: z.string().nullable(), host: z.string().nullable(), traceId: z.string().nullable(), spanId: z.string().nullable(),
  requestId: z.string().nullable(), httpMethod: z.string().nullable(), httpRoute: z.string().nullable(), httpStatus: z.number().nullable(),
  durationMs: z.number().nullable(), errorType: z.string().nullable(), environmentId: z.string(), redactions: z.number(), hasStack: z.boolean(),
});
export type LogSummary = z.infer<typeof LogSummary>;

const KV = z.object({ k: z.string(), v: z.string() });
export const LogDetail = LogSummary.extend({
  projectId: z.string(), serviceVersion: z.string().nullable(), deployment: z.string().nullable(), container: z.string().nullable(),
  exceptionMessage: z.string().nullable(), stack: z.string().nullable(), scope: z.string().nullable(), source: z.enum(['otlp', 'json']),
  severityText: z.string().nullable(), tsSource: z.enum(['event', 'observed', 'received']), tsAdjusted: z.enum(['future']).nullable(),
  receivedAt: iso, expireAt: iso, attrs: z.array(KV), resource: z.array(KV), attrsTruncated: z.boolean(), messageTruncated: z.boolean(),
});
export type LogDetail = z.infer<typeof LogDetail>;

export const LogSearchResult = z.object({ items: z.array(LogSummary), nextCursor: z.string().nullable() });
export const LogContext = z.object({
  related: z.object({ by: z.enum(['traceId', 'requestId']).nullable(), items: z.array(LogSummary) }),
  before: z.array(LogSummary), after: z.array(LogSummary),
});
export const LogHistogram = z.object({ bucketMs: z.number(), buckets: z.array(z.object({ t: z.number(), total: z.number(), errors: z.number() })) });
export const LogFacets = z.object({
  services: z.array(z.object({ value: z.string(), count: z.number() })), severities: z.array(z.object({ value: z.string(), count: z.number() })),
});

// ---------------------------------------------------------------- ingestion tokens, saved queries, stats
export const IngestTokenCreate = z.object({
  name: z.string().trim().min(1).max(80),
  /** `deployments` (ADR-0011) is opt-in: the default stays the three telemetry signals. */
  signals: z.array(z.enum(['logs', 'traces', 'metrics', 'deployments'])).min(1).max(4).default(['logs', 'traces', 'metrics']),
  retentionDays: z.number().int().min(1).max(90).default(30),
  redaction: z.object({
    enabled: z.boolean().default(true),
    extraKeys: z.array(z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9_.-]+$/)).max(50).default([]),
  }).default({ enabled: true, extraKeys: [] }),
  recordsPerMinute: z.number().int().min(100).max(1_000_000).nullable().default(null),
});
export const IngestTokenDto = z.object({
  id: Id, projectId: Id, environmentId: Id, name: z.string(), prefix: z.string(), scopes: z.array(z.string()),
  retentionDays: z.number(), redaction: z.object({ enabled: z.boolean(), extraKeys: z.array(z.string()) }), recordsPerMinute: z.number().nullable(),
  createdAt: iso, lastUsedAt: iso.nullable(), revokedAt: iso.nullable(),
});
export const IngestTokenCreated = z.object({ token: z.string(), info: IngestTokenDto });

export const SavedQueryCreate = z.object({ name: z.string().trim().min(1).max(80), query: LogQuery, shared: z.boolean().default(false) });
export const SavedQueryDto = z.object({ id: z.string(), name: z.string(), query: z.record(z.string(), z.unknown()), shared: z.boolean(), ownedByMe: z.boolean(), createdAt: iso });
export const IngestStatsDto = z.object({
  window: z.object({ from: iso, to: iso, minutes: z.number() }),
  totals: z.object({ requests: z.number(), bytes: z.number(), accepted: z.number(), duplicates: z.number(), rejectedInvalid: z.number(), rejectedQuota: z.number(), rejectedOverload: z.number(), rejectedStorage: z.number(), redactions: z.number() }),
  refused: z.number(),
  perEnvironment: z.array(z.object({ environmentId: z.string(), accepted: z.number(), refused: z.number(), lastAcceptedAt: iso.nullable() })),
});

export const LogParams = z.object({ projectId: Id, logId: z.string().min(8).max(80) });
export const TokenParams = z.object({ projectId: Id, tokenId: Id });
export const SavedQueryParams = z.object({ projectId: Id, queryId: z.string().min(8).max(80) });
export const ExportBody = z.object({ query: LogQuery, format: z.enum(['ndjson', 'csv']).default('ndjson') });
export const TailBody = z.object({ query: LogQuery });
