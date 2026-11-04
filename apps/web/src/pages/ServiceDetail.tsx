import type { ServiceHealth, TraceSummaryDto } from '@nexus/contracts';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, ApiRequestError } from '../api';
import { StackedBar, TimelineChart, fmtNum } from '../charts';
import { Badge, Card, EmptyState, ErrorState, Loading } from '../ui';
import { freshnessBadge, lastSeen, msText, pctText, sourceBadge } from './Services';
import { logsLink, traceLink, tracesLink } from './traces/model';
import { fieldClass, ProjectGate, WINDOWS } from './traces/shared';
import { formatNs } from './traces/waterfall-model';
import { useDeploymentMarkers } from './deployments/useMarkers';
import { utc } from './logs/model';

interface Detail { health: ServiceHealth[]; slowTraces: TraceSummaryDto[]; errorTraces: TraceSummaryDto[]; correlation: string }

export default function ServiceDetail() {
  const { service = '' } = useParams();
  const [sp] = useSearchParams();
  return <ProjectGate title={`Service ${service}`} urlProject={sp.get('p')}>{(project) => <Body projectId={project.id} service={service} envNames={new Map(project.environments.map((e) => [e.id, e.name]))} />}</ProjectGate>;
}

function TraceList({ title, items, projectId, empty }: { title: string; items: TraceSummaryDto[]; projectId: string; empty: string }) {
  return (
    <div>
      <h3 className="mb-1 text-sm font-semibold">{title}</h3>
      {items.length === 0 ? <p className="text-xs text-slate-600 dark:text-slate-400">{empty}</p> : (
        <ul className="space-y-1 text-sm">{items.map((t) => (
          <li key={t.traceId} className="flex flex-wrap items-center gap-2">
            <Link className="text-indigo-700 underline dark:text-indigo-300" to={traceLink(t.traceId, projectId, t.environmentId)}>{t.rootName ?? '(root span not received)'}</Link>
            <span className="tabular-nums text-xs">{formatNs(t.durationNs)}</span>
            {t.errorCount > 0 && <Badge tone="danger">✕ {t.errorCount}</Badge>}
            {t.httpStatus !== null && <span className="text-xs tabular-nums">{t.httpStatus}</span>}
            <span className="font-mono text-xs text-slate-600 dark:text-slate-400">{utc(t.start).slice(11, 19)} UTC</span>
          </li>))}</ul>
      )}
    </div>
  );
}

function Body({ projectId, service, envNames }: { projectId: string; service: string; envNames: Map<string, string> }) {
  const [sp, setSp] = useSearchParams();
  const nav = useNavigate();
  const minutes = Number(sp.get('minutes')) || 60;
  const env = sp.get('env');
  const q = useQuery({
    queryKey: ['service', projectId, service, minutes, env], retry: false, refetchInterval: 30_000,
    queryFn: () => api<Detail>('GET', `/api/v1/projects/${projectId}/services/${encodeURIComponent(service)}?minutes=${minutes}${env ? `&environmentId=${env}` : ''}`),
  });

  // Change markers (deployments, ADR-0011) for the selected window, rounded to the minute so the request is stable between renders.
  const minuteNow = Math.floor(Date.now() / 60_000) * 60_000;
  const deploys = useDeploymentMarkers(projectId, new Date(minuteNow - minutes * 60_000).toISOString(), new Date(minuteNow).toISOString(), { service, environmentId: env ?? undefined });

  if (q.isPending) return <Loading label="Loading service…" />;
  if (q.isError) {
    return (
      <div className="space-y-3"><h1 className="text-xl font-semibold">Service {service}</h1>
        {q.error instanceof ApiRequestError && q.error.status === 404
          ? <EmptyState title="Service not found" action={<Link className="text-indigo-700 underline dark:text-indigo-300" to={`/services?p=${projectId}`}>All services</Link>}>No telemetry from this service has been received in the environments you can access.</EmptyState>
          : <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      </div>
    );
  }
  const rows = q.data.health;
  const window = { from: new Date(Date.now() - minutes * 60_000).toISOString(), to: new Date().toISOString() };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{service}</h1>
        <div className="flex items-center gap-3">
          <Link className="text-sm text-indigo-700 underline dark:text-indigo-300" to={`/services?p=${projectId}&minutes=${minutes}`}>← All services</Link>
          <label className="text-xs">Window
            <select className={`${fieldClass} ml-2`} value={minutes} onChange={(e) => { const n = new URLSearchParams(sp); n.set('minutes', e.target.value); setSp(n, { replace: true }); }}>{WINDOWS.map((w) => <option key={w.minutes} value={w.minutes}>{w.label}</option>)}</select></label>
        </div>
      </div>

      {rows.map((s) => {
        const seen = lastSeen(s);
        const stepMs = s.timeline.length > 1 ? s.timeline[1]!.t - s.timeline[0]!.t : 60_000;
        const envMarkers = deploys.forEnvironment(s.environmentId);
        const toTraces = (t: number, errorsOnly: boolean) => nav(tracesLink(projectId, { service, from: new Date(t).toISOString(), to: new Date(t + stepMs).toISOString(), errorsOnly, envId: s.environmentId }));
        return (
          <section key={s.environmentId} aria-label={`${service} in ${envNames.get(s.environmentId) ?? s.environmentId}`} className="space-y-3" data-testid="service-health">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge>{envNames.get(s.environmentId) ?? s.environmentId.slice(0, 8)}</Badge>{freshnessBadge(s.freshness)}{sourceBadge(s.source)}
              {s.version && <span className="text-xs text-slate-600 dark:text-slate-400">v{s.version}</span>}
              <span className="text-xs text-slate-600 dark:text-slate-400">{seen ? `last data ${utc(seen).slice(0, 19)} UTC` : 'no telemetry'}</span>
            </div>
            {s.freshness === 'stale' && <p role="note" className="rounded border border-amber-300 bg-amber-50 p-2 text-sm text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">No telemetry has been received from this service recently. The numbers below describe the past; they say nothing about its health right now.</p>}
            <p className="text-xs text-slate-600 dark:text-slate-400" data-testid="source-detail">{s.sourceDetail}</p>
            {deploys.failed && <p role="note" data-testid="markers-unavailable" className="text-xs text-slate-600 dark:text-slate-400">Deployment markers could not be loaded; the charts are complete without them.</p>}

            {s.source === 'none' ? (
              <EmptyState title="No request statistics available">This service has not sent HTTP server metrics or server spans in this window, so rate, errors and latency cannot be shown. It is not shown as zero.</EmptyState>
            ) : (
              <>
                <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                  {([['Requests', s.requests === null ? 'n/a' : s.requests.toLocaleString()], ['Rate', s.ratePerSec === null ? 'n/a' : `${fmtNum(s.ratePerSec, 2)}/s`], ['Error rate', pctText(s.errorRate)], ['p95 latency', msText(s.p95Ms)], ['p99 latency', msText(s.p99Ms)]] as const).map(([k, v]) => (
                    <div key={k} className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900"><dt className="text-xs text-slate-600 dark:text-slate-400">{k}</dt><dd className="text-lg font-semibold tabular-nums">{v}</dd></div>))}
                </dl>
                <Card title="Request volume and errors">
                  <TimelineChart title="Requests and errors per window" unit="requests" stepMs={stepMs}
                    summary={`${s.requests ?? 0} requests, ${s.errors ?? 0} errors in the selected window.`}
                    series={[{ name: 'Requests', kind: 'bar', tone: 'indigo', points: s.timeline.map((p) => ({ t: p.t, v: p.requests })) }, { name: 'Errors', kind: 'bar', tone: 'red', points: s.timeline.map((p) => ({ t: p.t, v: p.errors })) }]}
                    onPointClick={(t) => toTraces(t, true)} markers={envMarkers} />
                  <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">Selecting a bar opens the traces recorded in that window. This is a time-window link, not proof that those traces caused what the chart shows{s.source === 'traces' ? '' : ' (and only sampled traces exist)'}.</p>
                </Card>
                {s.source === 'metrics' && (
                  <Card title="Latency"><TimelineChart title="p95 latency per window" unit="ms" stepMs={stepMs} summary={`Overall p95 ${msText(s.p95Ms)}.`}
                    series={[{ name: 'p95', kind: 'line', tone: 'amber', points: s.timeline.map((p) => ({ t: p.t, v: p.p95Ms })) }]} onPointClick={(t) => toTraces(t, false)} markers={envMarkers} />
                    <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">Percentiles are estimated from histogram buckets of the merged distribution (never averaged across instances).</p></Card>
                )}
                {s.source === 'metrics' && (
                  <div className="grid gap-4 md:grid-cols-2">
                    <Card title="HTTP status distribution"><StackedBar title="Responses by class" parts={[
                      { label: '2xx', value: s.statuses['2xx'] ?? 0, tone: 'emerald' }, { label: '3xx', value: s.statuses['3xx'] ?? 0, tone: 'indigo' },
                      { label: '4xx', value: s.statuses['4xx'] ?? 0, tone: 'amber' }, { label: '5xx', value: s.statuses['5xx'] ?? 0, tone: 'red' }, { label: 'other', value: s.statuses.other ?? 0, tone: 'indigo' }]} /></Card>
                    <Card title="Slowest operations (by p95)">
                      {s.routes.length === 0 ? <p className="text-sm text-slate-600 dark:text-slate-400">No routes reported.</p> : (
                        <table className="w-full text-left text-sm" aria-label="Operations by p95"><thead className="text-xs uppercase text-slate-600 dark:text-slate-400"><tr><th scope="col" className="py-1">Route</th><th scope="col" className="py-1 text-right">Requests</th><th scope="col" className="py-1 text-right">Errors</th><th scope="col" className="py-1 text-right">p95</th></tr></thead>
                          <tbody>{[...s.routes].sort((a, b) => (b.p95Ms ?? -1) - (a.p95Ms ?? -1)).slice(0, 8).map((r) => (
                            <tr key={r.route} className="border-t border-slate-100 dark:border-slate-800"><th scope="row" className="py-1 font-mono text-xs font-normal">{r.route}</th><td className="py-1 text-right tabular-nums">{r.requests.toLocaleString()}</td><td className="py-1 text-right tabular-nums">{r.errors}</td><td className="py-1 text-right tabular-nums">{msText(r.p95Ms)}</td></tr>))}</tbody></table>
                      )}
                      {s.routes.some((r) => r.errors > 0) && <p className="mt-2 text-xs"><strong>Failing:</strong> {s.routes.filter((r) => r.errors > 0).sort((a, b) => b.errors - a.errors).slice(0, 5).map((r) => `${r.route} (${r.errors})`).join(', ')}</p>}
                    </Card>
                  </div>
                )}
              </>
            )}
          </section>
        );
      })}

      <Card title="Traces behind these numbers">
        <div className="grid gap-4 md:grid-cols-2">
          <TraceList title="Failed traces in this window" items={q.data.errorTraces} projectId={projectId} empty="No failed traces were received in this window." />
          <TraceList title="Slowest traces in this window" items={q.data.slowTraces} projectId={projectId} empty="No traces were received in this window." />
        </div>
        <p className="mt-2 text-xs text-slate-600 dark:text-slate-400" data-testid="correlation-note">{q.data.correlation}</p>
        <p className="mt-1 flex flex-wrap gap-3 text-sm">
          <Link className="text-indigo-700 underline dark:text-indigo-300" to={tracesLink(projectId, { service, ...window, errorsOnly: true })}>All failed traces</Link>
          <Link className="text-indigo-700 underline dark:text-indigo-300" to={`/metrics?p=${projectId}&metric=http.server.request.duration&svc=${encodeURIComponent(service)}&agg=p95&group=http.route&range=${minutes <= 60 ? '1h' : '24h'}`}>Explore this service’s metrics</Link>
          <Link className="text-indigo-700 underline dark:text-indigo-300" to={`/logs?p=${projectId}&svc=${encodeURIComponent(service)}&range=${minutes <= 60 ? '1h' : '24h'}`}>Logs of this service</Link>
        </p>
      </Card>
    </div>
  );
}

// re-exported for tests of link building
export { logsLink };
