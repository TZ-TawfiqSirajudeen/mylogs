import type { IngestStatsDto, IngestTokenCreated, IngestTokenDto } from '@nexus/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { z } from 'zod';
import { api } from '../api';
import { useSelection } from '../session';
import { Badge, Button, Card, EmptyState, ErrorState, Loading } from '../ui';
import { fmtTime } from './sources/parts';

type Token = z.infer<typeof IngestTokenDto>;
type Created = z.infer<typeof IngestTokenCreated>;
type Stats = z.infer<typeof IngestStatsDto>;
type Endpoints = { otlpHttpLogs: string; otlpHttpTraces: string; otlpHttpMetrics: string; jsonLogs: string; ingestBase: string };

const field = 'rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900';

function Snippet({ title, text }: { title: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="flex items-center justify-between"><h4 className="text-xs font-semibold uppercase text-slate-600 dark:text-slate-400">{title}</h4>
        <button type="button" className="rounded border border-slate-300 px-1.5 text-xs dark:border-slate-700" onClick={() => { void navigator.clipboard?.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}>{copied ? 'Copied' : `Copy ${title}`}</button></div>
      <pre className="mt-1 overflow-x-auto rounded bg-slate-100 p-2 font-mono text-xs dark:bg-slate-800" tabIndex={0}>{text}</pre>
    </div>
  );
}

/** Ingestion setup: where to send telemetry, tokens (shown once), and honest accounting of what arrived and what was refused. */
export default function Ingestion() {
  const { project } = useSelection();
  const qc = useQueryClient();
  const projectId = project?.id;
  const canManage = project?.role === 'project_admin';
  const base = `/api/v1/projects/${projectId}`;
  const endpoints = useQuery({ queryKey: ['telemetry-endpoints'], queryFn: () => api<Endpoints>('GET', '/api/v1/telemetry/endpoints'), staleTime: 300_000 });
  const stats = useQuery({ queryKey: ['ingest-stats', projectId], enabled: !!projectId, refetchInterval: 15_000, queryFn: () => api<Stats>('GET', `${base}/ingest/stats?minutes=60`) });
  const tokens = useQuery({ queryKey: ['ingest-tokens', projectId], enabled: !!projectId && canManage, queryFn: () => api<Token[]>('GET', `${base}/ingest-tokens`) });

  const [envId, setEnvId] = useState('');
  const [name, setName] = useState('');
  const [retention, setRetention] = useState(30);
  const [extraKeys, setExtraKeys] = useState('');
  const [signals, setSignals] = useState<{ logs: boolean; traces: boolean; metrics: boolean }>({ logs: true, traces: true, metrics: true });
  // The token lives ONLY in this component's state until dismissed; it is never written to storage or the URL.
  const [fresh, setFresh] = useState<Created | null>(null);
  useEffect(() => () => setFresh(null), [projectId]);

  const create = useMutation({
    mutationFn: () => api<Created>('POST', `${base}/environments/${envId}/ingest-tokens`, {
      name, retentionDays: retention, signals: (['logs', 'traces', 'metrics'] as const).filter((s) => signals[s]), redaction: { enabled: true, extraKeys: extraKeys.split(',').map((s) => s.trim()).filter(Boolean) },
    }),
    onSuccess: (c) => { setFresh(c); setName(''); void qc.invalidateQueries({ queryKey: ['ingest-tokens', projectId] }); },
  });
  const revoke = useMutation({ mutationFn: (id: string) => api('DELETE', `${base}/ingest-tokens/${id}`), onSuccess: () => void qc.invalidateQueries({ queryKey: ['ingest-tokens', projectId] }) });

  if (!project) return <EmptyState title="Select a project">Choose a project in the header to manage its ingestion.</EmptyState>;
  const envName = (id: string) => project.environments.find((e) => e.id === id)?.name ?? id.slice(0, 8);
  const ep = endpoints.data;

  return (
    <div className="space-y-4">
      <Card title="What arrived in the last hour">
        {stats.isPending && <Loading />}
        {stats.isError && <ErrorState error={stats.error} onRetry={() => void stats.refetch()} />}
        {stats.data && (
          <div className="space-y-3">
            <ul className="grid gap-3 md:grid-cols-2">
              {project.environments.map((e) => {
                const s = stats.data.perEnvironment.find((x) => x.environmentId === e.id);
                return (
                  <li key={e.id} className="rounded-lg border border-slate-200 p-3 dark:border-slate-800" data-testid={`ingest-env-${e.name}`}>
                    <div className="flex items-center justify-between"><span className="font-medium">{e.name}</span>{e.isProduction && <Badge tone="danger">production</Badge>}</div>
                    <p className="mt-1 text-sm">{s?.lastAcceptedAt ? <>Last telemetry received <time dateTime={s.lastAcceptedAt}>{fmtTime(s.lastAcceptedAt)}</time></> : <span className="font-medium">No telemetry received yet</span>}</p>
                    <p className="text-xs text-slate-600 dark:text-slate-400">{(s?.accepted ?? 0).toLocaleString()} accepted · {(s?.refused ?? 0).toLocaleString()} refused (last hour)</p>
                  </li>
                );
              })}
            </ul>
            <dl className="grid grid-cols-2 gap-2 text-sm md:grid-cols-4" aria-label="Refusals in the last hour">
              {([['Invalid / too old', stats.data.totals.rejectedInvalid], ['Rate limited', stats.data.totals.rejectedQuota], ['Overload', stats.data.totals.rejectedOverload], ['Storage errors', stats.data.totals.rejectedStorage]] as const).map(([k, v]) => (
                <div key={k}><dt className="text-xs text-slate-600 dark:text-slate-400">{k}</dt><dd className={v ? 'font-semibold text-red-700 dark:text-red-400' : ''}>{v.toLocaleString()}</dd></div>))}
            </dl>
            {stats.data.refused > 0 && <p role="alert" className="text-sm text-red-700 dark:text-red-400">Refused records are not stored. OpenTelemetry exporters retry rate-limit and overload responses; invalid records are never retried.</p>}
          </div>
        )}
      </Card>

      {!canManage && <Card><p className="text-sm text-slate-600 dark:text-slate-400">Only project admins can see and manage ingestion tokens.</p></Card>}

      {canManage && (
        <>
          <Card title="Create an ingestion token">
            <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
              <label className="text-sm">Environment<select required className={`${field} mt-0.5 block`} value={envId} onChange={(e) => setEnvId(e.target.value)}>
                <option value="">Select…</option>{project.environments.map((e) => <option key={e.id} value={e.id}>{e.name}{e.isProduction ? ' (production)' : ''}</option>)}</select></label>
              <label className="text-sm">Token name<input required className={`${field} mt-0.5 block`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="checkout-api" /></label>
              <label className="text-sm">Retention (days)<input type="number" min={1} max={90} className={`${field} mt-0.5 block w-24`} value={retention} onChange={(e) => setRetention(Number(e.target.value))} /></label>
              <label className="text-sm">Extra fields to mask<input className={`${field} mt-0.5 block`} value={extraKeys} onChange={(e) => setExtraKeys(e.target.value)} placeholder="customer.ssn, card.number" /></label>
              <fieldset className="text-sm"><legend className="text-xs">Signals this token may send</legend>
                <div className="mt-0.5 flex gap-3">{(['logs', 'traces', 'metrics'] as const).map((s) => (
                  <label key={s} className="flex items-center gap-1"><input type="checkbox" checked={signals[s]} onChange={(e) => setSignals({ ...signals, [s]: e.target.checked })} />{s}</label>))}</div></fieldset>
              <Button type="submit" disabled={!envId || !name.trim() || create.isPending || !(signals.logs || signals.traces || signals.metrics)}>{create.isPending ? 'Creating…' : 'Create token'}</Button>
            </form>
            {create.isError && <p role="alert" className="mt-2 text-sm text-red-600">{create.error.message}</p>}
            <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">A token is tied to one environment: telemetry sent with it can only ever land there. Sensitive fields are masked before storage; masking is best-effort.</p>
          </Card>

          {fresh && (
            <section aria-label="New token" className="space-y-3 rounded-lg border-2 border-emerald-500 bg-emerald-50 p-4 dark:bg-emerald-950/30" data-testid="fresh-token">
              <h2 className="font-semibold">Token created for {envName(fresh.info.environmentId)} — copy it now</h2>
              <p role="alert" className="text-sm">This token is shown <strong>once</strong>. It is not stored and cannot be retrieved later; if you lose it, revoke it and create another.</p>
              <div className="flex flex-wrap items-center gap-2"><code className="break-all rounded bg-white px-2 py-1 font-mono text-sm dark:bg-slate-900" data-testid="fresh-token-value">{fresh.token}</code></div>
              {ep && <Snippet title="Environment variables (Node.js / any OpenTelemetry SDK)" text={`OTEL_EXPORTER_OTLP_ENDPOINT=${ep.ingestBase}\nOTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\nOTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer ${fresh.token}\n# per-signal endpoints (logs: ${ep.otlpHttpLogs}, traces: ${ep.otlpHttpTraces}, metrics: ${ep.otlpHttpMetrics})`} />}
              <Button variant="ghost" onClick={() => setFresh(null)}>I have copied it — dismiss</Button>
            </section>
          )}

          <Card title="Tokens">
            {tokens.isPending && <Loading />}
            {tokens.isError && <ErrorState error={tokens.error} onRetry={() => void tokens.refetch()} />}
            {tokens.data?.length === 0 && <p className="text-sm text-slate-600 dark:text-slate-400">No tokens yet.</p>}
            {!!tokens.data?.length && (
              <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-sm"><caption className="sr-only">Ingestion tokens</caption>
                <thead className="text-xs uppercase text-slate-600 dark:text-slate-400"><tr><th className="py-1 pr-3">Name</th><th className="pr-3">Environment</th><th className="pr-3">Token</th><th className="pr-3">Signals</th><th className="pr-3">Retention</th><th className="pr-3">Last used (UTC)</th><th className="pr-3">Status</th><th><span className="sr-only">Actions</span></th></tr></thead>
                <tbody className="divide-y divide-slate-200 dark:divide-slate-800">{tokens.data.map((t) => (
                  <tr key={t.id}><td className="py-1.5 pr-3 font-medium">{t.name}</td><td className="pr-3">{envName(t.environmentId)}</td><td className="pr-3 font-mono text-xs">{t.prefix}…</td>
                    <td className="pr-3 text-xs" data-testid="token-signals">{t.scopes.join(', ')}</td><td className="pr-3">{t.retentionDays} d</td><td className="pr-3 font-mono text-xs">{fmtTime(t.lastUsedAt)}</td>
                    <td className="pr-3">{t.revokedAt ? <Badge tone="danger">revoked</Badge> : <Badge tone="info">active</Badge>}</td>
                    <td className="text-right">{!t.revokedAt && <Button variant="danger" disabled={revoke.isPending} onClick={() => { if (confirm(`Revoke token "${t.name}"? Senders using it will start receiving 401 errors.`)) revoke.mutate(t.id); }}>Revoke</Button>}</td></tr>))}</tbody></table></div>
            )}
          </Card>
        </>
      )}

      {ep && (
        <Card title="Where to send telemetry">
          <div className="space-y-3">
            <p className="text-sm">OTLP/HTTP endpoints (JSON or protobuf, optionally gzip): logs <code className="rounded bg-slate-100 px-1 font-mono text-xs dark:bg-slate-800">{ep.otlpHttpLogs}</code> · traces <code className="rounded bg-slate-100 px-1 font-mono text-xs dark:bg-slate-800">{ep.otlpHttpTraces}</code> · metrics <code className="rounded bg-slate-100 px-1 font-mono text-xs dark:bg-slate-800">{ep.otlpHttpMetrics}</code> · generic JSON/NDJSON logs: <code className="rounded bg-slate-100 px-1 font-mono text-xs dark:bg-slate-800">{ep.jsonLogs}</code>. OTLP/gRPC is not supported.</p>
            <Snippet title="OpenTelemetry Collector" text={`exporters:\n  otlphttp/nexus:\n    logs_endpoint: ${ep.otlpHttpLogs}\n    traces_endpoint: ${ep.otlpHttpTraces}\n    metrics_endpoint: ${ep.otlpHttpMetrics}\n    headers:\n      Authorization: "Bearer \${env:NEXUS_INGEST_TOKEN}"\nservice:\n  pipelines:\n    logs:\n      receivers: [otlp]\n      exporters: [otlphttp/nexus]\n    traces:\n      receivers: [otlp]\n      exporters: [otlphttp/nexus]\n    metrics:\n      receivers: [otlp]\n      exporters: [otlphttp/nexus]`} />
            <Snippet title="curl (JSON logs)" text={`curl -X POST ${ep.jsonLogs} \\\n  -H "Authorization: Bearer $NEXUS_INGEST_TOKEN" -H "Content-Type: application/json" \\\n  -d '[{"level":"error","msg":"payment failed","service":"checkout","http.response.status_code":500}]'`} />
            <p className="text-xs text-slate-600 dark:text-slate-400">Logs are supported. Traces and metrics over OTLP are planned (phase 4); the endpoint does not accept them yet.</p>
          </div>
        </Card>
      )}
    </div>
  );
}
