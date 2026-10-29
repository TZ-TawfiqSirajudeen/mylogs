import type { TraceDetail as TraceDetailDto, TraceLogs } from '@nexus/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { z } from 'zod';
import { api, ApiRequestError } from '../api';
import { useSelection } from '../session';
import { Badge, Button, Card, EmptyState, ErrorState, Loading } from '../ui';
import { SEVERITY_TONE, utc } from './logs/model';
import { logsLink, traceLink } from './traces/model';
import { CopyButton, ProjectGate } from './traces/shared';
import { SpanDetails } from './traces/SpanDetails';
import { SpanTable, Waterfall } from './traces/Waterfall';
import { buildWaterfall, formatNs, FULL, type View } from './traces/waterfall-model';

type Detail = z.infer<typeof TraceDetailDto>;
type Logs = z.infer<typeof TraceLogs>;

export default function TraceDetailPage() {
  const { traceId = '' } = useParams();
  const [sp] = useSearchParams();
  return <ProjectGate title="Trace" urlProject={sp.get('p')}>{(project) => <Body projectId={project.id} traceId={traceId} />}</ProjectGate>;
}

function Body({ projectId, traceId }: { projectId: string; traceId: string }) {
  const [sp, setSp] = useSearchParams();
  const { project, environment, select } = useSelection();
  const base = `/api/v1/projects/${projectId}`;
  const selectedId = sp.get('span');
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [view, setView] = useState<View>(FULL);
  const [mode, setMode] = useState<'timeline' | 'table'>('timeline');
  const [copied, setCopied] = useState(false);

  const trace = useQuery({
    queryKey: ['trace', projectId, traceId], retry: false, staleTime: 15_000,
    queryFn: () => api<Detail>('GET', `${base}/traces/${traceId}`),
  });
  const logs = useQuery({
    queryKey: ['trace-logs', projectId, traceId], retry: false, staleTime: 15_000,
    queryFn: () => api<Logs>('GET', `${base}/traces/${traceId}/logs`),
  });

  // The link carries the environment; make the header selection agree with it (the server has already scoped the data).
  const envId = trace.data?.summary.environmentId;
  useEffect(() => { if (envId && project && environment?.id !== envId && project.environments.some((e) => e.id === envId)) select(project.id, envId); }, [envId, project, environment?.id, select]);

  const model = useMemo(() => buildWaterfall(trace.data?.spans ?? [], collapsed), [trace.data, collapsed]);
  const selectedRow = useMemo(() => model.rows.find((r) => r.span.spanId === selectedId) ?? (selectedId ? buildWaterfall(trace.data?.spans ?? [], new Set()).rows.find((r) => r.span.spanId === selectedId) : undefined), [model, selectedId, trace.data]);
  const select_ = (id: string | null) => { const n = new URLSearchParams(sp); if (id) n.set('span', id); else n.delete('span'); setSp(n, { replace: true }); };

  if (trace.isPending) return <Loading label="Loading trace…" />;
  if (trace.isError) {
    const notFound = trace.error instanceof ApiRequestError && trace.error.status === 404;
    return (
      <div className="space-y-3"><h1 className="text-xl font-semibold">Trace</h1>
        {notFound ? (
          <EmptyState title="Trace not found" action={<Link className="text-indigo-700 underline dark:text-indigo-300" to={`/traces?p=${projectId}`}>Search traces</Link>}>
            Nothing is stored for trace <span className="font-mono">{traceId.slice(0, 16)}…</span> in the environments you can access. It may not have arrived yet (spans can be delayed), may have expired under the retention policy, or may belong to an environment you do not have access to.
            {logs.data && logs.data.logs.length > 0 && <> Log records that reference this trace id <Link className="underline" to={logsLink(projectId, traceId, { from: new Date(Date.now() - 7 * 86400_000).toISOString(), to: new Date().toISOString() })}>do exist</Link> — the trace itself has not been received.</>}
          </EmptyState>
        ) : <ErrorState error={trace.error} onRetry={() => void trace.refetch()} />}
      </div>
    );
  }

  const d = trace.data;
  const s = d.summary;
  const traceEnd = new Date(Date.parse(s.start) + s.durationNs / 1e6).toISOString();
  const logCounts = logs.data?.bySpan ?? {};
  const traceLogsLink = logsLink(projectId, traceId, { from: new Date(Date.parse(s.start) - 5 * 60_000).toISOString(), to: new Date(Date.parse(traceEnd) + 5 * 60_000).toISOString() });
  const failed = d.spans.filter((x) => x.statusCode === 'error');

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Trace <span className="font-mono text-base font-normal">{traceId.slice(0, 8)}…{traceId.slice(-4)}</span><CopyButton value={traceId} label="trace ID" /></h1>
        <div className="flex flex-wrap items-center gap-2">
          <Link className="text-sm text-indigo-700 underline dark:text-indigo-300" to={`/traces?p=${projectId}`}>← All traces</Link>
          <Button variant="ghost" onClick={() => { void navigator.clipboard?.writeText(`${window.location.origin}${traceLink(traceId, projectId, s.environmentId, selectedId)}`).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? 'Link copied' : 'Copy link'}</Button>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border border-slate-200 bg-white p-3 text-sm sm:grid-cols-4 dark:border-slate-800 dark:bg-slate-900" data-testid="trace-header">
        <div><dt className="text-xs text-slate-600 dark:text-slate-400">Operation</dt><dd className="truncate" title={s.rootName ?? ''}>{s.rootName ?? <span className="italic">root span not received</span>}</dd></div>
        <div><dt className="text-xs text-slate-600 dark:text-slate-400">Duration (observed)</dt><dd className="tabular-nums">{formatNs(s.durationNs)}</dd></div>
        <div><dt className="text-xs text-slate-600 dark:text-slate-400">Started (UTC)</dt><dd className="font-mono text-xs">{utc(s.start).slice(0, 23)}</dd></div>
        <div><dt className="text-xs text-slate-600 dark:text-slate-400">Environment</dt><dd>{project?.environments.find((e) => e.id === s.environmentId)?.name ?? s.environmentId.slice(0, 8)}</dd></div>
        <div><dt className="text-xs text-slate-600 dark:text-slate-400">Services</dt><dd>{s.services.join(', ') || 'unavailable'}</dd></div>
        <div><dt className="text-xs text-slate-600 dark:text-slate-400">Spans</dt><dd className="tabular-nums">{s.spanCount}</dd></div>
        <div><dt className="text-xs text-slate-600 dark:text-slate-400">Errors</dt><dd>{s.errorCount > 0 ? <Badge tone="danger">✕ {s.errorCount}</Badge> : '0'}</dd></div>
        <div><dt className="text-xs text-slate-600 dark:text-slate-400">HTTP</dt><dd>{[s.httpMethod, s.httpRoute, s.httpStatus].filter((x) => x !== null && x !== '').join(' ') || '—'}</dd></div>
      </dl>

      {(d.warnings.length > 0 || model.issues.length > 0) && (
        <div role="note" data-testid="completeness-warning" className="space-y-1 rounded border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
          <p className="font-medium">{s.completeness === 'partial' ? '⚠ This trace may be incomplete' : '⚠ Read this before trusting the timeline'}</p>
          <ul className="list-disc space-y-0.5 pl-5">{[...new Set([...d.warnings, ...model.issues])].map((w) => <li key={w}>{w}</li>)}</ul>
          <p className="text-xs">Nothing has been estimated or filled in: gaps are shown as gaps. Services without instrumentation do not appear at all.</p>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="View">
        <Button variant={mode === 'timeline' ? 'primary' : 'ghost'} aria-pressed={mode === 'timeline'} onClick={() => setMode('timeline')}>Timeline</Button>
        <Button variant={mode === 'table' ? 'primary' : 'ghost'} aria-pressed={mode === 'table'} onClick={() => setMode('table')}>Table</Button>
        {failed.length > 0 && <Button variant="ghost" onClick={() => { const f = failed[0]!; select_(f.spanId); }}>Jump to first failed span</Button>}
        <Link className="ml-auto text-sm text-indigo-700 underline dark:text-indigo-300" to={traceLogsLink}>All logs of this trace in the Logs explorer</Link>
      </div>

      {mode === 'timeline'
        ? <Waterfall model={model} selectedId={selectedId} onSelect={(id) => select_(id)} collapsed={collapsed}
            onToggle={(id) => setCollapsed((c) => { const n = new Set(c); if (n.has(id)) n.delete(id); else n.add(id); return n; })}
            onCollapseAll={() => setCollapsed(new Set(model.parents))} onExpandAll={() => setCollapsed(new Set())} view={view} onView={setView} logCounts={logCounts} />
        : <SpanTable model={model} selectedId={selectedId} onSelect={(id) => select_(id)} logCounts={logCounts} />}

      {selectedRow ? (
        <SpanDetails row={selectedRow} spans={d.spans} projectId={projectId} traceStart={s.start} traceEnd={traceEnd} logs={logs.data?.logs ?? []} onSelect={(id) => select_(id)} />
      ) : (
        <p className="text-sm text-slate-600 dark:text-slate-400" role="note">Select a span to see its attributes, events, exceptions, parent/children and logs.</p>
      )}

      <Card title={`Logs in this trace (${logs.data ? logs.data.logs.length : '…'})`}>
        {logs.isPending ? <Loading label="Loading logs…" /> : logs.isError ? <ErrorState error={logs.error} onRetry={() => void logs.refetch()} /> : logs.data.logs.length === 0 ? (
          <p className="text-sm text-slate-600 dark:text-slate-400">No log record carries this trace id. Logs are only linked when the application writes the active trace id into its log records (the OpenTelemetry logs SDK does this automatically).</p>
        ) : (
          <ul className="space-y-1 text-sm" data-testid="trace-logs">{logs.data.logs.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs">{utc(l.ts).slice(11, 23)}</span><Badge tone={SEVERITY_TONE[l.severity]}>{l.severity}</Badge>
              <span className="text-xs text-slate-600 dark:text-slate-400">{l.service ?? 'unavailable'}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs" title={l.message}>{l.message}</span>
              {l.spanId && d.spans.some((x) => x.spanId === l.spanId) && <button type="button" className="text-xs text-indigo-700 underline dark:text-indigo-300" onClick={() => select_(l.spanId!)}>show span</button>}
              {l.spanId && !d.spans.some((x) => x.spanId === l.spanId) && <span className="text-xs text-amber-800 dark:text-amber-300" title="The span this log belongs to has not been received">span not received</span>}
            </li>))}
            {logs.data.truncated && <li className="text-xs text-slate-600 dark:text-slate-400">More logs exist; open them in the Logs explorer.</li>}
          </ul>
        )}
      </Card>
    </div>
  );
}
