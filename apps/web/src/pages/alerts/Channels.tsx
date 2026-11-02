import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../../api';
import { Badge, Button, Card, EmptyState, ErrorState, Loading } from '../../ui';
import { fmtTime } from '../sources/parts';
import { ProjectGate } from '../traces/shared';
import { AlertTabs, can, errorText, field, Table, THead, type Channel, type Page, type Rule, type Silence } from './shared';

export default function Channels() {
  const [sp] = useSearchParams();
  return <ProjectGate title="Channels and silences" urlProject={sp.get('p')}>{(project) => <Body project={project} />}</ProjectGate>;
}

type Project = NonNullable<ReturnType<typeof import('../../session').useSelection>['project']>;

function Body({ project }: { project: Project }) {
  const { manage } = can(project.role);
  return (
    <div className="space-y-4">
      <h1 className="text-xl font-semibold">Channels &amp; silences</h1>
      <AlertTabs />
      <p className="text-sm text-slate-600 dark:text-slate-400">Notifications are sent to <strong>webhooks</strong> only (signed JSON over HTTPS). E-mail, Slack, PagerDuty and other integrations are not available yet. A silence suppresses notifications for a time window; incidents are still recorded.</p>
      {!manage && <p className="text-sm text-slate-600 dark:text-slate-400" data-testid="channels-readonly">You have read-only access. Project admins manage channels and silences.</p>}
      <ChannelsCard project={project} manage={manage} />
      <SilencesCard project={project} manage={manage} />
    </div>
  );
}

function ChannelsCard({ project, manage }: { project: Project; manage: boolean }) {
  const qc = useQueryClient();
  const base = `/api/v1/projects/${project.id}/alert-channels`;
  const q = useQuery({ queryKey: ['alert-channels', project.id], queryFn: () => api<Page<Channel>>('GET', `${base}?limit=100`) });
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [rate, setRate] = useState(20);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['alert-channels', project.id] });

  const create = useMutation({
    mutationFn: () => api<Channel>('POST', base, { type: 'webhook', name: name.trim(), url: url.trim(), signingSecret: secret, rateLimitPerMinute: rate }),
    // The secret lives only in this component's state until the request is sent; it is cleared at once and never stored or shown again.
    onSuccess: (c) => { setName(''); setUrl(''); setSecret(''); setMsg({ ok: true, text: `Channel “${c.name}” created.` }); refresh(); },
    onError: (e) => setMsg({ ok: false, text: errorText(e) }),
  });
  const test = useMutation({
    mutationFn: (c: Channel) => api<{ ok: boolean; message: string }>('POST', `${base}/${c.id}/test`),
    onSuccess: (r, c) => { setMsg({ ok: r.ok, text: `Test to “${c.name}”: ${r.ok ? 'delivered' : 'failed'} — ${r.message}` }); refresh(); },
    onError: (e) => setMsg({ ok: false, text: errorText(e) }),
  });
  const toggle = useMutation({ mutationFn: (c: Channel) => api<Channel>('PATCH', `${base}/${c.id}`, { enabled: !c.enabled }), onSuccess: refresh, onError: (e) => setMsg({ ok: false, text: errorText(e) }) });
  const remove = useMutation({ mutationFn: (c: Channel) => api('DELETE', `${base}/${c.id}`), onSuccess: () => { setMsg({ ok: true, text: 'Channel deleted. Its stored URL and secret were destroyed.' }); refresh(); }, onError: (e) => setMsg({ ok: false, text: errorText(e) }) });

  return (
    <Card title="Notification channels">
      <div className="space-y-4">
        {msg && <p role={msg.ok ? 'status' : 'alert'} className={`rounded-md px-3 py-2 text-sm ${msg.ok ? 'bg-slate-100 dark:bg-slate-800' : 'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300'}`} data-testid="channel-message">{msg.text}</p>}
        {q.isPending && <Loading />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data?.items.length === 0 && <EmptyState title="No channels yet">Incidents are recorded without one, but nobody is notified.</EmptyState>}
        {!!q.data?.items.length && (
          <Table label="Notification channels" testid="channels-table" min="44rem">
            <THead cols={['Name', 'Target', 'State', 'Limit', 'Last test', { sr: 'Actions' }]} />
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {q.data.items.map((c) => (
                <tr key={c.id} data-testid={`channel-row-${c.name}`}>
                  <td className="px-3 py-2 font-medium">{c.name}</td>
                  <td className="px-3 py-2 font-mono text-xs">{c.urlDisplay}<span className="block font-sans text-slate-600 dark:text-slate-400">path and signing secret are write-only</span></td>
                  <td className="px-3 py-2">{c.enabled ? <Badge tone="info">enabled</Badge> : <Badge>disabled</Badge>}</td>
                  <td className="px-3 py-2">{c.rateLimitPerMinute}/min</td>
                  <td className="px-3 py-2 text-xs" data-testid="channel-last-test">{c.lastTest ? <>{c.lastTest.ok ? 'ok' : 'failed'} · {fmtTime(c.lastTest.at)}<span className="block text-slate-600 dark:text-slate-400">{c.lastTest.message}</span></> : 'never'}</td>
                  <td className="px-3 py-2 text-right">{manage && (
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button variant="ghost" disabled={test.isPending} onClick={() => test.mutate(c)} data-testid="channel-test">{test.isPending && test.variables?.id === c.id ? 'Sending…' : 'Send test'}</Button>
                      <Button variant="ghost" onClick={() => toggle.mutate(c)}>{c.enabled ? 'Disable' : 'Enable'}</Button>
                      <Button variant="danger" onClick={() => { if (confirm(`Delete channel "${c.name}"? Rules stop notifying it.`)) remove.mutate(c); }}>Delete</Button>
                    </div>)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {manage && (
          <form className="grid gap-3 md:grid-cols-4" onSubmit={(e) => { e.preventDefault(); setMsg(null); create.mutate(); }} aria-label="New webhook channel" data-testid="channel-form">
            <label className="text-sm">Name<input required className={`${field} mt-0.5 block w-full`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} data-testid="channel-name" /></label>
            <label className="text-sm md:col-span-2">Webhook URL (https)<input required type="url" className={`${field} mt-0.5 block w-full font-mono`} value={url} maxLength={2048} onChange={(e) => setUrl(e.target.value)} placeholder="https://hooks.example.com/nexus" autoComplete="off" data-testid="channel-url" /></label>
            <label className="text-sm">Notifications per minute (max)<input type="number" min={1} max={60} className={`${field} mt-0.5 block w-full`} value={rate} onChange={(e) => setRate(Number(e.target.value))} /></label>
            <label className="text-sm md:col-span-2">Signing secret (16+ characters, write-only)<input required type="password" minLength={16} maxLength={256} className={`${field} mt-0.5 block w-full`} value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" data-testid="channel-secret" /></label>
            <div className="flex items-end"><Button type="submit" disabled={create.isPending || !name.trim() || !url.trim() || secret.length < 16} data-testid="channel-create">{create.isPending ? 'Creating…' : 'Add webhook channel'}</Button></div>
            <p className="text-xs text-slate-600 md:col-span-4 dark:text-slate-400">Each delivery is a JSON POST with an <code>X-Nexus-Signature: t=…,v1=…</code> header (HMAC-SHA256 of <code>t.body</code> with this secret). The URL and secret are stored encrypted and are never shown again. Private, loopback and cloud-metadata addresses are refused; redirects are not followed.</p>
          </form>
        )}
      </div>
    </Card>
  );
}

const DURATIONS = [[1, '1 hour'], [4, '4 hours'], [24, '24 hours'], [168, '7 days']] as const;

function SilencesCard({ project, manage }: { project: Project; manage: boolean }) {
  const qc = useQueryClient();
  const base = `/api/v1/projects/${project.id}`;
  const q = useQuery({ queryKey: ['alert-silences', project.id], refetchInterval: 30_000, queryFn: () => api<Page<Silence>>('GET', `${base}/alert-silences?limit=100`) });
  const rules = useQuery({ queryKey: ['alert-rules-select', project.id], enabled: manage, queryFn: () => api<Page<Rule>>('GET', `${base}/alert-rules?limit=100`) });
  const [comment, setComment] = useState('');
  const [hours, setHours] = useState(1);
  const [ruleId, setRuleId] = useState('');
  const [severity, setSeverity] = useState('');
  const [error, setError] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['alert-silences', project.id] });
  const create = useMutation({
    mutationFn: () => {
      const now = Date.now();
      return api<Silence>('POST', `${base}/alert-silences`, {
        comment: comment.trim(), startsAt: new Date(now).toISOString(), endsAt: new Date(now + hours * 3_600_000).toISOString(),
        matchers: { ...(ruleId ? { ruleIds: [ruleId] } : {}), ...(severity ? { severities: [severity] } : {}) },
      });
    },
    onSuccess: () => { setComment(''); setError(null); refresh(); },
    onError: (e) => setError(errorText(e)),
  });
  const remove = useMutation({ mutationFn: (s: Silence) => api('DELETE', `${base}/alert-silences/${s.id}`), onSuccess: refresh, onError: (e) => setError(errorText(e)) });
  const ruleName = (id: string) => rules.data?.items.find((r) => r.id === id)?.name ?? id.slice(0, 8);
  const scope = (s: Silence) => [s.matchers.ruleIds?.length ? `rules: ${s.matchers.ruleIds.map(ruleName).join(', ')}` : '', s.matchers.severities?.length ? `severity: ${s.matchers.severities.join(', ')}` : '', s.matchers.environmentIds?.length ? `${s.matchers.environmentIds.length} environment(s)` : ''].filter(Boolean).join(' · ') || 'the whole project';

  return (
    <Card title="Silences and maintenance windows">
      <div className="space-y-4">
        {q.isPending && <Loading />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data?.items.length === 0 && <p className="text-sm text-slate-600 dark:text-slate-400" data-testid="no-silences">No silences.</p>}
        {!!q.data?.items.length && (
          <Table label="Silences" testid="silences-table" min="40rem">
            <THead cols={['Reason', 'Applies to', 'From (UTC)', 'Until (UTC)', 'State', { sr: 'Actions' }]} />
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {q.data.items.map((s) => (
                <tr key={s.id} data-testid={`silence-row-${s.comment}`}>
                  <td className="px-3 py-2">{s.comment}</td><td className="px-3 py-2 text-xs">{scope(s)}</td>
                  <td className="px-3 py-2 font-mono text-xs">{fmtTime(s.startsAt)}</td><td className="px-3 py-2 font-mono text-xs">{fmtTime(s.endsAt)}</td>
                  <td className="px-3 py-2"><Badge tone={s.state === 'active' ? 'warn' : 'neutral'}>{s.state}</Badge></td>
                  <td className="px-3 py-2 text-right">{manage && <Button variant="ghost" onClick={() => remove.mutate(s)}>{s.state === 'expired' ? 'Remove' : 'End now'}</Button>}</td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
        {manage && (
          <form className="grid gap-3 md:grid-cols-5" onSubmit={(e) => { e.preventDefault(); create.mutate(); }} aria-label="New silence" data-testid="silence-form">
            <label className="text-sm md:col-span-2">Reason<input required className={`${field} mt-0.5 block w-full`} value={comment} maxLength={500} onChange={(e) => setComment(e.target.value)} data-testid="silence-comment" /></label>
            <label className="text-sm">Starting now, for<select className={`${field} mt-0.5 block w-full`} value={hours} onChange={(e) => setHours(Number(e.target.value))}>{DURATIONS.map(([h, l]) => <option key={h} value={h}>{l}</option>)}</select></label>
            <label className="text-sm">Only rule<select className={`${field} mt-0.5 block w-full`} value={ruleId} onChange={(e) => setRuleId(e.target.value)}><option value="">All rules</option>{rules.data?.items.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
            <label className="text-sm">Only severity<select className={`${field} mt-0.5 block w-full`} value={severity} onChange={(e) => setSeverity(e.target.value)}><option value="">Any</option><option value="critical">critical</option><option value="warning">warning</option><option value="info">info</option></select></label>
            <div className="md:col-span-5"><Button type="submit" disabled={create.isPending || !comment.trim()} data-testid="silence-create">{create.isPending ? 'Creating…' : 'Create silence'}</Button></div>
            {error && <p role="alert" className="text-sm text-red-700 md:col-span-5 dark:text-red-400">{error}</p>}
          </form>
        )}
      </div>
    </Card>
  );
}
