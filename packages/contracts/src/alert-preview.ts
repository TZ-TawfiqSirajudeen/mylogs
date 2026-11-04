import { z } from 'zod';
import { COMPARISON_OPS, RULE_STATUSES, ruleShape, validateRuleFields } from './alerting.js';

/** Every bound of a rule preview (ADR-0009). Enforced by the schema below AND again in the service. */
export const PREVIEW_LIMITS = {
  defaultRangeSeconds: 6 * 3_600, minRangeSeconds: 300, maxRangeSeconds: 24 * 3_600,
  /** Evaluation points per preview (the step is widened so the range never needs more). */
  maxPoints: 200,
  /** Store queries per preview (an `avg` rule needs two per point). */
  maxStoreQueries: 400,
  /** Evaluations in flight at once for one preview. */
  concurrency: 4,
  /** Wall-clock budget of the whole preview. */
  deadlineMs: 15_000,
  /** Previews one API process runs at the same time. */
  maxConcurrentPerProcess: 2,
} as const;

const iso = z.iso.datetime();

/** The rule fields that decide what is measured (no name, severity, channels or enabled flag), same schemas and limits as rule create. */
const measuring = z.strictObject({
  environmentId: ruleShape.environmentId, query: ruleShape.query, condition: ruleShape.condition, windowSeconds: ruleShape.windowSeconds,
  forSeconds: ruleShape.forSeconds, resolveAfterSeconds: ruleShape.resolveAfterSeconds, noDataPolicy: ruleShape.noDataPolicy, intervalSeconds: ruleShape.intervalSeconds,
}).superRefine((r, ctx) => {
  for (const message of validateRuleFields({ ...r, channelIds: [] })) ctx.addIssue({ code: 'custom', message });
});

export const RulePreviewBody = z.strictObject({
  rule: measuring,
  /** How far back to replay, ending now. */
  rangeSeconds: z.number().int().min(PREVIEW_LIMITS.minRangeSeconds).max(PREVIEW_LIMITS.maxRangeSeconds).default(PREVIEW_LIMITS.defaultRangeSeconds),
});
export type RulePreviewBody = z.infer<typeof RulePreviewBody>;
export type RulePreviewInput = z.input<typeof RulePreviewBody>;

export const PreviewPeriod = z.object({
  kind: z.enum(['pending', 'firing']), from: iso,
  /** End of the period (the first evaluation that was no longer in this state), or the end of the range when `ongoing`. */
  to: iso, ongoing: z.boolean(),
});

export const PreviewGroup = z.object({
  key: z.string(), labels: z.record(z.string(), z.string()),
  /** One entry per evaluation time (`times`). `null` = no data at that time (never zero). */
  values: z.array(z.number().nullable()),
  /** The state after each evaluation time. */
  states: z.array(z.enum(RULE_STATUSES)),
  periods: z.array(PreviewPeriod),
  /** Incidents this group would have opened. */
  wouldOpen: z.number(), noDataPoints: z.number(),
});

export const RulePreviewResult = z.object({
  from: iso, to: iso, rangeSeconds: z.number(),
  /** Spacing of the evaluation times (the rule's interval, widened when the range needs more than 200 points). */
  stepSeconds: z.number(), intervalSeconds: z.number(), windowSeconds: z.number(),
  condition: z.object({ op: z.enum(COMPARISON_OPS), threshold: z.number() }),
  /** Evaluation times, ms since epoch, oldest first. */
  times: z.array(z.number()),
  /** Indexes into `times` whose evaluation failed and was skipped (state unchanged, as in a live evaluation). */
  skipped: z.array(z.number()),
  groups: z.array(PreviewGroup),
  totals: z.object({
    wouldOpenIncidents: z.number(), groupsThatWouldFire: z.number(), evaluationPoints: z.number(), evaluatedPoints: z.number(),
    /** Evaluation times at which no group had any data. */
    noDataPoints: z.number(), skippedPoints: z.number(), storeQueries: z.number(),
  }),
  truncatedGroups: z.boolean(),
  /** The deadline, the point limit or the query limit stopped the replay early: only the first part of the range was evaluated. */
  partial: z.boolean(),
  /** Plain-language statements about what the numbers do and do not mean (no-data handling, coarse step, start state, limits). */
  notes: z.array(z.string()),
  elapsedMs: z.number(),
});
export type RulePreviewResult = z.infer<typeof RulePreviewResult>;
export type PreviewGroup = z.infer<typeof PreviewGroup>;
