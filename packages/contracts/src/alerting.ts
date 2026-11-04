import { z } from 'zod';
import { Id } from './common.js';
import { LogFilter, LogQuery, SEVERITIES } from './logs.js';
import { MetricName } from './metrics.js';
import { MISSED_POLICIES, REPLAY_LIMITS } from './maintenance.js';

const iso = z.iso.datetime();

/**
 * Every bound that protects the platform from an alerting configuration (or an attacker holding a project-admin session).
 * They are enforced by the schemas below AND again in the services, so a direct database edit or a future caller cannot bypass them.
 */
export const ALERT_LIMITS = {
  maxRulesPerProject: 100,
  maxChannelsPerProject: 10,
  maxChannelsPerRule: 5,
  maxActiveSilencesPerProject: 50,
  minWindowSeconds: 60, maxWindowSeconds: 86_400,
  maxForSeconds: 86_400, maxResolveAfterSeconds: 86_400,
  minIntervalSeconds: 15, maxIntervalSeconds: 3_600,
  /** Groups (label values) one rule keeps state for; more are ignored and reported. */
  maxGroupsPerRule: 20,
  maxSilenceMs: 30 * 24 * 3_600_000,
  maxSilenceRuleIds: 20,
  maxCommentChars: 2_000,
  maxCommentsPerIncident: 100,
  /** Timeline events kept per incident (the newest are kept). */
  maxTimelineEvents: 500,
  maxFiltersPerRule: 10,
  maxUrlChars: 2_048,
  minSecretChars: 16, maxSecretChars: 256,
  maxRateLimitPerMinute: 60,
  listLimit: 100,
} as const;

export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];
export const COMPARISON_OPS = ['gt', 'gte', 'lt', 'lte', 'eq', 'ne'] as const;
export type ComparisonOp = (typeof COMPARISON_OPS)[number];
export const NO_DATA_POLICIES = ['ok', 'alert', 'keep'] as const;
export type NoDataPolicy = (typeof NO_DATA_POLICIES)[number];

/**
 * Aggregations that can be computed EXACTLY over a window from the metric store's per-step results (sums and extremes compose; averages are
 * computed as sum/count). Percentiles are deliberately absent: a percentile of per-minute percentiles is wrong, and the store does not expose
 * mergeable buckets for a sliding window (see ADR-0006).
 */
export const RULE_METRIC_AGGREGATIONS = ['sum', 'rate', 'avg', 'min', 'max', 'last', 'count'] as const;
export type RuleMetricAggregation = (typeof RULE_METRIC_AGGREGATIONS)[number];

const LabelKey = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.\-/]+$/);

export const MetricRuleQuery = z.strictObject({
  kind: z.literal('metric'),
  metric: MetricName,
  service: z.string().trim().min(1).max(128).optional(),
  /** Exact-match label filters (same bounded form as the metrics explorer). */
  filters: z.array(z.strictObject({ key: LabelKey, value: z.string().max(128) })).max(5).default([]),
  /** One label (or `service`) to evaluate separately; each value gets its own state and incident. */
  groupBy: z.array(LabelKey).max(1).default([]),
  agg: z.enum(RULE_METRIC_AGGREGATIONS),
});
export type MetricRuleQuery = z.infer<typeof MetricRuleQuery>;

export const LogRuleQuery = z.strictObject({
  kind: z.literal('logs'),
  /** The same filter vocabulary as the Logs Explorer (allow-listed fields and operators only). The rule counts matching records in the window. */
  text: z.string().trim().max(200).optional(),
  minSeverity: z.enum(SEVERITIES).optional(),
  errorsOnly: z.boolean().optional(),
  services: z.array(z.string().max(128)).max(20).optional(),
  filters: z.array(LogFilter).max(ALERT_LIMITS.maxFiltersPerRule).default([]),
}).superRefine((q, ctx) => {
  // Reuse the Logs Explorer validation (operator/field compatibility) so a rule can never hold a query the store would refuse.
  const r = LogQuery.safeParse({ from: '2000-01-01T00:00:00.000Z', to: '2000-01-01T01:00:00.000Z', text: q.text, minSeverity: q.minSeverity, errorsOnly: q.errorsOnly, services: q.services, filters: q.filters });
  if (!r.success) for (const i of r.error.issues) ctx.addIssue({ code: 'custom', message: i.message, path: i.path.filter((p) => p !== 'from' && p !== 'to') });
});
export type LogRuleQuery = z.infer<typeof LogRuleQuery>;

export const RuleQuery = z.discriminatedUnion('kind', [MetricRuleQuery, LogRuleQuery]);
export type RuleQuery = z.infer<typeof RuleQuery>;

export const RuleCondition = z.strictObject({ op: z.enum(COMPARISON_OPS), threshold: z.number().finite().min(-1e15).max(1e15) });
export type RuleCondition = z.infer<typeof RuleCondition>;

/** Plain field schemas (no defaults): PATCH bodies must not receive server defaults for fields the caller did not send. */
const ruleFields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500),
  severity: z.enum(ALERT_SEVERITIES),
  /** A rule reads exactly one environment: access to it is decided by the caller's environment scope. */
  environmentId: Id,
  enabled: z.boolean(),
  query: RuleQuery,
  condition: RuleCondition,
  /** The aggregation window (the last N seconds before each evaluation). */
  windowSeconds: z.number().int().min(ALERT_LIMITS.minWindowSeconds).max(ALERT_LIMITS.maxWindowSeconds),
  /** The condition must hold continuously this long before the rule fires (0 = fire on the first breaching evaluation). */
  forSeconds: z.number().int().min(0).max(ALERT_LIMITS.maxForSeconds),
  /** Flapping protection: the condition must stay clear this long before a firing rule resolves. */
  resolveAfterSeconds: z.number().int().min(0).max(ALERT_LIMITS.maxResolveAfterSeconds),
  noDataPolicy: z.enum(NO_DATA_POLICIES),
  intervalSeconds: z.number().int().min(ALERT_LIMITS.minIntervalSeconds).max(ALERT_LIMITS.maxIntervalSeconds),
  channelIds: z.array(Id).max(ALERT_LIMITS.maxChannelsPerRule),
  /** What to do when evaluations were missed (worker down, lease expired): `skip` = only count them, `replay` = re-evaluate the latest ones in order (ADR-0010). */
  missedPolicy: z.enum(MISSED_POLICIES),
  /** Replay: at most this many missed interval boundaries are re-evaluated per catch-up. */
  maxReplayEvaluations: z.number().int().min(1).max(REPLAY_LIMITS.maxEvaluations),
  /** Replay: a replayed transition older than this (at processing time) is recorded as `stale` and not sent. */
  staleNotificationSeconds: z.number().int().min(0).max(REPLAY_LIMITS.maxStaleSeconds),
};
export const ruleShape = {
  ...ruleFields,
  description: ruleFields.description.default(''),
  enabled: ruleFields.enabled.default(true),
  forSeconds: ruleFields.forSeconds.default(0),
  resolveAfterSeconds: ruleFields.resolveAfterSeconds.default(120),
  noDataPolicy: ruleFields.noDataPolicy.default('keep'),
  intervalSeconds: ruleFields.intervalSeconds.default(60),
  channelIds: ruleFields.channelIds.default([]),
  missedPolicy: ruleFields.missedPolicy.default('skip'),
  maxReplayEvaluations: ruleFields.maxReplayEvaluations.default(REPLAY_LIMITS.defaultMaxEvaluations),
  staleNotificationSeconds: ruleFields.staleNotificationSeconds.default(REPLAY_LIMITS.defaultStaleSeconds),
};

/** Cross-field rules (used for create and for the merged result of an update). */
export function validateRuleFields(r: { query: RuleQuery; condition: RuleCondition; windowSeconds: number; intervalSeconds: number; channelIds: string[] }): string[] {
  const issues: string[] = [];
  if (r.query.kind === 'logs' && (!Number.isInteger(r.condition.threshold) || r.condition.threshold < 0)) issues.push('A log rule compares a record count: the threshold must be a whole number of 0 or more');
  if (r.intervalSeconds > r.windowSeconds * 2 && r.windowSeconds < ALERT_LIMITS.maxWindowSeconds) issues.push('The evaluation interval may not be more than twice the window: data between evaluations would never be examined');
  if (new Set(r.channelIds).size !== r.channelIds.length) issues.push('Channels must be unique');
  return issues;
}
const refineRule = (r: { query: RuleQuery; condition: RuleCondition; windowSeconds: number; intervalSeconds: number; channelIds: string[] }, ctx: z.RefinementCtx) => {
  for (const message of validateRuleFields(r)) ctx.addIssue({ code: 'custom', message });
};

export const AlertRuleCreate = z.strictObject(ruleShape).superRefine(refineRule);
export type AlertRuleCreate = z.infer<typeof AlertRuleCreate>;
export const AlertRuleUpdate = z.strictObject(ruleFields).partial().refine((b) => Object.keys(b).length > 0, 'Nothing to update');
export type AlertRuleUpdate = z.infer<typeof AlertRuleUpdate>;
/** Same as create without server-side defaults applied: what a stored rule looks like. */
export type AlertRuleFields = AlertRuleCreate;

export const RULE_STATUSES = ['ok', 'pending', 'firing', 'resolved'] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];

export const RuleGroupStateDto = z.object({
  key: z.string(), labels: z.record(z.string(), z.string()), status: z.enum(RULE_STATUSES),
  since: iso.nullable(), lastValue: z.number().nullable(), incidentId: Id.nullable(),
});
export const AlertRuleDto = z.object({
  id: Id, projectId: Id, ...ruleFields,
  version: z.number(),
  /** `unknown` = never evaluated. `error` = the last evaluation failed (state is NOT changed by a failed evaluation). */
  health: z.enum(['unknown', 'ok', 'error']),
  status: z.enum(['unknown', 'ok', 'pending', 'firing']),
  lastEvaluatedAt: iso.nullable(), nextEvalAt: iso.nullable(),
  lastError: z.object({ at: iso, message: z.string() }).nullable(),
  lastValue: z.number().nullable(),
  noDataSince: iso.nullable(),
  /** Evaluations that were due but not run on time (cumulative): replayed = re-evaluated in order, skipped = only counted. */
  missedEvaluations: z.object({ total: z.number(), replayed: z.number(), skipped: z.number(), lastAt: iso.nullable() }),
  groups: z.array(RuleGroupStateDto),
  truncatedGroups: z.boolean(),
  createdBy: Id, createdAt: iso, updatedAt: iso,
});
export type AlertRuleDto = z.infer<typeof AlertRuleDto>;

// Notification channels (webhook, Slack, e-mail) live in ./alert-channels.ts (ADR-0008).

// ---------------------------------------------------------------- silences
export const SilenceCreate = z.strictObject({
  comment: z.string().trim().min(1).max(500),
  startsAt: iso, endsAt: iso,
  /** Empty = the whole project. All given matchers must match (AND); within a list any value matches. */
  matchers: z.strictObject({
    ruleIds: z.array(Id).max(ALERT_LIMITS.maxSilenceRuleIds).optional(),
    severities: z.array(z.enum(ALERT_SEVERITIES)).max(3).optional(),
    environmentIds: z.array(Id).max(20).optional(),
  }).default({}),
}).superRefine((s, ctx) => {
  const a = Date.parse(s.startsAt), b = Date.parse(s.endsAt);
  if (!(a < b)) ctx.addIssue({ code: 'custom', message: '"endsAt" must be after "startsAt"', path: ['endsAt'] });
  else if (b - a > ALERT_LIMITS.maxSilenceMs) ctx.addIssue({ code: 'custom', message: 'A silence may last at most 30 days', path: ['endsAt'] });
});
export const SilenceDto = z.object({
  id: Id, projectId: Id, comment: z.string(), startsAt: iso, endsAt: iso,
  matchers: z.object({ ruleIds: z.array(Id).optional(), severities: z.array(z.enum(ALERT_SEVERITIES)).optional(), environmentIds: z.array(Id).optional() }),
  state: z.enum(['scheduled', 'active', 'expired']),
  createdBy: Id, createdAt: iso,
});

// ---------------------------------------------------------------- incidents
export const INCIDENT_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];
export const INCIDENT_EVENT_TYPES = ['opened', 'notified', 'notification_failed', 'notification_suppressed', 'acknowledged', 'resolved', 'auto_resolved', 'comment'] as const;
export type IncidentEventType = (typeof INCIDENT_EVENT_TYPES)[number];

export const IncidentEventDto = z.object({
  id: Id, type: z.enum(INCIDENT_EVENT_TYPES), at: iso,
  actorUserId: Id.nullable(), actorName: z.string().nullable(),
  message: z.string(),
  data: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
});
export const IncidentDto = z.object({
  id: Id, projectId: Id, environmentId: Id, ruleId: Id, ruleName: z.string(), severity: z.enum(ALERT_SEVERITIES),
  title: z.string(), groupKey: z.string(), groupLabels: z.record(z.string(), z.string()),
  status: z.enum(INCIDENT_STATUSES),
  openedAt: iso, acknowledgedAt: iso.nullable(), acknowledgedBy: Id.nullable(), resolvedAt: iso.nullable(),
  resolvedBy: z.object({ kind: z.enum(['user', 'auto']), userId: Id.nullable(), reason: z.string().nullable() }).nullable(),
  lastValue: z.number().nullable(),
  condition: z.object({ op: z.enum(COMPARISON_OPS), threshold: z.number(), windowSeconds: z.number() }),
  eventCount: z.number(),
});
export type IncidentDto = z.infer<typeof IncidentDto>;
export const IncidentDetailDto = IncidentDto.extend({ timeline: z.array(IncidentEventDto) });

export const CommentBody = z.strictObject({ body: z.string().trim().min(1).max(ALERT_LIMITS.maxCommentChars) });
export const ResolveBody = z.strictObject({ note: z.string().trim().max(500).optional() }).default({});
export const AckBody = z.strictObject({ note: z.string().trim().max(500).optional() }).default({});

// ---------------------------------------------------------------- deliveries
export const DELIVERY_STATUSES = ['pending', 'delivered', 'failed', 'suppressed', 'rate_limited', 'stale'] as const;
export const DeliveryDto = z.object({
  id: Id, incidentId: Id.nullable(), channelId: Id, channelName: z.string(),
  event: z.enum(['incident.opened', 'incident.resolved', 'test']),
  status: z.enum(DELIVERY_STATUSES), attempts: z.number(),
  createdAt: iso, deliveredAt: iso.nullable(), nextAttemptAt: iso.nullable(),
  lastError: z.object({ code: z.string(), message: z.string() }).nullable(), httpStatus: z.number().nullable(), silenceId: Id.nullable(), maintenanceId: Id.nullable(),
});
export type DeliveryDto = z.infer<typeof DeliveryDto>;
export const TestSendResult = z.object({ ok: z.boolean(), status: z.number().nullable(), message: z.string(), delivery: DeliveryDto });

// ---------------------------------------------------------------- params and queries
export const ProjectParam = z.object({ projectId: Id });
export const RuleParams = z.object({ projectId: Id, ruleId: Id });
export const ChannelParams = z.object({ projectId: Id, channelId: Id });
export const SilenceParams = z.object({ projectId: Id, silenceId: Id });
export const IncidentParams = z.object({ projectId: Id, incidentId: Id });

const limit = z.coerce.number().int().min(1).max(ALERT_LIMITS.listLimit).default(25);
const cursor = z.string().max(300).optional();
export const RuleListQuery = z.object({ limit, cursor, environmentId: Id.optional(), enabled: z.enum(['true', 'false']).optional() });
export const IncidentListQuery = z.object({
  limit, cursor, environmentId: Id.optional(), ruleId: Id.optional(),
  status: z.enum([...INCIDENT_STATUSES, 'active']).optional(), severity: z.enum(ALERT_SEVERITIES).optional(),
});
export const PageQuery = z.object({ limit, cursor });
export const page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export type SilenceDto = z.infer<typeof SilenceDto>;
export type IncidentEventDto = z.infer<typeof IncidentEventDto>;
export type IncidentDetailDto = z.infer<typeof IncidentDetailDto>;
