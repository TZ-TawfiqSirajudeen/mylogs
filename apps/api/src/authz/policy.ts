import type { OrgRole, ProjectRole } from '@nexus/contracts';

/**
 * Authorization policy. Pure functions, no I/O, so every rule is unit-testable. Route handlers never
 * compare roles directly; they ask this module.
 *
 * Role model
 *  - Org roles: owner, admin (implicit project_admin on every project), member (needs project grants),
 *    auditor (read-only audit history; deliberately NO telemetry/project access unless explicitly granted).
 *  - Project roles: project_admin, engineer, viewer; optionally restricted to specific environments.
 */
export interface Principal { userId: string; orgId: string; orgRole: OrgRole }
export interface ProjectAccess { role: ProjectRole; environmentIds: string[] | null }

export type OrgAction = 'project:create' | 'audit:read' | 'org:members:read' | 'org:members:manage';
export type ProjectAction =
  | 'project:read' | 'project:update' | 'environment:manage' | 'member:manage'
  | 'telemetry:read' | 'connection:manage' | 'incident:write';

const ORG_ACTIONS: Record<OrgRole, readonly OrgAction[]> = {
  owner: ['project:create', 'audit:read', 'org:members:read', 'org:members:manage'],
  admin: ['project:create', 'audit:read', 'org:members:read', 'org:members:manage'],
  member: [],
  auditor: ['audit:read'],
};

const PROJECT_ACTIONS: Record<ProjectRole, readonly ProjectAction[]> = {
  project_admin: ['project:read', 'project:update', 'environment:manage', 'member:manage', 'telemetry:read', 'connection:manage', 'incident:write'],
  engineer: ['project:read', 'telemetry:read', 'incident:write'],
  viewer: ['project:read', 'telemetry:read'],
};

export function canOrg(p: Principal, action: OrgAction): boolean {
  return ORG_ACTIONS[p.orgRole].includes(action);
}

/**
 * Who may set or change which org role. Privilege is only handed out by someone at least as privileged:
 * admins manage member/auditor accounts; only owners create, change or remove admins and owners.
 * `current` = the target's existing role (null when adding); `next` = the new role (null when removing).
 */
export function canChangeOrgRole(actor: OrgRole, current: OrgRole | null, next: OrgRole | null): boolean {
  if (actor === 'owner') return true;
  if (actor !== 'admin') return false;
  const privileged = (r: OrgRole | null) => r === 'owner' || r === 'admin';
  return !privileged(current) && !privileged(next);
}

/** Effective access to one project, or null when the principal has none. */
export function resolveProjectAccess(p: Principal, grant: ProjectAccess | null): ProjectAccess | null {
  if (p.orgRole === 'owner' || p.orgRole === 'admin') return { role: 'project_admin', environmentIds: null };
  return grant;
}

export function canProject(access: ProjectAccess | null, action: ProjectAction): boolean {
  return !!access && PROJECT_ACTIONS[access.role].includes(action);
}

/**
 * True when the caller's environment scope fully contains `target` (null = all environments). An environment-restricted
 * project admin may only manage things inside their own scope — never widen it, never touch environments outside it.
 */
export function scopeCovers(access: ProjectAccess | null, target: string[] | null): boolean {
  if (!access) return false;
  if (access.environmentIds === null) return true;
  if (target === null) return false;
  return target.every((id) => access.environmentIds!.includes(id));
}

export const isUnrestricted = (access: ProjectAccess | null): boolean => !!access && access.environmentIds === null;

export function canAccessEnvironment(access: ProjectAccess | null, environmentId: string): boolean {
  if (!access) return false;
  return access.environmentIds === null || access.environmentIds.includes(environmentId);
}
