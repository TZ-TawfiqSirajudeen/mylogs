import { useId, useState } from 'react';

/**
 * Small, dependency-free SVG charts. Design rules:
 *  - a missing measurement is a GAP, never a zero (null values are not drawn and the table says "no data");
 *  - colour is never the only signal (series have different shapes/dashes and a legend; tables repeat every value);
 *  - every chart has a text alternative: an aria-label summary and a "Show data as a table" disclosure;
 *  - theme colours come from Tailwind classes, so light and dark both meet contrast requirements.
 */
export interface ChartSeries { name: string; kind: 'bar' | 'line'; points: { t: number; v: number | null }[]; tone: 'indigo' | 'red' | 'emerald' | 'amber'; dashed?: boolean }

const TONE = {
  indigo: { stroke: 'stroke-indigo-600 dark:stroke-indigo-400', fill: 'fill-indigo-600/80 dark:fill-indigo-400/80', swatch: 'bg-indigo-600 dark:bg-indigo-400' },
  red: { stroke: 'stroke-red-700 dark:stroke-red-400', fill: 'fill-red-700/85 dark:fill-red-400/85', swatch: 'bg-red-700 dark:bg-red-400' },
  emerald: { stroke: 'stroke-emerald-700 dark:stroke-emerald-400', fill: 'fill-emerald-700/80 dark:fill-emerald-400/80', swatch: 'bg-emerald-700 dark:bg-emerald-400' },
  amber: { stroke: 'stroke-amber-700 dark:stroke-amber-400', fill: 'fill-amber-700/80 dark:fill-amber-400/80', swatch: 'bg-amber-700 dark:bg-amber-400' },
} as const;

const W = 640, H = 180, PAD = { l: 48, r: 8, t: 8, b: 22 };

export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v) ?? v;
}
export const fmtNum = (n: number | null, digits = 2): string => (n === null ? 'no data' : Math.abs(n) >= 1000 ? n.toLocaleString('en', { maximumFractionDigits: 0 }) : String(Number(n.toFixed(digits))));
const clock = (t: number, stepMs: number) => { const d = new Date(t); return stepMs >= 86_400_000 ? d.toISOString().slice(5, 10) : d.toISOString().slice(11, 16); };

export function TimelineChart({ title, unit, series, stepMs, summary, onPointClick }: {
  title: string; unit: string; series: ChartSeries[]; stepMs: number; summary?: string; onPointClick?: (t: number) => void;
}) {
  const id = useId();
  const [table, setTable] = useState(false);
  const all = series.flatMap((s) => s.points);
  const ts = [...new Set(all.map((p) => p.t))].sort((a, b) => a - b);
  const hasData = all.some((p) => p.v !== null);
  const max = niceMax(Math.max(0, ...all.map((p) => p.v ?? 0)));
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  const x = (i: number) => PAD.l + (ts.length <= 1 ? iw / 2 : (i / (ts.length - 1)) * iw);
  const y = (v: number) => PAD.t + ih - (v / max) * ih;
  const bw = Math.max(2, Math.min(24, (iw / Math.max(ts.length, 1)) * 0.7));
  const idx = new Map(ts.map((t, i) => [t, i]));
  const label = `${title}. ${summary ?? (hasData ? `${series.map((s) => s.name).join(', ')} over ${ts.length} windows.` : 'No data in this window.')}`;

  return (
    <figure className="space-y-1" aria-labelledby={`${id}-t`}>
      <figcaption id={`${id}-t`} className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium">
        <span>{title} <span className="font-normal text-slate-600 dark:text-slate-400">({unit})</span></span>
        <ul className="flex flex-wrap gap-3 text-xs font-normal" aria-label="Legend">
          {series.map((s) => (
            <li key={s.name} className="flex items-center gap-1.5"><span aria-hidden className={`inline-block h-2.5 w-2.5 ${s.kind === 'bar' ? 'rounded-sm' : 'rounded-full'} ${TONE[s.tone].swatch}`} />{s.name}{s.dashed ? ' (dashed)' : ''}</li>
          ))}
        </ul>
      </figcaption>
      {!hasData ? (
        <p role="status" className="flex h-24 items-center justify-center rounded border border-dashed border-slate-300 text-sm text-slate-600 dark:border-slate-700 dark:text-slate-400">No measurements in this window (missing data is not shown as zero).</p>
      ) : (
        <svg role="img" aria-label={label} viewBox={`0 0 ${W} ${H}`} className="w-full" preserveAspectRatio="none" style={{ height: 'auto', maxHeight: 220 }}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(max * f)} y2={y(max * f)} className="stroke-slate-200 dark:stroke-slate-800" strokeWidth={1} />
              <text x={PAD.l - 6} y={y(max * f) + 3} textAnchor="end" className="fill-slate-600 text-[10px] dark:fill-slate-400">{fmtNum(max * f, 1)}</text>
            </g>
          ))}
          {ts.filter((_, i) => i % Math.max(1, Math.ceil(ts.length / 6)) === 0).map((t) => (
            <text key={t} x={x(idx.get(t)!)} y={H - 6} textAnchor="middle" className="fill-slate-600 text-[10px] dark:fill-slate-400">{clock(t, stepMs)}</text>
          ))}
          {series.filter((s) => s.kind === 'bar').map((s, si, bars) => s.points.map((p) => p.v === null ? null : (
            <rect key={`${s.name}${p.t}`} x={x(idx.get(p.t)!) - bw / 2 + (si - (bars.length - 1) / 2) * (bw / bars.length)} y={y(p.v)} width={bw / bars.length} height={Math.max(1, PAD.t + ih - y(p.v))}
              className={`${TONE[s.tone].fill} ${onPointClick ? 'cursor-pointer' : ''}`} onClick={onPointClick ? () => onPointClick(p.t) : undefined}>
              <title>{`${new Date(p.t).toISOString().slice(0, 16).replace('T', ' ')} UTC — ${s.name}: ${fmtNum(p.v)} ${unit}`}</title>
            </rect>
          )))}
          {series.filter((s) => s.kind === 'line').map((s) => {
            // A line is split at gaps: two points are only joined when the windows are adjacent and BOTH have data.
            const segs: { t: number; v: number }[][] = [];
            let cur: { t: number; v: number }[] = [];
            for (const p of s.points) { if (p.v === null) { if (cur.length) segs.push(cur); cur = []; } else cur.push({ t: p.t, v: p.v }); }
            if (cur.length) segs.push(cur);
            return (
              <g key={s.name} className={TONE[s.tone].stroke} fill="none" strokeWidth={2} strokeDasharray={s.dashed ? '5 3' : undefined}>
                {segs.map((seg, i) => (seg.length === 1
                  ? <circle key={i} cx={x(idx.get(seg[0]!.t)!)} cy={y(seg[0]!.v)} r={3} className={TONE[s.tone].fill} stroke="none"><title>{`${s.name}: ${fmtNum(seg[0]!.v)} ${unit}`}</title></circle>
                  : <polyline key={i} points={seg.map((p) => `${x(idx.get(p.t)!)},${y(p.v)}`).join(' ')} />))}
                {s.points.filter((p) => p.v !== null).map((p) => (
                  <circle key={p.t} cx={x(idx.get(p.t)!)} cy={y(p.v!)} r={2.5} className={`${TONE[s.tone].fill} ${onPointClick ? 'cursor-pointer' : ''}`} stroke="none" onClick={onPointClick ? () => onPointClick(p.t) : undefined}>
                    <title>{`${new Date(p.t).toISOString().slice(0, 16).replace('T', ' ')} UTC — ${s.name}: ${fmtNum(p.v)} ${unit}`}</title>
                  </circle>
                ))}
              </g>
            );
          })}
        </svg>
      )}
      <button type="button" aria-expanded={table} aria-controls={`${id}-tbl`} className="text-xs text-indigo-700 underline dark:text-indigo-300" onClick={() => setTable((v) => !v)}>
        {table ? 'Hide data table' : 'Show data as a table'}
      </button>
      {table && (
        <div id={`${id}-tbl`} className="max-h-60 overflow-auto rounded border border-slate-200 dark:border-slate-800">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">{title}: values per window (UTC)</caption>
            <thead className="sticky top-0 bg-white text-slate-600 dark:bg-slate-900 dark:text-slate-400"><tr><th scope="col" className="px-2 py-1">Window start (UTC)</th>{series.map((s) => <th scope="col" key={s.name} className="px-2 py-1">{s.name}</th>)}</tr></thead>
            <tbody>{ts.map((t) => (
              <tr key={t} className="border-t border-slate-100 dark:border-slate-800"><th scope="row" className="whitespace-nowrap px-2 py-1 font-mono font-normal">{new Date(t).toISOString().slice(0, 16).replace('T', ' ')}</th>
                {series.map((s) => <td key={s.name} className="px-2 py-1 tabular-nums">{fmtNum(s.points.find((p) => p.t === t)?.v ?? null)}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </figure>
  );
}

/** One stacked horizontal bar with a labelled legend (e.g. HTTP status classes). Counts are repeated as text. */
export function StackedBar({ title, parts }: { title: string; parts: { label: string; value: number; tone: ChartSeries['tone'] }[] }) {
  const total = parts.reduce((n, p) => n + p.value, 0);
  if (!total) return <p className="text-sm text-slate-600 dark:text-slate-400">{title}: no requests in this window.</p>;
  return (
    <div className="space-y-1">
      <p className="text-sm font-medium">{title}</p>
      <div role="img" aria-label={`${title}: ${parts.map((p) => `${p.label} ${p.value} (${Math.round((p.value / total) * 100)}%)`).join(', ')}`} className="flex h-4 overflow-hidden rounded">
        {parts.filter((p) => p.value > 0).map((p) => <div key={p.label} style={{ width: `${(p.value / total) * 100}%` }} className={TONE[p.tone].swatch} title={`${p.label}: ${p.value}`} />)}
      </div>
      <ul className="flex flex-wrap gap-3 text-xs">{parts.map((p) => <li key={p.label} className="flex items-center gap-1.5"><span aria-hidden className={`inline-block h-2.5 w-2.5 rounded-sm ${TONE[p.tone].swatch}`} />{p.label}: <span className="tabular-nums">{p.value.toLocaleString()}</span> ({Math.round((p.value / total) * 100)}%)</li>)}</ul>
    </div>
  );
}
