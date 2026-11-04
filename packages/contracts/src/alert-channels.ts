import { z } from 'zod';
import { Id } from './common.js';
import { ALERT_LIMITS } from './alerting.js';

/**
 * Notification channels (ADR-0006 webhook, ADR-0008 Slack and e-mail).
 * Every secret-bearing field is WRITE-ONLY: it appears in the create/update bodies and never in a DTO.
 */
const iso = z.iso.datetime();

export const CHANNEL_TYPES = ['webhook', 'slack', 'email'] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const EMAIL_LIMITS = {
  maxRecipients: 20,
  maxAddressChars: 254,
  /** Reachable SMTP ports outside development: 465 (implicit TLS), 587 (submission), 2525 (alternative submission). Port 25 stays blocked (ADR-0008 #5). */
  smtpPorts: [465, 587, 2525] as readonly number[],
  maxSmtpCredentialChars: 256,
} as const;
export const SMTP_SECURITY = ['starttls', 'tls', 'none'] as const;
export type SmtpSecurity = (typeof SMTP_SECURITY)[number];

/**
 * A strict, ASCII-only addr-spec. No quotes, no comments, no display names, no whitespace and therefore no CR/LF: a value that passes this
 * cannot break out of an SMTP command or a header. (SMTPUTF8 addresses are deliberately not supported.)
 */
const ADDR_SPEC = /^[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}$/;
export function isValidEmailAddress(v: unknown): v is string {
  return typeof v === 'string' && v.length <= EMAIL_LIMITS.maxAddressChars && ADDR_SPEC.test(v) && !v.includes('..') && !/\.@|@\./.test(v);
}
/** Lower-cases and de-duplicates (first occurrence wins). Does not validate. */
export const normalizeRecipients = (list: readonly string[]): string[] => [...new Set(list.map((a) => a.trim().toLowerCase()))];

/** `alice@example.com` -> `a***@example.com`: readers of the channel list learn the domain and the count, not the mailbox. */
export function maskEmail(addr: string): string {
  const at = addr.lastIndexOf('@');
  if (at < 1) return '***';
  return `${addr.slice(0, 1)}***${addr.slice(at)}`;
}

const emailAddress = z.string().trim().max(EMAIL_LIMITS.maxAddressChars).refine(isValidEmailAddress, 'Enter a plain e-mail address such as oncall@example.com').transform((s) => s.toLowerCase());
const recipients = z.array(emailAddress).min(1, 'At least one recipient is required').max(EMAIL_LIMITS.maxRecipients, `At most ${EMAIL_LIMITS.maxRecipients} recipients`)
  .refine((l) => new Set(l).size === l.length, 'Recipients must be unique');
const smtpHost = z.string().trim().min(1).max(253).refine((h) => /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(h) && !h.includes('..') || /^[0-9A-Fa-f:.]{2,45}$/.test(h) && h.includes(':'), 'Enter a host name such as smtp.example.com');
const smtpPort = z.number().int().min(1).max(65535);
const smtpCredential = z.string().min(1).max(EMAIL_LIMITS.maxSmtpCredentialChars);

const common = {
  name: z.string().trim().min(1).max(80),
  enabled: z.boolean().default(true),
  rateLimitPerMinute: z.number().int().min(1).max(ALERT_LIMITS.maxRateLimitPerMinute).default(20),
};
const url = z.string().trim().min(1).max(ALERT_LIMITS.maxUrlChars);

export const WebhookChannelCreate = z.strictObject({
  type: z.literal('webhook'), ...common,
  url,
  /** Write-only: used to sign each delivery (HMAC-SHA256). It is stored encrypted and is never returned. */
  signingSecret: z.string().min(ALERT_LIMITS.minSecretChars).max(ALERT_LIMITS.maxSecretChars),
});
export const SlackChannelCreate = z.strictObject({
  type: z.literal('slack'), ...common,
  /** Write-only: a Slack incoming-webhook URL is a bearer secret (its path is the credential). Stored encrypted, never returned. */
  url,
});
export const SmtpSettings = z.strictObject({
  host: smtpHost,
  port: smtpPort.default(587),
  /** `starttls` (587, required upgrade), `tls` (implicit, 465) or `none` (development policy only). */
  security: z.enum(SMTP_SECURITY).default('starttls'),
  /** Write-only. Both or neither. */
  username: smtpCredential.optional(),
  password: smtpCredential.optional(),
}).refine((s) => (s.username === undefined) === (s.password === undefined), { message: 'Provide both the SMTP user name and password, or neither', path: ['password'] });
export const EmailChannelCreate = z.strictObject({
  type: z.literal('email'), ...common,
  smtp: SmtpSettings,
  from: emailAddress,
  recipients,
});

export const ChannelCreate = z.discriminatedUnion('type', [WebhookChannelCreate, SlackChannelCreate, EmailChannelCreate]);
export type ChannelCreate = z.infer<typeof ChannelCreate>;

/** A flat partial: the service rejects fields that do not belong to the channel's type (the type itself cannot be changed). */
export const ChannelUpdate = z.strictObject({
  name: common.name,
  enabled: z.boolean(),
  // No default here: zod applies defaults inside `.partial()`, which would silently reset the limit to 20 on every unrelated PATCH.
  rateLimitPerMinute: z.number().int().min(1).max(ALERT_LIMITS.maxRateLimitPerMinute),
  url,
  signingSecret: WebhookChannelCreate.shape.signingSecret,
  smtp: z.strictObject({ host: smtpHost, port: smtpPort, security: z.enum(SMTP_SECURITY), username: smtpCredential, password: smtpCredential }).partial()
    .refine((s) => (s.username === undefined) === (s.password === undefined), { message: 'Provide both the SMTP user name and password, or neither', path: ['password'] }),
  /** Remove the stored SMTP user name and password (anonymous submission). */
  clearSmtpCredentials: z.literal(true),
  from: emailAddress,
  recipients,
}).partial().refine((b) => Object.keys(b).length > 0, 'Nothing to update');
export type ChannelUpdate = z.infer<typeof ChannelUpdate>;

export const ChannelDto = z.object({
  id: Id, projectId: Id, type: z.enum(CHANNEL_TYPES), name: z.string(), enabled: z.boolean(),
  /** Scheme, host and port only (`https://hooks.slack.com/…`, `smtp://smtp.example.com:587`). The path of a webhook or Slack URL is a credential, so it is never returned. */
  urlDisplay: z.string(),
  /** Webhook channels only. */
  hasSigningSecret: z.boolean(),
  /** E-mail channels only (absent for webhook and Slack, so their responses are unchanged). The SMTP user name and password are never returned. */
  smtp: z.object({ host: z.string(), port: z.number(), security: z.enum(SMTP_SECURITY) }).optional(),
  hasSmtpCredentials: z.boolean().optional(),
  from: z.string().optional(),
  /** E-mail channels only. Masked (`a***@example.com`) so a viewer cannot harvest mailboxes. */
  recipientsMasked: z.array(z.string()).optional(),
  rateLimitPerMinute: z.number(),
  lastTest: z.object({ at: iso, ok: z.boolean(), message: z.string() }).nullable(),
  createdBy: Id, createdAt: iso, updatedAt: iso,
});
export type ChannelDto = z.infer<typeof ChannelDto>;
