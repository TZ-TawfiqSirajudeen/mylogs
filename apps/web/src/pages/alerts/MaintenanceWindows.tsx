import type { MaintenanceDto } from '@nexus/contracts';
import { WEEKDAYS } from '@nexus/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api';
import { Badge, Button, Card, ErrorState, Loading } from '../../ui';
import { bodyFromForm, DAY_LABEL, describeSchedule, emptyForm, formFromWindow, formIssues, formatInZone, knownZones, utcShort, type WindowForm } from './maintenance-model';
import { errorText, field, Table, THead, type Page, type Rule } from './shared';

type Project = NonNullable<ReturnType<typeof import('../../session').useSelection>['project']>;
const SEVERITIES = ['critical', 'warning', 'info'] as const;

/**
 * Maintenance windows (ADR-0010): recurring (weekly, in an IANA time zone, daylight-saving aware) or one-off. While a window is active, matching
 * notifications are suppressed and recorded; incidents are still opened and shown. Times shown here come from the server's clock and rules.
 */
export function MaintenanceCard({ project, manage }: { project: Project; manage: boolean }) {
  const qc = useQueryClient();
  const base = `/api/v1/projects/${project.id}`;
  const q = useQuery({ queryKey: ['alert-maintenance', project.id], refetchInterval: 30_000, queryFn: () => api<Page<MaintenanceDto>>('GET', `${base}/alert-maintenance-windows?limit=100`) });
  const rules = useQuery({ queryKey: ['alert-rules-select', project.id], enabled: manage, queryFn: () => api<Page<Rule>>('GET', `${base}/alert-rules?limit=100`) });
  const [editing, setEditing] = useState<MaintenanceDto | 'new' | null>(null);
  const [form, setForm] = useState<WindowForm>(emptyForm());
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['alert-maintenance', project.id] });
  const open = (w: MaintenanceDto | 'new') => { setEditing(w); setForm(w === 'new' ? emptyForm() : formFromWindow(w)); setError(null); setNotice(null); };
  const set = <K extends keyof WindowForm>(k: K, v: WindowForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = useMutation({
    mutationFn: () => (editing && editing !== 'new' ? api<MaintenanceDto>('PATCH', `${base}/alert-maintenance-windows/${editing.id}`, bodyFromForm(form)) : api<MaintenanceDto>('POST', `${base}/alert-maintenance-windows`, bodyFromForm(form))),
    onSuccess: (w) => { setEditing(null); setError(null); setNotice(`Maintenance window “${w.name}” saved.`); refresh(); },
    onError: (e) => setError(errorText(e)),
  });
  const toggle = useMutation({
    mutationFn: (w: MaintenanceDto) => api<MaintenanceDto>('PATCH', `${base}/alert-maintenance-windows/${w.id}`, { enabled: !w.enabled }),
    onSuccess: (w) => { setNotice(`Maintenance window “${w.name}” ${w.enabled ? 'enabled' : 'disabled'}.`); refresh(); }, onError: (e) => setNotice(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: (w: MaintenanceDto) => api('DELETE', `${base}/alert-maintenance-windows/${w.id}`),
    onSuccess: () => { setNotice('Maintenance window deleted. Notifications are no longer suppressed by it.'); refresh(); }, onError: (e) => setNotice(errorText(e)),
  });

  const ruleName = (id: string) => rules.data?.items.find((r) => r.id === id)?.name ?? id.slice(0, 8);
  const envName = (id: string) => project.environments.find((e) => e.id === id)?.name ?? id.slice(0, 8);
  const scope = (w: MaintenanceDto) => [
    w.matchers.ruleIds?.length ? `rules: ${w.matchers.ruleIds.map(ruleName).join(', ')}` : '', w.matchers.severities?.length ? `severity: ${w.matchers.severities.join(', ')}` : '',
    w.matchers.environmentIds?.length ? `environments: ${w.matchers.environmentIds.map(envName).join(', ')}` : '',
  ].filter(Boolean).join(' · ') || 'the whole project';
  const issues = editing ? formIssues(form) : [];
  const zones = knownZones();

  return (
    <Card title="Maintenance windows">
      <div className="space-y-4" data-testid="maintenance-card">
        <p className="text-sm text-slate-600 dark:text-slate-400">
          A window suppresses <strong>notifications</strong> for matching rules while it is active, for example every Sunday 02:00–04:00 in your time zone (daylight saving is followed).
          Rules keep being evaluated and incidents are still opened and shown; each suppressed notification is recorded with the window. A window that ends while an incident it hid is still firing does not send a late notice.
        </p>
        {notice && <p role="status" className="rounded-md bg-slate-100 px-3 py-2 text-sm dark:bg-slate-800" data-testid="maint-notice">{notice}</p>}
        {q.isPending && <Loading />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
        {q.data?.items.length === 0 && <p className="text-sm text-slate-600 dark:text-slate-400" data-testid="no-maintenance">No maintenance windows.</p>}
        {!!q.data?.items.length && (
          <Table label="Maintenance windows" testid="maintenance-table" min="52rem">
            <THead cols={['Window', 'Schedule', 'Applies to', 'State', 'Next occurrence', { sr: 'Actions' }]} />
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {q.data.items.map((w) => {
                const zone = w.schedule.type === 'weekly' ? w.schedule.timezone : 'UTC';
                return (
                  <tr key={w.id} data-testid={`maint-row-${w.name}`}>
                    <td className="px-3 py-2 font-medium">{w.name}{w.comment && <span className="block text-xs font-normal text-slate-600 dark:text-slate-400">{w.comment}</span>}</td>
                    <td className="px-3 py-2 text-xs">{describeSchedule(w.schedule)}</td>
                    <td className="px-3 py-2 text-xs">{scope(w)}</td>
                    <td className="px-3 py-2" data-testid="maint-state">
                      {w.activeNow ? <Badge tone="warn">active now</Badge> : w.state === 'disabled' ? <Badge>disabled</Badge> : w.state === 'expired' ? <Badge>expired</Badge> : <Badge tone="info">scheduled</Badge>}
                      {w.activeNow && w.currentOccurrence && <span className="block text-xs text-slate-600 dark:text-slate-400">until {utcShort(w.currentOccurrence.endsAt)}</span>}
                    </td>
                    <td className="px-3 py-2 text-xs" data-testid="maint-next">
                      {w.nextOccurrence ? <>{formatInZone(w.nextOccurrence.startsAt, zone)} <span className="text-slate-600 dark:text-slate-400">({zone})</span><span className="block font-mono text-slate-600 dark:text-slate-400">{utcShort(w.nextOccurrence.startsAt)}</span></> : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">{manage && (
                      <div className="flex flex-wrap justify-end gap-1">
                        <Button variant="ghost" onClick={() => open(w)} data-testid="maint-edit">Edit</Button>
                        <Button variant="ghost" disabled={toggle.isPending} onClick={() => toggle.mutate(w)} data-testid="maint-toggle">{w.enabled ? 'Disable' : 'Enable'}</Button>
                        <Button variant="danger" disabled={remove.isPending} onClick={() => { if (confirm(`Delete maintenance window "${w.name}"?`)) remove.mutate(w); }} data-testid="maint-delete">Delete</Button>
                      </div>)}</td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}

        {manage && !editing && <Button onClick={() => open('new')} data-testid="maint-new">New maintenance window</Button>}
        {manage && editing && (
          <form className="space-y-3 rounded-md border border-slate-200 p-3 dark:border-slate-800" onSubmit={(e) => { e.preventDefault(); save.mutate(); }} aria-label={editing === 'new' ? 'New maintenance window' : `Edit ${editing.name}`} data-testid="maint-form">
            <div className="grid gap-3 md:grid-cols-3">
              <label className="text-sm">Name<input required maxLength={80} className={`${field} mt-0.5 block w-full`} value={form.name} onChange={(e) => set('name', e.target.value)} data-testid="maint-name" /></label>
              <label className="text-sm md:col-span-2">Reason (optional)<input maxLength={500} className={`${field} mt-0.5 block w-full`} value={form.comment} onChange={(e) => set('comment', e.target.value)} data-testid="maint-comment" /></label>
            </div>
            <div role="radiogroup" aria-label="Schedule type" className="flex gap-4 text-sm">
              <label className="flex items-center gap-1"><input type="radio" name="maint-type" checked={form.type === 'weekly'} onChange={() => set('type', 'weekly')} data-testid="maint-type-weekly" />Repeats weekly</label>
              <label className="flex items-center gap-1"><input type="radio" name="maint-type" checked={form.type === 'once'} onChange={() => set('type', 'once')} data-testid="maint-type-once" />One time</label>
            </div>
            {form.type === 'weekly' ? (
              <div className="grid gap-3 md:grid-cols-4">
                <fieldset className="md:col-span-4"><legend className="text-sm">Days</legend>
                  <div className="mt-1 flex flex-wrap gap-3">{WEEKDAYS.map((d) => (
                    <label key={d} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={form.weekdays.includes(d)} data-testid={`maint-day-${d}`}
                      onChange={(e) => set('weekdays', e.target.checked ? [...form.weekdays, d] : form.weekdays.filter((x) => x !== d))} />{DAY_LABEL[d]}</label>))}</div></fieldset>
                <label className="text-sm">Starts at (local time in the zone)<input required type="time" className={`${field} mt-0.5 block w-full`} value={form.startTime} onChange={(e) => set('startTime', e.target.value)} data-testid="maint-start" /></label>
                <label className="text-sm">Lasts (minutes, 1–1440)<input required type="number" min={1} max={1440} className={`${field} mt-0.5 block w-full`} value={form.durationMinutes} onChange={(e) => set('durationMinutes', e.target.value)} data-testid="maint-duration" /></label>
                <label className="text-sm md:col-span-2">Time zone (IANA name)<input required list="maint-zones" className={`${field} mt-0.5 block w-full font-mono`} value={form.timezone} onChange={(e) => set('timezone', e.target.value)} data-testid="maint-timezone" />
                  <datalist id="maint-zones">{zones.map((z) => <option key={z} value={z} />)}</datalist></label>
                <p className="text-xs text-slate-600 md:col-span-4 dark:text-slate-400">The window starts at that wall-clock time on each listed day and lasts that many elapsed minutes (it may cross midnight). A start time that does not exist on a clock-change night moves to the first valid moment after the jump.</p>
              </div>
            ) : (
              <div className="grid gap-3 md:grid-cols-3">
                <label className="text-sm">Starts (your local time)<input required type="datetime-local" className={`${field} mt-0.5 block w-full`} value={form.onceStart} onChange={(e) => set('onceStart', e.target.value)} data-testid="maint-once-start" /></label>
                <label className="text-sm">Ends (your local time)<input required type="datetime-local" className={`${field} mt-0.5 block w-full`} value={form.onceEnd} onChange={(e) => set('onceEnd', e.target.value)} data-testid="maint-once-end" /></label>
                <p className="self-end text-xs text-slate-600 dark:text-slate-400">At most 30 days; it must end in the future. It is removed a day after it ends.</p>
              </div>
            )}
            <div className="grid gap-3 md:grid-cols-4">
              <label className="text-sm">Only rule<select className={`${field} mt-0.5 block w-full`} value={form.ruleId} onChange={(e) => set('ruleId', e.target.value)} data-testid="maint-rule"><option value="">All rules</option>{rules.data?.items.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
              <label className="text-sm">Only severity<select className={`${field} mt-0.5 block w-full`} value={form.severity} onChange={(e) => set('severity', e.target.value)} data-testid="maint-severity"><option value="">Any</option>{SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
              <label className="text-sm">Only environment<select className={`${field} mt-0.5 block w-full`} value={form.environmentId} onChange={(e) => set('environmentId', e.target.value)} data-testid="maint-environment"><option value="">Any</option>{project.environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}</select></label>
              <label className="flex items-end gap-2 pb-1.5 text-sm"><input type="checkbox" checked={form.enabled} onChange={(e) => set('enabled', e.target.checked)} data-testid="maint-enabled" />Enabled</label>
            </div>
            {issues.length > 0 && <p className="text-sm text-amber-800 dark:text-amber-300" data-testid="maint-issues">{issues.join(' · ')}</p>}
            {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400" data-testid="maint-error">{error}</p>}
            <div className="flex gap-2">
              <Button type="submit" disabled={save.isPending || !form.name.trim() || issues.length > 0} data-testid="maint-save">{save.isPending ? 'Saving…' : editing === 'new' ? 'Create window' : 'Save changes'}</Button>
              <Button type="button" variant="ghost" onClick={() => { setEditing(null); setError(null); }} data-testid="maint-cancel">Cancel</Button>
            </div>
          </form>
        )}
      </div>
    </Card>
  );
}
