import { createHash } from 'node:crypto';
import {
  AckBody, AlertRuleCreate, AlertRuleDto, AlertRuleUpdate, ChannelCreate, ChannelDto, ChannelParams, ChannelUpdate, CommentBody, DeliveryDto,
  IncidentDetailDto, IncidentDto, IncidentListQuery, IncidentParams, PageQuery, ProjectParam, ResolveBody, RuleListQuery, RuleParams, SilenceCreate,
  SilenceDto, SilenceParams, TestSendResult, page,
} from '@nexus/contracts';
import {
  AlertingError, toChannelDto, toDeliveryDto, toEventDto, toIncidentDto, toRuleDto, toSilenceDto, type ActorScope, type AlertingServices,
} from '@nexus/alerting';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { ProjectAction } from '../authz/policy.js';
import { AppError } from '../errors.js';
import { principalOf } from '../plugins/auth.js';
import type { ProjectService } from '../services/projects.js';

/** Alerting services signal expected failures with AlertingError; the API reports them with the same envelope as every other route. */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof AlertingError) throw new AppError(e.status, e.code, e.message, e.details);
    throw e;
  }
}

export function alertingRoutes(deps: { projects: ProjectService; alerting: AlertingServices; cookieName: string }) {
  const { projects, alerting } = deps;

  return async (app: FastifyInstance) => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const pre = { onRequest: app.authenticate };
    const ctx = (req: FastifyRequest) => ({ requestId: req.id, ip: req.ip });
    const throttled = {
      rateLimit: {
        max: 20, timeWindow: '1 minute',
        keyGenerator: (req: FastifyRequest) => createHash('sha256').update(req.cookies?.[deps.cookieName] ?? req.ip).digest('hex').slice(0, 24),
      },
    };
    const READ: ProjectAction = 'alert:read';
    const ACT: ProjectAction = 'incident:write';
    const MANAGE: ProjectAction = 'alert:manage';

    /**
     * Authorization for every alerting route: project role -> action, then the caller's environment scope. Projects the caller cannot see are 404.
     * The scope handed to the services comes from the session and the grant only; nothing in the request can widen it.
     */
    async function scopeFor(req: FastifyRequest, projectId: string, action: ProjectAction): Promise<ActorScope> {
      const p = principalOf(req);
      const { access } = await projects.requireProject(p, projectId, action);
      return { orgId: p.orgId, projectId, environmentIds: access.environmentIds, userId: p.userId };
    }

    // ------------------------------------------------------------------ rules
    r.get('/api/v1/projects/:projectId/alert-rules', {
      ...pre, schema: { tags: ['alerting'], summary: 'List alert rules (newest first, keyset pagination)', params: ProjectParam, querystring: RuleListQuery, response: { 200: page(AlertRuleDto) } },
    }, async (req) => guard(async () => {
      const s = await scopeFor(req, req.params.projectId, READ);
      const q = req.query;
      const res = await alerting.rules.list(s, { limit: q.limit, cursor: q.cursor, environmentId: q.environmentId, enabled: q.enabled === undefined ? undefined : q.enabled === 'true' });
      return { items: res.items.map(toRuleDto), nextCursor: res.nextCursor };
    }));

    r.post('/api/v1/projects/:projectId/alert-rules', {
      ...pre, schema: { tags: ['alerting'], summary: 'Create an alert rule (project admin)', params: ProjectParam, body: AlertRuleCreate, response: { 201: AlertRuleDto } },
    }, async (req, reply) => guard(async () => {
      const s = await scopeFor(req, req.params.projectId, MANAGE);
      return reply.code(201).send(toRuleDto(await alerting.rules.create(s, req.body, ctx(req))));
    }));

    r.get('/api/v1/projects/:projectId/alert-rules/:ruleId', {
      ...pre, schema: { tags: ['alerting'], params: RuleParams, response: { 200: AlertRuleDto } },
    }, async (req) => guard(async () => toRuleDto(await alerting.rules.get(await scopeFor(req, req.params.projectId, READ), req.params.ruleId))));

    r.patch('/api/v1/projects/:projectId/alert-rules/:ruleId', {
      ...pre, schema: { tags: ['alerting'], summary: 'Update a rule (changing what is measured resets its state and closes its live incidents)', params: RuleParams, body: AlertRuleUpdate, response: { 200: AlertRuleDto } },
    }, async (req) => guard(async () => toRuleDto(await alerting.rules.update(await scopeFor(req, req.params.projectId, MANAGE), req.params.ruleId, req.body, ctx(req)))));

    r.delete('/api/v1/projects/:projectId/alert-rules/:ruleId', {
      ...pre, schema: { tags: ['alerting'], params: RuleParams, response: { 204: z.null() } },
    }, async (req, reply) => guard(async () => {
      await alerting.rules.remove(await scopeFor(req, req.params.projectId, MANAGE), req.params.ruleId, ctx(req));
      return reply.code(204).send(null);
    }));

    // ------------------------------------------------------------------ channels
    r.get('/api/v1/projects/:projectId/alert-channels', {
      ...pre, schema: { tags: ['alerting'], summary: 'List notification channels (secrets are never returned)', params: ProjectParam, querystring: PageQuery, response: { 200: page(ChannelDto) } },
    }, async (req) => guard(async () => {
      const res = await alerting.channels.list(await scopeFor(req, req.params.projectId, READ), req.query);
      return { items: res.items.map(toChannelDto), nextCursor: res.nextCursor };
    }));

    r.post('/api/v1/projects/:projectId/alert-channels', {
      ...pre, schema: { tags: ['alerting'], summary: 'Create a webhook channel (project admin, unrestricted scope). The signing secret is write-only.', params: ProjectParam, body: ChannelCreate, response: { 201: ChannelDto } },
    }, async (req, reply) => guard(async () => {
      const s = await scopeFor(req, req.params.projectId, MANAGE);
      return reply.code(201).send(toChannelDto(await alerting.channels.create(s, req.body, ctx(req))));
    }));

    r.patch('/api/v1/projects/:projectId/alert-channels/:channelId', {
      ...pre, schema: { tags: ['alerting'], params: ChannelParams, body: ChannelUpdate, response: { 200: ChannelDto } },
    }, async (req) => guard(async () => toChannelDto(await alerting.channels.update(await scopeFor(req, req.params.projectId, MANAGE), req.params.channelId, req.body, ctx(req)))));

    r.delete('/api/v1/projects/:projectId/alert-channels/:channelId', {
      ...pre, schema: { tags: ['alerting'], params: ChannelParams, response: { 204: z.null() } },
    }, async (req, reply) => guard(async () => {
      await alerting.channels.remove(await scopeFor(req, req.params.projectId, MANAGE), req.params.channelId, ctx(req));
      return reply.code(204).send(null);
    }));

    r.post('/api/v1/projects/:projectId/alert-channels/:channelId/test', {
      ...pre, config: throttled, schema: { tags: ['alerting'], summary: 'Send one signed test notification now (no retries; at most 5 per minute per channel)', params: ChannelParams, response: { 200: TestSendResult } },
    }, async (req) => guard(async () => {
      const t = await alerting.channels.test(await scopeFor(req, req.params.projectId, MANAGE), req.params.channelId, ctx(req));
      return { ok: t.ok, status: t.status, message: t.message, delivery: toDeliveryDto(t.delivery) };
    }));

    // ------------------------------------------------------------------ silences
    r.get('/api/v1/projects/:projectId/alert-silences', {
      ...pre, schema: { tags: ['alerting'], params: ProjectParam, querystring: PageQuery, response: { 200: page(SilenceDto) } },
    }, async (req) => guard(async () => {
      const res = await alerting.silences.list(await scopeFor(req, req.params.projectId, READ), req.query);
      const now = new Date();
      return { items: res.items.map((x) => toSilenceDto(x, now)), nextCursor: res.nextCursor };
    }));

    r.post('/api/v1/projects/:projectId/alert-silences', {
      ...pre, schema: { tags: ['alerting'], summary: 'Create a time-bounded silence: matching notifications are suppressed, incidents are still recorded', params: ProjectParam, body: SilenceCreate, response: { 201: SilenceDto } },
    }, async (req, reply) => guard(async () => {
      const s = await scopeFor(req, req.params.projectId, MANAGE);
      return reply.code(201).send(toSilenceDto(await alerting.silences.create(s, req.body, ctx(req)), new Date()));
    }));

    r.delete('/api/v1/projects/:projectId/alert-silences/:silenceId', {
      ...pre, schema: { tags: ['alerting'], params: SilenceParams, response: { 204: z.null() } },
    }, async (req, reply) => guard(async () => {
      await alerting.silences.remove(await scopeFor(req, req.params.projectId, MANAGE), req.params.silenceId, ctx(req));
      return reply.code(204).send(null);
    }));

    // ------------------------------------------------------------------ incidents
    r.get('/api/v1/projects/:projectId/incidents', {
      ...pre, schema: { tags: ['incidents'], summary: 'List incidents (newest first, keyset pagination)', params: ProjectParam, querystring: IncidentListQuery, response: { 200: page(IncidentDto) } },
    }, async (req) => guard(async () => {
      const res = await alerting.incidents.list(await scopeFor(req, req.params.projectId, READ), req.query);
      return { items: res.items.map(toIncidentDto), nextCursor: res.nextCursor };
    }));

    r.get('/api/v1/projects/:projectId/incidents/:incidentId', {
      ...pre, schema: { tags: ['incidents'], summary: 'One incident with its timeline', params: IncidentParams, response: { 200: IncidentDetailDto } },
    }, async (req) => guard(async () => {
      const { incident, actors } = await alerting.incidents.get(await scopeFor(req, req.params.projectId, READ), req.params.incidentId);
      return { ...toIncidentDto(incident), timeline: incident.timeline.map((e) => toEventDto(e, actors)) };
    }));

    r.get('/api/v1/projects/:projectId/incidents/:incidentId/deliveries', {
      ...pre, schema: { tags: ['incidents'], summary: 'Notification delivery log of one incident', params: IncidentParams, response: { 200: z.array(DeliveryDto) } },
    }, async (req) => guard(async () => (await alerting.incidents.deliveries(await scopeFor(req, req.params.projectId, READ), req.params.incidentId)).map(toDeliveryDto)));

    const detail = async (s: ActorScope, id: string) => {
      const { incident, actors } = await alerting.incidents.get(s, id);
      return { ...toIncidentDto(incident), timeline: incident.timeline.map((e) => toEventDto(e, actors)) };
    };

    r.post('/api/v1/projects/:projectId/incidents/:incidentId/acknowledge', {
      ...pre, schema: { tags: ['incidents'], params: IncidentParams, body: AckBody, response: { 200: IncidentDetailDto } },
    }, async (req) => guard(async () => {
      const s = await scopeFor(req, req.params.projectId, ACT);
      await alerting.incidents.acknowledge(s, req.params.incidentId, req.body.note, ctx(req));
      return detail(s, req.params.incidentId);
    }));

    r.post('/api/v1/projects/:projectId/incidents/:incidentId/resolve', {
      ...pre, schema: { tags: ['incidents'], params: IncidentParams, body: ResolveBody, response: { 200: IncidentDetailDto } },
    }, async (req) => guard(async () => {
      const s = await scopeFor(req, req.params.projectId, ACT);
      await alerting.incidents.resolve(s, req.params.incidentId, req.body.note, ctx(req));
      return detail(s, req.params.incidentId);
    }));

    r.post('/api/v1/projects/:projectId/incidents/:incidentId/comments', {
      ...pre, schema: { tags: ['incidents'], params: IncidentParams, body: CommentBody, response: { 200: IncidentDetailDto } },
    }, async (req) => guard(async () => {
      const s = await scopeFor(req, req.params.projectId, ACT);
      await alerting.incidents.comment(s, req.params.incidentId, req.body.body, ctx(req));
      return detail(s, req.params.incidentId);
    }));
  };
}
