import { ALERT_LIMITS, REPLAY_LIMITS, RULE_METRIC_AGGREGATIONS, SEVERITIES, type AlertRuleCreate } from '@nexus/contracts';
import { useState } from 'react';
import { Button } from '../../ui';
import { PreviewPanel } from './PreviewPanel';
import { field, OPS, type Channel, type Rule } from './shared';

interface Env { id: string; name: string; isProduction: boolean }
const INTERVALS = [15, 30, 60, 120, 300, 600, 1800, 3600];
const NO_DATA = [
  ['keep', 'Keep the current state (default)'], ['ok', 'Treat missing data as healthy'], ['alert', 'Treat missing data as a problem'],
] as const;

const linesToFilters = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const i = l.indexOf('='); return { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim() }; });
const mins = (s: number) => String(Math.round((s / 60) * 100) / 100);

/** Create / edit form for one alert rule. All input limits mirror the server's (which is the authority and re-validates everything). */
export function RuleForm({ rule, envs, channels, busy, error, onSubmit, onCancel, projectId }: {
  /** Needed for the history preview (admins only reach this form). */
  projectId?: string; rule: Rule | null; envs: Env[]; channels: Channel[]; busy: boolean; error: string | null;
  onSubmit: (body: AlertRuleCreate) => void; onCancel: () => void;
}) {
  const q = rule?.query;
  const [name, setName] = useState(rule?.name ?? '');
  const [description, setDescription] = useState(rule?.description ?? '');
  const [severity, setSeverity] = useState<Rule['severity']>(rule?.severity ?? 'warning');
  const [environmentId, setEnvironmentId] = useState(rule?.environmentId ?? '');
  const [kind, setKind] = useState<'metric' | 'logs'>(q?.kind ?? 'metric');
  // metric query
  const [metric, setMetric] = useState(q?.kind === 'metric' ? q.metric : '');
  const [agg, setAgg] = useState<(typeof RULE_METRIC_AGGREGATIONS)[number]>(q?.kind === 'metric' ? q.agg : 'max');
  const [service, setService] = useState(q?.kind === 'metric' ? q.service ?? '' : '');
  const [labels, setLabels] = useState(q?.kind === 'metric' ? q.filters.map((f) => `${f.key}=${f.value}`).join('\n') : '');
  const [groupBy, setGroupBy] = useState(q?.kind === 'metric' ? q.groupBy[0] ?? '' : '');
  // log query
  const [text, setText] = useState(q?.kind === 'logs' ? q.text ?? '' : '');
  const [errorsOnly, setErrorsOnly] = useState(q?.kind === 'logs' ? !!q.errorsOnly : true);
  const [minSeverity, setMinSeverity] = useState<string>(q?.kind === 'logs' ? q.minSeverity ?? '' : '');
  const [services, setServices] = useState(q?.kind === 'logs' ? (q.services ?? []).join(', ') : '');
  const [status, setStatus] = useState(q?.kind === 'logs' ? String(q.filters.find((f) => f.field === 'httpStatus')?.value ?? '') : '');
  // condition
  const [op, setOp] = useState<keyof typeof OPS>(rule?.condition.op ?? 'gt');
  const [threshold, setThreshold] = useState(String(rule?.condition.threshold ?? ''));
  const [windowMin, setWindowMin] = useState(mins(rule?.windowSeconds ?? 300));
  const [forMin, setForMin] = useState(mins(rule?.forSeconds ?? 120));
  const [resolveMin, setResolveMin] = useState(mins(rule?.resolveAfterSeconds ?? 300));
  const [noData, setNoData] = useState<Rule['noDataPolicy']>(rule?.noDataPolicy ?? 'keep');
  const [interval, setIntervalSeconds] = useState(rule?.intervalSeconds ?? 60);
  const [channelIds, setChannelIds] = useState<string[]>(rule?.channelIds ?? []);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  // missed evaluations (ADR-0010)
  const [missedPolicy, setMissedPolicy] = useState<Rule['missedPolicy']>(rule?.missedPolicy ?? 'skip');
  const [maxReplay, setMaxReplay] = useState(String(rule?.maxReplayEvaluations ?? 5));
  const [staleMin, setStaleMin] = useState(mins(rule?.staleNotificationSeconds ?? 900));

  /** The rule exactly as Save would send it (also what Preview replays). */
  const build = (): AlertRuleCreate => {
    const query = kind === 'metric'
      ? { kind: 'metric' as const, metric: metric.trim(), agg, filters: linesToFilters(labels), groupBy: groupBy.trim() ? [groupBy.trim()] : [], ...(service.trim() ? { service: service.trim() } : {}) }
      : {
        kind: 'logs' as const, filters: status.trim() ? [{ field: 'httpStatus', op: 'gte' as const, value: Number(status) }] : [],
        ...(text.trim() ? { text: text.trim() } : {}), ...(errorsOnly ? { errorsOnly: true } : minSeverity ? { minSeverity: minSeverity as (typeof SEVERITIES)[number] } : {}),
        ...(services.trim() ? { services: services.split(',').map((s) => s.trim()).filter(Boolean) } : {}),
      };
    return {
      name: name.trim(), description: description.trim(), severity, environmentId, enabled, query, condition: { op, threshold: Number(threshold) },
      windowSeconds: Math.round(Number(windowMin) * 60), forSeconds: Math.round(Number(forMin) * 60), resolveAfterSeconds: Math.round(Number(resolveMin) * 60),
      noDataPolicy: noData, intervalSeconds: interval, channelIds,
      missedPolicy, maxReplayEvaluations: Math.round(Number(maxReplay)), staleNotificationSeconds: Math.round(Number(staleMin) * 60),
    } as AlertRuleCreate;
  };
  const submit = (e: React.FormEvent) => { e.preventDefault(); onSubmit(build()); };

  return (
    <form onSubmit={submit} className="space-y-4" data-testid="rule-form" aria-label={rule ? `Edit rule ${rule.name}` : 'New alert rule'}>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="text-sm">Name<input required className={`${field} mt-0.5 block w-full`} value={name} maxLength={100} onChange={(e) => setName(e.target.value)} data-testid="rule-name" /></label>
        <label className="text-sm">Environment<select required disabled={!!rule} className={`${field} mt-0.5 block w-full`} value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)} data-testid="rule-environment">
          <option value="">Select…</option>{envs.map((e) => <option key={e.id} value={e.id}>{e.name}{e.isProduction ? ' (production)' : ''}</option>)}</select></label>
        <label className="text-sm md:col-span-2">Description (optional)<input className={`${field} mt-0.5 block w-full`} value={description} maxLength={500} onChange={(e) => setDescription(e.target.value)} /></label>
        <label className="text-sm">Severity<select className={`${field} mt-0.5 block w-full`} value={severity} onChange={(e) => setSeverity(e.target.value as Rule['severity'])} data-testid="rule-severity">
          <option value="info">info</option><option value="warning">warning</option><option value="critical">critical</option></select></label>
      </div>

      <fieldset className="space-y-3 rounded-md border border-slate-200 p-3 dark:border-slate-800">
        <legend className="px-1 text-sm font-medium">What to measure</legend>
        <div role="radiogroup" aria-label="Rule type" className="flex gap-4 text-sm">
          <label className="flex items-center gap-1"><input type="radio" name="kind" checked={kind === 'metric'} disabled={!!rule} onChange={() => setKind('metric')} data-testid="rule-kind-metric" />Metric threshold</label>
          <label className="flex items-center gap-1"><input type="radio" name="kind" checked={kind === 'logs'} disabled={!!rule} onChange={() => setKind('logs')} data-testid="rule-kind-logs" />Log count</label>
        </div>
        {kind === 'metric' ? (
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-sm">Metric name<input required className={`${field} mt-0.5 block w-full font-mono`} value={metric} onChange={(e) => setMetric(e.target.value)} placeholder="http.server.errors" data-testid="rule-metric" /></label>
            <label className="text-sm">Aggregation over the window<select className={`${field} mt-0.5 block w-full`} value={agg} onChange={(e) => setAgg(e.target.value as typeof agg)} data-testid="rule-agg">
              {RULE_METRIC_AGGREGATIONS.map((a) => <option key={a} value={a}>{a}</option>)}</select></label>
            <label className="text-sm">Service (optional)<input className={`${field} mt-0.5 block w-full`} value={service} onChange={(e) => setService(e.target.value)} /></label>
            <label className="text-sm md:col-span-2">Label filters (one <code>key=value</code> per line, up to 5)<textarea rows={2} className={`${field} mt-0.5 block w-full font-mono`} value={labels} onChange={(e) => setLabels(e.target.value)} /></label>
            <label className="text-sm">Evaluate separately per label (optional)<input className={`${field} mt-0.5 block w-full`} value={groupBy} onChange={(e) => setGroupBy(e.target.value)} placeholder="service" /></label>
            <p className="text-xs text-slate-600 md:col-span-3 dark:text-slate-400">Percentile aggregations (p95…) are not available for alerts yet: they cannot be computed exactly over a sliding window.</p>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-3">
            <label className="text-sm">Text contains (optional)<input className={`${field} mt-0.5 block w-full`} value={text} onChange={(e) => setText(e.target.value)} data-testid="rule-text" /></label>
            <label className="text-sm">Services (comma separated, optional)<input className={`${field} mt-0.5 block w-full`} value={services} onChange={(e) => setServices(e.target.value)} /></label>
            <label className="text-sm">HTTP status at least (optional)<input type="number" min={100} max={599} className={`${field} mt-0.5 block w-full`} value={status} onChange={(e) => setStatus(e.target.value)} /></label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={errorsOnly} onChange={(e) => setErrorsOnly(e.target.checked)} data-testid="rule-errors-only" />Errors and above only</label>
            {!errorsOnly && <label className="text-sm">Minimum severity<select className={`${field} mt-0.5 block w-full`} value={minSeverity} onChange={(e) => setMinSeverity(e.target.value)}>
              <option value="">any</option>{SEVERITIES.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>}
            <p className="text-xs text-slate-600 md:col-span-3 dark:text-slate-400">Counts records whose event time falls in the window. Records that arrive late are counted when the next evaluation runs.</p>
          </div>
        )}
      </fieldset>

      <fieldset className="space-y-3 rounded-md border border-slate-200 p-3 dark:border-slate-800">
        <legend className="px-1 text-sm font-medium">When to alert</legend>
        <div className="grid gap-3 md:grid-cols-4">
          <label className="text-sm">Value is<select className={`${field} mt-0.5 block w-full`} value={op} onChange={(e) => setOp(e.target.value as keyof typeof OPS)} data-testid="rule-op">
            {Object.entries(OPS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="text-sm">Threshold<input required type="number" step="any" className={`${field} mt-0.5 block w-full`} value={threshold} onChange={(e) => setThreshold(e.target.value)} data-testid="rule-threshold" /></label>
          <label className="text-sm">Window (minutes)<input required type="number" min={ALERT_LIMITS.minWindowSeconds / 60} max={ALERT_LIMITS.maxWindowSeconds / 60} step="any" className={`${field} mt-0.5 block w-full`} value={windowMin} onChange={(e) => setWindowMin(e.target.value)} data-testid="rule-window" /></label>
          <label className="text-sm">Check every<select className={`${field} mt-0.5 block w-full`} value={interval} onChange={(e) => setIntervalSeconds(Number(e.target.value))} data-testid="rule-interval">
            {INTERVALS.map((s) => <option key={s} value={s}>{s < 60 ? `${s} s` : `${s / 60} min`}</option>)}</select></label>
          <label className="text-sm">Must hold for (minutes)<input type="number" min={0} max={ALERT_LIMITS.maxForSeconds / 60} step="any" className={`${field} mt-0.5 block w-full`} value={forMin} onChange={(e) => setForMin(e.target.value)} data-testid="rule-for" /></label>
          <label className="text-sm">Stay clear before resolving (minutes)<input type="number" min={0} max={ALERT_LIMITS.maxResolveAfterSeconds / 60} step="any" className={`${field} mt-0.5 block w-full`} value={resolveMin} onChange={(e) => setResolveMin(e.target.value)} data-testid="rule-resolve" /></label>
          <label className="text-sm md:col-span-2">When there is no data<select className={`${field} mt-0.5 block w-full`} value={noData} onChange={(e) => setNoData(e.target.value as Rule['noDataPolicy'])} data-testid="rule-nodata">
            {NO_DATA.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
        </div>
      </fieldset>

      {projectId && <PreviewPanel projectId={projectId} build={build} disabledReason={!environmentId ? 'Choose an environment to preview this rule.' : null} />}

      <fieldset className="space-y-2 rounded-md border border-slate-200 p-3 dark:border-slate-800" data-testid="rule-missed-policy">
        <legend className="px-1 text-sm font-medium">If checks are missed (worker down)</legend>
        <div className="grid gap-3 md:grid-cols-3">
          <label className="text-sm">Policy<select className={`${field} mt-0.5 block w-full`} value={missedPolicy} onChange={(e) => setMissedPolicy(e.target.value as Rule['missedPolicy'])} data-testid="rule-missed-policy-select">
            <option value="skip">Skip: judge the current data only (default)</option><option value="replay">Replay: re-check the latest missed intervals in order</option></select></label>
          <label className="text-sm">Replay at most (checks, 1–{REPLAY_LIMITS.maxEvaluations})<input type="number" min={1} max={REPLAY_LIMITS.maxEvaluations} disabled={missedPolicy !== 'replay'} className={`${field} mt-0.5 block w-full`} value={maxReplay} onChange={(e) => setMaxReplay(e.target.value)} data-testid="rule-max-replay" /></label>
          <label className="text-sm">Do not notify for events older than (minutes)<input type="number" min={0} max={REPLAY_LIMITS.maxStaleSeconds / 60} step="any" disabled={missedPolicy !== 'replay'} className={`${field} mt-0.5 block w-full`} value={staleMin} onChange={(e) => setStaleMin(e.target.value)} data-testid="rule-stale-minutes" /></label>
        </div>
        <p className="text-xs text-slate-600 dark:text-slate-400">Replay uses the data as it was at each missed check, so an incident opens at the time it really began. Older replayed events are recorded as <em>stale</em> and not sent; an incident that is still firing gets one catch-up notice.</p>
      </fieldset>

      <fieldset className="rounded-md border border-slate-200 p-3 dark:border-slate-800">
        <legend className="px-1 text-sm font-medium">Notify</legend>
        {channels.length === 0 ? <p className="text-sm text-slate-600 dark:text-slate-400">No notification channels yet. Incidents are still recorded; add a channel to be notified.</p> : (
          <div className="flex flex-wrap gap-4">{channels.map((c) => (
            <label key={c.id} className="flex items-center gap-1 text-sm"><input type="checkbox" checked={channelIds.includes(c.id)} disabled={!channelIds.includes(c.id) && channelIds.length >= ALERT_LIMITS.maxChannelsPerRule}
              onChange={(e) => setChannelIds(e.target.checked ? [...channelIds, c.id] : channelIds.filter((x) => x !== c.id))} />{c.name}</label>))}</div>
        )}
      </fieldset>

      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />Enabled</label>
      {error && <p role="alert" className="text-sm text-red-700 dark:text-red-400" data-testid="rule-form-error">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || !name.trim() || !environmentId} data-testid="rule-save">{busy ? 'Saving…' : rule ? 'Save changes' : 'Create rule'}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
