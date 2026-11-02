import type { ConnectionDto, ConnectorDescriptorDto } from '@nexus/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { z } from 'zod';
import type { DiscoveryDto, PreviewDto } from '@nexus/contracts';
import { api, ApiRequestError } from '../api';
import { useSelection } from '../session';
import { Badge, Button, Card, ErrorState, Loading } from '../ui';
import { buildConfig, CapabilityList, ConfigForm, StepList, type ConfigDraft, type Report } from './sources/parts';

type Discovery = z.infer<typeof DiscoveryDto>;
type Preview = z.infer<typeof PreviewDto>;

const STEPS = [
  'Provider', 'Scope', 'Authentication', 'Details', 'Validate', 'Permissions', 'Test', 'Discover', 'Select', 'Settings', 'Preview', 'Start',
] as const;

const field = 'w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900';

function problemText(e: unknown): string[] {
  if (!(e instanceof ApiRequestError)) return [e instanceof Error ? e.message : 'Request failed'];
  return [e.message];
}

export default function SourceWizard() {
  const nav = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const { projects, projectsStatus, project: selProject, environment: selEnv } = useSelection();
  const resumeId = params.get('connection');

  const connectors = useQuery({ queryKey: ['connectors'], queryFn: () => api<ConnectorDescriptorDto[]>('GET', '/api/v1/connectors'), staleTime: 300_000 });
  const adminProjects = projects.filter((p) => p.role === 'project_admin');
  const notAdmin = projectsStatus === 'success' && adminProjects.length === 0 && !resumeId;

  const [step, setStep] = useState(0);
  const [type, setType] = useState<string | null>(null);
  const [projectId, setProjectId] = useState<string | null>(selProject?.role === 'project_admin' ? selProject.id : null);
  const [envId, setEnvId] = useState<string | null>(selEnv?.id ?? null);
  const [authMethod, setAuthMethod] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<ConfigDraft>({});
  // Credentials live ONLY here until the draft is saved; they are wiped immediately after submission.
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [conn, setConn] = useState<ConnectionDto | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [selIds, setSelIds] = useState<Set<string>>(new Set());
  const [selSignals, setSelSignals] = useState<Set<string>>(new Set());
  const [settings, setSettings] = useState({ pollIntervalSeconds: 60, sampling: 1, retentionDays: 30, redactionEnabled: true, extraKeys: '' });

  // The header selection loads asynchronously (e.g. after a reload or a direct visit): adopt it ONCE when it arrives,
  // without fighting the user if they later choose differently.
  const adopted = useRef(false);
  useEffect(() => {
    if (adopted.current || !selProject || selProject.role !== 'project_admin') return;
    adopted.current = true;
    setProjectId((p) => p ?? selProject.id);
    setEnvId((e) => e ?? selEnv?.id ?? null);
  }, [selProject, selEnv]);

  const descriptor = connectors.data?.find((d) => d.type === type);
  const method = descriptor?.authMethods.find((a) => a.id === authMethod);
  const project = projects.find((p) => p.id === projectId);
  const base = projectId ? `/api/v1/projects/${projectId}` : '';

  // Resume an unfinished draft.
  const resume = useQuery({
    queryKey: ['connection', resumeId], enabled: !!resumeId && !!selProject,
    queryFn: () => api<ConnectionDto>('GET', `/api/v1/projects/${selProject!.id}/connections/${resumeId}`),
  });
  useEffect(() => {
    const c = resume.data;
    if (!c || conn) return;
    setConn(c); setType(c.connectorType); setProjectId(c.projectId); setEnvId(c.environmentId); setAuthMethod(c.authMethod); setName(c.name);
    if (c.lifecycle === 'draft') setStep(6);
  }, [resume.data, conn]);

  const invalidate = () => { void qc.invalidateQueries({ queryKey: ['connections'] }); };

  const save = useMutation({
    mutationFn: async () => {
      const config = buildConfig(type!, authMethod!, draft);
      if (conn) return api<ConnectionDto>('PATCH', `${base}/connections/${conn.id}`, { name, config });
      return api<ConnectionDto>('POST', `${base}/environments/${envId}/connections`, { connectorType: type, name, authMethod, config, secrets });
    },
    onSuccess: (c) => { setSecrets({}); setConn(c); setReport(null); setDiscovery(null); invalidate(); },
  });
  const test = useMutation({ mutationFn: () => api<Report>('POST', `${base}/connections/${conn!.id}/test`), onSuccess: (r) => { setReport(r); setConn(r.connection); } });
  const discover = useMutation({
    mutationFn: () => api<Discovery>('POST', `${base}/connections/${conn!.id}/discover`),
    onSuccess: (d) => { setDiscovery(d); setConn(d.connection); setSelIds(new Set()); setSelSignals(new Set()); },
  });
  const select = useMutation({
    mutationFn: () => api<ConnectionDto>('PUT', `${base}/connections/${conn!.id}/selection`, { resourceIds: [...selIds], signals: [...selSignals] }),
    onSuccess: setConn,
  });
  const saveSettings = useMutation({
    mutationFn: () => api<ConnectionDto>('PUT', `${base}/connections/${conn!.id}/settings`, {
      pollIntervalSeconds: settings.pollIntervalSeconds, sampling: settings.sampling, retentionDays: settings.retentionDays,
      redaction: { enabled: settings.redactionEnabled, extraKeys: settings.extraKeys.split(',').map((s) => s.trim()).filter(Boolean) },
    }),
    onSuccess: setConn,
  });
  const preview = useQuery({ queryKey: ['preview', conn?.id, conn?.updatedAt], enabled: step === 10 && !!conn, queryFn: () => api<Preview>('GET', `${base}/connections/${conn!.id}/preview`) });
  const activate = useMutation({ mutationFn: () => api<ConnectionDto>('POST', `${base}/connections/${conn!.id}/activate`), onSuccess: (c) => { setConn(c); invalidate(); } });

  const offeredSignals = useMemo(() => {
    const chosen = discovery?.resources.filter((r) => selIds.has(r.id)) ?? [];
    return [...new Set(chosen.flatMap((r) => r.signals))].filter((s) => descriptor?.signals.some((d) => d.signal === s && (d.availability === 'supported' || d.availability === 'requires_config')));
  }, [discovery, selIds, descriptor]);

  if (connectors.isPending) return <Loading />;
  if (connectors.isError) return <ErrorState error={connectors.error} onRetry={() => void connectors.refetch()} />;
  const nextDisabled = (() => {
    switch (step) {
      case 0: return !type || notAdmin;
      case 1: return !projectId || !envId;
      case 2: return !authMethod;
      case 3: return !name.trim() || (method?.secretFields ?? []).some((f) => !conn && !secrets[f.name]);
      case 4: return !conn;
      case 6: return !report?.ok;
      case 7: return !discovery;
      case 8: return !conn?.selection;
      case 9: return !conn?.settings;
      default: return false;
    }
  })();
  const go = (n: number) => setStep(Math.max(0, Math.min(STEPS.length - 1, n)));

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div><Link to="/sources" className="text-sm text-indigo-600 hover:underline">← Data Sources</Link><h1 className="mt-1 text-xl font-semibold">Add a data source</h1></div>
      {notAdmin && (
        <p role="alert" className="rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
          Only project admins can add data sources, and you are not an admin of any project. Ask a project admin for access.
        </p>
      )}
      <ol className="flex flex-wrap gap-1 text-xs" aria-label="Wizard steps">
        {STEPS.map((s, i) => (
          <li key={s} aria-current={i === step ? 'step' : undefined} className={`rounded px-2 py-1 ${i === step ? 'bg-indigo-600 text-white' : i < step ? 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950 dark:text-indigo-300' : 'bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300'}`}>{i + 1}. {s}</li>
        ))}
      </ol>

      <Card title={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}>
        {step === 0 && (
          <div className="grid gap-2 sm:grid-cols-2">
            {connectors.data.map((d) => (
              <button key={d.type} type="button" disabled={d.status !== 'implemented' || d.mode === 'push'} onClick={() => { setType(d.type); setAuthMethod(d.authMethods.find((a) => a.recommended)?.id ?? null); setDraft({}); }}
                aria-pressed={type === d.type}
                className={`rounded-lg border p-3 text-left text-sm ${type === d.type ? 'border-indigo-500 ring-1 ring-indigo-500' : 'border-slate-200 dark:border-slate-800'} disabled:cursor-not-allowed disabled:opacity-60`}>
                <div className="flex items-center justify-between"><span className="font-medium">{d.displayName}</span><Badge tone={d.status === 'implemented' ? 'info' : 'warn'}>{d.mode === 'push' ? 'Use an ingestion token' : d.status === 'implemented' ? 'Available' : 'Planned — not connectable'}</Badge></div>
                <div className="mt-1 text-xs text-slate-500">{d.category} · {d.signals.filter((s) => s.availability === 'supported').map((s) => s.signal).join(', ') || 'no signals yet'}</div>
              </button>
            ))}
          </div>
        )}

        {step === 1 && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm"><span className="font-medium">Project</span>
              <select className={field} value={projectId ?? ''} disabled={!!conn} onChange={(e) => { setProjectId(e.target.value || null); setEnvId(null); }}>
                <option value="">Select a project…</option>{adminProjects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
            <label className="space-y-1 text-sm"><span className="font-medium">Environment</span>
              <select className={field} value={envId ?? ''} disabled={!project || !!conn} onChange={(e) => setEnvId(e.target.value || null)}>
                <option value="">Select an environment…</option>{project?.environments.map((e) => <option key={e.id} value={e.id}>{e.name}{e.isProduction ? ' (production)' : ''}</option>)}</select></label>
            {adminProjects.length === 0 && <p className="text-sm text-slate-600 sm:col-span-2">Only project admins can add data sources, and you are not an admin of any project.</p>}
            {project?.environments.find((e) => e.id === envId)?.isProduction && <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-800 sm:col-span-2 dark:bg-red-950/40 dark:text-red-300">This is a PRODUCTION environment.</p>}
          </div>
        )}

        {step === 2 && descriptor && (
          <fieldset className="space-y-2"><legend className="sr-only">Authentication method</legend>
            {descriptor.authMethods.map((a) => (
              <label key={a.id} className={`flex cursor-pointer gap-3 rounded-lg border p-3 text-sm ${authMethod === a.id ? 'border-indigo-500' : 'border-slate-200 dark:border-slate-800'}`}>
                <input type="radio" name="auth" checked={authMethod === a.id} disabled={!!conn} onChange={() => setAuthMethod(a.id)} />
                <span><span className="font-medium">{a.label}</span> {a.recommended && <Badge tone="info">Recommended</Badge>}<span className="block text-slate-600 dark:text-slate-400">{a.description}</span></span>
              </label>
            ))}
          </fieldset>
        )}

        {step === 3 && descriptor && authMethod && (
          <div className="space-y-4">
            <label className="block space-y-1 text-sm"><span className="font-medium">Connection name</span><input className={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="checkout api (prod)" /></label>
            <ConfigForm type={descriptor.type} authMethod={authMethod} draft={draft} onChange={setDraft} projectId={projectId} onSecret={(n, v) => setSecrets((s) => ({ ...s, [n]: v }))} />
            {(method?.secretFields.length ?? 0) > 0 && (
              <div className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
                <p className="text-sm font-medium">Credentials</p>
                {conn ? <p className="text-sm text-slate-600 dark:text-slate-400">Credentials are already stored (encrypted, write-only). To change them, use “Rotate credentials” on the Data Sources page.</p> : method!.secretFields.map((f) => (
                  <label key={f.name} className="block space-y-1 text-sm"><span>{f.label}</span>
                    <input type="password" autoComplete="new-password" className={field} value={secrets[f.name] ?? ''} onChange={(e) => setSecrets({ ...secrets, [f.name]: e.target.value })} /></label>
                ))}
                <p className="text-xs text-slate-500">Sent once over TLS, stored encrypted, never displayed again, never kept in the browser after you continue.</p>
              </div>
            )}
          </div>
        )}

        {step === 4 && (
          <div className="space-y-3">
            <p className="text-sm">The server validates your settings against the connector&apos;s schema and stores the credentials encrypted. Nothing is connected yet.</p>
            <Button disabled={save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Validating…' : conn ? 'Re-validate and save changes' : 'Validate and save draft'}</Button>
            {save.isError && <div role="alert" className="rounded border border-red-300 bg-red-50 p-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">{problemText(save.error).map((m) => <p key={m}>{m}</p>)}{save.error instanceof ApiRequestError && save.error.code === 'invalid_config' && <p className="mt-1 text-xs">Go back to “Details” to correct the settings.</p>}</div>}
            {conn && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">Draft saved. Credentials: {Object.keys(conn.secrets).join(', ') || 'none'} (encrypted, hidden).</p>}
          </div>
        )}

        {step === 5 && descriptor && (
          <div className="space-y-3 text-sm">
            <p>Grant only what is listed here — nothing more. These are the exact permissions the connector uses.</p>
            <ul className="space-y-1">{descriptor.requiredPermissions.map((p) => <li key={p.permission}><span className="font-medium">{p.permission}</span> <span className="text-slate-500">({p.scope}){p.optional ? ' — optional' : ''}</span><br /><span className="text-slate-600 dark:text-slate-400">{p.why}</span></li>)}</ul>
            {descriptor.leastPrivilegeGuide && <pre className="overflow-x-auto rounded bg-slate-100 p-3 font-mono text-xs dark:bg-slate-800">{descriptor.leastPrivilegeGuide}</pre>}
            <div><p className="font-medium">Known limitations</p><ul className="list-disc pl-5 text-slate-600 dark:text-slate-400">{descriptor.limitations.map((l) => <li key={l}>{l}</li>)}</ul></div>
          </div>
        )}

        {step === 6 && (
          <div className="space-y-3">
            <p className="text-sm">Tests the network policy, connectivity, authentication and permissions. Read-only; nothing is written to the target.</p>
            <Button disabled={test.isPending || !conn} onClick={() => test.mutate()}>{test.isPending ? 'Testing…' : report ? 'Test again' : 'Run connection test'}</Button>
            {test.isError && <p role="alert" className="text-sm text-red-600">{test.error.message}</p>}
            {report && (
              <div className="space-y-3">
                <p role="status" className={`text-sm font-medium ${report.ok ? 'text-emerald-600' : 'text-red-600'}`}>{report.ok ? 'Connection verified.' : `Failed: ${report.failure?.message}`}</p>
                {!report.ok && report.failure && <p className="rounded border border-amber-300 bg-amber-50 p-2 text-sm dark:border-amber-900 dark:bg-amber-950/40">How to fix: {report.failure.remediation}</p>}
                <StepList steps={report.steps} />
                <div><p className="text-sm font-medium">Capabilities detected</p><CapabilityList caps={report.capabilities} /></div>
              </div>
            )}
          </div>
        )}

        {step === 7 && (
          <div className="space-y-3">
            <Button disabled={discover.isPending || !conn} onClick={() => discover.mutate()}>{discover.isPending ? 'Discovering…' : discovery ? 'Discover again' : 'Discover resources'}</Button>
            {discover.isError && <div role="alert" className="text-sm text-red-600">{discover.error.message}{discover.error instanceof ApiRequestError && ' — see the connection test for remediation.'}</div>}
            {discovery && (
              <div className="space-y-2">
                <p className="text-sm">{discovery.resources.length} resource(s) found{discovery.truncated ? ' (list truncated)' : ''}.</p>
                <ul className="divide-y divide-slate-200 text-sm dark:divide-slate-800">{discovery.resources.slice(0, 50).map((r) => <li key={r.id} className="py-1.5"><span className="font-medium">{r.name}</span> <span className="text-xs text-slate-500">{r.type} · signals: {r.signals.join(', ') || 'none'}</span></li>)}</ul>
              </div>
            )}
          </div>
        )}

        {step === 8 && discovery && (
          <div className="space-y-3">
            <p className="text-sm font-medium">Resources</p>
            <ul className="max-h-64 space-y-1 overflow-y-auto text-sm">
              {discovery.resources.map((r) => (
                <li key={r.id}><label className="flex items-center gap-2"><input type="checkbox" checked={selIds.has(r.id)} onChange={(e) => setSelIds((s) => { const n = new Set(s); e.target.checked ? n.add(r.id) : n.delete(r.id); return n; })} />{r.name} <span className="text-xs text-slate-500">({r.type})</span></label></li>
              ))}
            </ul>
            <p className="text-sm font-medium">Signals</p>
            {offeredSignals.length === 0 ? <p className="text-sm text-slate-500">Select at least one resource to see the signals it can provide.</p> : (
              <div className="flex flex-wrap gap-3">{offeredSignals.map((s) => <label key={s} className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={selSignals.has(s)} onChange={(e) => setSelSignals((x) => { const n = new Set(x); e.target.checked ? n.add(s) : n.delete(s); return n; })} />{s}</label>)}</div>
            )}
            <p className="text-xs text-slate-500">Only signals this connector can really provide are offered. Logs and traces are not available from this source.</p>
            <Button disabled={select.isPending || selIds.size === 0 || selSignals.size === 0} onClick={() => select.mutate()}>{select.isPending ? 'Saving…' : 'Save selection'}</Button>
            {select.isError && <p role="alert" className="text-sm text-red-600">{select.error.message}</p>}
            {conn?.selection && <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">Selection saved: {conn.selection.resourceIds.length} resource(s), signals {conn.selection.signals.join(', ')}.</p>}
          </div>
        )}
        {step === 8 && !discovery && <p className="text-sm text-slate-500">Run discovery in the previous step first.</p>}

        {step === 9 && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="space-y-1 text-sm"><span className="font-medium">Health-check interval (seconds, 30–3600)</span><input type="number" min={30} max={3600} className={field} value={settings.pollIntervalSeconds} onChange={(e) => setSettings({ ...settings, pollIntervalSeconds: Number(e.target.value) })} /></label>
            <label className="space-y-1 text-sm"><span className="font-medium">Sampling (0.01–1)</span><input type="number" step={0.01} min={0.01} max={1} className={field} value={settings.sampling} onChange={(e) => setSettings({ ...settings, sampling: Number(e.target.value) })} />
              <span className="block text-xs text-slate-500">Sampling removes evidence that incident investigation may need. Keep 1 unless volume forces otherwise.</span></label>
            <label className="space-y-1 text-sm"><span className="font-medium">Retention (days, 1–365)</span><input type="number" min={1} max={365} className={field} value={settings.retentionDays} onChange={(e) => setSettings({ ...settings, retentionDays: Number(e.target.value) })} /></label>
            <div className="space-y-1 text-sm"><label className="flex items-center gap-2"><input type="checkbox" checked={settings.redactionEnabled} onChange={(e) => setSettings({ ...settings, redactionEnabled: e.target.checked })} />Redact sensitive fields</label>
              <input className={field} placeholder="extra field names, comma separated" value={settings.extraKeys} onChange={(e) => setSettings({ ...settings, extraKeys: e.target.value })} /></div>
            <div className="sm:col-span-2"><Button disabled={saveSettings.isPending} onClick={() => saveSettings.mutate()}>{saveSettings.isPending ? 'Saving…' : 'Save settings'}</Button>
              {saveSettings.isError && <span role="alert" className="ml-3 text-sm text-red-600">{saveSettings.error.message}</span>}
              {saveSettings.isSuccess && <span role="status" className="ml-3 text-sm text-emerald-700 dark:text-emerald-400">Saved.</span>}</div>
          </div>
        )}

        {step === 10 && (
          <div className="space-y-2 text-sm">
            {preview.isPending && <Loading />}
            {preview.isError && <ErrorState error={preview.error} />}
            {preview.data && (
              <>
                <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">
                  <div><dt className="text-xs text-slate-500">Connector</dt><dd>{preview.data.connector}</dd></div>
                  <div><dt className="text-xs text-slate-500">Authentication</dt><dd>{preview.data.authMethod}</dd></div>
                  <div className="sm:col-span-2"><dt className="text-xs text-slate-500">Target</dt><dd className="font-mono text-xs">{JSON.stringify(preview.data.target)}</dd></div>
                  <div><dt className="text-xs text-slate-500">Credentials</dt><dd>{preview.data.credentials.map((c) => `${c.field}: ${c.set ? 'stored' : 'missing'}`).join(', ') || 'none'}</dd></div>
                  <div><dt className="text-xs text-slate-500">Resources / signals</dt><dd>{preview.data.resources.length} / {preview.data.signals.join(', ')}</dd></div>
                  <div><dt className="text-xs text-slate-500">Schedule</dt><dd>{preview.data.schedule}</dd></div>
                  <div><dt className="text-xs text-slate-500">Collection</dt><dd>{preview.data.collection}</dd></div>
                </dl>
                {preview.data.warnings.map((w) => <p key={w} role="note" className="rounded border border-amber-300 bg-amber-50 p-2 dark:border-amber-900 dark:bg-amber-950/40">{w}</p>)}
              </>
            )}
          </div>
        )}

        {step === 11 && (
          <div className="space-y-3 text-sm">
            {conn?.lifecycle === 'active' ? (
              <>
                <p role="status" className="font-medium text-emerald-700 dark:text-emerald-400">Monitoring started.</p>
                <p>{conn.collection.note}</p>
                <Button onClick={() => nav('/sources')}>Go to Data Sources</Button>
              </>
            ) : (
              <>
                <p>Starting enables scheduled health checks for this connection. It requires a passing test for the current settings.</p>
                <Button disabled={activate.isPending} onClick={() => activate.mutate()}>{activate.isPending ? 'Starting…' : 'Start monitoring'}</Button>
                {activate.isError && <p role="alert" className="text-sm text-red-600">{activate.error.message}</p>}
              </>
            )}
          </div>
        )}
      </Card>

      <div className="flex justify-between">
        <Button variant="ghost" disabled={step === 0} onClick={() => go(step - 1)}>Back</Button>
        {step < STEPS.length - 1 && <Button disabled={nextDisabled} onClick={() => go(step + 1)}>Next</Button>}
      </div>
    </div>
  );
}
