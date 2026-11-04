import type { AlertRuleCreate, PreviewGroup, RulePreviewInput, RulePreviewResult } from '@nexus/contracts';
import { duration, num, OPS } from './model';

export const PREVIEW_RANGES = [
  { seconds: 3_600, label: 'Last hour' }, { seconds: 6 * 3_600, label: 'Last 6 hours (default)' }, { seconds: 24 * 3_600, label: 'Last 24 hours' },
] as const;
export const DEFAULT_PREVIEW_RANGE = 6 * 3_600;

/** The request a draft rule produces: only the fields that decide what is measured (the server rejects anything else). */
export function toPreviewRequest(rule: AlertRuleCreate, rangeSeconds: number): RulePreviewInput {
  return {
    rule: {
      environmentId: rule.environmentId, query: rule.query, condition: rule.condition, windowSeconds: rule.windowSeconds, forSeconds: rule.forSeconds,
      resolveAfterSeconds: rule.resolveAfterSeconds, noDataPolicy: rule.noDataPolicy, intervalSeconds: rule.intervalSeconds,
    },
    rangeSeconds,
  };
}

export type PreviewVerdict = 'no_data' | 'quiet' | 'would_fire';
/** What the result means at a glance. `no_data` = the stores had nothing for this selection anywhere in the range. */
export function previewVerdict(r: Pick<RulePreviewResult, 'totals'>): PreviewVerdict {
  if (r.totals.evaluatedPoints > 0 && r.totals.noDataPoints === r.totals.evaluatedPoints) return 'no_data';
  return r.totals.wouldOpenIncidents > 0 ? 'would_fire' : 'quiet';
}

export function previewSummary(r: Pick<RulePreviewResult, 'totals' | 'condition' | 'windowSeconds' | 'rangeSeconds'>): string {
  const n = r.totals.wouldOpenIncidents;
  const base = `With ${OPS[r.condition.op]} ${num(r.condition.threshold)} over ${duration(r.windowSeconds)}, this rule would have opened ${n} incident${n === 1 ? '' : 's'} in the last ${duration(r.rangeSeconds)}`;
  return n > 0 ? `${base}, in ${r.totals.groupsThatWouldFire} group${r.totals.groupsThatWouldFire === 1 ? '' : 's'}.` : `${base}.`;
}

const hhmm = (iso: string) => iso.slice(11, 16);
/** "Firing 10:05 to 10:22 UTC" / "Pending 10:00 to 10:05 UTC (still going at the end of the range)". */
export function periodText(p: PreviewGroup['periods'][number]): string {
  return `${p.kind === 'firing' ? 'Would fire' : 'Pending'} ${hhmm(p.from)} to ${hhmm(p.to)} UTC${p.ongoing ? ' (still the case at the end of the range)' : ''}`;
}

export const groupLabel = (g: Pick<PreviewGroup, 'key' | 'labels'>): string => (g.key === '' ? 'whole rule' : Object.entries(g.labels).map(([k, v]) => `${k}=${v || '∅'}`).join(', '));

// ---------------------------------------------------------------- chart geometry (pure, so it is unit tested)
export const CHART = { w: 640, h: 190, l: 52, r: 10, t: 10, b: 24 } as const;

export interface ChartModel {
  /** One path per run of consecutive values: a gap (no data) breaks the line, it is never drawn as zero. */
  segments: string[];
  /** Isolated points (a run of one value) are drawn as dots so they stay visible. */
  dots: { x: number; y: number }[];
  thresholdY: number;
  bands: { x: number; width: number; kind: 'pending' | 'firing' }[];
  yTicks: { y: number; label: string }[];
  xTicks: { x: number; label: string }[];
  lo: number; hi: number;
  hasValues: boolean;
}

export function chartModel(r: Pick<RulePreviewResult, 'times' | 'condition'>, g: Pick<PreviewGroup, 'values' | 'periods'>): ChartModel {
  const { w, h, l, r: rr, t: top, b } = CHART;
  const iw = w - l - rr, ih = h - top - b;
  const times = r.times;
  const t0 = times[0] ?? 0, t1 = times[times.length - 1] ?? t0;
  const x = (tm: number) => l + (t1 === t0 ? iw / 2 : ((tm - t0) / (t1 - t0)) * iw);
  const vals = g.values.filter((v): v is number => v !== null);
  const threshold = r.condition.threshold;
  let lo = Math.min(0, threshold, ...vals), hi = Math.max(threshold, ...vals, 0);
  if (hi === lo) hi = lo + 1;
  const pad = (hi - lo) * 0.06;
  if (hi > 0) hi += pad;
  if (lo < 0) lo -= pad;
  const y = (v: number) => top + ih - ((v - lo) / (hi - lo)) * ih;
  const f = (n: number) => String(Math.round(n * 10) / 10);

  const segments: string[] = [];
  const dots: ChartModel['dots'] = [];
  let run: { x: number; y: number }[] = [];
  const flush = () => {
    if (run.length === 1) dots.push(run[0]!);
    else if (run.length > 1) segments.push(run.map((p, i) => `${i === 0 ? 'M' : 'L'}${f(p.x)},${f(p.y)}`).join(' '));
    run = [];
  };
  g.values.forEach((v, i) => { if (v === null || times[i] === undefined) flush(); else run.push({ x: x(times[i]!), y: y(v) }); });
  flush();

  const bands = g.periods.map((p) => {
    const a = x(Date.parse(p.from)), z = x(Date.parse(p.to));
    return { x: a, width: Math.max(2, z - a), kind: p.kind };
  });
  const yTicks = [lo, (lo + hi) / 2, hi].map((v) => ({ y: y(v), label: num(Math.round(v * 100) / 100) }));
  const xTicks = times.length === 0 ? [] : [t0, (t0 + t1) / 2, t1].map((tm) => ({ x: x(tm), label: new Date(tm).toISOString().slice(11, 16) }));
  return { segments, dots, thresholdY: y(threshold), bands, yTicks, xTicks, lo, hi, hasValues: vals.length > 0 };
}

/** Text alternative for the chart: what a person who cannot see it needs to know. */
export function chartAlt(r: Pick<RulePreviewResult, 'times' | 'condition' | 'windowSeconds'>, g: Pick<PreviewGroup, 'values' | 'periods' | 'wouldOpen'>, name: string): string {
  const vals = g.values.filter((v): v is number => v !== null);
  const range = vals.length ? `values from ${num(Math.min(...vals))} to ${num(Math.max(...vals))}` : 'no data';
  return `${name}: ${range}, threshold ${OPS[r.condition.op]} ${num(r.condition.threshold)}, ${g.periods.filter((p) => p.kind === 'firing').length} would-fire period(s), would open ${g.wouldOpen} incident(s).`;
}
