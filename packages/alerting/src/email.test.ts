import { isValidEmailAddress, maskEmail, normalizeRecipients, EmailChannelCreate, ChannelCreate, ChannelUpdate, ChannelDto } from '@nexus/contracts';
import { describe, expect, test } from 'vitest';
import { buildEmailMessage, EmailFormatError, escapeHtml, renderEmail } from './email.js';

const now = new Date('2026-11-04T10:00:00Z');
const incident = (over: Record<string, unknown> = {}) => ({
  event: 'incident.opened', occurredAt: now.toISOString(), deliveryId: 'd-1',
  incident: { id: 'inc-1', title: 'High error rate (service=checkout)', severity: 'critical', status: 'open', ruleName: 'High error rate', group: { service: 'checkout' }, value: 12.5, condition: '> 10 over 5m', openedAt: now.toISOString(), resolvedAt: null, url: 'https://nexus.example.com/incidents/inc-1?p=p1', ...over },
});
const decode = (raw: string, type: 'text/plain' | 'text/html') => {
  const m = new RegExp(`Content-Type: ${type}; charset=utf-8\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([A-Za-z0-9+/=\\r\\n]+?)\\r\\n--`).exec(raw);
  return Buffer.from((m?.[1] ?? '').replace(/\r\n/g, ''), 'base64').toString('utf8');
};
const build = (payload: Record<string, unknown>, over: Partial<Parameters<typeof buildEmailMessage>[0]> = {}) =>
  buildEmailMessage({ from: 'alerts@example.com', to: ['a@example.com', 'b@example.org'], deliveryId: 'd-1', event: 'incident.opened', now, boundary: 'BOUNDARY', ...over }, payload);

describe('e-mail addresses (contract)', () => {
  test.each(['alice@example.com', 'a.b+tag@sub.example.co.uk', 'o_n-call%x@example.io'])('accepts %s', (a) => expect(isValidEmailAddress(a)).toBe(true));
  test.each([
    'a@b', 'no-at.example.com', '@example.com', 'a@@example.com', 'a b@example.com', 'a@example.com\r\nBcc: evil@x.com', 'a@example.com\nRCPT TO:<x@y.zz>', 'a@example.com>', '<a@example.com>',
    '"quoted"@example.com', 'a,b@example.com', 'a@exa mple.com', 'a;b@example.com', 'a@example.com ', '', 'a..b@example.com', 'a@.example.com', 'ä@example.com', `${'a'.repeat(250)}@example.com`,
  ])('refuses %j', (a) => expect(isValidEmailAddress(a)).toBe(false));
  test('normalisation lower-cases and de-duplicates; masking hides the mailbox', () => {
    expect(normalizeRecipients(['A@Example.com', 'a@example.com ', 'b@example.com'])).toEqual(['a@example.com', 'b@example.com']);
    expect(maskEmail('alice@example.com')).toBe('a***@example.com');
  });
});

describe('e-mail channel contract', () => {
  const ok = { type: 'email', name: 'ops', smtp: { host: 'smtp.example.com', username: 'u', password: 'p' }, from: 'alerts@example.com', recipients: ['a@example.com'] };
  test('accepts a valid body and fills defaults', () => {
    const r = EmailChannelCreate.parse(ok);
    expect(r.smtp).toMatchObject({ port: 587, security: 'starttls' });
    expect(r).toMatchObject({ enabled: true, rateLimitPerMinute: 20 });
  });
  test('caps recipients at 20, requires at least one, rejects duplicates and injected recipients', () => {
    const many = Array.from({ length: 21 }, (_, i) => `u${i}@example.com`);
    expect(ChannelCreate.safeParse({ ...ok, recipients: many }).success).toBe(false);
    expect(ChannelCreate.safeParse({ ...ok, recipients: many.slice(0, 20) }).success).toBe(true);
    expect(ChannelCreate.safeParse({ ...ok, recipients: [] }).success).toBe(false);
    expect(ChannelCreate.safeParse({ ...ok, recipients: ['a@example.com', 'A@example.com'] }).success).toBe(false);
    expect(ChannelCreate.safeParse({ ...ok, recipients: ['a@example.com\r\nBcc: x@example.com'] }).success).toBe(false);
    expect(ChannelCreate.safeParse({ ...ok, from: 'x@example.com\nSubject: hi' }).success).toBe(false);
  });
  test('user name and password come together; unknown fields are refused; the host must look like a host', () => {
    expect(ChannelCreate.safeParse({ ...ok, smtp: { host: 'smtp.example.com', username: 'u' } }).success).toBe(false);
    expect(ChannelCreate.safeParse({ ...ok, smtp: { host: 'smtp.example.com' } }).success).toBe(true);
    expect(ChannelCreate.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    for (const host of ['a b', 'smtp.example.com/x', 'smtp.example.com:25', 'http://x', 'a..b', '']) expect(ChannelCreate.safeParse({ ...ok, smtp: { host } }).success, host).toBe(false);
  });
  test('the DTO has no field that could carry a secret or a full recipient list', () => {
    const keys = Object.keys(ChannelDto.shape);
    for (const k of keys.filter((x) => !x.startsWith('has'))) expect(k).not.toMatch(/password|secret|username|recipients$|^url$/i);
    expect(keys).toContain('recipientsMasked'); expect(keys).toContain('hasSmtpCredentials');
  });
  test('update is a partial; empty bodies are refused', () => {
    expect(ChannelUpdate.safeParse({}).success).toBe(false);
    expect(ChannelUpdate.safeParse({ recipients: ['a@example.com'] }).success).toBe(true);
    expect(ChannelUpdate.safeParse({ smtp: { password: 'x' } }).success).toBe(false); // password without user name
  });
});

describe('message building', () => {
  test('multipart/alternative with a plain-text part first and an HTML part second, CRLF line endings', () => {
    const { raw, subject } = build(incident());
    expect(subject).toBe('[Nexus] CRITICAL: High error rate (service=checkout)');
    expect(raw).toMatch(/^From: "Nexus Observability" <alerts@example.com>\r\nTo: <a@example.com>, <b@example.org>\r\n/);
    expect(raw).toContain('Content-Type: multipart/alternative; boundary="BOUNDARY"');
    expect(raw.indexOf('text/plain')).toBeLessThan(raw.indexOf('text/html'));
    expect(raw).toContain('Message-ID: <d-1@example.com>');
    expect(raw).toContain('Auto-Submitted: auto-generated');
    expect(raw.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/); // no bare CR or LF anywhere
    const text = decode(raw, 'text/plain'), html = decode(raw, 'text/html');
    expect(text).toContain('Severity: critical'); expect(text).toContain('View the incident: https://nexus.example.com/incidents/inc-1?p=p1');
    expect(html).toContain('<a href="https://nexus.example.com/incidents/inc-1?p=p1">');
  });
  test('a resolved notice and a test notice read differently', () => {
    expect(build({ ...incident(), event: 'incident.resolved' }).subject).toMatch(/^\[Nexus\] RESOLVED:/);
    expect(renderEmail({ event: 'test', message: 'hi', channel: 'ops' }).subject).toBe('[Nexus] Test notification');
  });
  test('HTML escapes every dynamic value (classic XSS payloads from labels, titles and rule names)', () => {
    const evil = `<script>alert(1)</script><img src=x onerror=alert(2)>"'&`;
    const html = renderEmail(incident({ title: evil, ruleName: evil, group: { [evil]: evil }, condition: evil, severity: evil, status: evil })).html;
    expect(html).not.toContain('<script'); expect(html).not.toContain('<img'); expect(html).not.toMatch(/onerror=alert\(2\)>/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(escapeHtml(`a"b'c<d>&`)).toBe('a&quot;b&#39;c&lt;d&gt;&amp;');
  });
  test('links: only http(s) URLs become links, and attribute-breaking URLs are escaped', () => {
    expect(renderEmail(incident({ url: 'javascript:alert(1)' })).html).not.toContain('<a href');
    expect(renderEmail(incident({ url: 'data:text/html,<script>' })).text).not.toContain('View the incident');
    const html = renderEmail(incident({ url: 'https://x.example.com/a?q="><script>alert(1)</script>' })).html;
    expect(html).not.toContain('<script'); // the URL parser percent-encodes quotes and angle brackets; escapeHtml covers the rest
  });
  test('CR/LF in titles never reach a header: the subject is one line and no header can be injected', () => {
    const { raw, subject } = build(incident({ title: 'boom\r\nBcc: attacker@evil.example\r\nX-Evil: 1' }));
    expect(subject).not.toMatch(/[\r\n]/);
    const headerBlock = raw.split('\r\n\r\n')[0]!;
    expect(headerBlock).not.toMatch(/^Bcc:/im); expect(headerBlock).not.toMatch(/^X-Evil:/im);
  });
  test('non-ASCII subjects are RFC 2047 encoded', () => {
    const { raw } = build(incident({ title: 'Überlast – 検知' }));
    const subj = /^Subject: (.*(?:\r\n .*)*)\r\n/m.exec(raw)![1]!;
    expect(subj).toMatch(/^=\?UTF-8\?B\?/);
    const decoded = subj.split('\r\n ').map((w) => Buffer.from(/=\?UTF-8\?B\?(.*)\?=/.exec(w)![1]!, 'base64').toString('utf8')).join('');
    expect(decoded).toContain('Überlast – 検知');
  });
  test('unsafe addresses are refused at build time even if they bypassed the contract (old documents)', () => {
    expect(() => build(incident(), { to: ['a@example.com\r\nBcc: x@y.zz'] })).toThrow(EmailFormatError);
    expect(() => build(incident(), { from: 'x@example.com\r\n' })).toThrow(EmailFormatError);
    expect(() => build(incident(), { to: [] })).toThrow(EmailFormatError);
  });
  test('the message is bounded', () => {
    const big = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, 'v'.repeat(100)]));
    expect(Buffer.byteLength(build(incident({ group: big })).raw)).toBeLessThan(64 * 1024);
  });
});
