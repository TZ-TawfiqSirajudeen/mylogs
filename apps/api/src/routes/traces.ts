import {
  MAX_SPANS_PER_TRACE_RESPONSE, SpanDto, SpanParams, TraceDetail, TraceLogs, TraceParams, TraceQuery, TraceSearchResult, IdParam, LogQuery, type LogSummary as LogSummaryDto,
} from '@nexus/contracts';
import type { SpanDoc, TraceSummaryDoc } from '@nexus/database';
import type { LogStore, LogSummary } from '@nexus/logstore';
import { completenessWarnings, type TraceStore } from '@nexus/tracestore';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { sessionKey, type Authorize, type QueryMonitor } from './scope.js';

const iso = (d: Date) => d.toISOString();
const ns = (d: Date, frac: number) => (BigInt(d.getTime()) * 1_000_000n + BigInt(frac)).toString();

export const toTraceSummary = (s: TraceSummaryDoc) => ({
  traceId: s.traceId, environmentId: s.environmentId, start: iso(s.start), startUnixNano: (BigInt(s.start.getTime()) * 1_000_000n).toString(),
  durationNs: s.durationNs, durationMs: Math.round(s.durationNs / 1000) / 1000, spanCount: s.spanCount, errorCount: s.errorCount, services: s.services,
  rootName: s.rootName, rootService: s.rootService, rootSpanId: s.rootSpanId, httpMethod: s.httpMethod, httpRoute: s.httpRoute, httpStatus: s.httpStatus,
  completeness: s.hasRoot && s.orphanCount === 0 ? ('complete' as const) : ('partial' as const), hasRoot: s.hasRoot, orphanCount: s.orphanCount, invalidTimingCount: s.invalidTimingCount,
});

export const toSpanDto = (s: SpanDoc) => ({
  traceId: s.traceId, spanId: s.spanId, parentSpanId: s.parentSpanId, environmentId: s.environmentId, name: s.name, kind: s.kind, statusCode: s.statusCode,
  statusMessage: s.statusMessage, service: s.service, serviceVersion: s.serviceVersion, host: s.host, deployment: s.deployment,
  startUnixNano: ns(s.start, s.startNsFrac), endUnixNano: ns(s.end, s.endNsFrac), durationNs: s.durationNs, timingValid: s.timingValid,
  httpMethod: s.httpMethod, httpRoute: s.httpRoute, httpStatus: s.httpStatus, dbSystem: s.dbSystem, peerService: s.peerService, exceptionType: s.exceptionType,
  scopeName: s.scopeName, scopeVersion: s.scopeVersion, traceState: s.traceState, flags: s.flags,
  attrs: s.attrs, resource: s.resource,
  events: s.events.map((e) => ({ ts: iso(e.ts), tsUnixNano: ns(e.ts, e.tsNsFrac), name: e.name, attrs: e.attrs, droppedAttrs: e.droppedAttrs })),
  links: s.links, droppedAttrs: s.droppedAttrs, droppedEvents: s.droppedEvents, droppedLinks: s.droppedLinks, attrsTruncated: s.attrsTruncated, redactions: s.redactions,
});

const toLogSummary = (d: LogSummary): LogSummaryDto => ({
  id: d._id, ts: iso(d.ts), severity: d.severity, message: d.message, service: d.service, host: d.host, traceId: d.traceId, spanId: d.spanId, requestId: d.requestId,
  httpMethod: d.httpMethod, httpRoute: d.httpRoute, httpStatus: d.httpStatus, durationMs: d.durationMs, errorType: d.errorType, environmentId: d.environmentId, redactions: d.redactions, hasStack: d.hasStack,
});

export function traceRoutes(deps: { traces: TraceStore; logs: LogStore; authorize: Authorize; monitor: QueryMonitor; cookieName: string }) {
  const { traces, logs, authorize, monitor } = deps;
  return async (app: FastifyInstance) => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const pre = { onRequest: app.authenticate };
    const throttle = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute', keyGenerator: (req: Parameters<typeof sessionKey>[0]) => sessionKey(req, deps.cookieName) } });

    r.post('/api/v1/projects/:projectId/traces/search', {
      ...pre, config: throttle(120),
      schema: { tags: ['traces'], summary: 'Search traces (validated query builder; scoped to the caller\'s environments)', params: IdParam, body: TraceQuery, response: { 200: TraceSearchResult } },
    }, async (req) => {
      const { scope } = await authorize(req, req.params.projectId, 'telemetry:read');
      const res = await monitor.time('traces.search', () => traces.search(scope, req.body));
      return { items: res.items.map(toTraceSummary), nextCursor: res.nextCursor };
    });

    r.get('/api/v1/projects/:projectId/traces/:traceId', {
      ...pre, config: throttle(240),
      schema: { tags: ['traces'], summary: `One trace: summary and up to ${MAX_SPANS_PER_TRACE_RESPONSE} spans in start order, with plain-language completeness warnings`, params: TraceParams, response: { 200: TraceDetail } },
    }, async (req, reply) => {
      const { scope } = await authorize(req, req.params.projectId, 'telemetry:read');
      const t = await monitor.time('traces.get', () => traces.getTrace(scope, req.params.traceId, MAX_SPANS_PER_TRACE_RESPONSE));
      // A trace the caller may not see and a trace that does not exist are indistinguishable: both 404.
      if (!t) throw new AppError(404, 'not_found', 'Trace not found. It may not have arrived yet, may have expired, or may belong to an environment you cannot access.');
      reply.header('cache-control', 'private, no-store');
      return { summary: toTraceSummary(t.summary), spans: t.spans.map(toSpanDto), totalSpans: t.totalSpans, truncated: t.truncated, warnings: completenessWarnings(t.summary, t.truncated, t.totalSpans) };
    });

    r.get('/api/v1/projects/:projectId/traces/:traceId/spans/:spanId', {
      ...pre, config: throttle(240),
      schema: { tags: ['traces'], summary: 'One span with all attributes, events and links', params: SpanParams, response: { 200: SpanDto } },
    }, async (req, reply) => {
      const { scope } = await authorize(req, req.params.projectId, 'telemetry:read');
      const s = await monitor.time('traces.span', () => traces.getSpan(scope, req.params.traceId, req.params.spanId));
      if (!s) throw new AppError(404, 'not_found', 'Span not found');
      reply.header('cache-control', 'private, no-store');
      return toSpanDto(s);
    });

    r.get('/api/v1/projects/:projectId/traces/:traceId/logs', {
      ...pre, config: throttle(120),
      schema: {
        tags: ['traces', 'logs'], summary: 'Logs that carry this trace id (same project, only environments the caller may read)', params: TraceParams,
        querystring: z.object({ from: z.iso.datetime().optional(), to: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(500).default(200) }),
        response: { 200: TraceLogs },
      },
    }, async (req) => {
      const { scope } = await authorize(req, req.params.projectId, 'telemetry:read');
      const known = await traces.knownTraces(scope, [req.params.traceId]);
      const trace = known.has(req.params.traceId) ? await traces.getTrace(scope, req.params.traceId, 1) : null;
      // Around a known trace: its own time range +- 1 h. Otherwise the caller's window (default: the last 7 days).
      const now = Date.now();
      const from = req.query.from ?? new Date((trace ? trace.summary.start.getTime() : now - 7 * 86_400_000) - (trace ? 3_600_000 : 0)).toISOString();
      const to = req.query.to ?? new Date((trace ? trace.summary.end.getTime() + 3_600_000 : now) + 60_000).toISOString();
      const parsed = LogQuery.safeParse({ from, to, filters: [{ field: 'traceId', op: 'eq', value: req.params.traceId }], sort: 'asc', limit: req.query.limit });
      if (!parsed.success) throw new AppError(400, 'validation_error', parsed.error.issues[0]?.message ?? 'Invalid time range');
      const q = parsed.data;
      const res = await monitor.time('traces.logs', () => logs.search(scope, q));
      const bySpan: Record<string, number> = {};
      for (const l of res.items) if (l.spanId) bySpan[l.spanId] = (bySpan[l.spanId] ?? 0) + 1;
      return { traceKnown: known.has(req.params.traceId), logs: res.items.map(toLogSummary), truncated: res.nextCursor !== null, bySpan };
    });
  };
}
