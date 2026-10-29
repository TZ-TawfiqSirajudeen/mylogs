import type { Page } from '@playwright/test';
import { DEMO, env, expect, login, selectProject, test, apiAs } from '../support/fixtures.js';
import { accessibilityViolations, createProject, noHorizontalScroll, uniq } from '../support/helpers.js';

const iso = (ago = 0) => new Date(Date.now() - ago).toISOString();
const setTheme = (page: Page, t: 'light' | 'dark') => page.evaluate((x) => { localStorage.setItem('nx-theme', x); document.documentElement.classList.toggle('dark', x === 'dark'); }, t);

async function seed(page: Page, withData: boolean) {
  const name = uniq('E2E LogsQ');
  const p = await createProject(page, name);
  const envId = p.environments[0]!.id;
  const t = await apiAs(page, 'POST', `/api/v1/projects/${p.id}/environments/${envId}/ingest-tokens`, { name: 'quality' });
  if (withData) {
    await fetch(`${env().ingest}/v1/json-logs`, {
      method: 'POST', headers: { authorization: `Bearer ${t.json.token}`, 'content-type': 'application/json' },
      body: JSON.stringify([
        { time: iso(5000), level: 'error', msg: 'checkout failed for order 42', service: 'checkout', 'http.response.status_code': 500, 'http.request.method': 'POST', 'http.route': '/pay', trace_id: 'd'.repeat(32), 'request.id': 'req-1', 'exception.type': 'TypeError', 'exception.stacktrace': 'TypeError: x is undefined\n    at pay (pay.js:10:5)\n    at run (app.js:3:1)', 'customer.tier': 'gold', password: 'hunter2hunter2' },
        { time: iso(4000), level: 'info', msg: 'checkout started', service: 'checkout', trace_id: 'd'.repeat(32), 'request.id': 'req-1' },
        ...Array.from({ length: 15 }, (_, i) => ({ time: iso(1000 * (i + 6)), level: i % 4 === 0 ? 'warn' : 'info', msg: `background job ${i}`, service: 'worker' })),
      ]),
    });
  }
  return { name, p, token: t.json.token as string };
}

for (const theme of ['light', 'dark'] as const) {
  test(`accessibility (WCAG 2 A/AA) of the logs and ingestion screens — ${theme}`, async ({ page }) => {
    test.setTimeout(150_000);
    await login(page, DEMO.owner);
    await setTheme(page, theme);
    const empty = await seed(page, false);
    const full = await seed(page, true);
    const failures: Record<string, unknown> = {};
    const scan = async (label: string) => { const v = await accessibilityViolations(page); if (v.length) failures[label] = v; };

    await page.goto('/'); await selectProject(page, empty.name);
    await page.goto('/logs'); await expect(page.getByText('No telemetry has been received for this project yet')).toBeVisible(); await scan('logs: silent project');
    await page.goto('/sources?tab=ingestion'); await expect(page.getByTestId(/ingest-env-/).first()).toBeVisible(); await scan('ingestion: empty');
    await page.locator('main').getByLabel('Environment').selectOption({ index: 1 });
    await page.locator('main').getByLabel('Token name').fill('a11y');
    await page.getByRole('button', { name: 'Create token' }).click();
    await expect(page.getByTestId('fresh-token')).toBeVisible(); await scan('ingestion: fresh token');
    await page.getByRole('button', { name: /dismiss/ }).click(); await scan('ingestion: token table');

    await page.goto('/'); await selectProject(page, full.name);
    await page.goto('/logs');
    await expect.poll(async () => Number(await page.getByRole('table', { name: 'Log results' }).getAttribute('aria-rowcount'))).toBeGreaterThan(10);
    await scan('logs: results');
    await page.locator('summary', { hasText: 'Field filters' }).click();
    await page.getByRole('group', { name: 'Add a field filter' }).getByLabel('Value').fill('x');
    await page.getByRole('button', { name: 'Add filter' }).click(); await scan('logs: filter builder with a chip');
    await page.getByRole('button', { name: /Remove filter/ }).click();
    await page.getByLabel('Search messages and errors').fill('checkout failed');
    await page.getByRole('button', { name: 'Run search' }).click();
    await page.getByRole('table', { name: 'Log results' }).getByRole('row').nth(1).click();
    await expect(page.getByRole('complementary', { name: 'Log details' }).getByTestId('log-message')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Stack trace' })).toBeVisible();
    await scan('logs: detail drawer');
    await page.getByRole('tab', { name: 'JSON' }).click(); await scan('logs: JSON view');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Live tail' }).click(); await expect(page.getByTestId('live-status')).toBeVisible(); await scan('logs: live tail');
    await page.getByRole('button', { name: /Live — stop/ }).click();
    await page.getByLabel('Search messages and errors').fill('does-not-exist-anywhere');
    await page.getByRole('button', { name: 'Run search' }).click();
    await expect(page.getByText('No logs match this search')).toBeVisible(); await scan('logs: no matches');

    const distinct = new Map<string, string[]>();
    for (const [screen, list] of Object.entries(failures)) for (const v of list as { rule: string; nodes: string[] }[]) for (const n of v.nodes) {
      const key = `${v.rule} | ${n.replace(/\s+/g, ' ').slice(0, 220)}`;
      distinct.set(key, [...(distinct.get(key) ?? []), screen]);
    }
    const report = [...distinct].map(([k, s]) => `${k} || on: ${[...new Set(s)].join(', ')}`).join(' ## ');
    expect(distinct.size, `Distinct accessibility problems (${theme}): ${report}`).toBe(0);
  });
}

for (const vp of [{ n: 'phone', w: 375, h: 667 }, { n: 'tablet', w: 768, h: 1024 }]) {
  test.describe(`logs layout at ${vp.n}`, () => {
    test.use({ viewport: { width: vp.w, height: vp.h } });
    test('no horizontal page scroll, including with the details drawer open; the drawer fits the screen', async ({ page }) => {
      test.setTimeout(120_000);
      await login(page, DEMO.owner);
      const s = await seed(page, true);
      await page.goto('/'); await selectProject(page, s.name);
      const bad: string[] = [];
      const check = async (l: string) => { if (!(await noHorizontalScroll(page))) bad.push(l); };
      await page.goto('/logs');
      await expect.poll(async () => Number(await page.getByRole('table', { name: 'Log results' }).getAttribute('aria-rowcount'))).toBeGreaterThan(10);
      await check('results');
      await page.locator('summary', { hasText: 'Field filters' }).click(); await check('filter builder');
      await page.locator('summary', { hasText: 'Saved queries' }).click(); await check('saved queries');
      await page.getByRole('table', { name: 'Log results' }).getByRole('row').nth(1).click();
      const drawer = page.getByRole('complementary', { name: 'Log details' });
      await expect(drawer.getByTestId('log-message')).toBeVisible();
      await check('drawer');
      const box = (await drawer.boundingBox())!;
      expect(box.width).toBeLessThanOrEqual(vp.w);
      expect(box.x).toBeGreaterThanOrEqual(0);
      await expect(drawer.getByRole('button', { name: 'Close log details' })).toBeVisible();
      await drawer.getByRole('button', { name: 'Close log details' }).click();
      await page.goto('/sources?tab=ingestion'); await check('ingestion');
      expect(bad, `screens with horizontal scroll at ${vp.w}px`).toEqual([]);
    });
  });
}
