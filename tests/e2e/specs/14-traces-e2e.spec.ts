import type { Page } from '@playwright/test';
import { DEMO, env, expect, login, test, apiAs } from '../support/fixtures.js';
import { accessibilityViolations, createProject, grant, noHorizontalScroll, orgMembers, uniq } from '../support/helpers.js';
import { startShop, type RunningShop } from '../support/sample-app.js';

// The real chain: an instrumented gateway calls an instrumented inventory service (W3C trace-context propagation over HTTP);
// both export traces, metrics and logs with the REAL OpenTelemetry JS SDK to the ingestion service; the UI shows what was stored.
// Nothing in this file fakes an API response.

interface Ctx { projectId: string; prodEnv: string; devEnv: string; token: string; shop: RunningShop; name: string; okTrace: string; failTrace: string; missTrace: string }
let ctx: Ctx;

async function get(path: string) { const r = await fetch(path); await r.text(); return r.status; }
const treeitem = (page: Page, name: RegExp | string) => page.getByRole('treeitem', { name });
async function openTrace(page: Page, traceId: string, extra = '') {
  await login(page, DEMO.owner);
  await page.goto(`/traces/${traceId}?p=${ctx.projectId}&env=${ctx.prodEnv}${extra}`);
  await expect(page.getByTestId('trace-header')).toBeVisible();
}
async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => { localStorage.setItem('nx-theme', t); document.documentElement.classList.toggle('dark', t === 'dark'); }, theme);
}

test.describe.serial('two instrumented services -> ingestion -> storage -> UI', () => {
  test('setup: real SDK telemetry from two services reaches storage with propagation intact', async ({ page, db }) => {
    test.setTimeout(240_000);
    const name = uniq('E2E Traces');
    await login(page, DEMO.owner);
    const p = await createProject(page, name);
    const prodEnv = p.environments.find((e) => e.isProduction)!.id, devEnv = p.environments.find((e) => !e.isProduction)!.id;
    const minted = await apiAs(page, 'POST', `/api/v1/projects/${p.id}/environments/${prodEnv}/ingest-tokens`, { name: 'shop' });
    expect(minted.status).toBe(201);
    expect(minted.json.info.scopes.sort()).toEqual(['logs', 'metrics', 'traces']);

    const suffix = Date.now().toString(36);
    const shop = await startShop({ ingestUrl: env().ingest, token: minted.json.token, suffix });
    ctx = { projectId: p.id, prodEnv, devEnv, token: minted.json.token, shop, name, okTrace: '', failTrace: '', missTrace: '' };

    // traffic: successes, a not-found, and a failure that originates in the INVENTORY service
    for (let i = 0; i < 12; i++) expect(await get(`${shop.gateway}/orders/${100 + i}`)).toBe(200);
    expect(await get(`${shop.gateway}/orders/404`)).toBe(404);
    expect(await get(`${shop.gateway}/orders/500`)).toBe(502);
    expect(await get(`${shop.gateway}/orders/slow`)).toBe(200);
    await new Promise((r) => setTimeout(r, 1500)); // let the metric readers collect at least one interval
    await shop.flush();

    await expect.poll(async () => db.count('spans', { projectId: p.id, service: shop.gatewayName }), { timeout: 40_000, intervals: [500] }).toBeGreaterThanOrEqual(15 * 2);
    await expect.poll(async () => db.count('spans', { projectId: p.id, service: shop.inventoryName }), { timeout: 40_000, intervals: [500] }).toBeGreaterThanOrEqual(15 * 2);

    // ---- propagation: the same trace id spans BOTH services, and parent/child links are preserved across the process boundary
    const spans = await db.find('spans', { projectId: p.id });
    const byTrace = new Map<string, any[]>();
    for (const s of spans) byTrace.set(s.traceId, [...(byTrace.get(s.traceId) ?? []), s]);
    const crossService = [...byTrace.values()].filter((t) => new Set(t.map((s) => s.service)).size === 2);
    expect(crossService.length, `output: ${shop.output().slice(-600)}`).toBeGreaterThanOrEqual(14);
    const find500 = [...byTrace.values()].find((t) => t.some((s) => s.name === 'stock.find' && s.statusCode === 'error'))!;
    expect(find500, 'the failing request must be present as a trace').toBeTruthy();
    const gwServer = find500.find((s) => s.service === shop.gatewayName && s.kind === 'server')!;
    const gwClient = find500.find((s) => s.service === shop.gatewayName && s.kind === 'client')!;
    const invServer = find500.find((s) => s.service === shop.inventoryName && s.kind === 'server')!;
    const dbSpan = find500.find((s) => s.name === 'stock.find')!;
    expect(gwServer.parentSpanId).toBeNull();
    expect(gwClient.parentSpanId).toBe(gwServer.spanId);
    expect(invServer.parentSpanId).toBe(gwClient.spanId);   // <- the inventory span continues the gateway's client span
    expect(dbSpan.parentSpanId).toBe(invServer.spanId);
    expect(dbSpan).toMatchObject({ kind: 'client', statusCode: 'error', dbSystem: 'mongodb', exceptionType: 'Error' });
    expect(dbSpan.events.some((e: any) => e.name === 'exception')).toBe(true);
    expect(gwServer.httpStatus).toBe(502);
    expect(gwServer.environmentId).toBe(prodEnv);
    expect(spans.every((s) => s.environmentId === prodEnv && s.projectId === p.id)).toBe(true);
    ctx.failTrace = find500[0]!.traceId;
    ctx.okTrace = [...byTrace.values()].find((t) => t.length >= 4 && !t.some((s) => s.statusCode === 'error') && t.some((s) => s.httpStatus === 200))![0].traceId;
    ctx.missTrace = [...byTrace.values()].find((t) => t.some((s) => s.httpStatus === 404 && s.service === shop.gatewayName))![0].traceId;

    // ---- logs carry the active trace/span ids (this is what links logs and traces)
    await expect.poll(async () => db.count('logs', { projectId: p.id, traceId: ctx.failTrace }), { timeout: 30_000, intervals: [500] }).toBeGreaterThanOrEqual(2);
    const logs = await db.find('logs', { projectId: p.id, traceId: ctx.failTrace });
    expect(logs.every((l) => /^[0-9a-f]{16}$/.test(l.spanId))).toBe(true);
    expect(new Set(logs.map((l) => l.service))).toEqual(new Set([shop.gatewayName, shop.inventoryName]));

    // ---- metrics: ingested and queryable
    await expect.poll(async () => db.count('metric_points', { projectId: p.id, service: shop.gatewayName, metric: 'http.server.request.duration' }), { timeout: 40_000, intervals: [500] }).toBeGreaterThan(0);
    await expect.poll(async () => db.count('metric_points', { projectId: p.id, service: shop.inventoryName }), { timeout: 40_000, intervals: [500] }).toBeGreaterThan(0);
    const names = (await db.find('metric_series', { projectId: p.id })).map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(['http.server.request.duration', 'shop.stock.lookups', 'shop.db.duration']));
    const inventoryHttp = (await db.find('metric_series', { projectId: p.id, service: shop.inventoryName })).map((s) => s.name);
    expect(inventoryHttp.some((n) => /^http\.server\.(request\.)?duration$/.test(n)), `inventory metrics: ${inventoryHttp.join(',')}`).toBe(true);

    // ---- service inventory
    const svc = (await db.find('services', { projectId: p.id })).map((s) => s.name).sort();
    expect(svc).toEqual([shop.gatewayName, shop.inventoryName].sort());
  });

  test('Trace Explorer finds the failed request; the waterfall shows both services, the failing span, its exception and the logs of the trace', async ({ page }) => {
    test.setTimeout(150_000);
    await login(page, DEMO.owner);
    await page.goto(`/traces?p=${ctx.projectId}&range=1h&err=1`);
    const rows = page.getByTestId('trace-row');
    await expect(rows.first()).toBeVisible();
    await expect(page.getByTestId('trace-summary')).toContainText('trace(s)');
    await expect(rows.first()).toContainText('✕');                       // the error indicator is a symbol, not just a colour
    await expect(rows.first()).toContainText(ctx.shop.gatewayName);
    await expect(rows.first()).toContainText(ctx.shop.inventoryName);

    await rows.first().getByRole('link').first().click();
    await expect(page).toHaveURL(new RegExp(`/traces/${ctx.failTrace}`));
    await expect(page.getByTestId('trace-header')).toContainText('Errors');
    await expect(page.getByTestId('waterfall')).toBeVisible();
    expect(await page.getByRole('treeitem').count()).toBeGreaterThanOrEqual(4);
    // hierarchy: root = level 1, its client span = 2, the other service's server span = 3, the datastore span = 4
    const failed = treeitem(page, /stock\.find.*failed/);
    await expect(failed).toBeVisible();
    await expect(failed).toHaveAttribute('aria-level', '4');

    // selecting the failed span shows its exception, status and datastore metadata
    await failed.click();
    const details = page.getByTestId('span-details');
    await expect(details).toContainText('stock.find');
    await expect(details.getByTestId('exception')).toContainText('stock database connection reset');
    await expect(details).toContainText('mongodb');
    await expect(details).toContainText(ctx.shop.inventoryName);
    await expect(page).toHaveURL(/span=[0-9a-f]{16}/);                  // the selection is part of the deep link

    // logs of the trace, from BOTH services
    const logs = page.getByTestId('trace-logs');
    await expect(logs).toContainText('inventory failed for order 500');
    await expect(logs).toContainText('unhandled error serving GET /stock/500');   // the INVENTORY service's own log

    // the same information as a table, for users who cannot use the visual timeline
    await page.getByRole('button', { name: 'Table', exact: true }).click();
    const table = page.getByTestId('span-table');
    await expect(table).toBeVisible();
    await expect(table.getByRole('row')).toHaveCount(5);               // header + 4 spans
    await expect(table).toContainText('✕ error');
    await expect(table).toContainText('stock database connection reset');
  });

  test('the waterfall is keyboard operable, collapses and zooms, and passes WCAG A/AA in both themes', async ({ page }) => {
    test.setTimeout(150_000);
    await openTrace(page, ctx.failTrace);
    await page.getByRole('treeitem').first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(page.getByRole('treeitem').nth(1)).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(page.getByRole('treeitem').first()).toBeFocused();
    await page.keyboard.press('ArrowLeft');                              // collapse the root: its subtree disappears
    await expect(page.getByRole('treeitem')).toHaveCount(1);
    await expect(page.getByRole('treeitem').first()).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('ArrowRight');                             // expand again
    await expect(page.getByRole('treeitem')).toHaveCount(4);
    await page.keyboard.press('End');
    await expect(page.getByRole('treeitem').last()).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('span-details')).toContainText('stock.find');

    await page.getByRole('button', { name: 'Collapse all' }).click();
    await expect(page.getByRole('treeitem')).toHaveCount(1);
    await page.getByRole('button', { name: 'Expand all' }).click();
    await expect(page.getByRole('treeitem')).toHaveCount(4);

    const status = page.getByRole('status').filter({ hasText: /Showing/ });
    const before = await status.textContent();
    await page.getByRole('button', { name: 'Zoom in' }).click();
    await expect(status).not.toHaveText(before!);
    await page.getByRole('button', { name: 'Reset zoom' }).click();
    await expect(status).toHaveText(before!);
    await page.getByRole('button', { name: 'Zoom to selected span' }).click();
    await expect(page.getByTestId('waterfall')).toBeVisible();

    for (const theme of ['light', 'dark'] as const) {
      await setTheme(page, theme);
      expect(await accessibilityViolations(page), `trace detail (${theme})`).toEqual([]);
    }
    await setTheme(page, 'light');
    await page.getByRole('button', { name: 'Table', exact: true }).click();
    expect(await accessibilityViolations(page), 'trace table').toEqual([]);
  });

  test('a successful trace has no completeness warnings; deep links work for a new session; authorization applies to shared links', async ({ page, browser }) => {
    test.setTimeout(180_000);
    await openTrace(page, ctx.okTrace);
    await expect(page.getByTestId('completeness-warning')).toHaveCount(0);
    await expect(page.getByTestId('trace-header')).toContainText('Spans');
    expect(await page.getByRole('treeitem').count()).toBeGreaterThanOrEqual(4);
    const link = `/traces/${ctx.failTrace}?p=${ctx.projectId}&env=${ctx.prodEnv}`;

    // give a read-only viewer access to the DEV environment only, and an engineer to everything
    const members = await orgMembers(page);
    await page.goto('/');
    await grant(page, ctx.projectId, members['viewer@acme.test']!, 'viewer', [ctx.devEnv]);
    await grant(page, ctx.projectId, members['engineer@acme.test']!, 'engineer');

    const ctxV = await browser.newContext(); const v = await ctxV.newPage();
    await login(v, DEMO.viewer);
    await v.goto(link);
    await expect(v.getByText('Trace not found')).toBeVisible();              // the trace exists, but not for this person: indistinguishable from "missing"
    await expect(v.getByTestId('trace-header')).toHaveCount(0);
    await expect(v.getByText(ctx.shop.gatewayName)).toHaveCount(0);
    await ctxV.close();

    const ctxE = await browser.newContext(); const e = await ctxE.newPage();
    await login(e, DEMO.engineer);
    await e.goto(link);
    await expect(e.getByTestId('trace-header')).toBeVisible();               // an authorized person opens the same link
    await expect(e.getByRole('treeitem').first()).toBeVisible();
    await ctxE.close();

    const ctxG = await browser.newContext(); const g = await ctxG.newPage();
    await login(g, DEMO.globex);
    await g.goto(link);
    await expect(g.getByText('Project not found')).toBeVisible();            // another tenant: not even the project is revealed
    await ctxG.close();

    const anon = await browser.newContext(); const a = await anon.newPage();
    await a.goto(link);
    await expect(a.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
    await anon.close();
  });

  test('a log record links to its trace and span; a log whose trace has not arrived says so honestly', async ({ page }) => {
    test.setTimeout(150_000);
    // a log that references a trace which was never received
    const orphanTrace = 'c0ffee00'.repeat(4);
    const r = await fetch(`${env().ingest}/v1/json-logs`, { method: 'POST', headers: { authorization: `Bearer ${ctx.token}`, 'content-type': 'application/json' },
      body: JSON.stringify([{ level: 'error', msg: 'late span log', service: 'ghost-svc', trace_id: orphanTrace, span_id: 'abcdabcdabcdabcd', time: new Date().toISOString() }]) });
    expect(r.status).toBe(200);

    await login(page, DEMO.owner);
    await page.goto(`/logs?p=${ctx.projectId}&range=1h&f=${encodeURIComponent(`traceId~eq~${ctx.failTrace}`)}`);
    const results = page.getByRole('table', { name: 'Log results' });
    await expect(results).toContainText('inventory failed for order 500');
    await results.getByRole('row').filter({ hasText: 'inventory failed for order 500' }).first().click();
    await page.getByTestId('trace-link').getByRole('link').click();
    await expect(page).toHaveURL(new RegExp(`/traces/${ctx.failTrace}`));
    await expect(page.getByTestId('span-details')).toBeVisible();            // the span the log belongs to is preselected

    await page.goto(`/logs?p=${ctx.projectId}&range=1h&f=${encodeURIComponent(`traceId~eq~${orphanTrace}`)}`);
    await expect(page.getByRole('table', { name: 'Log results' })).toContainText('late span log');
    await page.getByRole('table', { name: 'Log results' }).getByRole('row').filter({ hasText: 'late span log' }).first().click();
    await page.getByTestId('trace-link').getByRole('link').click();
    await expect(page.getByText('Trace not found')).toBeVisible();
    await expect(page.getByText(/may not have arrived yet/)).toBeVisible();
    await expect(page.getByRole('link', { name: 'do exist' })).toBeVisible(); // the logs that DO reference it are one click away
  });

  test('Services shows each service with its data source, freshness, and the observed dependencies', async ({ page }) => {
    test.setTimeout(150_000);
    await login(page, DEMO.owner);
    await page.goto(`/services?p=${ctx.projectId}&minutes=60`);
    const gw = page.getByTestId(`service-${ctx.shop.gatewayName}`);
    const inv = page.getByTestId(`service-${ctx.shop.inventoryName}`);
    await expect(gw).toBeVisible();
    await expect(inv).toBeVisible();
    await expect(gw).toContainText('HTTP metrics');                         // explicit metric (stable semconv), preferred over the legacy auto-metric
    await expect(gw).toContainText('active');
    const requests = Number((await gw.locator('td').nth(2).textContent())!.replace(/[^\d]/g, ''));
    expect(requests).toBeGreaterThanOrEqual(10);
    await expect(inv).toContainText('active');
    await expect(inv).toContainText('HTTP metrics');
    await expect(page.getByRole('table', { name: 'Observed dependencies' })).toContainText(ctx.shop.inventoryName);
    await expect(page.getByRole('table', { name: 'Observed dependencies' })).toContainText('mongodb');
    await expect(page.getByText(/none are inferred/)).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
  });

  test('Service dashboard: request volume, errors, latency, failing routes, and the traces behind them', async ({ page }) => {
    test.setTimeout(150_000);
    await login(page, DEMO.owner);
    await page.goto(`/services/${ctx.shop.gatewayName}?p=${ctx.projectId}&minutes=60`);
    await expect(page.getByTestId('service-health')).toBeVisible();
    await expect(page.getByTestId('source-detail')).toContainText('Explicit OTLP metric');
    await expect(page.getByRole('img', { name: /Requests and errors per window/ })).toBeVisible();
    await expect(page.getByRole('img', { name: /p95 latency per window/ })).toBeVisible();
    await expect(page.getByRole('img', { name: /Responses by class/ })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Operations by p95' })).toContainText('/orders/:id');          // a route TEMPLATE, never a raw URL
    await expect(page.getByRole('table', { name: 'Operations by p95' })).not.toContainText('/orders/100');
    await expect(page.locator('p', { hasText: 'Failing:' })).toContainText('/orders/:id');
    await page.getByRole('button', { name: 'Show data as a table' }).first().click();
    await expect(page.getByRole('table', { name: /Requests and errors per window: values per window/ })).toBeVisible();

    // the metric window leads to trace evidence: failed + slow traces of this service, and an explicit "not proof of cause" statement
    await expect(page.getByTestId('correlation-note')).toContainText('not proof');
    const failedList = page.getByRole('heading', { name: 'Failed traces in this window' }).locator('..');
    await expect(failedList.getByRole('link').first()).toBeVisible();
    await failedList.getByRole('link').first().click();
    await expect(page.getByTestId('trace-header')).toBeVisible();
    await expect(page.getByRole('treeitem').first()).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
  });

  test('Metrics explorer: a counter and a percentile query over real data, with honest notes', async ({ page }) => {
    test.setTimeout(150_000);
    await login(page, DEMO.owner);
    await page.goto(`/metrics?p=${ctx.projectId}&metric=shop.stock.lookups&range=1h`);
    await expect(page.getByTestId('metric-summary')).toContainText('series');
    await expect(page.getByRole('img', { name: /shop\.stock\.lookups/ })).toBeVisible();
    await expect(page.getByTestId('metric-notes')).toContainText('Counter series are converted to increases');

    await page.goto(`/metrics?p=${ctx.projectId}&metric=http.server.request.duration&agg=p95&group=http.route&svc=${ctx.shop.gatewayName}&range=1h`);
    await expect(page.getByRole('table', { name: 'Series summary' })).toContainText('http.route=/orders/:id');
    await expect(page.getByTestId('metric-notes')).toContainText('estimated from histogram bucket counts');
    await expect(page.getByText('Traces behind this metric')).toBeVisible();
    await expect(page.getByText(/does not show that they caused/)).toBeVisible();
    await page.getByRole('link', { name: 'Traces from the same window' }).click();
    await expect(page.getByTestId('trace-row').first()).toBeVisible();
    expect(await accessibilityViolations(page)).toEqual([]);
  });

  test('layouts hold at phone width in both themes, and a logs-only token cannot write traces', async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, DEMO.owner);
    for (const url of [`/traces?p=${ctx.projectId}&range=1h`, `/traces/${ctx.failTrace}?p=${ctx.projectId}`, `/services?p=${ctx.projectId}`, `/services/${ctx.shop.gatewayName}?p=${ctx.projectId}`, `/metrics?p=${ctx.projectId}&metric=shop.stock.lookups`]) {
      for (const theme of ['light', 'dark'] as const) {
        await page.goto(url);
        await setTheme(page, theme);
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        await page.waitForTimeout(400);
        expect(await noHorizontalScroll(page), `${url} (${theme})`).toBe(true);
      }
    }
    // token scopes are enforced on the real ingestion endpoint
    const logsOnly = await apiAs(page, 'POST', `/api/v1/projects/${ctx.projectId}/environments/${ctx.devEnv}/ingest-tokens`, { name: 'logs only', signals: ['logs'] });
    expect(logsOnly.status).toBe(201);
    const denied = await fetch(`${env().ingest}/v1/traces`, { method: 'POST', headers: { authorization: `Bearer ${logsOnly.json.token}`, 'content-type': 'application/json' }, body: '{"resourceSpans":[]}' });
    expect(denied.status).toBe(403);
    expect((await fetch(`${env().ingest}/v1/metrics`, { method: 'POST', headers: { authorization: `Bearer ${logsOnly.json.token}`, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403);
    await ctx.shop.stop();
  });
});
