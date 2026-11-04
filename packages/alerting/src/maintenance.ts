import { randomUUID } from 'node:crypto';
import { MAINTENANCE_LIMITS, scheduleIssues, WEEKDAYS, type MaintenanceCreate, type MaintenanceDto, type MaintenanceSchedule, type MaintenanceUpdate } from '@nexus/contracts';
import type { AlertMaintenanceDoc, AlertRuleDoc, AuditSink, Database, MaintenanceScheduleDoc } from '@nexus/database';
import type { Collection } from 'mongodb';
import {
  type ActorScope, AlertingError, conflict, DAY_MS, decodeCursor, encodeCursor, forbiddenScope, invalid, isDuplicateKey, notFound, type RequestContext, ruleCol,
} from './common.js';

/**
 * Maintenance windows (ADR-0010). Everything in the first half of this file is PURE: no clock, no I/O, only `Intl.DateTimeFormat` (time zones with
 * daylight saving come from the platform's IANA database). Every function takes the instant to judge as an argument.
 *
 * Conventions (each has a test):
 *  - a weekly occurrence STARTS at the local wall-clock time on a listed weekday; its duration is ELAPSED real time (so it may end at a different
 *    wall-clock time on the night the clocks change) and may cross midnight: it belongs to the weekday it starts on;
 *  - a start time that does not exist (spring forward) is shifted forward by the length of the gap (02:30 -> 03:30);
 *  - a start time that exists twice (fall back) uses the first occurrence.
 */
export type Schedule = MaintenanceScheduleDoc;
export interface Occurrence { startsAt: Date; endsAt: Date }

const MIN_MS = 60_000;
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    formatters.set(timeZone, f);
  }
  return f;
}

interface Civil { y: number; m: number; d: number }
/** The zone's offset from UTC (local minus UTC, in ms) at an instant. Throws RangeError for an unknown zone. */
export function zoneOffsetMs(timeZone: string, utcMs: number): number {
  const p: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(utcMs))) if (part.type !== 'literal') p[part.type] = Number(part.value);
  const asUtc = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}
const civilOf = (timeZone: string, utcMs: number): Civil => {
  const l = new Date(utcMs + zoneOffsetMs(timeZone, utcMs));
  return { y: l.getUTCFullYear(), m: l.getUTCMonth() + 1, d: l.getUTCDate() };
};
const addDays = (c: Civil, n: number): Civil => { const l = new Date(Date.UTC(c.y, c.m - 1, c.d + n)); return { y: l.getUTCFullYear(), m: l.getUTCMonth() + 1, d: l.getUTCDate() }; };
const weekdayOf = (c: Civil): (typeof WEEKDAYS)[number] => WEEKDAYS[(new Date(Date.UTC(c.y, c.m - 1, c.d)).getUTCDay() + 6) % 7]!;

/** Local wall-clock -> instant, with the gap/overlap conventions above. */
export function localToUtc(timeZone: string, c: Civil, hour: number, minute: number): number {
  const local = Date.UTC(c.y, c.m - 1, c.d, hour, minute, 0);
  const before = zoneOffsetMs(timeZone, local - DAY_MS), after = zoneOffsetMs(timeZone, local + DAY_MS);
  const valid = [...new Set([before, after])].map((o) => local - o).filter((utc) => zoneOffsetMs(timeZone, utc) === local - utc).sort((a, b) => a - b);
  // overlap (two valid instants): the first one; gap (none): interpret the wall-clock time with the offset that was in force BEFORE the jump
  return valid[0] ?? local - before;
}

export function parseStartTime(s: string): { hour: number; minute: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  if (!m) throw new RangeError(`Invalid start time "${s}": use 24-hour HH:MM`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

/** Throws RangeError for an unknown zone, a malformed time or a non-positive duration: callers that cannot trust the input (stored documents) catch it. */
function weeklyOccurrence(s: Extract<Schedule, { type: 'weekly' }>, day: Civil): Occurrence | null {
  if (!s.weekdays.includes(weekdayOf(day))) return null;
  const { hour, minute } = parseStartTime(s.startTime);
  if (!Number.isFinite(s.durationMinutes) || s.durationMinutes <= 0) throw new RangeError('durationMinutes must be positive');
  const start = localToUtc(s.timezone, day, hour, minute);
  return { startsAt: new Date(start), endsAt: new Date(start + s.durationMinutes * MIN_MS) };
}

/** Every occurrence whose local START DATE lies in [t's local date + from, t's local date + to]. */
function occurrencesAround(s: Schedule, t: Date, from: number, to: number): Occurrence[] {
  if (s.type === 'once') return [{ startsAt: s.startsAt, endsAt: s.endsAt }];
  const base = civilOf(s.timezone, t.getTime());
  const out: Occurrence[] = [];
  for (let k = from; k <= to; k++) { const o = weeklyOccurrence(s, addDays(base, k)); if (o) out.push(o); }
  return out;
}

/** The occurrence that contains `t` (start inclusive, end exclusive); when several overlap, the one that ends last. Null when none, or when `t` is not a valid date. */
export function activeOccurrenceAt(s: Schedule, t: Date): Occurrence | null {
  if (Number.isNaN(t.getTime())) return null;
  // a duration is at most 24 h, so the occurrence containing `t` started on t's local date or one of the two days before
  const hit = occurrencesAround(s, t, s.type === 'once' ? 0 : -2, 0).filter((o) => o.startsAt <= t && t < o.endsAt);
  return hit.sort((a, b) => b.endsAt.getTime() - a.endsAt.getTime())[0] ?? null;
}
export const isActiveAt = (s: Schedule, t: Date): boolean => activeOccurrenceAt(s, t) !== null;

/** The first occurrence that starts strictly after `t`; null when there is none (an ended one-off window, an invalid date). */
export function nextOccurrenceAfter(s: Schedule, t: Date): Occurrence | null {
  if (Number.isNaN(t.getTime())) return null;
  // every listed weekday recurs within 7 days; one extra day on each side absorbs the zone's date skew
  const later = occurrencesAround(s, t, -1, 8).filter((o) => o.startsAt > t);
  return later.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())[0] ?? null;
}

/** Validation for callers outside the zod schema (a stored document, a test): the same rules as the contract. */
export function validateSchedule(s: Schedule): string[] {
  const dto: MaintenanceSchedule = s.type === 'once'
    ? { type: 'once', startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() }
    : { type: 'weekly', timezone: s.timezone, weekdays: s.weekdays, startTime: s.startTime, durationMinutes: s.durationMinutes };
  const out = scheduleIssues(dto);
  if (s.type === 'weekly') {
    try { parseStartTime(s.startTime); } catch (e) { out.push((e as Error).message); }
    if (!Number.isInteger(s.durationMinutes) || s.durationMinutes < MAINTENANCE_LIMITS.minDurationMinutes || s.durationMinutes > MAINTENANCE_LIMITS.maxDurationMinutes) out.push('durationMinutes must be 1 to 1440');
  }
  return out;
}

export const toScheduleDoc = (s: MaintenanceSchedule): Schedule =>
  s.type === 'once' ? { type: 'once', startsAt: new Date(s.startsAt), endsAt: new Date(s.endsAt) } : { ...s };
export const toScheduleDto = (s: Schedule): MaintenanceSchedule =>
  s.type === 'once' ? { type: 'once', startsAt: s.startsAt.toISOString(), endsAt: s.endsAt.toISOString() } : { ...s };

/** Same matcher semantics as a silence: AND across kinds, empty = the whole project. A disabled window never matches. */
export function maintenanceMatches(w: Pick<AlertMaintenanceDoc, 'enabled' | 'schedule' | 'matchers'>, rule: Pick<AlertRuleDoc, '_id' | 'severity' | 'environmentId'>, at: Date): boolean {
  if (!w.enabled) return false;
  const m = w.matchers;
  if (m.ruleIds?.length && !m.ruleIds.includes(rule._id)) return false;
  if (m.severities?.length && !m.severities.includes(rule.severity)) return false;
  if (m.environmentIds?.length && !m.environmentIds.includes(rule.environmentId)) return false;
  try { return isActiveAt(w.schedule, at); } catch { return false; } // a corrupt stored schedule must never break notification planning
}

export type MaintenanceState = MaintenanceDto['state'];
export function maintenanceState(w: Pick<AlertMaintenanceDoc, 'enabled' | 'schedule'>, now: Date): MaintenanceState {
  if (!w.enabled) return 'disabled';
  if (w.schedule.type === 'once') return now < w.schedule.startsAt ? 'scheduled' : now < w.schedule.endsAt ? 'active' : 'expired';
  return isActiveAt(w.schedule, now) ? 'active' : 'scheduled';
}

const iso = (d: Date) => d.toISOString();
const occ = (o: Occurrence | null) => (o ? { startsAt: iso(o.startsAt), endsAt: iso(o.endsAt) } : null);
export function toMaintenanceDto(w: AlertMaintenanceDoc, now: Date): MaintenanceDto {
  let state: MaintenanceState, current: Occurrence | null = null, next: Occurrence | null = null;
  try { state = maintenanceState(w, now); current = activeOccurrenceAt(w.schedule, now); next = nextOccurrenceAfter(w.schedule, now); } catch { state = 'disabled'; }
  return {
    id: w._id, projectId: w.projectId, name: w.name, comment: w.comment, enabled: w.enabled, schedule: toScheduleDto(w.schedule), matchers: w.matchers,
    version: w.version, state, activeNow: state === 'active' && current !== null, currentOccurrence: w.enabled ? occ(current) : null, nextOccurrence: w.enabled ? occ(next) : null,
    createdBy: w.createdBy, createdAt: iso(w.createdAt), updatedAt: iso(w.updatedAt),
  };
}

// ======================================================================= storage and service

export const maintenanceCol = (db: Database) => db.c.alertConfig as unknown as Collection<AlertMaintenanceDoc>;

/** The first enabled window that applies to the rule at ANY of the given instants (send time and, for replayed transitions, event time). */
export async function findSuppressingWindow(
  db: Database, rule: Pick<AlertRuleDoc, '_id' | 'orgId' | 'projectId' | 'severity' | 'environmentId'>, instants: Date[],
): Promise<AlertMaintenanceDoc | null> {
  const windows = await maintenanceCol(db).find({ kind: 'maintenance', orgId: rule.orgId, projectId: rule.projectId, enabled: true }).limit(MAINTENANCE_LIMITS.maxWindowsPerProject * 2).toArray();
  return windows.find((w) => instants.some((at) => maintenanceMatches(w, rule, at))) ?? null;
}

export class MaintenanceService {
  constructor(private readonly db: Database, private readonly audit: AuditSink, private readonly opts: { now?: () => Date } = {}) {}
  private now() { return this.opts.now?.() ?? new Date(); }
  /** Windows are project-wide (like silences and channels): an environment-restricted caller may not manage them. */
  private requireProjectWide(s: ActorScope) { if (s.environmentIds !== null) throw forbiddenScope(); }
  private scoped(s: ActorScope, id: string) { return { kind: 'maintenance' as const, _id: id, orgId: s.orgId, projectId: s.projectId }; }

  private async checkRefs(s: ActorScope, matchers: AlertMaintenanceDoc['matchers']) {
    if (matchers.ruleIds?.length) {
      const n = await ruleCol(this.db).countDocuments({ kind: 'rule', orgId: s.orgId, projectId: s.projectId, _id: { $in: matchers.ruleIds } });
      if (n !== new Set(matchers.ruleIds).size) throw invalid('One or more rules do not exist in this project');
    }
    if (matchers.environmentIds?.length) {
      const n = await this.db.c.environments.countDocuments({ orgId: s.orgId, projectId: s.projectId, _id: { $in: matchers.environmentIds } });
      if (n !== new Set(matchers.environmentIds).size) throw invalid('One or more environments do not exist in this project');
    }
  }
  private checkSchedule(schedule: Schedule, now: Date) {
    const issues = validateSchedule(schedule);
    if (issues.length) throw invalid(issues[0]!, issues);
    if (schedule.type === 'once' && schedule.endsAt <= now) throw invalid('A one-off maintenance window must end in the future');
  }
  private expireAt(schedule: Schedule): { expireAt: Date } | Record<string, never> {
    return schedule.type === 'once' ? { expireAt: new Date(schedule.endsAt.getTime() + DAY_MS) } : {};
  }

  async create(s: ActorScope, input: MaintenanceCreate, ctx: RequestContext): Promise<AlertMaintenanceDoc> {
    this.requireProjectWide(s);
    const now = this.now();
    const schedule = toScheduleDoc(input.schedule);
    this.checkSchedule(schedule, now);
    await this.checkRefs(s, input.matchers);
    const doc: AlertMaintenanceDoc = {
      _id: randomUUID(), kind: 'maintenance', orgId: s.orgId, projectId: s.projectId, name: input.name, nameLower: input.name.toLowerCase(), comment: input.comment,
      enabled: input.enabled, schedule, matchers: input.matchers, version: 1, createdBy: s.userId, createdAt: now, updatedAt: now, ...this.expireAt(schedule),
    };
    try {
      await this.db.transaction(async (session) => {
        // Counted, not a counter: one-off windows are removed by the TTL index, which a counter would never see. (Two concurrent creates at the limit may overshoot by one.)
        const live = await maintenanceCol(this.db).countDocuments({ kind: 'maintenance', orgId: s.orgId, projectId: s.projectId, $or: [{ expireAt: { $exists: false } }, { expireAt: { $gt: now } }] }, { session });
        if (live >= MAINTENANCE_LIMITS.maxWindowsPerProject) throw new AlertingError(422, 'limit_reached', `A project may have at most ${MAINTENANCE_LIMITS.maxWindowsPerProject} maintenance windows`);
        await maintenanceCol(this.db).insertOne(doc, { session });
        await this.audit.record({ orgId: s.orgId, actorUserId: s.userId, action: 'alert.maintenance.created', targetType: 'alert_maintenance', targetId: doc._id, projectId: s.projectId, metadata: { name: doc.name, schedule: toScheduleDto(schedule), matchers: doc.matchers } }, ctx, session);
      });
    } catch (e) {
      if (isDuplicateKey(e)) throw conflict(`A maintenance window named "${input.name}" already exists in this project`);
      throw e;
    }
    return doc;
  }

  async list(s: ActorScope, q: { limit: number; cursor?: string | undefined }) {
    const filter: Record<string, unknown> = { kind: 'maintenance', orgId: s.orgId, projectId: s.projectId };
    const c = decodeCursor(q.cursor);
    if (c) filter.$or = [{ createdAt: { $lt: c[0] } }, { createdAt: c[0], _id: { $lt: c[1] } }];
    const rows = await maintenanceCol(this.db).find(filter as never).sort({ createdAt: -1, _id: -1 }).limit(q.limit + 1).toArray();
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { items: page, nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt.getTime(), last._id) : null };
  }

  async get(s: ActorScope, id: string): Promise<AlertMaintenanceDoc> {
    const w = await maintenanceCol(this.db).findOne(this.scoped(s, id));
    if (!w) throw notFound('Maintenance window');
    return w;
  }

  async update(s: ActorScope, id: string, patch: MaintenanceUpdate, ctx: RequestContext): Promise<AlertMaintenanceDoc> {
    this.requireProjectWide(s);
    const cur = await this.get(s, id);
    const now = this.now();
    const set: Record<string, unknown> = { updatedAt: now };
    const unset: Record<string, ''> = {};
    if (patch.name !== undefined) Object.assign(set, { name: patch.name, nameLower: patch.name.toLowerCase() });
    if (patch.comment !== undefined) set.comment = patch.comment;
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.matchers !== undefined) { await this.checkRefs(s, patch.matchers); set.matchers = patch.matchers; }
    if (patch.schedule !== undefined) {
      const schedule = toScheduleDoc(patch.schedule);
      this.checkSchedule(schedule, now);
      set.schedule = schedule;
      const e = this.expireAt(schedule);
      if ('expireAt' in e) set.expireAt = e.expireAt; else unset.expireAt = '';
    }
    try {
      await this.db.transaction(async (session) => {
        const u = await maintenanceCol(this.db).updateOne({ ...this.scoped(s, id), version: cur.version }, { $set: set, $inc: { version: 1 }, ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { session });
        if (u.matchedCount === 0) throw conflict('The maintenance window was changed by someone else; reload and try again');
        await this.audit.record({ orgId: s.orgId, actorUserId: s.userId, action: 'alert.maintenance.updated', targetType: 'alert_maintenance', targetId: id, projectId: s.projectId, metadata: { name: cur.name, fields: Object.keys(patch) } }, ctx, session);
      });
    } catch (e) {
      if (isDuplicateKey(e)) throw conflict(`A maintenance window named "${patch.name}" already exists in this project`);
      throw e;
    }
    return this.get(s, id);
  }

  async remove(s: ActorScope, id: string, ctx: RequestContext): Promise<void> {
    this.requireProjectWide(s);
    const cur = await this.get(s, id);
    await this.db.transaction(async (session) => {
      const d = await maintenanceCol(this.db).deleteOne(this.scoped(s, id), { session });
      if (d.deletedCount === 0) throw notFound('Maintenance window');
      await this.audit.record({ orgId: s.orgId, actorUserId: s.userId, action: 'alert.maintenance.deleted', targetType: 'alert_maintenance', targetId: id, projectId: s.projectId, metadata: { name: cur.name } }, ctx, session);
    });
  }
}
