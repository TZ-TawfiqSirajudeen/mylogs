import {
  IdParam, MetricLabelInfo, MetricNameInfo, MetricQuery, MetricQueryResult, ServiceOverview, TelemetryDiagnostics, TraceQuery, TraceSearchResult,
  type ServiceHealth,
} from '@nexus/contracts';
import type { Database, ServiceDoc } from '@nexus/database';
import { readIngestStats } from '@nexus/ingest';
import { MetricQueryError, type MetricStore } from '@nexus/metricstore';
import type { TraceStore } from '@nexus/tracestore';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { ScopedCache, sessionKey, type Authorize, type QueryMonitor, type TelemetryScope } from './scope.js';
import { toTraceSummary } from './traces.js';

/** Telemetry newer than this counts as "active". Anything older is "stale": seen before, but silent now. */
export const FRESHNESS_WINDOW_MS = 10 * 60_000;
const MAX_ENVS_PER_OVERVIEW = 10;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const pct = (sorted: number[], p: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]! : null);
const round3 = (n: number) => Math.round(n * 1000) / 1000;

const mapMetricError = <T>(fn: () => Promise<T>) => fn().catch((e) => { if (e instanceof MetricQueryError) throw new AppError(e.status, e.code, e.message); throw e; });

export function observabilityRoutes(deps: { db: Database; traces: TraceStore; metrics: MetricStore; authorize: Authorize; monitor: QueryMonitor; cookieName: string; now?: () => Date }) {
  const { db, traces, metrics, authorize, monitor } = deps;
  const now = deps.now ?? (() => new Date());
  const overviewCache = new ScopedCache<z.infer<typeof ServiceOverview>>(10_000);
  const metricCache = new ScopedCache<MetricQueryResult>(10_000);
  type MetricQueryResult = z.infer<typeof MetricQueryResult>;

  /** One row per service per environment. Numbers come from explicit HTTP server metrics when present, otherwise from stored SERVER spans (labelled), never both. */
  async function buildOverview(scope: TelemetryScope, minutes: number) {
    const to = now();
    const from = new Date(to.getTime() - minutes * 60_000);
    const envScopes = scope.environmentIds.slice(0, MAX_ENVS_PER_OVERVIEW);
    const notes: string[] = [];
    if (scope.environmentIds.length > MAX_ENVS_PER_OVERVIEW) notes.push(`Only the first ${MAX_ENVS_PER_OVERVIEW} environments are summarised; select an environment to see the others.`);
    const inventory = await db.c.services.find({ orgId: scope.orgId, projectId: scope.projectId, environmentId: { $in: scope.environmentIds } }).limit(500).maxTimeMS(8000).toArray();
    const windowSec = (to.getTime() - from.getTime()) / 1000;
    const services: ServiceHealth[] = [];
    let stepMs = 60_000;
    const edges: z.infer<typeof ServiceOverview>['dependencies'] = { edges: [], sampled: false };

    for (const envId of envScopes) {
      const one: TelemetryScope = { ...scope, environmentIds: [envId] };
      const [http, stats, deps2] = await Promise.all([
        metrics.httpOverview(one, from, to), traces.serverSpanStats(one, from, to), traces.dependencies(one, from, to),
      ]);
      stepMs = http.stepMs;
      const timeline = await traces.serverSpanTimeline(one, from, to, stepMs);
      for (const e of deps2.edges) edges.edges.push(e);
      edges.sampled ||= deps2.sampled;
      notes.push(...http.notes);
      const mine = inventory.filter((s: ServiceDoc) => s.environmentId === envId);
      const names = new Set<string>([...mine.map((s) => s.name), ...http.services.map((s) => s.service), ...stats.map((s) => s.service)]);
      for (const name of [...names].sort()) {
        const inv = mine.find((s) => s.name === name);
        const m = http.services.find((s) => s.service === name);
        const sp = stats.find((s) => s.service === name);
        const lastSeen = [inv?.lastSpanAt, inv?.lastMetricAt, inv?.lastLogAt, m?.lastDataAt, sp?.lastSpanAt].filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
        const traceCount = await db.c.traceSummaries.countDocuments({ orgId: scope.orgId, projectId: scope.projectId, environmentId: envId, services: name, start: { $gte: from, $lte: to } }, { limit: 10_000, maxTimeMS: 5000 }).catch(() => null);
        const base = {
          service: name, environmentId: envId, version: inv?.version ?? null, statuses: {} as Record<string, number>, routes: [] as ServiceHealth['routes'], timeline: [] as ServiceHealth['timeline'],
          lastSpanAt: iso(inv?.lastSpanAt), lastMetricAt: iso(inv?.lastMetricAt), lastLogAt: iso(inv?.lastLogAt), traceCount,
          freshness: !lastSeen ? ('unknown' as const) : now().getTime() - lastSeen.getTime() <= FRESHNESS_WINDOW_MS ? ('active' as const) : ('stale' as const),
        };
        if (m) {
          services.push({
            ...base, source: 'metrics', sourceDetail: `Explicit OTLP metric "${m.metric}" (authoritative). Trace-derived numbers are not mixed in.`,
            requests: m.requests, errors: m.errors, errorRate: m.requests ? round3(m.errors / m.requests) : null, ratePerSec: round3(m.requests / windowSec),
            p50Ms: m.p50Ms, p95Ms: m.p95Ms, p99Ms: m.p99Ms, statuses: m.statuses, routes: m.routes, timeline: m.timeline,
          });
        } else if (sp && sp.spans > 0) {
          const sorted = [...sp.durationsNs].sort((a, b) => a - b).map((n) => n / 1e6);
          const steps = new Map(timeline.filter((t) => t.service === name).map((t) => [t.t, t]));
          const tl: ServiceHealth['timeline'] = [];
          for (let t = Math.floor(from.getTime() / stepMs) * stepMs; t <= to.getTime(); t += stepMs) { const c = steps.get(t); tl.push({ t, requests: c ? c.count : null, errors: c ? c.errors : null, p95Ms: null }); }
          services.push({
            ...base, source: 'traces',
            sourceDetail: `Derived from ${sp.spans.toLocaleString('en')} stored SERVER spans. This reflects only the traces that were SAMPLED and received; it is not the true request count${sp.sampled ? ' (latency percentiles use the most recent 50,000 spans)' : ''}.`,
            requests: sp.spans, errors: sp.errors, errorRate: sp.spans ? round3(sp.errors / sp.spans) : null, ratePerSec: round3(sp.spans / windowSec),
            p50Ms: sorted.length ? round3(pct(sorted, 0.5)!) : null, p95Ms: sorted.length ? round3(pct(sorted, 0.95)!) : null, p99Ms: sorted.length ? round3(pct(sorted, 0.99)!) : null, timeline: tl,
          });
        } else {
          services.push({ ...base, source: 'none', sourceDetail: 'No HTTP server metrics or server spans were received in this window, so no request statistics can be shown.', requests: null, errors: null, errorRate: null, ratePerSec: null, p50Ms: null, p95Ms: null, p99Ms: null });
        }
      }
    }
    const merged = new Map<string, (typeof edges.edges)[number]>();
    for (const e of edges.edges) {
      const k = `${e.from}|${e.to}|${e.kind}|${e.basis}`;
      const c = merged.get(k);
      if (c) { c.calls += e.calls; c.errors += e.errors; } else merged.set(k, { ...e });
    }
    return {
      from: from.toISOString(), to: to.toISOString(), stepMs, freshnessWindowMs: FRESHNESS_WINDOW_MS,
      services: services.sort((a, b) => a.service.localeCompare(b.service) || a.environmentId.localeCompare(b.environmentId)),
      dependencies: { edges: [...merged.values()].sort((a, b) => b.calls - a.calls), sampled: edges.sampled },
      notes: [...new Set(notes)],
    };
  }

  return async (app: FastifyInstance) => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const pre = { onRequest: app.authenticate };
    const throttle = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute', keyGenerator: (req: Parameters<typeof sessionKey>[0]) => sessionKey(req, deps.cookieName) } });

    // ------------------------------------------------------------------ services
    r.get('/api/v1/projects/:projectId/services', {
      ...pre, config: throttle(60),
      schema: { tags: ['services'], summary: 'Observed services with request rate, errors, latency, freshness and dependencies', params: IdParam, querystring: z.object({ minutes: z.coerce.number().int().min(5).max(1440).default(60) }), response: { 200: ServiceOverview } },
    }, async (req, reply) => {
      const { scope } = await authorize(req, req.params.projectId, 'telemetry:read');
      // Cached for a few seconds per authorized scope (organization + project + exact environment set): never shared across permission boundaries.
      const key = overviewCache.key(scope, 'overview', req.query.minutes);
      const { value } = await overviewCache.get(key, () => monitor.time('services.overview', () => buildOverview(scope, req.query.minutes)));
      reply.header('cache-control', 'private, max-age=0, no-store');
      return value;
    });

    r.get('/api/v1/projects/:projectId/services/:service', {
      ...pre, config: throttle(60),
      schema: {
        tags: ['services'], summary: 'One service: its health row plus representative slow and failed traces from the same window (a time-window correlation, not proof of cause)',
        params: z.object({ projectId: IdParam.shape.projectId, service: z.string().min(1).max(128) }), querystring: z.object({ minutes: z.coerce.number().int().min(5).max(1440).default(60), environmentId: z.uuid().optional() }),
        response: { 200: z.object({ health: z.array(ServiceOverview.shape.services.element), slowTraces: TraceSearchResult.shape.items, errorTraces: TraceSearchResult.shape.items, correlation: z.string() }) },
      },
    }, async (req) => {
      const { scope } = await authorize(req, req.params.projectId, 'telemetry:read');
      const narrowed: TelemetryScope = { ...scope, environmentIds: req.query.environmentId ? scope.environmentIds.filter((e) => e === req.query.environmentId) : scope.environmentIds };
      if (!narrowed.environmentIds.length) throw new AppError(404, 'not_found', 'Service not found');
      const ov = await monitor.time('services.overview', () => buildOverview(narrowed, req.query.minutes));
      const health = ov.services.filter((s) => s.service === req.params.service);
      if (!health.length) throw new AppError(404, 'not_found', 'Service not found. No telemetry from it has been received in the environments you can access.');
      const range = { from: ov.from, to: ov.to, services: [req.params.service], limit: 10 } as const;
      const [slow, err] = await Promise.all([
        traces.search(narrowed, TraceQuery.parse({ ...range, sort: 'slowest' })),
        traces.search(narrowed, TraceQuery.parse({ ...range, errorsOnly: true })),
      ]);
      return {
        health, slowTraces: slow.items.map(toTraceSummary), errorTraces: err.items.map(toTraceSummary),
        correlation: 'These traces are the slowest and the failed ones seen for this service in the same time window. They are representative evidence, not proof that they caused a change in the metrics: only the traces that were sampled and received appear here.',
      };
    });

    // ------------------------------------------------------------------ metrics
    r.get('/api/v1/projects/:projectId/metrics/names', {
      ...pre, config: throttle(60), schema: { tags: ['metrics'], summary: 'Metric names that exist in the caller\'s environments', params: IdParam, response: { 200: z.array(MetricNameInfo) } },
    }, async (req) => {
      const { scope } = await authorize(req, req.params.projectId, 'telemetry:read');
      return (await monitor.time('metrics.names', () => metrics.names(scope))).map((n) => ({ ...n, lastSeen: n.lastSeen.toISOString() }));
    });

    r.get('/api/v1/projects/:projectId/metrics/labels', {
      ...pre, config: throttle(60), schema: { tags: ['metrics'], summary: 'Label keys and values seen for one metric', params: IdParam, querystring: z.object({ metric: z.string().min(1).max(200) }), response: { 200: z.array(MetricLabelInfo) } },
    }, async (req) => {
      const { scope } = await authorize(req, req.params.projectId, 'telemetry:read');
      return monitor.time('metrics.labels', () => metrics.labels(scope, req.query.metric));
    });

    r.post('/api/v1/projects/:projectId/metrics/query', {
      ...pre, config: throttle(120),
      schema: { tags: ['metrics'], summary: 'Bounded metric query (time range, series, points and scanned data are all limited). No free-form expressions.', params: IdParam, body: MetricQuery, response: { 200: MetricQueryResult } },
    }, async (req, reply) => {
      const { scope } = await authorize(req, req.params.projectId, 'telemetry:read');
      const key = metricCache.key(scope, 'query', req.body);
      const { value } = await metricCache.get(key, () => monitor.time('metrics.query', () => mapMetricError(() => metrics.query(scope, req.body))));
      reply.header('cache-control', 'private, no-store');
      return value;
    });

    // ------------------------------------------------------------------ diagnostics
    r.get('/api/v1/projects/:projectId/telemetry/diagnostics', {
      ...pre, config: throttle(30),
      schema: {
        tags: ['ingestion'], summary: 'Ingestion and storage health per signal, plus query timings of this API process', params: IdParam,
        querystring: z.object({ minutes: z.coerce.number().int().min(5).max(1440).default(60) }),
        response: { 200: TelemetryDiagnostics.extend({ queries: z.array(z.object({ kind: z.string(), count: z.number(), failures: z.number(), p50Ms: z.number(), p95Ms: z.number() })) }) },
      },
    }, async (req) => {
      const { scope } = await authorize(req, req.params.projectId, 'telemetry:read');
      const match = { orgId: scope.orgId, projectId: scope.projectId, environmentId: { $in: scope.environmentIds } };
      const signals: z.infer<typeof TelemetryDiagnostics>['signals'] = {};
      for (const signal of ['logs', 'traces', 'metrics'] as const) {
        const rows = await db.c.ingestStats.find({ ...match, minute: { $gte: new Date(now().getTime() - req.query.minutes * 60_000) }, ...(signal === 'logs' ? { signal: { $in: ['logs', null] } } : { signal }) } as never).limit(100_000).toArray();
        const sum = (k: 'requests' | 'accepted' | 'duplicates' | 'rejectedInvalid' | 'rejectedQuota' | 'rejectedOverload' | 'rejectedStorage' | 'redactions') => rows.reduce((n, x) => n + (x[k] ?? 0), 0);
        const last = rows.filter((x) => (x.accepted ?? 0) > 0).sort((a, b) => b.minute.getTime() - a.minute.getTime())[0];
        signals[signal] = {
          requests: sum('requests'), accepted: sum('accepted'), duplicates: sum('duplicates'), redactions: sum('redactions'), lastAcceptedAt: iso(last?.minute),
          rejectedInvalid: sum('rejectedInvalid'), rejectedQuota: sum('rejectedQuota'), rejectedOverload: sum('rejectedOverload'), rejectedStorage: sum('rejectedStorage'),
          refused: sum('rejectedInvalid') + sum('rejectedQuota') + sum('rejectedOverload') + sum('rejectedStorage'),
        };
      }
      const [spans, traceSummaries, logCount, metricDiag] = await Promise.all([
        db.c.spans.countDocuments(match, { maxTimeMS: 5000 }), db.c.traceSummaries.countDocuments(match, { maxTimeMS: 5000 }), db.c.logs.countDocuments(match, { maxTimeMS: 5000 }), metrics.diagnostics(scope),
      ]);
      void readIngestStats;
      return { window: { minutes: req.query.minutes }, signals, storage: { spans, traceSummaries, logs: logCount, metrics: metricDiag }, queries: monitor.snapshot() };
    });
  };
}
