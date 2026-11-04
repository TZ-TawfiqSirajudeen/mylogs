import type { AlertRuleCreate, RulePreviewResult } from '@nexus/contracts';
import { describe, expect, test } from 'vitest';
import { chartAlt, chartModel, CHART, groupLabel, periodText, previewSummary, previewVerdict, toPreviewRequest } from './preview-model';

const rule = {
  name: 'secret name', description: 'd', severity: 'critical', environmentId: crypto.randomUUID(), enabled: true, query: { kind: 'metric', metric: 'm', agg: 'max', filters: [], groupBy: [] },
  condition: { op: 'gt', threshold: 10 }, windowSeconds: 300, forSeconds: 60, resolveAfterSeconds: 120, noDataPolicy: 'keep', intervalSeconds: 60, channelIds: [crypto.randomUUID()],
} as unknown as AlertRuleCreate;

describe('toPreviewRequest', () => {
  test('sends only what decides what is measured (no name, severity, channels or enabled flag) and the chosen range', () => {
    const r = toPreviewRequest(rule, 3600);
    expect(r.rangeSeconds).toBe(3600);
    expect(Object.keys(r.rule).sort()).toEqual(['condition', 'environmentId', 'forSeconds', 'intervalSeconds', 'noDataPolicy', 'query', 'resolveAfterSeconds', 'windowSeconds']);
    expect(JSON.stringify(r)).not.toContain('secret name');
  });
});

const T0 = Date.UTC(2026, 2, 1, 10, 0, 0);
const times = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => T0 + i * 60_000);
const iso = (i: number) => new Date(times[i]!).toISOString();
const result = (g: Partial<RulePreviewResult['groups'][number]> = {}, totals: Partial<RulePreviewResult['totals']> = {}): RulePreviewResult => ({
  from: iso(0), to: iso(9), rangeSeconds: 540, stepSeconds: 60, intervalSeconds: 60, windowSeconds: 300,
  condition: { op: 'gt', threshold: 10 }, times, skipped: [], truncatedGroups: false, partial: false, notes: [], elapsedMs: 5,
  totals: { wouldOpenIncidents: 1, groupsThatWouldFire: 1, evaluationPoints: 10, evaluatedPoints: 10, noDataPoints: 0, skippedPoints: 0, storeQueries: 10, ...totals },
  groups: [{
    key: '', labels: {}, values: [1, 2, 50, 60, 55, 3, 2, 1, 1, 1], states: ['ok', 'ok', 'pending', 'firing', 'firing', 'firing', 'resolved', 'resolved', 'ok', 'ok'],
    periods: [{ kind: 'pending', from: iso(2), to: iso(3), ongoing: false }, { kind: 'firing', from: iso(3), to: iso(6), ongoing: false }],
    wouldOpen: 1, noDataPoints: 0, ...g,
  }],
});

describe('verdict and summary', () => {
  test('quiet, would fire, and no data at all are told apart', () => {
    expect(previewVerdict(result())).toBe('would_fire');
    expect(previewVerdict(result({}, { wouldOpenIncidents: 0, groupsThatWouldFire: 0 }))).toBe('quiet');
    expect(previewVerdict(result({}, { noDataPoints: 10 }))).toBe('no_data');
    expect(previewVerdict(result({}, { noDataPoints: 3 }))).toBe('would_fire'); // some data: the verdict follows the incidents
  });
  test('the summary answers "would have opened N incidents" in plain language', () => {
    expect(previewSummary(result())).toBe('With > 10 over 5 min, this rule would have opened 1 incident in the last 9 min, in 1 group.');
    expect(previewSummary(result({}, { wouldOpenIncidents: 3, groupsThatWouldFire: 2 }))).toContain('opened 3 incidents in the last 9 min, in 2 groups');
    expect(previewSummary(result({}, { wouldOpenIncidents: 0, groupsThatWouldFire: 0 }))).toBe('With > 10 over 5 min, this rule would have opened 0 incidents in the last 9 min.');
  });
  test('periods and groups are described in words, not colour', () => {
    const g = result().groups[0]!;
    expect(periodText(g.periods[0]!)).toBe('Pending 10:02 to 10:03 UTC');
    expect(periodText(g.periods[1]!)).toBe('Would fire 10:03 to 10:06 UTC');
    expect(periodText({ ...g.periods[1]!, ongoing: true })).toContain('still the case at the end of the range');
    expect(groupLabel({ key: '', labels: {} })).toBe('whole rule');
    expect(groupLabel({ key: 'service=a', labels: { service: 'a' } })).toBe('service=a');
  });
});

describe('chartModel', () => {
  test('a gap in the data breaks the line (never drawn as zero); an isolated value is a dot', () => {
    const r = result({ values: [1, 2, null, 5, null, 7, 8, null, null, 1] });
    const m = chartModel(r, r.groups[0]!);
    expect(m.segments).toHaveLength(2); // [1,2] and [7,8]
    expect(m.dots).toHaveLength(2); // 5 and the last 1
    expect(m.segments.every((s) => s.startsWith('M') && s.includes('L'))).toBe(true);
    expect(m.hasValues).toBe(true);
  });
  test('all values missing: nothing is drawn but the threshold line still has a position', () => {
    const r = result({ values: Array(10).fill(null), periods: [] });
    const m = chartModel(r, r.groups[0]!);
    expect(m.segments).toEqual([]);
    expect(m.dots).toEqual([]);
    expect(m.hasValues).toBe(false);
    expect(Number.isFinite(m.thresholdY)).toBe(true);
  });
  test('the threshold is inside the plot even when every value is far below it, and the axis grows with the data', () => {
    const r = result({ values: [1, 1, 1, 1, 1, 1, 1, 1, 1, 100] });
    const m = chartModel(r, r.groups[0]!);
    expect(m.thresholdY).toBeGreaterThanOrEqual(CHART.t);
    expect(m.thresholdY).toBeLessThanOrEqual(CHART.h - CHART.b);
    const lowRes = result({ values: Array(10).fill(1) });
    const low = chartModel(lowRes, lowRes.groups[0]!);
    expect(low.hi).toBeGreaterThanOrEqual(10); // the axis always reaches the threshold
    expect(m.hi).toBeGreaterThan(low.hi);
  });
  test('shaded bands sit on the periods, are at least 2 px wide, stay inside the plot and keep their kind', () => {
    const r = result();
    const m = chartModel(r, r.groups[0]!);
    expect(m.bands.map((b) => b.kind)).toEqual(['pending', 'firing']);
    expect(m.bands[1]!.x).toBeCloseTo(m.bands[0]!.x + m.bands[0]!.width, 5);
    expect(m.bands.every((b) => b.width >= 2 && b.x >= CHART.l && b.x + b.width <= CHART.w - CHART.r + 0.01)).toBe(true);
    const zero = result({ periods: [{ kind: 'firing', from: iso(2), to: iso(2), ongoing: true }] });
    expect(chartModel(zero, zero.groups[0]!).bands[0]!.width).toBe(2);
  });
  test('a single evaluation point does not divide by zero', () => {
    const r = { ...result(), times: [T0] };
    const m = chartModel(r, { values: [5], periods: [] });
    expect(m.dots).toHaveLength(1);
    expect(Number.isFinite(m.dots[0]!.x)).toBe(true);
  });
  test('the text alternative states range, threshold and would-fire periods', () => {
    const r = result();
    expect(chartAlt(r, r.groups[0]!, 'whole rule')).toBe('whole rule: values from 1 to 60, threshold > 10, 1 would-fire period(s), would open 1 incident(s).');
    expect(chartAlt(r, { ...r.groups[0]!, values: [null], periods: [], wouldOpen: 0 }, 'x')).toContain('no data');
  });
});
