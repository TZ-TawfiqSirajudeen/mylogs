/**
 * Slack incoming-webhook formatting (ADR-0008 #2-3). Pure functions: no I/O, no secrets.
 * Every dynamic value comes from telemetry or from users and is therefore escaped for Slack's mrkdwn (`&`, `<`, `>`), so it cannot create a mention
 * (`<!channel>`, `<@U123>`) or a disguised link (`<https://evil|click>`). Values are truncated to Slack's block limits.
 */
export const SLACK_LIMITS = { headerChars: 150, fieldChars: 300, textChars: 3_000, fallbackChars: 300, maxFields: 10, maxGroupLabels: 5 } as const;

/** Slack asks for exactly these three characters to be entity-encoded in text fields. */
export function escapeSlack(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);
/** Control characters (other than newline) are dropped; mrkdwn emphasis characters are neutralised so a label cannot restyle the message. */
const clean = (v: unknown): string => String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ');
const safe = (v: unknown, n: number) => escapeSlack(clip(clean(v), n));

interface PayloadIncident {
  id?: string; title?: string; severity?: string; status?: string; ruleName?: string; environmentId?: string; group?: Record<string, string>;
  value?: number | null; condition?: string; openedAt?: string; resolvedAt?: string | null; url?: string;
}
type Payload = { event?: string; occurredAt?: string; message?: string; channel?: string; incident?: PayloadIncident } & Record<string, unknown>;

const SEVERITY_EMOJI: Record<string, string> = { critical: ':red_circle:', warning: ':large_orange_circle:', info: ':large_blue_circle:' };

/** Only http(s) links are ever placed in a button, and the URL is length-capped by Slack (3000). */
const safeLink = (u: unknown): string | null => {
  if (typeof u !== 'string' || u.length > 2_000) return null;
  try { const p = new URL(u); return p.protocol === 'https:' || p.protocol === 'http:' ? p.toString() : null; } catch { return null; }
};

export function buildSlackMessage(raw: Record<string, unknown>): Record<string, unknown> {
  const p = raw as Payload;
  if (p.event === 'test' || !p.incident) {
    const text = `Nexus Observability test notification${p.channel ? ` for "${clip(clean(p.channel), 80)}"` : ''}`;
    return {
      text: escapeSlack(clip(text, SLACK_LIMITS.fallbackChars)),
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: ':white_check_mark: Nexus test notification', emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: safe(p.message ?? 'This is a test notification from Nexus Observability.', SLACK_LIMITS.textChars) } },
      ],
    };
  }
  const i = p.incident;
  const resolved = p.event === 'incident.resolved';
  const emoji = resolved ? ':white_check_mark:' : SEVERITY_EMOJI[String(i.severity)] ?? ':warning:';
  const verb = resolved ? 'Resolved' : 'Firing';
  const headerText = clip(`${emoji} ${verb}: ${clean(i.title)}`, SLACK_LIMITS.headerChars);
  const group = Object.entries(i.group ?? {}).slice(0, SLACK_LIMITS.maxGroupLabels).map(([k, v]) => `${safe(k, 40)}=${safe(v, 80)}`).join(', ');
  const fields = [
    { type: 'mrkdwn', text: `*Severity*\n${safe(i.severity, 20)}` },
    { type: 'mrkdwn', text: `*Status*\n${safe(i.status, 20)}` },
    { type: 'mrkdwn', text: `*Rule*\n${safe(i.ruleName, SLACK_LIMITS.fieldChars)}` },
    { type: 'mrkdwn', text: `*Condition*\n${safe(i.condition, SLACK_LIMITS.fieldChars)}` },
    { type: 'mrkdwn', text: `*Value*\n${i.value === null || i.value === undefined ? 'n/a' : safe(i.value, 40)}` },
    ...(group ? [{ type: 'mrkdwn', text: `*Group*\n${group}` }] : []),
  ].slice(0, SLACK_LIMITS.maxFields);
  const when = resolved ? i.resolvedAt ?? p.occurredAt : i.openedAt ?? p.occurredAt;
  const link = safeLink(i.url);
  const blocks: Record<string, unknown>[] = [
    { type: 'header', text: { type: 'plain_text', text: headerText, emoji: true } },
    { type: 'section', fields },
    { type: 'context', elements: [{ type: 'mrkdwn', text: `Nexus Observability · incident \`${safe(i.id, 64)}\`${when ? ` · ${resolved ? 'resolved' : 'opened'} ${safe(when, 40)}` : ''}` }] },
    ...(link ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'View incident', emoji: true }, url: link, action_id: 'view_incident' }] }] : []),
  ];
  // The fallback `text` is parsed as mrkdwn too (notifications, screen readers), so it is escaped like every other value.
  return { text: escapeSlack(clip(`${verb}: ${clean(i.title)} (${clean(i.severity)})`, SLACK_LIMITS.fallbackChars)), blocks };
}

export const slackBody = (payload: Record<string, unknown>): string => JSON.stringify(buildSlackMessage(payload));
