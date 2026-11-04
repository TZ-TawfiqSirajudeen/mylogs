import { EMAIL_LIMITS, isValidEmailAddress, type ChannelType, type SmtpSecurity } from '@nexus/contracts';

/** Pure helpers behind the "new channel" form (ADR-0008). The server validates everything again; this only keeps the button honest. */
export const splitRecipients = (s: string): string[] => [...new Set(s.split(/[\s,;]+/).map((x) => x.trim().toLowerCase()).filter(Boolean))];

export const recipientsProblem = (list: string[]): string | null =>
  list.length === 0 ? null
    : list.length > EMAIL_LIMITS.maxRecipients ? `At most ${EMAIL_LIMITS.maxRecipients} recipients.`
      : list.every(isValidEmailAddress) ? null : 'Every recipient must be a plain address such as name@example.com.';

export const defaultPort = (security: SmtpSecurity): number => (security === 'tls' ? 465 : 587);

export interface ChannelDraft {
  type: ChannelType; name: string; url: string; secret: string; rate: number;
  host: string; port: number; security: SmtpSecurity; smtpUser: string; smtpPass: string; from: string; recipientsText: string;
}

/** The request body for the draft. Secrets are included only for the channel types that use them. */
export function channelBody(d: ChannelDraft): Record<string, unknown> {
  const common = { name: d.name.trim(), rateLimitPerMinute: d.rate };
  if (d.type === 'webhook') return { type: d.type, ...common, url: d.url.trim(), signingSecret: d.secret };
  if (d.type === 'slack') return { type: d.type, ...common, url: d.url.trim() };
  return {
    type: d.type, ...common,
    smtp: { host: d.host.trim(), port: d.port, security: d.security, ...(d.smtpUser ? { username: d.smtpUser, password: d.smtpPass } : {}) },
    from: d.from.trim().toLowerCase(), recipients: splitRecipients(d.recipientsText),
  };
}

export function draftReady(d: ChannelDraft, minSecretChars: number): boolean {
  if (!d.name.trim()) return false;
  if (d.type === 'webhook') return !!d.url.trim() && d.secret.length >= minSecretChars;
  if (d.type === 'slack') return !!d.url.trim();
  const r = splitRecipients(d.recipientsText);
  return !!d.host.trim() && isValidEmailAddress(d.from.trim().toLowerCase()) && r.length > 0 && recipientsProblem(r) === null && (d.smtpUser === '') === (d.smtpPass === '');
}
