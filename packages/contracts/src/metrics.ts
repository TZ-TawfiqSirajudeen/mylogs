import { z } from 'zod';
import { Id } from './common.js';
import { MAX_TRACE_RANGE_MS } from './traces.js';

const iso = z.iso.datetime();

export const METRIC_AGGREGATIONS = ['sum', 'rate', 'avg', 'min', 'max', 'last', 'count', 'p50', 'p90', 'p95', 'p99'] as const;
export type MetricAggregation = (typeof METRIC_AGGREGATIONS)[number];

/** Hard limits that protect the store: every metric query is bounded in time, series, points and scanned data. */
export const METRIC_LIMITS = {
  maxRangeMs: MAX_TRACE_RANGE_MS, minStepSeconds: 60, maxPointsPerSeries: 400, maxResultSeries: 50, maxSeriesScanned: 2000, maxPointDocsScanned: 250_000, maxFilters: 5, maxGroupBy: 2,
} as const;

export const MetricName = z.string().min(1).max(200).regex(/^[A-Za-z_][A-Za-z0-9_.\-/:]*$/, 'invalid metric name');
const LabelKey = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.\-/]+$/);

export const MetricQuery = z.object({
  from: iso, to: iso,
  metric: MetricName,
  service: z.string().max(128).optional(),
  /** Exact-match label filters (label values are bounded strings; there are no operators to inject). */
  filters: z.array(z.object({ key: LabelKey, value: z.string().max(128) })).max(METRIC_LIMITS.maxFilters).default([]),
  /** Label keys (or the special key `service`) to split the result by. */
  groupBy: z.array(LabelKey).max(METRIC_LIMITS.maxGroupBy).default([]),
  agg: z.enum(METRIC_AGGREGATIONS).optional(),
  /** Aggregation window; chosen automatically when omitted so a result never exceeds the point limit. */
  stepSeconds: z.number().int().min(METRIC_LIMITS.minStepSeconds).max(86_400).optional(),
  environmentIds: z.array(Id).max(20).optional(),
}).superRefine((q, ctx) => {
  const from = Date.parse(q.from), to = Date.parse(q.to);
  if (!(from < to)) ctx.addIssue({ code: 'custom', message: '"from" must be before "to"', path: ['from'] });
  else if (to - from > METRIC_LIMITS.maxRangeMs) ctx.addIssue({ code: 'custom', message: 'Time range may not exceed 31 days', path: ['to'] });
});
export type MetricQuery = z.infer<typeof MetricQuery>;
export type MetricQueryInput = z.input<typeof MetricQuery>;

export const MetricSeriesDto = z.object({
  labels: z.record(z.string(), z.string()),
  /** `v` is null when NO measurement exists in that window. Missing data is never drawn as zero. */
  points: z.array(z.object({ t: z.number(), v: z.number().nullable() })),
  /** Exemplars (trace links) seen in the window, newest first, bounded. */
  exemplars: z.array(z.object({ traceId: z.string(), spanId: z.string().nullable(), value: z.number(), ts: iso })),
});
export const MetricQueryResult = z.object({
  metric: z.string(), type: z.enum(['gauge', 'sum', 'histogram']).nullable(), unit: z.string().nullable(),
  agg: z.enum(METRIC_AGGREGATIONS).nullable(), stepMs: z.number(), from: iso, to: iso,
  series: z.array(MetricSeriesDto),
  /** More series matched than are returned (the largest are kept). */
  truncated: z.boolean(),
  /** Plain-language caveats: estimated percentiles, missing data, bucket layouts, dropped series. */
  notes: z.array(z.string()),
});
export type MetricQueryResult = z.infer<typeof MetricQueryResult>;

export const MetricNameInfo = z.object({
  name: z.string(), type: z.enum(['gauge', 'sum', 'histogram']), unit: z.string().nullable(), description: z.string().nullable(),
  temporality: z.enum(['delta', 'cumulative']).nullable(), series: z.number(), services: z.array(z.string()), lastSeen: iso,
});
export const MetricLabelInfo = z.object({ key: z.string(), values: z.array(z.string()), truncated: z.boolean() });

// ---------------------------------------------------------------- services
export const ServiceTimelinePoint = z.object({ t: z.number(), requests: z.number().nullable(), errors: z.number().nullable(), p95Ms: z.number().nullable() });
export const ServiceRoute = z.object({ route: z.string(), requests: z.number(), errors: z.number(), p95Ms: z.number().nullable() });
export const ServiceHealth = z.object({
  service: z.string(), environmentId: z.string(), version: z.string().nullable(),
  /** Where the numbers come from. `metrics` = explicit OTLP HTTP server metrics (authoritative). `traces` = derived from stored SERVER spans (depends on sampling). `none` = nothing to compute from. */
  source: z.enum(['metrics', 'traces', 'none']),
  sourceDetail: z.string().nullable(),
  requests: z.number().nullable(), errors: z.number().nullable(), errorRate: z.number().nullable(), ratePerSec: z.number().nullable(),
  p50Ms: z.number().nullable(), p95Ms: z.number().nullable(), p99Ms: z.number().nullable(),
  statuses: z.record(z.string(), z.number()),
  routes: z.array(ServiceRoute), timeline: z.array(ServiceTimelinePoint),
  lastSpanAt: iso.nullable(), lastMetricAt: iso.nullable(), lastLogAt: iso.nullable(),
  /** `active` = telemetry seen recently; `stale` = seen, but not within the freshness window; `unknown` = never seen with data. Absence of errors is never "healthy" by itself. */
  freshness: z.enum(['active', 'stale', 'unknown']),
  traceCount: z.number().nullable(),
});
export type ServiceHealth = z.infer<typeof ServiceHealth>;
export const ServiceOverview = z.object({
  from: iso, to: iso, stepMs: z.number(), freshnessWindowMs: z.number(),
  services: z.array(ServiceHealth),
  dependencies: z.object({ edges: z.array(z.object({ from: z.string(), to: z.string(), kind: z.enum(['service', 'database', 'external']), basis: z.enum(['parent-child', 'span-attribute']), calls: z.number(), errors: z.number() })), sampled: z.boolean() }),
  notes: z.array(z.string()),
});
export type ServiceOverview = z.infer<typeof ServiceOverview>;

export const MetricDiagnostics = z.object({
  series: z.number(), pointDocs: z.number(),
  topMetrics: z.array(z.object({ name: z.string(), series: z.number(), nearLimit: z.boolean() })),
  limits: z.object({ maxSeriesPerMetric: z.number(), maxSeriesPerEnvironment: z.number() }),
  storageBytes: z.number().nullable(),
});
export const TelemetryDiagnostics = z.object({
  window: z.object({ minutes: z.number() }),
  signals: z.record(z.string(), z.object({
    requests: z.number(), accepted: z.number(), duplicates: z.number(), refused: z.number(), redactions: z.number(), lastAcceptedAt: iso.nullable(),
    rejectedInvalid: z.number(), rejectedQuota: z.number(), rejectedOverload: z.number(), rejectedStorage: z.number(),
  })),
  storage: z.object({ spans: z.number(), traceSummaries: z.number(), logs: z.number(), metrics: MetricDiagnostics }),
});
