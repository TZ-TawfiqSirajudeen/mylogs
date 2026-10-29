import { z } from 'zod';
import { Id } from './common.js';
import { LogSummary } from './logs.js';

export const SPAN_KINDS = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'] as const;
export const SPAN_STATUSES = ['unset', 'ok', 'error'] as const;

export const MAX_TRACE_RANGE_MS = 31 * 24 * 3600_000;
export const MAX_TRACE_LIMIT = 200;
/** A trace response never carries more spans than this; larger traces are returned truncated and flagged. */
export const MAX_SPANS_PER_TRACE_RESPONSE = 5000;

const iso = z.iso.datetime();
export const TraceId = z.string().regex(/^[0-9a-f]{32}$/, 'a trace id is 32 lowercase hex characters');
export const SpanId = z.string().regex(/^[0-9a-f]{16}$/, 'a span id is 16 lowercase hex characters');

/** Everything a user may search on. Fields are explicit and typed: there is no way to name an arbitrary database field or operator. */
export const TraceQuery = z.object({
  from: iso,
  to: iso,
  traceId: TraceId.optional(),
  services: z.array(z.string().max(128)).max(20).optional(),
  /** Case-insensitive substring of any span name in the trace (the first 64 distinct names of a trace are indexed). */
  spanName: z.string().trim().max(200).optional(),
  errorsOnly: z.boolean().optional(),
  /** Only traces without any error span. */
  okOnly: z.boolean().optional(),
  minDurationMs: z.number().min(0).max(31 * 24 * 3600_000).optional(),
  maxDurationMs: z.number().min(0).max(31 * 24 * 3600_000).optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  httpMethod: z.string().trim().toUpperCase().max(16).optional(),
  httpRoute: z.string().trim().max(200).optional(),
  dbSystem: z.string().trim().max(64).optional(),
  exceptionType: z.string().trim().max(200).optional(),
  environmentIds: z.array(Id).max(20).optional(),
  sort: z.enum(['recent', 'slowest']).default('recent'),
  limit: z.number().int().min(1).max(MAX_TRACE_LIMIT).default(50),
  cursor: z.string().max(300).optional(),
}).superRefine((q, ctx) => {
  const from = Date.parse(q.from), to = Date.parse(q.to);
  if (!(from < to)) ctx.addIssue({ code: 'custom', message: '"from" must be before "to"', path: ['from'] });
  else if (to - from > MAX_TRACE_RANGE_MS) ctx.addIssue({ code: 'custom', message: 'Time range may not exceed 31 days', path: ['to'] });
  if (q.errorsOnly && q.okOnly) ctx.addIssue({ code: 'custom', message: 'errorsOnly and okOnly are mutually exclusive', path: ['okOnly'] });
  if (q.minDurationMs !== undefined && q.maxDurationMs !== undefined && q.minDurationMs > q.maxDurationMs) ctx.addIssue({ code: 'custom', message: 'minDurationMs exceeds maxDurationMs', path: ['minDurationMs'] });
});
export type TraceQuery = z.infer<typeof TraceQuery>;
export type TraceQueryInput = z.input<typeof TraceQuery>;

const KV = z.object({ k: z.string(), v: z.string() });

export const TraceSummaryDto = z.object({
  traceId: TraceId, environmentId: z.string(),
  /** Earliest valid span start, as ISO (millisecond) and as the exact OTLP nanosecond string. */
  start: iso, startUnixNano: z.string(), durationNs: z.number(), durationMs: z.number(),
  spanCount: z.number(), errorCount: z.number(), services: z.array(z.string()),
  rootName: z.string().nullable(), rootService: z.string().nullable(), rootSpanId: z.string().nullable(),
  httpMethod: z.string().nullable(), httpRoute: z.string().nullable(), httpStatus: z.number().nullable(),
  /** `complete` = a root is stored and no stored span names a missing parent. It is evidence about what was RECEIVED, not a guarantee. */
  completeness: z.enum(['complete', 'partial']),
  hasRoot: z.boolean(), orphanCount: z.number(), invalidTimingCount: z.number(),
});
export type TraceSummaryDto = z.infer<typeof TraceSummaryDto>;

export const TraceSearchResult = z.object({ items: z.array(TraceSummaryDto), nextCursor: z.string().nullable() });

export const SpanEventDto = z.object({ ts: iso, tsUnixNano: z.string(), name: z.string(), attrs: z.array(KV), droppedAttrs: z.number() });
export const SpanLinkDto = z.object({ traceId: z.string(), spanId: z.string(), traceState: z.string().nullable(), attrs: z.array(KV), droppedAttrs: z.number() });
export const SpanDto = z.object({
  traceId: TraceId, spanId: SpanId, parentSpanId: SpanId.nullable(), environmentId: z.string(),
  name: z.string(), kind: z.enum(SPAN_KINDS), statusCode: z.enum(SPAN_STATUSES), statusMessage: z.string().nullable(),
  service: z.string().nullable(), serviceVersion: z.string().nullable(), host: z.string().nullable(), deployment: z.string().nullable(),
  /** Exact OTLP timestamps (nanoseconds since the epoch, as decimal strings: they exceed 2^53). */
  startUnixNano: z.string(), endUnixNano: z.string(), durationNs: z.number().nullable(), timingValid: z.boolean(),
  httpMethod: z.string().nullable(), httpRoute: z.string().nullable(), httpStatus: z.number().nullable(),
  dbSystem: z.string().nullable(), peerService: z.string().nullable(), exceptionType: z.string().nullable(),
  scopeName: z.string().nullable(), scopeVersion: z.string().nullable(), traceState: z.string().nullable(), flags: z.number().nullable(),
  attrs: z.array(KV), resource: z.array(KV), events: z.array(SpanEventDto), links: z.array(SpanLinkDto),
  droppedAttrs: z.number(), droppedEvents: z.number(), droppedLinks: z.number(), attrsTruncated: z.boolean(), redactions: z.number(),
});
export type SpanDto = z.infer<typeof SpanDto>;

export const TraceDetail = z.object({
  summary: TraceSummaryDto,
  spans: z.array(SpanDto),
  /** Spans stored for this trace; `spans` may hold fewer when the trace is larger than the response limit. */
  totalSpans: z.number(), truncated: z.boolean(),
  /** Plain-language reasons the trace may be incomplete (empty when no evidence of incompleteness exists). */
  warnings: z.array(z.string()),
});
export type TraceDetail = z.infer<typeof TraceDetail>;

export const TraceParams = z.object({ projectId: Id, traceId: TraceId });
export const SpanParams = z.object({ projectId: Id, traceId: TraceId, spanId: SpanId });

export const TraceLogs = z.object({
  /** `matched` = logs carrying this trace id. `unavailable` = the logs reference a trace that has not arrived (distinct from "no such trace"). */
  traceKnown: z.boolean(),
  logs: z.array(LogSummary),
  truncated: z.boolean(),
  /** Counts per span id (spans with logs), so the waterfall can mark them. */
  bySpan: z.record(z.string(), z.number()),
});

/** Observed (not inferred) service-to-service and service-to-datastore relationships. */
export const DependencyEdge = z.object({
  from: z.string(), to: z.string(), kind: z.enum(['service', 'database', 'external']),
  /** How the edge was observed: `parent-child` (a client span with a server child in another service) or `span-attribute` (db.system / peer address on a client span). */
  basis: z.enum(['parent-child', 'span-attribute']), calls: z.number(), errors: z.number(),
});
export type DependencyEdge = z.infer<typeof DependencyEdge>;
