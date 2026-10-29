import type { Page } from '@playwright/test';
import { DEMO, env, expect, login, selectProject, test } from '../support/fixtures.js';
import { accessibilityViolations, createHttpConnection, createProject, uniq } from '../support/helpers.js';

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => { localStorage.setItem('nx-theme', t); document.documentElement.classList.toggle('dark', t === 'dark'); }, theme);
}

for (const theme of ['light', 'dark'] as const) {
  test.describe(`accessibility (WCAG 2 A/AA via axe) — ${theme} theme`, () => {
    test(`${theme}: login screen`, async ({ page }) => {
      await page.goto('/');
      await setTheme(page, theme);
      await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
      expect(await accessibilityViolations(page)).toEqual([]);
    });

    test(`${theme}: signed-in screens`, async ({ page }) => {
      test.setTimeout(150_000);
      const name = uniq(`E2E A11y ${theme}`);
      await login(page, DEMO.owner);
      await setTheme(page, theme);
      const p = await createProject(page, name);
      await createHttpConnection(page, p.id, p.environments[0]!.id, uniq('a11y conn'), `${env().target}/healthz`, env().token);
      await page.reload();
      await selectProject(page, name);

      const failures: Record<string, unknown> = {};
      const scan = async (label: string) => {
        const v = await accessibilityViolations(page);
        if (v.length) failures[label] = v;
      };

      await page.goto('/'); await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible(); await scan('overview');
      await page.goto('/projects'); await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible(); await scan('projects');
      await page.getByRole('button', { name: 'New project' }).click(); await scan('projects: new-project form');
      await page.goto(`/projects/${p.id}`); await expect(page.getByRole('heading', { name })).toBeVisible(); await scan('project detail');
      await page.locator('#env-switch').selectOption({ label: 'Production (production)' }); await scan('production banner');
      await page.locator('#env-switch').selectOption({ label: 'All environments' });
      await page.goto('/sources'); await expect(page.getByTestId('connection-state').first()).toBeVisible(); await scan('data sources list');
      await page.locator('summary').first().click(); await scan('data sources list (details open)');
      await page.getByRole('tab', { name: 'Capability matrix' }).click(); await expect(page.getByRole('table')).toBeVisible(); await scan('capability matrix');
      await page.goto('/sources/new'); await scan('wizard: provider');
      await page.getByRole('button', { name: /Authenticated application health check/ }).click();
      await page.getByRole('button', { name: 'Next' }).click(); await scan('wizard: scope');
      await page.locator('main').getByLabel('Environment').selectOption({ label: 'Development' });
      await page.getByRole('button', { name: 'Next' }).click(); await scan('wizard: authentication');
      await page.getByRole('button', { name: 'Next' }).click(); await scan('wizard: details');
      await page.goto('/audit'); await expect(page.getByRole('table')).toBeVisible(); await scan('audit');
      await page.goto('/logs'); await scan('not-implemented page');

      // Report each distinct problem once, with the screens it appears on.
      const distinct = new Map<string, string[]>();
      for (const [screen, list] of Object.entries(failures)) {
        for (const v of list as { rule: string; nodes: string[] }[]) {
          for (const n of v.nodes) {
            const key = `${v.rule} | ${n.replace(/\s+/g, ' ').slice(0, 230)}`;
            distinct.set(key, [...(distinct.get(key) ?? []), screen]);
          }
        }
      }
      const report = [...distinct].map(([k, screens]) => `${k} || on: ${[...new Set(screens)].join(', ')}`).join(' ## ');
      expect(distinct.size, `Distinct accessibility problems (${theme}): ${report}`).toBe(0);
    });
  });
}
