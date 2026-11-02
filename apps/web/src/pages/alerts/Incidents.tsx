import { useInfiniteQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { Button, EmptyState, ErrorState, Loading } from '../../ui';
import { fmtTime } from '../sources/parts';
import { ProjectGate } from '../traces/shared';
import { AlertTabs, field, IncidentStatusBadge, num, OPS, SeverityBadge, Table, THead, duration, type Incident, type Page } from './shared';

const STATUSES = [['active', 'Active (open and acknowledged)'], ['open', 'Open'], ['acknowledged', 'Acknowledged'], ['resolved', 'Resolved'], ['all', 'All']] as const;

export default function Incidents() {
  const [sp, setSp] = useSearchParams();
  return <ProjectGate title="Incidents" urlProject={sp.get('p')}>{(project) => <Body projectId={project.id} envs={project.environments} sp={sp} setSp={setSp} />}</ProjectGate>;
}

function Body({ projectId, envs, sp, setSp }: { projectId: string; envs: { id: string; name: string }[]; sp: URLSearchParams; setSp: ReturnType<typeof useSearchParams>[1] }) {
  const status = sp.get('status') ?? 'active';
  const severity = sp.get('severity') ?? '';
  const environmentId = sp.get('environmentId') ?? '';
  const ruleId = sp.get('ruleId') ?? '';
  const set = (k: string, v: string) => { const n = new URLSearchParams(sp); n.set('p', projectId); if (v) n.set(k, v); else n.delete(k); setSp(n, { replace: true }); };
  const envName = (id: string) => envs.find((e) => e.id === id)?.name ?? id.slice(0, 8);

  const q = useInfiniteQuery({
    queryKey: ['incidents', projectId, status, severity, environmentId, ruleId], refetchInterval: 10_000, initialPageParam: '',
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: '25' });
      if (status !== 'all') p.set('status', status);
      if (severity) p.set('severity', severity);
      if (environmentId) p.set('environmentId', environmentId);
      if (ruleId) p.set('ruleId', ruleId);
      if (pageParam) p.set('cursor', pageParam);
      return api<Page<Incident>>('GET', `/api/v1/projects/${projectId}/incidents?${p}`);
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Incidents</h1>
      <AlertTabs />
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-xs">Status<select className={`${field} mt-0.5 block`} value={status} onChange={(e) => set('status', e.target.value)} data-testid="incident-status-filter">
          {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        <label className="text-xs">Severity<select className={`${field} mt-0.5 block`} value={severity} onChange={(e) => set('severity', e.target.value)}>
          <option value="">Any</option><option value="critical">critical</option><option value="warning">warning</option><option value="info">info</option></select></label>
        <label className="text-xs">Environment<select className={`${field} mt-0.5 block`} value={environmentId} onChange={(e) => set('environmentId', e.target.value)}>
          <option value="">All</option>{envs.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
        {ruleId && <Button variant="ghost" onClick={() => set('ruleId', '')}>Clear rule filter</Button>}
      </div>

      {q.isPending && <Loading label="Loading incidents…" />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && items.length === 0 && (
        <EmptyState title={status === 'active' ? 'No active incidents' : 'No incidents match'} action={<Link className="text-indigo-700 underline dark:text-indigo-300" to={`/alerts?p=${projectId}`}>View alert rules</Link>}>
          Incidents open when an alert rule fires. “No incidents” means no rule has fired, not that everything is monitored: check that you have rules and that the worker is running.
        </EmptyState>
      )}
      {items.length > 0 && (
        <Table label="Incidents" testid="incidents-table" min="52rem">
          <THead cols={['Incident', 'Severity', 'Status', 'Environment', 'Condition', 'Value', 'Opened (UTC)']} />
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {items.map((i) => (
              <tr key={i.id} data-testid={`incident-row-${i.ruleName}`}>
                <td className="px-3 py-2 font-medium"><Link className="text-indigo-700 underline dark:text-indigo-300" to={`/incidents/${i.id}?p=${projectId}`}>{i.title}</Link></td>
                <td className="px-3 py-2"><SeverityBadge s={i.severity} /></td>
                <td className="px-3 py-2" data-testid="incident-status"><IncidentStatusBadge s={i.status} /></td>
                <td className="px-3 py-2">{envName(i.environmentId)}</td>
                <td className="px-3 py-2 font-mono text-xs">{OPS[i.condition.op]} {i.condition.threshold} / {duration(i.condition.windowSeconds)}</td>
                <td className="px-3 py-2 tabular-nums">{num(i.lastValue)}</td>
                <td className="px-3 py-2 font-mono text-xs">{fmtTime(i.openedAt)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {q.hasNextPage && <Button variant="ghost" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>{q.isFetchingNextPage ? 'Loading…' : 'Load more incidents'}</Button>}
    </div>
  );
}
