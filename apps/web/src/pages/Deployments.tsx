import type { DeploymentDto } from '@nexus/contracts';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Button, Card, EmptyState, ErrorState, Loading } from '../ui';
import { DeploymentDrawer, StatusBadge } from './deployments/DeploymentDrawer';
import { DEFAULT_FILTERS, deploySnippets, durationText, filtersFromParams, filtersToParams, listQuery, RANGES, shortSha, stamp, canMintTokens, actorText } from './deployments/model';
import { fieldClass, ProjectGate } from './traces/shared';

export default function Deployments() {
  const [sp] = useSearchParams();
  return <ProjectGate title="Deployments" urlProject={sp.get('p')}>{(project) => <Body project={project} />}</ProjectGate>;
}

function Snippet({ title, text }: { title: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="flex items-center justify-between">
        <h4 className="text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">{title}</h4>
        <button type="button" className="rounded border border-slate-300 px-1.5 text-xs dark:border-slate-700" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? 'Copied' : `Copy ${title}`}</button>
      </div>
      <pre className="mt-1 overflow-x-auto rounded bg-slate-100 p-2 font-mono text-xs dark:bg-slate-800" tabIndex={0} aria-label={title} data-testid={`snippet-${title.toLowerCase().replace(/\W+/g, '-')}`}>{text}</pre>
    </div>
  );
}

function CiSnippets({ role, open }: { role: string; open: boolean }) {
  const { curl, github } = deploySnippets(`${window.location.origin}/api/v1/deployments`);
  return (
    <details open={open} className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900" data-testid="ci-snippets">
      <summary className="cursor-pointer text-sm font-semibold">Record deployments from CI</summary>
      <div className="mt-3 space-y-3">
        <p className="text-sm">
          Send one request when a deployment starts or finishes. Use an <strong>ingestion token with the “deployments” scope</strong>: the token decides the project and environment (create one per environment), so the request names neither.
          {canMintTokens(role) ? <> Create it under <Link className="text-indigo-700 underline dark:text-indigo-300" to="/sources?tab=ingestion">Data Sources → Ingestion</Link>.</> : ' Project admins create tokens.'}
        </p>
        <Snippet title="curl" text={curl} />
        <Snippet title="GitHub Actions step" text={github} />
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-slate-600 dark:text-slate-400">
          <li>Store the token as a CI secret (<code className="font-mono">NEXUS_DEPLOY_TOKEN</code>); it is shown once when created and a leaked one can only add deployment records to its environment.</li>
          <li>Statuses: <code className="font-mono">started</code>, <code className="font-mono">succeeded</code>, <code className="font-mono">failed</code>, <code className="font-mono">rolled_back</code>. Send <code className="font-mono">started</code> first and the final status later with the same key: it updates the same record.</li>
          <li>The key makes retries safe: the same key never records a second deployment. Links must be https; notes are plain text (up to 1,000 characters) and are scanned for credentials.</li>
        </ul>
      </div>
    </details>
  );
}

function Body({ project }: { project: NonNullable<ReturnType<typeof import('../session').useSelection>['project']> }) {
  const [sp, setSp] = useSearchParams();
  const filters = useMemo(() => filtersFromParams(sp), [sp]);
  const openId = sp.get('id') && /^[0-9a-f-]{36}$/i.test(sp.get('id')!) ? sp.get('id')! : null;
  const [serviceDraft, setServiceDraft] = useState(filters.service);
  // The window start is rounded to the minute so the request key is stable while the page is open.
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const envName = useCallback((id: string) => project.environments.find((e) => e.id === id)?.name ?? id.slice(0, 8), [project.environments]);

  const set = (patch: Partial<typeof filters>, id: string | null = openId) => setSp(filtersToParams({ ...filters, ...patch }, { p: project.id, id }), { replace: true });
  const q = useInfiniteQuery({
    queryKey: ['deployments', project.id, filters, now], retry: false, refetchInterval: 30_000, initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api<{ items: DeploymentDto[]; nextCursor: string | null }>('GET', `/api/v1/projects/${project.id}/deployments?${listQuery(filters, now, pageParam)}`),
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];
  const services = [...new Set(items.map((d) => d.service))].sort();
  const unfiltered = !filters.service && !filters.status && !filters.env && filters.range === DEFAULT_FILTERS.range;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold">Deployments</h1>
        <p className="max-w-prose text-sm text-slate-600 dark:text-slate-400">Changes recorded by your CI, shown as markers on the metric charts and as context on incidents. Nexus records deployments; it never starts, approves or rolls one back.</p>
      </div>

      <form className="flex flex-wrap items-end gap-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900" aria-label="Deployment filters" onSubmit={(e) => { e.preventDefault(); set({ service: serviceDraft.trim() }); }}>
        <label className="text-xs">Service
          <input list="deploy-services" className={`${fieldClass} mt-0.5 block w-48`} value={serviceDraft} maxLength={128} placeholder="any service" data-testid="filter-service"
            onChange={(e) => setServiceDraft(e.target.value)} onBlur={() => { if (serviceDraft.trim() !== filters.service) set({ service: serviceDraft.trim() }); }} />
          <datalist id="deploy-services">{services.map((s) => <option key={s} value={s} />)}</datalist></label>
        <label className="text-xs">Status
          <select className={`${fieldClass} mt-0.5 block`} value={filters.status} data-testid="filter-status" onChange={(e) => set({ status: e.target.value as typeof filters.status })}>
            <option value="">Any status</option><option value="started">started</option><option value="succeeded">succeeded</option><option value="failed">failed</option><option value="rolled_back">rolled back</option></select></label>
        <label className="text-xs">Environment
          <select className={`${fieldClass} mt-0.5 block`} value={filters.env} data-testid="filter-env" onChange={(e) => set({ env: e.target.value })}>
            <option value="">All environments</option>{project.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
        <label className="text-xs">Time range
          <select className={`${fieldClass} mt-0.5 block`} value={filters.range} data-testid="filter-range" onChange={(e) => set({ range: e.target.value as typeof filters.range })}>
            {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}</select></label>
        <Button type="submit" variant="ghost">Apply</Button>
        {!unfiltered && <Button type="button" variant="ghost" onClick={() => { setServiceDraft(''); setSp(filtersToParams(DEFAULT_FILTERS, { p: project.id, id: openId }), { replace: true }); }}>Clear filters</Button>}
      </form>

      {q.isPending && <Loading label="Loading deployments…" />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}

      {q.isSuccess && items.length === 0 && (
        unfiltered
          ? <EmptyState title="No deployments recorded yet">Deployments appear here after your CI reports them. Use the snippet below: it takes one request at the end of a deploy job.</EmptyState>
          : <EmptyState title="No deployments match these filters" action={<Button variant="ghost" onClick={() => { setServiceDraft(''); setSp(filtersToParams(DEFAULT_FILTERS, { p: project.id, id: openId }), { replace: true }); }}>Clear filters</Button>}>Try a longer time range or another service.</EmptyState>
      )}

      {items.length > 0 && (
        <div className="relative overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
          <table className="w-full min-w-[56rem] text-left text-sm" aria-label="Deployments" data-testid="deployments-table">
            <thead className="border-b border-slate-200 text-xs uppercase text-slate-600 dark:border-slate-800 dark:text-slate-400">
              <tr>{['Started (UTC)', 'Service', 'Version', 'Status', 'Environment', 'Commit', 'Recorded by', 'Duration'].map((c) => <th key={c} scope="col" className="px-3 py-2">{c}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {items.map((d) => (
                <tr key={d.id} data-testid="deployment-row" aria-selected={d.id === openId} className={d.id === openId ? 'bg-indigo-50 dark:bg-indigo-950/40' : ''}>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{stamp(d.startedAt)}</td>
                  <th scope="row" className="px-3 py-2 font-normal">
                    <button type="button" className="max-w-[16rem] truncate text-left font-medium text-indigo-700 underline dark:text-indigo-300" onClick={() => set({}, d.id)} aria-label={`Open details of ${d.service} ${d.version}`}>{d.service}</button>
                  </th>
                  <td className="max-w-[10rem] truncate px-3 py-2 font-mono text-xs" title={d.version}>{d.version}</td>
                  <td className="px-3 py-2"><StatusBadge s={d.status} /></td>
                  <td className="px-3 py-2">{envName(d.environmentId)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{shortSha(d.commitSha) ?? '—'}</td>
                  <td className="max-w-[12rem] truncate px-3 py-2 text-xs" title={actorText(d)}>{actorText(d)}</td>
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">{durationText(d.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.hasNextPage && <Button variant="ghost" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? 'Loading…' : 'Load more'}</Button>}

      <CiSnippets role={project.role} open={q.isSuccess && items.length === 0 && unfiltered} />
      <Card><p className="text-xs text-slate-600 dark:text-slate-400">Deployments are kept for one year. Markers appear on the <Link className="text-indigo-700 underline dark:text-indigo-300" to={`/metrics?p=${project.id}`}>Metrics explorer</Link> and on each <Link className="text-indigo-700 underline dark:text-indigo-300" to={`/services?p=${project.id}`}>service dashboard</Link>; an incident lists the deployments of its service from the 30 minutes before it opened. These are coincidences in time, not findings about cause.</p></Card>

      {openId && <DeploymentDrawer projectId={project.id} id={openId} envName={envName} onClose={() => set({}, null)} />}
    </div>
  );
}
