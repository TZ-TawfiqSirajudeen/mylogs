import { ALERT_LIMITS, type LogQuery, type MetricQuery } from '@nexus/contracts';
import type { AlertRuleDoc } from '@nexus/database';
import type { LogStore } from '@nexus/logstore';
import type { MetricStore } from '@nexus/metricstore';
import type { Observation } from './state.js';

export interface EvalDeps {
  metrics: Pick<MetricStore, 'query'>;
  logs: Pick<LogStore, 'histogram'>;
}
export interface GroupObservation { key: string; labels: Record<string, string>; obs: Observation }
export interface EvalResult { groups: GroupObservation[]; truncated: boolean }

export const groupKeyOf = (labels: Record<string, string>): string => {
  const keys = Object.keys(labels).sort();
  return keys.length ? keys.map((k) => `${k}=${labels[k]}`).join(',') : '';
};

type RuleQueryDoc = Pick<AlertRuleDoc, 'orgId' | 'projectId' | 'environmentId' | 'query' | 'windowSeconds'>;

/**
 * Runs one rule's query against the stores, READ-ONLY and scoped to the rule's own organization, project and environment (taken from the rule
 * document, never from a caller). Returns one observation per group; throws when the store refuses or fails (the engine records that as an
 * evaluation error and leaves the rule's state untouched).
 *
 * Window semantics: the last `windowSeconds` before `now`, with at most one minute of slack at the start (the store aggregates whole minutes).
 */
export async function evaluateQuery(rule: RuleQueryDoc, deps: EvalDeps, now: Date): Promise<EvalResult> {
  const scope = { orgId: rule.orgId, projectId: rule.projectId, environmentIds: [rule.environmentId] };
  const from = new Date(now.getTime() - rule.windowSeconds * 1000);
  if (rule.query.kind === 'logs') {
    const q = rule.query as unknown as { text?: string; minSeverity?: LogQuery['minSeverity']; errorsOnly?: boolean; services?: string[]; filters?: LogQuery['filters'] };
    const logQuery: LogQuery = {
      from: from.toISOString(), to: now.toISOString(), text: q.text, minSeverity: q.minSeverity, errorsOnly: q.errorsOnly, services: q.services,
      environmentIds: [rule.environmentId], filters: q.filters ?? [], sort: 'desc', limit: 1,
    };
    const h = await deps.logs.histogram(scope, logQuery, 1);
    // A count of zero is a real measurement, never "no data".
    return { groups: [{ key: '', labels: {}, obs: { kind: 'value', value: h.buckets.reduce((n, b) => n + b.total, 0) } }], truncated: false };
  }

  const q = rule.query as unknown as { metric: string; service?: string; filters?: { key: string; value: string }[]; groupBy?: string[]; agg: string };
  const base: MetricQuery = {
    from: from.toISOString(), to: now.toISOString(), metric: q.metric, filters: q.filters ?? [], groupBy: q.groupBy ?? [],
    environmentIds: [rule.environmentId], stepSeconds: 60, ...(q.service ? { service: q.service } : {}),
  };
  const run = (agg: NonNullable<MetricQuery['agg']>) => deps.metrics.query(scope, { ...base, agg });

  type Series = { labels: Record<string, string>; points: { t: number; v: number | null }[] };
  const collect = (series: Series[]) => new Map(series.map((s) => [groupKeyOf(s.labels), s]));
  const nonNull = (s: Series) => s.points.filter((p): p is { t: number; v: number } => p.v !== null).map((p) => p.v);
  const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

  const perGroup = new Map<string, { labels: Record<string, string>; value: number | null }>();
  let truncated = false;
  if (q.agg === 'avg') {
    // An average of per-minute averages is wrong; the exact value is total sum / total count over the window.
    const [sum, count] = await Promise.all([run('sum'), run('count')]);
    truncated = sum.truncated || count.truncated;
    const counts = collect(count.series);
    for (const s of sum.series) {
      const c = counts.get(groupKeyOf(s.labels));
      const n = c ? total(nonNull(c)) : 0;
      perGroup.set(groupKeyOf(s.labels), { labels: s.labels, value: n > 0 ? total(nonNull(s)) / n : null });
    }
  } else {
    const res = await run(q.agg as NonNullable<MetricQuery['agg']>);
    truncated = res.truncated;
    for (const s of res.series) {
      const v = nonNull(s);
      let value: number | null;
      if (v.length === 0) value = null;
      else if (q.agg === 'sum' || q.agg === 'count') value = total(v);
      // rate: each step value is "increase per second within the step"; the window rate is the total increase over the whole window
      else if (q.agg === 'rate') value = total(v) * (res.stepMs / 1000) / rule.windowSeconds;
      else if (q.agg === 'min') value = Math.min(...v);
      else if (q.agg === 'max') value = Math.max(...v);
      else value = v[v.length - 1]!; // last
      perGroup.set(groupKeyOf(s.labels), { labels: s.labels, value });
    }
  }

  const grouped = (q.groupBy ?? []).length > 0;
  if (!grouped) {
    const only = [...perGroup.values()][0];
    return { groups: [{ key: '', labels: {}, obs: only?.value == null ? { kind: 'no_data' } : { kind: 'value', value: only.value } }], truncated };
  }
  const entries = [...perGroup].map(([key, g]): GroupObservation => ({ key, labels: g.labels, obs: g.value === null ? { kind: 'no_data' } : { kind: 'value', value: g.value } }));
  if (entries.length > ALERT_LIMITS.maxGroupsPerRule) { truncated = true; entries.length = ALERT_LIMITS.maxGroupsPerRule; }
  return { groups: entries, truncated };
}
