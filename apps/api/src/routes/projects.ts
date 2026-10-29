import {
  Environment, EnvironmentCreate, IdParam, Project, ProjectCreate, ProjectEnvParams, ProjectMember, ProjectMemberParams,
  ProjectMemberUpsert, ProjectUpdate,
} from '@nexus/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { principalOf } from '../plugins/auth.js';
import type { ProjectService } from '../services/projects.js';

export function projectRoutes(projects: ProjectService) {
  return async (app: FastifyInstance) => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const pre = { onRequest: app.authenticate };
    const ctx = (req: { id: string; ip: string }) => ({ requestId: req.id, ip: req.ip });

    r.get('/api/v1/projects', { ...pre, schema: { tags: ['projects'], summary: 'Projects the caller can access', response: { 200: z.array(Project) } } },
      async (req) => projects.list(principalOf(req)));

    r.post('/api/v1/projects', { ...pre, schema: { tags: ['projects'], summary: 'Create a project (org owner/admin)', body: ProjectCreate, response: { 201: Project } } },
      async (req, reply) => reply.code(201).send(await projects.create(principalOf(req), req.body, ctx(req))));

    r.get('/api/v1/projects/:projectId', { ...pre, schema: { tags: ['projects'], params: IdParam, response: { 200: Project } } },
      async (req) => projects.get(principalOf(req), req.params.projectId));

    r.patch('/api/v1/projects/:projectId', { ...pre, schema: { tags: ['projects'], params: IdParam, body: ProjectUpdate, response: { 200: Project } } },
      async (req) => projects.update(principalOf(req), req.params.projectId, req.body, ctx(req)));

    r.post('/api/v1/projects/:projectId/environments', { ...pre, schema: { tags: ['environments'], params: IdParam, body: EnvironmentCreate, response: { 201: Environment } } },
      async (req, reply) => reply.code(201).send(await projects.addEnvironment(principalOf(req), req.params.projectId, req.body, ctx(req))));

    r.delete('/api/v1/projects/:projectId/environments/:environmentId', { ...pre, schema: { tags: ['environments'], params: ProjectEnvParams, response: { 204: z.null() } } },
      async (req, reply) => {
        await projects.deleteEnvironment(principalOf(req), req.params.projectId, req.params.environmentId, ctx(req));
        return reply.code(204).send(null);
      });

    r.get('/api/v1/projects/:projectId/members', { ...pre, schema: { tags: ['members'], params: IdParam, response: { 200: z.array(ProjectMember) } } },
      async (req) => projects.listMembers(principalOf(req), req.params.projectId));

    r.put('/api/v1/projects/:projectId/members/:userId', { ...pre, schema: { tags: ['members'], params: ProjectMemberParams, body: ProjectMemberUpsert, response: { 204: z.null() } } },
      async (req, reply) => {
        await projects.upsertMember(principalOf(req), req.params.projectId, req.params.userId, req.body, ctx(req));
        return reply.code(204).send(null);
      });

    r.delete('/api/v1/projects/:projectId/members/:userId', { ...pre, schema: { tags: ['members'], params: ProjectMemberParams, response: { 204: z.null() } } },
      async (req, reply) => {
        await projects.removeMember(principalOf(req), req.params.projectId, req.params.userId, ctx(req));
        return reply.code(204).send(null);
      });
  };
}
