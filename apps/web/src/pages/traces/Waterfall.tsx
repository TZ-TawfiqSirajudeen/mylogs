import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../../ui';
import { axisTicks, formatNs, FULL, project, zoomTo, type View, type WaterfallModel, type WaterfallRow } from './waterfall-model';

const ROW = 30;
const GRID = 'grid grid-cols-[minmax(11rem,40%)_1fr] max-md:grid-cols-[minmax(8rem,46%)_1fr]';

/** Text-only description of what the bar shows. Rendered as screen-reader-only content so the row's accessible name is built from its visible
 *  content plus this (no aria-label override, which would break "label in name"). */
const describe = (r: WaterfallRow) =>
  `${r.span.kind}${r.failed ? ', failed' : r.span.statusCode === 'ok' ? ', ok' : ''}${r.slow ? ', slow' : ''}, starts ${formatNs(r.offsetNs)} after the trace start, ` +
  `duration ${formatNs(r.durationNs)}${r.orphan ? ', parent not received' : ''}${r.startsBeforeParent ? ', starts before its parent' : ''}`;

/**
 * Interactive request waterfall: a span tree on the left, a shared time axis on the right. Rows are virtualized (only what is on
 * screen exists in the DOM), keyboard operable (arrows, Left/Right to collapse/expand, Enter to select) and every row has a full
 * text description; a table alternative is offered next to it for anyone who cannot use the visual timeline.
 */
export function Waterfall({ model, selectedId, onSelect, collapsed, onToggle, onCollapseAll, onExpandAll, view, onView, logCounts }: {
  model: WaterfallModel; selectedId: string | null; onSelect: (id: string) => void;
  collapsed: ReadonlySet<string>; onToggle: (id: string) => void; onCollapseAll: () => void; onExpandAll: () => void;
  view: View; onView: (v: View) => void; logCounts: Record<string, number>;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const rows = model.rows;
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => parent.current, estimateSize: () => ROW, overscan: 10 });
  const ticks = useMemo(() => axisTicks(model.traceDurationNs, view), [model.traceDurationNs, view]);
  const zoomed = view.end - view.start < 0.9999;

  // Keep the active row inside the rendered range and in sync with the selection.
  const selIndex = rows.findIndex((r) => r.span.spanId === selectedId);
  useEffect(() => { if (selIndex >= 0) setActive(selIndex); }, [selIndex]);
  useEffect(() => { if (active >= rows.length) setActive(Math.max(0, rows.length - 1)); }, [rows.length, active]);

  const focusRow = (i: number) => {
    const n = Math.max(0, Math.min(rows.length - 1, i));
    setActive(n);
    v.scrollToIndex(n);
    requestAnimationFrame(() => parent.current?.querySelector<HTMLElement>(`[data-row="${n}"]`)?.focus());
  };
  const onKey = (e: React.KeyboardEvent, i: number) => {
    const r = rows[i]!;
    if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(i - 1); }
    else if (e.key === 'Home') { e.preventDefault(); focusRow(0); }
    else if (e.key === 'End') { e.preventDefault(); focusRow(rows.length - 1); }
    else if (e.key === 'ArrowRight') {
      e.preventDefault();
      if (r.hasChildren && r.collapsed) onToggle(r.span.spanId); else if (r.hasChildren) focusRow(i + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (r.hasChildren && !r.collapsed) onToggle(r.span.spanId);
      else { for (let k = i - 1; k >= 0; k--) if (rows[k]!.depth < r.depth) { focusRow(k); break; } }
    } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(r.span.spanId); }
  };
  const selectedRow = rows[selIndex];
  const centre = selectedRow ? selectedRow.left + selectedRow.width / 2 : (view.start + view.end) / 2;

  return (
    <div className="rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-3 py-2 text-sm dark:border-slate-800" role="toolbar" aria-label="Waterfall controls">
        <Button type="button" variant="ghost" aria-label="Zoom in" onClick={() => onView(zoomTo(view, centre, 0.5))}>＋</Button>
        <Button type="button" variant="ghost" aria-label="Zoom out" onClick={() => onView(zoomTo(view, centre, 2))}>－</Button>
        <Button type="button" variant="ghost" disabled={!zoomed} onClick={() => onView(FULL)}>Reset zoom</Button>
        <Button type="button" variant="ghost" disabled={!selectedRow} onClick={() => selectedRow && onView(zoomTo(FULL, centre, Math.max(0.001, Math.min(1, (selectedRow.width || 0.001) * 1.6))))}>Zoom to selected span</Button>
        <span className="mx-1 h-5 border-l border-slate-300 dark:border-slate-700" aria-hidden />
        <Button type="button" variant="ghost" onClick={onCollapseAll}>Collapse all</Button>
        <Button type="button" variant="ghost" onClick={onExpandAll}>Expand all</Button>
        <span className="ml-auto text-xs text-slate-600 dark:text-slate-400" role="status">
          Showing {formatNs(view.start * model.traceDurationNs)} – {formatNs(view.end * model.traceDurationNs)} of {formatNs(model.traceDurationNs)} · {rows.length} of {model.spanCount} spans visible
        </span>
      </div>

      <div className={`${GRID} border-b border-slate-200 text-xs font-semibold uppercase text-slate-600 dark:border-slate-800 dark:text-slate-400`} aria-hidden>
        <div className="px-3 py-2">Span</div>
        <div className="relative h-8 overflow-hidden">
          {ticks.map((t) => (
            <span key={t.ns} className="absolute top-2 -translate-x-1/2 whitespace-nowrap px-1 font-normal normal-case" style={{ left: `${t.frac * 100}%` }}>{formatNs(t.ns)}</span>
          ))}
        </div>
      </div>

      <div ref={parent} className="h-[min(55vh,32rem)] overflow-auto" role="tree" aria-label="Spans of this trace" aria-multiselectable={false} data-testid="waterfall">
        <div style={{ height: v.getTotalSize(), position: 'relative' }}>
          <div className={`${GRID} pointer-events-none absolute inset-0`} aria-hidden>
            <div />
            <div className="relative">{ticks.map((t) => <span key={t.ns} className="absolute inset-y-0 border-l border-slate-100 dark:border-slate-800" style={{ left: `${t.frac * 100}%` }} />)}</div>
          </div>
          {v.getVirtualItems().map((vr) => {
            const r = rows[vr.index]!;
            const selected = r.span.spanId === selectedId;
            const pos = project(r, view);
            const widthPct = pos ? Math.max(pos.width * 100, r.durationNs === null ? 0 : 0.25) : 0;
            const logs = logCounts[r.span.spanId] ?? 0;
            return (
              <div
                key={r.span.spanId} role="treeitem" data-row={vr.index} data-span={r.span.spanId} tabIndex={vr.index === active ? 0 : -1} aria-level={r.depth + 1}
                aria-expanded={r.hasChildren ? !r.collapsed : undefined} aria-selected={selected}
                onClick={() => { setActive(vr.index); onSelect(r.span.spanId); }} onKeyDown={(e) => onKey(e, vr.index)} onFocus={() => setActive(vr.index)}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: ROW, transform: `translateY(${vr.start}px)` }}
                className={`${GRID} cursor-pointer items-center border-b border-slate-100 text-sm outline-none hover:bg-slate-50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-indigo-500 dark:border-slate-800 dark:hover:bg-slate-800/60 ${selected ? 'bg-indigo-50 dark:bg-indigo-950/50' : ''}`}
              >
                <div className="flex min-w-0 items-center gap-1 pr-2" style={{ paddingLeft: 8 + Math.min(r.depth, 12) * 14 }}>
                  {r.hasChildren
                    ? <button type="button" tabIndex={-1} aria-label={`${r.collapsed ? 'Expand' : 'Collapse'} ${r.span.name}`} className="w-5 shrink-0 rounded text-xs text-slate-600 hover:bg-slate-200 dark:text-slate-400 dark:hover:bg-slate-700"
                        onClick={(e) => { e.stopPropagation(); onToggle(r.span.spanId); }}><span aria-hidden>{r.collapsed ? '▸' : '▾'}</span></button>
                    : <span className="w-5 shrink-0" aria-hidden />}
                  {r.failed && <span aria-hidden title="Failed" className="shrink-0 font-bold text-red-700 dark:text-red-400">✕</span>}
                  <span className="truncate" title={`${r.span.name} — ${r.span.service ?? 'unknown service'}`}>{r.span.name}</span>
                  <span className="sr-only">{`, ${r.span.service ?? 'unknown service'}, ${describe(r)}`}</span>
                  <span className="hidden shrink-0 text-xs text-slate-600 dark:text-slate-400 lg:inline">{r.span.service ?? ''}</span>
                  {r.collapsed && <span className="shrink-0 rounded bg-slate-200 px-1 text-[10px] dark:bg-slate-700">+{r.descendants}</span>}
                  {r.orphan && <span className="shrink-0 rounded border border-amber-600 px-1 text-[10px] text-amber-800 dark:border-amber-400 dark:text-amber-300" title="Its parent span was not received">orphan</span>}
                  {logs > 0 && <span className="shrink-0 rounded border border-slate-400 px-1 text-[10px] text-slate-700 dark:border-slate-500 dark:text-slate-300" title={`${logs} related log record(s)`}>{logs} log{logs === 1 ? '' : 's'}</span>}
                </div>
                <div className="relative h-full" aria-hidden>
                  {pos && (r.durationNs === null
                    ? <span title="Duration unknown (no valid end time)" className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rotate-45 border-2 border-slate-700 bg-white dark:border-slate-300 dark:bg-slate-900" style={{ left: `${pos.left * 100}%` }} />
                    : (
                      <div
                        className={`absolute top-1/2 h-4 -translate-y-1/2 rounded-sm ${r.failed ? 'bg-red-700 dark:bg-red-500' : 'bg-indigo-600 dark:bg-indigo-400'} ${r.slow ? 'ring-2 ring-amber-500' : ''} ${r.failed ? 'bg-[repeating-linear-gradient(135deg,transparent_0_4px,rgba(255,255,255,.28)_4px_8px)]' : ''}`}
                        style={{ left: `${pos.left * 100}%`, width: `${widthPct}%`, minWidth: 2 }}
                        title={`${r.span.name}: ${formatNs(r.durationNs)} at +${formatNs(r.offsetNs)}`}
                      />
                    ))}
                  {pos && r.durationNs !== null && (
                    <span className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap pl-1 text-xs text-slate-700 dark:text-slate-300" style={{ left: `${Math.min(92, (pos.left + pos.width) * 100)}%` }}>{formatNs(r.durationNs)}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <p className="border-t border-slate-200 px-3 py-1.5 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-400">
        <span aria-hidden>✕</span> failed · amber ring = slow (at least half of the trace) · ◇ = no valid end time (duration unknown). Bars sit exactly where each span’s timestamps put them; overlapping spans overlap. Use ↑ ↓ to move, ← → to collapse/expand, Enter to select.
      </p>
    </div>
  );
}

/** The same information as a plain table, for anyone who cannot use (or prefers not to use) the visual timeline. */
export function SpanTable({ model, selectedId, onSelect, logCounts }: { model: WaterfallModel; selectedId: string | null; onSelect: (id: string) => void; logCounts: Record<string, number> }) {
  const [limit, setLimit] = useState(300);
  const rows = model.rows.slice(0, limit);
  return (
    <div className="space-y-2">
      <div className="max-h-[32rem] overflow-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full min-w-[44rem] text-left text-sm" aria-label="Spans of this trace (table)" data-testid="span-table">
          <thead className="sticky top-0 bg-white text-xs uppercase text-slate-600 dark:bg-slate-900 dark:text-slate-400">
            <tr><th scope="col" className="px-3 py-2">Span</th><th scope="col" className="px-3 py-2">Service</th><th scope="col" className="px-3 py-2">Kind</th><th scope="col" className="px-3 py-2">Status</th>
              <th scope="col" className="px-3 py-2 text-right">Start offset</th><th scope="col" className="px-3 py-2 text-right">Duration</th><th scope="col" className="px-3 py-2 text-right">Logs</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {rows.map((r) => (
              <tr key={r.span.spanId} aria-selected={r.span.spanId === selectedId} className={r.span.spanId === selectedId ? 'bg-indigo-50 dark:bg-indigo-950/50' : ''}>
                <th scope="row" className="px-3 py-1.5 font-normal" style={{ paddingLeft: 12 + Math.min(r.depth, 12) * 14 }}>
                  <button type="button" className="text-left text-indigo-700 underline dark:text-indigo-300" onClick={() => onSelect(r.span.spanId)}>{r.span.name}</button>
                  {r.orphan && <span className="ml-1 text-xs text-amber-800 dark:text-amber-300">(parent not received)</span>}
                </th>
                <td className="px-3 py-1.5">{r.span.service ?? 'unavailable'}</td>
                <td className="px-3 py-1.5">{r.span.kind}</td>
                <td className="px-3 py-1.5">{r.failed ? '✕ error' : r.span.statusCode}{r.span.statusMessage ? ` — ${r.span.statusMessage}` : ''}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">+{formatNs(r.offsetNs)}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{formatNs(r.durationNs)}{r.slow ? ' (slow)' : ''}</td>
                <td className="px-3 py-1.5 text-right tabular-nums">{logCounts[r.span.spanId] ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {model.rows.length > limit && <Button variant="ghost" onClick={() => setLimit(limit + 300)}>Show more spans ({model.rows.length - limit} remaining)</Button>}
    </div>
  );
}
