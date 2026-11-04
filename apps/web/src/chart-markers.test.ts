import { describe, expect, test } from 'vitest';
import { markerIndex, markerLabel, STATUS_STYLE, toChartMarkers } from './chart-markers';

const MIN = 60_000;
const ts = [0, 1, 2, 3, 4].map((i) => 1_700_000_000_000 + i * 5 * MIN);

describe('markerIndex', () => {
  test('exactly on a window start, in the middle of a window, and in the last window', () => {
    expect(markerIndex(ts[2]!, ts, 5 * MIN)).toBe(2);
    expect(markerIndex(ts[2]! + 2.5 * MIN, ts, 5 * MIN)).toBe(2.5);
    expect(markerIndex(ts[4]! + 4 * MIN, ts, 5 * MIN)).toBe(4); // no x position exists beyond the last point
  });
  test('outside the charted range nothing is drawn', () => {
    expect(markerIndex(ts[0]! - 1, ts, 5 * MIN)).toBeNull();
    expect(markerIndex(ts[4]! + 5 * MIN, ts, 5 * MIN)).toBeNull(); // the end is exclusive
    expect(markerIndex(NaN, ts, 5 * MIN)).toBeNull();
    expect(markerIndex(ts[0]!, [], 5 * MIN)).toBeNull();
  });
  test('a gap in the data compresses like the chart does (the axis is by category, not by time)', () => {
    const gappy = [ts[0]!, ts[1]!, ts[4]!]; // windows 2 and 3 have no data
    expect(markerIndex(ts[2]!, gappy, 5 * MIN)).toBeCloseTo(1 + (ts[2]! - ts[1]!) / (ts[4]! - ts[1]!));
  });
  test('a single window', () => {
    expect(markerIndex(ts[0]! + MIN, [ts[0]!], 5 * MIN)).toBe(0);
    expect(markerIndex(ts[0]! + 6 * MIN, [ts[0]!], 5 * MIN)).toBeNull();
  });
});

describe('labels and conversion', () => {
  const m = { id: 'a'.repeat(8), environmentId: 'e1', service: 'checkout', version: '1.2.3', status: 'rolled_back' as const, at: '2026-11-04T12:03:44.000Z', finishedAt: null };
  test('the label names service, version, status, UTC time and environment, and is plain text', () => {
    expect(markerLabel(m, 'Prod')).toBe('checkout 1.2.3 — rolled back — 2026-11-04 12:03 UTC (Prod)');
    expect(markerLabel(m)).toBe('checkout 1.2.3 — rolled back — 2026-11-04 12:03 UTC');
    const hostile = markerLabel({ ...m, service: '<img src=x onerror=alert(1)>' });
    expect(hostile).toContain('<img src=x onerror=alert(1)>'); // kept as text: React renders it as a text node, never as markup
  });
  test('every status has a glyph and a word, so colour is never the only signal', () => {
    for (const s of ['started', 'succeeded', 'failed', 'rolled_back'] as const) { expect(STATUS_STYLE[s].glyph).toBeTruthy(); expect(STATUS_STYLE[s].word).toBeTruthy(); }
    expect(new Set(Object.values(STATUS_STYLE).map((s) => s.glyph)).size).toBe(4);
  });
  test('toChartMarkers filters by environment, resolves names and links', () => {
    const items = [m, { ...m, id: 'b'.repeat(8), environmentId: 'e2', at: '2026-11-04T12:10:00.000Z' }];
    const all = toChartMarkers(items, { envName: (id) => (id === 'e1' ? 'Prod' : 'Dev'), href: (x) => `/deployments?id=${x.id}` });
    expect(all.map((x) => x.label.split(' ').at(-1))).toEqual(['(Prod)', '(Dev)']);
    expect(all[0]!.href).toBe(`/deployments?id=${'a'.repeat(8)}`);
    expect(toChartMarkers(items, { environmentId: 'e2' }).map((x) => x.id)).toEqual(['b'.repeat(8)]);
    expect(toChartMarkers([{ ...m, at: 'not a date' }])).toEqual([]);
  });
});
