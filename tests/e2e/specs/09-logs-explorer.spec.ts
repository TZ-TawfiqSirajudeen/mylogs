import type { Page } from '@playwright/test';
import { DEMO, env, expect, login, selectProject, test, apiAs } from '../support/fixtures.js';
import { createProject, grant, orgMembers, uniq } from '../support/helpers.js';
import { sendTraffic, startSampleApp } from '../support/sample-app.js';

const iso = (agoMs = 0) => new Date(Date.now() - agoMs).toISOString();

async function mintToken(page: Page, projectId: string, envId: string, name = 'e2e', extra: object = {}) {
  const r = await apiAs(page, 'POST', `/api/v1/projects/${projectId}/environments/${envId}/ingest-tokens`, { name, ...extra });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return r.json as { token: string; info: { id: string } };
}
async function sendJson(token: string, records: object[]) {
  return fetch(`${env().ingest}/v1/json-logs`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(records) });
}
async function openLogs(page: Page, projectName: string, query = '') {
  await page.goto('/'); // the project was created behind the UI's back: load the fresh project list first
  await selectProject(page, projectName);
  await page.goto(`/logs${query}`);
  await expect(page.getByRole('heading', { name: /^Logs/ })).toBeVisible();
}
const results = (page: Page) => page.getByRole('table', { name: 'Log results' });
const rowsIn = (page: Page) => results(page).getByRole('row').filter({ has: page.locator('[role="cell"]') });
/** Rows loaded (not just rendered: the list is virtualized, so the DOM only holds the visible window). */
const loaded = async (page: Page) => Number(await results(page).getAttribute('aria-rowcount')) - 1;
const run = (page: Page) => page.getByRole('button', { name: 'Run search' }).click();

test.describe('logs explorer', () => {
  test('first-run: silence is reported honestly (no fake numbers), then the full journey with a real instrumented app', async ({ page, db, responses }) => {
    test.setTimeout(240_000);
    const projectName = uniq('E2E Logs Journey');
    await login(page, DEMO.owner);
    const project = await createProject(page, projectName);
    const prod = project.environments.find((e) => e.isProduction)!;
    await page.reload();
    await selectProject(page, projectName);

    // ---- nothing has ever arrived: the UI says "silent", not "healthy and quiet"
    await page.goto('/logs');
    await expect(page.getByText('No telemetry has been received for this project yet')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Set up ingestion' })).toBeVisible();
    await page.getByRole('link', { name: 'Set up ingestion' }).click();
    await expect(page.getByTestId('ingest-env-Production')).toContainText('No telemetry received yet');
    await expect(page.getByTestId('ingest-env-Development')).toContainText('No telemetry received yet');

    // ---- create a token in the UI: shown once, never stored
    const main = page.locator('main');
    await main.getByLabel('Environment').selectOption({ label: 'Production (production)' });
    await main.getByLabel('Token name').fill('checkout-api');
    await main.getByLabel('Extra fields to mask').fill('customer.tier');
    await main.getByRole('button', { name: 'Create token' }).click();
    const fresh = page.getByTestId('fresh-token');
    await expect(fresh).toBeVisible();
    await expect(fresh).toContainText('shown once');
    const token = (await page.getByTestId('fresh-token-value').textContent())!.trim();
    expect(token).toMatch(/^nxi_[A-Za-z0-9_-]{43}$/);
    await expect(fresh).toContainText('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=');
    await expect(fresh).toContainText(`${env().ingest}/v1/logs`);
    await page.getByRole('button', { name: /dismiss/ }).click();
    await expect(page.getByText(token)).toHaveCount(0);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(token);
    await expect(page.getByRole('table', { name: 'Ingestion tokens' })).toContainText(token.slice(0, 8));
    await expect(page.getByRole('table', { name: 'Ingestion tokens' })).not.toContainText(token);

    // ---- a real instrumented application starts sending logs
    const service = `shop-${Date.now().toString(36)}`;
    const app = await startSampleApp({ ingestUrl: env().ingest, token, service });
    try {
      await sendTraffic(app.url, 24, 'journey');
      await expect.poll(() => db.count('logs', { projectId: project.id, service }), { timeout: 30_000, intervals: [500] }).toBeGreaterThanOrEqual(24);
    } finally { await app.stop(); }

    // ---- the Production card now shows data and no refusals
    await page.reload();
    await expect(page.getByTestId('ingest-env-Production')).toContainText('Last telemetry received');
    await expect(page.getByTestId('ingest-env-Development')).toContainText('No telemetry received yet'); // per environment, not global

    // ---- find the HTTP 500: errors only + status filter, then investigate
    await page.goto('/logs');
    await page.getByRole('checkbox', { name: 'Errors only' }).check();
    await page.getByText('Field filters', { exact: false }).click();
    const builder = page.getByRole('group', { name: 'Add a field filter' });
    await builder.getByLabel('Field').selectOption('httpStatus');
    await builder.getByLabel('Operator').selectOption('gte');
    await builder.getByLabel('Value').fill('500');
    await builder.getByRole('button', { name: 'Add filter' }).click();
    await expect(page.getByRole('list', { name: 'Active filters' })).toContainText('HTTP status ≥ 500');
    await run(page);
    await expect(rowsIn(page).first()).toContainText('GET /orders/:id -> 500');
    expect(await rowsIn(page).count()).toBeGreaterThanOrEqual(3);
    for (const row of await rowsIn(page).all()) await expect(row).toContainText('error');
    await expect(page.getByTestId('result-summary')).toContainText('event(s) in range');
    expect(page.url()).toContain('f=httpStatus');

    await rowsIn(page).first().click();
    const drawer = page.getByRole('complementary', { name: 'Log details' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByTestId('log-message')).toContainText('GET /orders/:id -> 500');
    await expect(drawer.locator('dt', { hasText: 'HTTP status' }).locator('..')).toContainText('500');
    await expect(drawer.locator('dt', { hasText: 'Trace ID' }).locator('..')).toContainText(/[0-9a-f]{32}/);
    await expect(drawer.locator('dt', { hasText: 'Request ID' }).locator('..')).toContainText('journey-');
    await expect(drawer.locator('dt', { hasText: 'Service version' }).locator('..')).toContainText('1.2.3');
    await expect(drawer.locator('dt', { hasText: 'Environment' }).locator('..')).toContainText('Production');
    await expect(drawer.getByText(/UTC/).first()).toBeVisible();
    await expect(drawer.getByText(/local/).first()).toBeVisible();
    await expect(drawer.getByText('unavailable').first()).toBeVisible(); // absent facts are labelled, not invented (e.g. container)
    // related events share the trace: the request log AND the exception log (with its stack trace)
    const related = drawer.getByRole('region', { name: /Related events \(same trace\)/ });
    await expect(related).toBeVisible();
    await expect(related).toContainText('observed correlation, not inferred');
    await expect(related.getByRole('button', { name: /unhandled error/ })).toBeVisible();
    await related.getByRole('button', { name: /unhandled error/ }).click();
    await expect(drawer.getByRole('region', { name: 'Stack trace' })).toContainText('TypeError');
    await expect(drawer.getByRole('region', { name: 'Stack trace' })).toContainText(/at .*app\.ts/);
    await expect(drawer.locator('dt', { hasText: 'Error type' }).locator('..')).toContainText('TypeError');
    // JSON view
    await drawer.getByRole('tab', { name: 'JSON' }).click();
    await expect(drawer.getByLabel('Record as JSON')).toContainText('"errorType": "TypeError"');
    await expect(drawer.getByLabel('Record as JSON')).not.toContainText('orgId');
    await drawer.getByRole('tab', { name: 'Details' }).click();
    // "search for this value": pivot on the trace id
    await drawer.locator('dt', { hasText: 'Trace ID' }).locator('..').getByRole('button', { name: 'search' }).click();
    await expect(page.getByRole('list', { name: 'Active filters' })).toContainText('Trace ID is');
    await expect(page.getByRole('checkbox', { name: 'Errors only' })).not.toBeChecked(); // following an id shows ALL of its evidence
    await expect.poll(() => rowsIn(page).count()).toBeGreaterThanOrEqual(2);
    await drawer.getByRole('button', { name: 'Close log details' }).click();
    await expect(drawer).toHaveCount(0);

    // ---- redaction as the user sees it (the app logged a password, a bearer token, a cookie, a vendor key)
    await page.goto('/logs');
    await page.getByLabel('Search messages and errors').fill('login attempt');
    await run(page);
    await rowsIn(page).first().click();
    const msg = page.getByRole('complementary', { name: 'Log details' }).getByTestId('log-message');
    await expect(msg).toContainText('[REDACTED]');
    await expect(page.getByTestId('redaction-note')).toContainText(/\d+ sensitive value\(s\)/);
    const bodyText = await page.locator('body').innerText();
    for (const secret of ['hunter2hunter2', 'sk_live_abcdefghijklmnop', 'abcdefghijklmnop0123456789', 'supersecretsessionvalue']) expect(bodyText, secret).not.toContain(secret);
    await expect(page.getByRole('complementary', { name: 'Log details' }).locator('tr', { hasText: 'user.password' })).toContainText('[REDACTED]');
    await expect(page.getByRole('complementary', { name: 'Log details' }).locator('tr', { hasText: 'customer.tier' })).toContainText('[REDACTED]'); // the token's extra key
    await expect(page.getByRole('complementary', { name: 'Log details' }).locator('tr', { hasText: 'user.password' }).getByRole('button', { name: /^Search for/ })).toHaveCount(0); // never offer to search a masked value
    await page.keyboard.press('Escape');

    // ---- live tail: new traffic appears without pressing Run
    await page.goto('/logs');
    await page.getByRole('button', { name: 'Live tail' }).click();
    await expect(page.getByTestId('live-status')).toContainText('Live: new matching events');
    const before = await loaded(page);
    const live = await startSampleApp({ ingestUrl: env().ingest, token, service: `${service}-live` });
    try {
      await sendTraffic(live.url, 12, 'live');
      await expect.poll(() => loaded(page), { timeout: 30_000 }).toBeGreaterThan(before);
    } finally { await live.stop(); }
    await expect(rowsIn(page).first()).toContainText(/sample-shop|->|started|login|order/i);
    await page.getByRole('button', { name: /Live — stop/ }).click();
    await expect(page.getByTestId('live-status')).toHaveCount(0);

    // ---- export: engineer-level access; file is scoped, free of secrets, and audited
    await page.goto('/logs');
    await page.locator('#export-format').selectOption('csv');
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: /Export \(max 10,000\)/ }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^logs-.*\.csv$/);
    const csv = (await (await import('node:fs/promises')).readFile((await file.path())!, 'utf8'));
    expect(csv.split('\n')[0]).toBe('ts,severity,service,host,environmentId,traceId,spanId,requestId,httpMethod,httpRoute,httpStatus,durationMs,errorType,message');
    expect(csv.split('\n').length).toBeGreaterThan(20);
    for (const secret of ['hunter2hunter2', 'sk_live_abcdefghijklmnop']) expect(csv).not.toContain(secret);
    await expect.poll(() => db.count('audit_events', { action: 'logs.exported', projectId: project.id })).toBe(1);

    // ---- saved queries and history
    await page.goto('/logs');
    await page.getByRole('checkbox', { name: 'Errors only' }).check();
    await page.getByLabel('Search messages and errors').fill('orders');
    await run(page);
    await page.locator('summary', { hasText: 'Saved queries' }).click();
    await page.getByLabel('Name for the saved query').fill('order errors');
    await page.getByRole('button', { name: 'Save current' }).click();
    await expect(page.getByRole('button', { name: 'order errors', exact: true })).toBeVisible();
    await page.locator('summary', { hasText: 'History' }).click();
    await expect(page.getByText(/· orders$/).first()).toBeVisible();
    await page.goto('/logs');
    await page.locator('summary', { hasText: 'Saved queries' }).click();
    await page.getByRole('button', { name: 'order errors', exact: true }).click();
    await expect(page.getByLabel('Search messages and errors')).toHaveValue('orders');
    await expect(page.getByRole('checkbox', { name: 'Errors only' })).toBeChecked();
    await page.getByRole('button', { name: 'Delete saved query order errors' }).click();
    await expect(page.getByRole('button', { name: 'order errors', exact: true })).toHaveCount(0);

    // ---- revoke: the sender is cut off, the UI says so
    await page.goto('/sources?tab=ingestion');
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('row', { name: /checkout-api/ }).getByRole('button', { name: 'Revoke' }).click();
    await expect(page.getByRole('row', { name: /checkout-api/ })).toContainText('revoked');
    expect((await sendJson(token, [{ msg: 'after revoke' }])).status).toBe(401);

    // ---- nothing secret ever reached the browser
    expect(responses.join('\n')).not.toContain('hunter2hunter2');
    expect(responses.filter((r) => r.includes(token))).toHaveLength(1); // the token crossed the wire to the browser exactly once: in the response that created it (shown once, by design)
    void prod;
  });

  test('filters, time ranges and deep links', async ({ page, browser }) => {
    test.setTimeout(150_000);
    const name = uniq('E2E Logs Filters');
    await login(page, DEMO.owner);
    const p = await createProject(page, name);
    const dev = p.environments.find((e) => !e.isProduction)!;
    const { token } = await mintToken(page, p.id, dev.id, 'filters');
    const recs = [
      ...Array.from({ length: 20 }, (_, i) => ({ time: iso(60_000 + i * 1000), level: 'info', msg: `health check ${i}`, service: 'gateway' })),
      { time: iso(30_000), level: 'error', msg: 'payment declined "card expired" for order 9', service: 'payments', 'http.response.status_code': 402, 'customer.tier': 'gold', trace_id: 'c'.repeat(32) },
      { time: iso(25_000), level: 'warn', msg: 'retrying payment provider', service: 'payments', 'customer.tier': 'silver' },
      { time: iso(20_000), level: 'fatal', msg: 'out of memory', service: 'worker', 'http.response.status_code': 503 },
      { time: iso(2 * 3600_000), level: 'error', msg: 'old failure two hours ago', service: 'payments' },
    ];
    expect((await sendJson(token, recs)).status).toBe(200);
    await openLogs(page, name);

    await expect(page.getByTestId('result-summary')).toContainText('24 event(s)', { timeout: 15_000 }).catch(() => undefined);
    // default range (15 min) excludes the 2-hour-old record
    await expect.poll(() => rowsIn(page).count()).toBe(23);
    await expect(results(page)).not.toContainText('old failure two hours ago');

    // preset ranges
    await page.getByLabel('Time range').selectOption('24h');
    await run(page);
    await expect.poll(() => rowsIn(page).count()).toBe(24);

    // text search: all terms required, phrases, case-insensitive; regex metacharacters are literal
    await page.getByLabel('Search messages and errors').fill('PAYMENT "card expired"');
    await run(page);
    await expect.poll(() => rowsIn(page).count()).toBe(1);
    await page.getByLabel('Search messages and errors').fill('.*');
    await run(page);
    await expect(page.getByText('No logs match this search')).toBeVisible();
    await expect(page.getByText(/Telemetry last arrived at/)).toBeVisible();
    await page.getByLabel('Search messages and errors').fill('');

    // severity thresholds
    await page.getByLabel('Minimum severity').selectOption('warn');
    await run(page);
    await expect.poll(() => rowsIn(page).count()).toBe(4); // warn, error, fatal, and the 2h-old error
    await page.getByLabel('Minimum severity').selectOption('error');
    await run(page);
    await expect.poll(() => rowsIn(page).count()).toBe(3);

    // service facet with counts
    await page.getByLabel('Minimum severity').selectOption('');
    await page.locator('summary', { hasText: 'Services' }).click();
    await page.getByRole('checkbox', { name: /^payments/ }).check();
    await run(page);
    await expect.poll(() => rowsIn(page).count()).toBe(3);

    // attribute filter and numeric operators
    await page.getByRole('checkbox', { name: /^payments/ }).uncheck();
    await page.getByText('Field filters', { exact: false }).click();
    const b = page.getByRole('group', { name: 'Add a field filter' });
    await b.getByLabel('Field').selectOption('attr');
    await b.getByLabel('Attribute name').fill('customer.tier');
    await b.getByLabel('Value').fill('gold');
    await b.getByRole('button', { name: 'Add filter' }).click();
    await run(page);
    await expect.poll(() => rowsIn(page).count()).toBe(1);
    await page.getByRole('button', { name: /Remove filter/ }).click();
    await b.getByLabel('Field').selectOption('httpStatus');
    await b.getByLabel('Operator').selectOption('gt');
    await b.getByLabel('Value').fill('400');
    await b.getByRole('button', { name: 'Add filter' }).click();
    await run(page);
    await expect.poll(() => rowsIn(page).count()).toBe(2);

    // the URL is a deep link: another browser context reproduces the same view and selection
    await rowsIn(page).first().click();
    await expect(page.getByRole('complementary', { name: 'Log details' })).toBeVisible();
    const url = page.url();
    expect(url).toContain('f=httpStatus');
    expect(url).toContain('id=');
    const ctx2 = await browser.newContext({ baseURL: env().web });
    const p2 = await ctx2.newPage();
    await login(p2, DEMO.owner);
    await p2.goto(url);
    await expect(p2.getByRole('list', { name: 'Active filters' })).toContainText('HTTP status > 400');
    await expect(p2.getByRole('complementary', { name: 'Log details' })).toBeVisible();
    await expect.poll(() => rowsIn(p2).count()).toBe(2);
    await ctx2.close();

    // custom range
    await page.getByRole('button', { name: 'Close log details' }).click();
    await page.getByLabel('Time range').selectOption('custom');
    await expect(page.getByLabel('From', { exact: true })).toBeVisible();
    await expect(page.getByLabel('To', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: /Remove filter/ }).click();
    await run(page);
    await expect(page.getByTestId('result-summary')).toContainText('UTC');
    expect(page.url()).toContain('range=custom');
  });

  test('large result sets stay fast: virtualized rows, incremental loading, bounded DOM', async ({ page }) => {
    test.setTimeout(180_000);
    const name = uniq('E2E Logs Volume');
    await login(page, DEMO.owner);
    const p = await createProject(page, name);
    const { token } = await mintToken(page, p.id, p.environments[0]!.id, 'volume');
    for (let b = 0; b < 3; b++) {
      const recs = Array.from({ length: 1000 }, (_, i) => ({ time: iso(1000 + (b * 1000 + i) * 20), level: i % 50 === 0 ? 'error' : 'info', msg: `volume record ${b * 1000 + i}`, service: 'bulk' }));
      expect((await sendJson(token, recs)).status).toBe(200);
    }
    await openLogs(page, name);
    await expect(page.getByTestId('result-summary')).toContainText('3,000 event(s)', { timeout: 20_000 });
    await expect.poll(() => rowsIn(page).count()).toBeGreaterThan(5);
    expect(await rowsIn(page).count()).toBeLessThan(60); // 100 loaded, only the visible window rendered
    await expect(page.getByText(/100 loaded/)).toBeVisible();
    const viewport = results(page).locator('div.overflow-auto');
    for (let i = 0; i < 6; i++) { await viewport.evaluate((e) => e.scrollTo(0, e.scrollHeight)); await page.waitForTimeout(400); }
    await expect.poll(async () => Number(/(\d[\d,]*) loaded/.exec(await page.getByRole('status').filter({ hasText: 'loaded' }).innerText())?.[1]?.replace(/,/g, '')), { timeout: 20_000 }).toBeGreaterThan(300);
    expect(await rowsIn(page).count()).toBeLessThan(60);
  });

  test('refusals are surfaced to humans: rate-limited senders show up as a warning, with counts', async ({ page }) => {
    const name = uniq('E2E Logs Refused');
    await login(page, DEMO.owner);
    const p = await createProject(page, name);
    const { token } = await mintToken(page, p.id, p.environments[0]!.id, 'tiny quota', { recordsPerMinute: 100 });
    expect((await sendJson(token, Array.from({ length: 80 }, (_, i) => ({ msg: `ok ${i}` })))).status).toBe(200);
    const refused = await sendJson(token, Array.from({ length: 80 }, (_, i) => ({ msg: `refused ${i}` })));
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    await openLogs(page, name);
    const banner = page.getByTestId('refused-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('80 record(s)');
    await page.goto('/sources?tab=ingestion');
    await expect(page.getByRole('list').filter({ hasText: 'accepted' }).first()).toContainText('80 accepted');
    await expect(page.getByLabel('Refusals in the last hour')).toContainText('Rate limited');
    await expect(page.getByLabel('Refusals in the last hour').locator('div', { hasText: 'Rate limited' })).toContainText('80');
  });

  test('access control in the UI: environment-scoped viewer, no export for viewers, deep links do not bypass authorization', async ({ page, browser }) => {
    test.setTimeout(150_000);
    const name = uniq('E2E Logs RBAC');
    await login(page, DEMO.owner);
    const p = await createProject(page, name);
    const prod = p.environments.find((e) => e.isProduction)!;
    const dev = p.environments.find((e) => !e.isProduction)!;
    const m = await orgMembers(page);
    await grant(page, p.id, m[DEMO.viewer]!, 'viewer', [dev.id]);
    await grant(page, p.id, m[DEMO.engineer]!, 'engineer');
    const prodTok = await mintToken(page, p.id, prod.id, 'prod');
    const devTok = await mintToken(page, p.id, dev.id, 'dev');
    await sendJson(prodTok.token, [{ time: iso(5000), level: 'error', msg: 'PROD-ONLY customer failure', service: 'billing' }]);
    await sendJson(devTok.token, [{ time: iso(5000), level: 'info', msg: 'dev-only message', service: 'billing' }]);
    await openLogs(page, name);
    await page.getByLabel('Search messages and errors').fill('PROD-ONLY');
    await run(page);
    await rowsIn(page).first().click();
    const deepLink = page.url();
    expect(deepLink).toContain('id=');

    // viewer restricted to dev: sees dev only; the prod record cannot be found or opened through a deep link
    const vctx = await browser.newContext({ baseURL: env().web });
    const v = await vctx.newPage();
    await login(v, DEMO.viewer);
    await openLogs(v, name);
    await expect.poll(() => rowsIn(v).count()).toBe(1);
    await expect(results(v)).toContainText('dev-only message');
    await expect(results(v)).not.toContainText('PROD-ONLY');
    await expect(v.getByRole('button', { name: /Export/ })).toHaveCount(0); // viewers cannot export
    await expect(v.getByText('share', { exact: true })).toHaveCount(0); // ...or share queries
    await v.goto(deepLink);
    await expect(v.getByRole('complementary', { name: 'Log details' })).toContainText('Log record not found');
    await expect(v.locator('body')).not.toContainText('PROD-ONLY customer failure');
    await v.getByRole('button', { name: 'Close log details' }).click();
    await expect(v.getByRole('link', { name: /Set up ingestion/ })).toHaveCount(0);
    await v.goto('/sources?tab=ingestion');
    await expect(v.getByText('Only project admins can see and manage ingestion tokens.')).toBeVisible();
    await expect(v.getByRole('button', { name: 'Create token' })).toHaveCount(0);
    await vctx.close();

    // engineer: can search everything and export, but not manage tokens
    const ectx = await browser.newContext({ baseURL: env().web });
    const e = await ectx.newPage();
    await login(e, DEMO.engineer);
    await openLogs(e, name);
    await expect(e.getByRole('button', { name: /Export/ })).toBeVisible();
    await e.goto('/sources?tab=ingestion');
    await expect(e.getByText('Only project admins can see and manage ingestion tokens.')).toBeVisible();
    await ectx.close();

    // other tenant: the project is invisible
    const gctx = await browser.newContext({ baseURL: env().web });
    const g = await gctx.newPage();
    await login(g, DEMO.globex);
    await g.goto(deepLink);
    await expect(g.getByText('Project not found')).toBeVisible();
    await expect(g.locator('body')).not.toContainText('PROD-ONLY');
    await gctx.close();
  });

  test('keyboard-only investigation: rows are reachable, Enter opens details, Escape closes', async ({ page }) => {
    const name = uniq('E2E Logs Keyboard');
    await login(page, DEMO.owner);
    const p = await createProject(page, name);
    const { token } = await mintToken(page, p.id, p.environments[0]!.id, 'kbd');
    await sendJson(token, Array.from({ length: 5 }, (_, i) => ({ time: iso(1000 + i * 100), level: 'info', msg: `keyboard row ${i}`, service: 'kbd' })));
    await openLogs(page, name);
    await expect.poll(() => rowsIn(page).count()).toBe(5);
    const first = results(page).locator('[data-row="0"]');
    await first.focus();
    await page.keyboard.press('ArrowDown');
    await expect(results(page).locator('[data-row="1"]')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(first).toBeFocused();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('complementary', { name: 'Log details' });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('heading', { name: 'Log details' })).toBeFocused(); // focus moves into the panel
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
  });
});
