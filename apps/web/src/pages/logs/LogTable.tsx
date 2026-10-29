import type { LogSummary } from '@nexus/contracts';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useEffect, useRef } from 'react';
import { Badge } from '../../ui';
import { SEVERITY_TONE, utc } from './model';

const ROW = 34;
const COLS = 'grid-cols-[11.5rem_5.5rem_9rem_1fr_4rem] max-md:grid-cols-[5.5rem_1fr_3rem]';

/**
 * Virtualized result list: only the rows in view exist in the DOM, so tens of thousands of results stay fast.
 * Rows are focusable; Enter/Space opens details and the arrow keys move between rows.
 */
export function LogTable({
  items, selectedId, onSelect, onNearEnd, hasMore, loadingMore, envNames,
}: {
  items: LogSummary[]; selectedId: string | null; onSelect: (id: string) => void;
  onNearEnd: () => void; hasMore: boolean; loadingMore: boolean; envNames: Map<string, string>;
}) {
  const parent = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: items.length, getScrollElement: () => parent.current, estimateSize: () => ROW, overscan: 12 });
  const rows = v.getVirtualItems();
  const last = rows[rows.length - 1];

  useEffect(() => {
    if (hasMore && !loadingMore && last && last.index >= items.length - 15) onNearEnd();
  }, [last?.index, items.length, hasMore, loadingMore, onNearEnd]);

  const focusRow = (i: number) => {
    v.scrollToIndex(i);
    requestAnimationFrame(() => parent.current?.querySelector<HTMLElement>(`[data-row="${i}"]`)?.focus());
  };

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-white text-sm dark:border-slate-800 dark:bg-slate-900">
     <div role="table" aria-label="Log results" aria-rowcount={items.length + 1}>
      <div role="rowgroup">
      <div role="row" className={`grid ${COLS} gap-2 border-b border-slate-200 px-3 py-2 text-xs font-semibold uppercase text-slate-600 dark:border-slate-800 dark:text-slate-400`}>
        <span role="columnheader" className="max-md:hidden">Time (UTC)</span>
        <span role="columnheader" className="md:hidden">Sev</span>
        <span role="columnheader" className="max-md:hidden">Severity</span>
        <span role="columnheader" className="max-md:hidden">Service</span>
        <span role="columnheader">Message</span>
        <span role="columnheader">HTTP</span>
      </div>
      </div>
      <div role="rowgroup" ref={parent} tabIndex={-1} className="h-[min(60vh,32rem)] overflow-auto">
        <div style={{ height: v.getTotalSize(), position: 'relative' }}>
          {rows.map((vr) => {
            const it = items[vr.index]!;
            const selected = it.id === selectedId;
            return (
              <div
                key={it.id} role="row" data-row={vr.index} tabIndex={0} aria-selected={selected} aria-rowindex={vr.index + 2}
                onClick={() => onSelect(it.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect(it.id); }
                  else if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(Math.min(items.length - 1, vr.index + 1)); }
                  else if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(Math.max(0, vr.index - 1)); }
                }}
                style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: ROW, transform: `translateY(${vr.start}px)` }}
                className={`grid ${COLS} cursor-pointer items-center gap-2 border-b border-slate-100 px-3 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/60 ${selected ? 'bg-indigo-50 dark:bg-indigo-950/50' : ''}`}
              >
                <span role="cell" className="font-mono text-xs max-md:hidden">{utc(it.ts)}</span>
                <span role="cell"><Badge tone={SEVERITY_TONE[it.severity]}>{it.severity}</Badge></span>
                <span role="cell" className="truncate max-md:hidden" title={envNames.get(it.environmentId)}>{it.service ?? <span className="text-slate-500">unavailable</span>}</span>
                <span role="cell" className="truncate font-mono text-xs" title={it.message}>{it.message || <span className="text-slate-500">(empty message)</span>}</span>
                <span role="cell" className="text-xs tabular-nums">{it.httpStatus ?? '—'}</span>
              </div>
            );
          })}
        </div>
      </div>
     </div>
      <div className="border-t border-slate-200 px-3 py-1.5 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-400" role="status">
        {items.length.toLocaleString()} loaded{hasMore ? (loadingMore ? ' · loading more…' : ' · scroll for more') : ' · end of results'}
      </div>
    </div>
  );
}
