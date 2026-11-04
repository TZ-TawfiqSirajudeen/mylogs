import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { STRICT_POLICY, type NetworkPolicy } from '@nexus/security';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildSlackMessage, escapeSlack, slackBody, SLACK_LIMITS } from './slack.js';
import { sendSlack } from './webhook.js';

const now = new Date('2026-11-04T10:00:00Z');
const payload = (over: Record<string, unknown> = {}, event = 'incident.opened') => ({
  event, occurredAt: now.toISOString(),
  incident: { id: 'inc-1', title: 'High error rate (service=checkout)', severity: 'critical', status: 'open', ruleName: 'High error rate', group: { service: 'checkout' }, value: 12.5, condition: '> 10 over 5m', openedAt: now.toISOString(), resolvedAt: null, url: 'https://nexus.example.com/incidents/inc-1?p=p1', ...over },
});
type Block = { type: string; text?: { type: string; text: string }; fields?: { text: string }[]; elements?: { text?: { text: string } | string; url?: string }[] };

describe('Slack message formatting', () => {
  test('Block Kit: header, fields, context and a "View incident" button, with a plain-text fallback', () => {
    const m = buildSlackMessage(payload()) as { text: string; blocks: Block[] };
    expect(m.text).toBe('Firing: High error rate (service=checkout) (critical)');
    expect(m.blocks.map((b) => b.type)).toEqual(['header', 'section', 'context', 'actions']);
    expect(m.blocks[0]!.text!.text).toContain('High error rate (service=checkout)');
    const fields = m.blocks[1]!.fields!.map((f) => f.text);
    expect(fields).toEqual(expect.arrayContaining(['*Severity*\ncritical', '*Status*\nopen', '*Rule*\nHigh error rate', '*Condition*\n&gt; 10 over 5m', '*Value*\n12.5', '*Group*\nservice=checkout']));
    expect(m.blocks[3]!.elements![0]!.url).toBe('https://nexus.example.com/incidents/inc-1?p=p1');
  });
  test('without a public URL there is no button; a resolved notice says so; a test notice is short', () => {
    expect((buildSlackMessage(payload({ url: undefined })) as { blocks: Block[] }).blocks.map((b) => b.type)).not.toContain('actions');
    const r = buildSlackMessage(payload({ status: 'resolved', resolvedAt: now.toISOString() }, 'incident.resolved')) as { text: string; blocks: Block[] };
    expect(r.text).toMatch(/^Resolved:/); expect(r.blocks[0]!.text!.text).toContain('Resolved');
    const t = buildSlackMessage({ event: 'test', message: 'hello', channel: 'ops' }) as { blocks: Block[] };
    expect(t.blocks).toHaveLength(2);
  });
  test('mrkdwn control characters from labels cannot create mentions or links', () => {
    expect(escapeSlack('<!channel> <@U123> <https://evil.example|click> a&b')).toBe('&lt;!channel&gt; &lt;@U123&gt; &lt;https://evil.example|click&gt; a&amp;b');
    const body = slackBody(payload({ title: '<!channel> outage', ruleName: '<!here>', group: { '<@U1>': '<https://evil.example|pay now>' }, condition: '<!everyone>' }));
    // every mrkdwn-parsed string (the fallback text and the mrkdwn fields) is free of raw angle brackets; the header is `plain_text`, which Slack never parses
    const parsed = JSON.parse(body) as { text: string; blocks: (Block & { fields?: { type: string; text: string }[] })[] };
    const parsedTexts = [parsed.text, ...parsed.blocks.flatMap((b) => [...(b.fields ?? []).map((f) => f.text), ...(b.elements ?? []).flatMap((e) => (typeof e.text === 'string' ? [e.text] : []))])];
    expect(parsedTexts.length).toBeGreaterThan(5);
    for (const t of parsedTexts) expect(t).not.toMatch(/[<>]/);
    expect(body).toContain('&lt;!channel&gt;');
    expect(parsed.blocks[0]!.text!.type).toBe('plain_text');
  });
  test('only http(s) links become a button', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,x', 'ftp://x.example.com/']) expect((buildSlackMessage(payload({ url })) as { blocks: Block[] }).blocks.map((b) => b.type), url).not.toContain('actions');
  });
  test('limits: header, fields and the whole body stay within Slack and platform limits', () => {
    const long = 'x'.repeat(10_000);
    const m = buildSlackMessage(payload({ title: long, ruleName: long, condition: long, group: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, long])) })) as { text: string; blocks: Block[] };
    expect(m.blocks[0]!.text!.text.length).toBeLessThanOrEqual(SLACK_LIMITS.headerChars);
    expect(m.blocks[1]!.fields!.length).toBeLessThanOrEqual(SLACK_LIMITS.maxFields);
    for (const f of m.blocks[1]!.fields!) expect(f.text.length).toBeLessThan(2_000);
    expect(m.text.length).toBeLessThanOrEqual(SLACK_LIMITS.fallbackChars + 20);
    expect(Buffer.byteLength(JSON.stringify(m))).toBeLessThan(16 * 1024);
  });
  test('control characters are dropped', () => {
    expect(slackBody(payload({ title: 'a\u0000b\u0007c' }))).not.toMatch(/\\u0000|\\u0007/);
  });
});

describe('sending to a fake Slack receiver (real HTTP, development policy)', () => {
  let server: http.Server; let port: number;
  const hits: { url: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  let mode: 'ok' | '400' | '404' | '429' | '500' | 'redirect' = 'ok';
  const dev: NetworkPolicy = { ...STRICT_POLICY, allowLoopback: true, allowInsecureHttp: true };
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = []; req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        hits.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() });
        if (mode === 'redirect') { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); return res.end(); }
        const status = mode === 'ok' ? 200 : Number(mode); res.writeHead(status, mode === '429' ? { 'retry-after': '1' } : {}); res.end(status === 200 ? 'ok' : 'no');
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  const send = () => sendSlack({ url: `http://127.0.0.1:${port}/services/T000/B000/XXXXSLACKTOKEN`, event: 'incident.opened', deliveryId: 'd-1', body: slackBody(payload()), now }, { policy: dev });

  test('posts the Block Kit JSON, without any signing header, to the stored path', async () => {
    mode = 'ok'; hits.length = 0;
    const r = await send();
    expect(r).toMatchObject({ ok: true, httpStatus: 200 });
    expect(hits[0]!.url).toBe('/services/T000/B000/XXXXSLACKTOKEN');
    expect(hits[0]!.headers['content-type']).toBe('application/json');
    expect(hits[0]!.headers['x-nexus-signature']).toBeUndefined();
    expect(JSON.parse(hits[0]!.body).blocks).toBeInstanceOf(Array);
  });
  test.each([['400', false], ['404', false], ['429', true], ['500', true], ['redirect', false]] as const)('receiver answers %s: retryable=%s, and the message never contains the URL token', async (m, retryable) => {
    mode = m;
    const r = await send();
    expect(r.ok).toBe(false); expect(r.retryable).toBe(retryable);
    expect(JSON.stringify(r)).not.toContain('XXXXSLACKTOKEN');
  });
  test('the platform policy blocks private and loopback targets (strict policy), exactly like webhooks', async () => {
    const strict: NetworkPolicy = { ...STRICT_POLICY, resolver: async (h) => (h === 'hooks.internal-corp.example.com' ? ['10.0.0.8'] : ['93.184.216.34']) };
    for (const url of ['https://127.0.0.1/services/x', 'https://169.254.169.254/x', 'https://hooks.internal-corp.example.com/x', 'https://localhost/x', 'http://hooks.slack.com/x']) {
      const r = await sendSlack({ url, event: 'test', deliveryId: 'd', body: '{}', now }, { policy: strict });
      expect(r, url).toMatchObject({ ok: false, retryable: false });
    }
  });
});
