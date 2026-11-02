import { DEMO, expect, login, selectProject, test } from '../support/fixtures.js';
import { createProject, uniq } from '../support/helpers.js';

test.describe('projects and environments', () => {
  test('owner creates a project with environments through the UI', async ({ page }) => {
    const name = uniq('E2E Alpha');
    await login(page, DEMO.owner);
    await page.getByRole('link', { name: 'Projects', exact: true }).click();
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByLabel('Owning team').fill('platform');
    await page.getByLabel('Description').fill('Created by the e2e suite');
    await page.getByLabel('Staging').check();
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('heading', { name })).toBeVisible();
    for (const env of ['Development', 'Production', 'Staging']) await expect(page.getByRole('listitem').filter({ hasText: env }).first()).toBeVisible();
    await expect(page.getByText('production', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('Team: platform')).toBeVisible();
  });

  test('validation: empty name is rejected; duplicate names are reported', async ({ page }) => {
    const name = uniq('E2E Dup');
    await login(page, DEMO.owner);
    await createProject(page, name);
    await page.goto('/projects');
    await page.getByRole('button', { name: 'New project' }).click();
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByRole('alert').first()).toBeVisible();
    await page.getByLabel('Name', { exact: true }).fill(name);
    await page.getByRole('button', { name: 'Create project' }).click();
    await expect(page.getByText(/already exists/)).toBeVisible();
  });

  test('add and delete a custom environment', async ({ page }) => {
    const name = uniq('E2E Envs');
    await login(page, DEMO.owner);
    const p = await createProject(page, name);
    await page.goto(`/projects/${p.id}`);
    await page.getByLabel('New environment').fill('QA Sandbox');
    await page.getByRole('button', { name: 'Add' }).click();
    const row = page.getByRole('listitem').filter({ hasText: 'QA Sandbox' });
    await expect(row).toBeVisible();
    await expect(row.getByText('qa-sandbox')).toBeVisible();
    // duplicate is refused
    await page.getByLabel('New environment').fill('qa sandbox');
    await page.getByRole('button', { name: 'Add' }).click();
    await expect(page.getByText(/already exists/)).toBeVisible();
    page.once('dialog', (d) => void d.accept());
    await row.getByRole('button', { name: 'Delete' }).click();
    await expect(row).toHaveCount(0);
  });

  test('production banner appears only while a production environment is selected', async ({ page }) => {
    const name = uniq('E2E Prod');
    await login(page, DEMO.owner);
    await createProject(page, name);
    await page.reload();
    await selectProject(page, name);
    await expect(page.getByText(/viewing PRODUCTION/)).toHaveCount(0);
    await page.locator('#env-switch').selectOption({ label: 'Development' });
    await expect(page.getByText(/viewing PRODUCTION/)).toHaveCount(0);
    await page.locator('#env-switch').selectOption({ label: 'Production (production)' });
    await expect(page.getByText(`viewing PRODUCTION — ${name} / Production`)).toBeVisible();
    // the selection survives reload (ids only)
    await page.reload();
    await expect(page.getByText(/viewing PRODUCTION/)).toBeVisible();
  });

  test('overview only shows real control-plane counts and says no telemetry exists', async ({ page }) => {
    await login(page, DEMO.owner);
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(page.getByText('No data sources connected')).toBeVisible();
    await expect(page.getByText(/Nothing on this page is demo or estimated data/)).toBeVisible();
    // no fabricated metrics tiles
    // exactly the three control-plane tiles, no telemetry tiles
    await expect(page.locator('main .tabular-nums')).toHaveCount(3);
    for (const tile of ['Projects', 'Environments', 'Production environments']) await expect(page.locator('main').getByText(tile, { exact: true })).toBeVisible();
  });

  test('members without a grant see no projects and cannot create any', async ({ page }) => {
    await login(page, DEMO.viewer);
    await page.goto('/projects');
    await expect(page.getByText('You have not been granted access to any project')).toBeVisible();
    await expect(page.getByRole('button', { name: 'New project' })).toHaveCount(0);
  });

  test('a project the user cannot access looks like it does not exist', async ({ page }) => {
    await login(page, DEMO.owner);
    const p = await createProject(page, uniq('E2E Hidden'));
    await page.context().clearCookies();
    await page.goto('/');
    await login(page, DEMO.globex);
    await page.goto(`/projects/${p.id}`);
    await expect(page.getByText('Project not found')).toBeVisible();
    await expect(page.getByText('does not exist or you do not have access')).toBeVisible();
  });

  test('unimplemented modules say so and offer no controls or numbers', async ({ page }) => {
    await login(page, DEMO.owner);
    for (const [path, phase] of [['/dependencies', 7], ['/deployments', 6], ['/dashboards', 7]] as const) {
      await page.goto(path);
      await expect(page.getByText('Not implemented yet')).toBeVisible();
      await expect(page.getByText(`phase ${phase}`)).toBeVisible();
    }
    // Incidents and alerts exist now (alerting, ADR-0006): they must not claim to be unimplemented.
    for (const path of ['/incidents', '/alerts']) {
      await page.goto(path);
      await expect(page.locator('main h1').first()).toBeVisible();
      await expect(page.getByText('Not implemented yet')).toHaveCount(0);
    }
  });

  test('XSS: hostile names render as text and never execute', async ({ page }) => {
    await login(page, DEMO.owner);
    const hostile = `<img src=x onerror="window.__xss=1"> ${Date.now().toString(36)}`;
    await createProject(page, hostile);
    await page.goto('/projects');
    await expect(page.locator('main').getByText(hostile)).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    expect(await page.locator('img[src="x"]').count()).toBe(0);
  });
});
