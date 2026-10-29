import { DEMO, env, expect, login, logout, test } from '../support/fixtures.js';

test.describe('authentication', () => {
  test('login page: heading, demo users clearly labelled, no console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Nexus Observability' })).toBeVisible();
    await expect(page.getByText(/Seeded DEMO users/)).toBeVisible();
    await expect(page.getByText(/Development mode only/)).toBeVisible();
    // 401 from the unauthenticated session probe is expected and is not an app error
    const real = errors.filter((e) => !/401|Unauthorized/.test(e));
    expect(real, real.join(' | ')).toEqual([]);
  });

  test('client-side validation and a generic failure for unknown users', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Email').fill('not-an-email');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await page.getByLabel('Email').fill('nobody@acme.test');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveText('Invalid login');
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  });

  test('Enter submits the form (keyboard only)', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('Email').focus();
    await page.keyboard.type(DEMO.viewer);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
  });

  test('demo-user shortcut buttons fill the email', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: /owner@acme.test/ }).click();
    await expect(page.getByLabel('Email')).toHaveValue('owner@acme.test');
  });

  test('session survives reload; protected routes show login when signed out', async ({ page }) => {
    await page.goto('/audit');
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Audit Logs' })).toHaveCount(0);
    await login(page, DEMO.owner);
    await page.goto('/audit');
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Audit Logs' })).toBeVisible();
  });

  test('sign out actually returns to the login screen and revokes the session server-side', async ({ page, context }) => {
    await login(page, DEMO.owner);
    const cookie = (await context.cookies()).find((c) => c.name.endsWith('nx_sid'))!;
    await logout(page);
    await page.reload();
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    // the old cookie is dead on the server, not just forgotten by the UI
    const res = await fetch(`${env().api}/api/v1/auth/session`, { headers: { cookie: `${cookie.name}=${cookie.value}` } });
    expect(res.status).toBe(401);
  });

  test('signing in as a different user never shows the previous user\'s data (cache isolation)', async ({ page }) => {
    await login(page, DEMO.owner);
    await page.goto('/audit');
    await expect(page.locator('table')).toBeVisible();
    await logout(page);
    await login(page, DEMO.engineer);
    // engineer has no audit permission; the owner's cached audit table must not flash or remain
    await page.goto('/audit');
    await expect(page.getByText('Audit history is available to organization owners, admins and auditors.')).toBeVisible();
    await expect(page.locator('table')).toHaveCount(0);
  });

  test('cookie is HttpOnly + SameSite and invisible to page scripts; browser storage holds no credentials', async ({ page, context }) => {
    await login(page, DEMO.owner);
    const c = (await context.cookies()).find((k) => k.name.endsWith('nx_sid'))!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Lax');
    const visible = await page.evaluate(() => document.cookie);
    expect(visible).not.toContain('nx_sid');
    const storage = await page.evaluate(() => ({ local: { ...localStorage }, session: { ...sessionStorage } }));
    expect(Object.keys(storage.local).every((k) => k.startsWith('nx-'))).toBe(true);
    expect(JSON.stringify(storage)).not.toContain(c.value);
    expect(JSON.stringify(storage).toLowerCase()).not.toMatch(/token|password|secret|csrf/);
  });

  test('session expiry mid-use sends the user back to login instead of showing broken screens', async ({ page, db }) => {
    await login(page, DEMO.viewer);
    await db.update('sessions', {}, { $set: { revokedAt: { $date: new Date().toISOString() } } });
    await page.goto('/projects');
    await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  });
});
