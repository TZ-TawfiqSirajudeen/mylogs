import { z } from 'zod';

export const OrgRole = z.enum(['owner', 'admin', 'member', 'auditor']);
export const ProjectRole = z.enum(['project_admin', 'engineer', 'viewer']);
export type OrgRole = z.infer<typeof OrgRole>;
export type ProjectRole = z.infer<typeof ProjectRole>;

import { Id } from './common.js';
export { Id };
export const Slug = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$/, 'lowercase letters, digits and dashes');

export const ApiError = z.object({
  error: z.object({ code: z.string(), message: z.string(), requestId: z.string(), details: z.unknown().optional() }),
});

// ---- sessions ----
export const DevLoginBody = z.object({ email: z.email().max(254), orgSlug: Slug.optional() });
export const SessionInfo = z.object({
  user: z.object({ id: Id, email: z.string(), displayName: z.string() }),
  org: z.object({ id: Id, slug: z.string(), name: z.string() }),
  orgRole: OrgRole,
  csrfToken: z.string(),
  authMode: z.enum(['dev', 'oidc']),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

// ---- environments ----
export const EnvironmentCreate = z.object({
  name: z.string().trim().min(1).max(60),
  isProduction: z.boolean().default(false),
});
export const Environment = z.object({
  id: Id, projectId: Id, slug: z.string(), name: z.string(), isProduction: z.boolean(), createdAt: z.iso.datetime(),
});
export type Environment = z.infer<typeof Environment>;

// ---- projects ----
export const ProjectCreate = z.object({
  name: z.string().trim().min(1).max(100),
  slug: Slug.optional(),
  description: z.string().trim().max(1000).default(''),
  owningTeam: z.string().trim().max(100).default(''),
  environments: z.array(EnvironmentCreate).max(10).default([]),
});
export const ProjectUpdate = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  description: z.string().trim().max(1000).optional(),
  owningTeam: z.string().trim().max(100).optional(),
});
export const Project = z.object({
  id: Id, slug: z.string(), name: z.string(), description: z.string(), owningTeam: z.string(),
  role: ProjectRole, createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  environments: z.array(Environment),
});
export type Project = z.infer<typeof Project>;

// ---- project members ----
export const ProjectMemberUpsert = z.object({
  role: ProjectRole,
  /** null/omitted = all environments. */
  environmentIds: z.array(Id).min(1).max(50).nullable().default(null),
});
export const ProjectMember = z.object({
  userId: Id, email: z.string(), displayName: z.string(), role: ProjectRole, environmentIds: z.array(Id).nullable(),
});

// ---- audit ----
export const AuditEvent = z.object({
  id: z.string(), seq: z.number(), action: z.string(), actorUserId: Id.nullable(), actorType: z.enum(['user', 'system']),
  targetType: z.string(), targetId: z.string().nullable(), projectId: Id.nullable(), environmentId: Id.nullable(),
  requestId: z.string().nullable(), metadata: z.record(z.string(), z.unknown()), createdAt: z.iso.datetime(),
});
export const AuditQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  action: z.string().max(100).optional(),
  projectId: Id.optional(),
});
export const AuditPage = z.object({ items: z.array(AuditEvent), nextBefore: z.number().nullable() });

export const IdParam = z.object({ projectId: Id });
export const ProjectEnvParams = z.object({ projectId: Id, environmentId: Id });
export const ProjectMemberParams = z.object({ projectId: Id, userId: Id });
export * from './connections.js';
export * from './logs.js';
export * from './traces.js';
export * from './metrics.js';
