import type { ConnectionDto, ConnectorDescriptorDto } from '@nexus/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { useSelection } from '../session';
import { Badge, Button, Card, EmptyState, ErrorState, Loading } from '../ui';
import Ingestion from './Ingestion';
import { CapabilityList, fmtTime, SignalSummary, StateBadge, StepList, type Report } from './sources/parts';

const base = (projectId: string) => `/api/v1/projects/${projectId}`;

function RotateDialog({ conn, projectId, descriptor, onClose }: { conn: ConnectionDto; projectId: string; descriptor?: ConnectorDescriptorDto | undefined; onClose: () => void }) {
  const qc = useQueryClient();
  const fields = descriptor?.authMethods.find((a) => a.id === conn.authMethod)?.secretFields ?? [];
  // Held in component state only for the lifetime of this dialog; cleared on close/submit, never persisted.
  const [values, setValues] = useState<Record<string, string>>({});
  const rotate = useMutation({
    mutationFn: () => api<Report>('POST', `${base(projectId)}/connections/${conn.id}/rotate`, { secrets: values }),
    onSuccess: () => { setValues({}); void qc.invalidateQueries({ queryKey: ['connections', projectId] }); },
  });
  return (
    <div role="dialog" aria-modal="true" aria-label="Rotate credentials" className="fixed inset-0 z-20 flex items-center justify-center bg-black/50 p-4">
      <div className="w-full max-w-md space-y-3 rounded-lg bg-white p-4 dark:bg-slate-900">
        <h2 className="font-semibold">Rotate credentials — {conn.name}</h2>
        <p className="text-sm text-slate-600 dark:text-slate-400">New values replace the old ones immediately. The connection is re-tested right away. Values are write-only and are never shown again.</p>
        {fields.map((f) => (
          <label key={f.name} className="block space-y-1 text-sm"><span className="font-medium">{f.label}</span>
            <input type="password" autoComplete="new-password" className="w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 dark:border-slate-700 dark:bg-slate-950"
              value={values[f.name] ?? ''} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} /></label>
        ))}
        {fields.length === 0 && <p className="text-sm text-slate-500">This authentication method has no credentials.</p>}
        {rotate.isError && <p role="alert" className="text-sm text-red-600">{rotate.error.message}</p>}
        {rotate.data && (
          <div className="rounded border border-slate-200 p-2 dark:border-slate-800">
            <p className={`text-sm font-medium ${rotate.data.ok ? 'text-emerald-600' : 'text-red-600'}`}>{rotate.data.ok ? 'Rotated and verified.' : `Rotated, but the new credentials do not work: ${rotate.data.failure?.message}`}</p>
            <StepList steps={rotate.data.steps} />
          </div>
        )}
        <div className="flex gap-2">
          <Button disabled={rotate.isPending || fields.some((f) => !values[f.name])} onClick={() => rotate.mutate()}>{rotate.isPending ? 'Rotating…' : 'Rotate and test'}</Button>
          <Button variant="ghost" onClick={() => { setValues({}); onClose(); }}>Close</Button>
        </div>
      </div>
    </div>
  );
}

function ConnectionCard({ conn, projectId, envName, descriptor, canManage }: { conn: ConnectionDto; projectId: string; envName: string; descriptor?: ConnectorDescriptorDto | undefined; canManage: boolean }) {
  const qc = useQueryClient();
  const [rotating, setRotating] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['connections', projectId] }); };
  const test = useMutation({ mutationFn: () => api<Report>('POST', `${base(projectId)}/connections/${conn.id}/test`), onSuccess: (r) => { setReport(r); refresh(); } });
  const disconnect = useMutation({ mutationFn: () => api('POST', `${base(projectId)}/connections/${conn.id}/disconnect`), onSuccess: refresh });
  const remove = useMutation({ mutationFn: () => api('DELETE', `${base(projectId)}/connections/${conn.id}`), onSuccess: refresh });
  const h = conn.health;
  const available = conn.capabilities.filter((c) => c.available).length;
  return (
    <li className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="font-medium">{conn.name} <span className="text-sm font-normal text-slate-500">· {conn.connectorName} · {envName}</span></h3>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <StateBadge state={h.state} stale={h.stale} />
            <Badge>{conn.lifecycle}</Badge>
            {canManage && conn.lifecycle === 'draft' && <Link className="text-xs text-indigo-600 underline" to={`/sources/new?connection=${conn.id}`}>Continue setup</Link>}
          </div>
        </div>
        {canManage && <div className="flex flex-wrap gap-1.5">
          {conn.connectorStatus === 'implemented' && conn.lifecycle !== 'disconnected' && <Button variant="ghost" disabled={test.isPending} onClick={() => test.mutate()}>{test.isPending ? 'Testing…' : 'Test now'}</Button>}
          {conn.lifecycle !== 'disconnected' && <Button variant="ghost" onClick={() => setRotating(true)}>Rotate credentials</Button>}
          {conn.lifecycle === 'disconnected' && <Button variant="ghost" onClick={() => setRotating(true)}>Reconnect (new credentials)</Button>}
          {conn.lifecycle !== 'disconnected' && <Button variant="ghost" disabled={disconnect.isPending} onClick={() => { if (confirm(`Disconnect "${conn.name}"? Monitoring stops and the stored credentials are deleted.`)) disconnect.mutate(); }}>Disconnect</Button>}
          <Button variant="danger" disabled={remove.isPending} onClick={() => { if (confirm(`Delete "${conn.name}" and its credentials permanently?`)) remove.mutate(); }}>Delete</Button>
        </div>}
      </div>

      <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div><dt className="text-xs text-slate-500">Last check (UTC)</dt><dd>{fmtTime(h.lastCheckAt)}</dd></div>
        <div><dt className="text-xs text-slate-500">Last successful check</dt><dd>{fmtTime(h.lastSuccessAt)}</dd></div>
        <div><dt className="text-xs text-slate-500">Next check</dt><dd>{fmtTime(h.nextCheckAt)}</dd></div>
        <div><dt className="text-xs text-slate-500">Collection lag</dt><dd>{h.collectionLagSeconds === null ? 'n/a — nothing is collected yet' : `${h.collectionLagSeconds}s`}</dd></div>
        <div><dt className="text-xs text-slate-500">Last successful collection</dt><dd>{fmtTime(conn.collection.lastSuccessfulCollectionAt)}</dd></div>
        <div><dt className="text-xs text-slate-500">Consecutive failures</dt><dd>{h.consecutiveFailures}</dd></div>
        <div><dt className="text-xs text-slate-500">Capabilities detected</dt><dd>{available} of {conn.capabilities.length}</dd></div>
        <div><dt className="text-xs text-slate-500">Credentials</dt><dd>{Object.keys(conn.secrets).length ? `${Object.keys(conn.secrets).join(', ')} (stored, write-only)` : 'none stored'}</dd></div>
      </dl>

      {h.state !== 'healthy' && h.remediation && (
        <p role="status" className="mt-3 rounded border border-amber-300 bg-amber-50 p-2 text-sm dark:border-amber-900 dark:bg-amber-950/40">
          <span className="font-medium">{h.lastError?.message}</span><br />How to fix: {h.remediation}
        </p>
      )}
      <p className="mt-3 text-xs text-slate-500">{conn.collection.note}</p>
      <div className="mt-2"><SignalSummary signals={conn.signals} /></div>

      <details className="mt-3 text-sm">
        <summary className="cursor-pointer text-slate-600 dark:text-slate-400">Capabilities, recent errors and last test</summary>
        <div className="mt-2 space-y-3">
          <CapabilityList caps={conn.capabilities} />
          {h.recentErrors.length > 0 && (
            <div><h4 className="text-xs font-semibold uppercase text-slate-500">Recent errors</h4>
              <ul className="mt-1 space-y-1 text-xs">{h.recentErrors.map((e) => <li key={e.at}><span className="font-mono">{fmtTime(e.at)}</span> · {e.kind} · {e.message}</li>)}</ul></div>
          )}
          {(report ?? conn.lastTest) && <div><h4 className="text-xs font-semibold uppercase text-slate-500">Last test{conn.lastTest?.stale ? ' (stale: settings changed or older than 30 min)' : ''}</h4><StepList steps={(report ?? conn.lastTest)!.steps} /></div>}
        </div>
      </details>
      {(test.isError || disconnect.isError || remove.isError) && <p role="alert" className="mt-2 text-sm text-red-600">{(test.error ?? disconnect.error ?? remove.error)?.message}</p>}
      {canManage && rotating && <RotateDialog conn={conn} projectId={projectId} descriptor={descriptor} onClose={() => setRotating(false)} />}
    </li>
  );
}

function Matrix({ list }: { list: ConnectorDescriptorDto[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <table className="w-full min-w-[900px] text-left text-sm">
        <caption className="sr-only">Integration capability matrix</caption>
        <thead className="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-800">
          <tr><th className="px-3 py-2">Connector</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Signals</th><th className="px-3 py-2">Auth (★ recommended)</th><th className="px-3 py-2">Required permissions</th><th className="px-3 py-2">Known limitations</th></tr>
        </thead>
        <tbody className="divide-y divide-slate-200 align-top dark:divide-slate-800">
          {list.map((d) => (
            <tr key={d.type}>
              <td className="px-3 py-2 font-medium">{d.displayName}<div className="text-xs font-normal text-slate-500">{d.deploymentTypes.join('; ')}</div></td>
              <td className="px-3 py-2"><Badge tone={d.status === 'implemented' ? 'info' : 'warn'}>{d.status}</Badge><div className="mt-1 text-xs text-slate-500">{d.mode === 'push' ? 'push: logs via ingestion token' : d.collection === 'implemented' ? 'collects telemetry' : 'health/discovery only'}</div></td>
              <td className="px-3 py-2"><SignalSummary signals={d.signals} /></td>
              <td className="px-3 py-2">{d.authMethods.map((a) => <div key={a.id}>{a.label}{a.recommended && ' ★'}</div>)}</td>
              <td className="px-3 py-2 text-xs">{d.requiredPermissions.filter((p) => !p.optional).map((p) => <div key={p.permission}>{p.permission}</div>)}</td>
              <td className="px-3 py-2 text-xs">{d.limitations.map((l) => <div key={l}>{l}</div>)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-slate-200 p-3 text-xs text-slate-500 dark:border-slate-800">Pull connectors only verify and monitor health; log ingestion is push-based via ingestion tokens. Live health is per connection (see Connections).</p>
    </div>
  );
}

export default function Sources() {
  const { project, environment, projects } = useSelection();
  const [sp] = useSearchParams();
  const [tab, setTab] = useState<'connections' | 'ingestion' | 'matrix'>(sp.get('tab') === 'ingestion' ? 'ingestion' : 'connections');
  const connectors = useQuery({ queryKey: ['connectors'], queryFn: () => api<ConnectorDescriptorDto[]>('GET', '/api/v1/connectors'), staleTime: 300_000 });
  const projectId = project?.id;
  const conns = useQuery({
    queryKey: ['connections', projectId, environment?.id ?? 'all'], enabled: !!projectId, refetchInterval: 30_000,
    queryFn: () => api<ConnectionDto[]>('GET', `${base(projectId!)}/connections${environment ? `?environmentId=${environment.id}` : ''}`),
  });
  const envName = (id: string) => project?.environments.find((e) => e.id === id)?.name ?? id.slice(0, 8);
  const canManage = project?.role === 'project_admin';
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Data Sources</h1>
        {canManage && <Link to="/sources/new" className="inline-flex rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-500">Add data source</Link>}
      </div>
      <div role="tablist" className="flex gap-1 border-b border-slate-200 dark:border-slate-800">
        {([['connections', 'Connections'], ['ingestion', 'Ingestion'], ['matrix', 'Capability matrix']] as const).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`px-3 py-1.5 text-sm ${tab === k ? 'border-b-2 border-indigo-600 font-medium' : 'text-slate-500'}`}>{l}</button>
        ))}
      </div>
      {tab === 'ingestion' && <Ingestion />}
      {tab === 'matrix' && (connectors.isPending ? <Loading /> : connectors.isError ? <ErrorState error={connectors.error} onRetry={() => void connectors.refetch()} /> : <Matrix list={connectors.data} />)}
      {tab === 'connections' && (
        <>
          {!project && (
            <EmptyState title="Select a project">{projects.length === 0 ? 'No projects yet.' : 'Choose a project (and optionally an environment) in the header to see its data sources.'}</EmptyState>
          )}
          {project && !canManage && <Card><p className="text-sm text-slate-600 dark:text-slate-400">You have read-only access to this project&apos;s data sources. Project admins can add, test, rotate and remove them.</p></Card>}
          {project && conns.isPending && <Loading />}
          {project && conns.isError && <ErrorState error={conns.error} onRetry={() => void conns.refetch()} />}
          {project && conns.data?.length === 0 && (
            <EmptyState title="No data sources connected" action={canManage ? <Link className="text-indigo-600 underline" to="/sources/new">Add the first data source</Link> : undefined}>
              Connect an application health check, MongoDB or Redis. Telemetry collection is not implemented yet, so a connected source is verified and monitored for health only.
            </EmptyState>
          )}
          <ul className="space-y-3">
            {conns.data?.map((c) => <ConnectionCard key={c.id} conn={c} projectId={project!.id} envName={envName(c.environmentId)} canManage={canManage} descriptor={connectors.data?.find((d) => d.type === c.connectorType)} />)}
          </ul>
        </>
      )}
    </div>
  );
}
