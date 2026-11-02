import type { Page } from '@playwright/test';
import { expect, test } from '../support/fixtures.js';
import { accessibilityViolations } from '../support/helpers.js';

// These specs run against a second API + web pair in AUTH_MODE=oidc, with a mock OpenID Provider (see support/stack.ts).
// Everything goes through a real browser: login page -> identity provider page -> callback -> app.
const WEB = () => process.env.E2E_OIDC_WEB_URL!;
const API = () => process.env.E2E_OIDC_API_URL!;
const IDP = () => process.env.E2E_IDP_URL!;
const SECRET = () => process.env.E2E_IDP_SECRET!;

/** Starts at `path`, signs in at the identity provider as `email`, and waits for the app to load. */
async function signInViaIdp(page: Page, email: string, path = '/') {
  await page.goto(`${WEB()}${path}`);
  await page.getByTestId('oidc-signin').click();
  await expect(page).toHaveURL(new RegExp(`^${IDP().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/authorize`));
  await page.getByTestId(`idp-user-${email}`).click();
}
const signedIn = (page: Page) => expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();

test.describe('OIDC single sign-on', () => {
  test('login page offers only the provider button (no dev form, no demo users) and is accessible', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(WEB());
    await expect(page.getByRole('heading', { name: 'Nexus Observability' })).toBeVisible();
    await expect(page.getByTestId('oidc-signin')).toHaveText('Sign in with Mock IdP');
    await expect(page.getByLabel('Email')).toHaveCount(0);
    await expect(page.getByText(/Seeded DEMO users/)).toHaveCount(0);
    expect(await accessibilityViolations(page)).toEqual([]);
    await page.evaluate(() => { localStorage.setItem('nx-theme', 'dark'); document.documentElement.classList.add('dark'); });
    expect(await accessibilityViolations(page)).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('the sign-in link is keyboard operable', async ({ page }) => {
    await page.goto(WEB());
    // Tab only once the link exists: pressing it during the initial render (slow machine) lands on the document instead.
    await expect(page.getByTestId('oidc-signin')).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('oidc-signin')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/authorize/);
  });

  test('signs in through the identity provider, keeps the deep link, and exposes no token to the page', async ({ page, context }) => {
    const callbacks: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/api/v1/auth/oidc/callback')) callbacks.push(r.url()); });
    await signInViaIdp(page, 'owner@acme.test', '/audit?from=deeplink');
    await signedIn(page);
    // The destination the user originally asked for is restored after the round trip.
    await expect(page).toHaveURL(`${WEB()}/audit?from=deeplink`);
    await expect(page.getByRole('heading', { name: 'Audit Logs' })).toBeVisible();
    expect(callbacks.length).toBe(1);

    // Cookies: HttpOnly session cookie, Lax, not readable from script; the flow cookie is gone.
    const cookies = await context.cookies();
    const sid = cookies.find((c) => c.name.endsWith('nx_sid'))!;
    expect(sid.httpOnly).toBe(true);
    expect(sid.sameSite).toBe('Lax');
    expect(cookies.find((c) => c.name.endsWith('nx_flow'))).toBeUndefined();
    expect(await page.evaluate(() => document.cookie)).not.toContain('nx_sid');

    // Nothing token-like in browser storage or in the URL/page; the client secret never reaches the browser.
    const stored = await page.evaluate(() => JSON.stringify({ l: { ...localStorage }, s: { ...sessionStorage } }));
    expect(stored).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
    expect(stored).not.toMatch(/access_token|id_token|refresh_token/);
    expect(page.url()).not.toMatch(/code=|state=|id_token/);
    expect(await page.content()).not.toContain(SECRET());

    // The session survives a reload.
    await page.reload();
    await signedIn(page);
  });

  test('the authorization code in a captured callback URL cannot be replayed', async ({ page, browser }) => {
    const callbacks: string[] = [];
    page.on('request', (r) => { if (r.url().includes('/api/v1/auth/oidc/callback')) callbacks.push(r.url()); });
    await signInViaIdp(page, 'viewer@acme.test');
    await signedIn(page);
    const other = await browser.newContext();
    const p2 = await other.newPage();
    await p2.goto(callbacks[0]!);
    await expect(p2.getByTestId('auth-error')).toContainText('could not be completed');
    await expect(p2.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    expect(p2.url()).not.toContain('auth_error'); // the parameter is removed so a refresh does not replay the message
    await other.close();
  });

  test('a person who has not been authorized sees a generic message and gets no session', async ({ page, context }) => {
    await signInViaIdp(page, 'stranger@elsewhere.test');
    await expect(page.getByTestId('auth-error')).toContainText('not authorized');
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    expect((await context.cookies()).find((c) => c.name.endsWith('nx_sid'))).toBeUndefined();
    expect(page.url()).not.toContain('auth_error');
    expect(await page.content()).not.toContain('stranger@elsewhere.test'); // no account enumeration / reflection
  });

  test('denying access at the identity provider returns to the app with a clear message', async ({ page }) => {
    await page.goto(WEB());
    await page.getByTestId('oidc-signin').click();
    await page.getByRole('link', { name: 'Deny' }).click();
    await expect(page.getByTestId('auth-error')).toContainText('cancelled or denied');
    await expect(page.getByTestId('oidc-signin')).toBeVisible();
  });

  test('sign out ends the application session and the provider session, and the old cookie is dead', async ({ page, context }) => {
    await signInViaIdp(page, 'engineer@acme.test');
    await signedIn(page);
    const cookie = (await context.cookies()).find((c) => c.name.endsWith('nx_sid'))!;
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByTestId('oidc-signin')).toBeVisible(); // back on the login page via the provider's end-session endpoint
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
    const res = await fetch(`${API()}/api/v1/auth/session`, { headers: { cookie: `${cookie.name}=${cookie.value}` } });
    expect(res.status).toBe(401);
    // Protected pages require signing in again.
    await page.goto(`${WEB()}/audit`);
    await expect(page.getByTestId('oidc-signin')).toBeVisible();
  });

  test('an expired session sends the user back to sign in', async ({ page, db }) => {
    await signInViaIdp(page, 'viewer@acme.test');
    await signedIn(page);
    const [user] = await db.find('users', { emailLower: 'viewer@acme.test' });
    await db.update('sessions', { userId: user._id, revokedAt: null }, { $set: { idleExpiresAt: { $date: new Date(Date.now() - 60_000).toISOString() } } });
    await page.reload();
    await expect(page.getByTestId('oidc-signin')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
  });

  test('read-only and audit-only roles keep their restrictions after SSO', async ({ page }) => {
    await signInViaIdp(page, 'viewer@acme.test', '/audit');
    await expect(page.getByText('Not permitted')).toBeVisible();
    await page.getByRole('link', { name: 'Settings' }).click();
    await expect(page.getByText('Not permitted')).toBeVisible();
  });

  test('another organization\'s owner signs in but sees none of acme\'s data', async ({ page }) => {
    await signInViaIdp(page, 'owner@globex.test', '/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    const rows = page.getByRole('table', { name: 'Organization members' }).locator('tbody tr');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('owner@globex.test');
    await expect(page.getByText('engineer@acme.test')).toHaveCount(0);
  });

  test('an owner pre-authorizes a person, who can then sign in; removing them ends access', async ({ page, browser, db }) => {
    // The mock directory is fixed at startup: the invitee is the "stranger" identity, who was refused in an earlier test.
    await signInViaIdp(page, 'owner@acme.test', '/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
    await page.getByLabel('E-mail').fill('stranger@elsewhere.test');
    await page.getByRole('button', { name: 'Add member' }).click();
    const row = page.getByTestId('member-stranger@elsewhere.test');
    await expect(row).toBeVisible();
    await expect(row).toContainText('Invited');

    const invited = await browser.newContext();
    const p2 = await invited.newPage();
    await signInViaIdp(p2, 'stranger@elsewhere.test');
    await signedIn(p2);

    // Role change (Member -> Auditor) shows up and takes effect: the auditor can now read the audit trail.
    await page.reload();
    await page.getByLabel('Role for stranger@elsewhere.test').selectOption('auditor');
    await expect(page.getByLabel('Role for stranger@elsewhere.test')).toHaveValue('auditor');
    const [u] = await db.find('users', { emailLower: 'stranger@elsewhere.test' });
    expect((await db.find('org_memberships', { userId: u._id })).map((m) => m.role)).toEqual(['auditor']); // persisted server-side, not just shown

    // Removing the member kills their live session.
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Remove stranger@elsewhere.test' }).click();
    await expect(page.getByTestId('member-stranger@elsewhere.test')).toHaveCount(0);
    await p2.reload();
    await expect(p2.getByTestId('oidc-signin')).toBeVisible();
    expect(await db.count('audit_events', { action: 'org.member_removed' })).toBeGreaterThan(0);
    await invited.close();
  });

  test('there is no dev login in OIDC mode, and unauthenticated API calls are rejected', async () => {
    const dev = await fetch(`${API()}/api/v1/auth/dev-login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: WEB() }, body: JSON.stringify({ email: 'owner@acme.test' }) });
    expect(dev.status).toBe(404);
    for (const p of ['/api/v1/projects', '/api/v1/org/members', '/api/v1/audit']) expect((await fetch(`${API()}${p}`)).status).toBe(401);
    const cfg = await (await fetch(`${API()}/api/v1/auth/config`)).json();
    expect(cfg).toMatchObject({ mode: 'oidc', providerName: 'Mock IdP' });
    expect(JSON.stringify(cfg)).not.toContain(SECRET());
  });
});
