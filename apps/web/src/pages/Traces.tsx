import type { ServiceOverview, TraceSearchResult, TraceSummaryDto } from '@nexus/contracts';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { z } from 'zod';
import { api } from '../api';
import { Badge, Button, EmptyState, ErrorState, Loading } from '../ui';
import { formatNs } from './traces/waterfall-model';
import { PRESETS, resolveRange, toTraceQuery, traceFiltersFromParams, traceFiltersToParams, traceLink, type TraceFilters } from './traces/model';
import { fieldClass, ProjectGate, toLocalInput } from './traces/shared';
import { utc } from './logs/model';

type Result = z.infer<typeof TraceSearchResult>;
type Services = z.infer<typeof ServiceOverview>;

function Results({ projectId, applied, nowMs, envNames }: { projectId: string; applied: TraceFilters; nowMs: number; envNames: Map<string, string> }) {
  const query = useMemo(() => toTraceQuery(applied, nowMs), [applied, nowMs]);
  const q = useInfiniteQuery({
    queryKey: ['traces', projectId, query], retry: false, initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<Result>('POST', `/api/v1/projects/${projectId}/traces/search`, { ...query, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items: TraceSummaryDto[] = q.data?.pages.flatMap((p) => p.items) ?? [];
  const range = resolveRange(applied, nowMs);

  if (q.isPending) return <Loading label="Searching traces…" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} />;
  if (items.length === 0) {
    return (
      <EmptyState title="No traces match this search">
        Try a wider time range or fewer filters. A trace appears here only after at least one of its spans has been received; if you expect traces, check that your
        application exports to <code className="font-mono">/v1/traces</code> with a token that includes the “traces” signal (<Link className="underline" to="/sources?tab=ingestion">ingestion setup</Link>).
      </EmptyState>
    );
  }
  return (
    <div className="space-y-2">
      <div aria-live="polite" data-testid="trace-summary" className="text-sm text-slate-600 dark:text-slate-400">
        {items.length.toLocaleString()}{q.hasNextPage ? '+' : ''} trace(s) · UTC {utc(range.from).slice(0, 19)} → {utc(range.to).slice(0, 19)} · {applied.sort === 'slowest' ? 'slowest first' : 'newest first'}
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full min-w-[44rem] text-left text-sm" aria-label="Trace results">
          <thead className="border-b border-slate-200 text-xs uppercase text-slate-600 dark:border-slate-800 dark:text-slate-400">
            <tr><th scope="col" className="px-3 py-2">Started (UTC)</th><th scope="col" className="px-3 py-2">Operation</th><th scope="col" className="px-3 py-2">Services</th>
              <th scope="col" className="px-3 py-2 text-right">Duration</th><th scope="col" className="px-3 py-2 text-right">Spans</th><th scope="col" className="px-3 py-2 text-right">Errors</th>
              <th scope="col" className="px-3 py-2">HTTP</th><th scope="col" className="px-3 py-2">Trace</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((t) => (
              <tr key={`${t.environmentId}${t.traceId}`} data-testid="trace-row" className="hover:bg-slate-50 dark:hover:bg-slate-800/60">
                <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{utc(t.start).slice(0, 23)}</td>
                <td className="max-w-[18rem] truncate px-3 py-2" title={t.rootName ?? 'No root span received'}>
                  <Link className="text-indigo-700 underline dark:text-indigo-300" to={traceLink(t.traceId, projectId, t.environmentId)}>{t.rootName ?? <span className="italic">(root span not received)</span>}</Link>
                  <span className="ml-1 text-xs text-slate-600 dark:text-slate-400">{envNames.get(t.environmentId) ?? ''}</span>
                </td>
                <td className="px-3 py-2 text-xs">{t.services.length ? t.services.join(', ') : <span className="text-slate-600 dark:text-slate-400">unavailable</span>}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatNs(t.durationNs)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{t.spanCount}</td>
                <td className="px-3 py-2 text-right tabular-nums">{t.errorCount > 0 ? <Badge tone="danger">✕ {t.errorCount}</Badge> : <span className="text-slate-600 dark:text-slate-400">0</span>}</td>
                <td className="px-3 py-2 text-xs tabular-nums">{t.httpMethod ?? ''} {t.httpRoute ?? ''} {t.httpStatus ?? (t.httpMethod || t.httpRoute ? '' : '—')}</td>
                <td className="px-3 py-2 text-xs">
                  <span className="font-mono">{t.traceId.slice(0, 8)}…</span> {t.completeness === 'partial' && <Badge tone="warn">partial</Badge>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {q.hasNextPage && <Button variant="ghost" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? 'Loading…' : 'Load more traces'}</Button>}
      <p className="text-xs text-slate-600 dark:text-slate-400">“Partial” means a root span is missing or a span refers to a parent that has not been received; it is a statement about what arrived, not a guarantee that complete traces have everything.</p>
    </div>
  );
}

export default function Traces() {
  const [sp, setSp] = useSearchParams();
  const urlProject = sp.get('p');
  const initial = useMemo(() => traceFiltersFromParams(sp), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState<TraceFilters>(initial);
  const [applied, setApplied] = useState<TraceFilters>(initial);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);

  return (
    <ProjectGate title="Traces" urlProject={urlProject}>
      {(project) => <Body project={project} sp={sp} setSp={setSp} draft={draft} setDraft={setDraft} applied={applied} setApplied={setApplied} nowMs={nowMs} setNowMs={setNowMs} copied={copied} setCopied={setCopied} />}
    </ProjectGate>
  );
}

function Body({ project, setSp, draft, setDraft, applied, setApplied, nowMs, setNowMs, copied, setCopied }: {
  project: NonNullable<ReturnType<typeof import('../session').useSelection>['project']>; sp: URLSearchParams; setSp: ReturnType<typeof useSearchParams>[1];
  draft: TraceFilters; setDraft: (f: TraceFilters) => void; applied: TraceFilters; setApplied: (f: TraceFilters) => void; nowMs: number; setNowMs: (n: number) => void;
  copied: boolean; setCopied: (b: boolean) => void;
}) {
  const envNames = useMemo(() => new Map(project.environments.map((e) => [e.id, e.name])), [project]);
  const services = useQuery({ queryKey: ['services-names', project.id], staleTime: 60_000, retry: false, queryFn: () => api<Services>('GET', `/api/v1/projects/${project.id}/services?minutes=1440`) });
  const serviceNames = useMemo(() => [...new Set((services.data?.services ?? []).map((s) => s.service))], [services.data]);
  const run = useCallback((f: TraceFilters) => { setApplied(f); setDraft(f); setNowMs(Date.now()); setSp(traceFiltersToParams(f, project.id), { replace: true }); }, [project.id, setApplied, setDraft, setNowMs, setSp]);
  const set = <K extends keyof TraceFilters>(k: K, v: TraceFilters[K]) => setDraft({ ...draft, [k]: v });
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Traces <span className="text-base font-normal text-slate-600 dark:text-slate-400">· {project.name}</span></h1>
        <Button variant="ghost" onClick={() => { void navigator.clipboard?.writeText(window.location.href).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? 'Link copied' : 'Copy link'}</Button>
      </div>

      <form className="space-y-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900" aria-label="Trace search" onSubmit={(e) => { e.preventDefault(); run(draft); }}>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs">Time range
            <select className={`${fieldClass} mt-0.5 block`} value={draft.range} onChange={(e) => setDraft({ ...draft, range: e.target.value, ...(e.target.value === 'custom' && !draft.from ? { from: new Date(Date.now() - 3600_000).toISOString(), to: new Date().toISOString() } : {}) })}>
              {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}<option value="custom">Custom range</option></select></label>
          {draft.range === 'custom' && (
            <>
              <label className="text-xs">From<input type="datetime-local" className={`${fieldClass} mt-0.5 block`} value={draft.from ? toLocalInput(draft.from) : ''} onChange={(e) => set('from', e.target.value ? new Date(e.target.value).toISOString() : '')} /></label>
              <label className="text-xs">To<input type="datetime-local" className={`${fieldClass} mt-0.5 block`} value={draft.to ? toLocalInput(draft.to) : ''} onChange={(e) => set('to', e.target.value ? new Date(e.target.value).toISOString() : '')} /></label>
            </>
          )}
          <label className="min-w-[16rem] flex-1 text-xs">Trace ID
            <input className={`${fieldClass} mt-0.5 block w-full font-mono`} value={draft.traceId} maxLength={32} placeholder="32 hex characters" spellCheck={false} onChange={(e) => set('traceId', e.target.value.trim().toLowerCase())} /></label>
          <label className="text-xs">Service
            <input list="svc-list" className={`${fieldClass} mt-0.5 block w-44`} value={draft.services.join(',')} placeholder="any" onChange={(e) => set('services', e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
            <datalist id="svc-list">{serviceNames.map((s) => <option key={s} value={s} />)}</datalist></label>
          <label className="text-xs">Span name contains
            <input className={`${fieldClass} mt-0.5 block w-44`} value={draft.spanName} maxLength={200} placeholder="GET /orders" onChange={(e) => set('spanName', e.target.value)} /></label>
          <label className="text-xs">Result
            <select className={`${fieldClass} mt-0.5 block`} value={draft.errorsOnly ? 'error' : draft.okOnly ? 'ok' : ''} onChange={(e) => setDraft({ ...draft, errorsOnly: e.target.value === 'error', okOnly: e.target.value === 'ok' })}>
              <option value="">Any</option><option value="error">Has an error span</option><option value="ok">No error spans</option></select></label>
          <label className="text-xs">Sort
            <select className={`${fieldClass} mt-0.5 block`} value={draft.sort} onChange={(e) => set('sort', e.target.value as TraceFilters['sort'])}><option value="recent">Newest first</option><option value="slowest">Slowest first</option></select></label>
          <Button type="submit">Search traces</Button>
        </div>
        <details className="text-sm"><summary className="cursor-pointer">More filters</summary>
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label className="text-xs">Min duration (ms)<input type="number" min={0} className={`${fieldClass} mt-0.5 block w-28`} value={draft.minMs} onChange={(e) => set('minMs', e.target.value)} /></label>
            <label className="text-xs">Max duration (ms)<input type="number" min={0} className={`${fieldClass} mt-0.5 block w-28`} value={draft.maxMs} onChange={(e) => set('maxMs', e.target.value)} /></label>
            <label className="text-xs">HTTP status<input className={`${fieldClass} mt-0.5 block w-24`} value={draft.httpStatus} inputMode="numeric" maxLength={3} placeholder="500" onChange={(e) => set('httpStatus', e.target.value.replace(/\D/g, ''))} /></label>
            <label className="text-xs">HTTP method<input className={`${fieldClass} mt-0.5 block w-24`} value={draft.httpMethod} maxLength={16} placeholder="GET" onChange={(e) => set('httpMethod', e.target.value.toUpperCase())} /></label>
            <label className="text-xs">HTTP route contains<input className={`${fieldClass} mt-0.5 block w-44`} value={draft.httpRoute} maxLength={200} placeholder="/orders/:id" onChange={(e) => set('httpRoute', e.target.value)} /></label>
            <label className="text-xs">Database system<input className={`${fieldClass} mt-0.5 block w-32`} value={draft.dbSystem} maxLength={64} placeholder="mongodb" onChange={(e) => set('dbSystem', e.target.value)} /></label>
            <label className="text-xs">Exception type contains<input className={`${fieldClass} mt-0.5 block w-44`} value={draft.exceptionType} maxLength={200} placeholder="TimeoutError" onChange={(e) => set('exceptionType', e.target.value)} /></label>
            {project.environments.length > 1 && (
              <fieldset className="text-xs"><legend>Environments</legend>
                <div className="mt-0.5 flex flex-wrap gap-3">{project.environments.map((e) => (
                  <label key={e.id} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={draft.envIds.includes(e.id)} onChange={(ev) => set('envIds', ev.target.checked ? [...draft.envIds, e.id] : draft.envIds.filter((x) => x !== e.id))} />{e.name}{e.isProduction && <Badge tone="danger">production</Badge>}</label>))}</div></fieldset>
            )}
          </div>
        </details>
      </form>
      {dirty && <p className="text-xs text-slate-600 dark:text-slate-400" role="note">You have unapplied changes. Press “Search traces”.</p>}
      <Results projectId={project.id} applied={applied} nowMs={nowMs} envNames={envNames} />
    </div>
  );
}
