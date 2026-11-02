import type { ConnectionDto, ConnectionState, ConnectorDescriptorDto } from '@nexus/contracts';
import { useState, type ReactNode } from 'react';
import type { z } from 'zod';
import type { TestReportDto } from '@nexus/contracts';
import { api } from '../../api';
import { Badge } from '../../ui';
import { parseMongoUri } from './mongo-uri';

export type Report = z.infer<typeof TestReportDto>;

const STATE_LABEL: Record<ConnectionState, string> = {
  pending: 'Pending', connecting: 'Connecting', healthy: 'Healthy', degraded: 'Degraded', permission_denied: 'Permission denied',
  authentication_expired: 'Authentication expired', unreachable: 'Unreachable', misconfigured: 'Misconfigured', disconnected: 'Disconnected',
};
const STATE_TONE: Record<ConnectionState, 'neutral' | 'danger' | 'info' | 'warn'> = {
  pending: 'neutral', connecting: 'info', healthy: 'info', degraded: 'warn', permission_denied: 'danger',
  authentication_expired: 'danger', unreachable: 'danger', misconfigured: 'warn', disconnected: 'neutral',
};

/** Colour is never the only signal: the label always carries the state. */
export function StateBadge({ state, stale }: { state: ConnectionState; stale?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1" data-testid="connection-state" data-state={state}>
      <Badge tone={state === 'healthy' ? 'info' : STATE_TONE[state]}>{state === 'healthy' ? '✓ ' : state === 'disconnected' || state === 'pending' ? '' : '! '}{STATE_LABEL[state]}</Badge>
      {stale && <Badge tone="warn">Stale — no recent check</Badge>}
    </span>
  );
}

export const fmtTime = (iso: string | null | undefined) => (iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—');

export function StepList({ steps }: { steps: Report['steps'] }) {
  const icon = { pass: '✓', fail: '✗', warn: '!', skipped: '–' } as Record<string, string>;
  const tone = { pass: 'text-emerald-600 dark:text-emerald-400', fail: 'text-red-600 dark:text-red-400', warn: 'text-amber-600 dark:text-amber-400', skipped: 'text-slate-400' } as Record<string, string>;
  return (
    <ol className="space-y-1.5 text-sm">
      {steps.map((s) => (
        <li key={s.id} className="flex gap-2">
          <span aria-label={s.status} className={`w-4 shrink-0 font-bold ${tone[s.status] ?? ''}`}>{icon[s.status] ?? '?'}</span>
          <span>
            <span className="font-medium">{s.label}</span>
            {s.detail && <span className="text-slate-600 dark:text-slate-400"> — {s.detail}</span>}
            {s.remediation && s.status !== 'pass' && <span className="block text-xs text-slate-500">How to fix: {s.remediation}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function CapabilityList({ caps }: { caps: ConnectionDto['capabilities'] }) {
  if (caps.length === 0) return <p className="text-sm text-slate-500">No capabilities detected yet — run a connection test.</p>;
  return (
    <ul className="grid gap-1 text-sm sm:grid-cols-2">
      {caps.map((c) => (
        <li key={c.id} className="flex items-start gap-2">
          <span aria-label={c.available ? 'available' : 'unavailable'} className={c.available ? 'text-emerald-600' : 'text-slate-400'}>{c.available ? '✓' : '✗'}</span>
          <span>{c.label}{c.signal && <span className="text-xs text-slate-500"> ({c.signal})</span>}{c.reason && <span className="block text-xs text-slate-500">{c.reason}</span>}</span>
        </li>
      ))}
    </ul>
  );
}

export function SignalSummary({ signals }: { signals: ConnectionDto['signals'] | ConnectorDescriptorDto['signals'] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {signals.map((s) => (
        <Badge key={s.signal} tone={s.availability === 'supported' ? 'info' : 'neutral'}>{s.signal}: {s.availability.replace('_', ' ')}</Badge>
      ))}
    </span>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return <div className="space-y-1"><div className="text-sm font-medium">{label}</div>{children}</div>;
}

// ---------------------------------------------------------------- per-connector configuration forms

export interface ConfigDraft { [key: string]: string | boolean }

/** Non-secret settings -> the JSON the connector's server-side schema validates. */
export function buildConfig(type: string, authMethod: string, d: ConfigDraft): Record<string, unknown> {
  const num = (v: unknown, dflt: number) => (v === '' || v === undefined ? dflt : Number(v));
  if (type === 'http-health') {
    return {
      url: String(d.url ?? ''), method: String(d.method ?? 'GET'),
      expectedStatuses: String(d.expectedStatuses ?? '200,204').split(',').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n)),
      timeoutMs: num(d.timeoutMs, 10_000),
      ...(authMethod === 'header' && d.headerName ? { headerName: String(d.headerName) } : {}),
    };
  }
  if (type === 'mongodb') {
    const hosts = String(d.hosts ?? '').split(/\r?\n|,/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const i = l.lastIndexOf(':');
      return i > 0 && /^\d+$/.test(l.slice(i + 1)) ? { host: l.slice(0, i), port: Number(l.slice(i + 1)) } : { host: l, port: 27017 };
    });
    return { hosts, authSource: String(d.authSource || 'admin'), tls: d.tls !== false, ...(authMethod === 'scram' && d.username ? { username: String(d.username) } : {}) };
  }
  if (type === 'redis') {
    return { host: String(d.host ?? ''), port: num(d.port, 6379), tls: d.tls !== false, ...(d.username ? { username: String(d.username) } : {}) };
  }
  return {};
}

const inputCls = 'w-full rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900';

/**
 * "Paste a connection string": fills the host list, user, auth database and TLS from what Atlas / a DBA gave you. The password
 * goes straight to the write-only credential field. mongodb+srv:// is expanded by the server (DNS only; it receives the host
 * name, never the user or password). The pasted text is cleared immediately and never stored.
 */
function MongoPaste({ projectId, authMethod, draft, onChange, onSecret }: { projectId: string | null; authMethod: string; draft: ConfigDraft; onChange: (d: ConfigDraft) => void; onSecret?: (name: string, value: string) => void }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const fill = async () => {
    const parsed = parseMongoUri(text);
    if (!parsed.ok) { setMsg({ ok: false, text: parsed.error }); return; }
    const u = parsed.value;
    setBusy(true); setMsg(null);
    try {
      let hosts = u.hosts, authSource = u.authSource, note = '';
      if (u.srvHost) {
        if (!projectId) throw new Error('Choose a project first (step 2), then paste the string.');
        const r = await api<{ hosts: { host: string; port: number }[]; authSource: string | null; replicaSet: string | null; truncated: boolean }>('POST', `/api/v1/projects/${projectId}/connectors/mongodb/resolve-srv`, { host: u.srvHost });
        hosts = r.hosts; authSource ??= r.authSource;
        note = ` ${r.hosts.length} member${r.hosts.length === 1 ? '' : 's'} found by DNS.${r.truncated ? ' More than 7 exist; only the first 7 are used.' : ''}`;
      }
      onChange({ ...draft, hosts: hosts.map((h) => `${h.host}:${h.port}`).join('\n'), authSource: authSource ?? String(draft.authSource || 'admin'), ...(u.tls !== null ? { tls: u.tls } : {}), ...(u.username ? { username: u.username } : {}) });
      const parts = [`Form filled.${note}`];
      if (u.password) { onSecret?.('password', u.password); parts.push(authMethod === 'scram' ? 'The password is in the Credentials box below.' : 'This string has a password, but the "No authentication" method is selected: go back and choose "Username + password".'); }
      if (u.ignored.length) parts.push(`Ignored (not needed for monitoring): ${u.ignored.join(', ')}.`);
      setMsg({ ok: true, text: parts.join(' ') });
      setText('');
    } catch (e) { setMsg({ ok: false, text: e instanceof Error ? e.message : 'Could not use that connection string.' }); } finally { setBusy(false); }
  };
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 p-3 sm:col-span-2 dark:border-slate-800">
      <label className="block space-y-1 text-sm"><span className="font-medium">Connection string (optional shortcut)</span>
        <input type="password" autoComplete="off" spellCheck={false} data-testid="mongo-uri" className={inputCls} value={text} onChange={(e) => setText(e.target.value)} placeholder="mongodb+srv://user:password@cluster0.abcde.mongodb.net/" />
        <span className="block text-xs text-slate-500">Paste what Atlas gave you ("Connect" → "Drivers"). It is read in your browser and cleared right after; only the cluster's DNS name is sent to the server.</span></label>
      <button type="button" data-testid="mongo-uri-fill" disabled={busy || !text.trim()} onClick={() => void fill()} className="rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium disabled:opacity-50 dark:border-slate-700">{busy ? 'Looking up…' : 'Fill the form from it'}</button>
      {msg && <p role={msg.ok ? 'status' : 'alert'} data-testid="mongo-uri-msg" className={`text-sm ${msg.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-red-700 dark:text-red-400'}`}>{msg.text}</p>}
    </div>
  );
}

export function ConfigForm({ type, authMethod, draft, onChange, projectId = null, onSecret }: { type: string; authMethod: string; draft: ConfigDraft; onChange: (d: ConfigDraft) => void; projectId?: string | null; onSecret?: (name: string, value: string) => void }) {
  const set = (k: string, v: string | boolean) => onChange({ ...draft, [k]: v });
  const text = (k: string, label: string, ph = '', hint?: string) => (
    <label className="block space-y-1 text-sm"><span className="font-medium">{label}</span>
      <input className={inputCls} value={String(draft[k] ?? '')} placeholder={ph} onChange={(e) => set(k, e.target.value)} autoComplete="off" />
      {hint && <span className="block text-xs text-slate-500">{hint}</span>}
    </label>
  );
  const check = (k: string, label: string, dflt = true) => (
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft[k] === undefined ? dflt : Boolean(draft[k])} onChange={(e) => set(k, e.target.checked)} />{label}</label>
  );
  if (type === 'http-health') {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">{text('url', 'Health endpoint URL', 'https://api.example.com/healthz', 'Query strings can carry secrets: put credentials in the credential fields instead.')}</div>
        <label className="block space-y-1 text-sm"><span className="font-medium">Method</span>
          <select className={inputCls} value={String(draft.method ?? 'GET')} onChange={(e) => set('method', e.target.value)}><option>GET</option><option>HEAD</option></select></label>
        {text('expectedStatuses', 'Expected status codes', '200,204')}
        {text('timeoutMs', 'Timeout (ms)', '10000')}
        {authMethod === 'header' && text('headerName', 'Header name', 'X-Health-Key')}
      </div>
    );
  }
  if (type === 'mongodb') {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        <MongoPaste projectId={projectId} authMethod={authMethod} draft={draft} onChange={onChange} {...(onSecret ? { onSecret } : {})} />
        <label className="block space-y-1 text-sm sm:col-span-2"><span className="font-medium">Hosts (one per line, host:port)</span>
          <textarea className={inputCls} rows={3} value={String(draft.hosts ?? '')} placeholder="mongo-1.example.com:27017" onChange={(e) => set('hosts', e.target.value)} />
          {String(draft.hosts ?? '').includes('://')
            ? <span role="alert" className="block text-xs text-red-700 dark:text-red-400">This looks like a connection string, not a host name. Paste it into the "Connection string" box above and choose "Fill the form from it".</span>
            : <span className="block text-xs text-slate-500">Each member is monitored individually; topology discovery is disabled on purpose.</span>}</label>
        {authMethod === 'scram' && text('username', 'Monitoring user', 'nexus_monitor')}
        {text('authSource', 'Auth database', 'admin')}
        <div className="sm:col-span-2">{check('tls', 'Use TLS (strongly recommended)')}</div>
      </div>
    );
  }
  if (type === 'redis') {
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        {text('host', 'Host', 'redis.example.com')}
        {text('port', 'Port', '6379')}
        {text('username', 'ACL user (optional)', 'nexus_monitor')}
        <div className="sm:col-span-2">{check('tls', 'Use TLS (strongly recommended)')}</div>
      </div>
    );
  }
  return <p className="text-sm text-slate-500">This connector has no configuration form.</p>;
}
