import type { ConnectionDto, ConnectionState, ConnectorDescriptorDto } from '@nexus/contracts';
import type { ReactNode } from 'react';
import type { z } from 'zod';
import type { TestReportDto } from '@nexus/contracts';
import { Badge } from '../../ui';

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

export function ConfigForm({ type, authMethod, draft, onChange }: { type: string; authMethod: string; draft: ConfigDraft; onChange: (d: ConfigDraft) => void }) {
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
        <label className="block space-y-1 text-sm sm:col-span-2"><span className="font-medium">Hosts (one per line, host:port)</span>
          <textarea className={inputCls} rows={3} value={String(draft.hosts ?? '')} placeholder="mongo-1.example.com:27017" onChange={(e) => set('hosts', e.target.value)} />
          <span className="block text-xs text-slate-500">Each member is monitored individually; topology discovery is disabled on purpose.</span></label>
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
