import type { SpanDto } from '@nexus/contracts';
import { describe, expect, test } from 'vitest';
import { axisTicks, buildWaterfall, formatNs, FULL, project, zoomTo } from './waterfall-model';

const T0 = 1_700_000_000_000_000_000n; // a plausible epoch in ns (> 2^53: precision matters)
const sid = (n: number) => n.toString(16).padStart(16, '0');
function sp(n: number, over: Partial<SpanDto> & { startNs?: number; durNs?: number | null } = {}): SpanDto {
  const { startNs = 0, durNs = 1_000_000, ...rest } = over;
  const valid = durNs !== null;
  return {
    traceId: 'a'.repeat(32), spanId: sid(n), parentSpanId: null, environmentId: 'e', name: `op-${n}`, kind: 'internal', statusCode: 'unset', statusMessage: null,
    service: 'svc', serviceVersion: null, host: null, deployment: null,
    startUnixNano: String(T0 + BigInt(startNs)), endUnixNano: String(T0 + BigInt(startNs) + BigInt(valid ? durNs : 0)), durationNs: durNs, timingValid: valid,
    httpMethod: null, httpRoute: null, httpStatus: null, dbSystem: null, peerService: null, exceptionType: null, scopeName: null, scopeVersion: null, traceState: null, flags: null,
    attrs: [], resource: [], events: [], links: [], droppedAttrs: 0, droppedEvents: 0, droppedLinks: 0, attrsTruncated: false, redactions: 0, ...rest,
  };
}
const ids = (m: ReturnType<typeof buildWaterfall>) => m.rows.map((r) => r.span.spanId);

describe('hierarchy', () => {
  test('children follow their parent depth-first, siblings in start order', () => {
    const m = buildWaterfall([
      sp(1, { durNs: 10_000_000 }), sp(3, { parentSpanId: sid(1), startNs: 5_000_000 }), sp(2, { parentSpanId: sid(1), startNs: 1_000_000 }), sp(4, { parentSpanId: sid(2), startNs: 1_500_000 }),
    ]);
    expect(ids(m)).toEqual([sid(1), sid(2), sid(4), sid(3)]);
    expect(m.rows.map((r) => r.depth)).toEqual([0, 1, 2, 1]);
    expect(m.issues).toEqual([]);
    expect(m.parents.sort()).toEqual([sid(1), sid(2)].sort());
  });
  test('a missing parent makes an orphan root and an explicit notice; it is never attached to a guess', () => {
    const m = buildWaterfall([sp(2, { parentSpanId: sid(99) }), sp(3, { parentSpanId: sid(2), startNs: 100 })]);
    expect(m.rows[0]).toMatchObject({ orphan: true, depth: 0 });
    expect(m.rows[1]).toMatchObject({ orphan: false, depth: 1 });
    expect(m.issues.join(' ')).toMatch(/No root span was received/);
    expect(m.issues.join(' ')).toMatch(/parent was not received/);
  });
  test('cyclic or self-referencing parents (invalid data) are shown, not lost, and cannot hang the layout', () => {
    const m = buildWaterfall([sp(1, { parentSpanId: sid(2) }), sp(2, { parentSpanId: sid(1), startNs: 10 }), sp(3, { parentSpanId: sid(3), startNs: 20 })]);
    expect(m.rows).toHaveLength(3);
    expect(m.issues.join(' ')).toMatch(/refer to each other/);
    expect(m.rows.find((r) => r.span.spanId === sid(3))!.orphan).toBe(true);
  });
  test('an empty trace is explained', () => { expect(buildWaterfall([]).issues[0]).toMatch(/no spans/); });
});

describe('time axis: positions come only from timestamps', () => {
  test('overlapping siblings overlap on the axis (no sequential assumption)', () => {
    const m = buildWaterfall([sp(1, { durNs: 10_000_000 }), sp(2, { parentSpanId: sid(1), startNs: 1_000_000, durNs: 6_000_000 }), sp(3, { parentSpanId: sid(1), startNs: 3_000_000, durNs: 6_000_000 })]);
    const [, a, b] = m.rows;
    expect(a!.left).toBeCloseTo(0.1, 9);
    expect(b!.left).toBeCloseTo(0.3, 9);
    expect(a!.left + a!.width).toBeGreaterThan(b!.left); // they overlap
  });
  test('exact nanosecond offsets survive timestamps beyond 2^53', () => {
    const m = buildWaterfall([sp(1, { startNs: 0, durNs: 1_000_000_000 }), sp(2, { parentSpanId: sid(1), startNs: 123_456_789, durNs: 1 })]);
    expect(m.rows[1]!.offsetNs).toBe(123_456_789);
    expect(m.rows[1]!.durationNs).toBe(1);
    expect(m.traceDurationNs).toBe(1_000_000_000);
  });
  test('the trace window is the earliest start to the latest VALID end, even when the root is missing', () => {
    const m = buildWaterfall([sp(2, { parentSpanId: sid(1), startNs: 5_000_000, durNs: 2_000_000 }), sp(3, { parentSpanId: sid(1), startNs: 9_000_000, durNs: 3_000_000 })]);
    expect(m.traceDurationNs).toBe(7_000_000);
    expect(m.rows[0]!.left).toBe(0);
  });
  test('a span with no valid end is a point at its start with an unknown duration, and does not stretch the window', () => {
    const m = buildWaterfall([sp(1, { durNs: 4_000_000 }), sp(2, { parentSpanId: sid(1), startNs: 1_000_000, durNs: null })]);
    const bad = m.rows[1]!;
    expect(bad).toMatchObject({ durationNs: null, width: 0, slow: false });
    expect(m.traceDurationNs).toBe(4_000_000);
    expect(m.issues.join(' ')).toMatch(/no valid end time/);
  });
  test('a child that starts before its parent (clock skew) is shown where it says it is, and flagged', () => {
    const m = buildWaterfall([sp(1, { startNs: 5_000_000, durNs: 5_000_000 }), sp(2, { parentSpanId: sid(1), startNs: 2_000_000, durNs: 1_000_000 })]);
    const child = m.rows.find((r) => r.span.spanId === sid(2))!;
    expect(child.startsBeforeParent).toBe(true);
    expect(child.offsetNs).toBe(0); // it IS the earliest event in the trace
    expect(m.issues.join(' ')).toMatch(/before .* parent|before their parent|before its parent/);
  });
  test('work that outlives its parent is flagged as such, not clipped', () => {
    const m = buildWaterfall([sp(1, { durNs: 2_000_000 }), sp(2, { parentSpanId: sid(1), startNs: 1_000_000, durNs: 5_000_000 })]);
    expect(m.rows[1]!.endsAfterParent).toBe(true);
    expect(m.traceDurationNs).toBe(6_000_000);
  });
  test('a zero-duration trace still has a positive window (no division by zero)', () => {
    const m = buildWaterfall([sp(1, { durNs: 0 })]);
    expect(m.traceDurationNs).toBe(1);
    expect(Number.isFinite(m.rows[0]!.left)).toBe(true);
    expect(Number.isFinite(m.rows[0]!.width)).toBe(true);
  });
});

describe('flags', () => {
  test('failed = error status; slow = at least half of the trace; single-span traces are never "slow"', () => {
    const m = buildWaterfall([sp(1, { durNs: 10_000_000 }), sp(2, { parentSpanId: sid(1), startNs: 1_000_000, durNs: 6_000_000, statusCode: 'error' }), sp(3, { parentSpanId: sid(1), startNs: 8_000_000, durNs: 1_000_000 })]);
    expect(m.rows.map((r) => [r.failed, r.slow])).toEqual([[false, true], [true, true], [false, false]]);
    expect(buildWaterfall([sp(1)]).rows[0]!.slow).toBe(false);
  });
});

describe('collapse', () => {
  test('collapsing a span hides its subtree and reports how many spans are hidden', () => {
    const spans = [sp(1, { durNs: 10_000_000 }), sp(2, { parentSpanId: sid(1), startNs: 1 }), sp(3, { parentSpanId: sid(2), startNs: 2 }), sp(4, { parentSpanId: sid(2), startNs: 3 }), sp(5, { parentSpanId: sid(1), startNs: 9 })];
    const m = buildWaterfall(spans, new Set([sid(2)]));
    expect(ids(m)).toEqual([sid(1), sid(2), sid(5)]);
    expect(m.rows[1]).toMatchObject({ collapsed: true, descendants: 2, hasChildren: true });
    expect(buildWaterfall(spans, new Set([sid(1)])).rows).toHaveLength(1);
    expect(buildWaterfall(spans, new Set([sid(5)])).rows).toHaveLength(5); // collapsing a leaf changes nothing
  });
});

describe('zoom', () => {
  test('project maps rows into the viewport and clips what extends past it; outside rows are dropped', () => {
    const v = { start: 0.25, end: 0.75 };
    const inside = project({ left: 0.4, width: 0.1 }, v)!;
    expect(inside.left).toBeCloseTo(0.3, 9);
    expect(inside.width).toBeCloseTo(0.2, 9);
    expect(inside).toMatchObject({ clippedLeft: false, clippedRight: false });
    expect(project({ left: 0.1, width: 0.3 }, v)).toMatchObject({ left: 0, clippedLeft: true });
    expect(project({ left: 0.7, width: 0.3 }, v)).toMatchObject({ clippedRight: true });
    expect(project({ left: 0.0, width: 0.1 }, v)).toBeNull();
    expect(project({ left: 0.9, width: 0.05 }, v)).toBeNull();
    expect(project({ left: 0.4, width: 0.1 }, FULL)!.width).toBeCloseTo(0.1, 9);
  });
  test('zoomTo keeps the viewport inside the trace and never collapses it to nothing', () => {
    expect(zoomTo(FULL, 0.5, 0.5)).toEqual({ start: 0.25, end: 0.75 });
    const edge = zoomTo(FULL, 0.99, 0.2);
    expect(edge.end).toBeLessThanOrEqual(1);
    expect(edge.start).toBeGreaterThanOrEqual(0);
    const tiny = zoomTo({ start: 0.4, end: 0.4005 }, 0.4, 0.0001);
    expect(tiny.end - tiny.start).toBeGreaterThanOrEqual(0.001);
    expect(zoomTo({ start: 0.2, end: 0.4 }, 0.3, 100)).toEqual(FULL);
  });
});

describe('formatting', () => {
  test.each([[null, 'unknown'], [0, '0 ns'], [999, '999 ns'], [1500, '1.5 µs'], [1_234_567, '1.23 ms'], [250_000_000, '250 ms'], [2_500_000_000, '2.5 s'], [90_000_000_000, '1 min 30 s']])('formatNs(%s) = %s', (n, s) => { expect(formatNs(n)).toBe(s); });
  test('axis ticks are evenly spaced "nice" numbers inside the window', () => {
    const t = axisTicks(1_000_000_000, FULL);
    expect(t.length).toBeGreaterThanOrEqual(4);
    expect(t.length).toBeLessThanOrEqual(11);
    const steps = t.slice(1).map((x, i) => x.ns - t[i]!.ns);
    expect(new Set(steps).size).toBe(1);
    expect(t.every((x) => x.frac >= 0 && x.frac <= 1)).toBe(true);
    const z = axisTicks(1_000_000_000, { start: 0.5, end: 0.51 });
    expect(z.every((x) => x.ns >= 500_000_000 && x.ns <= 510_000_000)).toBe(true);
  });
});
