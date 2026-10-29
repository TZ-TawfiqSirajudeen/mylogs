import { describe, expect, test } from 'vitest';
import { decodeLogsRequest, encodeLogsRequest, encodeLogsResponse } from './proto.js';
import { jsonLogsToDrafts, parseTimestamp } from './json-logs.js';
import { otlpLogsToDrafts } from './otlp.js';
import { normalizeSpanId, normalizeTraceId, severityFromNumber, severityFromPino, severityFromText, truncateBytes } from './normalize.js';
import { redactAttrs, scrubText } from './redact.js';
import { DEFAULT_LIMITS, type Limits } from './types.js';

const NOW = new Date('2026-03-01T12:00:00.000Z');
const nsOf = (iso: string) => String(BigInt(Date.parse(iso)) * 1_000_000n);
const opts = (over: Partial<Limits> = {}, redaction = { enabled: true, extraKeys: [] as string[] }) => ({ now: NOW, limits: { ...DEFAULT_LIMITS, ...over }, redaction });
const body = (records: object[], resourceAttrs: object[] = [{ key: 'service.name', value: { stringValue: 'checkout' } }]) => ({
  resourceLogs: [{ resource: { attributes: resourceAttrs }, scopeLogs: [{ scope: { name: 'app' }, logRecords: records }] }],
});

describe('severity mapping', () => {
  test.each([[1, 'trace'], [4, 'trace'], [5, 'debug'], [9, 'info'], [13, 'warn'], [17, 'error'], [21, 'fatal'], [24, 'fatal']] as const)('OTLP %s -> %s', (n, s) => expect(severityFromNumber(n)).toBe(s));
  test('0, out of range and missing are unknown (not silently info)', () => {
    for (const n of [0, 25, -1, null, undefined]) expect(severityFromNumber(n as never)).toBeNull();
  });
  test('text and pino levels', () => {
    expect(severityFromText('WARNING')).toBe('warn');
    expect(severityFromText('critical')).toBe('fatal');
    expect(severityFromText('nonsense')).toBeNull();
    expect([10, 20, 30, 40, 50, 60].map(severityFromPino)).toEqual(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
  });
});

describe('ids and text helpers', () => {
  test('trace/span ids must be exact-length non-zero hex', () => {
    expect(normalizeTraceId('0AF7651916CD43DD8448EB211C80319C')).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(normalizeTraceId('0'.repeat(32))).toBeNull();
    expect(normalizeTraceId('short')).toBeNull();
    expect(normalizeTraceId('z'.repeat(32))).toBeNull();
    expect(normalizeSpanId('00f067aa0ba902b7')).toBe('00f067aa0ba902b7');
    expect(normalizeSpanId('0'.repeat(16))).toBeNull();
  });
  test('byte truncation never splits the budget and handles multi-byte text', () => {
    const t = truncateBytes('é'.repeat(100), 51);
    expect(Buffer.byteLength(t.text)).toBeLessThanOrEqual(54);
    expect(t.truncated).toBe(true);
    expect(truncateBytes('ok', 10)).toEqual({ text: 'ok', truncated: false });
  });
  test('JSON timestamps: ISO, epoch seconds, epoch ms, garbage', () => {
    expect(parseTimestamp('2026-03-01T12:00:00Z')?.toISOString()).toBe('2026-03-01T12:00:00.000Z');
    expect(parseTimestamp(1772366400)?.toISOString()).toBe('2026-03-01T12:00:00.000Z');
    expect(parseTimestamp(1772366400000)?.toISOString()).toBe('2026-03-01T12:00:00.000Z');
    expect(parseTimestamp('1772366400')?.toISOString()).toBe('2026-03-01T12:00:00.000Z');
    for (const bad of ['yesterday', '', null, {}, 1, '1970-01-01']) expect(parseTimestamp(bad as never)).toBeNull();
  });
});

describe('OTLP/JSON mapping', () => {
  test('maps a full record into the normalized schema', () => {
    const r = otlpLogsToDrafts(body([{
      timeUnixNano: nsOf('2026-03-01T11:59:59.123Z'), severityNumber: 17, severityText: 'ERROR',
      body: { stringValue: 'payment failed' },
      traceId: '0af7651916cd43dd8448eb211c80319c', spanId: '00f067aa0ba902b7',
      attributes: [
        { key: 'http.request.method', value: { stringValue: 'post' } }, { key: 'http.route', value: { stringValue: '/orders/:id' } },
        { key: 'http.response.status_code', value: { intValue: '500' } }, { key: 'duration_ms', value: { doubleValue: 183.5 } },
        { key: 'exception.type', value: { stringValue: 'TypeError' } }, { key: 'exception.message', value: { stringValue: 'x is undefined' } },
        { key: 'exception.stacktrace', value: { stringValue: 'TypeError: x\n    at f (a.js:1:1)' } },
        { key: 'request.id', value: { stringValue: 'req-123' } }, { key: 'custom.flag', value: { boolValue: true } },
      ],
    }], [{ key: 'service.name', value: { stringValue: 'checkout' } }, { key: 'service.version', value: { stringValue: '1.4.2' } }, { key: 'host.name', value: { stringValue: 'web-1' } }]), opts());
    expect(r.rejected).toBe(0);
    const d = r.records[0]!;
    expect(d).toMatchObject({
      ts: new Date('2026-03-01T11:59:59.123Z'), tsSource: 'event', severity: 'error', level: 4, message: 'payment failed',
      service: 'checkout', serviceVersion: '1.4.2', host: 'web-1', traceId: '0af7651916cd43dd8448eb211c80319c', spanId: '00f067aa0ba902b7',
      requestId: 'req-123', httpMethod: 'POST', httpRoute: '/orders/:id', httpStatus: 500, durationMs: 183.5,
      errorType: 'TypeError', exceptionMessage: 'x is undefined', scope: 'app', source: 'otlp', severityText: 'ERROR',
    });
    expect(d.stack).toContain('at f (a.js');
    // provider-specific fields are preserved, not discarded
    expect(d.attrs.find((a) => a.k === 'custom.flag')?.v).toBe('true');
    expect(d.resource.find((a) => a.k === 'service.name')?.v).toBe('checkout');
  });

  test('absent facts stay null instead of being invented', () => {
    const d = otlpLogsToDrafts(body([{ body: { stringValue: 'bare' } }], []), opts()).records[0]!;
    expect(d).toMatchObject({ service: null, traceId: null, spanId: null, requestId: null, httpStatus: null, httpMethod: null, errorType: null, host: null, durationMs: null });
    expect(d.tsSource).toBe('received'); // no timestamp at all -> receive time, and we say so
    expect(d.ts).toEqual(NOW);
  });

  test('timestamp rules: observed time fallback, future clamp, too old rejected', () => {
    const obs = otlpLogsToDrafts(body([{ observedTimeUnixNano: nsOf('2026-03-01T11:00:00Z'), body: { stringValue: 'a' } }]), opts()).records[0]!;
    expect(obs.tsSource).toBe('observed');
    const fut = otlpLogsToDrafts(body([{ timeUnixNano: nsOf('2026-03-01T14:00:00Z'), body: { stringValue: 'a' } }]), opts()).records[0]!;
    expect(fut.tsAdjusted).toBe('future');
    expect(fut.ts).toEqual(NOW);
    const old = otlpLogsToDrafts(body([{ timeUnixNano: nsOf('2025-01-01T00:00:00Z'), body: { stringValue: 'a' } }]), opts());
    expect(old.records).toHaveLength(0);
    expect(old.rejected).toBe(1);
    expect(old.errors[0]).toMatch(/older than the retention window/);
  });

  test('accepts snake_case (protobuf-decoded) field names too', () => {
    const r = otlpLogsToDrafts({
      resource_logs: [{ resource: { attributes: [{ key: 'service.name', value: { string_value: 'svc' } }] },
        scope_logs: [{ log_records: [{ time_unix_nano: nsOf('2026-03-01T11:00:00Z'), severity_number: 13, body: { int_value: '42' }, trace_id: '0af7651916cd43dd8448eb211c80319c' }] }] }],
    }, opts());
    expect(r.records[0]).toMatchObject({ severity: 'warn', message: '42', service: 'svc', traceId: '0af7651916cd43dd8448eb211c80319c' });
  });

  test('structured bodies and attribute values are stringified, not evaluated', () => {
    const d = otlpLogsToDrafts(body([{
      body: { kvlistValue: { values: [{ key: 'event', value: { stringValue: 'login' } }, { key: 'n', value: { intValue: '3' } }] } },
      attributes: [{ key: 'tags', value: { arrayValue: { values: [{ stringValue: 'a' }, { stringValue: 'b' }] } } }],
    }]), opts()).records[0]!;
    expect(JSON.parse(d.message)).toEqual({ event: 'login', n: '3' });
    expect(d.attrs[0]).toEqual({ k: 'tags', v: '["a","b"]' });
  });

  test('bounds: oversize message, attribute count/key/value, too many records per request', () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ key: `k${i}`, value: { stringValue: 'v'.repeat(9000) } }));
    const d = otlpLogsToDrafts(body([{ body: { stringValue: 'm'.repeat(100_000) }, attributes: many }]), opts()).records[0]!;
    expect(Buffer.byteLength(d.message)).toBeLessThanOrEqual(32 * 1024 + 4);
    expect(d.messageTruncated).toBe(true);
    expect(d.attrs.length).toBeLessThanOrEqual(100);
    expect(d.attrsTruncated).toBe(true);
    expect(d.attrs.every((a) => Buffer.byteLength(a.v) <= 4 * 1024 + 4)).toBe(true);
    const r = otlpLogsToDrafts(body(Array.from({ length: 12 }, () => ({ body: { stringValue: 'x' } }))), opts({ maxRecordsPerRequest: 10 }));
    expect(r.records).toHaveLength(10);
    expect(r.rejected).toBe(2); // reported, not silently dropped
  });

  test('malformed structures are rejected individually and never throw', () => {
    const r = otlpLogsToDrafts({ resourceLogs: [null, 5, { scopeLogs: [null, { logRecords: [null, 'x', { body: { stringValue: 'good' } }] }] }] }, opts());
    expect(r.records).toHaveLength(1);
    expect(r.rejected).toBeGreaterThanOrEqual(4);
    for (const junk of [null, undefined, 'x', 5, [], { resourceLogs: 'no' }]) expect(() => otlpLogsToDrafts(junk, opts())).not.toThrow();
  });

  test('prototype-pollution and control-character payloads are inert', () => {
    const hostile = JSON.parse('{"resourceLogs":[{"__proto__":{"polluted":1},"scopeLogs":[{"logRecords":[{"body":{"stringValue":"x"},"attributes":[{"key":"__proto__","value":{"stringValue":"p"}},{"key":"a\\u0000b\\u0001c","value":{"stringValue":"v\\u0000"}},{"key":"constructor","value":{"stringValue":"c"}}]}]}]}]}');
    const d = otlpLogsToDrafts(hostile, opts()).records[0]!;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(d.attrs.map((a) => a.k)).toContain('__proto__'); // kept as plain data in an ARRAY, never as an object key
    expect(d.attrs.find((a) => a.k.startsWith('a'))?.k).toBe('abc'); // control characters stripped
  });
});

describe('protobuf wire format', () => {
  const request = {
    resource_logs: [{
      resource: { attributes: [{ key: 'service.name', value: { string_value: 'proto-svc' } }] },
      scope_logs: [{ scope: { name: 'lib', version: '1' }, log_records: [{
        time_unix_nano: String(BigInt(Date.parse('2026-03-01T11:00:00Z')) * 1_000_000n), severity_number: 17, severity_text: 'ERROR',
        body: { string_value: 'boom' }, trace_id: Buffer.from('0af7651916cd43dd8448eb211c80319c', 'hex'), span_id: Buffer.from('00f067aa0ba902b7', 'hex'),
        attributes: [{ key: 'http.response.status_code', value: { int_value: '500' } }, { key: 'ok', value: { bool_value: true } }, { key: 'ratio', value: { double_value: 0.5 } }],
      }] }],
    }],
  };

  test('encode -> decode -> map round-trips every field', () => {
    const bytes = encodeLogsRequest(request);
    const decoded = decodeLogsRequest(bytes);
    const d = otlpLogsToDrafts(decoded, opts()).records[0]!;
    expect(d).toMatchObject({ service: 'proto-svc', severity: 'error', message: 'boom', httpStatus: 500, scope: 'lib' });
    expect(d.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(d.spanId).toBe('00f067aa0ba902b7');
    expect(d.ts).toEqual(new Date('2026-03-01T11:00:00Z'));
    expect(d.attrs.find((a) => a.k === 'ratio')?.v).toBe('0.5');
  });

  test('garbage and truncated protobuf raise a decode error, never crash', () => {
    expect(() => decodeLogsRequest(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]))).toThrow();
    const bytes = encodeLogsRequest(request);
    expect(() => decodeLogsRequest(bytes.slice(0, bytes.length - 7))).toThrow();
  });

  test('partial-success response encodes the rejected count', () => {
    expect(encodeLogsResponse(0, '').length).toBe(0);
    expect(encodeLogsResponse(3, 'bad').length).toBeGreaterThan(0);
  });
});

describe('generic JSON logs', () => {
  test('pino-style records (numeric level, msg, time, req/res)', () => {
    const r = jsonLogsToDrafts(JSON.stringify({ level: 50, time: 1772362800000, msg: 'request failed', service: 'api', req: { method: 'GET', id: 'r-9' }, res: { statusCode: 500 }, responseTime: 87 }), opts());
    expect(r.records[0]).toMatchObject({ severity: 'error', message: 'request failed', service: 'api', httpMethod: 'GET', httpStatus: 500, requestId: 'r-9', durationMs: 87, source: 'json' });
    expect(r.records[0]!.ts).toEqual(new Date(1772362800000));
  });

  test('winston/ECS-style records and arrays, wrapper objects and NDJSON', () => {
    const one = { '@timestamp': '2026-03-01T11:00:00Z', level: 'warn', message: 'slow query', trace_id: '0af7651916cd43dd8448eb211c80319c', 'service.name': 'db' };
    expect(jsonLogsToDrafts([one, one] as never, opts()).records).toHaveLength(2);
    expect(jsonLogsToDrafts({ logs: [one] }, opts()).records).toHaveLength(1);
    const nd = jsonLogsToDrafts(`${JSON.stringify(one)}\n${JSON.stringify({ ...one, message: 'b' })}\nnot json\n`, opts());
    expect(nd.records).toHaveLength(2);
    expect(nd.rejected).toBe(1);
    expect(nd.records[0]).toMatchObject({ severity: 'warn', traceId: '0af7651916cd43dd8448eb211c80319c', service: 'db' });
  });

  test('non-objects and oversized batches are rejected and counted', () => {
    const r = jsonLogsToDrafts([1, 'x', null, { message: 'ok' }] as never, opts());
    expect(r.records).toHaveLength(1);
    expect(r.rejected).toBe(3);
    const big = jsonLogsToDrafts(Array.from({ length: 5 }, () => ({ message: 'x' })) as never, opts({ maxRecordsPerRequest: 3 }));
    expect(big.records).toHaveLength(3);
    expect(big.rejected).toBe(2);
  });

  test('empty and whitespace bodies are not errors', () => {
    expect(jsonLogsToDrafts('   ', opts())).toEqual({ records: [], rejected: 0, errors: [] });
  });
});

describe('redaction', () => {
  test.each([
    ['Authorization: Bearer abcdefghijklmnop1234567890', 'abcdefghijklmnop1234567890'],
    ['token=sk_live_51H8abcdefghijkl', 'sk_live_51H8abcdefghijkl'],
    ['password: "hunter2hunter2"', 'hunter2hunter2'],
    ['connecting to mongodb://admin:p@ssw0rd@db:27017/x', 'p@ssw0rd'],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk', 'eyJhbGciOiJIUzI1NiJ9'],
    ['key AKIAIOSFODNN7EXAMPLE leaked', 'AKIAIOSFODNN7EXAMPLE'],
    ['api_key=AbCdEf123456&other=1', 'AbCdEf123456'],
    ['stripe said sk_live_abcdefghijklmnop was invalid', 'sk_live_abcdefghijklmnop'],
    ['clone failed ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789'],
    ['slack xoxb-1234567890-abcdefghij', 'xoxb-1234567890-abcdefghij'],
    ['-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\n-----END RSA PRIVATE KEY-----', 'MIIEabc'],
  ])('scrubs credential-shaped text: %s', (input, secret) => {
    const r = scrubText(input);
    expect(r.text).not.toContain(secret);
    expect(r.count).toBeGreaterThan(0);
  });

  test('leaves ordinary text, ids and URLs alone', () => {
    for (const ok of ['user 42 logged in', 'GET https://example.com/a?b=c 200', 'trace 0af7651916cd43dd8448eb211c80319c', 'token count is 7', 'order #1234 shipped']) {
      expect(scrubText(ok)).toEqual({ text: ok, count: 0 });
    }
  });

  test('sensitive attribute KEYS are masked whatever the value; extra keys are honoured', () => {
    const { attrs, count } = redactAttrs([
      { k: 'http.request.header.authorization', v: 'Bearer abc' }, { k: 'http.request.header.cookie', v: 'sid=1' }, { k: 'user.password', v: 'x' },
      { k: 'db.connection_string', v: 'mongodb://h' }, { k: 'X-Api-Key', v: 'k' }, { k: 'customer.ssn', v: '123-45-6789' }, { k: 'http.route', v: '/ok' }, { k: 'author', v: 'kim' },
    ], { enabled: true, extraKeys: ['customer.ssn'] });
    const m = Object.fromEntries(attrs.map((a) => [a.k, a.v]));
    for (const k of ['http.request.header.authorization', 'http.request.header.cookie', 'user.password', 'db.connection_string', 'X-Api-Key', 'customer.ssn']) expect(m[k], k).toBe('[REDACTED]');
    expect(m['http.route']).toBe('/ok');
    expect(m.author).toBe('kim'); // "author" must not be mistaken for "auth"
    expect(count).toBe(6);
  });

  test('full pipeline: secrets in message, attributes, stack and exception text never survive', () => {
    const secret = 'sk_live_abcdefghijklmnop';
    const r = otlpLogsToDrafts(body([{
      body: { stringValue: `charge failed token=${secret} for user 7` },
      attributes: [
        { key: 'http.request.header.authorization', value: { stringValue: `Bearer ${secret}` } },
        { key: 'exception.message', value: { stringValue: `bad key ${secret}` } },
        { key: 'exception.stacktrace', value: { stringValue: `Error: password=${secret}\n at x` } },
        { key: 'url', value: { stringValue: `https://u:${secret}@api.example.com/x` } },
      ],
    }]), opts());
    expect(r.records[0]!.redactions).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(r.records[0])).not.toContain(secret);
  });

  test('redaction can be disabled by policy (and nothing is changed)', () => {
    const d = otlpLogsToDrafts(body([{ body: { stringValue: 'token=abcdefghijk' } }]), opts({}, { enabled: false, extraKeys: [] })).records[0]!;
    expect(d.message).toBe('token=abcdefghijk');
    expect(d.redactions).toBe(0);
  });
});
