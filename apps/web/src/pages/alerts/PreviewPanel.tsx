import type { AlertRuleCreate, RulePreviewResult } from '@nexus/contracts';
import { useMutation } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { api } from '../../api';
import { Badge, Button, Loading } from '../../ui';
import { field, num, OPS } from './shared';
import { errorText } from './model';
import { chartAlt, chartModel, CHART, DEFAULT_PREVIEW_RANGE, groupLabel, periodText, PREVIEW_RANGES, previewSummary, previewVerdict, toPreviewRequest } from './preview-model';

/**
 * "Preview against history" for the rule form: replays the DRAFT rule over the last hour / 6 h / 24 h of stored data on the server (the real evaluator
 * and state machine; read-only, nothing is created) and shows what it would have done. See ADR-0009.
 */
export function PreviewPanel({ projectId, build, disabledReason }: { projectId: string; build: () => AlertRuleCreate; disabledReason: string | null }) {
  const id = useId();
  const [range, setRange] = useState<number>(DEFAULT_PREVIEW_RANGE);
  const [groupIdx, setGroupIdx] = useState(0);
  const [asOf, setAsOf] = useState<string | null>(null);
  const run = useMutation({
    mutationFn: (vars: { body: ReturnType<typeof toPreviewRequest> }) => api<RulePreviewResult>('POST', `/api/v1/projects/${projectId}/alert-rules/preview`, vars.body),
    onSuccess: () => setGroupIdx(0),
  });
  const start = () => { const body = toPreviewRequest(build(), range); setAsOf(JSON.stringify(body)); run.mutate({ body }); };
  const stale = !!run.data && asOf !== null && asOf !== JSON.stringify(toPreviewRequest(build(), range));

  return (
    <section className="space-y-3 rounded-md border border-slate-200 p-3 dark:border-slate-800" aria-labelledby={`${id}-h`} data-testid="rule-preview">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h3 id={`${id}-h`} className="text-sm font-medium">Preview against history</h3>
          <p className="text-xs text-slate-600 dark:text-slate-400">Replays this rule over stored data to show when it would have fired. Nothing is created and nobody is notified.</p>
        </div>
        <div className="flex items-end gap-2">
          <label className="text-xs">Range
            <select className={`${field} mt-0.5 block`} value={range} onChange={(e) => setRange(Number(e.target.value))} data-testid="preview-range">
              {PREVIEW_RANGES.map((r) => <option key={r.seconds} value={r.seconds}>{r.label}</option>)}
            </select></label>
          <Button type="button" variant="ghost" disabled={run.isPending || !!disabledReason} onClick={start} data-testid="rule-preview-run" title={disabledReason ?? undefined}>{run.isPending ? 'Previewing…' : 'Preview'}</Button>
        </div>
      </div>
      {disabledReason && <p className="text-xs text-slate-600 dark:text-slate-400">{disabledReason}</p>}

      <div aria-live="polite">
        {run.isPending && <Loading label="Replaying the rule over history…" />}
        {run.isError && <p role="alert" className="text-sm text-red-700 dark:text-red-400" data-testid="preview-error">Preview failed: {errorText(run.error)}</p>}
        {run.data && !run.isPending && <Result r={run.data} groupIdx={groupIdx} setGroupIdx={setGroupIdx} stale={stale} />}
      </div>
    </section>
  );
}

function Result({ r, groupIdx, setGroupIdx, stale }: { r: RulePreviewResult; groupIdx: number; setGroupIdx: (n: number) => void; stale: boolean }) {
  const verdict = previewVerdict(r);
  const g = r.groups[Math.min(groupIdx, r.groups.length - 1)];
  return (
    <div className="space-y-3" data-testid="preview-result">
      {stale && <p role="status" className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200" data-testid="preview-stale">The form changed since this preview. Press Preview again to refresh it.</p>}
      {verdict === 'no_data' ? (
        <div role="status" className="rounded border border-dashed border-slate-300 p-3 text-sm dark:border-slate-700" data-testid="preview-empty">
          <p className="font-medium">No data in this range</p>
          <p className="text-slate-600 dark:text-slate-400">The stores have no measurements for this selection between {r.from.slice(0, 16).replace('T', ' ')} and {r.to.slice(0, 16).replace('T', ' ')} UTC, so the rule had nothing to judge. Check the metric name, service, labels and environment.</p>
        </div>
      ) : (
        <p className="text-sm font-medium" data-testid="preview-summary">{previewSummary(r)}</p>
      )}

      {verdict !== 'no_data' && g && (
        <>
          {r.groups.length > 1 && (
            <label className="block text-xs">Group
              <select className={`${field} mt-0.5 block`} value={groupIdx} onChange={(e) => setGroupIdx(Number(e.target.value))} data-testid="preview-group">
                {r.groups.map((x, i) => <option key={x.key} value={i}>{groupLabel(x)}{x.wouldOpen ? ` (${x.wouldOpen} incident${x.wouldOpen === 1 ? '' : 's'})` : ''}</option>)}
              </select></label>
          )}
          <PreviewChart r={r} group={g} />
          <div>
            <h4 className="text-xs font-semibold">When it would have fired ({groupLabel(g)})</h4>
            {g.periods.length === 0
              ? <p className="text-xs text-slate-600 dark:text-slate-400" data-testid="preview-no-periods">Never: the condition was not met long enough in this range.</p>
              : <ul className="mt-0.5 list-disc pl-5 text-xs" data-testid="preview-periods">{g.periods.map((p, i) => <li key={i}>{periodText(p)}</li>)}</ul>}
          </div>
          <details className="text-xs">
            <summary className="cursor-pointer">Show the data as a table</summary>
            <div tabIndex={0} role="region" aria-label="Preview data, scrollable" className="mt-1 max-h-60 overflow-auto rounded border border-slate-200 focus:outline focus:outline-2 focus:outline-indigo-600 dark:border-slate-800">
              <table className="w-full text-left" aria-label="Preview data" data-testid="preview-table">
                <thead className="sticky top-0 bg-white text-slate-600 dark:bg-slate-900 dark:text-slate-400"><tr><th scope="col" className="px-2 py-1">Time (UTC)</th><th scope="col" className="px-2 py-1 text-right">Value</th><th scope="col" className="px-2 py-1">State</th></tr></thead>
                <tbody>{r.times.map((t, i) => (
                  <tr key={t} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="px-2 py-0.5 font-mono">{new Date(t).toISOString().slice(0, 19).replace('T', ' ')}{r.skipped.includes(i) ? ' (skipped)' : ''}</td>
                    <td className="px-2 py-0.5 text-right tabular-nums">{g.values[i] === null || g.values[i] === undefined ? 'no data' : num(g.values[i])}</td>
                    <td className="px-2 py-0.5">{g.states[i]}</td>
                  </tr>))}</tbody>
              </table>
            </div>
          </details>
        </>
      )}

      <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-600 dark:text-slate-400" data-testid="preview-notes">{r.notes.map((n) => <li key={n}>{n}</li>)}</ul>
      <p className="text-xs text-slate-600 dark:text-slate-400"><Badge>{r.times.length} evaluations</Badge> every {r.stepSeconds < 60 ? `${r.stepSeconds} s` : `${Math.round(r.stepSeconds / 6) / 10} min`}{r.partial ? ' · partial result' : ''} · {r.elapsedMs} ms</p>
    </div>
  );
}

function PreviewChart({ r, group }: { r: RulePreviewResult; group: RulePreviewResult['groups'][number] }) {
  const m = chartModel(r, group);
  const { w, h, l, r: rr, t, b } = CHART;
  return (
    <figure className="space-y-1" data-testid="preview-chart">
      <svg role="img" aria-label={chartAlt(r, group, groupLabel(group))} viewBox={`0 0 ${w} ${h}`} className="w-full" style={{ height: 'auto', maxHeight: 230 }}>
        {m.yTicks.map((k) => (
          <g key={k.label + k.y}>
            <line x1={l} x2={w - rr} y1={k.y} y2={k.y} className="stroke-slate-200 dark:stroke-slate-800" strokeWidth={1} />
            <text x={l - 4} y={k.y + 3} textAnchor="end" className="fill-slate-600 text-[10px] dark:fill-slate-400">{k.label}</text>
          </g>
        ))}
        {m.xTicks.map((k) => <text key={k.x} x={k.x} y={h - b + 14} textAnchor="middle" className="fill-slate-600 text-[10px] dark:fill-slate-400">{k.label}</text>)}
        {m.bands.map((band, i) => (
          <rect key={i} x={band.x} width={band.width} y={t} height={h - t - b} data-kind={band.kind}
            className={band.kind === 'firing' ? 'fill-red-600/20 dark:fill-red-400/25' : 'fill-amber-500/20 dark:fill-amber-400/20'} />
        ))}
        <line x1={l} x2={w - rr} y1={m.thresholdY} y2={m.thresholdY} strokeDasharray="5 3" strokeWidth={1.5} className="stroke-red-700 dark:stroke-red-400" data-testid="preview-threshold" />
        {m.segments.map((d, i) => <path key={i} d={d} fill="none" strokeWidth={1.75} className="stroke-indigo-600 dark:stroke-indigo-400" />)}
        {m.dots.map((d, i) => <circle key={i} cx={d.x} cy={d.y} r={2.5} className="fill-indigo-600 dark:fill-indigo-400" />)}
      </svg>
      <figcaption className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-400">
        <span><span aria-hidden className="mr-1 inline-block h-0.5 w-4 bg-indigo-600 align-middle dark:bg-indigo-400" />value (gaps = no data, never zero)</span>
        <span><span aria-hidden className="mr-1 inline-block w-4 border-t-2 border-dashed border-red-700 align-middle dark:border-red-400" />threshold {OPS[r.condition.op]} {num(r.condition.threshold)}</span>
        <span><span aria-hidden className="mr-1 inline-block h-3 w-4 bg-amber-500/30 align-middle" />pending</span>
        <span><span aria-hidden className="mr-1 inline-block h-3 w-4 bg-red-600/30 align-middle" />would fire</span>
      </figcaption>
    </figure>
  );
}
