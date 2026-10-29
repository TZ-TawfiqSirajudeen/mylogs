import { describe, expect, test } from 'vitest';
import { DEFAULT_LIMITS, decodeMetricsRequest, encodeMetricsRequest, otlpMetricsToPoints } from './index.js';

const now = new Date('2026-10-28T12:00:00.000Z');
const opts = { now, limits: DEFAULT_LIMITS, redaction: { enabled: true, extraKeys: [] as string[] } };
const ns = (msAgo: number) => String(BigInt(now.getTime() - msAgo) * 1_000_000n);
const res = [{ key: 'service.name', value: { stringValue: 'gateway' } }];
const wrap = (metrics: unknown[]) => ({ resourceMetrics: [{ resource: { attributes: res }, scopeMetrics: [{ scope: { name: 'm' }, metrics }] }] });
const labels = (o: Record<string, string>) => Object.entries(o).map(([key, v]) => ({ key, value: { stringValue: v } }));
const hist = (over: object = {}, dp: object = {}) => ({ name: 'http.server.request.duration', unit: 's', histogram: { aggregationTemporality: 1, dataPoints: [{
  startTimeUnixNano: ns(61000), timeUnixNano: ns(1000), count: '10', sum: 2.5, bucketCounts: ['4', '3', '2', '1'], explicitBounds: [0.1, 0.5, 1], min: 0.01, max: 3,
  attributes: labels({ 'http.route': '/orders/:id', 'http.response.status_code': '200' }), ...dp }], ...over } });

describe('supported types', () => {
  test('gauge', () => {
    const r = otlpMetricsToPoints(wrap([{ name: 'queue.depth', unit: '{items}', gauge: { dataPoints: [{ timeUnixNano: ns(500), asInt: '42' }] } }]), opts);
    expect(r.points).toHaveLength(1);
    expect(r.points[0]).toMatchObject({ name: 'queue.depth', type: 'gauge', value: 42, temporality: null, service: 'gateway', unit: '{items}' });
  });
  test.each([[1, 'delta'], [2, 'cumulative'], ['AGGREGATION_TEMPORALITY_CUMULATIVE', 'cumulative']])('sum with temporality %s -> %s, monotonic flag kept', (t, expected) => {
    const r = otlpMetricsToPoints(wrap([{ name: 'requests', sum: { aggregationTemporality: t, isMonotonic: true, dataPoints: [{ timeUnixNano: ns(500), asDouble: 7.5 }] } }]), opts);
    expect(r.points[0]).toMatchObject({ type: 'sum', temporality: expected, monotonic: true, value: 7.5 });
  });
  test('histogram keeps bucket counts, bounds, count, sum, min and max', () => {
    const p = otlpMetricsToPoints(wrap([hist()]), opts).points[0]!;
    expect(p).toMatchObject({ type: 'histogram', temporality: 'delta', count: 10, sum: 2.5, bounds: [0.1, 0.5, 1], buckets: [4, 3, 2, 1], min: 0.01, max: 3 });
  });
  test('a count/sum-only histogram becomes one catch-all bucket', () => {
    const p = otlpMetricsToPoints(wrap([hist({}, { bucketCounts: [], explicitBounds: [], count: '5' })]), opts).points[0]!;
    expect(p.buckets).toEqual([5]);
  });
  test('exemplars with a trace id are kept (bounded); others are dropped', () => {
    const t = 'a'.repeat(32), s = 'b'.repeat(16);
    const ex = [{ timeUnixNano: ns(900), asDouble: 2.2, traceId: t, spanId: s }, { timeUnixNano: ns(900), asDouble: 1, traceId: 'bad' }, ...Array.from({ length: 5 }, () => ({ timeUnixNano: ns(900), asDouble: 1, traceId: t }))];
    const p = otlpMetricsToPoints(wrap([hist({}, { exemplars: ex })]), opts).points[0]!;
    expect(p.exemplars[0]).toMatchObject({ traceId: t, spanId: s, value: 2.2 });
    expect(p.exemplars.length).toBe(3);
  });
});

describe('refusals are explicit', () => {
  test('exponential histograms and summaries are counted as unsupported, never approximated', () => {
    const r = otlpMetricsToPoints(wrap([
      { name: 'a', exponentialHistogram: { aggregationTemporality: 1, dataPoints: [{}, {}] } }, { name: 'b', summary: { dataPoints: [{}] } },
      { name: 'ok', gauge: { dataPoints: [{ timeUnixNano: ns(500), asInt: '1' }] } },
    ]), opts);
    expect(r.points).toHaveLength(1);
    expect(r.rejected).toBe(3);
    expect(r.unsupported).toBe(3);
    expect(r.errors.join(' ')).toMatch(/exponential histograms are not supported/);
  });
  test('unspecified temporality is refused (cumulative and delta must never be mixed up)', () => {
    const r = otlpMetricsToPoints(wrap([{ name: 'x', sum: { aggregationTemporality: 0, dataPoints: [{ timeUnixNano: ns(500), asInt: '1' }] } }]), opts);
    expect(r.points).toHaveLength(0);
    expect(r.unsupported).toBe(1);
  });
  test.each([
    ['bucket/bound length mismatch', hist({}, { bucketCounts: ['4', '3'] })], ['count != sum of buckets', hist({}, { count: '11' })],
    ['non-increasing bounds', hist({}, { explicitBounds: [1, 0.5, 2] })], ['negative bucket', hist({}, { bucketCounts: ['-1', '3', '2', '1'] })],
  ])('invalid histogram: %s', (_n, m) => {
    const r = otlpMetricsToPoints(wrap([m]), opts);
    expect(r.points).toHaveLength(0);
    expect(r.rejected).toBe(1);
  });
  test.each([['no timestamp', {}], ['ancient timestamp', { timeUnixNano: ns(40 * 86_400_000) }], ['future timestamp', { timeUnixNano: ns(-3_600_000) }]])('data point with %s', (_n, dp) => {
    const r = otlpMetricsToPoints(wrap([{ name: 'g', gauge: { dataPoints: [{ asInt: '1', ...dp }] } }]), opts);
    expect(r.points).toHaveLength(0);
    expect(r.rejected).toBe(1);
  });
  test('non-finite values, invalid names and junk never throw', () => {
    const r = otlpMetricsToPoints(wrap([
      { name: 'g', gauge: { dataPoints: [{ timeUnixNano: ns(500), asDouble: 'NaN' }] } },
      { name: '1 bad name!', gauge: { dataPoints: [{ timeUnixNano: ns(500), asInt: '1' }] } }, null, 5,
    ]), opts);
    expect(r.points).toHaveLength(0);
    expect(r.rejected).toBeGreaterThanOrEqual(3);
    expect(otlpMetricsToPoints('x', opts).points).toEqual([]);
  });
});

describe('cardinality policy', () => {
  test('unbounded labels are dropped, route templates are kept, labels are sorted and bounded', () => {
    const lab = labels({ 'http.route': '/orders/:id', 'url.full': 'https://x/y?z=1', 'user.id': 'u1', 'client.address': '1.2.3.4', zeta: 'z', alpha: 'a' });
    const r = otlpMetricsToPoints(wrap([{ name: 'c', sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [{ timeUnixNano: ns(500), asInt: '1', attributes: lab }] } }]), opts);
    expect(r.points[0]!.attrs.map((a) => a.k)).toEqual(['alpha', 'http.route', 'zeta']);
    expect(r.droppedLabels).toBe(3);
  });
  test('too many labels and over-long values are bounded deterministically; credential-named labels are masked', () => {
    const many = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`k${String(i).padStart(2, '0')}`, 'v'.repeat(500)]));
    const r = otlpMetricsToPoints(wrap([{ name: 'c', gauge: { dataPoints: [{ timeUnixNano: ns(500), asInt: '1', attributes: labels({ ...many, 'api.token': 'secretvalue' }) }] } }]), opts);
    const p = r.points[0]!;
    expect(p.attrs.length).toBe(12);
    expect(p.attrs.every((a) => a.v.length <= 128)).toBe(true);
    expect(JSON.stringify(p.attrs)).not.toContain('secretvalue');
  });
});

describe('protobuf transport', () => {
  test('a protobuf histogram and sum round-trip with int64/fixed64 values intact', () => {
    const pb = { resource_metrics: [{ resource: { attributes: [{ key: 'service.name', value: { string_value: 'gateway' } }] }, scope_metrics: [{ metrics: [{
      name: 'http.server.request.duration', unit: 's', histogram: { aggregation_temporality: 1, data_points: [{
        start_time_unix_nano: ns(61000), time_unix_nano: ns(1000), count: 10, sum: 2.5, bucket_counts: [4, 3, 2, 1], explicit_bounds: [0.1, 0.5, 1],
        attributes: [{ key: 'http.route', value: { string_value: '/x' } }],
        exemplars: [{ time_unix_nano: ns(900), as_double: 0.7, trace_id: Buffer.from('a'.repeat(32), 'hex'), span_id: Buffer.from('b'.repeat(16), 'hex') }],
      }] },
    }, { name: 'cnt', sum: { aggregation_temporality: 2, is_monotonic: true, data_points: [{ time_unix_nano: ns(1000), as_int: 123456789012 }] } }] }] }] };
    const r = otlpMetricsToPoints(decodeMetricsRequest(encodeMetricsRequest(pb)), opts);
    expect(r.rejected).toBe(0);
    const h = r.points.find((p) => p.type === 'histogram')!;
    expect(h).toMatchObject({ count: 10, sum: 2.5, buckets: [4, 3, 2, 1], bounds: [0.1, 0.5, 1], temporality: 'delta' });
    expect(h.exemplars[0]).toMatchObject({ traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), value: 0.7 });
    expect(r.points.find((p) => p.type === 'sum')).toMatchObject({ value: 123456789012, temporality: 'cumulative', monotonic: true });
  });
});
