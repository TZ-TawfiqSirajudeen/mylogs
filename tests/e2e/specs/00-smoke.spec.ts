import { env, expect, login, test } from '../support/fixtures.js';

test('stack is up: web serves, API and worker are ready, demo user can sign in', async ({ page, request }) => {
  expect((await request.get(`${env().api}/readyz`)).ok()).toBe(true);
  expect((await request.get(`${env().worker}/readyz`)).ok()).toBe(true);
  await login(page, 'owner@acme.test');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
});
