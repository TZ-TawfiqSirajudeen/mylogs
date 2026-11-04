import { randomUUID } from 'node:crypto';
import {
  ALERT_LIMITS, EMAIL_LIMITS, isValidEmailAddress, maskEmail, normalizeRecipients, type ChannelCreate, type ChannelDto, type ChannelUpdate, type SmtpSecurity,
} from '@nexus/contracts';
import type { AlertChannelDoc, AlertDeliveryDoc, AuditSink, Database } from '@nexus/database';
import { SecretStore } from '@nexus/secrets';
import type { NetworkPolicy } from '@nexus/security';
import {
  AlertingError, channelCol, channelSecretOwner, conflict, DAY_MS, decodeCursor, encodeCursor, forbiddenScope, invalid, isDuplicateKey, notFound, RETENTION,
  type ActorScope, type RequestContext, ruleCol,
} from './common.js';
import { releaseSlot, takeSlot } from './config.js';
import type { DeliveryProcessor } from './delivery.js';
import { checkSmtpTarget } from './smtp.js';
import { checkWebhookTarget, displayUrl, WebhookUrlError } from './webhook.js';

const iso = (d: Date) => d.toISOString();
const channelsKey = (s: { orgId: string; projectId: string }) => `alerting:channels:${s.orgId}:${s.projectId}`;

/** Secret names inside a channel's secret namespace (`alert-channel:<id>`): webhook = url + signing; slack = url; email = smtp-user + smtp-pass. */
export const CHANNEL_SECRETS = { url: 'url', signing: 'signing', smtpUser: 'smtp-user', smtpPass: 'smtp-pass' } as const;

export function toChannelDto(c: AlertChannelDoc): ChannelDto {
  const e = c.type === 'email' ? c.email ?? null : null;
  return {
    id: c._id, projectId: c.projectId, type: c.type, name: c.name, enabled: c.enabled, urlDisplay: c.urlDisplay, hasSigningSecret: c.type === 'webhook', rateLimitPerMinute: c.rateLimitPerMinute,
    ...(e ? { smtp: { host: e.host, port: e.port, security: e.security }, hasSmtpCredentials: e.hasCredentials, from: e.from, recipientsMasked: e.recipients.map(maskEmail) } : {}),
    lastTest: c.lastTest ? { at: iso(c.lastTest.at), ok: c.lastTest.ok, message: c.lastTest.message } : null, createdBy: c.createdBy, createdAt: iso(c.createdAt), updatedAt: iso(c.updatedAt),
  };
}

type Common = { name: string; enabled: boolean; rateLimitPerMinute: number };
/** What `create` accepts. The legacy webhook shape (no `type`) stays valid. */
export type ChannelCreateInput =
  | (Omit<Extract<ChannelCreate, { type: 'webhook' }>, 'type'> & { type?: 'webhook' })
  | Extract<ChannelCreate, { type: 'slack' }>
  | Extract<ChannelCreate, { type: 'email' }>;
export type ChannelUpdateInput = ChannelUpdate;

const WEBHOOK_FIELDS = ['name', 'enabled', 'rateLimitPerMinute', 'url', 'signingSecret'];
const SLACK_FIELDS = ['name', 'enabled', 'rateLimitPerMinute', 'url'];
const EMAIL_FIELDS = ['name', 'enabled', 'rateLimitPerMinute', 'smtp', 'from', 'recipients', 'clearSmtpCredentials'];

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
  private async checkSmtp(host: string, port: number, security: SmtpSecurity) {
    if (security === 'none' && !this.policy.allowInsecureHttp) throw invalid('Unencrypted SMTP is only permitted in development; use STARTTLS (587) or TLS (465)');
    try { await checkSmtpTarget(host, port, this.policy); } catch (e) {
      if (e instanceof WebhookUrlError) throw invalid(e.message);
      throw e;
    }
  }
  /** The service re-validates what the contract already validated: a direct caller cannot bring in a header-injecting or oversized recipient list. */
  private cleanAddresses(from: string, recipients: string[]) {
    const list = normalizeRecipients(recipients);
    if (list.length === 0) throw invalid('At least one recipient is required');
    if (list.length > EMAIL_LIMITS.maxRecipients) throw invalid(`At most ${EMAIL_LIMITS.maxRecipients} recipients are allowed`);
    if (!list.every(isValidEmailAddress)) throw invalid('A recipient is not a valid plain e-mail address');
    const f = from.trim().toLowerCase();
    if (!isValidEmailAddress(f)) throw invalid('The from-address is not a valid plain e-mail address');
    return { from: f, recipients: list };
  }

  async create(s: ActorScope, input: ChannelCreateInput, ctx: RequestContext): Promise<AlertChannelDoc> {
    this.requireProjectWide(s);
    const type = input.type ?? 'webhook';
    const now = this.now();
    const base = {
      _id: randomUUID(), kind: 'channel' as const, orgId: s.orgId, projectId: s.projectId, type, name: input.name, nameLower: input.name.toLowerCase(), enabled: input.enabled,
      rateLimitPerMinute: input.rateLimitPerMinute, lastTest: null, createdBy: s.userId, createdAt: now, updatedAt: now,
    };
    let doc: AlertChannelDoc;
    const secrets: { name: string; value: string }[] = [];
    if (type === 'email') {
      const e = input as Extract<ChannelCreate, { type: 'email' }>;
      const { from, recipients } = this.cleanAddresses(e.from, e.recipients);
      const host = e.smtp.host.trim().toLowerCase();
      await this.checkSmtp(host, e.smtp.port, e.smtp.security);
      const hasCredentials = e.smtp.username !== undefined && e.smtp.password !== undefined;
      if (hasCredentials) secrets.push({ name: CHANNEL_SECRETS.smtpUser, value: e.smtp.username! }, { name: CHANNEL_SECRETS.smtpPass, value: e.smtp.password! });
      doc = { ...base, urlDisplay: `smtp://${host}:${e.smtp.port}`, email: { host, port: e.smtp.port, security: e.smtp.security, from, recipients, hasCredentials } };
    } else {
      const url = await this.checkUrl((input as { url: string }).url);
      secrets.push({ name: CHANNEL_SECRETS.url, value: (input as { url: string }).url });
      if (type === 'webhook') secrets.push({ name: CHANNEL_SECRETS.signing, value: (input as { signingSecret: string }).signingSecret });
      doc = { ...base, urlDisplay: displayUrl(url) };
    }
    try {
      await this.db.transaction(async (session) => {
        await takeSlot(this.db, channelsKey(s), ALERT_LIMITS.maxChannelsPerProject, 'notification channels', session);
        await channelCol(this.db).insertOne(doc, { session });
        const owner = channelSecretOwner(doc._id);
        for (const sec of secrets) await this.secrets.put({ orgId: s.orgId, connectionId: owner, name: sec.name }, sec.value, s.userId, session);
        // Display target only: never the Slack/webhook URL path, SMTP credentials or recipient addresses.
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

  async update(s: ActorScope, id: string, patch: ChannelUpdateInput, ctx: RequestContext): Promise<AlertChannelDoc> {
    this.requireProjectWide(s);
    const cur = await this.get(s, id);
    const allowed = cur.type === 'email' ? EMAIL_FIELDS : cur.type === 'slack' ? SLACK_FIELDS : WEBHOOK_FIELDS;
    const foreign = Object.keys(patch).filter((k) => !allowed.includes(k));
    if (foreign.length > 0) throw invalid(`${foreign.join(', ')} ${foreign.length === 1 ? 'does' : 'do'} not apply to ${cur.type} channels`);

    const set: Record<string, unknown> = { updatedAt: this.now() };
    const putSecrets: { name: string; value: string }[] = [];
    const dropSecrets: string[] = [];
    const common = patch as Partial<Common>;
    if (common.name !== undefined) Object.assign(set, { name: common.name, nameLower: common.name.toLowerCase() });
    if (common.enabled !== undefined) set.enabled = common.enabled;
    if (common.rateLimitPerMinute !== undefined) set.rateLimitPerMinute = common.rateLimitPerMinute;
    const fields = Object.keys(patch).flatMap((k) => (k === 'smtp' && patch.smtp ? Object.keys(patch.smtp).map((f) => `smtp.${f}`) : [k]));

    if (cur.type === 'webhook' || cur.type === 'slack') {
      if (patch.url !== undefined) { set.urlDisplay = displayUrl(await this.checkUrl(patch.url)); set.lastTest = null; putSecrets.push({ name: CHANNEL_SECRETS.url, value: patch.url }); }
      if (patch.signingSecret !== undefined) putSecrets.push({ name: CHANNEL_SECRETS.signing, value: patch.signingSecret });
    } else {
      const e = cur.email!;
      const next = { ...e };
      const sm = patch.smtp;
      if (sm?.host !== undefined) next.host = sm.host.trim().toLowerCase();
      if (sm?.port !== undefined) next.port = sm.port;
      if (sm?.security !== undefined) next.security = sm.security;
      if (patch.from !== undefined || patch.recipients !== undefined) {
        const a = this.cleanAddresses(patch.from ?? e.from, patch.recipients ?? e.recipients);
        next.from = a.from; next.recipients = a.recipients;
      }
      if (sm?.username !== undefined && sm.password !== undefined) {
        putSecrets.push({ name: CHANNEL_SECRETS.smtpUser, value: sm.username }, { name: CHANNEL_SECRETS.smtpPass, value: sm.password });
        next.hasCredentials = true;
      }
      if (patch.clearSmtpCredentials) {
        if (sm?.username !== undefined) throw invalid('Cannot set and clear SMTP credentials in one request');
        dropSecrets.push(CHANNEL_SECRETS.smtpUser, CHANNEL_SECRETS.smtpPass); next.hasCredentials = false;
      }
      if (next.host !== e.host || next.port !== e.port || next.security !== e.security || sm?.username !== undefined) {
        await this.checkSmtp(next.host, next.port, next.security);
        set.lastTest = null;
      }
      set.email = next; set.urlDisplay = `smtp://${next.host}:${next.port}`;
    }
    try {
      await this.db.transaction(async (session) => {
        await channelCol(this.db).updateOne(this.scoped(s, id), { $set: set }, { session });
        const owner = channelSecretOwner(id);
        for (const sec of putSecrets) await this.secrets.put({ orgId: s.orgId, connectionId: owner, name: sec.name }, sec.value, s.userId, session);
        for (const name of dropSecrets) await this.secrets.delete({ orgId: s.orgId, connectionId: owner, name }, session);
        // Field NAMES only: values (and certainly secrets or recipient addresses) never reach the audit trail.
        await this.audit.record({ orgId: s.orgId, actorUserId: s.userId, action: 'alert.channel.updated', targetType: 'alert_channel', targetId: id, projectId: s.projectId, metadata: { fields } }, ctx, session);
      });
    } catch (e) {
      if (isDuplicateKey(e)) throw conflict(`A channel named "${common.name}" already exists in this project`);
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

  /** Sends one test notification right now (no retries) through the channel's real transport and records it in the delivery log. Limited to a few per minute per channel. */
  async test(s: ActorScope, id: string, ctx: RequestContext): Promise<{ ok: boolean; status: number | null; message: string; delivery: AlertDeliveryDoc }> {
    this.requireProjectWide(s);
    const ch = await this.get(s, id);
    const now = this.now();
    const recent = await this.db.c.alertDeliveries.countDocuments({ orgId: s.orgId, projectId: s.projectId, channelId: id, event: 'test', createdAt: { $gte: new Date(now.getTime() - 60_000) } });
    if (recent >= 5) throw new AlertingError(429, 'rate_limited', 'At most 5 test notifications per minute per channel');
    const d: AlertDeliveryDoc = {
      _id: randomUUID(), orgId: s.orgId, projectId: s.projectId, incidentId: null, channelId: id, channelName: ch.name, event: 'test', status: 'pending', attempts: 0, nextAttemptAt: null,
      lease: null, lastError: null, httpStatus: null, silenceId: null, maintenanceId: null,
      payload: { event: 'test', occurredAt: now.toISOString(), message: 'This is a test notification from Nexus Observability.', channel: ch.name },
      createdAt: now, deliveredAt: null, expireAt: new Date(now.getTime() + RETENTION.deliveryDays * DAY_MS),
    };
    await this.db.c.alertDeliveries.insertOne(d);
    const done = await this.delivery.attempt(d, 1);
    const ok = done.status === 'delivered';
    const message = ok ? (done.httpStatus === null ? 'Delivered (accepted by the SMTP server)' : `Delivered (HTTP ${done.httpStatus})`) : done.lastError?.message ?? 'Failed';
    await channelCol(this.db).updateOne(this.scoped(s, id), { $set: { lastTest: { at: now, ok, message } } });
    await this.audit.record({ orgId: s.orgId, actorUserId: s.userId, action: 'alert.channel.tested', targetType: 'alert_channel', targetId: id, projectId: s.projectId, metadata: { ok } }, ctx);
    return { ok, status: done.httpStatus, message, delivery: done };
  }
}
