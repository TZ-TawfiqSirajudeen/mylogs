import { DEMO, env, expect, login, logout, selectProject, test, apiAs } from '../support/fixtures.js';
import { createHttpConnection, createProject, grant, orgMembers, uniq } from '../support/helpers.js';

test.describe('role-based access, as the browser shows it', () => {
  let projectName: string;
  let projectId: string;
  let devEnv: string;
  let prodEnv: string;
  let connName: string;

  test.beforeAll(async ({ browser }) => {
    const page = await browser.newPage({ baseURL: env().web });
    await login(page, DEMO.owner);
    projectName = uniq('E2E RBAC');
    connName = uniq('rbac conn');
    const p = await createProject(page, projectName);
    projectId = p.id; devEnv = p.environments[0]!.id; prodEnv = p.environments[1]!.id;
    const m = await orgMembers(page);
    await grant(page, projectId, m[DEMO.engineer]!, 'engineer');
    await grant(page, projectId, m[DEMO.viewer]!, 'viewer', [devEnv]); // viewer is restricted to Development
    await createHttpConnection(page, projectId, devEnv, connName, `${env().target}/healthz`, env().token);
    await createHttpConnection(page, projectId, prodEnv, `${connName} prod`, `${env().target}/healthz`, env().token);
    await page.close();
  });

  test('viewer: read-only data sources — sees status, no way to add/test/rotate/disconnect/delete', async ({ page }) => {
    await login(page, DEMO.viewer);
    await selectProject(page, projectName);
    await page.goto('/sources');
    await expect(page.getByText(/read-only access to this project's data sources/)).toBeVisible();
    const card = page.locator('li', { hasText: connName });
    await expect(card).toBeVisible();
    await expect(card.getByTestId('connection-state')).toBeVisible();
    for (const b of ['Test now', 'Rotate credentials', 'Disconnect', 'Delete']) await expect(card.getByRole('button', { name: b })).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'Add data source' })).toHaveCount(0);
    await expect(card.getByRole('link', { name: 'Continue setup' })).toHaveCount(0);
  });

  test('viewer: environment restriction hides production connections and the production environment itself', async ({ page }) => {
    await login(page, DEMO.viewer);
    await selectProject(page, projectName);
    await page.goto('/sources');
    await expect(page.locator('li', { hasText: `${connName} prod` })).toHaveCount(0);
    await expect(page.locator('#env-switch').locator('option', { hasText: 'Production' })).toHaveCount(0);
    const r = await apiAs(page, 'GET', `/api/v1/projects/${projectId}/connections`);
    expect(r.json.map((c: { name: string }) => c.name)).toEqual([connName]);
  });

  test('engineer: can read but not manage; the wizard refuses to start for non-admins', async ({ page }) => {
    await login(page, DEMO.engineer);
    await selectProject(page, projectName);
    await page.goto('/sources');
    await expect(page.locator('li', { hasText: connName }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'Add data source' })).toHaveCount(0);
    await expect(page.locator('li', { hasText: connName }).first().getByRole('button', { name: 'Delete' })).toHaveCount(0);
    await page.goto('/sources/new');
    await expect(page.getByText(/not an admin of any project/)).toBeVisible();
  });

  test('forced API calls are rejected server-side even when the UI is bypassed', async ({ page }) => {
    await login(page, DEMO.viewer);
    const list = await apiAs(page, 'GET', `/api/v1/projects/${projectId}/connections`);
    const id = list.json[0].id;
    for (const [method, path, body] of [
      ['POST', `/api/v1/projects/${projectId}/connections/${id}/test`, undefined],
      ['POST', `/api/v1/projects/${projectId}/connections/${id}/rotate`, { secrets: { token: 'hijack-token-12345' } }],
      ['DELETE', `/api/v1/projects/${projectId}/connections/${id}`, undefined],
      ['POST', `/api/v1/projects/${projectId}/environments/${devEnv}/connections`, { connectorType: 'redis', name: 'x', authMethod: 'none', config: { host: 'a' }, secrets: {} }],
    ] as const) {
      const r = await apiAs(page, method, path, body);
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    const prodConn = await apiAs(page, 'GET', `/api/v1/projects/${projectId}/connections/00000000-0000-4000-8000-000000000000`);
    expect(prodConn.status).toBe(404);
  });

  test('auditor: reads the audit trail but sees no projects or connections', async ({ page }) => {
    await login(page, DEMO.auditor);
    await page.goto('/audit');
    await expect(page.getByRole('table', { name: 'Audit events, newest first' })).toBeVisible();
    await expect(page.getByText('connection.created').first()).toBeVisible();
    await page.goto('/projects');
    await expect(page.getByText('You have not been granted access to any project')).toBeVisible();
    const r = await apiAs(page, 'GET', `/api/v1/projects/${projectId}/connections`);
    expect(r.status).toBe(404);
  });

  test('other tenant: cannot see, open or probe this organization\'s project or connections', async ({ page }) => {
    await login(page, DEMO.globex);
    await page.goto('/projects');
    await expect(page.getByText(projectName)).toHaveCount(0);
    await page.goto(`/projects/${projectId}`);
    await expect(page.getByText('Project not found')).toBeVisible();
    for (const path of [`/api/v1/projects/${projectId}/connections`, `/api/v1/projects/${projectId}`]) {
      expect((await apiAs(page, 'GET', path)).status).toBe(404);
    }
    await page.goto('/audit');
    await expect(page.getByText(projectName)).toHaveCount(0);
    await expect(page.getByText('connection.created')).toHaveCount(0);
  });
});

test.describe('audit trail', () => {
  test('owner sees attributed, redacted, newest-first events; secrets never appear', async ({ page, db }) => {
    await login(page, DEMO.owner);
    const name = uniq('E2E Audit');
    const p = await createProject(page, name);
    const token = `audit-secret-${Date.now().toString(36)}-xxxxxxxx`;
    await createHttpConnection(page, p.id, p.environments[0]!.id, uniq('audit conn'), `${env().target}/healthz`, token);
    await page.goto('/audit');
    const table = page.getByRole('table', { name: 'Audit events, newest first' });
    await expect(table).toBeVisible();
    await expect(table.getByRole('row').nth(1)).toContainText('connection.created'); // newest first
    await expect(table.getByText('project.created').first()).toBeVisible();
    await expect(table.getByText(/\d{4}-\d\d-\d\d \d\d:\d\d:\d\dZ/).first()).toBeVisible(); // UTC timestamps
    await expect(page.locator('body')).not.toContainText(token);
    expect(JSON.stringify(await db.find('audit_events'))).not.toContain(token);
  });

  test('older events load on demand and the list stays ordered', async ({ page }) => {
    await login(page, DEMO.owner);
    for (let i = 0; i < 3; i++) await createProject(page, uniq('E2E Fill')); // make sure there is history
    await page.goto('/audit');
    await expect(page.getByRole('table')).toBeVisible();
    const more = page.getByRole('button', { name: 'Load older events' });
    if (await more.count()) {
      const before = await page.locator('tbody tr').count();
      await more.click();
      await expect.poll(() => page.locator('tbody tr').count()).toBeGreaterThan(before);
    }
    const times = await page.locator('tbody tr td:first-child').allTextContents();
    expect([...times].sort().reverse()).toEqual(times);
  });

  test('non-privileged roles get a clear refusal, not an empty table', async ({ page }) => {
    await login(page, DEMO.viewer);
    await page.goto('/audit');
    await expect(page.getByText('Audit history is available to organization owners, admins and auditors.')).toBeVisible();
    await logout(page);
  });
});
