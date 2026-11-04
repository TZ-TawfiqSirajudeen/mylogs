import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ALERT_LIMITS, EMAIL_LIMITS, type ChannelType, type SmtpSecurity } from '@nexus/contracts';
import { api } from '../../api';
import { Badge, Button, Card, EmptyState, ErrorState, Loading } from '../../ui';
import { fmtTime } from '../sources/parts';
import { ProjectGate } from '../traces/shared';
import { channelBody, defaultPort, draftReady, recipientsProblem, splitRecipients } from './channel-form';
import { MaintenanceCard } from './MaintenanceWindows';
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
      <MaintenanceCard project={project} manage={manage} />
    </div>
  );
}

const TYPE_LABEL = { webhook: 'Webhook', slack: 'Slack', email: 'E-mail' } as const;
const SECURITY_HELP = { starttls: 'STARTTLS (port 587, upgrade required)', tls: 'TLS (port 465, implicit)', none: 'None (development only)' } as const;

function ChannelsCard({ project, manage }: { project: Project; manage: boolean }) {
  const qc = useQueryClient();
  const base = `/api/v1/projects/${project.id}/alert-channels`;
  const q = useQuery({ queryKey: ['alert-channels', project.id], queryFn: () => api<Page<Channel>>('GET', `${base}?limit=100`) });
  const [type, setType] = useState<ChannelType>('webhook');
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [rate, setRate] = useState(20);
  const [host, setHost] = useState('');
  const [port, setPort] = useState(587);
  const [security, setSecurity] = useState<SmtpSecurity>('starttls');
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [from, setFrom] = useState('');
  const [recipientsText, setRecipientsText] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['alert-channels', project.id] });
  const draft = { type, name, url, secret, rate, host, port, security, smtpUser, smtpPass, from, recipientsText };
  const recipients = splitRecipients(recipientsText);
  const recipientsError = recipientsProblem(recipients);
  const credentialsOk = (smtpUser === '') === (smtpPass === '');
  const ready = draftReady(draft, ALERT_LIMITS.minSecretChars);

  const create = useMutation({
    mutationFn: () => api<Channel>('POST', base, channelBody(draft)),
    // Secrets (signing secret, Slack URL, SMTP password) live only in this component's state until the request is sent; they are cleared at once and never stored or shown again.
    onSuccess: (c) => { setName(''); setUrl(''); setSecret(''); setSmtpUser(''); setSmtpPass(''); setRecipientsText(''); setMsg({ ok: true, text: `Channel “${c.name}” created.` }); refresh(); },
    onError: (e) => setMsg({ ok: false, text: errorText(e) }),
  });
  const test = useMutation({
    mutationFn: (c: Channel) => api<{ ok: boolean; message: string }>('POST', `${base}/${c.id}/test`),
    onSuccess: (r, c) => { setMsg({ ok: r.ok, text: `Test to “${c.name}”: ${r.ok ? 'delivered' : 'failed'} — ${r.message}` }); refresh(); },
    onError: (e) => setMsg({ ok: false, text: errorText(e) }),
  });
  const toggle = useMutation({ mutationFn: (c: Channel) => api<Channel>('PATCH', `${base}/${c.id}`, { enabled: !c.enabled }), onSuccess: refresh, onError: (e) => setMsg({ ok: false, text: errorText(e) }) });
  const remove = useMutation({ mutationFn: (c: Channel) => api('DELETE', `${base}/${c.id}`), onSuccess: () => { setMsg({ ok: true, text: 'Channel deleted. Its stored secrets were destroyed.' }); refresh(); }, onError: (e) => setMsg({ ok: false, text: errorText(e) }) });
  const pickSecurity = (s: SmtpSecurity) => { setSecurity(s); setPort(defaultPort(s)); };

  return (
    <Card title="Notification channels">
      <div className="space-y-4">
        {msg && <p role={msg.ok ? 'status' : 'alert'} className={`rounded-md px-3 py-2 text-sm ${msg.ok ? 'bg-slate-100 dark:bg-slate-800' : 'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300'}`} data-testid="channel-message">{msg.text}</p>}
        {q.isPending && <Loading />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data?.items.length === 0 && <EmptyState title="No channels yet">Incidents are recorded without one, but nobody is notified.</EmptyState>}
        {!!q.data?.items.length && (
          <Table label="Notification channels" testid="channels-table" min="44rem">
            <THead cols={['Name', 'Type', 'Target', 'State', 'Limit', 'Last test', { sr: 'Actions' }]} />
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {q.data.items.map((c) => (
                <tr key={c.id} data-testid={`channel-row-${c.name}`}>
                  <td className="px-3 py-2 font-medium">{c.name}</td>
                  <td className="px-3 py-2" data-testid="channel-type">{TYPE_LABEL[c.type]}</td>
                  <td className="px-3 py-2 font-mono text-xs">{c.urlDisplay}
                    {c.type === 'email'
                      ? <span className="block font-sans text-slate-600 dark:text-slate-400" data-testid="channel-recipients">from {c.from} to {(c.recipientsMasked ?? []).join(', ')} · {c.smtp?.security === 'none' ? 'unencrypted' : c.smtp?.security === 'tls' ? 'TLS' : 'STARTTLS'} · {c.hasSmtpCredentials ? 'credentials stored (write-only)' : 'no authentication'}</span>
                      : <span className="block font-sans text-slate-600 dark:text-slate-400">{c.type === 'slack' ? 'path is write-only' : 'path and signing secret are write-only'}</span>}
                  </td>
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
          <form className="grid gap-3 md:grid-cols-4" onSubmit={(e) => { e.preventDefault(); setMsg(null); create.mutate(); }} aria-label={`New ${TYPE_LABEL[type]} channel`} data-testid="channel-form">
            <label className="text-sm">Type
              <select className={`${field} mt-0.5 block w-full`} value={type} onChange={(e) => setType(e.target.value as ChannelType)} data-testid="channel-type-select">
                <option value="webhook">Webhook (signed JSON)</option><option value="slack">Slack (incoming webhook)</option><option value="email">E-mail (SMTP)</option>
              </select>
            </label>
            <label className="text-sm">Name<input required className={`${field} mt-0.5 block w-full`} value={name} maxLength={80} onChange={(e) => setName(e.target.value)} data-testid="channel-name" /></label>
            <label className="text-sm">Notifications per minute (max)<input type="number" min={1} max={60} className={`${field} mt-0.5 block w-full`} value={rate} onChange={(e) => setRate(Number(e.target.value))} /></label>
            <span className="hidden md:block" />
            {type !== 'email' && (
              <label className="text-sm md:col-span-2">{type === 'slack' ? 'Slack incoming-webhook URL (write-only)' : 'Webhook URL (https)'}<input required type={type === 'slack' ? 'password' : 'url'} className={`${field} mt-0.5 block w-full font-mono`} value={url} maxLength={2048} onChange={(e) => setUrl(e.target.value)} placeholder={type === 'slack' ? 'https://hooks.slack.com/services/…' : 'https://hooks.example.com/nexus'} autoComplete="off" data-testid="channel-url" /></label>
            )}
            {type === 'webhook' && (
              <label className="text-sm md:col-span-2">Signing secret (16+ characters, write-only)<input required type="password" minLength={16} maxLength={256} className={`${field} mt-0.5 block w-full`} value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="new-password" data-testid="channel-secret" /></label>
            )}
            {type === 'email' && (
              <>
                <label className="text-sm md:col-span-2">SMTP host<input required className={`${field} mt-0.5 block w-full font-mono`} value={host} maxLength={253} onChange={(e) => setHost(e.target.value)} placeholder="smtp.example.com" autoComplete="off" data-testid="smtp-host" /></label>
                <label className="text-sm">Security
                  <select className={`${field} mt-0.5 block w-full`} value={security} onChange={(e) => pickSecurity(e.target.value as SmtpSecurity)} data-testid="smtp-security">
                    <option value="starttls">{SECURITY_HELP.starttls}</option><option value="tls">{SECURITY_HELP.tls}</option><option value="none">{SECURITY_HELP.none}</option>
                  </select>
                </label>
                <label className="text-sm">Port<input type="number" min={1} max={65535} className={`${field} mt-0.5 block w-full`} value={port} onChange={(e) => setPort(Number(e.target.value))} data-testid="smtp-port" /></label>
                <label className="text-sm">SMTP user name (write-only, optional)<input className={`${field} mt-0.5 block w-full`} value={smtpUser} maxLength={256} onChange={(e) => setSmtpUser(e.target.value)} autoComplete="off" data-testid="smtp-user" /></label>
                <label className="text-sm">SMTP password (write-only)<input type="password" className={`${field} mt-0.5 block w-full`} value={smtpPass} maxLength={256} onChange={(e) => setSmtpPass(e.target.value)} autoComplete="new-password" data-testid="smtp-pass" /></label>
                <label className="text-sm">From address<input required type="email" className={`${field} mt-0.5 block w-full`} value={from} maxLength={254} onChange={(e) => setFrom(e.target.value)} placeholder="alerts@example.com" data-testid="email-from" /></label>
                <label className="text-sm md:col-span-4">Recipients (up to {EMAIL_LIMITS.maxRecipients}; separate with commas, spaces or new lines)
                  <textarea required rows={2} className={`${field} mt-0.5 block w-full font-mono`} value={recipientsText} onChange={(e) => setRecipientsText(e.target.value)} placeholder="oncall@example.com, sre@example.com" data-testid="email-recipients" />
                </label>
                {recipientsError && <p role="alert" className="text-xs text-red-700 md:col-span-4 dark:text-red-300" data-testid="email-recipients-error">{recipientsError}</p>}
                {!credentialsOk && <p role="alert" className="text-xs text-red-700 md:col-span-4 dark:text-red-300">Enter both the SMTP user name and password, or neither.</p>}
              </>
            )}
            <div className="flex items-end"><Button type="submit" disabled={create.isPending || !ready} data-testid="channel-create">{create.isPending ? 'Creating…' : `Add ${TYPE_LABEL[type].toLowerCase()} channel`}</Button></div>
            <p className="text-xs text-slate-600 md:col-span-4 dark:text-slate-400">
              {type === 'webhook' && <>Each delivery is a JSON POST with an <code>X-Nexus-Signature: t=…,v1=…</code> header (HMAC-SHA256 of <code>t.body</code> with this secret). </>}
              {type === 'slack' && <>Posts a formatted message with a link back to the incident. Slack incoming-webhook URLs are credentials: stored encrypted, never shown again. </>}
              {type === 'email' && <>Sends a plain-text and HTML message over SMTP with certificate verification; only ports 587, 465 and 2525 are allowed. The SMTP credentials are stored encrypted and never shown again; recipients are masked in this list. </>}
              The target is checked when saved and on every send: private, loopback and cloud-metadata addresses are refused; redirects are not followed. Use <em>Send test</em> after adding a channel.
            </p>
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
    <Card title="Silences (one-off)">
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
