import type { ServiceHealth, ServiceOverview } from '@nexus/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { z } from 'zod';
import { api } from '../api';
import { Badge, Card, EmptyState, ErrorState, Loading } from '../ui';
import { fmtNum } from '../charts';
import { fieldClass, ProjectGate, WINDOWS } from './traces/shared';
import { tracesLink } from './traces/model';
import { utc } from './logs/model';

export type Overview = z.infer<typeof ServiceOverview>;

export const sourceBadge = (s: ServiceHealth['source']) => s === 'metrics' ? <Badge tone="info">HTTP metrics</Badge> : s === 'traces' ? <Badge tone="warn">trace-derived</Badge> : <Badge>no request data</Badge>;
export const freshnessBadge = (f: ServiceHealth['freshness']) => f === 'active' ? <Badge tone="info">● active</Badge> : f === 'stale' ? <Badge tone="warn">stale</Badge> : <Badge>never seen</Badge>;
export const lastSeen = (s: ServiceHealth) => [s.lastSpanAt, s.lastMetricAt, s.lastLogAt].filter((x): x is string => !!x).sort().at(-1) ?? null;
export const pctText = (r: number | null) => (r === null ? 'n/a' : `${fmtNum(r * 100, 1)}%`);
export const msText = (v: number | null) => (v === null ? 'n/a' : `${fmtNum(v, 1)} ms`);

export default function Services() {
  const [sp, setSp] = useSearchParams();
  return <ProjectGate title="Services" urlProject={sp.get('p')}>{(project) => <Body projectId={project.id} sp={sp} setSp={setSp} envNames={new Map(project.environments.map((e) => [e.id, e.name]))} />}</ProjectGate>;
}

function Body({ projectId, sp, setSp, envNames }: { projectId: string; sp: URLSearchParams; setSp: ReturnType<typeof useSearchParams>[1]; envNames: Map<string, string> }) {
  const minutes = Number(sp.get('minutes')) || 60;
  const q = useQuery({ queryKey: ['services', projectId, minutes], retry: false, refetchInterval: 30_000, queryFn: () => api<Overview>('GET', `/api/v1/projects/${projectId}/services?minutes=${minutes}`) });
  const [showDeps, setShowDeps] = useState(true);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Services</h1>
        <label className="text-xs">Window
          <select className={`${fieldClass} ml-2`} value={minutes} onChange={(e) => { const n = new URLSearchParams(sp); n.set('p', projectId); n.set('minutes', e.target.value); setSp(n, { replace: true }); }}>
            {WINDOWS.map((w) => <option key={w.minutes} value={w.minutes}>{w.label}</option>)}</select></label>
      </div>
      <p className="text-sm text-slate-600 dark:text-slate-400">Every row comes from telemetry that was actually received. Request statistics use explicit HTTP server metrics when the service sends them; otherwise they are derived from stored server spans and labelled <em>trace-derived</em> (they depend on sampling and are not true request counts). A service with no errors is not necessarily healthy: check that it is <em>active</em>.</p>

      {q.isPending && <Loading label="Loading services…" />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && q.data.services.length === 0 && (
        <EmptyState title="No services have sent telemetry yet" action={<Link className="text-indigo-700 underline dark:text-indigo-300" to="/sources?tab=ingestion">Set up ingestion</Link>}>
          Services appear here after logs, traces or metrics with a <code className="font-mono">service.name</code> resource attribute are received. Silence is not shown as “healthy”.
        </EmptyState>
      )}
      {q.data && q.data.services.length > 0 && (
        <>
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <table className="w-full min-w-[56rem] text-left text-sm" aria-label="Services" data-testid="services-table">
              <thead className="border-b border-slate-200 text-xs uppercase text-slate-600 dark:border-slate-800 dark:text-slate-400">
                <tr><th scope="col" className="px-3 py-2">Service</th><th scope="col" className="px-3 py-2">Status</th><th scope="col" className="px-3 py-2">Source</th>
                  <th scope="col" className="px-3 py-2 text-right">Requests</th><th scope="col" className="px-3 py-2 text-right">Rate</th><th scope="col" className="px-3 py-2 text-right">Errors</th>
                  <th scope="col" className="px-3 py-2 text-right">p50</th><th scope="col" className="px-3 py-2 text-right">p95</th><th scope="col" className="px-3 py-2 text-right">p99</th><th scope="col" className="px-3 py-2 text-right">Traces</th></tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {q.data.services.map((s) => {
                  const seen = lastSeen(s);
                  return (
                    <tr key={`${s.environmentId}${s.service}`} data-testid={`service-${s.service}`}>
                      <th scope="row" className="px-3 py-2 font-normal">
                        <Link className="font-medium text-indigo-700 underline dark:text-indigo-300" to={`/services/${encodeURIComponent(s.service)}?p=${projectId}&env=${s.environmentId}&minutes=${minutes}`}>{s.service}</Link>
                        <div className="text-xs text-slate-600 dark:text-slate-400">{envNames.get(s.environmentId) ?? ''}{s.version ? ` · v${s.version}` : ''}</div>
                      </th>
                      <td className="px-3 py-2">{freshnessBadge(s.freshness)}<div className="text-xs text-slate-600 dark:text-slate-400">{seen ? `last data ${utc(seen).slice(5, 19)} UTC` : 'no telemetry'}</div></td>
                      <td className="px-3 py-2" title={s.sourceDetail ?? ''}>{sourceBadge(s.source)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.requests === null ? 'n/a' : s.requests.toLocaleString()}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.ratePerSec === null ? 'n/a' : `${fmtNum(s.ratePerSec, 2)}/s`}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.errors === null ? 'n/a' : <>{s.errors.toLocaleString()} <span className="text-xs text-slate-600 dark:text-slate-400">({pctText(s.errorRate)})</span></>}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{msText(s.p50Ms)}</td><td className="px-3 py-2 text-right tabular-nums">{msText(s.p95Ms)}</td><td className="px-3 py-2 text-right tabular-nums">{msText(s.p99Ms)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">
                        {s.traceCount === null ? 'n/a' : <Link className="text-indigo-700 underline dark:text-indigo-300" to={tracesLink(projectId, { service: s.service, from: q.data.from, to: q.data.to, envId: s.environmentId })}>{s.traceCount.toLocaleString()}</Link>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <Card title="Observed dependencies" actions={<button type="button" className="text-xs underline" aria-expanded={showDeps} onClick={() => setShowDeps((v) => !v)}>{showDeps ? 'Hide' : 'Show'}</button>}>
            {showDeps && (q.data.dependencies.edges.length === 0
              ? <p className="text-sm text-slate-600 dark:text-slate-400">No cross-service or datastore calls were observed in this window (this needs client spans from instrumented services).</p>
              : (
                <>
                  <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm" aria-label="Observed dependencies">
                    <thead className="text-xs uppercase text-slate-600 dark:text-slate-400"><tr><th scope="col" className="py-1 pr-3">From</th><th scope="col" className="py-1 pr-3">To</th><th scope="col" className="py-1 pr-3">Type</th><th scope="col" className="py-1 pr-3">Observed from</th><th scope="col" className="py-1 pr-3 text-right">Calls</th><th scope="col" className="py-1 text-right">Errors</th></tr></thead>
                    <tbody>{q.data.dependencies.edges.map((e) => (
                      <tr key={`${e.from}${e.to}${e.kind}${e.basis}`} className="border-t border-slate-100 dark:border-slate-800"><td className="py-1 pr-3">{e.from}</td><td className="py-1 pr-3">{e.to}</td><td className="py-1 pr-3">{e.kind}</td>
                        <td className="py-1 pr-3 text-xs">{e.basis === 'parent-child' ? 'a client span with a child in another service' : 'span attributes (db.system / peer address)'}</td><td className="py-1 pr-3 text-right tabular-nums">{e.calls}</td><td className="py-1 text-right tabular-nums">{e.errors}</td></tr>))}</tbody>
                  </table>
                  </div>
                  <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">Only relationships that were observed in spans are listed; none are inferred.{q.data.dependencies.sampled ? ' The span sample for this window was capped.' : ''}</p>
                </>
              ))}
          </Card>
          {q.data.notes.length > 0 && <ul className="list-disc pl-5 text-xs text-slate-600 dark:text-slate-400">{q.data.notes.map((n) => <li key={n}>{n}</li>)}</ul>}
        </>
      )}
    </div>
  );
}
