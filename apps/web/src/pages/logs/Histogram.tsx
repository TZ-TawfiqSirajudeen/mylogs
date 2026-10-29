import type { z } from 'zod';
import type { LogHistogram } from '@nexus/contracts';

type H = z.infer<typeof LogHistogram>;

/**
 * Volume over time. Errors are drawn over total with a distinct pattern, and the summary is also provided as text,
 * so colour is never the only signal. Clicking a bar zooms the time range to that bucket.
 */
export function Histogram({ data, onZoom }: { data: H; onZoom: (fromMs: number, toMs: number) => void }) {
  const total = data.buckets.reduce((s, b) => s + b.total, 0);
  const errors = data.buckets.reduce((s, b) => s + b.errors, 0);
  const max = Math.max(1, ...data.buckets.map((b) => b.total));
  const W = 600, H_ = 56;
  const n = Math.max(1, data.buckets.length);
  const bw = Math.max(2, Math.min(24, W / (n + 2)));
  const t0 = data.buckets[0]?.t;
  const label = `Log volume: ${total} events, ${errors} errors, ${data.buckets.length} time buckets of ${Math.round(data.bucketMs / 1000)} seconds`;
  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H_}`} role="img" aria-label={label} className="h-16 w-full rounded border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900" preserveAspectRatio="none">
        <title>{label}</title>
        {data.buckets.map((b, i) => {
          const x = t0 === undefined ? 0 : ((b.t - t0) / data.bucketMs) * (bw + 1) + 2;
          const h = (b.total / max) * (H_ - 6);
          const eh = (b.errors / max) * (H_ - 6);
          return (
            <g key={b.t} onClick={() => onZoom(b.t, b.t + data.bucketMs)} className="cursor-pointer">
              <rect x={x} y={H_ - h - 2} width={bw} height={h} className="fill-slate-400 dark:fill-slate-500" />
              {b.errors > 0 && <rect x={x} y={H_ - eh - 2} width={bw} height={eh} className="fill-red-600 dark:fill-red-400" />}
              <rect x={x} y={0} width={bw} height={H_} fill="transparent"><title>{`${new Date(b.t).toISOString().replace('T', ' ').slice(0, 19)}Z — ${b.total} events, ${b.errors} errors`}</title></rect>
              {i < 0 && null}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-1 text-xs text-slate-600 dark:text-slate-400">{total.toLocaleString()} events · {errors.toLocaleString()} errors (red) · click a bar to zoom</figcaption>
    </figure>
  );
}
