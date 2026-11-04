import { createHash } from 'node:crypto';
import {
  DeploymentDto, DeploymentIncidentParams, DeploymentListQuery, DeploymentMarkers, DeploymentMarkersQuery, DeploymentPage, DeploymentParams,
  DeploymentProjectParam, DeploymentWrite, DeploymentWriteResult, DEPLOYMENT_LIMITS, IncidentDeployments,
} from '@nexus/contracts';
import type { Database, IngestTokenDoc } from '@nexus/database';
import { DeploymentError, DeploymentService, IngestTokenService, RateLimiter, toDeploymentDto } from '@nexus/ingest';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { canAccessEnvironment } from '../authz/policy.js';
import { AppError, notFound, unauthorized } from '../errors.js';
import { principalOf } from '../plugins/auth.js';
import type { Authorize } from './scope.js';
import type { ProjectService } from '../services/projects.js';

/** The same budget as the ingestion service: repeated failed authentication from one address is throttled. */
const AUTH_FAILURES_PER_MINUTE = 30;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:@/-]{1,128}$/;

type Credential = { kind: 'token'; token: IngestTokenDoc } | { kind: 'session' };

/** A presented ingestion token (Authorization: Bearer or X-Nexus-Token). `undefined` = none was presented. */
function presentedToken(req: FastifyRequest): string | undefined {
  const auth = String(req.headers.authorization ?? '');
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const x = req.headers['x-nexus-token'];
  return typeof x === 'string' ? x : undefined;
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof DeploymentError) throw new AppError(e.status, e.code, e.message, e.details);
    throw e;
  }
}

/**
 * Deployments (change markers), ADR-0011.
 *  - `POST /api/v1/deployments` is written by CI with an ingestion token that carries the `deployments` scope (environment and tenant come from the token),
 *    or by a signed-in engineer / project admin (cookie + CSRF + origin, project and environment named in the body and authorized against the grant).
 *  - Everything else is read-only, session-only and scoped to the caller's environments (viewer and up).
 */
export function deploymentRoutes(deps: { db: Database; projects: ProjectService; service: DeploymentService; tokens: IngestTokenService; authorize: Authorize }) {
  const { projects, service, tokens, authorize } = deps;
  const authFailures = new RateLimiter();

  return async (app: FastifyInstance) => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const pre = { onRequest: app.authenticate };
    const credentials = new WeakMap<FastifyRequest, Credential>();
    /** Rate-limit bucket of the writer: the token (hashed), else the session cookie, else the address. */
    const writerKey = (req: FastifyRequest) => createHash('sha256').update(presentedToken(req) ?? req.cookies?.[app.cookieName] ?? req.ip).digest('hex').slice(0, 32);

    /**
     * Runs before body validation. A presented token is judged as a token and NEVER falls back to a cookie; without a token the request must be a normal session
     * request (cookie, origin and CSRF checks are those of `app.authenticate`). Unknown, malformed and revoked tokens are indistinguishable (401).
     */
    const writerAuth = async (req: FastifyRequest, reply: FastifyReply) => {
      const raw = presentedToken(req);
      if (raw === undefined) { await app.authenticate(req, reply); credentials.set(req, { kind: 'session' }); return; }
      const token = await tokens.authenticate(raw);
      if (!token) {
        if (!authFailures.take(`authfail:${req.ip}`, 1, AUTH_FAILURES_PER_MINUTE).ok) { reply.header('retry-after', '60'); throw new AppError(429, 'rate_limited', 'Too many failed authentication attempts'); }
        throw unauthorized();
      }
      if (!token.scopes.includes('deployments')) throw new AppError(403, 'forbidden_scope', 'This token is not allowed to record deployments. Create a token that includes the "deployments" scope.');
      credentials.set(req, { kind: 'token', token });
    };

    r.post('/api/v1/deployments', {
      onRequest: writerAuth, bodyLimit: DEPLOYMENT_LIMITS.bodyBytes,
      config: { rateLimit: { max: DEPLOYMENT_LIMITS.writesPerMinute, timeWindow: '1 minute', keyGenerator: writerKey } },
      schema: {
        tags: ['deployments'], body: DeploymentWrite, response: { 200: DeploymentWriteResult, 201: DeploymentWriteResult },
        summary: 'Record a deployment (idempotent on idempotencyKey). Ingestion token with the "deployments" scope, or a session (engineer, project admin).',
      },
    }, async (req, reply) => guard(async () => {
      const cred = credentials.get(req);
      if (!cred) throw unauthorized(); // unreachable: the hook always sets it
      const body = req.body;
      const header = req.headers['idempotency-key'];
      if (typeof header === 'string' && header) {
        if (!IDEMPOTENCY_KEY.test(header)) throw new AppError(400, 'validation_error', 'Idempotency-Key must be letters, digits and . _ : @ / - (1 to 128 characters)');
        if (body.idempotencyKey && body.idempotencyKey !== header) throw new AppError(400, 'validation_error', 'Idempotency-Key and idempotencyKey differ');
        body.idempotencyKey = header;
      }
      const { projectId: bodyProject, environmentId: bodyEnv, ...input } = body;
      const ctx = { requestId: req.id, ip: req.ip };

      if (cred.kind === 'token') {
        // The credential decides where the record goes. A payload that tries to say otherwise is refused, not silently ignored.
        if (bodyProject !== undefined || bodyEnv !== undefined) throw new AppError(400, 'scope_in_payload', 'projectId and environmentId are not accepted with an ingestion token: the token decides the environment');
        const t = cred.token;
        const res = await service.record({ orgId: t.orgId, projectId: t.projectId, environmentId: t.environmentId }, { type: 'token', id: t._id, name: t.name }, input, ctx);
        return reply.code(res.outcome === 'created' ? 201 : 200).send({ outcome: res.outcome, deployment: toDeploymentDto(res.deployment) });
      }

      if (!bodyProject || !bodyEnv) throw new AppError(400, 'scope_required', 'projectId and environmentId are required when recording a deployment with a session');
      const p = principalOf(req);
      const { access } = await projects.requireProject(p, bodyProject, 'deployment:write');
      if (!canAccessEnvironment(access, bodyEnv)) throw notFound('Environment');
      const res = await service.record({ orgId: p.orgId, projectId: bodyProject, environmentId: bodyEnv }, { type: 'user', id: p.userId, name: req.auth!.user.displayName }, input, ctx);
      return reply.code(res.outcome === 'created' ? 201 : 200).send({ outcome: res.outcome, deployment: toDeploymentDto(res.deployment) });
    }));

    // ------------------------------------------------------------------ reads (session only; an ingestion token never authenticates these)
    r.get('/api/v1/projects/:projectId/deployments', {
      ...pre, schema: { tags: ['deployments'], summary: 'List deployments (newest first, keyset pagination)', params: DeploymentProjectParam, querystring: DeploymentListQuery, response: { 200: DeploymentPage } },
    }, async (req) => guard(async () => {
      const { scope } = await authorize(req, req.params.projectId, 'telemetry:read');
      const res = await service.list(scope, req.query);
      return { items: res.items.map(toDeploymentDto), nextCursor: res.nextCursor };
    }));

    r.get('/api/v1/projects/:projectId/deployments/markers', {
      ...pre, schema: { tags: ['deployments'], summary: 'Change markers for a chart window (at most 200, no notes)', params: DeploymentProjectParam, querystring: DeploymentMarkersQuery, response: { 200: DeploymentMarkers } },
    }, async (req) => guard(async () => {
      const { scope } = await authorize(req, req.params.projectId, 'telemetry:read');
      return service.markers(scope, req.query);
    }));

    r.get('/api/v1/projects/:projectId/deployments/:deploymentId', {
      ...pre, schema: { tags: ['deployments'], params: DeploymentParams, response: { 200: DeploymentDto } },
    }, async (req) => guard(async () => {
      const { scope } = await authorize(req, req.params.projectId, 'telemetry:read');
      return toDeploymentDto(await service.get(scope, req.params.deploymentId));
    }));

    r.get('/api/v1/projects/:projectId/incidents/:incidentId/deployments', {
      ...pre, schema: { tags: ['deployments'], summary: 'Deployments of the incident\'s services shortly before it opened (correlation, not proof of cause)', params: DeploymentIncidentParams, response: { 200: IncidentDeployments } },
    }, async (req) => guard(async () => {
      const { scope } = await authorize(req, req.params.projectId, 'alert:read');
      return service.forIncident(scope, req.params.incidentId);
    }));
  };
}
