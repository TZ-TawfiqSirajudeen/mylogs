import { DEMO, env, expect, login, selectProject, test } from '../support/fixtures.js';
import { createProject, uniq } from '../support/helpers.js';

test.describe('failures are handled, not hidden', () => {
  test('a failing project list shows an error with a working Retry (not a misleading empty state)', async ({ page }) => {
    await login(page, DEMO.owner);
    let failing = true;
    await page.route('**/api/v1/projects', (route) => (failing ? route.fulfill({ status: 500, json: { error: { code: 'internal_error', message: 'Internal server error', requestId: 'req-e2e-0001' } } }) : route.continue()));
    await page.goto('/');
    await expect(page.getByRole('alert')).toContainText('Internal server error');
    await expect(page.getByRole('alert')).toContainText('req-e2e-0001'); // support can trace it
    await expect(page.getByText('No projects yet')).toHaveCount(0);
    failing = false;
    await page.getByRole('button', { name: 'Retry' }).click();
    await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('unreachable API at startup is reported clearly', async ({ page }) => {
    await page.route('**/api/v1/auth/session', (r) => r.abort('connectionrefused'));
    await page.goto('/');
    await expect(page.getByText(/Cannot reach the API/)).toBeVisible();
  });

  test('a failing connection test surfaces the error without breaking the wizard', async ({ page }) => {
    await login(page, DEMO.owner);
    const name = uniq('E2E Fail');
    await createProject(page, name);
    await page.reload();
    await selectProject(page, name);
    await page.goto('/sources/new');
    await page.getByRole('button', { name: /Authenticated application health check/ }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.locator('main').getByLabel('Environment').selectOption({ label: 'Development' });
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('No authentication').check();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('Connection name').fill('flaky');
    await page.getByLabel('Health endpoint URL').fill(`${env().target}/healthz`);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Validate and save draft' }).click();
    await expect(page.getByText(/Draft saved/)).toBeVisible();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.route('**/connections/*/test', (r) => r.fulfill({ status: 503, json: { error: { code: 'x', message: 'Service unavailable', requestId: 'req-e2e-0002' } } }));
    await page.getByRole('button', { name: 'Run connection test' }).click();
    await expect(page.getByRole('alert')).toContainText('Service unavailable');
    await expect(page.getByRole('button', { name: 'Run connection test' })).toBeEnabled(); // can retry
    await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  test('double-clicking "Validate and save draft" creates exactly one connection', async ({ page, db }) => {
    await login(page, DEMO.owner);
    const name = uniq('E2E Double');
    await createProject(page, name);
    await page.reload();
    await selectProject(page, name);
    await page.goto('/sources/new');
    await page.getByRole('button', { name: /Authenticated application health check/ }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.locator('main').getByLabel('Environment').selectOption({ label: 'Development' });
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByLabel('No authentication').check();
    await page.getByRole('button', { name: 'Next' }).click();
    const conn = uniq('double click');
    await page.getByLabel('Connection name').fill(conn);
    await page.getByLabel('Health endpoint URL').fill(`${env().target}/healthz`);
    await page.getByRole('button', { name: 'Next' }).click();
    await page.getByRole('button', { name: 'Validate and save draft' }).dblclick();
    await expect(page.getByText(/Draft saved/)).toBeVisible();
    expect(await db.count('connections', { name: conn })).toBe(1);
  });
});

test.describe('browser-side security', () => {
  test('state-changing requests without the CSRF token, or from a foreign origin, are refused', async ({ page, context }) => {
    await login(page, DEMO.owner);
    const cookies = await context.cookies();
    const cookie = cookies.filter((c) => c.name.endsWith('nx_sid')).map((c) => `${c.name}=${c.value}`).join('; ');
    const noToken = await fetch(`${env().api}/api/v1/projects`, { method: 'POST', headers: { cookie, origin: env().web, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'csrf probe' }) });
    expect(noToken.status).toBe(403);
    const session = await (await fetch(`${env().api}/api/v1/auth/session`, { headers: { cookie } })).json();
    const evilOrigin = await fetch(`${env().api}/api/v1/projects`, { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'x-csrf-token': session.csrfToken, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'csrf probe' }) });
    expect(evilOrigin.status).toBe(403);
    expect((await evilOrigin.json()).error.code).toBe('bad_origin');
  });

  test('API responses carry security headers and unknown routes return a traceable, non-leaky error', async ({ request }) => {
    const r = await request.get(`${env().api}/api/v1/does-not-exist`);
    expect(r.status()).toBe(404);
    const body = await r.json();
    expect(body.error.requestId).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/at .*\.(ts|js):\d+|node_modules/);
    const h = r.headers();
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-powered-by']).toBeUndefined();
    expect(h['x-request-id']).toBe(body.error.requestId);
  });

  test('the API never exposes stored credentials, even to the project admin who set them', async ({ page, db }) => {
    await login(page, DEMO.owner);
    const name = uniq('E2E NoLeak');
    const p = await createProject(page, name);
    const secret = `leak-check-${Date.now().toString(36)}-yyyyyyyy`;
    const created = await page.evaluate(async ({ pid, eid, secret, target }) => {
      const s = await (await fetch('/api/v1/auth/session')).json();
      const res = await fetch(`/api/v1/projects/${pid}/environments/${eid}/connections`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': s.csrfToken },
        body: JSON.stringify({ connectorType: 'http-health', name: 'leak check', authMethod: 'bearer', config: { url: `${target}/healthz` }, secrets: { token: secret } }),
      });
      const c = await res.json();
      const list = await (await fetch(`/api/v1/projects/${pid}/connections`)).text();
      const one = await (await fetch(`/api/v1/projects/${pid}/connections/${c.id}`)).text();
      const test = await (await fetch(`/api/v1/projects/${pid}/connections/${c.id}/test`, { method: 'POST', headers: { 'x-csrf-token': s.csrfToken } })).text();
      const audit = await (await fetch('/api/v1/audit?limit=200')).text();
      return { all: JSON.stringify(c) + list + one + test + audit };
    }, { pid: p.id, eid: p.environments[0]!.id, secret, target: env().target });
    expect(created.all).not.toContain(secret);
    expect(JSON.stringify(await db.find('secrets'))).not.toContain(secret);
  });
});

test.describe('preferences', () => {
  test('theme toggle switches and persists across reloads', async ({ page }) => {
    await login(page, DEMO.owner);
    const html = page.locator('html');
    const startedDark = await html.evaluate((e) => e.classList.contains('dark'));
    await page.getByRole('button', { name: /Theme/ }).click();
    expect(await html.evaluate((e) => e.classList.contains('dark'))).toBe(!startedDark);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    expect(await html.evaluate((e) => e.classList.contains('dark'))).toBe(!startedDark);
  });

  test('the dev-mode banner is shown and the demo shortcuts are clearly dev-only', async ({ page }) => {
    await login(page, DEMO.owner);
    await expect(page.getByText(/Development auth mode: passwordless demo sign-in is enabled/)).toBeVisible();
  });
});
