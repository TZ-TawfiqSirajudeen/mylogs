import { DEMO, env, expect, login, selectProject, test } from '../support/fixtures.js';
import { createHttpConnection, createProject, noHorizontalScroll, uniq } from '../support/helpers.js';

const VIEWPORTS = [
  { name: 'phone', width: 375, height: 667 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1440, height: 900 },
];

for (const vp of VIEWPORTS) {
  test.describe(`layout at ${vp.name} (${vp.width}px)`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('no screen scrolls horizontally; navigation and controls stay reachable', async ({ page }) => {
      test.setTimeout(120_000);
      const name = uniq(`E2E Layout ${vp.name}`);
      await login(page, DEMO.owner);
      const p = await createProject(page, name);
      await createHttpConnection(page, p.id, p.environments[0]!.id, uniq('layout conn'), `${env().target}/healthz`, env().token);
      await page.reload();
      await selectProject(page, name);

      const overflowing: string[] = [];
      const check = async (label: string) => { if (!(await noHorizontalScroll(page))) overflowing.push(label); };

      await page.goto('/'); await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible(); await check('overview');
      await page.goto('/projects'); await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible(); await check('projects');
      await page.getByRole('button', { name: 'New project' }).click(); await check('projects: form');
      await page.goto(`/projects/${p.id}`); await expect(page.getByRole('heading', { name })).toBeVisible(); await check('project detail');
      await page.goto('/sources'); await expect(page.getByTestId('connection-state').first()).toBeVisible(); await check('sources');
      await page.locator('summary').first().click(); await check('sources: details');
      await page.getByRole('tab', { name: 'Capability matrix' }).click(); await expect(page.getByRole('table')).toBeVisible(); await check('matrix');
      await page.goto('/sources/new'); await check('wizard 1');
      await page.getByRole('button', { name: /Authenticated application health check/ }).click();
      await page.getByRole('button', { name: 'Next' }).click(); await check('wizard 2');
      await page.locator('main').getByLabel('Environment').selectOption({ label: 'Development' });
      await page.getByRole('button', { name: 'Next' }).click();
      await page.getByRole('button', { name: 'Next' }).click(); await check('wizard 4 (details)');
      await page.goto('/audit'); await expect(page.getByRole('table')).toBeVisible(); await check('audit');
      expect(overflowing, `screens with horizontal page scroll at ${vp.width}px`).toEqual([]);
    });
  });
}

test.describe('phone navigation', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('menu is collapsed by default, opens, navigates and closes', async ({ page }) => {
    await login(page, DEMO.owner);
    const menu = page.getByRole('button', { name: 'Menu' });
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeHidden();
    await menu.click();
    await expect(menu).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('link', { name: 'Audit Logs' }).click();
    await expect(page.getByRole('heading', { name: 'Audit Logs' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeHidden(); // closes after navigating
  });

  test('an urgent incident check works on a phone: status of a connection is readable without zooming', async ({ page }) => {
    await login(page, DEMO.owner);
    const name = uniq('E2E Phone');
    const p = await createProject(page, name);
    const conn = uniq('phone conn');
    await createHttpConnection(page, p.id, p.environments[0]!.id, conn, `${env().target}/healthz`, env().token);
    await page.reload();
    await selectProject(page, name);
    await page.goto('/sources');
    const card = page.locator('li', { hasText: conn });
    await expect(card.getByTestId('connection-state')).toBeVisible();
    const box = await card.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(375);
    const fontSize = await card.locator('dd').first().evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
    expect(fontSize).toBeGreaterThanOrEqual(14);
  });
});

test.describe('hostile content does not break layout', () => {
  test('very long unbroken names wrap or scroll inside their container, never the page', async ({ page }) => {
    await login(page, DEMO.owner);
    const long = `${'W'.repeat(90)}${Date.now().toString(36)}`;
    const p = await createProject(page, long);
    await page.goto('/projects');
    await expect(page.locator('main').getByText(long)).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    await page.goto(`/projects/${p.id}`);
    expect(await noHorizontalScroll(page)).toBe(true);
    await selectProject(page, long);
    expect(await noHorizontalScroll(page)).toBe(true);
  });
});
