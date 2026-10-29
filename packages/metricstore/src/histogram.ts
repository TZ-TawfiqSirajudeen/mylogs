/**
 * Percentiles from histogram buckets.
 *
 * A percentile can only be obtained from the DISTRIBUTION. Histograms that share bucket bounds are merged by adding their bucket
 * counts; the percentile is then read off the merged distribution. Averaging or otherwise combining already-computed percentiles
 * (p95 of p95s) is wrong and is never done anywhere in this code base.
 *
 * Within a bucket the observations are assumed to be evenly spread (linear interpolation), so the result is an ESTIMATE whose error is
 * bounded by the bucket width. The first bucket's lower edge is the observed minimum when known (else 0 for non-negative data); the
 * open-ended last bucket is clamped to the observed maximum when known, otherwise to its lower bound (so very slow outliers are
 * reported as "at least" that value rather than invented).
 */
export interface Quantile { value: number; /** Always true: derived from bucket counts. */ estimated: true; /** The value is the lower bound of the open-ended last bucket (a floor, not an estimate). */ atLeast: boolean }

export function histogramQuantile(bounds: number[], counts: number[], q: number, hint: { min?: number | null; max?: number | null } = {}): Quantile | null {
  if (counts.length !== bounds.length + 1) return null;
  const total = counts.reduce((a, b) => a + b, 0);
  if (!(total > 0) || !(q >= 0 && q <= 1)) return null;
  const rank = q * total;
  let before = 0;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i]!;
    if (c > 0 && before + c >= rank) {
      const last = i === bounds.length;
      const lower = i === 0 ? (hint.min ?? (bounds.length && bounds[0]! > 0 ? 0 : bounds[0] ?? 0)) : bounds[i - 1]!;
      let upper = last ? hint.max ?? lower : bounds[i]!;
      if (last && !(hint.max !== null && hint.max !== undefined && hint.max > lower)) return { value: lower, estimated: true, atLeast: true };
      if (!last && i === 0 && hint.min !== null && hint.min !== undefined && hint.min > upper) upper = hint.min;
      const frac = c === 0 ? 0 : Math.min(1, Math.max(0, (rank - before) / c));
      return { value: lower + (Math.max(upper, lower) - lower) * frac, estimated: true, atLeast: false };
    }
    before += c;
  }
  return { value: bounds[bounds.length - 1] ?? 0, estimated: true, atLeast: true };
}

/** Adds `b` into `a` element-wise (same length required). */
export function addBuckets(a: number[], b: number[]): number[] { return a.map((v, i) => v + (b[i] ?? 0)); }
export const boundsKey = (bounds: number[] | null): string => (bounds ? bounds.join(',') : '');
