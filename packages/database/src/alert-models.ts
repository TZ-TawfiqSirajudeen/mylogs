/**
 * Alerting and incident documents (ADR-0006). Three collections hold everything:
 *   alert_config      rules, notification channels and silences, told apart by `kind` (small, project-scoped configuration documents)
 *   incidents         one document per incident, the timeline is embedded and bounded
 *   alert_deliveries  the notification queue AND the delivery log (TTL)
 * Rule queries are stored in the shape of @nexus/contracts (`RuleQuery`); this package does not depend on contracts, so they are typed loosely here
 * and re-typed by @nexus/alerting.
 */
export type AlertSeverityName = 'info' | 'warning' | 'critical';
export type AlertComparison = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne';

export interface AlertGroupState {
  /** Stable identifier of the group (label values), '' for an ungrouped rule. */
  key: string;
  labels: Record<string, string>;
  /** `ok` groups are not stored (absence = ok). `resolved` is kept until pruned so the UI can show the last recovery. */
  status: 'pending' | 'firing' | 'resolved';
  /** When the group entered this status. */
  since: Date;
  lastValue: number | null;
  lastEvalAt: Date;
  /** While firing: when the condition last became clear (resolve hysteresis). */
  okSince: Date | null;
  incidentId: string | null;
  /** When the group last had no data (null = it had data at the last evaluation). */
  noDataSince: Date | null;
}

export interface AlertRuleDoc {
  _id: string; kind: 'rule'; orgId: string; projectId: string; environmentId: string;
  name: string; nameLower: string; description: string; severity: AlertSeverityName; enabled: boolean;
  query: Record<string, unknown> & { kind: 'metric' | 'logs' };
  condition: { op: AlertComparison; threshold: number };
  windowSeconds: number; forSeconds: number; resolveAfterSeconds: number;
  noDataPolicy: 'ok' | 'alert' | 'keep'; intervalSeconds: number; channelIds: string[];
  /** Bumped on every edit: an evaluation that started before an edit never writes its (stale) result. */
  version: number;
  createdBy: string; createdAt: Date; updatedAt: Date;
  /** Null when disabled. */
  nextEvalAt: Date | null;
  lease: { owner: string; until: Date } | null;
  lastEvaluatedAt: Date | null;
  health: 'unknown' | 'ok' | 'error';
  lastError: { at: Date; message: string } | null;
  lastValue: number | null;
  noDataSince: Date | null;
  groups: AlertGroupState[];
  truncatedGroups: boolean;
}

export interface AlertChannelDoc {
  _id: string; kind: 'channel'; orgId: string; projectId: string;
  type: 'webhook'; name: string; nameLower: string; enabled: boolean;
  /** scheme://host[:port] only. The full URL and the signing secret are in `secrets` (envelope-encrypted), never here. */
  urlDisplay: string;
  rateLimitPerMinute: number;
  lastTest: { at: Date; ok: boolean; message: string } | null;
  createdBy: string; createdAt: Date; updatedAt: Date;
}

export interface AlertSilenceDoc {
  _id: string; kind: 'silence'; orgId: string; projectId: string;
  comment: string; startsAt: Date; endsAt: Date;
  matchers: { ruleIds?: string[]; severities?: AlertSeverityName[]; environmentIds?: string[] };
  createdBy: string; createdAt: Date;
  /** Silences are removed shortly after they end. */
  expireAt: Date;
}

export type AlertConfigDoc = AlertRuleDoc | AlertChannelDoc | AlertSilenceDoc;

export type IncidentEventKind =
  | 'opened' | 'notified' | 'notification_failed' | 'notification_suppressed' | 'acknowledged' | 'resolved' | 'auto_resolved' | 'comment';
export interface IncidentEventDoc {
  id: string; type: IncidentEventKind; at: Date; actorUserId: string | null; message: string;
  data: Record<string, string | number | boolean | null>;
}

export interface IncidentDoc {
  _id: string; orgId: string; projectId: string; environmentId: string;
  ruleId: string; ruleName: string; severity: AlertSeverityName;
  title: string; groupKey: string; groupLabels: Record<string, string>;
  status: 'open' | 'acknowledged' | 'resolved';
  /** True while the incident is not resolved. A unique partial index on (rule, group) WHERE active guarantees one live incident per rule+group. */
  active: boolean;
  openedAt: Date; acknowledgedAt: Date | null; acknowledgedBy: string | null;
  resolvedAt: Date | null; resolvedBy: { kind: 'user' | 'auto'; userId: string | null; reason: string | null } | null;
  lastValue: number | null;
  condition: { op: AlertComparison; threshold: number; windowSeconds: number };
  timeline: IncidentEventDoc[];
  /** Number of comments ever added (bounded) and of events ever appended (the timeline itself keeps only the newest ones). */
  commentCount: number;
  eventCount: number;
  /** Set on resolution: resolved incidents are deleted after the retention period. */
  expireAt: Date | null;
}

export interface AlertDeliveryDoc {
  _id: string; orgId: string; projectId: string; incidentId: string | null; channelId: string; channelName: string;
  event: 'incident.opened' | 'incident.resolved' | 'test';
  status: 'pending' | 'delivered' | 'failed' | 'suppressed' | 'rate_limited';
  attempts: number; nextAttemptAt: Date | null;
  lease: { owner: string; until: Date } | null;
  lastError: { code: string; message: string } | null; httpStatus: number | null;
  silenceId: string | null;
  /** The notification body as of enqueue time (bounded, contains no secrets). */
  payload: Record<string, unknown>;
  createdAt: Date; deliveredAt: Date | null; expireAt: Date;
}
