import type { AlertRuleCreate } from '@nexus/contracts';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { Badge, Button, Card, EmptyState, ErrorState, Loading } from '../../ui';
import { fmtTime } from '../sources/parts';
import { ProjectGate } from '../traces/shared';
import { RuleForm } from './RuleForm';
import { AlertTabs, can, errorText, describeRule, num, RuleStatusBadge, SeverityBadge, Table, THead, type Channel, type Page, type Rule } from './shared';

/** Alert rules: list, create, edit, enable/disable, delete. Evaluation happens in the worker; this page only configures and displays. */
export default function Alerts() {
  const [sp] = useSearchParams();
  return <ProjectGate title="Alert rules" urlProject={sp.get('p')}>{(project) => <Body project={project} />}</ProjectGate>;
}

function Body({ project }: { project: NonNullable<ReturnType<typeof import('../../session').useSelection>['project']> }) {
  const qc = useQueryClient();
  const base = `/api/v1/projects/${project.id}`;
  const { manage } = can(project.role);
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const envName = (id: string) => project.environments.find((e) => e.id === id)?.name ?? id.slice(0, 8);

  const rules = useInfiniteQuery({
    queryKey: ['alert-rules', project.id], refetchInterval: 15_000, initialPageParam: '',
    queryFn: ({ pageParam }) => api<Page<Rule>>('GET', `${base}/alert-rules?limit=50${pageParam ? `&cursor=${pageParam}` : ''}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const channels = useQuery({ queryKey: ['alert-channels', project.id], queryFn: () => api<Page<Channel>>('GET', `${base}/alert-channels?limit=100`) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['alert-rules', project.id] });

  const save = useMutation({
    mutationFn: (body: AlertRuleCreate) => (editing && editing !== 'new'
      ? api<Rule>('PATCH', `${base}/alert-rules/${editing.id}`, body)
      : api<Rule>('POST', `${base}/alert-rules`, body)),
    onSuccess: (r) => { setEditing(null); setFormError(null); setNotice(`Rule “${r.name}” saved.`); refresh(); },
    onError: (e) => setFormError(errorText(e)),
  });
  const toggle = useMutation({
    mutationFn: (r: Rule) => api<Rule>('PATCH', `${base}/alert-rules/${r.id}`, { enabled: !r.enabled }),
    onSuccess: (r) => { setNotice(`Rule “${r.name}” ${r.enabled ? 'enabled' : 'disabled'}.`); refresh(); },
    onError: (e) => setNotice(`Could not change the rule: ${e.message}`),
  });
  const remove = useMutation({
    mutationFn: (r: Rule) => api('DELETE', `${base}/alert-rules/${r.id}`),
    onSuccess: () => { setNotice('Rule deleted. Its live incidents were closed.'); refresh(); },
    onError: (e) => setNotice(`Could not delete the rule: ${e.message}`),
  });

  const all = rules.data?.pages.flatMap((p) => p.items) ?? [];
  // an edit of an existing rule sends only what the form holds; defaults the server applies to create are explicit there
  const submit = (body: AlertRuleCreate) => { setFormError(null); save.mutate(editing && editing !== 'new' ? { ...body, environmentId: undefined as never } : body); };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">Alert rules</h1>
        {manage && !editing && <Button onClick={() => { setEditing('new'); setFormError(null); }} data-testid="new-rule">New alert rule</Button>}
      </div>
      <AlertTabs />
      <p className="text-sm text-slate-600 dark:text-slate-400">A rule evaluates a metric or a log count over a window at a fixed interval. When the condition holds long enough an incident opens; it resolves after the condition has stayed clear. Rules are evaluated by the worker, so no evaluation happens if the worker is not running.</p>
      {!manage && <p className="text-sm text-slate-600 dark:text-slate-400" data-testid="rules-readonly">You have read-only access to alert rules. Project admins create and change them.</p>}
      {notice && <p role="status" className="rounded-md bg-slate-100 px-3 py-2 text-sm dark:bg-slate-800" data-testid="rules-notice">{notice}</p>}

      {editing && (
        <Card title={editing === 'new' ? 'New alert rule' : `Edit “${editing.name}”`}>
          <RuleForm key={editing === 'new' ? 'new' : editing.id} projectId={project.id} rule={editing === 'new' ? null : editing} envs={project.environments} channels={channels.data?.items ?? []}
            busy={save.isPending} error={formError} onSubmit={submit} onCancel={() => { setEditing(null); setFormError(null); }} />
        </Card>
      )}

      {rules.isPending && <Loading label="Loading rules…" />}
      {rules.isError && <ErrorState error={rules.error} onRetry={() => void rules.refetch()} />}
      {rules.data && all.length === 0 && (
        <EmptyState title="No alert rules yet" action={manage ? <Button onClick={() => setEditing('new')}>Create the first rule</Button> : undefined}>
          Rules turn telemetry into incidents. Create one for a metric threshold (for example the error rate) or a log count (for example 5xx responses in five minutes).
        </EmptyState>
      )}
      {all.length > 0 && (
        <Table label="Alert rules" testid="rules-table" min="58rem">
          <THead cols={['Rule', 'Environment', 'Condition', 'Severity', 'State', 'Last value', 'Evaluated (UTC)', { sr: 'Actions' }]} />
          <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
            {all.map((r) => (
              <tr key={r.id} data-testid={`rule-row-${r.name}`}>
                <td className="px-3 py-2 font-medium">{r.name}{r.description && <span className="block text-xs font-normal text-slate-600 dark:text-slate-400">{r.description}</span>}</td>
                <td className="px-3 py-2">{envName(r.environmentId)}</td>
                <td className="px-3 py-2 font-mono text-xs">{describeRule(r)}</td>
                <td className="px-3 py-2"><SeverityBadge s={r.severity} /></td>
                <td className="px-3 py-2" data-testid="rule-state">
                  <RuleStatusBadge rule={r} />
                  {r.groups.length > 1 && <span className="ml-1 text-xs text-slate-600 dark:text-slate-400">{r.groups.filter((g) => g.status === 'firing').length}/{r.groups.length} groups firing</span>}
                  {r.lastError && <span className="block text-xs text-amber-800 dark:text-amber-300">{r.lastError.message}</span>}
                  {r.noDataSince && <span className="block text-xs text-slate-600 dark:text-slate-400">no data since {fmtTime(r.noDataSince)}</span>}
                </td>
                <td className="px-3 py-2 tabular-nums">{num(r.lastValue)}</td>
                <td className="px-3 py-2 font-mono text-xs" data-testid="rule-evaluated">{fmtTime(r.lastEvaluatedAt)}
                  {r.missedPolicy === 'replay' && <span className="block font-sans text-slate-600 dark:text-slate-400">replays missed checks (up to {r.maxReplayEvaluations})</span>}
                  {r.missedEvaluations.total > 0 && (
                    <span className="block font-sans text-slate-600 dark:text-slate-400" data-testid="rule-missed">
                      {r.missedEvaluations.total} missed ({r.missedEvaluations.replayed} replayed, {r.missedEvaluations.skipped} skipped){r.missedEvaluations.lastAt ? `, last ${fmtTime(r.missedEvaluations.lastAt)}` : ''}
                    </span>)}
                </td>
                <td className="px-3 py-2 text-right">
                  <div className="flex flex-wrap justify-end gap-1">
                    {r.status === 'firing' && <Link className="rounded-md border border-slate-300 px-2 py-1 text-sm dark:border-slate-700" to={`/incidents?p=${project.id}&ruleId=${r.id}&status=active`}>Incidents</Link>}
                    {manage && <>
                      <Button variant="ghost" disabled={toggle.isPending} onClick={() => toggle.mutate(r)} data-testid="rule-toggle">{r.enabled ? 'Disable' : 'Enable'}</Button>
                      <Button variant="ghost" onClick={() => { setEditing(r); setFormError(null); window.scrollTo({ top: 0 }); }} data-testid="rule-edit">Edit</Button>
                      <Button variant="danger" disabled={remove.isPending} onClick={() => { if (confirm(`Delete rule "${r.name}"? Its live incidents will be closed.`)) remove.mutate(r); }} data-testid="rule-delete">Delete</Button>
                    </>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {rules.hasNextPage && <Button variant="ghost" disabled={rules.isFetchingNextPage} onClick={() => void rules.fetchNextPage()}>{rules.isFetchingNextPage ? 'Loading…' : 'Load more rules'}</Button>}
      <p className="text-xs text-slate-600 dark:text-slate-400"><Badge>limits</Badge> up to 100 rules per project; evaluation interval 15 s – 1 h; window 1 min – 24 h. See <code>docs/alerting.md</code>.</p>
    </div>
  );
}
