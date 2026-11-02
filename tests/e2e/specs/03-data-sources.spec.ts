import { DEMO, env, expect, login, selectProject, test } from '../support/fixtures.js';
import { createProject, makeDue, stateOf, uniq } from '../support/helpers.js';

const state = (card: import('@playwright/test').Locator, s: string) => expect(card.getByTestId('connection-state')).toHaveAttribute('data-state', s);
const next = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'Next' });

test.describe('data sources: capability matrix and the 12-step wizard', () => {
  test('capability matrix is honest: implemented vs planned; only MongoDB and Redis sample metrics', async ({ page }) => {
    await login(page, DEMO.owner);
    await page.goto('/sources');
    await page.getByRole('tab', { name: 'Capability matrix' }).click();
    const table = page.getByRole('table', { name: 'Integration capability matrix' });
    await expect(table).toBeVisible();
    for (const row of ['Authenticated application health check', 'MongoDB', 'Redis / Redis-compatible']) {
      await expect(table.getByRole('row').filter({ hasText: row })).toContainText('implemented');
    }
    for (const row of ['OpenTelemetry (OTLP/HTTP) logs', 'Generic JSON / NDJSON logs']) {
      await expect(table.getByRole('row').filter({ hasText: row })).toContainText('implemented');
      await expect(table.getByRole('row').filter({ hasText: row })).toContainText('push: logs via ingestion token');
    }
    for (const row of ['AWS CloudWatch', 'Azure Monitor', 'Kubernetes clusters', 'Nginx access/error logs']) {
      await expect(table.getByRole('row').filter({ hasText: row })).toContainText('planned');
    }
    // Only the two database connectors sample metrics (read-only); the health check and every planned connector do not.
    for (const row of ['MongoDB', 'Redis / Redis-compatible']) await expect(table.getByRole('row').filter({ hasText: row })).toContainText('collects metrics (read-only)');
    await expect(table.getByText('collects metrics (read-only)')).toHaveCount(2);
    await expect(table.getByRole('row').filter({ hasText: 'Authenticated application health check' })).toContainText('health/discovery only');
    await expect(table.getByText('collects telemetry')).toHaveCount(0);
    await expect(page.getByText(/log ingestion is push-based via ingestion tokens/)).toBeVisible();
  });

  test('planned connectors cannot be selected in the wizard', async ({ page }) => {
    await login(page, DEMO.owner);
    await createProject(page, uniq('E2E Planned'));
    await page.goto('/sources/new');
    await expect(page.getByRole('button', { name: /AWS CloudWatch/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: /AWS CloudWatch/ })).toContainText('Planned');
    await expect(next(page)).toBeDisabled();
    // push sources are implemented but are set up with ingestion tokens, not the connection wizard
    await expect(page.getByRole('button', { name: /OpenTelemetry \(OTLP\/HTTP\) logs/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: /OpenTelemetry \(OTLP\/HTTP\) logs/ })).toContainText('Use an ingestion token');
    await page.getByRole('button', { name: /Authenticated application health check/ }).click();
    await expect(next(page)).toBeEnabled();
  });

  test('full journey: failed first test -> rotate -> resume -> discover -> select -> start -> outage -> recovery -> disconnect -> delete', async ({ page, db, responses, setTarget }) => {
    test.setTimeout(180_000);
    const projectName = uniq('E2E Journey');
    const connName = uniq('journey api');
    const WRONG = 'wrong-token-aaaaaaaaaaaa';
    const t = env();
    await setTarget('ok');
    await login(page, DEMO.owner);
    const project = await createProject(page, projectName);
    await page.reload();
    await selectProject(page, projectName);
    page.on('dialog', (d) => void d.accept());

    // ---- steps 1-5: provider, scope, auth, details, validate (credentials go to the server once)
    await page.getByRole('link', { name: 'Data Sources' }).click();
    await expect(page.getByText('No data sources connected')).toBeVisible();
    await page.getByRole('link', { name: 'Add data source' }).first().click();
    await page.getByRole('button', { name: /Authenticated application health check/ }).click();
    await next(page).click();
    await expect(page.getByText('Step 2 of 12: Scope')).toBeVisible();
    await page.locator('main').getByLabel('Environment').selectOption({ label: 'Development' });
    await next(page).click();
    await expect(page.getByText('Bearer token')).toBeVisible();
    await expect(page.getByText('Recommended')).toBeVisible();
    await expect(page.getByLabel('No authentication')).not.toBeChecked();
    await next(page).click();
    await page.getByLabel('Connection name').fill(connName);
    await page.getByLabel('Health endpoint URL').fill(`${t.target}/healthz`);
    const tokenInput = page.getByLabel('Token');
    await expect(tokenInput).toHaveAttribute('type', 'password');
    await expect(tokenInput).toHaveAttribute('autocomplete', 'new-password');
    await tokenInput.fill(WRONG);
    await next(page).click();
    await page.getByRole('button', { name: 'Validate and save draft' }).click();
    await expect(page.getByText(/Draft saved/)).toBeVisible();
    // the credential is stored encrypted, not in the DOM/storage any more
    await expect(page.getByText(WRONG)).toHaveCount(0);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(WRONG);
    const doc = (await db.find('connections', { name: connName }))[0];
    expect(doc.lifecycle).toBe('draft');
    expect(JSON.stringify(doc)).not.toContain(WRONG);
    expect(JSON.stringify(await db.find('secrets', { connectionId: doc._id }))).not.toContain(WRONG);

    // ---- step 6-7: permissions, then a failing test with actionable remediation
    await next(page).click();
    await expect(page.getByText(/Grant only what is listed here/)).toBeVisible();
    await expect(page.getByText('Read access to the health endpoint only')).toBeVisible();
    await next(page).click();
    await page.getByRole('button', { name: 'Run connection test' }).click();
    await expect(page.getByText(/Failed: The endpoint rejected the credentials/)).toBeVisible();
    await expect(page.getByText(/How to fix:/).first()).toBeVisible();
    await expect(next(page)).toBeDisabled(); // cannot proceed past a failed test
    expect(await stateOf(db, connName)).toBe('misconfigured'); // first-time auth failure is NOT "expired"

    // ---- rotate to the right credential from the Data Sources page, then resume the draft
    await page.getByRole('link', { name: '← Data Sources' }).click();
    const card = page.locator('li', { hasText: connName });
    await state(card, 'misconfigured');
    await expect(card.getByText(/How to fix:/).first()).toBeVisible();
    await card.getByRole('button', { name: 'Rotate credentials' }).click();
    const dialog = page.getByRole('dialog', { name: 'Rotate credentials' });
    await dialog.getByLabel('Token').fill(t.token);
    await dialog.getByRole('button', { name: 'Rotate and test' }).click();
    await expect(dialog.getByText('Rotated and verified.')).toBeVisible();
    await expect(dialog.getByLabel('Token')).toHaveValue(''); // cleared after submit
    await dialog.getByRole('button', { name: 'Close' }).click();
    await state(card, 'healthy');
    await card.getByRole('link', { name: 'Continue setup' }).click();

    // ---- resumed at the test step; steps 7-12
    await expect(page.getByText('Step 7 of 12: Test')).toBeVisible();
    await page.getByRole('button', { name: 'Run connection test' }).click();
    await expect(page.getByText('Connection verified.')).toBeVisible();
    await expect(page.getByText('Availability probe')).toBeVisible();
    await expect(page.getByText('A health endpoint does not expose logs')).toBeVisible(); // missing signal explained, not hidden
    await next(page).click();
    await page.getByRole('button', { name: 'Discover resources' }).click();
    await expect(page.getByText('1 resource(s) found.')).toBeVisible();
    await next(page).click();
    await expect(next(page)).toBeDisabled();
    await page.getByRole('checkbox', { name: /^\S.*http_endpoint/ }).check();
    await expect(page.getByRole('checkbox', { name: 'logs' })).toHaveCount(0); // only signals it can really provide
    await page.getByRole('checkbox', { name: 'metrics' }).check();
    await page.getByRole('button', { name: 'Save selection' }).click();
    await expect(page.getByText(/Selection saved: 1 resource\(s\), signals metrics/)).toBeVisible();
    await next(page).click();
    await page.getByLabel('Check and collection interval (seconds, 30–3600)').fill('5');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByRole('alert')).toBeVisible(); // out of bounds is refused by the server
    await page.getByLabel('Check and collection interval (seconds, 30–3600)').fill('45');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await next(page).click();
    await expect(page.getByText('Health check every 45s')).toBeVisible();
    await expect(page.getByText('Not collected (not implemented for this connector)')).toBeVisible();
    await expect(page.getByText(/no telemetry will be collected/)).toBeVisible();
    await next(page).click();
    await page.getByRole('button', { name: 'Start monitoring' }).click();
    await expect(page.getByText('Monitoring started.')).toBeVisible();
    await page.getByRole('button', { name: 'Go to Data Sources' }).click();

    // ---- the active connection: honest health facts
    await expect(card.getByText('active', { exact: true })).toBeVisible();
    await state(card, 'healthy');
    await expect(card.getByText('n/a — nothing has been collected')).toBeVisible();
    await expect(card.getByText(/no data is being collected/)).toBeVisible();
    await expect(card.locator('dt', { hasText: 'Credentials' }).locator('..')).toContainText('token (stored, write-only)');

    // ---- outage -> degraded -> expired credential -> recovery, detected by the real worker
    await setTarget('503');
    await makeDue(db, connName);
    await expect.poll(() => stateOf(db, connName), { timeout: 20_000 }).toBe('degraded');
    await page.reload();
    await state(card, 'degraded');
    await expect(card.getByText(/How to fix:/).first()).toBeVisible();
    await setTarget('reject');
    await makeDue(db, connName);
    await expect.poll(() => stateOf(db, connName), { timeout: 20_000 }).toBe('authentication_expired');
    await page.reload();
    await state(card, 'authentication_expired');
    await expect(card.locator('dt', { hasText: 'Last successful check' }).locator('..')).not.toContainText('—');
    await setTarget('ok');
    await makeDue(db, connName);
    await expect.poll(() => stateOf(db, connName), { timeout: 20_000 }).toBe('healthy');
    await card.getByRole('button', { name: 'Test now' }).click();
    await state(card, 'healthy');

    // ---- disconnect revokes credentials; delete removes everything
    await card.getByRole('button', { name: 'Disconnect' }).click();
    await state(card, 'disconnected');
    await expect(card.getByText('none stored')).toBeVisible();
    expect(await db.count('secrets', { connectionId: doc._id })).toBe(0);
    await expect(card.getByRole('button', { name: 'Test now' })).toHaveCount(0);
    await card.getByRole('button', { name: 'Delete' }).click();
    await expect(card).toHaveCount(0);
    expect(await db.count('connections', { _id: doc._id })).toBe(0);

    // ---- nothing secret ever reached the browser or the database
    for (const secret of [WRONG, t.token]) {
      expect(responses.join('\n')).not.toContain(secret);
      for (const c of ['connections', 'secrets', 'audit_events']) expect(JSON.stringify(await db.find(c)), c).not.toContain(secret);
    }
    void project;
  });

  test('misconfigured network targets are refused with a clear reason (SSRF) and nothing is requested', async ({ page, db }) => {
    await login(page, DEMO.owner);
    const name = uniq('E2E SSRF');
    await createProject(page, name);
    await page.reload();
    await selectProject(page, name);
    await page.goto('/sources/new');
    await page.getByRole('button', { name: /Authenticated application health check/ }).click();
    await next(page).click();
    await page.locator('main').getByLabel('Environment').selectOption({ label: 'Development' });
    await next(page).click();
    await page.getByLabel('No authentication').check();
    await next(page).click();
    await page.getByLabel('Connection name').fill('metadata probe');
    await page.getByLabel('Health endpoint URL').fill('http://169.254.169.254/latest/meta-data/');
    await next(page).click();
    await page.getByRole('button', { name: 'Validate and save draft' }).click();
    await expect(page.getByText(/Draft saved/)).toBeVisible();
    await next(page).click();
    await next(page).click();
    await page.getByRole('button', { name: 'Run connection test' }).click();
    await expect(page.getByText(/Failed:.*(not permitted|reserved|resolves to an address)/)).toBeVisible();
    await expect(page.getByText(/administrator-approved network path/).first()).toBeVisible();
    expect((await db.find('connections', { name: 'metadata probe' }))[0].health.state).toBe('misconfigured');
  });

  test('invalid details are reported by the server with guidance', async ({ page }) => {
    await login(page, DEMO.owner);
    const name = uniq('E2E Invalid');
    await createProject(page, name);
    await page.reload();
    await selectProject(page, name);
    await page.goto('/sources/new');
    await page.getByRole('button', { name: /Authenticated application health check/ }).click();
    await next(page).click();
    await page.locator('main').getByLabel('Environment').selectOption({ label: 'Development' });
    await next(page).click();
    await page.getByLabel('No authentication').check();
    await next(page).click();
    await page.getByLabel('Connection name').fill('bad url');
    await page.getByLabel('Health endpoint URL').fill('not a url');
    await next(page).click();
    await page.getByRole('button', { name: 'Validate and save draft' }).click();
    // the schema accepts any string; the connector test reports the real problem
    await next(page).click();
    await next(page).click();
    await page.getByRole('button', { name: 'Run connection test' }).click();
    await expect(page.getByText(/Failed: The URL is not valid/)).toBeVisible();
    await expect(page.getByText(/Enter a full URL/).first()).toBeVisible();
  });
});
