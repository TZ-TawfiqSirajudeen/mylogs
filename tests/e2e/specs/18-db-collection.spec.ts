import { DEMO, env, expect, login, selectProject, test } from '../support/fixtures.js';
import { accessibilityViolations, createProject, makeDue, uniq } from '../support/helpers.js';

const next = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'Next' });

test.describe('MongoDB data source: the chosen database really feeds the Metrics page', () => {
  test('connect through the wizard, let the worker collect, see the card report it and the metrics appear (labelled as a connector, not a service)', async ({ page, db }) => {
    test.setTimeout(180_000);
    const projectName = uniq('E2E DB collection');
    const connName = uniq('collect mongo');
    await login(page, DEMO.owner);
    await createProject(page, projectName);
    await page.reload();
    await selectProject(page, projectName);

    // ---- the wizard, exactly as a user walks it (the stack's throwaway mongod has no TLS and no authentication)
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
    await page.getByLabel(/Use TLS/).uncheck();
    await next(page).click();
    await page.getByRole('button', { name: 'Validate and save draft' }).click();
    await expect(page.getByText(/Draft saved/)).toBeVisible();
    await next(page).click();
    await next(page).click();
    await page.getByRole('button', { name: 'Run connection test' }).click();
    await expect(page.getByText('Connection verified.')).toBeVisible({ timeout: 30_000 });
    await next(page).click();
    await page.getByRole('button', { name: 'Discover resources' }).click();
    await expect(page.getByText(/resource\(s\) found/)).toBeVisible({ timeout: 30_000 });
    await next(page).click();
    await page.locator('li').filter({ hasText: /mongodb_instance/ }).getByRole('checkbox').first().check();
    await page.locator('li').filter({ hasText: /mongodb_database/ }).getByRole('checkbox').first().check();
    await page.getByLabel('metrics', { exact: true }).check();
    await page.getByRole('button', { name: 'Save selection' }).click();
    await expect(page.getByText(/Selection saved/)).toBeVisible();
    await next(page).click();
    await page.getByRole('button', { name: 'Save settings' }).click();
    await next(page).click();
    await expect(page.getByText(/metric collection every 60s/)).toBeVisible(); // the preview says what will run
    await next(page).click();
    await page.getByRole('button', { name: 'Start monitoring' }).click();
    await expect(page.getByText('Monitoring started.')).toBeVisible();
    await expect(page.getByText(/Waiting for the first collection/)).toBeVisible();
    await page.getByRole('button', { name: 'Go to Data Sources' }).click();

    // ---- the worker (500 ms tick) picks it up as soon as it is due
    const card = page.locator('li').filter({ hasText: connName });
    await expect(card.getByTestId('collection-status')).toContainText('Waiting for first collection');
    await makeDue(db, connName);
    await expect(async () => {
      await page.reload();
      await expect(card.getByTestId('collection-status')).toContainText('Collecting metrics');
    }).toPass({ timeout: 40_000, intervals: [1_000, 2_000] });
    await expect(card.getByTestId('collection-note')).toContainText(/Collecting every 60s, \d+ series per collection/);
    await expect(card.getByTestId('collection-last-success')).not.toContainText('—');
    await expect(card.getByTestId('selected-resources')).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
    const stored = (await db.find('connections', { name: connName }))[0];
    expect(stored.collection.status).toBe('running');
    expect(stored.collection.lastSuccessfulCollectionAt).toBeTruthy();

    // ---- the data is on the Metrics page, labelled as coming from a connector
    await card.getByRole('link', { name: 'See its metrics' }).click();
    await expect(page.getByTestId('connector-metric-note')).toContainText('data-source connector');
    await expect(page.getByTestId('connector-metric-note')).toContainText(connName);
    await expect(page.getByTestId('metric-summary')).toContainText('1 series');
    const row = page.getByRole('table', { name: 'Series summary' }).getByRole('row').nth(1);
    await expect(row).toBeVisible();
    expect(Number((await row.getByRole('cell').first().textContent())!.replace(/[^\d.]/g, ''))).toBeGreaterThanOrEqual(1); // at least our own connection
    expect(await accessibilityViolations(page)).toEqual([]);

    // ---- and it is NOT presented as an application service
    await page.goto('/services');
    await expect(page.getByRole('heading', { name: 'Services' })).toBeVisible();
    await expect(page.getByText(connName)).toHaveCount(0);
    expect(await db.count('services', { name: connName })).toBe(0);
  });
});
