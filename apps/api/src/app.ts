import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { createAlertingServices, RulePreviewService, type EmailSender, type SlackSender, type WebhookSender } from '@nexus/alerting';
import { ConnectionService, ServiceError } from '@nexus/connections';
import { createDefaultRegistry } from '@nexus/connectors';
import type { Database } from '@nexus/database';
import { DeploymentService, IngestTokenService } from '@nexus/ingest';
import { MongoLogStore } from '@nexus/logstore';
import { MongoMetricStore, type MetricStore } from '@nexus/metricstore';
import { MongoTraceStore, type TraceStore } from '@nexus/tracestore';
import { loadKeyring, SecretStore, type Keyring } from '@nexus/secrets';
import Fastify from 'fastify';
import {
  hasZodFastifySchemaValidationErrors, jsonSchemaTransform, serializerCompiler, validatorCompiler,
} from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import authPlugin from './plugins/auth.js';
import { OidcService } from './auth/oidc.js';
import { authRoutes } from './routes/auth.js';
import { oidcRoutes } from './routes/oidc.js';
import { alertingRoutes } from './routes/alerting.js';
import { deploymentRoutes } from './routes/deployments.js';
import { connectionRoutes } from './routes/connections.js';
import { orgRoutes } from './routes/org.js';
import { projectRoutes } from './routes/projects.js';
import { telemetryRoutes } from './routes/telemetry.js';
import { observabilityRoutes } from './routes/observability.js';
import { makeAuthorize, QueryMonitor } from './routes/scope.js';
import { traceRoutes } from './routes/traces.js';
import { AuditService } from './services/audit.js';
import { ProjectService } from './services/projects.js';
import { SessionService } from './services/sessions.js';

const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

export interface RouteInfo { method: string; url: string; authenticated: boolean }

declare module 'fastify' {
  interface FastifyInstance { routeTable: RouteInfo[] }
}

export async function buildApp(cfg: Config, db: Database, deps: { keyring?: Keyring; logStream?: { write(msg: string): void }; traceStore?: TraceStore; metricStore?: MetricStore; webhookSender?: WebhookSender; slackSender?: SlackSender; emailSender?: EmailSender } = {}) {
  const app = Fastify({
    logger: {
      level: cfg.logLevel,
      ...(deps.logStream ? { stream: deps.logStream } : {}),
      // The OIDC callback URL carries the one-time authorization code and state: never write them to logs.
      serializers: {
        req(req: { method?: string; url?: string; headers?: Record<string, unknown>; ip?: string }) {
          const url = req.url ?? '';
          return { method: req.method, url: url.startsWith('/api/v1/auth/oidc/callback') ? '/api/v1/auth/oidc/callback' : url, remoteAddress: req.ip };
        },
      },
      // Credentials must never reach logs.
      redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-csrf-token"]', 'res.headers["set-cookie"]'], censor: '[REDACTED]' },
    },
    bodyLimit: 256 * 1024,
    trustProxy: false,
    // Never trust arbitrary client-supplied ids in logs/audit: accept only a conservative shape.
    genReqId: (req) => {
      const h = req.headers['x-request-id'];
      return typeof h === 'string' && REQUEST_ID.test(h) ? h : randomUUID();
    },
  });
  // Route inventory (used by tests to prove that every non-public route requires authentication).
  const routeTable: RouteInfo[] = [];
  app.addHook('onRoute', (o) => {
    const hooks = ([] as unknown[]).concat(o.onRequest ?? []);
    for (const method of ([] as string[]).concat(o.method)) routeTable.push({ method, url: o.url, authenticated: hooks.includes(app.authenticate) });
  });
  app.decorate('routeTable', routeTable);
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.addHook('onSend', async (req, reply) => { reply.header('x-request-id', req.id); });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const requestId = req.id;
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, requestId, details: err.details } });
    }
    if (err instanceof ServiceError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, requestId, details: err.details } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({ error: { code: 'validation_error', message: 'Request validation failed', requestId, details: err.validation.map((v) => ({ path: v.instancePath, message: v.message })) } });
    }
    if (err.statusCode === 429) {
      return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many requests', requestId } });
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: { code: 'bad_request', message: 'Bad request', requestId } });
    }
    // Unexpected: log full detail server-side, return nothing internal to the client.
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal_error', message: 'Internal server error', requestId } });
  });
  app.setNotFoundHandler((req, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: 'Route not found', requestId: req.id } }));

  await app.register(helmet, { contentSecurityPolicy: cfg.env === 'production' ? undefined : false });
  await app.register(cookie);
  await app.register(rateLimit, { max: cfg.rateLimitMax, timeWindow: '1 minute' });

  if (cfg.env !== 'production') {
    await app.register(swagger, {
      openapi: { info: { title: 'Nexus Observability API', version: '0.1.0' }, tags: [{ name: 'auth' }, { name: 'projects' }, { name: 'environments' }, { name: 'members' }, { name: 'audit' }, { name: 'connectors' }, { name: 'connections' }, { name: 'logs' }, { name: 'ingestion' }, { name: 'alerting' }, { name: 'incidents' }, { name: 'deployments' }] },
      transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: '/docs' });
  }

  const audit = new AuditService(db);
  const sessions = new SessionService(db, cfg);
  const projects = new ProjectService(db, audit);
  await app.register(authPlugin, { cfg, sessions });

  // Secret store: the KEK comes from the platform (SECRETS_KEYS); production refuses to start without it.
  const keyring = deps.keyring ?? loadKeyring(
    { SECRETS_KEYS: cfg.secretsKeys, SECRETS_CURRENT_KEY_ID: cfg.secretsCurrentKeyId },
    { production: cfg.env === 'production', devKeyFile: cfg.secretsDevKeyFile },
  );
  const registry = createDefaultRegistry();
  const connections = new ConnectionService({
    db, secrets: new SecretStore(db, keyring), registry, audit, network: cfg.network, testTimeoutMs: cfg.connectionTestTimeoutMs,
  });

  // Liveness never touches dependencies (a DB outage must not cause restart loops); readiness does.
  app.get('/healthz', { schema: { hide: true } }, async () => ({ status: 'ok' }));
  app.get('/readyz', { schema: { hide: true } }, async (_req, reply) => {
    const ok = await db.ping();
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ready' : 'degraded', checks: { mongodb: ok ? 'up' : 'down' } });
  });

  const oidc = cfg.oidc ? new OidcService(cfg, cfg.oidc, db, sessions, audit, app.log) : null;
  await app.register(oidcRoutes({ cfg, oidc }));
  await app.register(authRoutes({ cfg, db, sessions, audit, logoutUrl: oidc ? () => oidc.logoutUrl() : undefined }));
  await app.register(projectRoutes(projects));
  await app.register(orgRoutes({ db, audit, sessions }));
  const logStore = new MongoLogStore(db);
  const traceStore = deps.traceStore ?? new MongoTraceStore(db);
  const metricStore = deps.metricStore ?? new MongoMetricStore(db);
  const authorize = makeAuthorize(db, projects);
  const monitor = new QueryMonitor();
  await app.register(traceRoutes({ traces: traceStore, logs: logStore, authorize, monitor, cookieName: app.cookieName }));
  await app.register(observabilityRoutes({ db, traces: traceStore, metrics: metricStore, authorize, monitor, cookieName: app.cookieName }));
  await app.register(telemetryRoutes({ db, projects, store: logStore, tokens: new IngestTokenService(db, audit), audit, cookieName: app.cookieName, ingestPublicUrl: cfg.ingestPublicUrl }));
  await app.register(connectionRoutes({ projects, connections, registry, cookieName: app.cookieName }));
  const alerting = createAlertingServices(db, audit, new SecretStore(db, keyring), cfg.network, { publicUrl: cfg.webOrigin, ...(deps.webhookSender ? { sender: deps.webhookSender } : {}), ...(deps.slackSender ? { slackSender: deps.slackSender } : {}), ...(deps.emailSender ? { emailSender: deps.emailSender } : {}) });
  await app.register(alertingRoutes({ projects, alerting, preview: new RulePreviewService({ metrics: metricStore, logs: logStore }), cookieName: app.cookieName }));
  // Deployments / change markers (ADR-0011): CI writes with an ingestion token (scope `deployments`) or a session; everything else is read-only.
  await app.register(deploymentRoutes({ db, projects, service: new DeploymentService(db, audit), tokens: new IngestTokenService(db, audit), authorize }));
  return app;
}
