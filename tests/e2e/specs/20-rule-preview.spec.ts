import type { Page } from '@playwright/test';
import { DEMO, env, expect, login, test, apiAs } from '../support/fixtures.js';
import { accessibilityViolations, createProject, grant, noHorizontalScroll, orgMembers, uniq } from '../support/helpers.js';
import { startShop, type RunningShop } from '../support/sample-app.js';

// Rule preview against history and incident-to-trace/log links (ADR-0009), with real processes: an instrumented two-service shop sends traces, metrics and
// logs to the real ingestion service, the real API replays the draft rule over stored data, and the real worker opens the incident whose page is then
// checked. Nothing in this file fakes an API response (one test only DELAYS the preview request to observe the loading state).

interface Ctx {
  projectId: string; devEnv: string; prodEnv: string; token: string; shop: RunningShop; metricRuleName: string; logRuleName: string;
  metricIncidentId: string; logIncidentId: string; users: Record<string, string>;
}
let ctx: Ctx;
const get = async (url: string) => (await fetch(url)).status;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => { localStorage.setItem('nx-theme', t); document.documentElement.classList.toggle('dark', t === 'dark'); }, theme);
}
const makeRuleDue = (db: { update(c: string, f: object, u: object): Promise<number> }, name: string) =>
  db.update('alert_config', { kind: 'rule', name }, { $set: { nextEvalAt: { $date: new Date(Date.now() - 1000).toISOString() } } });

/** Fills the rule form with a metric rule on the shop's gateway (a histogram: `count` is valid and every request counts). */
async function fillMetricRule(page: Page, name: string, over: { metric?: string; threshold?: string } = {}) {
  await page.getByTestId('new-rule').click();
  await page.getByTestId('rule-name').fill(name);
  await page.getByTestId('rule-environment').selectOption(ctx.prodEnv);
  await page.getByTestId('rule-severity').selectOption('critical');
  await page.getByTestId('rule-metric').fill(over.metric ?? 'http.server.request.duration');
  await page.getByTestId('rule-agg').selectOption('count');
  await page.getByLabel('Service (optional)').fill(ctx.shop.gatewayName);
  await page.getByTestId('rule-op').selectOption('gt');
  await page.getByTestId('rule-threshold').fill(over.threshold ?? '0');
  await page.getByTestId('rule-window').fill('15');
  await page.getByTestId('rule-for').fill('0');
  await page.getByTestId('rule-resolve').fill('0');
  await page.getByTestId('rule-interval').selectOption('60');
}

test.describe.serial('rule preview against history and incident links', () => {
  test('setup: real telemetry (traces, metrics, error logs) from an instrumented shop reaches storage', async ({ page, db }) => {
    test.setTimeout(240_000);
    await login(page, DEMO.owner);
    const p = await createProject(page, uniq('E2E Preview'));
    const devEnv = p.environments.find((e) => !e.isProduction)!.id, prodEnv = p.environments.find((e) => e.isProduction)!.id;
    const minted = await apiAs(page, 'POST', `/api/v1/projects/${p.id}/environments/${prodEnv}/ingest-tokens`, { name: 'preview' });
    expect(minted.status).toBe(201);
    const users = await orgMembers(page);
    await grant(page, p.id, users[DEMO.engineer]!, 'engineer');
    await grant(page, p.id, users[DEMO.viewer]!, 'viewer');
    await grant(page, p.id, users[DEMO.auditor]!, 'project_admin', [devEnv]); // an administrator restricted to the development environment
    const shop = await startShop({ ingestUrl: env().ingest, token: minted.json.token, suffix: Date.now().toString(36) });
    ctx = { projectId: p.id, devEnv, prodEnv, token: minted.json.token, shop, metricRuleName: uniq('Gateway traffic'), logRuleName: uniq('Checkout errors'), metricIncidentId: '', logIncidentId: '', users };

    for (let i = 0; i < 12; i++) expect(await get(`${shop.gateway}/orders/${100 + i}`)).toBe(200);
    expect(await get(`${shop.gateway}/orders/404`)).toBe(404);
    expect(await get(`${shop.gateway}/orders/500`)).toBe(502); // a failure: its traces carry error spans
    await sleep(1500);
    await shop.flush();
    await expect.poll(async () => db.count('spans', { projectId: p.id, service: shop.gatewayName }), { timeout: 40_000, intervals: [500] }).toBeGreaterThanOrEqual(14 * 2);
    await expect.poll(async () => db.count('metric_points', { projectId: p.id, service: shop.gatewayName, metric: 'http.server.request.duration' }), { timeout: 40_000, intervals: [500] }).toBeGreaterThan(0);
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${env().ingest}/v1/json-logs`, { method: 'POST', headers: { authorization: `Bearer ${minted.json.token}`, 'content-type': 'application/json' }, body: JSON.stringify([{ level: 'error', msg: `linkburst failure ${i}`, service: 'checkout', 'http.response.status_code': 503 }]) });
      expect(r.status).toBeLessThan(300);
    }
    await expect.poll(async () => db.count('logs', { projectId: p.id, severity: 'error' }), { timeout: 30_000, intervals: [500] }).toBeGreaterThanOrEqual(5);
  });

  test('Preview in the rule form replays the draft over history: summary, chart with threshold and shaded periods, a data table; nothing is created', async ({ page, db }) => {
    test.setTimeout(150_000);
    await login(page, DEMO.owner);
    await page.goto(`/alerts?p=${ctx.projectId}`);
    await fillMetricRule(page, ctx.metricRuleName);
    await page.getByTestId('preview-range').selectOption('3600');

    // loading state: the real request is only delayed, so the busy indicator can be observed
    await page.route('**/alert-rules/preview', async (route) => { await sleep(1200); await route.continue(); });
    await page.getByTestId('rule-preview-run').click();
    await expect(page.getByTestId('rule-preview').getByText('Replaying the rule over history')).toBeVisible();
    await expect(page.getByTestId('rule-preview-run')).toBeDisabled();

    await expect(page.getByTestId('preview-summary')).toContainText('this rule would have opened 1 incident', { timeout: 30_000 });
    await page.unroute('**/alert-rules/preview');
    await expect(page.getByTestId('preview-summary')).toContainText('over 15 min');
    await expect(page.getByTestId('preview-periods')).toContainText('Would fire');
    const chart = page.getByTestId('preview-chart');
    await expect(chart.getByRole('img')).toHaveAttribute('aria-label', /threshold > 0.*would-fire period/);
    await expect(chart.getByTestId('preview-threshold')).toHaveCount(1); // a horizontal line has no area, so it is checked by presence
    await expect(chart.locator('rect[data-kind="firing"]').first()).toBeVisible();
    await expect(page.getByTestId('preview-notes')).toContainText('starts from "ok"');
    await expect(page.getByTestId('preview-notes')).toContainText('Computed from the data stored now');
    // the same data as a table, with the state per evaluation time
    await page.getByText('Show the data as a table').click();
    const rows = page.getByTestId('preview-table').locator('tbody tr');
    expect(await rows.count()).toBeGreaterThan(50);
    await expect(page.getByTestId('preview-table')).toContainText('firing');
    await expect(page.getByTestId('preview-table')).toContainText('ok');

    // a change to the form is flagged: the shown preview no longer describes it
    await page.getByTestId('rule-threshold').fill('1000000');
    await expect(page.getByTestId('preview-stale')).toBeVisible();
    await page.getByTestId('rule-preview-run').click();
    await expect(page.getByTestId('preview-summary')).toContainText('would have opened 0 incidents');
    await expect(page.getByTestId('preview-no-periods')).toBeVisible();
    await expect(page.getByTestId('preview-stale')).toHaveCount(0);

    // read-only: no rule, incident, delivery or notification was created by any of it
    expect(await db.count('alert_config', { projectId: ctx.projectId, kind: 'rule' })).toBe(0);
    expect(await db.count('incidents', { projectId: ctx.projectId })).toBe(0);
    expect(await db.count('alert_deliveries', { projectId: ctx.projectId })).toBe(0);
  });

  test('empty and error states: a metric with no data says so plainly; a rejected draft shows the server message', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, DEMO.owner);
    await page.goto(`/alerts?p=${ctx.projectId}`);
    await fillMetricRule(page, uniq('Ghost'), { metric: 'does.not.exist' });
    await page.getByTestId('rule-preview-run').click();
    await expect(page.getByTestId('preview-empty')).toContainText('No data in this range');
    await expect(page.getByTestId('preview-summary')).toHaveCount(0);
    await expect(page.getByTestId('preview-notes')).toContainText('no data at all');

    // a log rule needs a whole, non-negative threshold: the server refuses it and the panel shows why
    await page.getByTestId('rule-kind-logs').check();
    await page.getByTestId('rule-threshold').fill('-5');
    await page.getByTestId('rule-preview-run').click();
    await expect(page.getByTestId('preview-error')).toContainText(/whole number|threshold/i);
    await expect(page.getByTestId('preview-result')).toHaveCount(0);
  });

  test('a log-count rule previews through the log store; the Preview button needs an environment', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, DEMO.owner);
    await page.goto(`/alerts?p=${ctx.projectId}`);
    await page.getByTestId('new-rule').click();
    await expect(page.getByTestId('rule-preview-run')).toBeDisabled();
    await page.getByTestId('rule-environment').selectOption(ctx.prodEnv);
    await expect(page.getByTestId('rule-preview-run')).toBeEnabled();
    await page.getByTestId('rule-kind-logs').check();
    await page.getByTestId('rule-errors-only').check();
    await page.getByTestId('rule-op').selectOption('gt');
    await page.getByTestId('rule-threshold').fill('2');
    await page.getByTestId('rule-window').fill('5');
    await page.getByTestId('rule-for').fill('0');
    await page.getByTestId('rule-resolve').fill('0');
    await page.getByTestId('rule-preview-run').click();
    await expect(page.getByTestId('preview-summary')).toContainText('would have opened 1 incident');
  });

  test('RBAC: engineers and viewers cannot preview; an environment-restricted admin can only preview inside their environment', async ({ page }) => {
    test.setTimeout(150_000);
    const body = (environmentId: string) => ({ rule: { environmentId, query: { kind: 'logs', errorsOnly: true }, condition: { op: 'gt', threshold: 2 }, windowSeconds: 300 }, rangeSeconds: 600 });
    const url = `/api/v1/projects/${ctx.projectId}/alert-rules/preview`;
    for (const who of [DEMO.engineer, DEMO.viewer]) {
      await login(page, who);
      expect((await apiAs(page, 'POST', url, body(ctx.prodEnv))).status, who).toBe(403);
      await page.goto(`/alerts?p=${ctx.projectId}`);
      await expect(page.getByTestId('new-rule')).toHaveCount(0);
      await page.getByRole('button', { name: 'Sign out' }).click();
    }
    await login(page, DEMO.auditor);
    expect((await apiAs(page, 'POST', url, body(ctx.devEnv))).status).toBe(200);
    expect((await apiAs(page, 'POST', url, body(ctx.prodEnv))).status).toBe(404);
    await page.goto(`/alerts?p=${ctx.projectId}`);
    await page.getByTestId('new-rule').click();
    await expect(page.getByTestId('rule-environment').locator('option')).toHaveText(['Select…', 'Development']);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await login(page, DEMO.globex);
    expect((await apiAs(page, 'POST', url, body(ctx.prodEnv))).status).toBe(404);
  });

  test('a saved metric rule opens an incident (real worker); its page offers the metric, the window and up to 5 example traces, with the honest wording', async ({ page, db }) => {
    test.setTimeout(200_000);
    await login(page, DEMO.owner);
    await page.goto(`/alerts?p=${ctx.projectId}`);
    await fillMetricRule(page, ctx.metricRuleName);
    await page.getByTestId('rule-save').click();
    await expect(page.getByTestId('rules-notice')).toContainText('saved');
    await expect.poll(async () => db.count('incidents', { projectId: ctx.projectId, status: 'open' }), { timeout: 60_000, intervals: [500] }).toBe(1);
    const inc = (await db.find('incidents', { projectId: ctx.projectId }))[0];
    ctx.metricIncidentId = inc._id;
    expect(inc).toMatchObject({ ruleName: ctx.metricRuleName, environmentId: ctx.prodEnv });

    await page.goto(`/incidents/${ctx.metricIncidentId}?p=${ctx.projectId}`);
    const panel = page.getByTestId('related-panel');
    await expect(panel).toBeVisible();
    await expect(page.getByTestId('related-window')).toContainText('Window (UTC)');
    const metricsHref = (await page.getByTestId('related-metrics-link').getAttribute('href'))!;
    const u = new URL(metricsHref, 'http://x');
    expect(u.pathname).toBe('/metrics');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ p: ctx.projectId, metric: 'http.server.request.duration', agg: 'count', range: 'custom', env: ctx.prodEnv, svc: ctx.shop.gatewayName });
    // a link carries only ids, filters and times: no token, secret or session value
    expect(metricsHref).not.toContain(ctx.token);
    expect(await page.getByTestId('related-traces-link').getAttribute('href')).toContain(`svc=${ctx.shop.gatewayName}`);
    await expect(page.getByTestId('related-logs-link')).toHaveCount(0); // a metric rule has no logs link

    await expect(page.getByTestId('related-example-list')).toBeVisible({ timeout: 30_000 });
    const items = page.getByTestId('related-example-list').locator('li');
    expect(await items.count()).toBeGreaterThanOrEqual(1);
    expect(await items.count()).toBeLessThanOrEqual(5);
    await expect(page.getByTestId('related-note')).toContainText('A sample from the window, not proof of cause.');
    await expect(page.getByTestId('related-note')).toContainText('may be unrelated');

    // an example opens a real trace of this service
    await items.first().getByRole('link').click();
    await expect(page.getByTestId('trace-header')).toBeVisible();
    await expect(page.getByTestId('trace-header')).toContainText(ctx.shop.gatewayName);

    // the metric link opens the Metrics explorer on exactly the incident window, in the incident's environment
    await page.goto(metricsHref);
    await expect(page.getByTestId('metric-summary')).toContainText('series');
    await expect(page.getByTestId('metric-summary')).toContainText(`UTC ${u.searchParams.get('from')!.slice(0, 16).replace('T', ' ')}`);
    await expect(page.getByRole('combobox', { name: /range/i })).toContainText('Window from link');
    await expect(page.getByRole('img', { name: /http\.server\.request\.duration/ })).toBeVisible();
  });

  test('a log-count incident links to the Logs Explorer pre-filled with the rule filter and the window, and shows no example traces', async ({ page, db }) => {
    test.setTimeout(200_000);
    await login(page, DEMO.owner);
    const rule = await apiAs(page, 'POST', `/api/v1/projects/${ctx.projectId}/alert-rules`, {
      name: ctx.logRuleName, severity: 'warning', environmentId: ctx.prodEnv, query: { kind: 'logs', errorsOnly: true, services: ['checkout'], filters: [{ field: 'httpStatus', op: 'gte', value: 500 }] },
      condition: { op: 'gt', threshold: 2 }, windowSeconds: 300, forSeconds: 0, resolveAfterSeconds: 0, intervalSeconds: 60,
    });
    expect(rule.status).toBe(201);
    await makeRuleDue(db, ctx.logRuleName);
    await expect.poll(async () => (await db.find('incidents', { projectId: ctx.projectId, ruleName: ctx.logRuleName, status: 'open' })).length, { timeout: 60_000, intervals: [500] }).toBe(1);
    ctx.logIncidentId = (await db.find('incidents', { projectId: ctx.projectId, ruleName: ctx.logRuleName }))[0]._id;

    await page.goto(`/incidents/${ctx.logIncidentId}?p=${ctx.projectId}`);
    await expect(page.getByTestId('related-panel')).toBeVisible();
    const href = (await page.getByTestId('related-logs-link').getAttribute('href'))!;
    const sp = new URL(href, 'http://x').searchParams;
    expect(Object.fromEntries(sp)).toMatchObject({ p: ctx.projectId, range: 'custom', err: '1', svc: 'checkout', env: ctx.prodEnv });
    expect(sp.getAll('f')).toEqual(['httpStatus~gte~500']);
    expect(Date.parse(sp.get('from')!)).toBeLessThan(Date.parse(sp.get('to')!));
    await expect(page.getByTestId('related-examples')).toHaveCount(0);
    await expect(page.getByTestId('related-metrics-link')).toHaveCount(0);

    await page.getByTestId('related-logs-link').click();
    await expect(page.getByTestId('result-summary')).toContainText('event(s) in range', { timeout: 20_000 });
    await expect(page.getByText(/linkburst failure/).first()).toBeVisible();
    await expect(page.getByRole('list', { name: 'Active filters' })).toContainText('HTTP status');
  });

  test('a deleted rule leaves the incident page working, with the panel saying why there are no links; another organization sees nothing', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, DEMO.owner);
    const rules = (await apiAs(page, 'GET', `/api/v1/projects/${ctx.projectId}/alert-rules?limit=100`)).json.items as { id: string; name: string }[];
    const logRule = rules.find((r) => r.name === ctx.logRuleName)!;
    // closing and deleting: the incident (now auto-resolved) still has a page
    expect((await apiAs(page, 'DELETE', `/api/v1/projects/${ctx.projectId}/alert-rules/${logRule.id}`)).status).toBe(204);
    await page.goto(`/incidents/${ctx.logIncidentId}?p=${ctx.projectId}`);
    await expect(page.getByTestId('incident-title')).toBeVisible();
    await expect(page.getByTestId('related-unavailable')).toContainText('no longer exists');
    await expect(page.getByTestId('related-logs-link')).toHaveCount(0);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await login(page, DEMO.globex);
    await page.goto(`/incidents/${ctx.metricIncidentId}?p=${ctx.projectId}`);
    await expect(page.getByRole('heading', { name: 'Project not found' })).toBeVisible();
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`accessibility (axe, WCAG 2 A/AA) of the rule form with a preview and of the incident page with related telemetry, ${theme} theme, no horizontal scroll on a phone`, async ({ page }) => {
      test.setTimeout(180_000);
      await login(page, DEMO.owner);
      await setTheme(page, theme);
      const failures: Record<string, unknown> = {};
      await page.goto(`/alerts?p=${ctx.projectId}`);
      await fillMetricRule(page, uniq('A11y'));
      await page.getByTestId('rule-preview-run').click();
      await expect(page.getByTestId('preview-chart')).toBeVisible({ timeout: 30_000 });
      await page.getByText('Show the data as a table').click();
      const rule = await accessibilityViolations(page);
      if (rule.length) failures['rule form with preview'] = rule;
      await page.setViewportSize({ width: 390, height: 800 });
      expect(await noHorizontalScroll(page), 'rule form with preview at phone width').toBe(true);
      await page.setViewportSize({ width: 1280, height: 800 });

      await page.goto(`/incidents/${ctx.metricIncidentId}?p=${ctx.projectId}`);
      await expect(page.getByTestId('related-example-list')).toBeVisible({ timeout: 30_000 });
      const inc = await accessibilityViolations(page);
      if (inc.length) failures['incident related panel'] = inc;
      await page.setViewportSize({ width: 390, height: 800 });
      expect(await noHorizontalScroll(page), 'incident page at phone width').toBe(true);
      expect(failures).toEqual({});
    });
  }

  test('teardown: the instrumented shop is stopped', async () => { await ctx.shop.stop(); });
});
