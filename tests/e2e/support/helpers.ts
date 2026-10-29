import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { apiAs, expect, type Db } from './fixtures.js';

export const uniq = (p: string) => `${p} ${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/** Creates a project (owner session required) and returns its id and environments. */
export async function createProject(page: Page, name: string, envs = [{ name: 'Development' }, { name: 'Production', isProduction: true }]) {
  const r = await apiAs(page, 'POST', '/api/v1/projects', { name, environments: envs });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json as { id: string; environments: { id: string; name: string; isProduction: boolean }[] };
}

export async function orgMembers(page: Page): Promise<Record<string, string>> {
  const r = await apiAs(page, 'GET', '/api/v1/org/members');
  return Object.fromEntries((r.json as { email: string; userId: string }[]).map((m) => [m.email, m.userId]));
}

export async function grant(page: Page, projectId: string, userId: string, role: 'engineer' | 'viewer' | 'project_admin', environmentIds: string[] | null = null) {
  const r = await apiAs(page, 'PUT', `/api/v1/projects/${projectId}/members/${userId}`, { role, environmentIds });
  expect(r.status).toBe(204);
}

export async function createHttpConnection(page: Page, projectId: string, envId: string, name: string, url: string, token: string) {
  const r = await apiAs(page, 'POST', `/api/v1/projects/${projectId}/environments/${envId}/connections`, {
    connectorType: 'http-health', name, authMethod: 'bearer', config: { url }, secrets: { token },
  });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json as { id: string };
}

/** Make the worker check this connection right now (it ticks every 500 ms in the e2e stack). */
export async function makeDue(db: Db, name: string) {
  await db.update('connections', { name }, { $set: { 'health.nextCheckAt': { $date: new Date(Date.now() - 1000).toISOString() } } });
}

export async function stateOf(db: Db, name: string): Promise<string> {
  return (await db.find('connections', { name }))[0]?.health.state;
}

export async function accessibilityViolations(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => ({
    rule: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => `${n.target.join(' ')} :: ${(n.failureSummary ?? '').split('\n')[1] ?? ''}`),
  }));
}

export async function noHorizontalScroll(page: Page) {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
}
