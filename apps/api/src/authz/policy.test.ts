import { describe, expect, test } from 'vitest';
import { canAccessEnvironment, canOrg, canProject, isUnrestricted, resolveProjectAccess, scopeCovers, type Principal } from './policy.js';

const p = (orgRole: Principal['orgRole']): Principal => ({ userId: 'u', orgId: 'o', orgRole });

describe('org actions', () => {
  test.each([
    ['owner', 'project:create', true], ['admin', 'project:create', true], ['member', 'project:create', false],
    ['auditor', 'project:create', false], ['auditor', 'audit:read', true], ['member', 'audit:read', false],
    ['admin', 'audit:read', true],
  ] as const)('%s %s -> %s', (role, action, expected) => expect(canOrg(p(role), action)).toBe(expected));
});

describe('project access', () => {
  test('owner/admin get project_admin on all environments without a grant', () => {
    for (const r of ['owner', 'admin'] as const) {
      expect(resolveProjectAccess(p(r), null)).toEqual({ role: 'project_admin', environmentIds: null });
    }
  });
  test('members and auditors without a grant have no access', () => {
    expect(resolveProjectAccess(p('member'), null)).toBeNull();
    expect(resolveProjectAccess(p('auditor'), null)).toBeNull();
  });
  test('explicit grant is honoured', () => {
    const g = { role: 'viewer' as const, environmentIds: ['e1'] };
    expect(resolveProjectAccess(p('member'), g)).toEqual(g);
  });
  test('viewer cannot mutate; engineer cannot manage connections; admin can', () => {
    expect(canProject({ role: 'viewer', environmentIds: null }, 'telemetry:read')).toBe(true);
    expect(canProject({ role: 'viewer', environmentIds: null }, 'project:update')).toBe(false);
    expect(canProject({ role: 'engineer', environmentIds: null }, 'connection:manage')).toBe(false);
    expect(canProject({ role: 'project_admin', environmentIds: null }, 'member:manage')).toBe(true);
    expect(canProject(null, 'project:read')).toBe(false);
  });
  test('scopeCovers: restricted callers can only manage targets inside their own scope', () => {
    const open = { role: 'project_admin' as const, environmentIds: null };
    const scoped = { role: 'project_admin' as const, environmentIds: ['e1', 'e2'] };
    expect(scopeCovers(open, null)).toBe(true);
    expect(scopeCovers(open, ['x'])).toBe(true);
    expect(scopeCovers(scoped, ['e1'])).toBe(true);
    expect(scopeCovers(scoped, ['e1', 'e2'])).toBe(true);
    expect(scopeCovers(scoped, ['e1', 'e3'])).toBe(false);
    expect(scopeCovers(scoped, null)).toBe(false); // cannot grant "all environments"
    expect(scopeCovers(null, ['e1'])).toBe(false);
    expect(isUnrestricted(open)).toBe(true);
    expect(isUnrestricted(scoped)).toBe(false);
  });
  test('environment restriction', () => {
    expect(canAccessEnvironment({ role: 'viewer', environmentIds: ['e1'] }, 'e1')).toBe(true);
    expect(canAccessEnvironment({ role: 'viewer', environmentIds: ['e1'] }, 'e2')).toBe(false);
    expect(canAccessEnvironment({ role: 'viewer', environmentIds: null }, 'e2')).toBe(true);
    expect(canAccessEnvironment(null, 'e1')).toBe(false);
  });
});
