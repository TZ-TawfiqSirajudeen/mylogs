import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { Badge, Button, Card, ErrorState, Loading } from '../../ui';
import { fmtTime } from '../sources/parts';
import { ProjectGate } from '../traces/shared';
import { AlertTabs, can, duration, field, IncidentStatusBadge, link, num, OPS, SeverityBadge, Table, THead, type Delivery, type IncidentDetail } from './shared';

export default function IncidentDetailPage() {
  const [sp] = useSearchParams();
  const { incidentId = '' } = useParams();
  return <ProjectGate title="Incident" urlProject={sp.get('p')}>{(project) => <Body project={project} incidentId={incidentId} />}</ProjectGate>;
}

const EVENT_LABEL: Record<string, string> = {
  opened: 'Opened', notified: 'Notified', notification_failed: 'Notification failed', notification_suppressed: 'Notification not sent', acknowledged: 'Acknowledged',
  resolved: 'Resolved', auto_resolved: 'Resolved automatically', comment: 'Comment',
};

function Body({ project, incidentId }: { project: NonNullable<ReturnType<typeof import('../../session').useSelection>['project']>; incidentId: string }) {
  const qc = useQueryClient();
  const base = `/api/v1/projects/${project.id}/incidents/${incidentId}`;
  const { act } = can(project.role);
  const [comment, setComment] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const inc = useQuery({ queryKey: ['incident', project.id, incidentId], refetchInterval: 8_000, retry: false, queryFn: () => api<IncidentDetail>('GET', base) });
  const deliveries = useQuery({ queryKey: ['incident-deliveries', project.id, incidentId], refetchInterval: 8_000, queryFn: () => api<Delivery[]>('GET', `${base}/deliveries`) });
  const done = (d: IncidentDetail) => { qc.setQueryData(['incident', project.id, incidentId], d); setError(null); void qc.invalidateQueries({ queryKey: ['incidents', project.id] }); void qc.invalidateQueries({ queryKey: ['incident-deliveries', project.id, incidentId] }); };
  const fail = (e: Error) => setError(e.message);
  const ack = useMutation({ mutationFn: () => api<IncidentDetail>('POST', `${base}/acknowledge`, note.trim() ? { note: note.trim() } : {}), onSuccess: (d) => { done(d); setNote(''); }, onError: fail });
  const resolve = useMutation({ mutationFn: () => api<IncidentDetail>('POST', `${base}/resolve`, note.trim() ? { note: note.trim() } : {}), onSuccess: (d) => { done(d); setNote(''); }, onError: fail });
  const add = useMutation({ mutationFn: () => api<IncidentDetail>('POST', `${base}/comments`, { body: comment.trim() }), onSuccess: (d) => { done(d); setComment(''); }, onError: fail });

  if (inc.isPending) return <Loading label="Loading incident…" />;
  if (inc.isError) return <div className="space-y-3"><h1 className="text-xl font-semibold">Incident</h1><ErrorState error={inc.error} /><Link className={link} to={`/incidents?p=${project.id}`}>Back to incidents</Link></div>;
  const i = inc.data;
  const env = project.environments.find((e) => e.id === i.environmentId)?.name ?? i.environmentId.slice(0, 8);
  const busy = ack.isPending || resolve.isPending;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-semibold" data-testid="incident-title">{i.title}</h1>
        <SeverityBadge s={i.severity} /><span data-testid="incident-detail-status"><IncidentStatusBadge s={i.status} /></span>
      </div>
      <AlertTabs />

      <Card title="Summary">
        <dl className="grid gap-3 text-sm md:grid-cols-3">
          <div><dt className="text-xs text-slate-600 dark:text-slate-400">Environment</dt><dd>{env}</dd></div>
          <div><dt className="text-xs text-slate-600 dark:text-slate-400">Rule</dt><dd><Link className={link} to={`/alerts?p=${project.id}`}>{i.ruleName}</Link></dd></div>
          <div><dt className="text-xs text-slate-600 dark:text-slate-400">Condition</dt><dd className="font-mono text-xs">{OPS[i.condition.op]} {i.condition.threshold} over {duration(i.condition.windowSeconds)}</dd></div>
          <div><dt className="text-xs text-slate-600 dark:text-slate-400">Latest value</dt><dd className="tabular-nums">{num(i.lastValue)}</dd></div>
          <div><dt className="text-xs text-slate-600 dark:text-slate-400">Opened (UTC)</dt><dd className="font-mono text-xs">{fmtTime(i.openedAt)}</dd></div>
          <div><dt className="text-xs text-slate-600 dark:text-slate-400">{i.status === 'resolved' ? 'Resolved (UTC)' : 'Acknowledged (UTC)'}</dt>
            <dd className="font-mono text-xs">{fmtTime(i.status === 'resolved' ? i.resolvedAt : i.acknowledgedAt)}{i.resolvedBy && <span className="ml-1 font-sans">{i.resolvedBy.kind === 'auto' ? `(automatically: ${(i.resolvedBy.reason ?? '').replace(/_/g, ' ')})` : '(by a person)'}</span>}</dd></div>
          {Object.keys(i.groupLabels).length > 0 && <div className="md:col-span-3"><dt className="text-xs text-slate-600 dark:text-slate-400">Group</dt><dd>{Object.entries(i.groupLabels).map(([k, v]) => <Badge key={k}>{k}={v}</Badge>)}</dd></div>}
        </dl>
      </Card>

      {act && i.status !== 'resolved' && (
        <Card title="Actions">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-sm">Note (optional)<input className={`${field} mt-0.5 block w-72`} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} data-testid="incident-note" /></label>
            {i.status === 'open' && <Button disabled={busy} onClick={() => ack.mutate()} data-testid="incident-ack">{ack.isPending ? 'Acknowledging…' : 'Acknowledge'}</Button>}
            <Button variant="ghost" disabled={busy} onClick={() => resolve.mutate()} data-testid="incident-resolve">{resolve.isPending ? 'Resolving…' : 'Resolve'}</Button>
          </div>
          <p className="mt-2 text-xs text-slate-600 dark:text-slate-400">Resolving by hand closes this incident. If the rule is still breaching, it will be judged again at its next evaluation and may open a new incident.</p>
        </Card>
      )}
      {!act && <p className="text-sm text-slate-600 dark:text-slate-400" data-testid="incident-readonly">You have read-only access. Engineers and project admins can acknowledge, resolve and comment.</p>}
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400" data-testid="incident-error">{error}</p>}

      <Card title="Timeline">
        <ol className="space-y-3" data-testid="incident-timeline" aria-label="Incident timeline">
          {i.timeline.map((e) => (
            <li key={e.id} className="border-l-2 border-slate-300 pl-3 dark:border-slate-700" data-testid={`timeline-${e.type}`}>
              <div className="flex flex-wrap items-center gap-2 text-sm"><span className="font-medium">{EVENT_LABEL[e.type] ?? e.type}</span>
                {e.actorName && <span className="text-slate-600 dark:text-slate-400">by {e.actorName}</span>}
                <time dateTime={e.at} className="font-mono text-xs text-slate-600 dark:text-slate-400">{fmtTime(e.at)}</time></div>
              <p className={`text-sm ${e.type === 'comment' ? 'whitespace-pre-wrap' : ''}`}>{e.message}</p>
            </li>
          ))}
        </ol>
        {act && (
          <form className="mt-4 space-y-2" onSubmit={(ev) => { ev.preventDefault(); if (comment.trim()) add.mutate(); }}>
            <label className="block text-sm">Add a comment<textarea rows={2} maxLength={2000} className={`${field} mt-0.5 block w-full`} value={comment} onChange={(e) => setComment(e.target.value)} data-testid="incident-comment" /></label>
            <Button type="submit" variant="ghost" disabled={add.isPending || !comment.trim()} data-testid="incident-comment-submit">{add.isPending ? 'Posting…' : 'Post comment'}</Button>
          </form>
        )}
      </Card>

      <Card title="Notification delivery log">
        {deliveries.isPending && <Loading />}
        {deliveries.isError && <ErrorState error={deliveries.error} />}
        {deliveries.data?.length === 0 && <p className="text-sm text-slate-600 dark:text-slate-400" data-testid="no-deliveries">No notifications were queued for this incident (the rule has no channels, or they are disabled).</p>}
        {!!deliveries.data?.length && (
          <Table label="Notification deliveries" testid="deliveries-table" min="40rem">
            <THead cols={['Channel', 'Event', 'Status', 'Attempts', 'Created (UTC)', 'Detail']} />
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {deliveries.data.map((d) => (
                <tr key={d.id}>
                  <td className="px-3 py-2">{d.channelName}</td><td className="px-3 py-2">{d.event.replace('incident.', '')}</td>
                  <td className="px-3 py-2" data-testid="delivery-status"><Badge tone={d.status === 'delivered' ? 'info' : d.status === 'failed' ? 'danger' : d.status === 'pending' ? 'warn' : 'neutral'}>{d.status.replace('_', ' ')}</Badge></td>
                  <td className="px-3 py-2 tabular-nums">{d.attempts}</td><td className="px-3 py-2 font-mono text-xs">{fmtTime(d.createdAt)}</td>
                  <td className="px-3 py-2 text-xs">{d.lastError?.message ?? (d.httpStatus ? `HTTP ${d.httpStatus}` : '')}{d.status === 'pending' && d.nextAttemptAt ? ` — next attempt ${fmtTime(d.nextAttemptAt)}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
