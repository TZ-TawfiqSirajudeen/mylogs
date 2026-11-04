import type { MetricQueryResult, TraceSummaryDto } from '@nexus/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { Card, Loading } from '../../ui';
import { fmtTime } from '../sources/parts';
import {
  EXAMPLES_DETAIL, EXAMPLES_HEADLINE, exampleLink, exemplarQuery, failedTraceQuery, incidentService, incidentWindow, logsLinkForRule, metricsLinkForRule, pickExamples, tracesLinkForRule,
} from './links';
import { link, type IncidentDetail, type Rule } from './shared';

/**
 * "Related telemetry" on the incident page (ADR-0009): deep links into the explorers with the rule's own filters and the incident window, and for
 * metric rules up to 5 example traces. Everything is a sample from a time window: no claim of cause. Reads only (existing authorized endpoints).
 */
export function RelatedPanel({ projectId, incident }: { projectId: string; incident: IncidentDetail }) {
  const base = `/api/v1/projects/${projectId}`;
  const [nowMs] = useState(() => Date.now());
  const rule = useQuery({ queryKey: ['alert-rule', projectId, incident.ruleId], retry: false, staleTime: 60_000, queryFn: () => api<Rule>('GET', `${base}/alert-rules/${incident.ruleId}`) });
  const win = incidentWindow(incident, nowMs);
  const r = rule.data;
  const exQ = r ? exemplarQuery(r, incident, win) : null;
  const trQ = r ? failedTraceQuery(r, incident, win) : null;
  const exemplars = useQuery({ queryKey: ['related-exemplars', projectId, incident.id], enabled: !!exQ, retry: false, staleTime: 60_000, queryFn: () => api<MetricQueryResult>('POST', `${base}/metrics/query`, exQ) });
  const failed = useQuery({ queryKey: ['related-failed-traces', projectId, incident.id], enabled: !!exQ && !!trQ, retry: false, staleTime: 60_000, queryFn: () => api<{ items: TraceSummaryDto[] }>('POST', `${base}/traces/search`, trQ) });

  return (
    <Card title="Related telemetry">
      <div data-testid="related-panel" className="space-y-3 text-sm">
        {rule.isPending && <Loading label="Preparing links…" />}
        {rule.isError && <p className="text-slate-600 dark:text-slate-400" data-testid="related-unavailable">The rule behind this incident no longer exists or is not visible to you, so no links can be built.</p>}
        {r && (
          <>
            <p className="text-xs text-slate-600 dark:text-slate-400" data-testid="related-window">
              Window (UTC): <span className="font-mono">{fmtTime(win.from)}</span> to <span className="font-mono">{fmtTime(win.to)}</span>: from the start of the rule window that produced the first breaching value until {incident.resolvedAt ? 'the incident was resolved' : 'now'}.
            </p>
            <ul className="space-y-1">
              {r.query.kind === 'logs' && <li><Link className={link} data-testid="related-logs-link" to={logsLinkForRule(projectId, r, incident, win)!}>Open the matching logs in the Logs Explorer</Link> <span className="text-xs text-slate-600 dark:text-slate-400">with the rule’s filter and this window</span></li>}
              {r.query.kind === 'metric' && <li><Link className={link} data-testid="related-metrics-link" to={metricsLinkForRule(projectId, r, incident, win)!}>Open the metric in the Metrics explorer</Link> <span className="text-xs text-slate-600 dark:text-slate-400">with the rule’s metric, filters{incident.groupLabels && Object.keys(incident.groupLabels).length ? ', the incident’s group' : ''} and this window</span></li>}
              {tracesLinkForRule(projectId, r, incident, win) && <li><Link className={link} data-testid="related-traces-link" to={tracesLinkForRule(projectId, r, incident, win)!}>Failed traces of {incidentService(r, incident.groupLabels)} in the same window</Link> <span className="text-xs text-slate-600 dark:text-slate-400">a time-window link: approximate, limited to the traces that were sampled and received</span></li>}
            </ul>

            {r.query.kind === 'metric' && (
              <div data-testid="related-examples">
                <h3 className="font-semibold">Example traces</h3>
                {(exemplars.isPending || (!!trQ && failed.isPending)) && !exemplars.isError && <Loading label="Looking for example traces…" />}
                {exemplars.isError && <p className="text-xs text-slate-600 dark:text-slate-400" data-testid="related-examples-error">Could not look for example traces for this window ({exemplars.error.message}). The links above still work.</p>}
                {!exemplars.isPending && !exemplars.isError && !(trQ && failed.isPending) && (() => {
                  const examples = pickExamples(exemplars.data?.series.flatMap((s) => s.exemplars) ?? [], failed.data?.items ?? []);
                  return examples.length === 0
                    ? <p className="text-xs text-slate-600 dark:text-slate-400" data-testid="related-examples-empty">No example traces: this metric carries no exemplars in the window{trQ ? ' and no failed traces of the same service were stored for it' : ', and the rule has no service to look up traces by'}.</p>
                    : (
                      <>
                        <ul className="mt-1 space-y-1 text-xs" data-testid="related-example-list">{examples.map((e) => (
                          <li key={e.traceId}>{e.detail} → <Link className={link} to={exampleLink(projectId, e, incident.environmentId)}>trace {e.traceId.slice(0, 8)}…</Link></li>))}</ul>
                        <p className="mt-1 text-xs text-slate-600 dark:text-slate-400" data-testid="related-note"><strong>{EXAMPLES_HEADLINE}</strong> {EXAMPLES_DETAIL}</p>
                      </>
                    );
                })()}
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
