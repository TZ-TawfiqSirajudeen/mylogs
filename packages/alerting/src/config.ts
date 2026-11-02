import { randomUUID } from 'node:crypto';
import {
  ALERT_LIMITS, validateRuleFields, type AlertRuleCreate, type AlertRuleDto, type AlertRuleUpdate, type ChannelDto, type DeliveryDto, type RuleQuery, type SilenceDto,
} from '@nexus/contracts';
import type { AlertChannelDoc, AlertDeliveryDoc, AlertRuleDoc, AlertSilenceDoc, AuditSink, ClientSession, Database } from '@nexus/database';
import { SecretStore } from '@nexus/secrets';
import type { NetworkPolicy } from '@nexus/security';
import { DAY_MS, RETENTION, type ActorScope, AlertingError, channelCol, channelSecretOwner, conflict, decodeCursor, encodeCursor, envFilter, forbiddenScope, invalid, isDuplicateKey, notFound, type RequestContext, ruleCol, silenceCol } from './common.js';
import type { DeliveryProcessor } from './delivery.js';
import type { IncidentService } from './incidents.js';
import { checkWebhookTarget, displayUrl, WebhookUrlError } from './webhook.js';

const iso = (d: Date) => d.toISOString();

/** Atomically takes one slot of a per-project quota inside the caller's transaction (aborts, rolling everything back, when the quota is used up). */
async function takeSlot(db: Database, key: string, max: number, what: string, session: ClientSession) {
  const c = await db.c.counters.findOneAndUpdate({ _id: key }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after', session });
  if (c!.value > max) throw new AlertingError(422, 'limit_reached', `A project may have at most ${max} ${what}`);
}
const releaseSlot = (db: Database, key: string, session: ClientSession) => db.c.counters.updateOne({ _id: key }, { $inc: { value: -1 } }, { session });
const rulesKey = (s: { orgId: string; projectId: string }) => `alerting:rules:${s.orgId}:${s.projectId}`;
const channelsKey = (s: { orgId: string; projectId: string }) => `alerting:channels:${s.orgId}:${s.projectId}`;

// ======================================================================= rules

export function toRuleDto(r: AlertRuleDoc): AlertRuleDto {
  const live = r.groups.filter((g) => g.status === 'firing').length > 0 ? 'firing' : r.groups.some((g) => g.status === 'pending') ? 'pending' : null;
  return {
    id: r._id, projectId: r.projectId, name: r.name, description: r.description, severity: r.severity, environmentId: r.environmentId, enabled: r.enabled,
    query: r.query as unknown as RuleQuery, condition: r.condition, windowSeconds: r.windowSeconds, forSeconds: r.forSeconds, resolveAfterSeconds: r.resolveAfterSeconds,
    noDataPolicy: r.noDataPolicy, intervalSeconds: r.intervalSeconds, channelIds: r.channelIds, version: r.version,
    health: r.health, status: live ?? (r.lastEvaluatedAt ? 'ok' : 'unknown'), lastEvaluatedAt: r.lastEvaluatedAt ? iso(r.lastEvaluatedAt) : null,
    nextEvalAt: r.nextEvalAt ? iso(r.nextEvalAt) : null, lastError: r.lastError ? { at: iso(r.lastError.at), message: r.lastError.message } : null,
    lastValue: r.lastValue, noDataSince: r.noDataSince ? iso(r.noDataSince) : null,
    groups: r.groups.map((g) => ({ key: g.key, labels: g.labels, status: g.status, since: iso(g.since), lastValue: g.lastValue, incidentId: g.incidentId })),
    truncatedGroups: r.truncatedGroups, createdBy: r.createdBy, createdAt: iso(r.createdAt), updatedAt: iso(r.updatedAt),
  };
}

/** Key-order independent comparison of JSON-like values. */
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

const SEMANTIC_FIELDS = ['query', 'condition', 'windowSeconds', 'forSeconds', 'resolveAfterSeconds', 'noDataPolicy', 'intervalSeconds'] as const;

export class RuleService {
  constructor(private readonly db: Database, private readonly audit: AuditSink, private readonly incidents: IncidentService, private readonly opts: { now?: () => Date } = {}) {}
  private now() { return this.opts.now?.() ?? new Date(); }

  private async mustEnvironment(s: ActorScope, environmentId: string) {
    const allowed = s.environmentIds === null || s.environmentIds.includes(environmentId);
    const env = allowed ? await this.db.c.environments.findOne({ _id: environmentId, orgId: s.orgId, projectId: s.projectId }) : null;
    if (!env) throw notFound('Environment');
    return env;
  }
  private async mustChannels(s: ActorScope, ids: string[]) {
    if (!ids.length) return;
    const n = await channelCol(this.db).countDocuments({ kind: 'channel', orgId: s.orgId, projectId: s.projectId, _id: { $in: ids } });
    if (n !== new Set(ids).size) throw invalid('One or more notification channels do not exist in this project');
  }
  private scoped(s: ActorScope, ruleId: string) { return { kind: 'rule' as const, _id: ruleId, orgId: s.orgId, projectId: s.projectId, ...envFilter(s) }; }

  async create(s: ActorScope, input: AlertRuleCreate, ctx: RequestContext): Promise<AlertRuleDoc> {
    const env = await this.mustEnvironment(s, input.environmentId);
    await this.mustChannels(s, input.channelIds);
    const now = this.now();
    const doc: AlertRuleDoc = {
      _id: randomUUID(), kind: 'rule', orgId: s.orgId, projectId: s.projectId, environmentId: env._id,
      name: input.name, nameLower: input.name.toLowerCase(), description: input.description, severity: input.severity, enabled: input.enabled,
      query: input.query as AlertRuleDoc['query'], condition: input.condition, windowSeconds: input.windowSeconds, forSeconds: input.forSeconds,
      resolveAfterSeconds: input.resolveAfterSeconds, noDataPolicy: input.noDataPolicy, intervalSeconds: input.intervalSeconds, channelIds: input.channelIds,
      version: 1, createdBy: s.userId, createdAt: now, updatedAt: now, nextEvalAt: input.enabled ? now : null, lease: null,
      lastEvaluatedAt: null, health: 'unknown', lastError: null, lastValue: null, noDataSince: null, groups: [], truncatedGroups: false,
    };
    try {
      await this.db.transaction(async (session) => {
        await takeSlot(this.db, rulesKey(s), ALERT_LIMITS.maxRulesPerProject, 'alert rules', session);
        await ruleCol(this.db).insertOne(doc, { session });
        await this.audit.record({ orgId: s.orgId, actorUserId: s.userId, action: 'alert.rule.created', targetType: 'alert_rule', targetId: doc._id, projectId: s.projectId, environmentId: doc.environmentId, metadata: { name: doc.name, severity: doc.severity, kind: doc.query.kind } }, ctx, session);
      });
    } catch (e) {
      if (isDuplicateKey(e)) throw conflict(`A rule named "${input.name}" already exists in this project`);
      throw e;
    }
    return doc;
  }

  async get(s: ActorScope, ruleId: string): Promise<AlertRuleDoc> {
    const r = await ruleCol(this.db).findOne(this.scoped(s, ruleId));
    if (!r) throw notFound('Alert rule');
    return r;
  }

  async list(s: ActorScope, q: { limit: number; cursor?: string | undefined; environmentId?: string | undefined; enabled?: boolean | undefined }) {
    const filter: Record<string, unknown> = { kind: 'rule', orgId: s.orgId, projectId: s.projectId };
    if (q.environmentId) {
      if (s.environmentIds !== null && !s.environmentIds.includes(q.environmentId)) return { items: [] as AlertRuleDoc[], nextCursor: null };
      filter.environmentId = q.environmentId;
    } else Object.assign(filter, envFilter(s));
    if (q.enabled !== undefined) filter.enabled = q.enabled;
    const c = decodeCursor(q.cursor);
    if (c) filter.$or = [{ createdAt: { $lt: c[0] } }, { createdAt: c[0], _id: { $lt: c[1] } }];
    const rows = await ruleCol(this.db).find(filter as never).sort({ createdAt: -1, _id: -1 }).limit(q.limit + 1).maxTimeMS(5_000).toArray();
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { items: page, nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt.getTime(), last._id) : null };
  }

  async update(s: ActorScope, ruleId: string, patch: AlertRuleUpdate, ctx: RequestContext): Promise<AlertRuleDoc> {
    const cur = await this.get(s, ruleId);
    if (patch.environmentId !== undefined && patch.environmentId !== cur.environmentId) throw invalid('A rule cannot be moved to another environment; create a new rule instead');
    const merged = {
      query: (patch.query ?? cur.query) as unknown as RuleQuery, condition: patch.condition ?? cur.condition, windowSeconds: patch.windowSeconds ?? cur.windowSeconds,
      intervalSeconds: patch.intervalSeconds ?? cur.intervalSeconds, channelIds: patch.channelIds ?? cur.channelIds,
    };
    const issues = validateRuleFields(merged);
    if (issues.length) throw invalid(issues[0]!, issues);
    if (patch.channelIds) await this.mustChannels(s, patch.channelIds);

    const set: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) if (v !== undefined && k !== 'environmentId') set[k] = v;
    if (patch.name !== undefined) set.nameLower = patch.name.toLowerCase();
    const now = this.now();
    const semantic = SEMANTIC_FIELDS.some((f) => patch[f] !== undefined && canon(patch[f]) !== canon(cur[f]));
    const enabled = patch.enabled ?? cur.enabled;
    const toggled = patch.enabled !== undefined && patch.enabled !== cur.enabled;
    // A change of what is measured resets the evaluation state: the old state described a different question.
    const reset = semantic || toggled;
    if (reset) Object.assign(set, { groups: [], truncatedGroups: false, lastError: null, health: 'unknown', lastValue: null, noDataSince: null, lastEvaluatedAt: null, nextEvalAt: enabled ? now : null });
    set.updatedAt = now;
    try {
      const r = await this.db.transaction(async (session) => {
        const u = await ruleCol(this.db).updateOne({ ...this.scoped(s, ruleId), version: cur.version }, { $set: set, $inc: { version: 1 } }, { session });
        if (u.matchedCount === 0) throw conflict('The rule was changed by someone else; reload and try again');
        await this.audit.record({ orgId: s.orgId, actorUserId: s.userId, action: 'alert.rule.updated', targetType: 'alert_rule', targetId: ruleId, projectId: s.projectId, environmentId: cur.environmentId, metadata: { name: cur.name, fields: Object.keys(patch) } }, ctx, session);
        return u;
      });
      void r;
    } catch (e) {
      if (isDuplicateKey(e)) throw conflict(`A rule named "${patch.name}" already exists in this project`);
      throw e;
    }
    if (reset) await this.incidents.autoResolveAllForRule(s.orgId, s.projectId, ruleId, toggled && !enabled ? 'rule_disabled' : 'rule_changed', now);
    return this.get(s, ruleId);
  }

  async remove(s: ActorScope, ruleId: string, ctx: RequestContext): Promise<void> {
    const cur = await this.get(s, ruleId);
    await this.db.transaction(async (session) => {
      const d = await ruleCol(this.db).deleteOne(this.scoped(s, ruleId), { session });
      if (d.deletedCount === 0) throw notFound('Alert rule');
      await releaseSlot(this.db, rulesKey(s), session);
      await this.audit.record({ orgId: s.orgId, actorUserId: s.userId, action: 'alert.rule.deleted', targetType: 'alert_rule', targetId: ruleId, projectId: s.projectId, environmentId: cur.environmentId, metadata: { name: cur.name } }, ctx, session);
    });
    // The history stays (retention applies); live incidents are closed so nothing is left open for a rule that no longer exists.
    await this.incidents.autoResolveAllForRule(s.orgId, s.projectId, ruleId, 'rule_deleted', this.now());
  }
}

// ======================================================================= channels

export function toChannelDto(c: AlertChannelDoc): ChannelDto {
  return {
    id: c._id, projectId: c.projectId, type: c.type, name: c.name, enabled: c.enabled, urlDisplay: c.urlDisplay, hasSigningSecret: true, rateLimitPerMinute: c.rateLimitPerMinute,
    lastTest: c.lastTest ? { at: iso(c.lastTest.at), ok: c.lastTest.ok, message: c.lastTest.message } : null, createdBy: c.createdBy, createdAt: iso(c.createdAt), updatedAt: iso(c.updatedAt),
  };
}
export const toDeliveryDto = (d: AlertDeliveryDoc): DeliveryDto => ({
  id: d._id, incidentId: d.incidentId, channelId: d.channelId, channelName: d.channelName, event: d.event, status: d.status, attempts: d.attempts,
  createdAt: iso(d.createdAt), deliveredAt: d.deliveredAt ? iso(d.deliveredAt) : null, nextAttemptAt: d.nextAttemptAt ? iso(d.nextAttemptAt) : null,
  lastError: d.lastError, httpStatus: d.httpStatus, silenceId: d.silenceId,
});

export class ChannelService {
  constructor(
    private readonly db: Database, private readonly audit: AuditSink, private readonly secrets: SecretStore, private readonly policy: NetworkPolicy,
    private readonly delivery: DeliveryProcessor, private readonly opts: { now?: () => Date } = {},
  ) {}
  private now() { return this.opts.now?.() ?? new Date(); }
  /** Channels are project-level: an environment-restricted caller may not manage (or learn the configuration of) them. */
  private requireProjectWide(s: ActorScope) { if (s.environmentIds !== null) throw forbiddenScope(); }
  private scoped(s: ActorScope, id: string) { return { kind: 'channel' as const, _id: id, orgId: s.orgId, projectId: s.projectId }; }

  private async checkUrl(url: string) {
    try { return (await checkWebhookTarget(url, this.policy)).url; } catch (e) {
      if (e instanceof WebhookUrlError) throw invalid(e.message);
      throw e;
    }
  }

  async create(s: ActorScope, input: { name: string; url: string; signingSecret: string; enabled: boolean; rateLimitPerMinute: number }, ctx: RequestContext): Promise<AlertChannelDoc> {
    this.requireProjectWide(s);
    const url = await this.checkUrl(input.url);
    const now = this.now();
    const doc: AlertChannelDoc = {
      _id: randomUUID(), kind: 'channel', orgId: s.orgId, projectId: s.projectId, type: 'webhook', name: input.name, nameLower: input.name.toLowerCase(), enabled: input.enabled,
      urlDisplay: displayUrl(url), rateLimitPerMinute: input.rateLimitPerMinute, lastTest: null, createdBy: s.userId, createdAt: now, updatedAt: now,
    };
    try {
      await this.db.transaction(async (session) => {
        await takeSlot(this.db, channelsKey(s), ALERT_LIMITS.maxChannelsPerProject, 'notification channels', session);
        await channelCol(this.db).insertOne(doc, { session });
        const owner = channelSecretOwner(doc._id);
        await this.secrets.put({ orgId: s.orgId, connectionId: owner, name: 'url' }, input.url, s.userId, session);
        await this.secrets.put({ orgId: s.orgId, connectionId: owner, name: 'signing' }, input.signingSecret, s.userId, session);
        await this.audit.record({ orgId: s.orgId, actorUserId: s.userId, action: 'alert.channel.created', targetType: 'alert_channel', targetId: doc._id, projectId: s.projectId, metadata: { name: doc.name, type: doc.type, target: doc.urlDisplay } }, ctx, session);
      });
    } catch (e) {
      if (isDuplicateKey(e)) throw conflict(`A channel named "${input.name}" already exists in this project`);
      throw e;
    }
    return doc;
  }

  async list(s: ActorScope, q: { limit: number; cursor?: string | undefined }) {
    const filter: Record<string, unknown> = { kind: 'channel', orgId: s.orgId, projectId: s.projectId };
    const c = decodeCursor(q.cursor);
    if (c) filter.$or = [{ createdAt: { $lt: c[0] } }, { createdAt: c[0], _id: { $lt: c[1] } }];
    const rows = await channelCol(this.db).find(filter as never).sort({ createdAt: -1, _id: -1 }).limit(q.limit + 1).toArray();
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { items: page, nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt.getTime(), last._id) : null };
  }

  async get(s: ActorScope, id: string): Promise<AlertChannelDoc> {
    const c = await channelCol(this.db).findOne(this.scoped(s, id));
    if (!c) throw notFound('Notification channel');
    return c;
  }

  async update(s: ActorScope, id: string, patch: { name?: string; url?: string; signingSecret?: string; enabled?: boolean; rateLimitPerMinute?: number }, ctx: RequestContext): Promise<AlertChannelDoc> {
    this.requireProjectWide(s);
    await this.get(s, id);
    const set: Record<string, unknown> = { updatedAt: this.now() };
    if (patch.name !== undefined) Object.assign(set, { name: patch.name, nameLower: patch.name.toLowerCase() });
    if (patch.enabled !== undefined) set.enabled = patch.enabled;
    if (patch.rateLimitPerMinute !== undefined) set.rateLimitPerMinute = patch.rateLimitPerMinute;
    if (patch.url !== undefined) { set.urlDisplay = displayUrl(await this.checkUrl(patch.url)); set.lastTest = null; }
    try {
      await this.db.transaction(async (session) => {
        await channelCol(this.db).updateOne(this.scoped(s, id), { $set: set }, { session });
        const owner = channelSecretOwner(id);
        if (patch.url !== undefined) await this.secrets.put({ orgId: s.orgId, connectionId: owner, name: 'url' }, patch.url, s.userId, session);
        if (patch.signingSecret !== undefined) await this.secrets.put({ orgId: s.orgId, connectionId: owner, name: 'signing' }, patch.signingSecret, s.userId, session);
        // Field NAMES only: values (and certainly secrets) never reach the audit trail.
        await this.audit.record({ orgId: s.orgId, actorUserId: s.userId, action: 'alert.channel.updated', targetType: 'alert_channel', targetId: id, projectId: s.projectId, metadata: { fields: Object.keys(patch) } }, ctx, session);
      });
    } catch (e) {
      if (isDuplicateKey(e)) throw conflict(`A channel named "${patch.name}" already exists in this project`);
      throw e;
    }
    return this.get(s, id);
  }

  async remove(s: ActorScope, id: string, ctx: RequestContext): Promise<void> {
    this.requireProjectWide(s);
    const cur = await this.get(s, id);
    await this.db.transaction(async (session) => {
      await channelCol(this.db).deleteOne(this.scoped(s, id), { session });
      await this.secrets.deleteAllForConnection(s.orgId, channelSecretOwner(id), session);
      await ruleCol(this.db).updateMany({ kind: 'rule', orgId: s.orgId, projectId: s.projectId, channelIds: id }, { $pull: { channelIds: id } }, { session });
      await releaseSlot(this.db, channelsKey(s), session);
      await this.audit.record({ orgId: s.orgId, actorUserId: s.userId, action: 'alert.channel.deleted', targetType: 'alert_channel', targetId: id, projectId: s.projectId, metadata: { name: cur.name } }, ctx, session);
    });
  }

  /** Sends one signed test notification right now (no retries) and records it in the delivery log. Limited to a few per minute per channel. */
  async test(s: ActorScope, id: string, ctx: RequestContext): Promise<{ ok: boolean; status: number | null; message: string; delivery: AlertDeliveryDoc }> {
    this.requireProjectWide(s);
    const ch = await this.get(s, id);
    const now = this.now();
    const recent = await this.db.c.alertDeliveries.countDocuments({ orgId: s.orgId, projectId: s.projectId, channelId: id, event: 'test', createdAt: { $gte: new Date(now.getTime() - 60_000) } });
    if (recent >= 5) throw new AlertingError(429, 'rate_limited', 'At most 5 test notifications per minute per channel');
    const d: AlertDeliveryDoc = {
      _id: randomUUID(), orgId: s.orgId, projectId: s.projectId, incidentId: null, channelId: id, channelName: ch.name, event: 'test', status: 'pending', attempts: 0, nextAttemptAt: null,
      lease: null, lastError: null, httpStatus: null, silenceId: null,
      payload: { event: 'test', occurredAt: now.toISOString(), message: 'This is a test notification from Nexus Observability.', channel: ch.name },
      createdAt: now, deliveredAt: null, expireAt: new Date(now.getTime() + RETENTION.deliveryDays * DAY_MS),
    };
    await this.db.c.alertDeliveries.insertOne(d);
    const done = await this.delivery.attempt(d, 1);
    const ok = done.status === 'delivered';
    const message = ok ? `Delivered (HTTP ${done.httpStatus})` : done.lastError?.message ?? 'Failed';
    await channelCol(this.db).updateOne(this.scoped(s, id), { $set: { lastTest: { at: now, ok, message } } });
    await this.audit.record({ orgId: s.orgId, actorUserId: s.userId, action: 'alert.channel.tested', targetType: 'alert_channel', targetId: id, projectId: s.projectId, metadata: { ok } }, ctx);
    return { ok, status: done.httpStatus, message, delivery: done };
  }
}

// ======================================================================= silences

export const silenceState = (s: AlertSilenceDoc, now: Date): SilenceDto['state'] => (now < s.startsAt ? 'scheduled' : now < s.endsAt ? 'active' : 'expired');
export const toSilenceDto = (s: AlertSilenceDoc, now: Date): SilenceDto => ({
  id: s._id, projectId: s.projectId, comment: s.comment, startsAt: iso(s.startsAt), endsAt: iso(s.endsAt), matchers: s.matchers, state: silenceState(s, now), createdBy: s.createdBy, createdAt: iso(s.createdAt),
});

export class SilenceService {
  constructor(private readonly db: Database, private readonly audit: AuditSink, private readonly opts: { now?: () => Date } = {}) {}
  private now() { return this.opts.now?.() ?? new Date(); }
  private requireProjectWide(s: ActorScope) { if (s.environmentIds !== null) throw forbiddenScope(); }

  async create(s: ActorScope, input: { comment: string; startsAt: string; endsAt: string; matchers: AlertSilenceDoc['matchers'] }, ctx: RequestContext): Promise<AlertSilenceDoc> {
    this.requireProjectWide(s);
    const now = this.now();
    const startsAt = new Date(input.startsAt), endsAt = new Date(input.endsAt);
    if (endsAt <= now) throw invalid('The silence must end in the future');
    if (input.matchers.ruleIds?.length) {
      const n = await ruleCol(this.db).countDocuments({ kind: 'rule', orgId: s.orgId, projectId: s.projectId, _id: { $in: input.matchers.ruleIds } });
      if (n !== new Set(input.matchers.ruleIds).size) throw invalid('One or more rules do not exist in this project');
    }
    if (input.matchers.environmentIds?.length) {
      const n = await this.db.c.environments.countDocuments({ orgId: s.orgId, projectId: s.projectId, _id: { $in: input.matchers.environmentIds } });
      if (n !== new Set(input.matchers.environmentIds).size) throw invalid('One or more environments do not exist in this project');
    }
    const active = await silenceCol(this.db).countDocuments({ kind: 'silence', orgId: s.orgId, projectId: s.projectId, endsAt: { $gt: now } });
    if (active >= ALERT_LIMITS.maxActiveSilencesPerProject) throw new AlertingError(422, 'limit_reached', `A project may have at most ${ALERT_LIMITS.maxActiveSilencesPerProject} active or scheduled silences`);
    const doc: AlertSilenceDoc = {
      _id: randomUUID(), kind: 'silence', orgId: s.orgId, projectId: s.projectId, comment: input.comment, startsAt, endsAt, matchers: input.matchers,
      createdBy: s.userId, createdAt: now, expireAt: new Date(endsAt.getTime() + RETENTION.silenceGraceDays * DAY_MS),
    };
    await this.db.transaction(async (session) => {
      await silenceCol(this.db).insertOne(doc, { session });
      await this.audit.record({ orgId: s.orgId, actorUserId: s.userId, action: 'alert.silence.created', targetType: 'alert_silence', targetId: doc._id, projectId: s.projectId, metadata: { startsAt: input.startsAt, endsAt: input.endsAt, matchers: input.matchers } }, ctx, session);
    });
    return doc;
  }

  async list(s: ActorScope, q: { limit: number; cursor?: string | undefined }) {
    const filter: Record<string, unknown> = { kind: 'silence', orgId: s.orgId, projectId: s.projectId };
    const c = decodeCursor(q.cursor);
    if (c) filter.$or = [{ createdAt: { $lt: c[0] } }, { createdAt: c[0], _id: { $lt: c[1] } }];
    const rows = await silenceCol(this.db).find(filter as never).sort({ createdAt: -1, _id: -1 }).limit(q.limit + 1).toArray();
    const page = rows.slice(0, q.limit);
    const last = page[page.length - 1];
    return { items: page, nextCursor: rows.length > q.limit && last ? encodeCursor(last.createdAt.getTime(), last._id) : null };
  }

  /** Removes a silence (an active one stops suppressing immediately). */
  async remove(s: ActorScope, id: string, ctx: RequestContext): Promise<void> {
    this.requireProjectWide(s);
    await this.db.transaction(async (session) => {
      const d = await silenceCol(this.db).deleteOne({ kind: 'silence', _id: id, orgId: s.orgId, projectId: s.projectId }, { session });
      if (d.deletedCount === 0) throw notFound('Silence');
      await this.audit.record({ orgId: s.orgId, actorUserId: s.userId, action: 'alert.silence.deleted', targetType: 'alert_silence', targetId: id, projectId: s.projectId, metadata: {} }, ctx, session);
    });
  }
}
