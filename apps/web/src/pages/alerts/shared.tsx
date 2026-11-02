import type { AlertRuleDto, ChannelDto, DeliveryDto, IncidentDetailDto, IncidentDto, SilenceDto } from '@nexus/contracts';
import { NavLink } from 'react-router-dom';
import { Badge } from '../../ui';
import { can, describeRule, duration, errorText, num, OPS } from './model';
export { can, describeRule, duration, errorText, num, OPS };

export type Rule = AlertRuleDto;
export type Channel = ChannelDto;
export type Silence = SilenceDto;
export type Incident = IncidentDto;
export type IncidentDetail = IncidentDetailDto;
export type Delivery = DeliveryDto;
export interface Page<T> { items: T[]; nextCursor: string | null }

export const field = 'rounded-md border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-slate-700 dark:bg-slate-900';
export const link = 'text-indigo-700 underline dark:text-indigo-300';

export const SEVERITY_TONE = { info: 'info', warning: 'warn', critical: 'danger' } as const;
export const SeverityBadge = ({ s }: { s: Rule['severity'] }) => <Badge tone={SEVERITY_TONE[s]}>{s}</Badge>;
export const IncidentStatusBadge = ({ s }: { s: Incident['status'] }) => <Badge tone={s === 'open' ? 'danger' : s === 'acknowledged' ? 'warn' : 'neutral'}>{s}</Badge>;

export function RuleStatusBadge({ rule }: { rule: Rule }) {
  if (!rule.enabled) return <Badge>disabled</Badge>;
  if (rule.health === 'error') return <Badge tone="warn">evaluation error</Badge>;
  const tone = rule.status === 'firing' ? 'danger' : rule.status === 'pending' ? 'warn' : rule.status === 'ok' ? 'info' : 'neutral';
  return <Badge tone={tone}>{rule.status}</Badge>;
}

/** The three alerting pages share one tab strip (real links, so every page is deep-linkable). */
export function AlertTabs() {
  const cls = ({ isActive }: { isActive: boolean }) => `rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-indigo-50 font-medium text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300' : 'text-slate-700 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800'}`;
  return (
    <nav aria-label="Alerting" className="flex flex-wrap gap-1" data-testid="alert-tabs">
      <NavLink to="/incidents" className={cls}>Incidents</NavLink>
      <NavLink to="/alerts" end className={cls}>Alert rules</NavLink>
      <NavLink to="/alerts/channels" className={cls}>Channels &amp; silences</NavLink>
    </nav>
  );
}

export const th = 'px-3 py-2';
/** `relative` matters: the visually hidden header text is absolutely positioned and would otherwise escape the scroll container and widen the page. */
export const Table = ({ label, testid, min = '40rem', children }: { label: string; testid: string; min?: string; children: React.ReactNode }) => (
  <div className="relative overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
    <table className="w-full text-left text-sm" style={{ minWidth: min }} aria-label={label} data-testid={testid}>{children}</table>
  </div>
);
export const THead = ({ cols }: { cols: (string | { sr: string })[] }) => (
  <thead className="border-b border-slate-200 text-xs uppercase text-slate-600 dark:border-slate-800 dark:text-slate-400">
    <tr>{cols.map((c, i) => <th key={i} scope="col" className={th}>{typeof c === 'string' ? c : <span className="sr-only">{c.sr}</span>}</th>)}</tr>
  </thead>
);

