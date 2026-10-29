import { createHash } from 'node:crypto';
import {
  ConnectionConfigUpdate, ConnectionCreate, ConnectionDto, ConnectionIdParams, ConnectionListQuery, ConnectionParams,
  ConnectionRotate, ConnectionSelection, ConnectionSettings, ConnectorDescriptorDto, DiscoveryDto, PreviewDto, TestReportDto,
} from '@nexus/contracts';
import type { ConnectionService, Scope } from '@nexus/connections';
import type { ConnectorRegistry, TestReport } from '@nexus/connector-sdk';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ProjectAction } from '../authz/policy.js';
import { principalOf } from '../plugins/auth.js';
import type { ProjectService } from '../services/projects.js';

export function connectionRoutes(deps: { projects: ProjectService; connections: ConnectionService; registry: ConnectorRegistry; cookieName: string }) {
  const { projects, connections, registry } = deps;

  return async (app: FastifyInstance) => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const pre = { onRequest: app.authenticate };
    // Connectivity tests make the platform open outbound sockets: throttle per session, not just per IP.
    const throttled = {
      rateLimit: {
        max: 20, timeWindow: '1 minute',
        keyGenerator: (req: FastifyRequest) => createHash('sha256').update(req.cookies?.[deps.cookieName] ?? req.ip).digest('hex').slice(0, 24),
      },
    };
    const actorOf = (req: FastifyRequest) => ({ userId: req.auth!.user._id, ctx: { requestId: req.id, ip: req.ip } });

    /** Authorization happens here, server-side, for every route: project role + environment scope -> a Scope the service enforces. */
    async function scopeFor(req: FastifyRequest, projectId: string, action: ProjectAction): Promise<Scope> {
      const p = principalOf(req);
      const { access } = await projects.requireProject(p, projectId, action);
      return { orgId: p.orgId, projectId, environmentIds: access.environmentIds };
    }
    const MANAGE: ProjectAction = 'connection:manage';
    const READ: ProjectAction = 'telemetry:read';

    const toReport = (report: TestReport, connection: z.infer<typeof ConnectionDto>) => ({
      ok: report.ok,
      failure: report.failure ? { kind: report.failure.kind, message: report.failure.message, remediation: report.failure.remediation } : null,
      steps: report.steps, capabilities: report.capabilities, facts: report.facts, durationMs: report.durationMs, connection,
    });

    r.get('/api/v1/connectors', {
      onRequest: app.authenticate,
      schema: { tags: ['connectors'], summary: 'Connector registry and capability matrix (implemented vs planned, honestly)', response: { 200: z.array(ConnectorDescriptorDto) } },
    }, async () => registry.list() as never);

    r.get('/api/v1/projects/:projectId/connections', {
      ...pre, schema: { tags: ['connections'], params: z.object({ projectId: ConnectionParams.shape.projectId }), querystring: ConnectionListQuery, response: { 200: z.array(ConnectionDto) } },
    }, async (req) => connections.list(await scopeFor(req, req.params.projectId, READ), req.query.environmentId));

    r.post('/api/v1/projects/:projectId/environments/:environmentId/connections', {
      ...pre, schema: { tags: ['connections'], summary: 'Create a draft connection (credentials are write-only)', params: ConnectionParams, body: ConnectionCreate, response: { 201: ConnectionDto } },
    }, async (req, reply) => {
      const scope = await scopeFor(req, req.params.projectId, MANAGE);
      return reply.code(201).send(await connections.create(scope, req.params.environmentId, actorOf(req), req.body));
    });

    r.get('/api/v1/projects/:projectId/connections/:connectionId', {
      ...pre, schema: { tags: ['connections'], params: ConnectionIdParams, response: { 200: ConnectionDto } },
    }, async (req) => connections.get(await scopeFor(req, req.params.projectId, READ), req.params.connectionId));

    r.patch('/api/v1/projects/:projectId/connections/:connectionId', {
      ...pre, schema: { tags: ['connections'], params: ConnectionIdParams, body: ConnectionConfigUpdate, response: { 200: ConnectionDto } },
    }, async (req) => connections.updateConfig(await scopeFor(req, req.params.projectId, MANAGE), req.params.connectionId, actorOf(req), req.body));

    r.post('/api/v1/projects/:projectId/connections/:connectionId/test', {
      ...pre, config: throttled, schema: { tags: ['connections'], summary: 'Validate credentials and connectivity; updates health', params: ConnectionIdParams, response: { 200: TestReportDto } },
    }, async (req) => {
      const { report, connection } = await connections.test(await scopeFor(req, req.params.projectId, MANAGE), req.params.connectionId, actorOf(req));
      return toReport(report, connection);
    });

    r.post('/api/v1/projects/:projectId/connections/:connectionId/discover', {
      ...pre, config: throttled, schema: { tags: ['connections'], summary: 'Discover resources and capabilities', params: ConnectionIdParams, response: { 200: DiscoveryDto } },
    }, async (req) => {
      const { discovery, connection } = await connections.discover(await scopeFor(req, req.params.projectId, MANAGE), req.params.connectionId, actorOf(req));
      return { ...discovery, connection };
    });

    r.put('/api/v1/projects/:projectId/connections/:connectionId/selection', {
      ...pre, schema: { tags: ['connections'], params: ConnectionIdParams, body: ConnectionSelection, response: { 200: ConnectionDto } },
    }, async (req) => connections.setSelection(await scopeFor(req, req.params.projectId, MANAGE), req.params.connectionId, actorOf(req), req.body));

    r.put('/api/v1/projects/:projectId/connections/:connectionId/settings', {
      ...pre, schema: { tags: ['connections'], params: ConnectionIdParams, body: ConnectionSettings, response: { 200: ConnectionDto } },
    }, async (req) => connections.setSettings(await scopeFor(req, req.params.projectId, MANAGE), req.params.connectionId, actorOf(req), req.body));

    r.get('/api/v1/projects/:projectId/connections/:connectionId/preview', {
      ...pre, schema: { tags: ['connections'], summary: 'Preview the collection configuration that activation will start', params: ConnectionIdParams, response: { 200: PreviewDto } },
    }, async (req) => connections.preview(await scopeFor(req, req.params.projectId, READ), req.params.connectionId) as never);

    r.post('/api/v1/projects/:projectId/connections/:connectionId/activate', {
      ...pre, schema: { tags: ['connections'], summary: 'Start monitoring (requires a passing, recent test and a selection)', params: ConnectionIdParams, response: { 200: ConnectionDto } },
    }, async (req) => connections.activate(await scopeFor(req, req.params.projectId, MANAGE), req.params.connectionId, actorOf(req)));

    r.post('/api/v1/projects/:projectId/connections/:connectionId/rotate', {
      ...pre, config: throttled, schema: { tags: ['connections'], summary: 'Replace credentials and revalidate immediately', params: ConnectionIdParams, body: ConnectionRotate, response: { 200: TestReportDto } },
    }, async (req) => {
      const { report, connection } = await connections.rotate(await scopeFor(req, req.params.projectId, MANAGE), req.params.connectionId, actorOf(req), req.body.secrets);
      return toReport(report, connection);
    });

    r.post('/api/v1/projects/:projectId/connections/:connectionId/disconnect', {
      ...pre, schema: { tags: ['connections'], summary: 'Stop monitoring and revoke (delete) stored credentials', params: ConnectionIdParams, response: { 200: ConnectionDto } },
    }, async (req) => connections.disconnect(await scopeFor(req, req.params.projectId, MANAGE), req.params.connectionId, actorOf(req)));

    r.delete('/api/v1/projects/:projectId/connections/:connectionId', {
      ...pre, schema: { tags: ['connections'], params: ConnectionIdParams, response: { 204: z.null() } },
    }, async (req, reply) => {
      await connections.remove(await scopeFor(req, req.params.projectId, MANAGE), req.params.connectionId, actorOf(req));
      return reply.code(204).send(null);
    });
  };
}
