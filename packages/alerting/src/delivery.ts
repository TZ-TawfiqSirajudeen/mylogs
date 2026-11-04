import { randomUUID } from 'node:crypto';
import type { AlertDeliveryDoc, Database, IncidentEventDoc } from '@nexus/database';
import { SecretStore } from '@nexus/secrets';
import type { NetworkPolicy } from '@nexus/security';
import { ALERT_LIMITS } from '@nexus/contracts';
import { channelCol, channelSecretOwner } from './common.js';
import { buildEmailMessage, EmailFormatError } from './email.js';
import { sendSmtp, type EmailSender } from './smtp.js';
import { slackBody } from './slack.js';
import { fail, sendSlack, sendWebhook, type SlackSender, type WebhookResult, type WebhookSender } from './webhook.js';

export interface DeliveryOptions {
  owner: string;
  policy: NetworkPolicy;
  now?: () => Date;
  /** Total attempts (first try included) before a delivery is marked failed. */
  maxAttempts?: number;
  /** Delay before attempt number `attempt + 1` (attempt = attempts already made, >= 1). Exponential with jitter by default. */
  backoffMs?: (attempt: number) => number;
  sender?: WebhookSender;
  /** Transports of the other channel types (ADR-0008); injectable for tests. */
  slackSender?: SlackSender;
  emailSender?: EmailSender;
  concurrency?: number;
  batch?: number;
  leaseMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
}

export const DEFAULT_MAX_ATTEMPTS = 5;
/** 30 s, 2 min, 10 min, 30 min (plus up to 20% jitter, so a recovering receiver is not hit by every retry at once). */
export const defaultBackoffMs = (attempt: number, random: () => number = Math.random): number => {
  const base = [30_000, 120_000, 600_000, 1_800_000][Math.min(attempt, 4) - 1] ?? 1_800_000;
  return Math.round(base * (1 + 0.2 * random()));
};

export interface DeliveryMetrics { attempted: number; delivered: number; retried: number; failed: number; }

/**
 * Sends queued notifications. The queue is the `alert_deliveries` collection itself: a delivery is leased (atomic claim), sent, and then
 * marked delivered, rescheduled with backoff, or failed for good. A crashed worker's lease expires and another worker retries; the receiver can
 * de-duplicate on the `x-nexus-delivery` header (a delivery is at-least-once).
 */
export class DeliveryProcessor {
  readonly metrics: DeliveryMetrics = { attempted: 0, delivered: 0, retried: 0, failed: 0 };
  private readonly secrets: SecretStore;
  private readonly now: () => Date;
  private readonly send: WebhookSender;
  private readonly sendSlackMessage: SlackSender;
  private readonly sendEmail: EmailSender;
  private readonly maxAttempts: number;

  constructor(private readonly db: Database, secrets: SecretStore, private readonly o: DeliveryOptions) {
    this.secrets = secrets;
    this.now = o.now ?? (() => new Date());
    this.send = o.sender ?? sendWebhook;
    this.sendSlackMessage = o.slackSender ?? sendSlack;
    this.sendEmail = o.emailSender ?? sendSmtp;
    this.maxAttempts = o.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  private claim(now: Date): Promise<AlertDeliveryDoc | null> {
    const leaseMs = this.o.leaseMs ?? 30_000;
    return this.db.c.alertDeliveries.findOneAndUpdate(
      { status: 'pending', nextAttemptAt: { $lte: now }, $or: [{ lease: null }, { 'lease.until': { $lt: now } }] },
      { $set: { lease: { owner: this.o.owner, until: new Date(now.getTime() + leaseMs) } } },
      { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
    );
  }

  /** Processes due deliveries (bounded per tick). Resolves when everything it started has finished. */
  async tick(): Promise<number> {
    const limit = this.o.batch ?? 20;
    let remaining = limit, done = 0;
    const lane = async () => {
      while (remaining > 0) {
        remaining--;
        const d = await this.claim(this.now());
        if (!d) return;
        done++;
        await this.attempt(d, this.maxAttempts).catch((e) => this.o.log?.('error', 'delivery crashed', { delivery: d._id, error: e instanceof Error ? e.message : String(e) }));
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.o.concurrency ?? 4, limit) }, lane));
    return done;
  }

  /** Performs one attempt for a delivery this caller owns, and records the outcome. `maxAttempts = 1` (test sends) never schedules a retry. */
  async attempt(d: AlertDeliveryDoc, maxAttempts: number): Promise<AlertDeliveryDoc> {
    const now = this.now();
    this.metrics.attempted++;
    const attempts = d.attempts + 1;
    let result: WebhookResult;
    try {
      const channel = await channelCol(this.db).findOne({ kind: 'channel', _id: d.channelId, orgId: d.orgId, projectId: d.projectId });
      if (!channel || (!channel.enabled && d.event !== 'test')) {
        result = { ok: false, httpStatus: null, code: 'invalid_url', message: 'The channel no longer exists or is disabled', retryable: false };
      } else {
        const owner = channelSecretOwner(channel._id);
        const get = (name: string) => this.secrets.get({ orgId: d.orgId, connectionId: owner, name });
        const opts = { policy: this.o.policy };
        if (channel.type === 'slack') {
          const url = await get('url');
          result = await this.sendSlackMessage({ url, event: d.event, deliveryId: d._id, body: slackBody(d.payload), now }, opts);
        } else if (channel.type === 'email') {
          const e = channel.email;
          if (!e) {
            result = fail('invalid_address', 'The e-mail channel has no SMTP settings', false);
          } else {
            const [username, password] = e.hasCredentials ? await Promise.all([get('smtp-user'), get('smtp-pass')]) : [undefined, undefined];
            try {
              const { raw } = buildEmailMessage({ from: e.from, to: e.recipients, deliveryId: d._id, event: d.event, now }, d.payload);
              result = await this.sendEmail({ host: e.host, port: e.port, security: e.security, username, password, from: e.from, to: e.recipients, message: raw }, opts);
            } catch (err) {
              if (!(err instanceof EmailFormatError)) throw err;
              result = fail('invalid_address', err.message, false);
            }
          }
        } else {
          const [url, secret] = await Promise.all([get('url'), get('signing')]);
          const body = JSON.stringify({ ...d.payload, deliveryId: d._id, attempt: attempts });
          result = await this.send({ url, secret, event: d.event, deliveryId: d._id, body, now }, opts);
        }
      }
    } catch {
      // Decryption or storage problems: never surface details (they could name keys); the operator sees the worker log.
      result = { ok: false, httpStatus: null, code: 'connection_failed', message: 'The channel configuration could not be loaded', retryable: true };
    }

    let patch: Partial<AlertDeliveryDoc>;
    let timeline: IncidentEventDoc | null = null;
    if (result.ok) {
      this.metrics.delivered++;
      patch = { status: 'delivered', attempts, deliveredAt: now, nextAttemptAt: null, lease: null, lastError: null, httpStatus: result.httpStatus };
      timeline = { id: randomUUID(), type: 'notified', at: now, actorUserId: null, message: `Notified "${d.channelName}" (${d.event === 'incident.opened' ? 'opened' : d.event === 'test' ? 'test' : 'resolved'}, ${result.httpStatus === null ? 'accepted' : `HTTP ${result.httpStatus}`})`, data: { channelId: d.channelId, deliveryId: d._id, event: d.event, attempts } };
    } else if (result.retryable && attempts < maxAttempts) {
      this.metrics.retried++;
      const delay = (this.o.backoffMs ?? defaultBackoffMs)(attempts);
      patch = { status: 'pending', attempts, nextAttemptAt: new Date(now.getTime() + delay), lease: null, lastError: { code: result.code ?? 'error', message: result.message }, httpStatus: result.httpStatus };
    } else {
      this.metrics.failed++;
      patch = { status: 'failed', attempts, nextAttemptAt: null, lease: null, lastError: { code: result.code ?? 'error', message: result.message }, httpStatus: result.httpStatus };
      timeline = { id: randomUUID(), type: 'notification_failed', at: now, actorUserId: null, message: `Could not notify "${d.channelName}" after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${result.message}`, data: { channelId: d.channelId, deliveryId: d._id, event: d.event, attempts, code: result.code ?? 'error' } };
    }
    await this.db.c.alertDeliveries.updateOne({ _id: d._id }, { $set: patch });
    if (timeline && d.incidentId) {
      await this.db.c.incidents.updateOne(
        { _id: d.incidentId, orgId: d.orgId, projectId: d.projectId },
        { $push: { timeline: { $each: [timeline], $slice: -ALERT_LIMITS.maxTimelineEvents } }, $inc: { eventCount: 1 } },
      );
    }
    return { ...d, ...patch } as AlertDeliveryDoc;
  }
}
