import { describe, expect, test } from 'vitest';
import { DEFAULT_LIMITS, decodeTracesRequest, encodeTracesRequest, encodeTracesResponse, otlpTracesToDrafts, parseUnixNano, redactUrlText } from './index.js';

const now = new Date('2026-10-28T12:00:00.000Z');
const opts = { now, limits: DEFAULT_LIMITS, redaction: { enabled: true, extraKeys: [] as string[] } };
const ns = (msAgo: number, frac = 0) => String(BigInt(now.getTime() - msAgo) * 1_000_000n + BigInt(frac));
const TRACE = 'a'.repeat(32), SPAN = 'b'.repeat(16), PARENT = 'c'.repeat(16);
const span = (over: object = {}) => ({ traceId: TRACE, spanId: SPAN, parentSpanId: PARENT, name: 'GET /orders/:id', kind: 2, startTimeUnixNano: ns(2000, 123456), endTimeUnixNano: ns(1500, 654321), attributes: [], ...over });
const body = (spans: object[], resourceAttrs: object[] = [{ key: 'service.name', value: { stringValue: 'gateway' } }, { key: 'service.version', value: { stringValue: '1.2.3' } }]) =>
  ({ resourceSpans: [{ resource: { attributes: resourceAttrs }, scopeSpans: [{ scope: { name: 'http', version: '0.1' }, spans }] }] });
const one = (over: object = {}, o = opts) => otlpTracesToDrafts(body([span(over)]), o);

describe('timestamps keep nanosecond precision', () => {
  test('parseUnixNano splits milliseconds and the nanoseconds within them without losing digits', () => {
    const t = parseUnixNano('1700000000123456789')!;
    expect(t.ms).toBe(1700000000123);
    expect(t.frac).toBe(456789);
    expect(t.ns).toBe(1700000000123456789n);
  });
  test('absent, zero, negative, non-numeric and out-of-range values are null (never "now")', () => {
    for (const v of [undefined, null, '', '0', 0, '-5', 'abc', '1', '99999999999999999999']) expect(parseUnixNano(v)).toBeNull();
  });
  test('the duration is exact to the nanosecond', () => {
    const [s] = one().records;
    expect(s!.durationNs).toBe(500_000_000 + (654321 - 123456));
    expect(s!.startNsFrac).toBe(123456);
    expect(s!.timingValid).toBe(true);
  });
  test('nanoseconds are not mistaken for milliseconds: a plausible date is required', () => {
    const r = one({ startTimeUnixNano: String(now.getTime()), endTimeUnixNano: String(now.getTime() + 5) }); // a ms value in a ns field
    expect(r.records).toEqual([]);
    expect(r.rejected).toBe(1);
  });
});

describe('structure and validity', () => {
  test('maps a well-formed span with resource, scope, status and extracted fields', () => {
    const r = one({ status: { code: 2, message: 'boom' }, attributes: [
      { key: 'http.request.method', value: { stringValue: 'get' } }, { key: 'http.route', value: { stringValue: '/orders/:id' } },
      { key: 'http.response.status_code', value: { intValue: '500' } }, { key: 'db.system', value: { stringValue: 'mongodb' } },
    ] });
    expect(r.rejected).toBe(0);
    expect(r.records[0]).toMatchObject({
      traceId: TRACE, spanId: SPAN, parentSpanId: PARENT, kind: 'server', statusCode: 'error', statusMessage: 'boom', service: 'gateway', serviceVersion: '1.2.3',
      scopeName: 'http', scopeVersion: '0.1', httpMethod: 'GET', httpRoute: '/orders/:id', httpStatus: 500, dbSystem: 'mongodb',
    });
  });
  test('enums may arrive as names (OTLP/JSON) or numbers (protobuf)', () => {
    const r = one({ kind: 'SPAN_KIND_CLIENT', status: { code: 'STATUS_CODE_OK' } });
    expect(r.records[0]).toMatchObject({ kind: 'client', statusCode: 'ok' });
  });
  test('a root span has parentSpanId null; empty and all-zero parents mean "no parent"', () => {
    for (const parentSpanId of [undefined, '', '0'.repeat(16)]) expect(one({ parentSpanId }).records[0]!.parentSpanId).toBeNull();
  });
  test.each([
    ['short trace id', { traceId: 'abc' }], ['all-zero trace id', { traceId: '0'.repeat(32) }], ['non-hex trace id', { traceId: 'z'.repeat(32) }],
    ['short span id', { spanId: 'abc' }], ['all-zero span id', { spanId: '0'.repeat(16) }],
    ['malformed (non-empty) parent id', { parentSpanId: 'not-an-id' }], ['missing start time', { startTimeUnixNano: undefined }],
    ['start far in the future', { startTimeUnixNano: ns(-3_600_000) }],
  ])('rejects a span with %s and reports why', (_n, over) => {
    const r = one(over);
    expect(r.records).toEqual([]);
    expect(r.rejected).toBe(1);
    expect(r.errors.length).toBe(1);
  });
  test('a missing or reversed end time keeps the span but reports no duration (nothing is invented)', () => {
    for (const endTimeUnixNano of [undefined, ns(5000)]) {
      const s = one({ endTimeUnixNano }).records[0]!;
      expect(s.timingValid).toBe(false);
      expect(s.durationNs).toBeNull();
      expect(s.end.getTime()).toBe(s.start.getTime());
    }
  });
  test('malformed entries are counted and never crash; valid siblings still pass', () => {
    const r = otlpTracesToDrafts({ resourceSpans: [null, { scopeSpans: [null, { spans: [null, 5, span()] }] }] }, opts);
    expect(r.records).toHaveLength(1);
    expect(r.rejected).toBe(4);
    expect(otlpTracesToDrafts('nope', opts).records).toEqual([]);
    expect(otlpTracesToDrafts({ resourceSpans: 'x' }, opts).records).toEqual([]);
  });
  test('the per-request span limit is enforced and counted', () => {
    const r = otlpTracesToDrafts(body(Array.from({ length: 12 }, (_, i) => span({ spanId: i.toString(16).padStart(16, '1') }))), { ...opts, limits: { ...DEFAULT_LIMITS, maxRecordsPerRequest: 10 } });
    expect(r.records).toHaveLength(10);
    expect(r.rejected).toBe(2);
  });
  test('events, exceptions and links are preserved (bounded) and sanitized', () => {
    const r = one({
      events: [{ timeUnixNano: ns(1700), name: 'exception', attributes: [
        { key: 'exception.type', value: { stringValue: 'TypeError' } }, { key: 'exception.message', value: { stringValue: 'x is not a function' } },
        { key: 'exception.stacktrace', value: { stringValue: 'TypeError: x\n  at f (a.js:1)\n  password=hunter2hunter2' } },
      ] }, { name: 'no-time-event' }],
      links: [{ traceId: 'd'.repeat(32), spanId: 'e'.repeat(16), attributes: [] }, { traceId: 'bad', spanId: 'e'.repeat(16) }],
    });
    const s = r.records[0]!;
    expect(s.exceptionType).toBe('TypeError');
    expect(s.events).toHaveLength(2);
    expect(s.events[0]!.attrs.find((a) => a.k === 'exception.stacktrace')!.v).not.toContain('hunter2');
    expect(s.events[1]!.ts.getTime()).toBe(s.start.getTime()); // an event without a time sits at the span start
    expect(s.links).toHaveLength(1); // the broken link is dropped, not repaired
    expect(s.redactions).toBeGreaterThan(0);
  });
  test('an excess of events is truncated and the loss is visible', () => {
    const s = one({ events: Array.from({ length: 300 }, (_, i) => ({ name: `e${i}`, timeUnixNano: ns(1800) })) }).records[0]!;
    expect(s.events).toHaveLength(128);
    expect(s.droppedEvents).toBeGreaterThan(0);
    expect(s.attrsTruncated).toBe(true);
  });
});

describe('redaction (same principles as logs, plus URLs and connection strings)', () => {
  test('credential-named attributes are masked; ordinary ones are not', () => {
    const s = one({ attributes: [
      { key: 'http.request.header.authorization', value: { stringValue: 'Bearer abcdefghijklmnop' } }, { key: 'http.request.header.cookie', value: { stringValue: 'sid=1' } },
      { key: 'db.connection_string', value: { stringValue: 'mongodb://u:pw@h/db' } }, { key: 'customer.tier', value: { stringValue: 'gold' } },
    ] }).records[0]!;
    const v = (k: string) => s.attrs.find((a) => a.k === k)!.v;
    expect(v('http.request.header.authorization')).toBe('[REDACTED]');
    expect(v('http.request.header.cookie')).toBe('[REDACTED]');
    expect(v('db.connection_string')).toBe('[REDACTED]');
    expect(v('customer.tier')).toBe('gold');
  });
  test('credential query parameters and URL userinfo are masked; harmless parameters stay readable', () => {
    const s = one({ attributes: [
      { key: 'url.full', value: { stringValue: 'https://alice:s3cret@api.test/pay?token=abc123&page=2&api_key=zzz&sig=q' } },
      { key: 'http.target', value: { stringValue: '/cb?code=oauthcode&state=ok&access_token=eyJabcdefghij.klmnopqrst.uvwxyz1234' } },
    ] }).records[0]!;
    const full = s.attrs.find((a) => a.k === 'url.full')!.v;
    expect(full).not.toMatch(/s3cret|abc123|zzz|sig=q/);
    expect(full).toContain('page=2');
    expect(full).toContain('token=[REDACTED]');
    const target = s.attrs.find((a) => a.k === 'http.target')!.v;
    expect(target).not.toMatch(/oauthcode|eyJ/);
    expect(target).toContain('state=ok');
  });
  test('redactUrlText leaves URLs without credentials untouched', () => {
    expect(redactUrlText('https://x.test/a?b=1&c=2')).toEqual({ text: 'https://x.test/a?b=1&c=2', count: 0 });
  });
  test('span names and status messages are scrubbed', () => {
    const s = one({ name: 'GET /x?token=abcdefghijk', status: { code: 2, message: 'failed: Bearer abcdefghijklmnopqrst' } }).records[0]!;
    expect(s.name).not.toContain('abcdefghijk');
    expect(s.statusMessage).not.toContain('abcdefghijklmnopqrst');
  });
  test('redaction can be disabled per token, and per-token extra keys apply', () => {
    const off = one({ attributes: [{ key: 'password', value: { stringValue: 'plain' } }] }, { ...opts, redaction: { enabled: false, extraKeys: [] } }).records[0]!;
    expect(off.attrs[0]!.v).toBe('plain');
    const extra = one({ attributes: [{ key: 'customer.ssn', value: { stringValue: '123' } }] }, { ...opts, redaction: { enabled: true, extraKeys: ['ssn'] } }).records[0]!;
    expect(extra.attrs[0]!.v).toBe('[REDACTED]');
  });
});

describe('protobuf transport', () => {
  test('a protobuf-encoded request decodes to the same drafts as its JSON form (bytes ids, fixed64 nanoseconds)', () => {
    const j = body([span({ status: { code: 2, message: 'x' }, attributes: [{ key: 'a', value: { intValue: '7' } }] })]);
    const s0 = j.resourceSpans[0]!.scopeSpans[0]!.spans[0] as { startTimeUnixNano: string; endTimeUnixNano: string };
    const pb = {
      resource_spans: [{ resource: { attributes: [{ key: 'service.name', value: { string_value: 'gateway' } }] }, scope_spans: [{ scope: { name: 'http' }, spans: [{
        trace_id: Buffer.from(TRACE, 'hex'), span_id: Buffer.from(SPAN, 'hex'), parent_span_id: Buffer.from(PARENT, 'hex'), name: 'GET /orders/:id', kind: 2,
        start_time_unix_nano: s0.startTimeUnixNano, end_time_unix_nano: s0.endTimeUnixNano,
        status: { code: 2, message: 'x' }, attributes: [{ key: 'a', value: { int_value: '7' } }],
      }] }] }],
    };
    const decoded = decodeTracesRequest(encodeTracesRequest(pb));
    const a = otlpTracesToDrafts(decoded, opts).records[0]!;
    const b = otlpTracesToDrafts(j, opts).records[0]!;
    expect(a.traceId).toBe(b.traceId);
    expect(a.spanId).toBe(b.spanId);
    expect(a.parentSpanId).toBe(b.parentSpanId);
    expect(a.durationNs).toBe(b.durationNs);
    expect(a.startNsFrac).toBe(123456);
    expect(a.statusCode).toBe('error');
    expect(a.attrs).toEqual([{ k: 'a', v: '7' }]);
    expect(a.service).toBe('gateway');
  });
  test('garbage bytes raise a decode error rather than crashing', () => {
    expect(() => decodeTracesRequest(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]))).toThrow();
  });
  test('the response reports partial success only when something was refused', () => {
    expect(encodeTracesResponse(0, '').length).toBe(0);
    expect(encodeTracesResponse(3, 'bad ids').length).toBeGreaterThan(0);
  });
});
