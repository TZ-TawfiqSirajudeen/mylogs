import type { MetricExemplarDoc, MetricSeriesDoc } from '@nexus/database';
import type { MetricPointDraft } from '@nexus/telemetry';

export const MINUTE = 60_000;
/** A cumulative series seen for the first time counts its whole value only if it started this recently (otherwise we may have missed earlier history). */
export const FIRST_POINT_MAX_AGE_MS = 5 * 60_000;
export const MAX_EXEMPLARS_PER_MINUTE = 5;

export const RECENT_KEEP = 128;
export interface SeriesState { lastPoint: Date | null; cumulative: MetricSeriesDoc['cumulative']; recent: number[] }
export interface MinuteAgg {
  minute: number; count: number; sum: number; min: number | null; max: number | null; last: number | null; lastAt: Date | null;
  buckets: number[] | null; exemplars: MetricExemplarDoc[];
}
export interface ProcessResult {
  aggs: Map<number, MinuteAgg>; state: SeriesState;
  /** Data points consumed (including baselines). */
  accepted: number; /** Not newer than the series watermark: retransmissions. */ duplicates: number;
  /** Cumulative data points that only established a baseline (no delta could be computed from them). */ baselines: number;
  /** Counter resets detected (the counter restarted; its new value is taken as the delta). */ resets: number;
}

const minuteOf = (t: Date) => Math.floor(t.getTime() / MINUTE) * MINUTE;
const agg = (m: Map<number, MinuteAgg>, minute: number): MinuteAgg => {
  let a = m.get(minute);
  if (!a) { a = { minute, count: 0, sum: 0, min: null, max: null, last: null, lastAt: null, buckets: null, exemplars: [] }; m.set(minute, a); }
  return a;
};
const bump = (a: MinuteAgg, p: MetricPointDraft, count: number, sum: number) => {
  a.count += count; a.sum += sum;
  if (p.exemplars.length) a.exemplars = [...a.exemplars, ...p.exemplars.map((e) => ({ traceId: e.traceId, spanId: e.spanId, value: e.value, ts: e.ts }))].slice(-MAX_EXEMPLARS_PER_MINUTE);
};

/**
 * Turns the data points of ONE series (sorted by time, oldest first) into per-minute increments and the series' next state.
 * Pure: no I/O, so every temporality rule is unit-tested directly.
 *
 *  - Duplicates (a retransmitted request) are ignored and counted: cumulative series reject points not newer than the last one (an older
 *    cumulative value carries no information the newer one lacks); delta and gauge series reject a point whose timestamp was seen recently, so
 *    batches that arrive OUT OF ORDER (parallel exporters, retries) are still accepted and nothing is lost.
 *  - gauge: observations (last/min/max/sum/count). delta sum / delta histogram: the point IS the increment for its interval.
 *  - cumulative sum / histogram: the increment is current - previous. A new start time, a decreasing monotonic counter, or a
 *    shrinking histogram is a RESET: the counter restarted from zero, so the current value is the increment. The very first
 *    point only establishes a baseline unless its start time shows the counter began just now.
 *  - cumulative and delta are never mixed: temporality is part of the series identity.
 */
export function processSeriesPoints(
  series: Pick<MetricSeriesDoc, 'type' | 'temporality' | 'monotonic' | 'bounds'>, start: SeriesState, points: MetricPointDraft[],
): ProcessResult {
  const out: ProcessResult = { aggs: new Map(), state: { lastPoint: start.lastPoint, cumulative: start.cumulative, recent: [...start.recent] }, accepted: 0, duplicates: 0, baselines: 0, resets: 0 };
  const cumulativeSeries = series.temporality === 'cumulative' && series.type !== 'gauge';
  for (const p of points) {
    const t = p.time.getTime();
    const duplicate = cumulativeSeries ? !!out.state.lastPoint && t <= out.state.lastPoint.getTime() : out.state.recent.includes(t);
    if (duplicate) { out.duplicates++; continue; }
    if (!out.state.lastPoint || t > out.state.lastPoint.getTime()) out.state.lastPoint = p.time;
    if (!cumulativeSeries) { out.state.recent.push(t); if (out.state.recent.length > RECENT_KEEP) out.state.recent.splice(0, out.state.recent.length - RECENT_KEEP); }
    out.accepted++;
    const a = agg(out.aggs, minuteOf(p.time));

    if (series.type === 'gauge') {
      bump(a, p, 1, p.value);
      a.min = a.min === null ? p.value : Math.min(a.min, p.value);
      a.max = a.max === null ? p.value : Math.max(a.max, p.value);
      a.last = p.value; a.lastAt = p.time;
      continue;
    }

    if (series.type === 'sum') {
      if (series.temporality === 'delta') { bump(a, p, 1, p.value); continue; }
      const prior = out.state.cumulative;
      out.state.cumulative = { time: p.time, startTime: p.startTime, value: p.value, count: 1, sum: p.value, buckets: null };
      if (!prior) {
        if (p.startTime && p.time.getTime() - p.startTime.getTime() <= FIRST_POINT_MAX_AGE_MS) bump(a, p, 1, p.value);
        else { out.baselines++; a.count += 0; }
        continue;
      }
      const restarted = !!(p.startTime && prior.startTime && p.startTime.getTime() > prior.startTime.getTime()) || (series.monotonic === true && p.value < prior.value);
      if (restarted) out.resets++;
      bump(a, p, 1, restarted ? p.value : p.value - prior.value);
      continue;
    }

    // histogram
    const buckets = p.buckets ?? [];
    if (series.temporality === 'delta') {
      bump(a, p, p.count, p.sum);
      a.buckets = a.buckets ? a.buckets.map((v, i) => v + (buckets[i] ?? 0)) : [...buckets];
      if (p.min !== null) a.min = a.min === null ? p.min : Math.min(a.min, p.min);
      if (p.max !== null) a.max = a.max === null ? p.max : Math.max(a.max, p.max);
      continue;
    }
    const prior = out.state.cumulative;
    out.state.cumulative = { time: p.time, startTime: p.startTime, value: 0, count: p.count, sum: p.sum, buckets: [...buckets] };
    if (!prior || !prior.buckets) {
      if (p.startTime && p.time.getTime() - p.startTime.getTime() <= FIRST_POINT_MAX_AGE_MS) {
        bump(a, p, p.count, p.sum); a.buckets = [...buckets];
        if (p.min !== null) a.min = p.min;
        if (p.max !== null) a.max = p.max;
      } else out.baselines++;
      continue;
    }
    const shrank = p.count < prior.count || buckets.some((v, i) => v < (prior.buckets![i] ?? 0));
    const restarted = shrank || !!(p.startTime && prior.startTime && p.startTime.getTime() > prior.startTime.getTime());
    if (restarted) out.resets++;
    const d = restarted ? buckets : buckets.map((v, i) => v - (prior.buckets![i] ?? 0));
    const dCount = restarted ? p.count : p.count - prior.count;
    bump(a, p, dCount, restarted ? p.sum : p.sum - prior.sum);
    a.buckets = a.buckets ? a.buckets.map((v, i) => v + (d[i] ?? 0)) : d;
    // min/max of a cumulative histogram describe the whole lifetime, not this interval: they are not carried into the increment.
  }
  return out;
}
