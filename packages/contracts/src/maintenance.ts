import { z } from 'zod';
import { Id } from './common.js';

const iso = z.iso.datetime();

/** Bounds of maintenance windows and of the replay policy (ADR-0010). Enforced by the schemas AND again by the services. */
export const MAINTENANCE_LIMITS = {
  maxWindowsPerProject: 20,
  maxOnceMs: 30 * 24 * 3_600_000,
  minDurationMinutes: 1, maxDurationMinutes: 1_440,
  maxRuleIds: 20, maxEnvironmentIds: 20,
  maxCommentChars: 500, maxNameChars: 80,
} as const;

export const REPLAY_LIMITS = { defaultMaxEvaluations: 5, maxEvaluations: 20, defaultStaleSeconds: 900, maxStaleSeconds: 86_400 } as const;
export const MISSED_POLICIES = ['skip', 'replay'] as const;
export type MissedPolicy = (typeof MISSED_POLICIES)[number];

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** IANA zone names only (`Europe/Berlin`, `America/Argentina/Buenos_Aires`, `UTC`). Numeric offsets cannot follow daylight saving and are refused. */
export const IANA_ZONE_SHAPE = /^(?:UTC|GMT|[A-Za-z][A-Za-z_]*(?:\/[A-Za-z0-9_+\-]+){1,2})$/;
export const TIME_OF_DAY = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const OnceSchedule = z.strictObject({ type: z.literal('once'), startsAt: iso, endsAt: iso });
export const WeeklySchedule = z.strictObject({
  type: z.literal('weekly'),
  timezone: z.string().trim().min(1).max(64).regex(IANA_ZONE_SHAPE, 'Use an IANA time zone name such as "Europe/Berlin" or "UTC"'),
  weekdays: z.array(z.enum(WEEKDAYS)).min(1).max(7),
  /** Local wall-clock start, 24 h "HH:MM". */
  startTime: z.string().regex(TIME_OF_DAY, 'Use 24-hour HH:MM'),
  /** Elapsed real time. May cross midnight; at most 24 h. */
  durationMinutes: z.number().int().min(MAINTENANCE_LIMITS.minDurationMinutes).max(MAINTENANCE_LIMITS.maxDurationMinutes),
});
export const MaintenanceSchedule = z.discriminatedUnion('type', [OnceSchedule, WeeklySchedule]);
export type MaintenanceSchedule = z.infer<typeof MaintenanceSchedule>;

export const MaintenanceMatchers = z.strictObject({
  ruleIds: z.array(Id).max(MAINTENANCE_LIMITS.maxRuleIds).optional(),
  severities: z.array(z.enum(['info', 'warning', 'critical'])).max(3).optional(),
  environmentIds: z.array(Id).max(MAINTENANCE_LIMITS.maxEnvironmentIds).optional(),
});

/** Cross-field checks shared by the schema and the service (the zone must really exist; a once-window must be ordered and bounded; weekdays unique). */
export function scheduleIssues(s: MaintenanceSchedule): string[] {
  const out: string[] = [];
  if (s.type === 'once') {
    const a = Date.parse(s.startsAt), b = Date.parse(s.endsAt);
    if (!(a < b)) out.push('"endsAt" must be after "startsAt"');
    else if (b - a > MAINTENANCE_LIMITS.maxOnceMs) out.push('A one-off maintenance window may last at most 30 days');
  } else {
    if (new Set(s.weekdays).size !== s.weekdays.length) out.push('Weekdays must be unique');
    try { new Intl.DateTimeFormat('en-US', { timeZone: s.timezone }); } catch { out.push(`Unknown time zone "${s.timezone}"`); }
  }
  return out;
}

const maintenanceFields = {
  name: z.string().trim().min(1).max(MAINTENANCE_LIMITS.maxNameChars),
  comment: z.string().trim().max(MAINTENANCE_LIMITS.maxCommentChars),
  enabled: z.boolean(),
  schedule: MaintenanceSchedule,
  /** Empty = the whole project. All given matchers must match (AND); within a list any value matches. */
  matchers: MaintenanceMatchers,
};
const refine = (b: { schedule?: MaintenanceSchedule }, ctx: z.RefinementCtx) => {
  if (b.schedule) for (const message of scheduleIssues(b.schedule)) ctx.addIssue({ code: 'custom', message, path: ['schedule'] });
};
export const MaintenanceCreate = z.strictObject({
  ...maintenanceFields, comment: maintenanceFields.comment.default(''), enabled: maintenanceFields.enabled.default(true), matchers: maintenanceFields.matchers.default({}),
}).superRefine(refine);
export type MaintenanceCreate = z.infer<typeof MaintenanceCreate>;
export const MaintenanceUpdate = z.strictObject(maintenanceFields).partial().superRefine(refine).refine((b) => Object.keys(b).length > 0, 'Nothing to update');
export type MaintenanceUpdate = z.infer<typeof MaintenanceUpdate>;

export const MAINTENANCE_STATES = ['active', 'scheduled', 'expired', 'disabled'] as const;
const Occurrence = z.object({ startsAt: iso, endsAt: iso });
export const MaintenanceDto = z.object({
  id: Id, projectId: Id, ...maintenanceFields,
  version: z.number(),
  /** Evaluated by the server clock at response time. */
  state: z.enum(MAINTENANCE_STATES),
  activeNow: z.boolean(),
  currentOccurrence: Occurrence.nullable(),
  /** The next occurrence that has not started yet (null when none will: an expired one-off window). */
  nextOccurrence: Occurrence.nullable(),
  createdBy: Id, createdAt: iso, updatedAt: iso,
});
export type MaintenanceDto = z.infer<typeof MaintenanceDto>;
export const MaintenanceParams = z.object({ projectId: Id, windowId: Id });
