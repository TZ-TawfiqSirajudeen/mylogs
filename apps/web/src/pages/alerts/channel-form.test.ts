import { ChannelCreate } from '@nexus/contracts';
import { describe, expect, test } from 'vitest';
import { channelBody, defaultPort, draftReady, recipientsProblem, splitRecipients, type ChannelDraft } from './channel-form';

const draft = (over: Partial<ChannelDraft> = {}): ChannelDraft => ({
  type: 'email', name: ' ops ', url: '', secret: '', rate: 20, host: ' smtp.example.com ', port: 587, security: 'starttls', smtpUser: '', smtpPass: '', from: ' Alerts@Example.com ', recipientsText: 'a@example.com, B@example.com\nb@example.com;c@example.org', ...over,
});

describe('channel form helpers', () => {
  test('recipients are split on commas, spaces, semicolons and new lines, lower-cased and de-duplicated', () => {
    expect(splitRecipients('a@example.com, B@example.com\nb@example.com;c@example.org')).toEqual(['a@example.com', 'b@example.com', 'c@example.org']);
    expect(splitRecipients('  ')).toEqual([]);
  });
  test('recipient problems: none for a valid list, a message for too many or malformed entries', () => {
    expect(recipientsProblem([])).toBeNull();
    expect(recipientsProblem(['a@example.com'])).toBeNull();
    expect(recipientsProblem(Array.from({ length: 21 }, (_, i) => `u${i}@example.com`))).toMatch(/At most 20/);
    expect(recipientsProblem(['not-an-address'])).toMatch(/plain address/);
    expect(recipientsProblem(['a@example.com\r\nBcc: x@y.zz'])).toMatch(/plain address/);
  });
  test('the e-mail request body is exactly what the API contract accepts, with credentials only when both are present', () => {
    const body = channelBody(draft());
    expect(ChannelCreate.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ type: 'email', name: 'ops', from: 'alerts@example.com', recipients: ['a@example.com', 'b@example.com', 'c@example.org'], smtp: { host: 'smtp.example.com', port: 587, security: 'starttls' } });
    expect((body.smtp as Record<string, unknown>).username).toBeUndefined();
    const authed = channelBody(draft({ smtpUser: 'u', smtpPass: 'p' }));
    expect(ChannelCreate.safeParse(authed).success).toBe(true);
    expect((authed.smtp as Record<string, unknown>).password).toBe('p');
  });
  test('slack and webhook bodies carry only the fields of their type', () => {
    const slack = channelBody(draft({ type: 'slack', url: ' https://hooks.slack.com/services/T/B/x ', secret: 'ignored-secret-value-123' }));
    expect(slack).toEqual({ type: 'slack', name: 'ops', rateLimitPerMinute: 20, url: 'https://hooks.slack.com/services/T/B/x' });
    expect(ChannelCreate.safeParse(slack).success).toBe(true);
    const hook = channelBody(draft({ type: 'webhook', url: 'https://hooks.example.com/x', secret: 'a-signing-secret-1234' }));
    expect(hook).toMatchObject({ type: 'webhook', signingSecret: 'a-signing-secret-1234' });
    expect(ChannelCreate.safeParse(hook).success).toBe(true);
  });
  test('the submit button is enabled only for a complete, valid draft', () => {
    expect(draftReady(draft(), 16)).toBe(true);
    expect(draftReady(draft({ name: ' ' }), 16)).toBe(false);
    expect(draftReady(draft({ recipientsText: '' }), 16)).toBe(false);
    expect(draftReady(draft({ recipientsText: 'bad' }), 16)).toBe(false);
    expect(draftReady(draft({ from: 'nope' }), 16)).toBe(false);
    expect(draftReady(draft({ smtpUser: 'u' }), 16)).toBe(false); // user name without password
    expect(draftReady(draft({ type: 'webhook', url: 'https://x.example.com', secret: 'short' }), 16)).toBe(false);
    expect(draftReady(draft({ type: 'webhook', url: 'https://x.example.com', secret: 'long-enough-secret-1' }), 16)).toBe(true);
    expect(draftReady(draft({ type: 'slack', url: '' }), 16)).toBe(false);
    expect(draftReady(draft({ type: 'slack', url: 'https://hooks.slack.com/x' }), 16)).toBe(true);
  });
  test('implicit TLS defaults to 465, everything else to 587', () => {
    expect(defaultPort('tls')).toBe(465); expect(defaultPort('starttls')).toBe(587); expect(defaultPort('none')).toBe(587);
  });
});
