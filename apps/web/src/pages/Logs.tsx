import type { IngestStatsDto, LogFacets, LogFilter, LogHistogram, LogSearchResult, LogSummary, SavedQueryDto } from '@nexus/contracts';
import { FIELD_TYPES, SEVERITIES } from '@nexus/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { z } from 'zod';
import { api, downloadPost, streamEvents } from '../api';
import { useSelection } from '../session';
import { Badge, Button, Card, EmptyState, ErrorState, Loading } from '../ui';
import { Histogram } from './logs/Histogram';
import { LogDrawer } from './logs/LogDrawer';
import { LogTable } from './logs/LogTable';
import { applySaved, DEFAULT_FILTERS, describeFilter, FIELD_LABELS, fromParams, opsFor, PRESETS, toParams, toQuery, utc, type Filters } from './logs/model';

type Search = z.infer<typeof LogSearchResult>;
type Hist = z.infer<typeof LogHistogram>;
type Facets = z.infer<typeof LogFacets>;
type Stats = z.infer<typeof IngestStatsDto>;
type Saved = z.infer<typeof SavedQueryDto>;

const field = 'rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900';
const toLocalInput = (iso: string) => { const d = new Date(iso); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };

function FilterBuilder({ onAdd }: { onAdd: (f: LogFilter) => void }) {
  const [name, setName] = useState('service');
  const [attr, setAttr] = useState('');
  const [op, setOp] = useState('eq');
  const [value, setValue] = useState('');
  const fieldName = name === 'attr' ? `attr:${attr.trim()}` : name;
  const ops = opsFor(fieldName);
  const valid = (name !== 'attr' || /^[A-Za-z0-9_.\-/]{1,100}$/.test(attr.trim())) && (op === 'exists' || value !== '');
  const add = () => {
    if (!valid) return;
    onAdd({ field: fieldName, op: op as LogFilter['op'], ...(op === 'exists' ? {} : { value: FIELD_TYPES[fieldName as keyof typeof FIELD_TYPES] === 'number' ? Number(value) : value }) });
    setValue('');
  };
  // A group, NOT a <form>: this sits inside the search form, and nested forms made "Add filter" also submit the search
  // with stale state (silently discarding the filter just added). Enter in an input adds the filter instead.
  const onEnter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); add(); } };
  return (
    <div role="group" className="flex flex-wrap items-end gap-2" aria-label="Add a field filter">
      <label className="text-xs">Field<select className={`${field} mt-0.5 block`} value={name} onChange={(e) => { setName(e.target.value); setOp('eq'); }}>
        {Object.keys(FIELD_TYPES).map((k) => <option key={k} value={k}>{FIELD_LABELS[k] ?? k}</option>)}<option value="attr">Attribute…</option></select></label>
      {name === 'attr' && <label className="text-xs">Attribute name<input className={`${field} mt-0.5 block w-40`} value={attr} onChange={(e) => setAttr(e.target.value)} onKeyDown={onEnter} placeholder="customer.tier" /></label>}
      <label className="text-xs">Operator<select className={`${field} mt-0.5 block`} value={op} onChange={(e) => setOp(e.target.value)}>{ops.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
      {op !== 'exists' && <label className="text-xs">Value<input className={`${field} mt-0.5 block w-40`} value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onEnter} /></label>}
      <Button type="button" variant="ghost" disabled={!valid} onClick={add}>Add filter</Button>
    </div>
  );
}

export default function Logs() {
  const { project, environment, projects, projectsStatus, select } = useSelection();
  const qc = useQueryClient();
  const [sp, setSp] = useSearchParams();
  const initial = useMemo(() => fromParams(sp), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState<Filters>(initial);
  const [applied, setApplied] = useState<Filters>(initial);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [remember, setRemember] = useState(false);
  // Open/closed is the user's choice; it must not snap shut when the last filter chip is removed.
  const [filtersOpen, setFiltersOpen] = useState(initial.filters.length > 0);
  const selectedId = sp.get('id');
  const projectId = project?.id ?? null;
  const base = projectId ? `/api/v1/projects/${projectId}` : '';
  const canExport = !!project && project.role !== 'viewer';
  const canShare = canExport;

  // A shared link names its project: adopt it once the project list is known (access is still enforced by the server).
  const urlProject = sp.get('p');
  useEffect(() => {
    if (urlProject && project?.id !== urlProject && projects.some((x) => x.id === urlProject)) select(urlProject, null);
  }, [urlProject, project?.id, projects, select]);

  const envIds = applied.envIds.length ? applied.envIds : environment ? [environment.id] : [];
  const query = useMemo(() => toQuery({ ...applied, envIds }, nowMs), [applied, nowMs, environment?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const envNames = useMemo(() => new Map((project?.environments ?? []).map((e) => [e.id, e.name])), [project]);

  const commit = useCallback((f: Filters, id: string | null = selectedId) => { setSp(toParams(f, id, projectId), { replace: true }); }, [setSp, selectedId, projectId]);
  const run = (f: Filters = draft, remember_ = true) => { setApplied(f); setDraft(f); setNowMs(Date.now()); setRemember(remember_); commit(f); };
  /**
   * Adds a filter. Identifiers (trace / request id) are different: following one should show ALL the evidence for it,
   * so earlier narrowing (errors only, status filters, text, services) is dropped and only the time range is kept.
   */
  const addFilter = (f: LogFilter) => {
    const pivot = f.field === 'traceId' || f.field === 'requestId';
    const next: Filters = pivot
      ? { ...draft, text: '', minSeverity: '', errorsOnly: false, services: [], filters: [f] }
      : { ...draft, filters: [...draft.filters, f].slice(0, 10) };
    run(next, false);
  };
  const open = (id: string | null) => commit(applied, id);

  const search = useInfiniteQuery({
    queryKey: ['logs', projectId, query], enabled: !!projectId, retry: false, initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api<Search>('POST', `${base}/logs/search${remember && !pageParam ? '?remember=true' : ''}`, { ...query, ...(pageParam ? { cursor: pageParam } : {}) }),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const { cursor: _c, limit: _l, ...aggQuery } = query as Record<string, unknown>;
  const aggBody = { ...aggQuery, limit: 1 };
  const hist = useQuery({ queryKey: ['log-hist', projectId, query], enabled: !!projectId, retry: false, queryFn: () => api<Hist>('POST', `${base}/logs/histogram`, aggBody) });
  const facets = useQuery({ queryKey: ['log-facets', projectId, query], enabled: !!projectId, retry: false, queryFn: () => api<Facets>('POST', `${base}/logs/facets`, aggBody) });
  const stats = useQuery({ queryKey: ['ingest-stats', projectId], enabled: !!projectId, refetchInterval: 30_000, queryFn: () => api<Stats>('GET', `${base}/ingest/stats?minutes=60`) });
  const saved = useQuery({ queryKey: ['saved-queries', projectId], enabled: !!projectId, queryFn: () => api<Saved[]>('GET', `${base}/logs/saved-queries`) });
  const history = useQuery({ queryKey: ['log-history', projectId], enabled: !!projectId, queryFn: () => api<{ id: string; query: Record<string, unknown>; at: string }[]>('GET', `${base}/logs/history`) });

  useEffect(() => { if (search.isSuccess && remember) { setRemember(false); void qc.invalidateQueries({ queryKey: ['log-history', projectId] }); } }, [search.isSuccess, remember, qc, projectId]);

  // ---------------------------------------------------------------- live tail
  const [live, setLive] = useState(false);
  const [liveState, setLiveState] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [liveItems, setLiveItems] = useState<LogSummary[]>([]);
  useEffect(() => {
    if (!live || !projectId) return;
    const ctl = new AbortController();
    setLiveItems(search.data?.pages.flatMap((p) => p.items).slice(0, 200) ?? []);
    setLiveState('connecting');
    void (async () => {
      while (!ctl.signal.aborted) {
        try {
          await streamEvents(`/api/v1/projects/${projectId}/logs/tail`, { query: toQuery({ ...applied, envIds }, Date.now()) }, (ev, data) => {
            if (ev === 'ready') setLiveState('connected');
            if (ev === 'logs') setLiveItems((prev) => [...((data as { items: LogSummary[] }).items).reverse(), ...prev].slice(0, 2000));
          }, ctl.signal);
        } catch { if (ctl.signal.aborted) return; setLiveState('error'); }
        if (!ctl.signal.aborted) await new Promise((r) => setTimeout(r, 3000));
      }
    })();
    return () => ctl.abort();
  }, [live, projectId, applied, envIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = live ? liveItems : (search.data?.pages.flatMap((p) => p.items) ?? []);

  // ---------------------------------------------------------------- saved queries, export
  const [saveName, setSaveName] = useState('');
  const [saveShared, setSaveShared] = useState(false);
  const save = useMutation({
    mutationFn: () => api<Saved>('POST', `${base}/logs/saved-queries`, { name: saveName, shared: saveShared, query }),
    onSuccess: () => { setSaveName(''); void qc.invalidateQueries({ queryKey: ['saved-queries', projectId] }); },
  });
  const del = useMutation({ mutationFn: (id: string) => api('DELETE', `${base}/logs/saved-queries/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['saved-queries', projectId] }) });
  const [exportFormat, setExportFormat] = useState<'ndjson' | 'csv'>('csv');
  const exporting = useMutation({ mutationFn: () => downloadPost(`${base}/logs/export`, { query, format: exportFormat }, `logs.${exportFormat}`) });
  const [copied, setCopied] = useState(false);

  if (!project && urlProject && projectsStatus === 'success' && !projects.some((x) => x.id === urlProject)) {
    return (
      <div className="space-y-3"><h1 className="text-xl font-semibold">Logs</h1>
        <EmptyState title="Project not found">This link points to a project that does not exist or that you do not have access to.</EmptyState></div>
    );
  }
  if (!project) {
    return (
      <div className="space-y-3"><h1 className="text-xl font-semibold">Logs</h1>
        <EmptyState title="Select a project">{projects.length === 0 ? 'No projects yet.' : 'Choose a project in the header to search its logs.'}</EmptyState></div>
    );
  }

  const received = stats.data?.perEnvironment ?? [];
  const everReceived = received.some((e) => e.lastAcceptedAt);
  const newestArrival = received.map((e) => e.lastAcceptedAt).filter(Boolean).sort().at(-1) ?? null;
  const total = hist.data?.buckets.reduce((s, b) => s + b.total, 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Logs <span className="text-base font-normal text-slate-600 dark:text-slate-400">· {project.name}{environment ? ` / ${environment.name}` : ''}</span></h1>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant={live ? 'primary' : 'ghost'} aria-pressed={live} onClick={() => setLive((v) => !v)}>{live ? '● Live — stop' : 'Live tail'}</Button>
          <Button variant="ghost" onClick={() => { void navigator.clipboard?.writeText(window.location.href).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? 'Link copied' : 'Copy link'}</Button>
        </div>
      </div>

      {stats.data && stats.data.refused > 0 && (
        <p role="alert" className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100" data-testid="refused-banner">
          Telemetry was refused in the last hour: {stats.data.refused.toLocaleString()} record(s) (rate limit, overload, invalid or storage errors). Senders that do not retry are losing data. <Link className="underline" to="/sources?tab=ingestion">Details</Link>
        </p>
      )}

      <form className="space-y-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900" aria-label="Log search" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs">Time range
            <select className={`${field} mt-0.5 block`} value={draft.range} disabled={live} onChange={(e) => setDraft({ ...draft, range: e.target.value, ...(e.target.value === 'custom' && !draft.from ? { from: new Date(Date.now() - 3600_000).toISOString(), to: new Date().toISOString() } : {}) })}>
              {PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}<option value="custom">Custom range</option></select></label>
          {draft.range === 'custom' && !live && (
            <>
              <label className="text-xs">From<input type="datetime-local" className={`${field} mt-0.5 block`} value={draft.from ? toLocalInput(draft.from) : ''} onChange={(e) => setDraft({ ...draft, from: e.target.value ? new Date(e.target.value).toISOString() : '' })} /></label>
              <label className="text-xs">To<input type="datetime-local" className={`${field} mt-0.5 block`} value={draft.to ? toLocalInput(draft.to) : ''} onChange={(e) => setDraft({ ...draft, to: e.target.value ? new Date(e.target.value).toISOString() : '' })} /></label>
            </>
          )}
          <label className="min-w-[14rem] flex-1 text-xs">Search messages and errors
            <input type="search" className={`${field} mt-0.5 block w-full`} value={draft.text} maxLength={200} placeholder='timeout "payment failed"' onChange={(e) => setDraft({ ...draft, text: e.target.value })} /></label>
          <label className="text-xs">Minimum severity
            <select className={`${field} mt-0.5 block`} value={draft.minSeverity} onChange={(e) => setDraft({ ...draft, minSeverity: e.target.value as Filters['minSeverity'] })}>
              <option value="">Any</option>{SEVERITIES.map((s) => <option key={s} value={s}>{s} and above</option>)}</select></label>
          <label className="flex items-center gap-1.5 pb-2 text-sm"><input type="checkbox" checked={draft.errorsOnly} onChange={(e) => setDraft({ ...draft, errorsOnly: e.target.checked })} />Errors only</label>
          <Button type="submit" disabled={live}>Run search</Button>
        </div>

        <div className="flex flex-wrap items-start gap-4">
          <details className="text-sm"><summary className="cursor-pointer">Services{draft.services.length ? ` (${draft.services.length})` : ''}</summary>
            <div className="mt-1 max-h-40 space-y-1 overflow-y-auto">
              {(facets.data?.services ?? []).map((s) => (
                <label key={s.value} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={draft.services.includes(s.value)} onChange={(e) => setDraft({ ...draft, services: e.target.checked ? [...draft.services, s.value] : draft.services.filter((x) => x !== s.value) })} />{s.value} <span className="text-xs text-slate-600 dark:text-slate-400">({s.count})</span></label>
              ))}
              {facets.data && facets.data.services.length === 0 && <p className="text-xs text-slate-600 dark:text-slate-400">No services in this time range.</p>}
            </div></details>
          {project.environments.length > 1 && (
            <details className="text-sm"><summary className="cursor-pointer">Environments{draft.envIds.length ? ` (${draft.envIds.length})` : ''}</summary>
              <div className="mt-1 space-y-1">{project.environments.map((e) => (
                <label key={e.id} className="flex items-center gap-1.5"><input type="checkbox" checked={draft.envIds.includes(e.id)} onChange={(ev) => setDraft({ ...draft, envIds: ev.target.checked ? [...draft.envIds, e.id] : draft.envIds.filter((x) => x !== e.id) })} />{e.name}{e.isProduction && <Badge tone="danger">production</Badge>}</label>))}</div></details>
          )}
          <details className="text-sm" open={filtersOpen} onToggle={(e) => setFiltersOpen((e.target as HTMLDetailsElement).open)}><summary className="cursor-pointer">Field filters{draft.filters.length ? ` (${draft.filters.length})` : ''}</summary>
            <div className="mt-2 space-y-2">
              <ul className="flex flex-wrap gap-1.5" aria-label="Active filters">{draft.filters.map((f, i) => (
                <li key={`${f.field}${i}`}><span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 text-xs dark:bg-slate-800">{describeFilter(f)}
                  <button type="button" aria-label={`Remove filter ${describeFilter(f)}`} className="font-bold" onClick={() => setDraft({ ...draft, filters: draft.filters.filter((_, j) => j !== i) })}>×</button></span></li>))}</ul>
              <FilterBuilder onAdd={(f) => setDraft({ ...draft, filters: [...draft.filters, f].slice(0, 10) })} />
            </div></details>
          <details className="text-sm"><summary className="cursor-pointer">Saved queries ({saved.data?.length ?? 0})</summary>
            <div className="mt-1 w-72 space-y-2">
              <ul className="space-y-1">{(saved.data ?? []).map((q) => (
                <li key={q.id} className="flex items-center justify-between gap-2"><button type="button" className="truncate text-left text-indigo-600 underline" onClick={() => run(applySaved({ ...draft }, q.query), false)}>{q.name}</button>
                  <span className="flex items-center gap-1">{q.shared && <Badge>shared</Badge>}{(q.ownedByMe || project.role === 'project_admin') && <button type="button" className="text-xs underline" aria-label={`Delete saved query ${q.name}`} onClick={() => del.mutate(q.id)}>delete</button>}</span></li>))}
                {saved.data?.length === 0 && <li className="text-xs text-slate-600 dark:text-slate-400">No saved queries yet.</li>}</ul>
              <div className="flex flex-wrap items-center gap-1"><input aria-label="Name for the saved query" className={`${field} w-36`} value={saveName} maxLength={80} placeholder="Name" onChange={(e) => setSaveName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (saveName.trim()) save.mutate(); } }} />
                {canShare && <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={saveShared} onChange={(e) => setSaveShared(e.target.checked)} />share</label>}
                <Button type="button" variant="ghost" disabled={!saveName.trim() || save.isPending} onClick={() => save.mutate()}>Save current</Button></div>
              {save.isError && <p role="alert" className="text-xs text-red-600">{save.error.message}</p>}
            </div></details>
          <details className="text-sm"><summary className="cursor-pointer">History</summary>
            <ul className="mt-1 w-72 space-y-1 text-xs">{(history.data ?? []).map((h) => (
              <li key={h.id}><button type="button" className="truncate text-left text-indigo-600 underline" onClick={() => run(applySaved({ ...draft }, h.query), false)}>{h.at.slice(11, 19)} · {String(h.query.text ?? '') || (Array.isArray(h.query.filters) && h.query.filters.length ? `${h.query.filters.length} filter(s)` : 'all logs')}</button></li>))}
              {history.data?.length === 0 && <li className="text-slate-600 dark:text-slate-400">No history yet.</li>}</ul></details>
          {canExport && (
            <div className="flex items-center gap-1 text-sm"><label className="sr-only" htmlFor="export-format">Export format</label>
              <select id="export-format" className={field} value={exportFormat} onChange={(e) => setExportFormat(e.target.value as 'csv' | 'ndjson')}><option value="csv">CSV</option><option value="ndjson">NDJSON</option></select>
              <Button type="button" variant="ghost" disabled={exporting.isPending} onClick={() => exporting.mutate()}>{exporting.isPending ? 'Exporting…' : 'Export (max 10,000)'}</Button></div>
          )}
        </div>
        {exporting.isError && <p role="alert" className="text-sm text-red-600">{exporting.error.message}</p>}
      </form>

      {draft.filters.length > 0 && draft.filters !== applied.filters && JSON.stringify(draft) !== JSON.stringify(applied) && <p className="text-xs text-slate-600 dark:text-slate-400" role="note">You have unapplied changes. Press “Run search”.</p>}

      {live && <p role="status" className="text-sm" data-testid="live-status">{liveState === 'connected' ? '● Live: new matching events appear at the top as they arrive.' : liveState === 'connecting' ? 'Connecting to the live stream…' : 'Live stream interrupted; reconnecting…'}</p>}

      {hist.data && hist.data.buckets.length > 0 && !live && <Histogram data={hist.data} onZoom={(a, b) => run({ ...draft, range: 'custom', from: new Date(a).toISOString(), to: new Date(b).toISOString() }, false)} />}

      <div aria-live="polite" className="text-sm text-slate-600 dark:text-slate-400" data-testid="result-summary">
        {search.isPending && !live ? 'Searching…' : search.isError ? '' : `${live ? items.length.toLocaleString() : (total ?? items.length).toLocaleString()} event(s) ${live ? 'in view' : 'in range'} (UTC ${utc(query.from).slice(0, 19)} → ${utc(query.to).slice(0, 19)})`}
      </div>

      {search.isPending && !live && <Loading label="Searching…" />}
      {search.isError && <ErrorState error={search.error} onRetry={() => void search.refetch()} />}

      {!search.isPending && !search.isError && items.length === 0 && (
        !everReceived && stats.isSuccess ? (
          <EmptyState title="No telemetry has been received for this project yet" action={<Link className="text-indigo-600 underline" to="/sources?tab=ingestion">Set up ingestion</Link>}>
            Create an ingestion token and point an OpenTelemetry exporter at it. Until then there is nothing to search — this is not a healthy-and-quiet system, it is a silent one.
          </EmptyState>
        ) : (
          <EmptyState title="No logs match this search">
            Try a wider time range or fewer filters.{newestArrival && <> Telemetry last arrived at <time dateTime={newestArrival}>{utc(newestArrival).slice(0, 19)} UTC</time>.</>}
          </EmptyState>
        )
      )}

      {items.length > 0 && (
        <LogTable items={items} selectedId={selectedId} onSelect={(id) => open(id)} envNames={envNames}
          hasMore={!live && !!search.hasNextPage} loadingMore={search.isFetchingNextPage} onNearEnd={() => void search.fetchNextPage()} />
      )}

      {selectedId && (
        <LogDrawer projectId={project.id} id={selectedId} envName={(id) => envNames.get(id) ?? id.slice(0, 8)} onClose={() => open(null)} onOpen={(id) => open(id)} onFilter={addFilter} />
      )}
      <Card title="Notes"><ul className="list-disc space-y-1 pl-5 text-xs text-slate-600 dark:text-slate-400">
        <li>Search terms are all required (AND); wrap a phrase in quotes. Matching is case-insensitive over messages and error text.</li>
        <li>Secrets are masked at ingestion, before storage. Masking is best-effort: avoid logging credentials.</li>
        <li>Missing fields are shown as “unavailable”; nothing is inferred.</li>
      </ul></Card>
    </div>
  );
}
