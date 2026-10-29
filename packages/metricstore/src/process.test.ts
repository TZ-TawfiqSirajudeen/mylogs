import type { MetricPointDraft } from '@nexus/telemetry';
import { describe, expect, test } from 'vitest';
import { addBuckets, histogramQuantile } from './histogram.js';
import { FIRST_POINT_MAX_AGE_MS, processSeriesPoints, type SeriesState } from './process.js';

const T0 = Date.parse('2026-03-01T12:00:00Z');
const at = (sec: number) => new Date(T0 + sec * 1000);
const none: SeriesState = { lastPoint: null, cumulative: null, recent: [] };
const pt = (over: Partial<MetricPointDraft>): MetricPointDraft => ({
  name: 'm', unit: null, description: null, type: 'sum', temporality: 'delta', monotonic: true, service: 's', serviceVersion: null, instance: null, attrs: [],
  time: at(0), startTime: null, value: 0, count: 1, sum: 0, min: null, max: null, bounds: null, buckets: null, exemplars: [], ...over,
});
const total = (r: ReturnType<typeof processSeriesPoints>) => [...r.aggs.values()].reduce((n, a) => n + a.sum, 0);

describe('gauge', () => {
  const g = { type: 'gauge' as const, temporality: null, monotonic: null, bounds: null };
  test('keeps count, sum, min, max and the NEWEST value per minute, whatever the arrival order inside the batch', () => {
    const r = processSeriesPoints(g, none, [pt({ type: 'gauge', time: at(5), value: 4 }), pt({ type: 'gauge', time: at(10), value: 9 }), pt({ type: 'gauge', time: at(20), value: 2 })]);
    const a = [...r.aggs.values()][0]!;
    expect(a).toMatchObject({ count: 3, sum: 15, min: 2, max: 9, last: 2 });
    expect(a.lastAt).toEqual(at(20));
    expect(r.accepted).toBe(3);
  });
  test('observations in different minutes land in different buckets', () => {
    const r = processSeriesPoints(g, none, [pt({ type: 'gauge', time: at(10), value: 1 }), pt({ type: 'gauge', time: at(70), value: 2 })]);
    expect(r.aggs.size).toBe(2);
  });
});

describe('duplicates: retransmissions are ignored, out-of-order data is not', () => {
  const s = { type: 'sum' as const, temporality: 'delta' as const, monotonic: true, bounds: null };
  test('a delta point whose timestamp was already accepted is a duplicate and changes nothing', () => {
    const first = processSeriesPoints(s, none, [pt({ time: at(30), value: 5 })]);
    const again = processSeriesPoints(s, first.state, [pt({ time: at(30), value: 5 })]);
    expect(again.duplicates).toBe(1);
    expect(again.accepted).toBe(0);
    expect(total(again)).toBe(0);
  });
  test('a NEW point that arrives after a newer one (out-of-order batches) is still accepted: nothing is lost', () => {
    const newer = processSeriesPoints(s, none, [pt({ time: at(90), value: 7 })]);
    const older = processSeriesPoints(s, newer.state, [pt({ time: at(30), value: 5 })]);
    expect(older.accepted).toBe(1);
    expect(total(older)).toBe(5);
    expect(older.state.lastPoint).toEqual(at(90)); // the newest time is kept
  });
  test('only a bounded memory of recent timestamps is kept', () => {
    const many = processSeriesPoints(s, none, Array.from({ length: 300 }, (_, i) => pt({ time: at(i), value: 1 })));
    expect(many.state.recent).toHaveLength(128);
    expect(many.state.recent.at(-1)).toBe(at(299).getTime());
  });
  test('cumulative series reject points that are not newer (an older total adds no information)', () => {
    const cs = { type: 'sum' as const, temporality: 'cumulative' as const, monotonic: true, bounds: null };
    const a = processSeriesPoints(cs, none, [pt({ temporality: 'cumulative', time: at(60), value: 10, startTime: at(-3600) })]);
    const b = processSeriesPoints(cs, a.state, [pt({ temporality: 'cumulative', time: at(30), value: 5, startTime: at(-3600) }), pt({ temporality: 'cumulative', time: at(60), value: 10, startTime: at(-3600) })]);
    expect(b.duplicates).toBe(2);
    expect(b.accepted).toBe(0);
  });
});

describe('delta sums', () => {
  const s = { type: 'sum' as const, temporality: 'delta' as const, monotonic: true, bounds: null };
  test('each point is the increment of its interval', () => {
    expect(total(processSeriesPoints(s, none, [pt({ time: at(10), value: 3 }), pt({ time: at(20), value: 4 })]))).toBe(7);
  });
});

describe('cumulative sums become increases (never confused with delta)', () => {
  const s = { type: 'sum' as const, temporality: 'cumulative' as const, monotonic: true, bounds: null };
  const c = (sec: number, value: number, startSec: number | null = -3600) => pt({ temporality: 'cumulative', time: at(sec), value, startTime: startSec === null ? null : at(startSec) });
  test('the first point of an old counter is only a baseline (its history is unknown)', () => {
    const r = processSeriesPoints(s, none, [c(10, 1000)]);
    expect(total(r)).toBe(0);
    expect(r.baselines).toBe(1);
    expect(r.state.cumulative).toMatchObject({ value: 1000 });
  });
  test('later points yield value differences', () => {
    const r1 = processSeriesPoints(s, none, [c(10, 1000)]);
    const r2 = processSeriesPoints(s, r1.state, [c(70, 1010), c(130, 1025)]);
    expect(total(r2)).toBe(25);
  });
  test('a counter that started moments ago counts its whole value at the first point', () => {
    const r = processSeriesPoints(s, none, [c(10, 42, 0)]);
    expect(total(r)).toBe(42);
    expect(FIRST_POINT_MAX_AGE_MS).toBe(300_000);
    expect(total(processSeriesPoints(s, none, [c(1000, 42, 0)]))).toBe(0); // started 1000 s earlier: could have missed history
  });
  test('a restart (new start time) is a reset: the new value is the increase, never a negative number', () => {
    const r1 = processSeriesPoints(s, none, [c(10, 1000), c(70, 1100)]);
    const r2 = processSeriesPoints(s, r1.state, [c(130, 20, 100)]);
    expect(r2.resets).toBe(1);
    expect(total(r2)).toBe(20);
  });
  test('a monotonic counter that goes down without a new start time is also a reset', () => {
    const r = processSeriesPoints(s, processSeriesPoints(s, none, [c(10, 500)]).state, [c(70, 30)]);
    expect(r.resets).toBe(1);
    expect(total(r)).toBe(30);
  });
  test('a NON-monotonic cumulative sum may legitimately decrease', () => {
    const nm = { ...s, monotonic: false };
    const r = processSeriesPoints(nm, processSeriesPoints(nm, none, [pt({ temporality: 'cumulative', monotonic: false, time: at(10), value: 50, startTime: at(-3600) })]).state,
      [pt({ temporality: 'cumulative', monotonic: false, time: at(70), value: 45, startTime: at(-3600) })]);
    expect(r.resets).toBe(0);
    expect(total(r)).toBe(-5);
  });
  test('state carries across batches exactly like one batch', () => {
    const oneBatch = processSeriesPoints(s, none, [c(10, 100), c(70, 130), c(130, 170)]);
    const a = processSeriesPoints(s, none, [c(10, 100)]);
    const b = processSeriesPoints(s, a.state, [c(70, 130), c(130, 170)]);
    expect(total(b)).toBe(total(oneBatch));
    expect(b.state).toEqual(oneBatch.state);
  });
});

describe('histograms', () => {
  const h = { type: 'histogram' as const, temporality: 'delta' as const, monotonic: null, bounds: [1, 5] };
  const hp = (sec: number, buckets: number[], sum: number, over: Partial<MetricPointDraft> = {}) =>
    pt({ type: 'histogram', temporality: 'delta', monotonic: null, bounds: [1, 5], time: at(sec), buckets, count: buckets.reduce((a, b) => a + b, 0), sum, ...over });
  test('delta histograms merge bucket by bucket, with counts and sums', () => {
    const r = processSeriesPoints(h, none, [hp(10, [1, 2, 3], 20, { min: 0.5, max: 9 }), hp(20, [4, 0, 1], 8, { min: 0.1, max: 6 })]);
    const a = [...r.aggs.values()][0]!;
    expect(a).toMatchObject({ count: 11, sum: 28, buckets: [5, 2, 4], min: 0.1, max: 9 });
  });
  test('cumulative histograms become per-interval distributions; resets are detected', () => {
    const cs = { ...h, temporality: 'cumulative' as const };
    const cp = (sec: number, buckets: number[], sum: number, startSec = -3600) => hp(sec, buckets, sum, { temporality: 'cumulative', startTime: at(startSec) });
    const base = processSeriesPoints(cs, none, [cp(10, [10, 10, 10], 100)]);
    expect([...base.aggs.values()].reduce((n, a) => n + a.count, 0)).toBe(0);
    const next = processSeriesPoints(cs, base.state, [cp(70, [12, 10, 11], 112)]);
    const a = [...next.aggs.values()][0]!;
    expect(a).toMatchObject({ count: 3, sum: 12, buckets: [2, 0, 1] });
    const restarted = processSeriesPoints(cs, next.state, [cp(130, [1, 0, 0], 0.5, 100)]);
    expect(restarted.resets).toBe(1);
    expect([...restarted.aggs.values()][0]).toMatchObject({ count: 1, buckets: [1, 0, 0] });
  });
  test('exemplars are bounded per minute and keep the newest', () => {
    const ex = (i: number) => ({ traceId: 'a'.repeat(32), spanId: null, value: i, ts: at(i) });
    const r = processSeriesPoints(h, none, Array.from({ length: 4 }, (_, i) => hp(10 + i, [1, 0, 0], 1, { exemplars: [ex(i), ex(i + 10)] })));
    const a = [...r.aggs.values()][0]!;
    expect(a.exemplars).toHaveLength(5);
    expect(a.exemplars.at(-1)!.value).toBe(13);
  });
});

describe('histogramQuantile', () => {
  test('interpolates linearly inside the bucket that holds the rank', () => {
    // 100 observations, evenly in (0,1], (1,5], (5,10]
    const q = histogramQuantile([1, 5, 10], [10, 40, 50, 0], 0.5)!;
    expect(q.value).toBeCloseTo(5 + 5 * (50 - 50) / 50 + 0, 0); // the median sits at the bucket edge
    expect(histogramQuantile([1, 5, 10], [10, 40, 50, 0], 0.25)!.value).toBeCloseTo(1 + 4 * (25 - 10) / 40, 6);
  });
  test('merging distributions is not the same as averaging percentiles (the classic mistake)', () => {
    const bounds = [10, 100, 1000];
    const fastService = [1000, 0, 0, 0];   // 1000 requests, all < 10 ms
    const slowService = [0, 0, 10, 0];     // 10 requests, 100-1000 ms
    const p95Fast = histogramQuantile(bounds, fastService, 0.95)!.value;
    const p95Slow = histogramQuantile(bounds, slowService, 0.95)!.value;
    const merged = histogramQuantile(bounds, addBuckets(fastService, slowService), 0.95)!.value;
    expect(merged).toBeLessThan(10); // 99% of all traffic is fast
    expect((p95Fast + p95Slow) / 2).toBeGreaterThan(100); // averaging the two p95s would claim a slow service overall
  });
  test('an empty histogram has no percentile (not zero)', () => { expect(histogramQuantile([1, 2], [0, 0, 0], 0.95)).toBeNull(); });
  test('values in the open-ended last bucket are reported as a floor, or clamped to the observed maximum', () => {
    expect(histogramQuantile([1, 5], [0, 0, 10], 0.99)).toMatchObject({ value: 5, atLeast: true });
    expect(histogramQuantile([1, 5], [0, 0, 10], 0.5, { max: 8 })!.value).toBeCloseTo(6.5, 6);
  });
  test('rejects inconsistent shapes and out-of-range quantiles', () => {
    expect(histogramQuantile([1, 2], [1, 1], 0.5)).toBeNull();
    expect(histogramQuantile([1], [1, 1], 1.5)).toBeNull();
  });
});
