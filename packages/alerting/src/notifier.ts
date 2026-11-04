import { randomUUID } from 'node:crypto';
import type { AlertDeliveryDoc, AlertRuleDoc, AlertSilenceDoc, Database, IncidentDoc, IncidentEventDoc } from '@nexus/database';
import { channelCol, DAY_MS, RETENTION, silenceCol } from './common.js';
import { findSuppressingWindow } from './maintenance.js';
import { describeOp, formatDuration } from './state.js';

export type DeliveryEvent = AlertDeliveryDoc['event'];

/** Does a silence apply to this rule right now? Every given matcher must match (AND); an empty matcher set silences the whole project. */
export function silenceMatches(s: AlertSilenceDoc, rule: Pick<AlertRuleDoc, '_id' | 'severity' | 'environmentId'>, now: Date): boolean {
  if (!(s.startsAt <= now && now < s.endsAt)) return false;
  const m = s.matchers;
  if (m.ruleIds?.length && !m.ruleIds.includes(rule._id)) return false;
  if (m.severities?.length && !m.severities.includes(rule.severity)) return false;
  if (m.environmentIds?.length && !m.environmentIds.includes(rule.environmentId)) return false;
  return true;
}

/** The body a receiver gets. Bounded and free of secrets: it is stored with the delivery and signed on the wire. */
export function buildPayload(event: DeliveryEvent, incident: IncidentDoc, link: string | null): Record<string, unknown> {
  return {
    event,
    occurredAt: (event === 'incident.resolved' ? incident.resolvedAt ?? incident.openedAt : incident.openedAt).toISOString(),
    incident: {
      id: incident._id, title: incident.title, severity: incident.severity, status: incident.status,
      ruleId: incident.ruleId, ruleName: incident.ruleName, projectId: incident.projectId, environmentId: incident.environmentId,
      group: incident.groupLabels, value: incident.lastValue,
      condition: `${describeOp(incident.condition.op)} ${incident.condition.threshold} over ${formatDuration(incident.condition.windowSeconds)}`,
      openedAt: incident.openedAt.toISOString(), resolvedAt: incident.resolvedAt?.toISOString() ?? null,
      resolvedBy: incident.resolvedBy ? incident.resolvedBy.kind : null,
      ...(link ? { url: link } : {}),
    },
  };
}

export interface PlannedNotifications { deliveries: AlertDeliveryDoc[]; events: IncidentEventDoc[] }

/**
 * Extra facts about a notification that is created for a REPLAYED evaluation (ADR-0010). `now` stays the processing time (it stamps the delivery rows and drives
 * the rate limit); `eventAt` is when the transition happened. A replayed transition older than `staleAfterSeconds` is recorded as `stale` and never sent.
 */
export interface PlanContext { eventAt?: Date; replayed?: boolean; staleAfterSeconds?: number }

/**
 * Decides, for one incident event, what each channel will do: send, be suppressed by a silence, or be dropped by the channel's rate limit.
 * Suppressed and rate-limited notifications are RECORDED (a delivery row and an incident timeline event) so nothing disappears silently, but
 * nothing is sent. Silences never prevent the incident itself from being recorded.
 */
export class Notifier {
  constructor(private readonly db: Database, private readonly opts: { publicUrl?: string | null } = {}) {}

  async plan(
    rule: Pick<AlertRuleDoc, '_id' | 'orgId' | 'projectId' | 'environmentId' | 'severity' | 'channelIds'>,
    incident: IncidentDoc, event: DeliveryEvent, now: Date, plan: PlanContext = {},
  ): Promise<PlannedNotifications> {
    let channelIds = rule.channelIds;
    if (event === 'incident.resolved') {
      // Only whoever was told about the opening hears about the recovery.
      const sent = await this.db.c.alertDeliveries.find({ orgId: incident.orgId, projectId: incident.projectId, incidentId: incident._id, event: 'incident.opened', status: { $in: ['pending', 'delivered'] } }, { projection: { channelId: 1 } }).toArray();
      channelIds = [...new Set(sent.map((d) => d.channelId))];
    }
    if (channelIds.length === 0) return { deliveries: [], events: [] };

    const channels = await channelCol(this.db).find({ kind: 'channel', orgId: incident.orgId, projectId: incident.projectId, _id: { $in: channelIds }, enabled: true }).toArray();
    if (channels.length === 0) return { deliveries: [], events: [] };
    const silences = await silenceCol(this.db).find({ kind: 'silence', orgId: incident.orgId, projectId: incident.projectId, startsAt: { $lte: now }, endsAt: { $gt: now } }).limit(100).toArray();
    const silence = silences.find((s) => silenceMatches(s, rule, now)) ?? null;
    const eventAt = plan.eventAt ?? now;
    const ageMs = now.getTime() - eventAt.getTime();
    const stale = plan.replayed === true && ageMs > (plan.staleAfterSeconds ?? 900) * 1000;
    // A maintenance window counts when it was active when the notification is created OR when the transition happened (ADR-0010 #6).
    const window = silence || stale ? null : await findSuppressingWindow(this.db, rule, eventAt.getTime() === now.getTime() ? [now] : [now, eventAt]);
    const link = this.opts.publicUrl ? `${this.opts.publicUrl.replace(/\/$/, '')}/incidents/${incident._id}?p=${incident.projectId}` : null;
    const payload = buildPayload(event, incident, link);
    const since = new Date(now.getTime() - 60_000);

    const deliveries: AlertDeliveryDoc[] = [];
    const events: IncidentEventDoc[] = [];
    for (const ch of channels) {
      const base: AlertDeliveryDoc = {
        _id: randomUUID(), orgId: incident.orgId, projectId: incident.projectId, incidentId: incident._id, channelId: ch._id, channelName: ch.name,
        event, status: 'pending', attempts: 0, nextAttemptAt: now, lease: null, lastError: null, httpStatus: null, silenceId: null, maintenanceId: null, payload,
        createdAt: now, deliveredAt: null, expireAt: new Date(now.getTime() + RETENTION.deliveryDays * DAY_MS),
      };
      if (stale) {
        const minutes = Math.max(1, Math.round(ageMs / 60_000));
        deliveries.push({ ...base, status: 'stale', nextAttemptAt: null, lastError: { code: 'stale', message: `Replayed transition is ${minutes} min old (limit ${Math.round((plan.staleAfterSeconds ?? 900) / 60)} min)` } });
        events.push({ id: randomUUID(), type: 'notification_suppressed', at: now, actorUserId: null, message: `Notification to "${ch.name}" not sent: stale (the transition was replayed ${minutes} min after it happened)`, data: { channelId: ch._id, reason: 'stale', event, eventAt: eventAt.toISOString() } });
        continue;
      }
      if (silence) {
        deliveries.push({ ...base, status: 'suppressed', nextAttemptAt: null, silenceId: silence._id });
        events.push({ id: randomUUID(), type: 'notification_suppressed', at: now, actorUserId: null, message: `Notification to "${ch.name}" suppressed by a silence: ${silence.comment}`, data: { channelId: ch._id, reason: 'silence', silenceId: silence._id, event } });
        continue;
      }
      if (window) {
        deliveries.push({ ...base, status: 'suppressed', nextAttemptAt: null, maintenanceId: window._id });
        events.push({ id: randomUUID(), type: 'notification_suppressed', at: now, actorUserId: null, message: `Notification to "${ch.name}" suppressed by maintenance window "${window.name}"`, data: { channelId: ch._id, reason: 'maintenance', maintenanceId: window._id, event } });
        continue;
      }
      const recent = await this.db.c.alertDeliveries.countDocuments({ orgId: incident.orgId, projectId: incident.projectId, channelId: ch._id, createdAt: { $gte: since }, status: { $in: ['pending', 'delivered', 'failed'] } });
      if (recent >= ch.rateLimitPerMinute) {
        deliveries.push({ ...base, status: 'rate_limited', nextAttemptAt: null, lastError: { code: 'rate_limited', message: `The channel's limit of ${ch.rateLimitPerMinute} notifications per minute was reached` } });
        events.push({ id: randomUUID(), type: 'notification_suppressed', at: now, actorUserId: null, message: `Notification to "${ch.name}" not sent: channel rate limit (${ch.rateLimitPerMinute}/minute) reached`, data: { channelId: ch._id, reason: 'rate_limited', event } });
        continue;
      }
      deliveries.push(base);
    }
    return { deliveries, events };
  }
}
