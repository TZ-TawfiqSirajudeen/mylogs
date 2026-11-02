import { randomUUID } from 'node:crypto';
import { ALERT_LIMITS, type IncidentDto, type IncidentEventType } from '@nexus/contracts';
import type { AlertDeliveryDoc, AlertRuleDoc, AuditSink, Database, IncidentDoc, IncidentEventDoc } from '@nexus/database';
import {
  type ActorScope, AlertingError, conflict, DAY_MS, decodeCursor, encodeCursor, envFilter, isDuplicateKey, notFound, type RequestContext, RETENTION,
} from './common.js';
import { Notifier, type DeliveryEvent } from './notifier.js';
import { describeOp, formatDuration } from './state.js';

const SYSTEM_CTX: RequestContext = { requestId: 'alert-engine' };
const fmt = (n: number | null) => (n === null ? 'no data' : Number.isInteger(n) ? String(n) : String(Math.round(n * 1e4) / 1e4));

export const incidentTitle = (ruleName: string, labels: Record<string, string>) => {
  const l = Object.entries(labels).map(([k, v]) => `${k}=${v}`).join(', ');
  return l ? `${ruleName} (${l})` : ruleName;
};

type RuleForIncident = Pick<AlertRuleDoc, '_id' | 'orgId' | 'projectId' | 'environmentId' | 'name' | 'severity' | 'condition' | 'windowSeconds' | 'channelIds'>;

export interface IncidentListQuery {
  limit: number; cursor?: string | undefined; environmentId?: string | undefined; ruleId?: string | undefined;
  status?: 'open' | 'acknowledged' | 'resolved' | 'active' | undefined; severity?: IncidentDoc['severity'] | undefined;
}

export class IncidentService {
  constructor(private readonly db: Database, private readonly audit: AuditSink, private readonly notifier: Notifier, private readonly opts: { maxTimeline?: number; now?: () => Date } = {}) {}
  private now() { return this.opts.now?.() ?? new Date(); }

  private get maxTimeline() { return this.opts.maxTimeline ?? ALERT_LIMITS.maxTimelineEvents; }
  private pushEvents(events: IncidentEventDoc[]) {
    return { $push: { timeline: { $each: events, $slice: -this.maxTimeline } }, $inc: { eventCount: events.length } };
  }
  private event(type: IncidentEventType, at: Date, message: string, actorUserId: string | null = null, data: IncidentEventDoc['data'] = {}): IncidentEventDoc {
    return { id: randomUUID(), type, at, actorUserId, message, data };
  }

  // ---------------------------------------------------------------- engine side

  /**
   * Opens the incident for (rule, group), or returns the one that is already live. Deduplication is enforced by the database (unique partial
   * index on rule + group where `active`), so two workers racing on the same rule can never create two live incidents.
   */
  async open(rule: RuleForIncident, group: { key: string; labels: Record<string, string> }, value: number | null, now: Date): Promise<{ incident: IncidentDoc; created: boolean }> {
    const incident: IncidentDoc = {
      _id: randomUUID(), orgId: rule.orgId, projectId: rule.projectId, environmentId: rule.environmentId, ruleId: rule._id, ruleName: rule.name, severity: rule.severity,
      title: incidentTitle(rule.name, group.labels), groupKey: group.key, groupLabels: group.labels,
      status: 'open', active: true, openedAt: now, acknowledgedAt: null, acknowledgedBy: null, resolvedAt: null, resolvedBy: null, lastValue: value,
      condition: { op: rule.condition.op, threshold: rule.condition.threshold, windowSeconds: rule.windowSeconds },
      timeline: [], commentCount: 0, eventCount: 0, expireAt: null,
    };
    const opened = this.event('opened', now, value === null
      ? `Opened: no data for ${formatDuration(rule.windowSeconds)} (the rule treats missing data as a breach)`
      : `Opened: value ${fmt(value)} is ${describeOp(rule.condition.op)} ${fmt(rule.condition.threshold)} over ${formatDuration(rule.windowSeconds)}`, null, { value });
    try {
      const plan = await this.notifier.plan(rule, incident, 'incident.opened', now);
      incident.timeline = [opened, ...plan.events];
      incident.eventCount = incident.timeline.length;
      await this.db.transaction(async (session) => {
        await this.db.c.incidents.insertOne(incident, { session });
        if (plan.deliveries.length) await this.db.c.alertDeliveries.insertMany(plan.deliveries, { session });
        await this.audit.record({ orgId: rule.orgId, actorUserId: null, action: 'incident.opened', targetType: 'incident', targetId: incident._id, projectId: rule.projectId, environmentId: rule.environmentId, metadata: { ruleId: rule._id, ruleName: rule.name, severity: rule.severity, group: group.labels } }, SYSTEM_CTX, session);
      });
      return { incident, created: true };
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
      const existing = await this.db.c.incidents.findOne({ orgId: rule.orgId, projectId: rule.projectId, ruleId: rule._id, groupKey: group.key, active: true });
      if (!existing) throw e;
      return { incident: existing, created: false };
    }
  }

  /** Closes a live incident automatically (recovery, or its rule was disabled/changed/deleted). Idempotent: returns null when nothing was live. */
  async autoResolve(ruleRef: { orgId: string; projectId: string; ruleId: string; groupKey: string }, reason: string, now: Date, value: number | null = null): Promise<IncidentDoc | null> {
    const message = reason === 'recovered'
      ? `Resolved automatically: the condition stayed clear${value === null ? '' : ` (value ${fmt(value)})`}`
      : `Resolved automatically: ${reason.replace(/_/g, ' ')}`;
    return this.close({ orgId: ruleRef.orgId, projectId: ruleRef.projectId, ruleId: ruleRef.ruleId, groupKey: ruleRef.groupKey }, { kind: 'auto', userId: null, reason }, 'auto_resolved', message, now, null, SYSTEM_CTX, value);
  }

  async autoResolveAllForRule(orgId: string, projectId: string, ruleId: string, reason: string, now: Date): Promise<number> {
    const live = await this.db.c.incidents.find({ orgId, projectId, ruleId, active: true }, { projection: { groupKey: 1 } }).limit(500).toArray();
    let n = 0;
    for (const i of live) if (await this.autoResolve({ orgId, projectId, ruleId, groupKey: i.groupKey }, reason, now)) n++;
    return n;
  }

  /** The ids of incidents that are live for a rule (used by the engine to notice a manual resolution). */
  async liveGroupKeys(orgId: string, projectId: string, ruleId: string): Promise<Set<string>> {
    const live = await this.db.c.incidents.find({ orgId, projectId, ruleId, active: true }, { projection: { groupKey: 1 } }).limit(1000).toArray();
    return new Set(live.map((i) => i.groupKey));
  }

  /** Records the latest observed value on a live incident (cheap, best-effort). */
  async touchValue(orgId: string, projectId: string, ruleId: string, groupKey: string, value: number): Promise<void> {
    await this.db.c.incidents.updateOne({ orgId, projectId, ruleId, groupKey, active: true }, { $set: { lastValue: value } });
  }

  private async close(
    filter: Record<string, unknown>, resolvedBy: NonNullable<IncidentDoc['resolvedBy']>, type: 'resolved' | 'auto_resolved', message: string,
    now: Date, actor: string | null, ctx: RequestContext, value: number | null,
  ): Promise<IncidentDoc | null> {
    return this.db.transaction(async (session) => {
      const closed = await this.db.c.incidents.findOneAndUpdate(
        { ...filter, active: true } as never,
        { $set: { status: 'resolved', active: false, resolvedAt: now, resolvedBy, expireAt: new Date(now.getTime() + RETENTION.incidentDays * DAY_MS), ...(value !== null ? { lastValue: value } : {}) } },
        { returnDocument: 'after', session },
      );
      if (!closed) return null;
      const plan = await this.notifier.plan({ _id: closed.ruleId, orgId: closed.orgId, projectId: closed.projectId, environmentId: closed.environmentId, severity: closed.severity, channelIds: [] }, closed, 'incident.resolved', now);
      const events = [this.event(type, now, message, actor, { reason: resolvedBy.reason }), ...plan.events];
      await this.db.c.incidents.updateOne({ _id: closed._id }, this.pushEvents(events), { session });
      if (plan.deliveries.length) await this.db.c.alertDeliveries.insertMany(plan.deliveries as AlertDeliveryDoc[], { session });
      await this.audit.record({
        orgId: closed.orgId, actorUserId: actor, action: type === 'resolved' ? 'incident.resolved' : 'incident.auto_resolved', targetType: 'incident', targetId: closed._id,
        projectId: closed.projectId, environmentId: closed.environmentId, metadata: { ruleId: closed.ruleId, reason: resolvedBy.reason },
      }, ctx, session);
      return { ...closed, timeline: [...closed.timeline, ...events] };
    });
  }

  // ---------------------------------------------------------------- user actions (always scoped: tenant, project and environment)

  private scoped(s: ActorScope, id: string) {
    return { _id: id, orgId: s.orgId, projectId: s.projectId, ...envFilter(s) };
  }
  private async mustFind(s: ActorScope, id: string): Promise<IncidentDoc> {
    const doc = await this.db.c.incidents.findOne(this.scoped(s, id) as never, { projection: { timeline: 0 } });
    if (!doc) throw notFound('Incident');
    return doc as IncidentDoc;
  }

  async acknowledge(s: ActorScope, id: string, note: string | undefined, ctx: RequestContext): Promise<IncidentDoc> {
    const now = this.now();
    const matched = await this.db.transaction(async (session) => {
      const r = await this.db.c.incidents.findOneAndUpdate(
        { ...this.scoped(s, id), status: 'open' } as never,
        { $set: { status: 'acknowledged', acknowledgedAt: now, acknowledgedBy: s.userId }, ...this.pushEvents([this.event('acknowledged', now, note ? `Acknowledged: ${note}` : 'Acknowledged', s.userId)]) },
        { session, projection: { ruleId: 1, environmentId: 1 } },
      );
      if (!r) return false;
      await this.audit.record({ orgId: s.orgId, actorUserId: s.userId, action: 'incident.acknowledged', targetType: 'incident', targetId: id, projectId: s.projectId, environmentId: r.environmentId, metadata: { ruleId: r.ruleId } }, ctx, session);
      return true;
    });
    const doc = await this.mustFind(s, id);
    if (!matched) throw conflict(doc.status === 'resolved' ? 'The incident is already resolved' : 'The incident is already acknowledged');
    return doc;
  }

  async resolve(s: ActorScope, id: string, note: string | undefined, ctx: RequestContext): Promise<IncidentDoc> {
    await this.mustFind(s, id);
    const now = this.now();
    const closed = await this.close(this.scoped(s, id), { kind: 'user', userId: s.userId, reason: null }, 'resolved', note ? `Resolved: ${note}` : 'Resolved', now, s.userId, ctx, null);
    if (!closed) throw conflict('The incident is already resolved');
    return closed;
  }

  async comment(s: ActorScope, id: string, body: string, ctx: RequestContext): Promise<IncidentDoc> {
    await this.mustFind(s, id);
    const now = this.now();
    const r = await this.db.transaction(async (session) => {
      const u = await this.db.c.incidents.updateOne(
        { ...this.scoped(s, id), commentCount: { $lt: ALERT_LIMITS.maxCommentsPerIncident } } as never,
        { ...this.pushEvents([this.event('comment', now, body, s.userId)]), $inc: { eventCount: 1, commentCount: 1 } } as never,
        { session },
      );
      if (u.matchedCount === 1) await this.audit.record({ orgId: s.orgId, actorUserId: s.userId, action: 'incident.commented', targetType: 'incident', targetId: id, projectId: s.projectId, metadata: { length: body.length } }, ctx, session);
      return u.matchedCount;
    });
    if (r === 0) throw new AlertingError(422, 'comment_limit', `An incident may hold at most ${ALERT_LIMITS.maxCommentsPerIncident} comments`);
    return this.mustFind(s, id);
  }

  // ---------------------------------------------------------------- reads

  async list(s: ActorScope, q: IncidentListQuery): Promise<{ items: IncidentDoc[]; nextCursor: string | null }> {
    const filter: Record<string, unknown> = { orgId: s.orgId, projectId: s.projectId };
    if (q.environmentId) {
      // An environment outside the caller's scope yields an empty page, exactly like an environment that has no incidents.
      if (s.environmentIds !== null && !s.environmentIds.includes(q.environmentId)) return { items: [], nextCursor: null };
      filter.environmentId = q.environmentId;
    } else Object.assign(filter, envFilter(s));
    if (q.ruleId) filter.ruleId = q.ruleId;
    if (q.severity) filter.severity = q.severity;
    if (q.status === 'active') filter.active = true; else if (q.status) filter.status = q.status;
    const c = decodeCursor(q.cursor);
    if (c) filter.$or = [{ openedAt: { $lt: c[0] } }, { openedAt: c[0], _id: { $lt: c[1] } }];
    const rows = await this.db.c.incidents.find(filter as never, { projection: { timeline: 0 } }).sort({ openedAt: -1, _id: -1 }).limit(q.limit + 1).maxTimeMS(5_000).toArray();
    const page = rows.slice(0, q.limit) as IncidentDoc[];
    const last = page[page.length - 1];
    return { items: page, nextCursor: rows.length > q.limit && last ? encodeCursor(last.openedAt.getTime(), last._id) : null };
  }

  async get(s: ActorScope, id: string): Promise<{ incident: IncidentDoc; actors: Map<string, string> }> {
    const incident = await this.db.c.incidents.findOne(this.scoped(s, id) as never);
    if (!incident) throw notFound('Incident');
    const ids = [...new Set(incident.timeline.map((e) => e.actorUserId).filter((x): x is string => !!x))];
    const users = ids.length ? await this.db.c.users.find({ _id: { $in: ids } }, { projection: { displayName: 1 } }).toArray() : [];
    return { incident, actors: new Map(users.map((u) => [u._id, u.displayName])) };
  }

  async deliveries(s: ActorScope, incidentId: string): Promise<AlertDeliveryDoc[]> {
    await this.mustFind(s, incidentId);
    return this.db.c.alertDeliveries.find({ orgId: s.orgId, projectId: s.projectId, incidentId }).sort({ createdAt: 1, _id: 1 }).limit(ALERT_LIMITS.listLimit).toArray();
  }
}

export function toIncidentDto(i: IncidentDoc): IncidentDto {
  return {
    id: i._id, projectId: i.projectId, environmentId: i.environmentId, ruleId: i.ruleId, ruleName: i.ruleName, severity: i.severity, title: i.title,
    groupKey: i.groupKey, groupLabels: i.groupLabels, status: i.status, openedAt: i.openedAt.toISOString(),
    acknowledgedAt: i.acknowledgedAt?.toISOString() ?? null, acknowledgedBy: i.acknowledgedBy, resolvedAt: i.resolvedAt?.toISOString() ?? null,
    resolvedBy: i.resolvedBy, lastValue: i.lastValue, condition: i.condition, eventCount: i.eventCount,
  };
}
export const toEventDto = (e: IncidentEventDoc, actors: Map<string, string>) => ({
  id: e.id, type: e.type, at: e.at.toISOString(), actorUserId: e.actorUserId, actorName: e.actorUserId ? actors.get(e.actorUserId) ?? null : null, message: e.message, data: e.data,
});
export type { DeliveryEvent };
