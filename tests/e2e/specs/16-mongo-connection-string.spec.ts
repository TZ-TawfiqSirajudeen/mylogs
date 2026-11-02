import { DEMO, expect, login, selectProject, test } from '../support/fixtures.js';
import { accessibilityViolations, createProject, uniq } from '../support/helpers.js';

const next = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'Next' });

// A made-up string: nothing here is a real host or credential, and the "Fill" step does not connect anywhere.
const FAKE = 'mongodb://monitor:s%40fe%2Fpass@db1.example.com:27018,db2.example.com/?authSource=admin&tls=true&replicaSet=rs0&retryWrites=true&appName=x';

test.describe('MongoDB connection string shortcut (data source wizard, step 4)', () => {
  test('a pasted string fills hosts, user, auth database and the write-only password; the pasted text is cleared', async ({ page }) => {
    await login(page, DEMO.owner);
    const name = uniq('E2E Mongo URI');
    await createProject(page, name);
    await page.reload();
    await selectProject(page, name);
    await page.goto('/sources/new');
    await page.getByRole('button', { name: /^MongoDB/ }).click();
    await next(page).click();
    await page.locator('main').getByLabel('Environment').selectOption({ label: 'Development' });
    await next(page).click();
    await next(page).click(); // the recommended method (username + password) is preselected
    await expect(page.getByText('Step 4 of 12')).toBeVisible();

    const box = page.getByTestId('mongo-uri');
    await expect(box).toHaveAttribute('type', 'password'); // not shown on screen
    await box.fill(FAKE);
    await page.getByTestId('mongo-uri-fill').click();

    await expect(page.getByLabel(/^Hosts/)).toHaveValue('db1.example.com:27018\ndb2.example.com:27017');
    await expect(page.getByLabel('Monitoring user')).toHaveValue('monitor');
    await expect(page.getByLabel('Auth database')).toHaveValue('admin');
    await expect(page.getByLabel('Password')).toHaveValue('s@fe/pass'); // decoded, in the write-only credential field
    await expect(box).toHaveValue('');
    await expect(page.getByTestId('mongo-uri-msg')).toContainText('Form filled');
    await expect(page.getByTestId('mongo-uri-msg')).toContainText('replicaset');
    await expect(page.getByTestId('mongo-uri-msg')).not.toContainText('s@fe');
    expect(await accessibilityViolations(page)).toEqual([]);
  });

  test('refusals are plain: not a MongoDB string, an unknown SRV name, and a connection string typed into the host box', async ({ page }) => {
    await login(page, DEMO.owner);
    const name = uniq('E2E Mongo URI bad');
    await createProject(page, name);
    await page.reload();
    await selectProject(page, name);
    await page.goto('/sources/new');
    await page.getByRole('button', { name: /^MongoDB/ }).click();
    await next(page).click();
    await page.locator('main').getByLabel('Environment').selectOption({ label: 'Development' });
    await next(page).click();
    await next(page).click();

    const box = page.getByTestId('mongo-uri');
    await box.fill('https://example.com');
    await page.getByTestId('mongo-uri-fill').click();
    await expect(page.getByTestId('mongo-uri-msg')).toContainText('not a MongoDB connection string');

    await box.fill('mongodb+srv://u:p@cluster0.nothing.invalid/');
    await page.getByTestId('mongo-uri-fill').click();
    await expect(page.getByTestId('mongo-uri-msg')).toContainText('No MongoDB SRV record', { timeout: 20_000 });
    await expect(page.getByLabel(/^Hosts/)).toHaveValue('');

    // The original mistake from the field: a whole connection string in the host box.
    await page.getByLabel(/^Hosts/).fill('mongodb+srv://u:p@cluster0.abcde.mongodb.net/');
    await expect(page.getByRole('alert').filter({ hasText: 'looks like a connection string' })).toBeVisible();
  });
});
