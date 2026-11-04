import type { AlertRuleDto, LogFilter } from '@nexus/contracts';
import { DEFAULT_FILTERS, toParams, type Filters } from '../logs/model';
import { traceLink, tracesLink } from '../traces/model';

/**
 * Incident -> logs / metrics / traces navigation (ADR-0009). Pure functions: a link carries ONLY ids (project, environment), the rule's declared
 * filters and UTC times. Never a token, a secret or any session data; whoever opens a link is authorized by the destination page's API calls.
 */
export const MIN_WINDOW_MS = 5 * 60_000;
export const MAX_WINDOW_MS = 24 * 3_600_000;
export const MAX_EXAMPLES = 5;

export interface IncidentLike { openedAt: string; resolvedAt: string | null; condition: { windowSeconds: number }; groupLabels: Record<string, string>; environmentId: string }
type Rule = Pick<AlertRuleDto, 'query'>;

/**
 * The window to look at: from the start of the window that produced the first breaching value (opened - rule window) to the resolution (or now for a
 * live incident), at least 5 minutes and at most 24 hours long (the longest the explorers are asked for from here).
 */
export function incidentWindow(i: Pick<IncidentLike, 'openedAt' | 'resolvedAt' | 'condition'>, nowMs: number): { from: string; to: string } {
  const opened = Date.parse(i.openedAt);
  const from = opened - i.condition.windowSeconds * 1000;
  const end = i.resolvedAt ? Date.parse(i.resolvedAt) : nowMs;
  let to = Math.max(end, opened + MIN_WINDOW_MS);
  if (to - from > MAX_WINDOW_MS) to = from + MAX_WINDOW_MS;
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/** The service an incident is about: the rule's own service, else the group's `service` label. */
export function incidentService(rule: Rule, groupLabels: Record<string, string>): string | null {
  const q = rule.query;
  if (q.kind === 'metric') return q.service ?? groupLabels.service ?? null;
  return q.services?.length === 1 ? q.services[0]! : null;
}

/** Logs Explorer pre-filled with the log rule's own filter (text, severity, services, field filters), its environment and the window. */
export function logsLinkForRule(projectId: string, rule: Rule, i: Pick<IncidentLike, 'environmentId'>, win: { from: string; to: string }): string | null {
  const q = rule.query;
  if (q.kind !== 'logs') return null;
  const f: Filters = {
    ...DEFAULT_FILTERS, range: 'custom', from: win.from, to: win.to, text: q.text ?? '', errorsOnly: !!q.errorsOnly,
    minSeverity: q.errorsOnly ? '' : q.minSeverity ?? '', services: q.services ?? [], envIds: [i.environmentId], filters: (q.filters ?? []) as LogFilter[],
  };
  return `/logs?${toParams(f, null, projectId)}`;
}

/** The label filters of the metric query: the rule's own plus the incident's group (a `service` group goes to the service selector instead). */
export function metricFilters(rule: Rule, groupLabels: Record<string, string>): { key: string; value: string }[] {
  const q = rule.query;
  if (q.kind !== 'metric') return [];
  const out = [...q.filters];
  for (const [key, value] of Object.entries(groupLabels)) if (key !== 'service' && !out.some((f) => f.key === key)) out.push({ key, value });
  return out.slice(0, 5);
}

/** Metrics explorer with the rule's metric, service, filters, aggregation, environment and the incident window (`range=custom`, `from`, `to`). */
export function metricsLinkForRule(projectId: string, rule: Rule, i: Pick<IncidentLike, 'environmentId' | 'groupLabels'>, win: { from: string; to: string }): string | null {
  const q = rule.query;
  if (q.kind !== 'metric') return null;
  const sp = new URLSearchParams({ p: projectId, metric: q.metric, range: 'custom', from: win.from, to: win.to, agg: q.agg, env: i.environmentId });
  const svc = incidentService(rule, i.groupLabels);
  if (svc) sp.set('svc', svc);
  for (const f of metricFilters(rule, i.groupLabels)) sp.append('f', `${f.key}~${f.value}`);
  return `/metrics?${sp}`;
}

/** Trace explorer for the incident's service and window (time-window link: approximate, never proof). Only when a service is known. */
export function tracesLinkForRule(projectId: string, rule: Rule, i: Pick<IncidentLike, 'environmentId' | 'groupLabels'>, win: { from: string; to: string }): string | null {
  const svc = incidentService(rule, i.groupLabels);
  return svc ? tracesLink(projectId, { service: svc, from: win.from, to: win.to, errorsOnly: true, envId: i.environmentId }) : null;
}

/** Body for `POST /metrics/query` that returns the exemplars seen in the window (the same query the rule evaluates, over the incident window). */
export function exemplarQuery(rule: Rule, i: Pick<IncidentLike, 'environmentId' | 'groupLabels'>, win: { from: string; to: string }) {
  const q = rule.query;
  if (q.kind !== 'metric') return null;
  const svc = incidentService(rule, i.groupLabels);
  return { from: win.from, to: win.to, metric: q.metric, agg: q.agg, filters: metricFilters(rule, i.groupLabels), groupBy: [] as string[], environmentIds: [i.environmentId], ...(svc ? { service: svc } : {}) };
}

/** Body for `POST /traces/search`: failed traces of the incident's service in the window. */
export function failedTraceQuery(rule: Rule, i: Pick<IncidentLike, 'environmentId' | 'groupLabels'>, win: { from: string; to: string }, limit = MAX_EXAMPLES) {
  const svc = incidentService(rule, i.groupLabels);
  return svc ? { from: win.from, to: win.to, services: [svc], errorsOnly: true, environmentIds: [i.environmentId], sort: 'recent' as const, limit } : null;
}

export interface Example { kind: 'exemplar' | 'failed'; traceId: string; spanId: string | null; detail: string }
/** At most 5 examples: exemplars of the metric first (newest first), then failed traces of the same service, one entry per trace. */
export function pickExamples(
  exemplars: { traceId: string; spanId: string | null; value: number; ts: string }[],
  failed: { traceId: string; start: string; rootName: string | null; rootService: string | null; errorCount: number }[],
  max = MAX_EXAMPLES,
): Example[] {
  const seen = new Set<string>();
  const out: Example[] = [];
  for (const e of [...exemplars].sort((a, b) => b.ts.localeCompare(a.ts))) {
    if (out.length >= max) break;
    if (seen.has(e.traceId)) continue;
    seen.add(e.traceId);
    out.push({ kind: 'exemplar', traceId: e.traceId, spanId: e.spanId, detail: `exemplar value ${Math.round(e.value * 1e4) / 1e4} at ${e.ts.slice(11, 19)} UTC` });
  }
  for (const t of failed) {
    if (out.length >= max) break;
    if (seen.has(t.traceId)) continue;
    seen.add(t.traceId);
    out.push({ kind: 'failed', traceId: t.traceId, spanId: null, detail: `failed trace${t.rootName ? ` “${t.rootName}”` : ''} at ${t.start.slice(11, 19)} UTC, ${t.errorCount} error span${t.errorCount === 1 ? '' : 's'}` });
  }
  return out;
}

export const exampleLink = (projectId: string, e: Example, envId: string) => traceLink(e.traceId, projectId, envId, e.spanId);

/** The statement shown next to every example list (same policy as the metric and service pages: a time-window sample, never a causal claim). */
export const EXAMPLES_HEADLINE = 'A sample from the window, not proof of cause.';
export const EXAMPLES_DETAIL = 'These are traces that were recorded and received in this time window (exemplars are explicit references from the metric; the rest are failed traces of the same service). They may be unrelated to the incident.';
