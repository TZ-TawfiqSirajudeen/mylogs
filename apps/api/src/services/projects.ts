import type { Database, EnvironmentDoc, ProjectDoc, ProjectMembershipDoc } from '@nexus/database';
import type { Environment, Project } from '@nexus/contracts';
import { canAccessEnvironment, canOrg, canProject, isUnrestricted, resolveProjectAccess, scopeCovers, type Principal, type ProjectAccess, type ProjectAction } from '../authz/policy.js';
import { AppError, conflict, forbidden, notFound } from '../errors.js';
import type { AuditService, RequestContext } from './audit.js';

export const slugify = (s: string) =>
  s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');

const isDuplicateKey = (e: unknown) => (e as { code?: number })?.code === 11000;

const toEnv = (e: EnvironmentDoc): Environment => ({
  id: e._id, projectId: e.projectId, slug: e.slug, name: e.name, isProduction: e.isProduction, createdAt: e.createdAt.toISOString(),
});

export class ProjectService {
  constructor(private readonly db: Database, private readonly audit: AuditService) {}

  private toProject(p: ProjectDoc, access: ProjectAccess, envs: EnvironmentDoc[]): Project {
    return {
      id: p._id, slug: p.slug, name: p.name, description: p.description, owningTeam: p.owningTeam,
      role: access.role, createdAt: p.createdAt.toISOString(), updatedAt: p.updatedAt.toISOString(),
      environments: envs.filter((e) => canAccessEnvironment(access, e._id)).map(toEnv),
    };
  }

  private async grant(p: Principal, projectId: string): Promise<ProjectAccess | null> {
    const m = await this.db.c.projectMemberships.findOne({ orgId: p.orgId, projectId, userId: p.userId });
    return resolveProjectAccess(p, m ? { role: m.role, environmentIds: m.environmentIds } : null);
  }

  /**
   * Loads a project the principal may see. Every query is scoped by orgId, and projects the caller cannot access
   * are reported as 404 (never 403) so ids cannot be probed across tenants or projects.
   */
  async requireProject(p: Principal, projectId: string, action: ProjectAction = 'project:read') {
    const project = await this.db.c.projects.findOne({ _id: projectId, orgId: p.orgId });
    const access = project ? await this.grant(p, projectId) : null;
    if (!project || !access) throw notFound('Project');
    if (!canProject(access, action)) throw forbidden();
    return { project, access };
  }

  async list(p: Principal): Promise<Project[]> {
    let projects: ProjectDoc[];
    const grants = new Map<string, ProjectMembershipDoc>();
    if (p.orgRole === 'owner' || p.orgRole === 'admin') {
      projects = await this.db.c.projects.find({ orgId: p.orgId }).sort({ name: 1 }).toArray();
    } else {
      const ms = await this.db.c.projectMemberships.find({ orgId: p.orgId, userId: p.userId }).toArray();
      ms.forEach((m) => grants.set(m.projectId, m));
      projects = await this.db.c.projects.find({ orgId: p.orgId, _id: { $in: ms.map((m) => m.projectId) } }).sort({ name: 1 }).toArray();
    }
    const envs = await this.db.c.environments.find({ orgId: p.orgId, projectId: { $in: projects.map((x) => x._id) } }).sort({ createdAt: 1 }).toArray();
    return projects.flatMap((proj) => {
      const g = grants.get(proj._id);
      const access = resolveProjectAccess(p, g ? { role: g.role, environmentIds: g.environmentIds } : null);
      return access ? [this.toProject(proj, access, envs.filter((e) => e.projectId === proj._id))] : [];
    });
  }

  async get(p: Principal, projectId: string): Promise<Project> {
    const { project, access } = await this.requireProject(p, projectId);
    const envs = await this.db.c.environments.find({ orgId: p.orgId, projectId }).sort({ createdAt: 1 }).toArray();
    return this.toProject(project, access, envs);
  }

  async create(
    p: Principal,
    body: { name: string; slug?: string | undefined; description: string; owningTeam: string; environments: { name: string; isProduction: boolean }[] },
    ctx: RequestContext,
  ): Promise<Project> {
    if (!canOrg(p, 'project:create')) throw forbidden();
    const slug = body.slug ?? slugify(body.name);
    if (!slug) throw conflict('Could not derive a valid slug from the name');
    const envSlugs = body.environments.map((e) => slugify(e.name));
    if (envSlugs.some((s) => !s) || new Set(envSlugs).size !== envSlugs.length) throw conflict('Environment names must be unique');

    const now = new Date();
    const project: ProjectDoc = {
      _id: crypto.randomUUID(), orgId: p.orgId, slug, name: body.name, description: body.description,
      owningTeam: body.owningTeam, createdBy: p.userId, createdAt: now, updatedAt: now,
    };
    // +i ms keeps creation order deterministic (all envs of one request would otherwise tie on createdAt).
    const envs: EnvironmentDoc[] = body.environments.map((e, i) => ({
      _id: crypto.randomUUID(), orgId: p.orgId, projectId: project._id, slug: envSlugs[i]!, name: e.name, isProduction: e.isProduction, createdAt: new Date(now.getTime() + i),
    }));
    try {
      await this.db.transaction(async (session) => {
        await this.db.c.projects.insertOne(project, { session });
        if (envs.length) await this.db.c.environments.insertMany(envs, { session });
        await this.db.c.projectMemberships.insertOne(
          { _id: crypto.randomUUID(), orgId: p.orgId, projectId: project._id, userId: p.userId, role: 'project_admin', environmentIds: null, createdAt: now },
          { session },
        );
        await this.audit.record(
          { orgId: p.orgId, actorUserId: p.userId, action: 'project.created', targetType: 'project', targetId: project._id, projectId: project._id, metadata: { name: project.name, slug, environments: envSlugs } },
          ctx, session,
        );
      });
    } catch (e) {
      if (isDuplicateKey(e)) throw conflict(`A project with slug "${slug}" already exists`);
      throw e;
    }
    return this.get(p, project._id);
  }

  async update(p: Principal, projectId: string, patch: { name?: string | undefined; description?: string | undefined; owningTeam?: string | undefined }, ctx: RequestContext): Promise<Project> {
    const { access } = await this.requireProject(p, projectId, 'project:update');
    // Project-level settings affect every environment; an environment-scoped admin must not change them.
    if (!isUnrestricted(access)) throw forbidden('Environment-restricted admins cannot change project-level settings');
    const set = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    await this.db.transaction(async (session) => {
      await this.db.c.projects.updateOne({ _id: projectId, orgId: p.orgId }, { $set: { ...set, updatedAt: new Date() } }, { session });
      await this.audit.record({ orgId: p.orgId, actorUserId: p.userId, action: 'project.updated', targetType: 'project', targetId: projectId, projectId, metadata: { fields: Object.keys(set) } }, ctx, session);
    });
    return this.get(p, projectId);
  }

  async addEnvironment(p: Principal, projectId: string, body: { name: string; isProduction: boolean }, ctx: RequestContext): Promise<Environment> {
    const { access } = await this.requireProject(p, projectId, 'environment:manage');
    // A new environment would be outside a restricted admin's scope, so creating one would be an escalation.
    if (!isUnrestricted(access)) throw forbidden('Environment-restricted admins cannot create environments');
    const slug = slugify(body.name);
    if (!slug) throw new AppError(400, 'validation_error', 'Could not derive a valid slug from the name');
    const env: EnvironmentDoc = { _id: crypto.randomUUID(), orgId: p.orgId, projectId, slug, name: body.name, isProduction: body.isProduction, createdAt: new Date() };
    try {
      await this.db.transaction(async (session) => {
        await this.db.c.environments.insertOne(env, { session });
        await this.audit.record({ orgId: p.orgId, actorUserId: p.userId, action: 'environment.created', targetType: 'environment', targetId: env._id, projectId, environmentId: env._id, metadata: { name: env.name, isProduction: env.isProduction } }, ctx, session);
      });
    } catch (e) {
      if (isDuplicateKey(e)) throw conflict(`Environment "${slug}" already exists in this project`);
      throw e;
    }
    return toEnv(env);
  }

  async deleteEnvironment(p: Principal, projectId: string, environmentId: string, ctx: RequestContext): Promise<void> {
    const { access } = await this.requireProject(p, projectId, 'environment:manage');
    // Out-of-scope environments are invisible to the caller, so report them as missing.
    if (!canAccessEnvironment(access, environmentId)) throw notFound('Environment');
    const env = await this.db.c.environments.findOne({ _id: environmentId, projectId, orgId: p.orgId });
    if (!env) throw notFound('Environment');
    await this.db.transaction(async (session) => {
      await this.db.c.environments.deleteOne({ _id: environmentId }, { session });
      // Drop the dangling reference from restricted memberships.
      await this.db.c.projectMemberships.updateMany({ projectId, environmentIds: environmentId }, { $pull: { environmentIds: environmentId } }, { session });
      await this.audit.record({ orgId: p.orgId, actorUserId: p.userId, action: 'environment.deleted', targetType: 'environment', targetId: environmentId, projectId, environmentId, metadata: { name: env.name } }, ctx, session);
    });
  }

  async listMembers(p: Principal, projectId: string) {
    const { access } = await this.requireProject(p, projectId, 'member:manage');
    let ms = await this.db.c.projectMemberships.find({ orgId: p.orgId, projectId }).toArray();
    const mine = access.environmentIds;
    // A restricted admin only sees members who can reach their environments, and only the overlapping part of the grant.
    if (mine) ms = ms.filter((m) => m.environmentIds === null || m.environmentIds.some((id) => mine.includes(id)));
    const users = await this.db.c.users.find({ _id: { $in: ms.map((m) => m.userId) } }).toArray();
    const byId = new Map(users.map((u) => [u._id, u]));
    return ms.flatMap((m) => {
      const u = byId.get(m.userId);
      const envIds = mine ? (m.environmentIds === null ? mine : m.environmentIds.filter((id) => mine.includes(id))) : m.environmentIds;
      return u ? [{ userId: u._id, email: u.email, displayName: u.displayName, role: m.role, environmentIds: envIds }] : [];
    });
  }

  async upsertMember(p: Principal, projectId: string, userId: string, body: { role: ProjectMembershipDoc['role']; environmentIds: string[] | null }, ctx: RequestContext) {
    const { access } = await this.requireProject(p, projectId, 'member:manage');
    // The target must belong to the SAME organization; environments must belong to THIS project.
    const orgMember = await this.db.c.orgMemberships.findOne({ orgId: p.orgId, userId });
    if (!orgMember) throw notFound('User');
    // Scope check: the grant (and any grant it replaces) must lie inside the caller's own environment scope.
    // This blocks widening one's own scope (e.g. restricted -> all environments) and touching other people's prod access.
    const existing = await this.db.c.projectMemberships.findOne({ orgId: p.orgId, projectId, userId });
    if (!scopeCovers(access, body.environmentIds) || (existing && !scopeCovers(access, existing.environmentIds))) {
      throw forbidden('You can only manage access to environments within your own scope');
    }
    if (body.environmentIds) {
      const n = await this.db.c.environments.countDocuments({ _id: { $in: body.environmentIds }, projectId, orgId: p.orgId });
      if (n !== new Set(body.environmentIds).size) throw notFound('Environment');
    }
    await this.db.transaction(async (session) => {
      await this.db.c.projectMemberships.updateOne(
        { projectId, userId },
        { $set: { role: body.role, environmentIds: body.environmentIds }, $setOnInsert: { _id: crypto.randomUUID(), orgId: p.orgId, createdAt: new Date() } },
        { upsert: true, session },
      );
      await this.audit.record({ orgId: p.orgId, actorUserId: p.userId, action: 'project.member.upserted', targetType: 'user', targetId: userId, projectId, metadata: { role: body.role, environmentIds: body.environmentIds } }, ctx, session);
    });
  }

  async removeMember(p: Principal, projectId: string, userId: string, ctx: RequestContext) {
    const { access } = await this.requireProject(p, projectId, 'member:manage');
    const existing = await this.db.c.projectMemberships.findOne({ orgId: p.orgId, projectId, userId });
    if (existing && !scopeCovers(access, existing.environmentIds)) throw forbidden('You can only manage access to environments within your own scope');
    await this.db.transaction(async (session) => {
      const r = await this.db.c.projectMemberships.deleteOne({ orgId: p.orgId, projectId, userId }, { session });
      if (!r.deletedCount) throw notFound('Member');
      await this.audit.record({ orgId: p.orgId, actorUserId: p.userId, action: 'project.member.removed', targetType: 'user', targetId: userId, projectId, metadata: {} }, ctx, session);
    });
  }
}
