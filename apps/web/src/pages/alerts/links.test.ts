import type { AlertRuleDto } from '@nexus/contracts';
import { describe, expect, test } from 'vitest';
import {
  EXAMPLES_HEADLINE, exemplarQuery, failedTraceQuery, incidentService, incidentWindow, logsLinkForRule, MAX_EXAMPLES, MAX_WINDOW_MS, metricFilters, metricsLinkForRule, MIN_WINDOW_MS,
  pickExamples, tracesLinkForRule,
} from './links';

const P = '11111111-1111-4111-8111-111111111111';
const ENV = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-03-01T12:00:00Z');
const inc = (over: Record<string, unknown> = {}) => ({ openedAt: '2026-03-01T11:00:00.000Z', resolvedAt: '2026-03-01T11:30:00.000Z', condition: { windowSeconds: 300 }, groupLabels: {} as Record<string, string>, environmentId: ENV, ...over });
const metricRule = (q: Record<string, unknown> = {}) => ({ query: { kind: 'metric', metric: 'http.server.errors', agg: 'rate', filters: [{ key: 'route', value: '/pay' }], groupBy: [], ...q } }) as unknown as Pick<AlertRuleDto, 'query'>;
const logRule = (q: Record<string, unknown> = {}) => ({ query: { kind: 'logs', filters: [{ field: 'httpStatus', op: 'gte', value: 500 }], errorsOnly: true, text: 'timeout', services: ['checkout'], ...q } }) as unknown as Pick<AlertRuleDto, 'query'>;

describe('incidentWindow', () => {
  test('starts one rule-window before the incident opened and ends when it was resolved', () => {
    expect(incidentWindow(inc(), NOW)).toEqual({ from: '2026-03-01T10:55:00.000Z', to: '2026-03-01T11:30:00.000Z' });
  });
  test('a live incident ends now; a very short one is widened to 5 minutes; a very long one is cut to 24 hours', () => {
    expect(incidentWindow(inc({ resolvedAt: null }), NOW).to).toBe('2026-03-01T12:00:00.000Z');
    const short = incidentWindow(inc({ resolvedAt: '2026-03-01T11:00:10.000Z' }), NOW);
    expect(Date.parse(short.to) - Date.parse('2026-03-01T11:00:00.000Z')).toBe(MIN_WINDOW_MS);
    const long = incidentWindow(inc({ resolvedAt: null, openedAt: '2026-02-20T00:00:00.000Z' }), NOW);
    expect(Date.parse(long.to) - Date.parse(long.from)).toBe(MAX_WINDOW_MS);
  });
});

describe('logs link for a log-count rule', () => {
  const win = incidentWindow(inc(), NOW);
  test('pre-fills the rule filter, the environment and the window, and carries only ids, filters and times', () => {
    const u = new URL(logsLinkForRule(P, logRule(), inc(), win)!, 'http://x');
    expect(u.pathname).toBe('/logs');
    const sp = u.searchParams;
    expect(sp.get('p')).toBe(P);
    expect(sp.get('range')).toBe('custom');
    expect(sp.get('from')).toBe(win.from);
    expect(sp.get('to')).toBe(win.to);
    expect(sp.get('q')).toBe('timeout');
    expect(sp.get('err')).toBe('1');
    expect(sp.get('svc')).toBe('checkout');
    expect(sp.get('env')).toBe(ENV);
    expect(sp.getAll('f')).toEqual(['httpStatus~gte~500']);
    expect([...new Set(sp.keys())].sort()).toEqual(['env', 'err', 'f', 'from', 'p', 'q', 'range', 'svc', 'to']);
  });
  test('minimum severity is used when errors-only is off; a metric rule has no logs link', () => {
    const sp = new URL(logsLinkForRule(P, logRule({ errorsOnly: false, minSeverity: 'warn', text: undefined, services: undefined, filters: [] }), inc(), win)!, 'http://x').searchParams;
    expect(sp.get('sev')).toBe('warn');
    expect(sp.has('err')).toBe(false);
    expect(sp.has('q')).toBe(false);
    expect(logsLinkForRule(P, metricRule(), inc(), win)).toBeNull();
  });
});

describe('metrics link and example queries for a metric rule', () => {
  const win = incidentWindow(inc(), NOW);
  test('carries metric, aggregation, rule filters, group labels (service goes to the selector), environment and window', () => {
    const i = inc({ groupLabels: { service: 'checkout', region: 'eu' } });
    const sp = new URL(metricsLinkForRule(P, metricRule({ groupBy: ['service'] }), i, win)!, 'http://x').searchParams;
    expect(Object.fromEntries(sp)).toMatchObject({ p: P, metric: 'http.server.errors', agg: 'rate', range: 'custom', from: win.from, to: win.to, env: ENV, svc: 'checkout' });
    expect(sp.getAll('f')).toEqual(['route~/pay', 'region~eu']);
    expect(metricsLinkForRule(P, logRule(), inc(), win)).toBeNull();
  });
  test('filters are capped at 5 and never duplicated', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ key: `k${i}`, value: 'v' }));
    expect(metricFilters(metricRule({ filters: many }), { extra: 'x', k0: 'other' })).toHaveLength(5);
    expect(metricFilters(metricRule({ filters: [{ key: 'region', value: 'us' }] }), { region: 'eu' })).toEqual([{ key: 'region', value: 'us' }]);
  });
  test('the service comes from the rule, else from the group; log rules use a single configured service', () => {
    expect(incidentService(metricRule({ service: 'api' }), { service: 'x' })).toBe('api');
    expect(incidentService(metricRule(), { service: 'x' })).toBe('x');
    expect(incidentService(metricRule(), {})).toBeNull();
    expect(incidentService(logRule({ services: ['a', 'b'] }), {})).toBeNull();
    expect(incidentService(logRule(), {})).toBe('checkout');
  });
  test('example queries are scoped to the environment and the window, and the failed-trace search needs a service', () => {
    const eq = exemplarQuery(metricRule({ service: 'api' }), inc(), win)!;
    expect(eq).toMatchObject({ metric: 'http.server.errors', agg: 'rate', service: 'api', environmentIds: [ENV], from: win.from, to: win.to, groupBy: [] });
    expect(failedTraceQuery(metricRule({ service: 'api' }), inc(), win)).toEqual({ from: win.from, to: win.to, services: ['api'], errorsOnly: true, environmentIds: [ENV], sort: 'recent', limit: 5 });
    expect(failedTraceQuery(metricRule(), inc(), win)).toBeNull();
    expect(tracesLinkForRule(P, metricRule(), inc(), win)).toBeNull();
    const t = new URL(tracesLinkForRule(P, metricRule({ service: 'api' }), inc(), win)!, 'http://x');
    expect(t.pathname).toBe('/traces');
    expect(t.searchParams.get('svc')).toBe('api');
    expect(t.searchParams.get('err')).toBe('1');
    expect(t.searchParams.get('env')).toBe(ENV);
  });
  test('no link contains anything but ids, filters and times (no token-like or session-like parameter)', () => {
    const i = inc({ groupLabels: { service: 'checkout' } });
    const urls = [logsLinkForRule(P, logRule(), i, win), metricsLinkForRule(P, metricRule(), i, win), tracesLinkForRule(P, metricRule({ service: 'a' }), i, win)].filter(Boolean) as string[];
    expect(urls).toHaveLength(3);
    const allowed = new Set(['p', 'env', 'range', 'from', 'to', 'q', 'err', 'sev', 'svc', 'f', 'metric', 'agg', 'sort']);
    for (const u of urls) for (const k of new URL(u, 'http://x').searchParams.keys()) expect(allowed.has(k), `${u} -> ${k}`).toBe(true);
  });
});

describe('pickExamples', () => {
  const ex = (n: number, ts = `2026-03-01T11:0${n}:00.000Z`) => ({ traceId: String(n).padStart(32, 'a'), spanId: String(n).padStart(16, 'b'), value: n * 1.5, ts });
  const fail = (n: number) => ({ traceId: String(n + 100).padStart(32, 'c'), start: `2026-03-01T11:1${n}:00.000Z`, rootName: 'GET /pay', rootService: 'api', errorCount: 2 });
  test('exemplars first (newest first), then failed traces, at most 5, one entry per trace', () => {
    const out = pickExamples([ex(1), ex(3), ex(2)], [fail(1), fail(2), fail(3), fail(4)]);
    expect(out).toHaveLength(MAX_EXAMPLES);
    expect(out.slice(0, 3).map((e) => e.kind)).toEqual(['exemplar', 'exemplar', 'exemplar']);
    expect(out.slice(0, 3).map((e) => e.traceId)).toEqual([ex(3).traceId, ex(2).traceId, ex(1).traceId]);
    expect(out.slice(3).every((e) => e.kind === 'failed')).toBe(true);
    expect(new Set(out.map((e) => e.traceId)).size).toBe(5);
  });
  test('a trace that is both an exemplar and failed is listed once; nothing at all gives an empty list', () => {
    const same = { ...fail(1), traceId: ex(1).traceId };
    expect(pickExamples([ex(1)], [same])).toHaveLength(1);
    expect(pickExamples([], [])).toEqual([]);
  });
  test('the wording is the "not proof of cause" statement used by the other navigation', () => {
    expect(EXAMPLES_HEADLINE).toBe('A sample from the window, not proof of cause.');
  });
});
