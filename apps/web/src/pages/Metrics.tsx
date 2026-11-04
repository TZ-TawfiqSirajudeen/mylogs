import { METRIC_AGGREGATIONS, type MetricAggregation, type MetricLabelInfo, type MetricNameInfo, type MetricQueryResult } from '@nexus/contracts';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { z } from 'zod';
import { api } from '../api';
import { TimelineChart, fmtNum, type ChartSeries } from '../charts';
import { Button, Card, EmptyState, ErrorState, Loading } from '../ui';
import { PRESETS } from './logs/model';
import { traceLink, tracesLink } from './traces/model';
import { fieldClass, ProjectGate } from './traces/shared';
import { useDeploymentMarkers } from './deployments/useMarkers';
import { utc } from './logs/model';

type Names = z.infer<typeof MetricNameInfo>[];
type Labels = z.infer<typeof MetricLabelInfo>[];
type Result = z.infer<typeof MetricQueryResult>;

const AGG_BY_TYPE: Record<string, MetricAggregation[]> = {
  gauge: ['avg', 'min', 'max', 'last', 'count', 'sum'], sum: ['sum', 'rate'], histogram: ['p50', 'p90', 'p95', 'p99', 'avg', 'count', 'sum', 'rate', 'min', 'max'],
};
const TONES: ChartSeries['tone'][] = ['indigo', 'red', 'emerald', 'amber'];
const MAX_DRAWN = 8;

export default function Metrics() {
  const [sp] = useSearchParams();
  return <ProjectGate title="Metrics" urlProject={sp.get('p')}>{(project) => <Body projectId={project.id} />}</ProjectGate>;
}

function Body({ projectId }: { projectId: string }) {
  const [sp, setSp] = useSearchParams();
  const base = `/api/v1/projects/${projectId}`;
  const [metric, setMetric] = useState(sp.get('metric') ?? '');
  const [service, setService] = useState(sp.get('svc') ?? '');
  const [agg, setAgg] = useState<string>(sp.get('agg') ?? '');
  const [group, setGroup] = useState<string[]>((sp.get('group') ?? '').split(',').filter(Boolean).slice(0, 2));
  // A deep link (e.g. from an incident) may carry an absolute window and an environment: `range=custom&from=…&to=…&env=<id>`.
  const [custom, setCustom] = useState<{ from: string; to: string } | null>(() => {
    const from = sp.get('from'), to = sp.get('to');
    if (sp.get('range') !== 'custom' || !from || !to) return null;
    const a = Date.parse(from), z = Date.parse(to);
    return Number.isFinite(a) && Number.isFinite(z) && a < z && z - a <= 31 * 24 * 3600_000 ? { from: new Date(a).toISOString(), to: new Date(z).toISOString() } : null;
  });
  const [envId] = useState(() => (/^[0-9a-f-]{36}$/i.test(sp.get('env') ?? '') ? sp.get('env')! : ''));
  const [range, setRange] = useState(custom ? 'custom' : sp.get('range') === 'custom' ? '1h' : sp.get('range') ?? '1h');
  const [filters, setFilters] = useState<{ key: string; value: string }[]>(sp.getAll('f').slice(0, 5).map((x) => { const [key, ...v] = x.split('~'); return { key: key ?? '', value: v.join('~') }; }).filter((f) => f.key));
  const [nowMs, setNowMs] = useState(() => Date.now());

  const names = useQuery({ queryKey: ['metric-names', projectId], retry: false, staleTime: 15_000, queryFn: () => api<Names>('GET', `${base}/metrics/names`) });
  const info = names.data?.find((n) => n.name === metric);
  const labels = useQuery({ queryKey: ['metric-labels', projectId, metric], enabled: !!metric, retry: false, queryFn: () => api<Labels>('GET', `${base}/metrics/labels?metric=${encodeURIComponent(metric)}`) });
  const allowedAggs = info ? AGG_BY_TYPE[info.type]! : [...METRIC_AGGREGATIONS];
  const effectiveAgg = (agg && allowedAggs.includes(agg as MetricAggregation) ? agg : allowedAggs[0]) as MetricAggregation;

  // Default to the first metric when none is chosen (e.g. a fresh visit).
  useEffect(() => { if (!metric && names.data?.length) setMetric(names.data.find((n) => n.name === 'http.server.request.duration')?.name ?? names.data[0]!.name); }, [metric, names.data]);

  const preset = PRESETS.find((p) => p.key === range) ?? PRESETS[2];
  const body = useMemo(() => ({
    from: custom && range === 'custom' ? custom.from : new Date(nowMs - preset.ms).toISOString(), to: custom && range === 'custom' ? custom.to : new Date(nowMs).toISOString(), metric, agg: effectiveAgg,
    ...(service ? { service } : {}), filters: filters.filter((f) => f.value !== ''), groupBy: group, ...(envId ? { environmentIds: [envId] } : {}),
  }), [nowMs, preset.ms, custom, range, envId, metric, effectiveAgg, service, filters, group]);
  const result = useMutation({ mutationFn: () => api<Result>('POST', `${base}/metrics/query`, body) });

  const run = () => {
    const n = new URLSearchParams({ p: projectId, metric, range });
    if (custom && range === 'custom') { n.set('from', custom.from); n.set('to', custom.to); }
    if (envId) n.set('env', envId);
    if (service) n.set('svc', service);
    if (agg) n.set('agg', agg);
    if (group.length) n.set('group', group.join(','));
    for (const f of filters) if (f.value) n.append('f', `${f.key}~${f.value}`);
    setSp(n, { replace: true });
    setNowMs(Date.now());
  };
  // Run once when the metric list is known and a metric is selected (and again whenever the user presses Run).
  useEffect(() => { if (metric && names.isSuccess) result.mutate(); }, [metric, nowMs, names.isSuccess]); // eslint-disable-line react-hooks/exhaustive-deps

  const r = result.data;
  const drawn = (r?.series ?? []).slice(0, MAX_DRAWN);
  const kind: ChartSeries['kind'] = effectiveAgg === 'sum' || effectiveAgg === 'count' ? 'bar' : 'line';
  const series: ChartSeries[] = drawn.map((s, i) => ({
    name: Object.keys(s.labels).length ? Object.entries(s.labels).map(([k, v]) => `${k}=${v || '∅'}`).join(', ') : metric,
    kind, tone: TONES[i % TONES.length]!, dashed: i >= TONES.length, points: s.points,
  }));
  const exemplars = (r?.series ?? []).flatMap((s) => s.exemplars).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 8);
  // Change markers (deployments, ADR-0011) for the charted window, for the selected service (all services when none) and the queried environment, if the link named one.
  const deploys = useDeploymentMarkers(projectId, r?.from, r?.to, { service: service || undefined, environmentId: (body as { environmentIds?: string[] }).environmentIds?.[0] });

  return (
    <div className="space-y-3">
      <h1 className="text-xl font-semibold">Metrics</h1>
      {names.isPending && <Loading label="Loading metric catalogue…" />}
      {names.isError && <ErrorState error={names.error} onRetry={() => void names.refetch()} />}
      {names.data && names.data.length === 0 && (
        <EmptyState title="No metrics have been received" action={<Link className="text-indigo-700 underline dark:text-indigo-300" to="/sources?tab=ingestion">Set up ingestion</Link>}>
          Metrics appear after an OpenTelemetry SDK or Collector sends OTLP metrics (gauge, sum, or histogram) to <code className="font-mono">/v1/metrics</code> with a token that includes the “metrics” signal, or after a connected MongoDB or Redis <Link className="text-indigo-700 underline dark:text-indigo-300" to="/sources">data source</Link> (with the metrics signal selected) is collected.
        </EmptyState>
      )}
      {names.data && names.data.length > 0 && (
        <>
          <form className="space-y-3 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900" aria-label="Metric query" onSubmit={(e) => { e.preventDefault(); run(); }}>
            <div className="flex flex-wrap items-end gap-2">
              <label className="min-w-[14rem] flex-1 text-xs">Metric
                <select className={`${fieldClass} mt-0.5 block w-full`} value={metric} onChange={(e) => { setMetric(e.target.value); setGroup([]); setFilters([]); setAgg(''); }}>
                  {names.data.map((n) => <option key={n.name} value={n.name}>{n.name} ({n.type}{n.unit ? `, ${n.unit}` : ''})</option>)}</select></label>
              <label className="text-xs">Service
                <select className={`${fieldClass} mt-0.5 block`} value={service} onChange={(e) => setService(e.target.value)}><option value="">All services</option>{(info?.services ?? []).map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
              <label className="text-xs">Aggregation
                <select className={`${fieldClass} mt-0.5 block`} value={effectiveAgg} onChange={(e) => setAgg(e.target.value)}>{allowedAggs.map((a) => <option key={a} value={a}>{a}</option>)}</select></label>
              <label className="text-xs">Time range
                <select className={`${fieldClass} mt-0.5 block`} value={range} onChange={(e) => { setRange(e.target.value); if (e.target.value !== 'custom') setCustom(null); }}>{custom && <option value="custom">Window from link ({custom.from.slice(0, 16).replace('T', ' ')} to {custom.to.slice(0, 16).replace('T', ' ')} UTC)</option>}{PRESETS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}</select></label>
              <Button type="submit" disabled={result.isPending}>{result.isPending ? 'Running…' : 'Run query'}</Button>
            </div>
            <div className="flex flex-wrap items-start gap-4 text-sm">
              <fieldset><legend className="text-xs">Group by (max 2)</legend>
                <div className="mt-0.5 flex flex-wrap gap-3">
                  {['service', ...(labels.data ?? []).map((l) => l.key)].map((k) => (
                    <label key={k} className="flex items-center gap-1.5"><input type="checkbox" checked={group.includes(k)} disabled={!group.includes(k) && group.length >= 2}
                      onChange={(e) => setGroup(e.target.checked ? [...group, k] : group.filter((x) => x !== k))} />{k}</label>))}</div></fieldset>
              <fieldset><legend className="text-xs">Label filters (exact match)</legend>
                <div className="mt-0.5 flex flex-wrap items-center gap-2">
                  {filters.map((f, i) => (
                    <span key={i} className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 text-xs dark:bg-slate-800">{f.key} = {f.value}
                      <button type="button" aria-label={`Remove filter ${f.key}`} className="font-bold" onClick={() => setFilters(filters.filter((_, j) => j !== i))}>×</button></span>))}
                  {filters.length < 5 && (labels.data ?? []).length > 0 && (
                    <select aria-label="Add a label filter" className={fieldClass} value="" onChange={(e) => {
                      const [k, ...v] = e.target.value.split('\u0001'); if (k) setFilters([...filters, { key: k, value: v.join('\u0001') }]);
                    }}><option value="">Add filter…</option>{(labels.data ?? []).flatMap((l) => l.values.slice(0, 20).map((v) => <option key={`${l.key}${v}`} value={`${l.key}\u0001${v}`}>{l.key} = {v}</option>))}</select>)}
                </div></fieldset>
            </div>
          </form>

          {labels.data?.find((l) => l.key === 'nexus.source')?.values.includes('connector') && (
            <p role="note" data-testid="connector-metric-note" className="rounded border border-sky-300 bg-sky-50 p-2 text-sm dark:border-sky-900 dark:bg-sky-950/40">
              This metric is read by a <strong>data-source connector</strong> (read-only) from {(labels.data.find((l) => l.key === 'nexus.connection.name')?.values ?? []).join(', ') || 'a connected database'}, not sent by an instrumented application: it has no service, traces or exemplars. Filter on <code className="font-mono">nexus.connection.name</code> to see one connection.{' '}
              <Link className="text-indigo-700 underline dark:text-indigo-300" to="/sources">Data Sources</Link>
            </p>
          )}
          {result.isError && <ErrorState error={result.error} onRetry={() => result.mutate()} />}
          {result.isPending && <Loading label="Running query…" />}
          {r && (
            <Card title={`${r.metric}${r.unit ? ` (${r.unit})` : ''} · ${r.agg ?? ''}`}>
              <div aria-live="polite" className="mb-2 text-xs text-slate-600 dark:text-slate-400" data-testid="metric-summary">
                UTC {utc(r.from).slice(0, 19)} → {utc(r.to).slice(0, 19)} · window {Math.round(r.stepMs / 60_000)} min · {r.series.length} series{r.truncated ? ' (largest shown)' : ''}{r.series.length > MAX_DRAWN ? ` · first ${MAX_DRAWN} drawn` : ''}
              </div>
              {series.length === 0
                ? <EmptyState title="No data for this selection">{r.notes[0] ?? 'Nothing matches. Widen the time range or remove filters.'}</EmptyState>
                : <TimelineChart title={r.metric} unit={r.unit ?? r.agg ?? ''} series={series} stepMs={r.stepMs} summary={`${series.length} series, ${effectiveAgg}.`} markers={deploys.markers} />}
              {deploys.failed && <p role="note" data-testid="markers-unavailable" className="mt-1 text-xs text-slate-600 dark:text-slate-400">Deployment markers could not be loaded; the chart above is complete without them.</p>}
              {deploys.truncated && <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">Only the newest 200 deployments in this window are marked. <Link className="text-indigo-700 underline dark:text-indigo-300" to={`/deployments?p=${projectId}`}>All deployments</Link></p>}
              {drawn.length > 0 && (
                <table className="mt-3 w-full text-left text-xs" aria-label="Series summary">
                  <thead className="text-slate-600 dark:text-slate-400"><tr><th scope="col" className="py-1">Series</th><th scope="col" className="py-1 text-right">Latest</th><th scope="col" className="py-1 text-right">Windows with data</th></tr></thead>
                  <tbody>{drawn.map((s, i) => { const have = s.points.filter((p) => p.v !== null); return (
                    <tr key={i} className="border-t border-slate-100 dark:border-slate-800"><th scope="row" className="py-1 font-mono font-normal">{series[i]!.name}</th><td className="py-1 text-right tabular-nums">{fmtNum(have.at(-1)?.v ?? null)}</td><td className="py-1 text-right tabular-nums">{have.length}/{s.points.length}</td></tr>); })}</tbody>
                </table>
              )}
              <ul className="mt-3 list-disc space-y-0.5 pl-5 text-xs text-slate-600 dark:text-slate-400" data-testid="metric-notes">{r.notes.map((n) => <li key={n}>{n}</li>)}</ul>
              <div className="mt-3 border-t border-slate-200 pt-2 text-sm dark:border-slate-800">
                <h3 className="font-semibold">Traces behind this metric</h3>
                {exemplars.length > 0 ? (
                  <ul className="mt-1 space-y-1 text-xs" data-testid="exemplars">{exemplars.map((e, i) => (
                    <li key={i}>exemplar {fmtNum(e.value)} at {utc(e.ts).slice(11, 19)} UTC → <Link className="text-indigo-700 underline dark:text-indigo-300" to={traceLink(e.traceId, projectId, null, e.spanId)}>trace {e.traceId.slice(0, 8)}…</Link></li>))}</ul>
                ) : <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">This metric carries no exemplars (explicit trace references), so no individual trace can be tied to a value.</p>}
                <p className="mt-1 text-xs"><Link className="text-indigo-700 underline dark:text-indigo-300" to={tracesLink(projectId, { service: service || undefined, from: r.from, to: r.to, errorsOnly: false })}>Traces from the same window</Link> <span className="text-slate-600 dark:text-slate-400">— a time-window link: approximate, and limited to the traces that were sampled and received; it does not show that they caused the values above.</span></p>
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
