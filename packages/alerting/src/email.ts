import { isValidEmailAddress } from '@nexus/contracts';

/**
 * E-mail formatting (ADR-0008 #7-8). Pure: builds an RFC 5322 / MIME message from a delivery payload.
 *  - header values never contain CR, LF or other control characters (stripped), recipients and the from-address are re-validated here;
 *  - the subject is RFC 2047 encoded when it is not plain ASCII;
 *  - `multipart/alternative`: a plain-text part first, an HTML part second, both UTF-8 base64;
 *  - every dynamic value in the HTML is entity-escaped, and the incident link is used only when it is an http(s) URL.
 */
export const EMAIL_BODY_LIMITS = { subjectChars: 150, valueChars: 300, maxMessageBytes: 64 * 1024 } as const;

export class EmailFormatError extends Error { constructor(message: string) { super(message); this.name = 'EmailFormatError'; } }

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);
const noControl = (s: string) => s.replace(/[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]/g, ' ');
/** A single-line header value: control characters (CR and LF included) become spaces. */
export const headerValue = (v: unknown, n = 500): string => clip(noControl(String(v ?? '')).replace(/\s+/g, ' ').trim(), n);
/** A value for a body: control characters other than newline dropped. */
const bodyValue = (v: unknown, n: number = EMAIL_BODY_LIMITS.valueChars): string => clip(String(v ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' '), n);

function encodeSubject(subject: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[ -~]*$/.test(subject)) return subject;
  const words: string[] = [];
  let cur = '';
  for (const ch of Array.from(subject)) {
    if (Buffer.byteLength(cur + ch) > 42) { words.push(cur); cur = ''; }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}
const b64Lines = (s: string) => (Buffer.from(s, 'utf8').toString('base64').match(/.{1,76}/g) ?? ['']).join('\r\n');

interface PayloadIncident {
  id?: string; title?: string; severity?: string; status?: string; ruleName?: string; group?: Record<string, string>;
  value?: number | null; condition?: string; openedAt?: string; resolvedAt?: string | null; url?: string;
}
type Payload = { event?: string; occurredAt?: string; message?: string; channel?: string; incident?: PayloadIncident } & Record<string, unknown>;

const safeLink = (u: unknown): string | null => {
  if (typeof u !== 'string' || u.length > 2_000) return null;
  try { const p = new URL(u); return p.protocol === 'https:' || p.protocol === 'http:' ? p.toString() : null; } catch { return null; }
};

export interface RenderedEmail { subject: string; text: string; html: string }

export function renderEmail(payload: Record<string, unknown>): RenderedEmail {
  const p = payload as Payload;
  if (p.event === 'test' || !p.incident) {
    const msg = bodyValue(p.message ?? 'This is a test notification from Nexus Observability.', 500);
    return {
      subject: '[Nexus] Test notification',
      text: `${msg}\n\nIf you can read this, the e-mail channel${p.channel ? ` "${bodyValue(p.channel, 80)}"` : ''} works.\n`,
      html: `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#111"><h2 style="margin:0 0 8px">Nexus test notification</h2><p>${escapeHtml(msg)}</p>`
        + `<p style="color:#555;font-size:12px">If you can read this, the e-mail channel${p.channel ? ` &quot;${escapeHtml(bodyValue(p.channel, 80))}&quot;` : ''} works.</p></body></html>`,
    };
  }
  const i = p.incident;
  const resolved = p.event === 'incident.resolved';
  const verb = resolved ? 'RESOLVED' : String(i.severity ?? 'alert').toUpperCase();
  const subject = headerValue(`[Nexus] ${verb}: ${bodyValue(i.title, 200)}`, EMAIL_BODY_LIMITS.subjectChars);
  const group = Object.entries(i.group ?? {}).slice(0, 10).map(([k, v]) => `${bodyValue(k, 60)}=${bodyValue(v, 100)}`).join(', ');
  const link = safeLink(i.url);
  const rows: [string, string][] = [
    ['Incident', bodyValue(i.title)], ['Severity', bodyValue(i.severity, 20)], ['Status', bodyValue(i.status, 20)], ['Rule', bodyValue(i.ruleName)],
    ['Condition', bodyValue(i.condition)], ['Value', i.value === null || i.value === undefined ? 'n/a' : bodyValue(i.value, 40)],
    ...(group ? [['Group', group] as [string, string]] : []),
    ['Opened', bodyValue(i.openedAt, 40)], ...(i.resolvedAt ? [['Resolved', bodyValue(i.resolvedAt, 40)] as [string, string]] : []),
  ];
  const text = `${resolved ? 'Incident resolved' : 'Incident opened'}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n${link ? `\nView the incident: ${link}\n` : ''}\n-- \nSent by Nexus Observability (incident ${bodyValue(i.id, 64)}).\n`;
  const html = `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#111"><h2 style="margin:0 0 12px">${escapeHtml(resolved ? 'Incident resolved' : 'Incident opened')}</h2>`
    + `<table role="presentation" cellpadding="4" cellspacing="0" style="border-collapse:collapse">${rows.map(([k, v]) => `<tr><td style="color:#555;vertical-align:top">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`).join('')}</table>`
    + `${link ? `<p><a href="${escapeHtml(link)}">View the incident</a></p>` : ''}`
    + `<p style="color:#777;font-size:12px">Sent by Nexus Observability (incident ${escapeHtml(bodyValue(i.id, 64))}).</p></body></html>`;
  return { subject, text, html };
}

export interface EmailEnvelope { from: string; to: string[]; deliveryId: string; event: string; now: Date; boundary?: string }

/** Builds the full message (headers + MIME body, CRLF line endings, no trailing dot-stuffing: the SMTP client does that). Throws EmailFormatError on any unsafe address. */
export function buildEmailMessage(env: EmailEnvelope, payload: Record<string, unknown>): { raw: string; subject: string } {
  if (!isValidEmailAddress(env.from)) throw new EmailFormatError('The from-address is not a valid plain e-mail address');
  if (env.to.length === 0) throw new EmailFormatError('There are no recipients');
  for (const a of env.to) if (!isValidEmailAddress(a)) throw new EmailFormatError('A recipient is not a valid plain e-mail address');
  const { subject, text, html } = renderEmail(payload);
  const boundary = env.boundary ?? `nexus-${Buffer.from(env.deliveryId).toString('hex').slice(0, 24)}-${Math.random().toString(36).slice(2, 10)}`;
  const domain = env.from.slice(env.from.lastIndexOf('@') + 1);
  const headers = [
    `From: "Nexus Observability" <${env.from}>`,
    `To: ${env.to.map((a) => `<${a}>`).join(', ')}`,
    `Subject: ${encodeSubject(subject)}`,
    `Date: ${env.now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${headerValue(env.deliveryId, 80).replace(/[^A-Za-z0-9._-]/g, '')}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    `X-Nexus-Event: ${headerValue(env.event, 40).replace(/[^A-Za-z0-9._-]/g, '')}`,
    `X-Nexus-Delivery: ${headerValue(env.deliveryId, 80).replace(/[^A-Za-z0-9._-]/g, '')}`,
    'Auto-Submitted: auto-generated',
    'X-Auto-Response-Suppress: All',
  ];
  const part = (type: string, body: string) => [`--${boundary}`, `Content-Type: ${type}; charset=utf-8`, 'Content-Transfer-Encoding: base64', '', b64Lines(body)].join('\r\n');
  const raw = `${headers.join('\r\n')}\r\n\r\n${part('text/plain', text)}\r\n${part('text/html', html)}\r\n--${boundary}--\r\n`;
  if (Buffer.byteLength(raw) > EMAIL_BODY_LIMITS.maxMessageBytes) throw new EmailFormatError('The message exceeds the size limit');
  return { raw, subject };
}
