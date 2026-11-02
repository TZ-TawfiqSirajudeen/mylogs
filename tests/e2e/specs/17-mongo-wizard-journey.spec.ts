import { DEMO, env, expect, login, selectProject, test } from '../support/fixtures.js';
import { createProject, uniq } from '../support/helpers.js';

const next = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'Next' });

test.describe('MongoDB data source: what you chose stays visible', () => {
  test('discover, choose a database, save, start: the Data Sources page keeps showing the connection and exactly what was chosen', async ({ page }) => {
    test.setTimeout(120_000);
    const projectName = uniq('E2E Mongo journey');
    const connName = uniq('mongo journey');
    await login(page, DEMO.owner);
    await createProject(page, projectName);
    await page.reload();
    await selectProject(page, projectName);

    await page.goto('/sources/new');
    await page.getByRole('button', { name: /^MongoDB/ }).click();
    await next(page).click();
    await page.locator('main').getByLabel('Environment').selectOption({ label: 'Development' });
    await next(page).click();
    await page.getByLabel('No authentication').check();
    await next(page).click();

    const u = new URL(env().mongo.replace('mongodb://', 'http://'));
    await page.getByLabel('Connection name').fill(connName);
    await page.getByLabel(/^Hosts/).fill(`${u.hostname}:${u.port}`);
    await page.getByLabel(/Use TLS/).uncheck(); // the throwaway test database has no TLS
    await next(page).click();
    await page.getByRole('button', { name: 'Validate and save draft' }).click();
    await expect(page.getByText(/Draft saved/)).toBeVisible();
    await next(page).click(); // permissions
    await next(page).click(); // test
    await page.getByRole('button', { name: 'Run connection test' }).click();
    await expect(page.getByText('Connection verified.')).toBeVisible({ timeout: 30_000 });
    await next(page).click(); // discover
    await page.getByRole('button', { name: 'Discover resources' }).click();
    await expect(page.getByText(/resource\(s\) found/)).toBeVisible({ timeout: 30_000 });
    await next(page).click(); // select

    const boxes = page.getByRole('checkbox');
    await boxes.first().check(); // the instance
    const dbBox = page.locator('li').filter({ hasText: /mongodb_database/ }).getByRole('checkbox').first();
    await dbBox.check();
    for (const s of await page.locator('label').filter({ has: page.getByRole('checkbox') }).filter({ hasText: /^(metrics|inventory)$/ }).all()) await s.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Save selection' }).click();
    await expect(page.getByText(/Selection saved/)).toBeVisible();
    await next(page).click(); // settings
    await page.getByRole('button', { name: 'Save settings' }).click();
    await next(page).click(); // preview
    await next(page).click(); // start
    await page.getByRole('button', { name: 'Start monitoring' }).click();
    await expect(page.getByText('Monitoring started.')).toBeVisible();
    await page.getByRole('button', { name: 'Go to Data Sources' }).click();

    const card = page.locator('li').filter({ hasText: connName });
    await expect(card).toBeVisible();
    // What was chosen must be visible without re-running the wizard.
    await expect(card.getByTestId('selected-resources')).toBeVisible();
    await expect(card.getByTestId('selected-resources')).toContainText('admin');
  });
});
