import type { LogDetail, LogFilter, LogSummary } from '@nexus/contracts';
import type { z } from 'zod';
import type { LogContext } from '@nexus/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Badge, Button, ErrorState, Loading } from '../../ui';
import { localTime, SEVERITY_TONE, utc } from './model';

type Ctx = z.infer<typeof LogContext>;

function CopyButton({ value, label }: { value: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" aria-label={`Copy ${label}`} className="ml-1 rounded border border-slate-300 px-1.5 text-xs hover:bg-slate-100 dark:border-slate-700 dark:hover:bg-slate-800"
      onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }); }}>
      {done ? 'Copied' : 'Copy'}
    </button>
  );
}

const UNAVAILABLE = <span className="text-slate-500">unavailable</span>;

function Field({ label, value, copy, search }: { label: string; value: string | number | null; copy?: boolean; search?: () => void }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-slate-600 dark:text-slate-400">{label}</dt>
      <dd className="break-all font-mono text-xs">
        {value === null || value === '' ? UNAVAILABLE : (
          <>
            {String(value)}
            {copy && <CopyButton value={String(value)} label={label} />}
            {search && <button type="button" className="ml-1 text-xs text-indigo-600 underline" onClick={search}>search</button>}
          </>
        )}
      </dd>
    </div>
  );
}

function Related({ title, items, currentId, onOpen, note }: { title: string; items: LogSummary[]; currentId: string; onOpen: (id: string) => void; note?: string }) {
  return (
    <section aria-label={title} className="space-y-1">
      <h3 className="text-sm font-semibold">{title} <span className="font-normal text-slate-600 dark:text-slate-400">({items.length})</span></h3>
      {note && <p className="text-xs text-slate-600 dark:text-slate-400">{note}</p>}
      <ul className="space-y-0.5 text-xs">
        {items.map((r) => (
          <li key={r.id}>
            <button type="button" onClick={() => onOpen(r.id)} aria-current={r.id === currentId} className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left hover:bg-slate-100 dark:hover:bg-slate-800 ${r.id === currentId ? 'bg-indigo-50 font-medium dark:bg-indigo-950/50' : ''}`}>
              <span className="font-mono">{utc(r.ts).slice(11)}</span>
              <Badge tone={SEVERITY_TONE[r.severity]}>{r.severity}</Badge>
              <span className="truncate">{r.message}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Stack traces: readable lines, frames de-emphasised, the exception line stands out. */
function Stack({ text }: { text: string }) {
  return (
    <pre className="max-h-64 overflow-auto rounded bg-slate-100 p-2 font-mono text-xs leading-5 dark:bg-slate-800" tabIndex={0} aria-label="Stack trace">
      {text.split('\n').map((l, i) => (
        <div key={i} className={/^\s+at\s/.test(l) ? 'text-slate-600 dark:text-slate-400' : 'font-semibold'}>{l || ' '}</div>
      ))}
    </pre>
  );
}

export function LogDrawer({
  projectId, id, envName, onClose, onOpen, onFilter,
}: { projectId: string; id: string; envName: (envId: string) => string; onClose: () => void; onOpen: (id: string) => void; onFilter: (f: LogFilter) => void }) {
  const base = `/api/v1/projects/${projectId}/logs/${id}`;
  const detail = useQuery({ queryKey: ['log', projectId, id], queryFn: () => api<LogDetail>('GET', base), retry: false });
  const ctx = useQuery({ queryKey: ['log-ctx', projectId, id], queryFn: () => api<Ctx>('GET', `${base}/context`), retry: false, enabled: detail.isSuccess });
  const [tab, setTab] = useState<'details' | 'json'>('details');
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [id]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const d = detail.data;
  return (
    <aside aria-label="Log details" className="fixed inset-y-0 right-0 z-30 flex w-full max-w-xl flex-col border-l border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900">
      <header className="flex items-center justify-between border-b border-slate-200 px-4 py-2 dark:border-slate-800">
        <h2 ref={heading} tabIndex={-1} className="text-base font-semibold outline-none">Log details</h2>
        <Button variant="ghost" onClick={onClose} aria-label="Close log details">Close</Button>
      </header>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {detail.isPending && <Loading />}
        {detail.isError && <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />}
        {d && (
          <>
            <div role="tablist" className="flex gap-1 border-b border-slate-200 dark:border-slate-800">
              {(['details', 'json'] as const).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`px-3 py-1 text-sm ${tab === t ? 'border-b-2 border-indigo-600 font-medium' : 'text-slate-600 dark:text-slate-400'}`}>{t === 'json' ? 'JSON' : 'Details'}</button>
              ))}
            </div>
            {tab === 'json' ? (
              <div><div className="mb-1 flex justify-end"><CopyButton value={JSON.stringify(d, null, 2)} label="JSON" /></div>
                <pre className="max-h-[70vh] overflow-auto rounded bg-slate-100 p-2 font-mono text-xs dark:bg-slate-800" tabIndex={0} aria-label="Record as JSON">{JSON.stringify(d, null, 2)}</pre></div>
            ) : (
              <>
                <section aria-label="Message" className="space-y-1">
                  <div className="flex items-center gap-2"><Badge tone={SEVERITY_TONE[d.severity]}>{d.severity}</Badge>{d.severityText && <span className="text-xs text-slate-600 dark:text-slate-400">as reported: {d.severityText}</span>}</div>
                  <p className="whitespace-pre-wrap break-words font-mono text-sm" data-testid="log-message">{d.message || '(empty message)'}</p>
                  <CopyButton value={d.message} label="message" />
                  {d.messageTruncated && <p className="text-xs text-amber-700 dark:text-amber-300">The message was longer than the storage limit and was truncated.</p>}
                  {d.redactions > 0 && <p className="text-xs text-slate-600 dark:text-slate-400" data-testid="redaction-note">{d.redactions} sensitive value(s) in this record were masked before storage.</p>}
                </section>

                <dl className="grid grid-cols-2 gap-x-4 gap-y-2" aria-label="Record metadata">
                  <div className="col-span-2"><dt className="text-xs text-slate-600 dark:text-slate-400">Time</dt>
                    <dd className="font-mono text-xs">{utc(d.ts)} UTC <span className="text-slate-600 dark:text-slate-400">· {localTime(d.ts)} local</span></dd>
                    {d.tsSource !== 'event' && <p className="text-xs text-amber-700 dark:text-amber-300">The sender provided no event time; the {d.tsSource === 'observed' ? 'observed' : 'receive'} time is shown.</p>}
                    {d.tsAdjusted === 'future' && <p className="text-xs text-amber-700 dark:text-amber-300">The sender&apos;s clock was in the future; the receive time was used instead.</p>}</div>
                  <Field label="Service" value={d.service} search={d.service ? () => onFilter({ field: 'service', op: 'eq', value: d.service! }) : undefined} />
                  <Field label="Service version" value={d.serviceVersion} />
                  <Field label="Host" value={d.host} /><Field label="Container / pod" value={d.container} />
                  <Field label="Environment" value={envName(d.environmentId)} />
                  <Field label="Source" value={`${d.source === 'otlp' ? 'OpenTelemetry (OTLP)' : 'JSON logs'}${d.scope ? ` · ${d.scope}` : ''}`} />
                  <Field label="Trace ID" value={d.traceId} copy search={d.traceId ? () => onFilter({ field: 'traceId', op: 'eq', value: d.traceId! }) : undefined} />
                  <Field label="Span ID" value={d.spanId} copy search={d.spanId ? () => onFilter({ field: 'spanId', op: 'eq', value: d.spanId! }) : undefined} />
                  {d.traceId && (
                    <div className="col-span-2 min-w-0" data-testid="trace-link">
                      <dt className="text-xs text-slate-600 dark:text-slate-400">Distributed trace</dt>
                      <dd className="text-sm"><Link className="text-indigo-700 underline dark:text-indigo-300" to={`/traces/${d.traceId}?p=${projectId}&env=${d.environmentId}${d.spanId ? `&span=${d.spanId}` : ''}`}>Open this request’s trace{d.spanId ? ' at this span' : ''}</Link>
                        <span className="ml-1 text-xs text-slate-600 dark:text-slate-400">(if its spans have been received; otherwise the trace page explains that it is unavailable)</span></dd>
                    </div>
                  )}
                  <Field label="Request ID" value={d.requestId} copy search={d.requestId ? () => onFilter({ field: 'requestId', op: 'eq', value: d.requestId! }) : undefined} />
                  <Field label="Deployment" value={d.deployment} />
                  <Field label="HTTP method" value={d.httpMethod} /><Field label="HTTP route" value={d.httpRoute} />
                  <Field label="HTTP status" value={d.httpStatus} search={d.httpStatus ? () => onFilter({ field: 'httpStatus', op: 'eq', value: d.httpStatus! }) : undefined} />
                  <Field label="Duration (ms)" value={d.durationMs} />
                  <Field label="Error type" value={d.errorType} search={d.errorType ? () => onFilter({ field: 'errorType', op: 'eq', value: d.errorType! }) : undefined} />
                  <Field label="Exception message" value={d.exceptionMessage} />
                  <Field label="Record ID" value={d.id} copy />
                </dl>

                {d.stack && <section aria-label="Stack trace" className="space-y-1"><h3 className="text-sm font-semibold">Stack trace</h3><Stack text={d.stack} /></section>}

                <section aria-label="Attributes" className="space-y-1">
                  <h3 className="text-sm font-semibold">Attributes <span className="font-normal text-slate-600 dark:text-slate-400">({d.attrs.length})</span></h3>
                  {d.attrsTruncated && <p className="text-xs text-amber-700 dark:text-amber-300">Some attributes were dropped or shortened because of storage limits.</p>}
                  {d.attrs.length === 0 ? <p className="text-xs text-slate-600 dark:text-slate-400">This record has no attributes.</p> : (
                    <table className="w-full text-xs"><caption className="sr-only">Parsed attributes</caption>
                      <thead className="sr-only"><tr><th>Name</th><th>Value</th><th>Actions</th></tr></thead>
                      <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                        {d.attrs.map((a) => (
                          <tr key={a.k}><th scope="row" className="w-2/5 break-all py-1 pr-2 text-left font-mono font-normal text-slate-700 dark:text-slate-300">{a.k}</th>
                            <td className="break-all py-1 pr-2 font-mono">{a.v}</td>
                            <td className="whitespace-nowrap py-1 text-right"><CopyButton value={a.v} label={`value of ${a.k}`} />
                              {a.v !== '[REDACTED]' && <button type="button" className="ml-1 text-indigo-600 underline" aria-label={`Search for ${a.k} equals ${a.v}`} onClick={() => onFilter({ field: `attr:${a.k}`, op: 'eq', value: a.v })}>search</button>}</td></tr>
                        ))}
                      </tbody></table>
                  )}
                  <details className="text-xs"><summary className="cursor-pointer text-slate-600 dark:text-slate-400">Resource attributes ({d.resource.length})</summary>
                    <ul className="mt-1 space-y-0.5 font-mono">{d.resource.map((a) => <li key={a.k} className="break-all"><span className="text-slate-600 dark:text-slate-400">{a.k}</span> = {a.v}</li>)}</ul></details>
                </section>

                <section aria-label="Correlated events" className="space-y-3">
                  {ctx.isPending && <Loading label="Loading related events…" />}
                  {ctx.isError && <ErrorState error={ctx.error} onRetry={() => void ctx.refetch()} />}
                  {ctx.data && (
                    <>
                      {ctx.data.related.by ? (
                        <Related title={`Related events (same ${ctx.data.related.by === 'traceId' ? 'trace' : 'request'})`} items={ctx.data.related.items} currentId={d.id} onOpen={onOpen}
                          note="These records share an identifier — observed correlation, not inferred." />
                      ) : (
                        <p className="rounded border border-slate-200 p-2 text-xs dark:border-slate-800">This record has no trace ID or request ID, so related events cannot be shown. Nothing is guessed; neighbouring events from the same service and host are listed below.</p>
                      )}
                      <Related title="Just before (same service and host)" items={ctx.data.before} currentId={d.id} onOpen={onOpen} />
                      <Related title="Just after (same service and host)" items={ctx.data.after} currentId={d.id} onOpen={onOpen} />
                    </>
                  )}
                </section>
                <p className="rounded border border-slate-200 p-2 text-xs text-slate-600 dark:border-slate-800 dark:text-slate-400">Linked incidents and deployments: not available yet (planned for phase 6).</p>
              </>
            )}
          </>
        )}
      </div>
    </aside>
  );
}
