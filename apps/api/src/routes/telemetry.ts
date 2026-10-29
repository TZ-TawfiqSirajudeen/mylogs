import { createHash } from 'node:crypto';
import {
  ExportBody, IngestStatsDto, IngestTokenCreate, IngestTokenCreated, IngestTokenDto, LogContext, LogDetail, LogFacets, LogHistogram, LogParams,
  LogQuery, LogSearchResult, SavedQueryCreate, SavedQueryDto, SavedQueryParams, TailBody, TokenParams, IdParam, ConnectionParams,
  type LogSummary as LogSummaryDto,
} from '@nexus/contracts';
import type { Database, LogDoc } from '@nexus/database';
import { IngestTokenService, TokenError, readIngestStats } from '@nexus/ingest';
import { encodeCursor, type LogStore, type LogSummary, type Scope } from '@nexus/logstore';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ProjectAction } from '../authz/policy.js';
import { AppError } from '../errors.js';
import { principalOf } from '../plugins/auth.js';
import type { AuditService } from '../services/audit.js';
import type { ProjectService } from '../services/projects.js';

const MAX_EXPORT_ROWS = 10_000;
const MAX_TAILS_PER_USER = 3;
const MAX_TAIL_MS = 10 * 60_000;
const HISTORY_KEEP = 20;
const MAX_SAVED_PER_USER = 50;

const iso = (d: Date) => d.toISOString();
const toSummary = (d: LogSummary): LogSummaryDto => ({
  id: d._id, ts: iso(d.ts), severity: d.severity, message: d.message, service: d.service, host: d.host, traceId: d.traceId, spanId: d.spanId,
  requestId: d.requestId, httpMethod: d.httpMethod, httpRoute: d.httpRoute, httpStatus: d.httpStatus, durationMs: d.durationMs,
  errorType: d.errorType, environmentId: d.environmentId, redactions: d.redactions, hasStack: d.hasStack,
});
const toDetail = (d: LogDoc) => ({
  ...toSummary({ ...d, hasStack: !!d.stack }), projectId: d.projectId, serviceVersion: d.serviceVersion, deployment: d.deployment, container: d.container,
  exceptionMessage: d.exceptionMessage, stack: d.stack, scope: d.scope, source: d.source, severityText: d.severityText, tsSource: d.tsSource,
  tsAdjusted: d.tsAdjusted, receivedAt: iso(d.receivedAt), expireAt: iso(d.expireAt), attrs: d.attrs, resource: d.resource,
  attrsTruncated: d.attrsTruncated, messageTruncated: d.messageTruncated,
});

/** CSV cells that start with = + - @ are interpreted as formulas by spreadsheets; neutralise them. */
const csvCell = (v: unknown): string => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const CSV_COLUMNS = ['ts', 'severity', 'service', 'host', 'environmentId', 'traceId', 'spanId', 'requestId', 'httpMethod', 'httpRoute', 'httpStatus', 'durationMs', 'errorType', 'message'] as const;

export function telemetryRoutes(deps: {
  db: Database; projects: ProjectService; store: LogStore; tokens: IngestTokenService; audit: AuditService; cookieName: string; ingestPublicUrl: string;
}) {
  const { db, projects, store, tokens, audit } = deps;
  const tails = new Map<string, number>();

  return async (app: FastifyInstance) => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const pre = { onRequest: app.authenticate };
    const sessionKey = (req: FastifyRequest) => createHash('sha256').update(req.cookies?.[deps.cookieName] ?? req.ip).digest('hex').slice(0, 24);
    const throttle = (max: number) => ({ rateLimit: { max, timeWindow: '1 minute', keyGenerator: sessionKey } });
    const actorOf = (req: FastifyRequest) => ({ userId: req.auth!.user._id, ctx: { requestId: req.id, ip: req.ip } });

    /** Authorization for everything here: project access -> the exact set of environments this caller may read. */
    async function authorize(req: FastifyRequest, projectId: string, action: ProjectAction) {
      const p = principalOf(req);
      const { access } = await projects.requireProject(p, projectId, action);
      let environmentIds = access.environmentIds;
      if (environmentIds === null) {
        environmentIds = (await db.c.environments.find({ orgId: p.orgId, projectId }).project({ _id: 1 }).toArray()).map((e) => e._id as string);
      }
      const scope: Scope = { orgId: p.orgId, projectId, environmentIds };
      return { p, access, scope };
    }
    const mapTokenError = <T>(fn: () => Promise<T>) => fn().catch((e) => { if (e instanceof TokenError) throw new AppError(e.status, e.code, e.message); throw e; });

    r.get('/api/v1/telemetry/endpoints', {
      onRequest: app.authenticate,
      schema: { tags: ['ingestion'], summary: 'Where to send telemetry', response: { 200: z.object({ otlpHttpLogs: z.string(), otlpHttpTraces: z.string(), otlpHttpMetrics: z.string(), jsonLogs: z.string(), ingestBase: z.string() }) } },
    }, async () => ({
      ingestBase: deps.ingestPublicUrl, otlpHttpLogs: `${deps.ingestPublicUrl}/v1/logs`, otlpHttpTraces: `${deps.ingestPublicUrl}/v1/traces`,
      otlpHttpMetrics: `${deps.ingestPublicUrl}/v1/metrics`, jsonLogs: `${deps.ingestPublicUrl}/v1/json-logs`,
    }));

    // ------------------------------------------------------------------ ingestion tokens
    r.get('/api/v1/projects/:projectId/ingest-tokens', {
      ...pre, schema: { tags: ['ingestion'], summary: 'Ingestion tokens (project admins)', params: IdParam, response: { 200: z.array(IngestTokenDto) } },
    }, async (req) => {
      const { p, access } = await authorize(req, req.params.projectId, 'connection:manage');
      return tokens.list({ orgId: p.orgId, projectId: req.params.projectId, environmentIds: access.environmentIds });
    });

    r.post('/api/v1/projects/:projectId/environments/:environmentId/ingest-tokens', {
      ...pre, schema: { tags: ['ingestion'], summary: 'Create an ingestion token. The token is shown ONCE.', params: ConnectionParams, body: IngestTokenCreate, response: { 201: IngestTokenCreated } },
    }, async (req, reply) => {
      const { p, access } = await authorize(req, req.params.projectId, 'connection:manage');
      const created = await mapTokenError(() => tokens.create({ orgId: p.orgId, projectId: req.params.projectId, environmentIds: access.environmentIds }, req.params.environmentId, actorOf(req), req.body));
      reply.header('cache-control', 'no-store');
      return reply.code(201).send(created);
    });

    r.delete('/api/v1/projects/:projectId/ingest-tokens/:tokenId', {
      ...pre, schema: { tags: ['ingestion'], params: TokenParams, response: { 204: z.null() } },
    }, async (req, reply) => {
      const { p, access } = await authorize(req, req.params.projectId, 'connection:manage');
      await mapTokenError(() => tokens.revoke({ orgId: p.orgId, projectId: req.params.projectId, environmentIds: access.environmentIds }, req.params.tokenId, actorOf(req)));
      return reply.code(204).send(null);
    });

    r.get('/api/v1/projects/:projectId/ingest/stats', {
      ...pre, schema: { tags: ['ingestion'], summary: 'What arrived and what was refused, per environment', params: IdParam, querystring: z.object({ minutes: z.coerce.number().int().min(5).max(1440).default(60) }), response: { 200: IngestStatsDto } },
    }, async (req) => {
      const { scope } = await authorize(req, req.params.projectId, 'telemetry:read');
      return readIngestStats(db, scope, req.query.minutes);
    });

    // ------------------------------------------------------------------ search & detail
    const rememberQuery = z.object({ remember: z.coerce.boolean().default(false) });

    r.post('/api/v1/projects/:projectId/logs/search', {
      ...pre, config: throttle(120),
      schema: { tags: ['logs'], summary: 'Search logs (validated query builder; no free-form database queries)', params: IdParam, querystring: rememberQuery, body: LogQuery, response: { 200: LogSearchResult } },
    }, async (req) => {
      const { p, scope } = await authorize(req, req.params.projectId, 'telemetry:read');
      const res = await store.search(scope, req.body);
      if (req.query.remember) await saveHistory(p.orgId, req.params.projectId, p.userId, req.body);
      return { items: res.items.map(toSummary), nextCursor: res.nextCursor };
    });

    r.post('/api/v1/projects/:projectId/logs/histogram', {
      ...pre, config: throttle(120), schema: { tags: ['logs'], params: IdParam, body: LogQuery, response: { 200: LogHistogram } },
    }, async (req) => store.histogram((await authorize(req, req.params.projectId, 'telemetry:read')).scope, req.body));

    r.post('/api/v1/projects/:projectId/logs/facets', {
      ...pre, config: throttle(120), schema: { tags: ['logs'], params: IdParam, body: LogQuery, response: { 200: LogFacets } },
    }, async (req) => store.facets((await authorize(req, req.params.projectId, 'telemetry:read')).scope, req.body));

    r.get('/api/v1/projects/:projectId/logs/:logId', {
      ...pre, config: throttle(240), schema: { tags: ['logs'], summary: 'Full record, including attributes and stack trace', params: LogParams, response: { 200: LogDetail } },
    }, async (req) => {
      const { scope } = await authorize(req, req.params.projectId, 'telemetry:read');
      const doc = await store.get(scope, req.params.logId);
      if (!doc) throw new AppError(404, 'not_found', 'Log record not found');
      return toDetail(doc);
    });

    r.get('/api/v1/projects/:projectId/logs/:logId/context', {
      ...pre, config: throttle(240), schema: { tags: ['logs'], summary: 'Related events (same trace/request) and neighbouring events', params: LogParams, response: { 200: LogContext } },
    }, async (req) => {
      const { scope } = await authorize(req, req.params.projectId, 'telemetry:read');
      const doc = await store.get(scope, req.params.logId);
      if (!doc) throw new AppError(404, 'not_found', 'Log record not found');
      const [related, nb] = await Promise.all([store.related(scope, doc), store.neighbors(scope, doc)]);
      return { related: { by: related.by, items: related.items.map(toSummary) }, before: nb.before.map(toSummary), after: nb.after.map(toSummary) };
    });

    // ------------------------------------------------------------------ live tail (server-sent events over POST)
    r.post('/api/v1/projects/:projectId/logs/tail', {
      ...pre, config: throttle(30), schema: { tags: ['logs'], summary: 'Live tail as a text/event-stream', params: IdParam, body: TailBody },
    }, async (req, reply) => {
      const { p, scope } = await authorize(req, req.params.projectId, 'telemetry:read');
      const n = tails.get(p.userId) ?? 0;
      if (n >= MAX_TAILS_PER_USER) throw new AppError(429, 'too_many_streams', `At most ${MAX_TAILS_PER_USER} live tails per user`);
      tails.set(p.userId, n + 1);

      const startedAt = Date.now();
      let cursor = encodeCursor(startedAt, '');
      let open = true;
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive',
        'x-accel-buffering': 'no', 'x-content-type-options': 'nosniff', 'x-request-id': req.id,
      });
      const send = (event: string, data: unknown) => { if (open) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
      // NOTE: the request's own 'close' fires when its body has been read, not when the client disconnects.
      // The RESPONSE socket's 'close' is the reliable signal; without it, tail slots leak and polling never stops.
      res.on('close', () => { open = false; });
      send('ready', { cursor, startedAt: new Date(startedAt).toISOString() });
      let lastBeat = Date.now();
      try {
        while (open && Date.now() - startedAt < MAX_TAIL_MS) {
          const q = { ...req.body.query, from: new Date(startedAt).toISOString(), to: new Date(Date.now() + 5 * 60_000).toISOString(), cursor, limit: 200 };
          const page = await store.tail(scope, q);
          if (page.nextCursor) cursor = page.nextCursor;
          if (page.items.length) send('logs', { items: page.items.map(toSummary) });
          if (Date.now() - lastBeat > 15_000) { if (open) res.write(': keep-alive\n\n'); lastBeat = Date.now(); }
          if (page.items.length < 200) await new Promise((rz) => setTimeout(rz, 1000));
        }
        send('end', { reason: open ? 'max-duration' : 'closed' });
      } catch (e) {
        req.log.error({ err: e }, 'tail failed');
        send('error', { message: 'Live tail stopped unexpectedly' });
      } finally {
        tails.set(p.userId, Math.max(0, (tails.get(p.userId) ?? 1) - 1));
        if (!res.writableEnded) res.end();
      }
    });

    // ------------------------------------------------------------------ export (permission-checked, capped, audited)
    r.post('/api/v1/projects/:projectId/logs/export', {
      ...pre, config: throttle(10), schema: { tags: ['logs'], summary: `Export up to ${MAX_EXPORT_ROWS} matching records as NDJSON or CSV`, params: IdParam, body: ExportBody },
    }, async (req, reply) => {
      // Exporting copies data out of the platform, so it needs engineer-level access (viewers can search but not export).
      const { p, scope } = await authorize(req, req.params.projectId, 'incident:write');
      const { query, format } = req.body;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      reply.hijack();
      const res = reply.raw;
      res.writeHead(200, {
        'content-type': format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8',
        'content-disposition': `attachment; filename="logs-${stamp}.${format === 'csv' ? 'csv' : 'ndjson'}"`,
        'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-request-id': req.id,
      });
      let rows = 0;
      try {
        if (format === 'csv') res.write(`${CSV_COLUMNS.join(',')}\n`);
        for await (const d of store.exportRows(scope, query, MAX_EXPORT_ROWS)) {
          const line = format === 'csv'
            ? `${CSV_COLUMNS.map((c) => csvCell(c === 'ts' ? iso(d.ts) : (d as unknown as Record<string, unknown>)[c])).join(',')}\n`
            : `${JSON.stringify(toDetail(d))}\n`;
          if (!res.write(line)) await new Promise<void>((ok) => res.once('drain', ok));
          rows++;
        }
      } finally {
        // Audit BEFORE closing the response, so a client that has received the whole export can rely on the record existing.
        await audit.record({
          orgId: p.orgId, actorUserId: p.userId, action: 'logs.exported', targetType: 'project', targetId: req.params.projectId, projectId: req.params.projectId,
          metadata: { format, rows, capped: rows >= MAX_EXPORT_ROWS, from: query.from, to: query.to, filters: query.filters.length, text: !!query.text },
        }, { requestId: req.id, ip: req.ip }).catch((err) => req.log.error({ err }, 'failed to audit export'));
        res.end();
      }
    });

    // ------------------------------------------------------------------ saved queries & history
    r.get('/api/v1/projects/:projectId/logs/saved-queries', {
      ...pre, schema: { tags: ['logs'], params: IdParam, response: { 200: z.array(SavedQueryDto) } },
    }, async (req) => {
      const { p } = await authorize(req, req.params.projectId, 'telemetry:read');
      const rows = await db.c.savedQueries.find({ orgId: p.orgId, projectId: req.params.projectId, $or: [{ ownerId: p.userId }, { shared: true }] }).sort({ createdAt: -1 }).limit(200).toArray();
      return rows.map((x) => ({ id: x._id, name: x.name, query: x.query, shared: x.shared, ownedByMe: x.ownerId === p.userId, createdAt: iso(x.createdAt) }));
    });

    r.post('/api/v1/projects/:projectId/logs/saved-queries', {
      ...pre, schema: { tags: ['logs'], params: IdParam, body: SavedQueryCreate, response: { 201: SavedQueryDto } },
    }, async (req, reply) => {
      // Personal queries need only read access; sharing with the project needs engineer-level access.
      const { p } = await authorize(req, req.params.projectId, req.body.shared ? 'incident:write' : 'telemetry:read');
      if ((await db.c.savedQueries.countDocuments({ orgId: p.orgId, projectId: req.params.projectId, ownerId: p.userId })) >= MAX_SAVED_PER_USER) {
        throw new AppError(409, 'limit_reached', `At most ${MAX_SAVED_PER_USER} saved queries per user and project`);
      }
      // Absolute times are dropped: a saved query is a filter, re-applied to whatever range is selected later.
      const { from: _f, to: _t, cursor: _c, ...rest } = req.body.query;
      const doc = { _id: crypto.randomUUID(), orgId: p.orgId, projectId: req.params.projectId, ownerId: p.userId, name: req.body.name, query: rest as Record<string, unknown>, shared: req.body.shared, createdAt: new Date() };
      await db.c.savedQueries.insertOne(doc);
      return reply.code(201).send({ id: doc._id, name: doc.name, query: doc.query, shared: doc.shared, ownedByMe: true, createdAt: iso(doc.createdAt) });
    });

    r.delete('/api/v1/projects/:projectId/logs/saved-queries/:queryId', {
      ...pre, schema: { tags: ['logs'], params: SavedQueryParams, response: { 204: z.null() } },
    }, async (req, reply) => {
      const { p, access } = await authorize(req, req.params.projectId, 'telemetry:read');
      const q = await db.c.savedQueries.findOne({ _id: req.params.queryId, orgId: p.orgId, projectId: req.params.projectId });
      if (!q || (!q.shared && q.ownerId !== p.userId)) throw new AppError(404, 'not_found', 'Saved query not found');
      if (q.ownerId !== p.userId && access.role !== 'project_admin') throw new AppError(403, 'forbidden', 'Only the owner or a project admin can delete a shared query');
      await db.c.savedQueries.deleteOne({ _id: q._id });
      return reply.code(204).send(null);
    });

    r.get('/api/v1/projects/:projectId/logs/history', {
      ...pre, schema: { tags: ['logs'], params: IdParam, response: { 200: z.array(z.object({ id: z.string(), query: z.record(z.string(), z.unknown()), at: z.iso.datetime() })) } },
    }, async (req) => {
      const { p } = await authorize(req, req.params.projectId, 'telemetry:read');
      const rows = await db.c.queryHistory.find({ orgId: p.orgId, projectId: req.params.projectId, userId: p.userId }).sort({ at: -1 }).limit(HISTORY_KEEP).toArray();
      return rows.map((h) => ({ id: h._id, query: h.query, at: iso(h.at) }));
    });

    async function saveHistory(orgId: string, projectId: string, userId: string, query: Record<string, unknown>) {
      const { cursor: _c, ...rest } = query;
      if (JSON.stringify(rest).length > 4096) return;
      await db.c.queryHistory.insertOne({ _id: crypto.randomUUID(), orgId, projectId, userId, query: rest, at: new Date(), expireAt: new Date(Date.now() + 30 * 86400_000) });
      const stale = await db.c.queryHistory.find({ orgId, projectId, userId }).sort({ at: -1 }).skip(HISTORY_KEEP).project({ _id: 1 }).toArray();
      if (stale.length) await db.c.queryHistory.deleteMany({ _id: { $in: stale.map((s) => s._id as string) } });
    }
  };
}
