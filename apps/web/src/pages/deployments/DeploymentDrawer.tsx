import type { DeploymentDto } from '@nexus/contracts';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { api, ApiRequestError } from '../../api';
import { Badge, Button, ErrorState, Loading } from '../../ui';
import { actorText, durationText, hostOf, safeHref, stamp, statusText } from './model';

export const STATUS_TONE = { started: 'neutral', succeeded: 'info', failed: 'danger', rolled_back: 'warn' } as const;
export const StatusBadge = ({ s }: { s: DeploymentDto['status'] }) => <Badge tone={STATUS_TONE[s]}>{statusText(s)}</Badge>;

function Field({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-slate-600 dark:text-slate-400">{label}</dt>
      <dd className={`break-words text-sm ${mono ? 'font-mono text-xs' : ''}`}>{children}</dd>
    </div>
  );
}

/**
 * Every value below is rendered as a React text node. Nothing is parsed as markup, Markdown or HTML, and the only link is a validated https URL.
 * A sender controls these strings: they are data, however they look.
 */
export function DeploymentDrawer({ projectId, id, envName, onClose }: { projectId: string; id: string; envName: (id: string) => string; onClose: () => void }) {
  const q = useQuery({ queryKey: ['deployment', projectId, id], retry: false, queryFn: () => api<DeploymentDto>('GET', `/api/v1/projects/${projectId}/deployments/${id}`) });
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [id, q.isSuccess]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  const d = q.data;
  const href = safeHref(d?.linkUrl ?? null);

  return (
    <aside aria-label="Deployment details" data-testid="deployment-drawer" className="fixed inset-y-0 right-0 z-30 flex w-full max-w-xl flex-col border-l border-slate-200 bg-white shadow-xl dark:border-slate-800 dark:bg-slate-900">
      <header className="flex items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <h2 ref={heading} tabIndex={-1} className="min-w-0 break-words text-base font-semibold outline-none">{d ? `${d.service} ${d.version}` : 'Deployment'}</h2>
        <Button variant="ghost" onClick={onClose} aria-label="Close deployment details">Close</Button>
      </header>
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        {q.isPending && <Loading label="Loading deployment…" />}
        {q.isError && (q.error instanceof ApiRequestError && q.error.status === 404
          ? <p role="alert" className="text-sm">This deployment does not exist, has expired, or is in an environment you cannot access.</p>
          : <ErrorState error={q.error} onRetry={() => void q.refetch()} />)}
        {d && (
          <>
            <p className="flex flex-wrap items-center gap-2 text-sm"><StatusBadge s={d.status} /><Badge>{envName(d.environmentId)}</Badge></p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3" aria-label="Deployment facts">
              <Field label="Service">{d.service}</Field>
              <Field label="Version">{d.version}</Field>
              <Field label="Started (UTC)" mono>{stamp(d.startedAt)}</Field>
              <Field label="Finished (UTC)" mono>{stamp(d.finishedAt)}</Field>
              <Field label="Duration">{durationText(d.durationMs)}</Field>
              <Field label="Commit" mono>{d.commitSha ?? '—'}</Field>
              <Field label="Recorded by">{actorText(d)}</Field>
              <Field label="Triggered by (label sent by the sender)">{d.triggeredBy ?? '—'}</Field>
              <Field label="Idempotency key" mono>{d.idempotencyKey ?? '—'}</Field>
              <Field label="Deployment id" mono>{d.id}</Field>
            </dl>
            <section aria-label="Notes" className="space-y-1">
              <h3 className="text-sm font-semibold">Notes</h3>
              {d.notes ? <p data-testid="deployment-notes" className="whitespace-pre-wrap break-words rounded bg-slate-100 p-2 text-sm dark:bg-slate-800">{d.notes}</p> : <p className="text-sm text-slate-600 dark:text-slate-400">No notes.</p>}
            </section>
            <section aria-label="Link" className="space-y-1">
              <h3 className="text-sm font-semibold">Link</h3>
              {href
                ? <p className="text-sm"><a data-testid="deployment-link" className="break-all text-indigo-700 underline dark:text-indigo-300" href={href} target="_blank" rel="noopener noreferrer nofollow">{href}</a> <span className="text-xs text-slate-600 dark:text-slate-400">(opens {hostOf(href)} in a new tab)</span></p>
                : <p className="text-sm text-slate-600 dark:text-slate-400">{d.linkUrl ? 'The stored link is not a valid https address and is not shown as a link.' : 'No link.'}</p>}
            </section>
            <section aria-label="Related" className="space-y-1">
              <h3 className="text-sm font-semibold">Look around this deployment</h3>
              <p className="flex flex-wrap gap-3 text-sm">
                <Link className="text-indigo-700 underline dark:text-indigo-300" to={`/services/${encodeURIComponent(d.service)}?p=${projectId}&env=${d.environmentId}`}>Service dashboard</Link>
                <Link className="text-indigo-700 underline dark:text-indigo-300" to={`/logs?p=${projectId}&svc=${encodeURIComponent(d.service)}&range=24h`}>Logs of this service</Link>
                <Link className="text-indigo-700 underline dark:text-indigo-300" to={`/metrics?p=${projectId}&metric=http.server.request.duration&svc=${encodeURIComponent(d.service)}&agg=p95&range=24h`}>Metrics of this service</Link>
              </p>
              <p className="text-xs text-slate-600 dark:text-slate-400">A deployment marker shows when a change was recorded. It does not show that the change caused anything.</p>
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
