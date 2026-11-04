import type { Page } from '@playwright/test';
import { DEMO, env, expect, login, test, apiAs } from '../support/fixtures.js';
import { accessibilityViolations, createProject, grant, noHorizontalScroll, orgMembers, uniq } from '../support/helpers.js';

// Deployments (ADR-0011) with real processes: CI-style requests with an ingestion token go through the web origin's /api proxy to the real API,
// real metrics and logs go to the real ingestion service, the real worker opens an incident, and the real UI shows what was stored.
// Nothing here fakes an API response.

const STAMP = Date.now().toString(36);
const SVC = `e2e-checkout-${STAMP}`;
const HOSTILE_SVC = `xss-${STAMP} <img src=x onerror="window.__xss=1">`;
const HOSTILE_NOTES = `<script>window.__xss=2</script> **bold** [click](javascript:alert(1)) password=hunter2hunter2`;
const min = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

interface Ctx { projectId: string; devEnv: string; prodEnv: string; deployToken: string; devDeployToken: string; telemetryToken: string; ruleName: string; incidentId: string; ids: Record<string, string> }
let ctx: Ctx;

/** What a CI job does: one HTTPS request with a bearer token, through the same origin the browser uses. */
async function ci(token: string, body: unknown, headers: Record<string, string> = {}) {
  const r = await fetch(`${env().web}/api/v1/deployments`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: r.status, json: (await r.json().catch(() => null)) as any };
}
const nsOf = (ms: number) => String(BigInt(ms) * 1_000_000n);
const histogramBody = (service: string) => ({
  resourceMetrics: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
    scopeMetrics: [{ metrics: [{
      name: 'http.server.request.duration', unit: 's',
      histogram: {
        aggregationTemporality: 1,
        // one point every 2 minutes over the last 50 minutes: the charts have a real time axis to draw markers on
        dataPoints: Array.from({ length: 25 }, (_, i) => ({
          timeUnixNano: nsOf(Date.now() - (49 - i * 2) * 60_000), count: '10', sum: 2.5, bucketCounts: ['2', '6', '2'], explicitBounds: [0.1, 0.5],
          attributes: [{ key: 'http.route', value: { stringValue: '/cart' } }, { key: 'http.response.status_code', value: { intValue: i % 6 === 0 ? 500 : 200 } }],
        })),
      },
    }] }],
  }],
});
async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => { localStorage.setItem('nx-theme', t); document.documentElement.classList.toggle('dark', t === 'dark'); }, theme);
}

test.describe.serial('deployments: CI writes with a token, the UI shows markers, incidents show context', () => {
  test('setup: a project, deployment and telemetry tokens, metrics and roles', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, DEMO.owner);
    const p = await createProject(page, uniq('E2E Deployments'));
    const devEnv = p.environments.find((e) => !e.isProduction)!.id, prodEnv = p.environments.find((e) => e.isProduction)!.id;
    const mint = async (envId: string, name: string, signals: string[]) => {
      const r = await apiAs(page, 'POST', `/api/v1/projects/${p.id}/environments/${envId}/ingest-tokens`, { name, signals });
      expect(r.status, JSON.stringify(r.json)).toBe(201);
      return r.json.token as string;
    };
    const deployToken = await mint(prodEnv, 'ci-prod', ['deployments']);
    const devDeployToken = await mint(devEnv, 'ci-dev', ['deployments']);
    const telemetryToken = await mint(prodEnv, 'telemetry', ['logs', 'metrics']);
    const users = await orgMembers(page);
    await grant(page, p.id, users[DEMO.engineer]!, 'engineer', [devEnv]); // an engineer restricted to Development
    await grant(page, p.id, users[DEMO.viewer]!, 'viewer');
    ctx = { projectId: p.id, devEnv, prodEnv, deployToken, devDeployToken, telemetryToken, ruleName: uniq('checkout errors'), incidentId: '', ids: {} };

    const m = await fetch(`${env().ingest}/v1/metrics`, { method: 'POST', headers: { authorization: `Bearer ${telemetryToken}`, 'content-type': 'application/json' }, body: JSON.stringify(histogramBody(SVC)) });
    expect(m.status).toBeLessThan(300);
    expect(await (await fetch(`${env().ingest}/v1/metrics`, { method: 'POST', headers: { authorization: `Bearer ${deployToken}`, 'content-type': 'application/json' }, body: '{}' })).status).toBe(403); // a deployments token sends no telemetry
  });

  test('the placeholder is gone: an empty project explains what to do, with copy-ready CI snippets that carry no secret', async ({ page }) => {
    await login(page, DEMO.owner);
    await page.goto(`/deployments?p=${ctx.projectId}`);
    await expect(page.getByRole('heading', { name: 'Deployments', exact: true })).toBeVisible();
    await expect(page.getByText('Not implemented yet')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'No deployments recorded yet' })).toBeVisible();
    // the nav entry no longer carries the "planned" badge
    await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link', { name: 'Deployments' })).not.toContainText('P6');
    const snippets = page.getByTestId('ci-snippets');
    await expect(snippets).toBeVisible();
    const curl = page.getByTestId('snippet-curl');
    await expect(curl).toContainText(`${new URL(page.url()).origin}/api/v1/deployments`);
    await expect(curl).toContainText('Authorization: Bearer $NEXUS_DEPLOY_TOKEN');
    await expect(page.getByTestId('snippet-github-actions-step')).toContainText('secrets.NEXUS_DEPLOY_TOKEN');
    await expect(page.locator('body')).not.toContainText(ctx.deployToken);
    await expect(page.getByTestId('snippet-curl')).not.toContainText(/nxi_[A-Za-z0-9_-]{20,}/);
    await expect(page.getByTestId('filter-service')).toBeVisible();
  });

  test('CI records deployments over HTTP: started then succeeded with one key is one record; replays and bad input behave', async () => {
    const key = `run-${STAMP}-1`;
    const started = await ci(ctx.deployToken, { service: SVC, version: '2.0.0', commitSha: '9fe8544abc', status: 'started', startedAt: min(21), idempotencyKey: key, triggeredBy: 'github-actions', linkUrl: 'https://ci.example.com/runs/1' });
    expect([started.status, started.json.outcome]).toEqual([201, 'created']);
    ctx.ids.v2 = started.json.deployment.id;
    const done = await ci(ctx.deployToken, { service: SVC, version: '2.0.0', status: 'succeeded', finishedAt: min(19), notes: 'Blue/green switch done', idempotencyKey: key });
    expect([done.status, done.json.outcome, done.json.deployment.id]).toEqual([200, 'updated', ctx.ids.v2]);
    expect((await ci(ctx.deployToken, { service: SVC, version: '2.0.0', status: 'succeeded', idempotencyKey: key })).json.outcome).toBe('unchanged');

    const failed = await ci(ctx.deployToken, { service: SVC, version: '2.1.0', status: 'failed', startedAt: min(9), finishedAt: min(8), notes: 'health check timed out', idempotencyKey: `run-${STAMP}-2` });
    expect(failed.status).toBe(201);
    ctx.ids.v21 = failed.json.deployment.id;
    const rolled = await ci(ctx.deployToken, { service: SVC, version: '2.1.0', status: 'rolled_back', idempotencyKey: `run-${STAMP}-2` });
    expect([rolled.status, rolled.json.deployment.status]).toEqual([200, 'rolled_back']);
    const dev = await ci(ctx.devDeployToken, { service: SVC, version: '2.0.0-dev', status: 'succeeded', startedAt: min(15), finishedAt: min(14) });
    expect(dev.status).toBe(201);
    ctx.ids.dev = dev.json.deployment.id;

    // refused: scheme, tenant fields in the payload, missing token, a telemetry token
    expect((await ci(ctx.deployToken, { service: SVC, version: 'x', status: 'succeeded', linkUrl: 'javascript:alert(1)' })).status).toBe(400);
    expect((await ci(ctx.deployToken, { service: SVC, version: 'x', status: 'succeeded', environmentId: ctx.devEnv })).json.error.code).toBe('scope_in_payload');
    expect((await ci('nxi_' + 'z'.repeat(43), { service: SVC, version: 'x', status: 'succeeded' })).status).toBe(401);
    expect((await ci(ctx.telemetryToken, { service: SVC, version: 'x', status: 'succeeded' })).status).toBe(403);

    // hostile text is accepted as text
    const hostile = await ci(ctx.deployToken, { service: HOSTILE_SVC, version: '"><svg onload=window.__xss=3>', status: 'succeeded', startedAt: min(30), finishedAt: min(29), notes: HOSTILE_NOTES, triggeredBy: '<b>mallory</b>', linkUrl: 'https://ci.example.com/hostile' });
    expect(hostile.status).toBe(201);
    ctx.ids.hostile = hostile.json.deployment.id;
    expect(hostile.json.deployment.notes).not.toContain('hunter2hunter2'); // credential-shaped text is scrubbed before storage
  });

  test('the Deployments page lists them, filters by service, status and time, and opens a details drawer; hostile text is shown as text', async ({ page }) => {
    await login(page, DEMO.owner);
    await page.goto(`/deployments?p=${ctx.projectId}`);
    const table = page.getByTestId('deployments-table');
    await expect(table).toBeVisible();
    await expect(page.getByTestId('deployment-row')).toHaveCount(4);
    await expect(table).toContainText('2.1.0');
    await expect(table).toContainText('↺ rolled back');
    await expect(table).toContainText('ingestion token “ci-prod”');
    await expect(page.getByText('No deployments recorded yet')).toHaveCount(0);

    // filters are URL-synced and shareable
    await page.getByTestId('filter-status').selectOption('rolled_back');
    await expect(page).toHaveURL(/status=rolled_back/);
    await expect(page.getByTestId('deployment-row')).toHaveCount(1);
    await page.getByTestId('filter-status').selectOption('');
    await page.getByTestId('filter-env').selectOption({ label: 'Development' });
    await expect(page.getByTestId('deployment-row')).toHaveCount(1);
    await expect(table).toContainText('2.0.0-dev');
    await page.getByTestId('filter-env').selectOption('');
    await page.getByTestId('filter-service').fill(SVC);
    await page.getByTestId('filter-service').press('Enter');
    await expect(page).toHaveURL(new RegExp(`svc=${SVC}`));
    await expect(page.getByTestId('deployment-row')).toHaveCount(3);
    await page.getByTestId('filter-range').selectOption('24h');
    await expect(page.getByTestId('deployment-row')).toHaveCount(3);
    await page.getByTestId('filter-service').fill('no-such-service');
    await page.getByTestId('filter-service').press('Enter');
    await expect(page.getByRole('heading', { name: 'No deployments match these filters' })).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).first().click();
    await expect(page.getByTestId('deployment-row')).toHaveCount(4);

    // the drawer: keyboard reachable, shows the facts, closes with Escape
    await page.getByRole('button', { name: `Open details of ${SVC} 2.0.0`, exact: true }).first().focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByTestId('deployment-drawer');
    await expect(drawer).toBeVisible();
    await expect(page).toHaveURL(/id=/);
    await expect(drawer).toContainText(SVC);
    await expect(drawer).toContainText('Blue/green switch done');
    await expect(drawer).toContainText('9fe8544abc');
    await expect(drawer).toContainText('github-actions');
    await expect(drawer).toContainText('ingestion token “ci-prod”');
    const link = drawer.getByTestId('deployment-link');
    await expect(link).toHaveAttribute('href', 'https://ci.example.com/runs/1');
    await expect(link).toHaveAttribute('rel', /noopener/);
    await expect(link).toHaveAttribute('target', '_blank');
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);

    // deep link by id; hostile text: rendered literally, never executed or parsed
    await page.goto(`/deployments?p=${ctx.projectId}&id=${ctx.ids.hostile}`);
    const d2 = page.getByTestId('deployment-drawer');
    await expect(d2).toContainText('<img src=x onerror="window.__xss=1">');
    await expect(d2.getByTestId('deployment-notes')).toContainText('<script>window.__xss=2</script> **bold** [click](javascript:alert(1))');
    await expect(d2.getByTestId('deployment-notes')).not.toContainText('hunter2hunter2');
    await expect(d2).toContainText('<b>mallory</b>');
    await expect(page.locator('main img, aside img, aside script, aside b')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    // a link-looking value inside the notes is not a link
    await expect(d2.getByTestId('deployment-notes').locator('a')).toHaveCount(0);
    await page.getByRole('button', { name: 'Close deployment details' }).click();
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    await expect(page.getByTestId('deployments-table')).toContainText('<img src=x onerror="window.__xss=1">'); // the list shows it as text too
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  });

  test('change markers on the Metrics explorer: vertical, keyboard focusable, with a tooltip and a text list; Enter opens the deployment', async ({ page }) => {
    await login(page, DEMO.owner);
    await page.goto(`/metrics?p=${ctx.projectId}&metric=http.server.request.duration&agg=p95&svc=${SVC}&range=1h`);
    await expect(page.getByTestId('metric-summary')).toBeVisible();
    const markers = page.getByTestId('chart-marker');
    // production: 2.0.0 succeeded, 2.1.0 rolled back; development: 2.0.0-dev (the owner may read both environments)
    await expect(markers).toHaveCount(3);
    const list = page.getByTestId('chart-deployments');
    await expect(list).toContainText(`${SVC} 2.0.0 — succeeded`);
    await expect(list).toContainText(`${SVC} 2.1.0 — rolled back`);
    await expect(list).toContainText('(Production)');
    await expect(list).toContainText('(Development)');
    await expect(list).toContainText('does not show that the change caused anything');
    await expect(page.locator('body')).not.toContainText(HOSTILE_SVC); // another service's marker is not drawn on this service's chart
    // status is not conveyed by colour alone
    await expect(markers.first()).toHaveAttribute('data-marker-status', /^(succeeded|rolled_back)$/);
    await expect(list.locator('li').first()).toContainText(/[✓✕↺▶]/);

    // keyboard: tab onto a marker, read its tooltip, activate it
    const rolled = page.getByRole('button', { name: new RegExp(`Deployment: ${SVC} 2\\.1\\.0 — rolled back`) });
    await rolled.focus();
    await expect(rolled).toBeFocused();
    await expect(page.getByTestId('marker-tooltip')).toContainText(`${SVC} 2.1.0 — rolled back`);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('marker-tooltip')).toHaveCount(0);
    await rolled.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/deployments\\?p=${ctx.projectId}&id=${ctx.ids.v21}`));
    await expect(page.getByTestId('deployment-drawer')).toContainText('health check timed out');
  });

  test('change markers on the service dashboard, per environment, and a failing marker request does not break the chart', async ({ page }) => {
    await login(page, DEMO.owner);
    await page.goto(`/services/${SVC}?p=${ctx.projectId}&minutes=60`);
    const health = page.getByTestId('service-health').first();
    await expect(health).toBeVisible();
    await expect(page.getByTestId('chart-marker').first()).toBeVisible();
    // Telemetry exists only in Production, so there is one section; it marks Production's 2.0.0 and 2.1.0 and not Development's 2.0.0-dev (markers are filtered per environment)
    await expect(page.getByTestId('service-health')).toHaveCount(1);
    await expect(page.getByTestId('chart-marker')).toHaveCount(4); // two charts (requests/errors and, for metrics sources, latency) share the same two markers
    const text = (await health.textContent()) ?? '';
    expect(text).toContain(`${SVC} 2.1.0 — rolled back`);
    expect(text).toContain(`${SVC} 2.0.0 — succeeded`);
    expect(text).not.toContain('2.0.0-dev');

    // the markers request fails: the page and its charts are still complete, and it says so
    await page.route('**/deployments/markers**', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"code":"internal_error","message":"x","requestId":"r"}}' }));
    await page.reload();
    await expect(page.getByTestId('service-health').first()).toBeVisible();
    await expect(page.getByTestId('markers-unavailable').first()).toBeVisible();
    await expect(page.getByTestId('chart-marker')).toHaveCount(0);
    await expect(page.getByRole('img', { name: /Requests and errors per window/ }).first()).toBeVisible();
    await page.unroute('**/deployments/markers**');
  });

  test('an incident of that service lists the deployments from the 30 minutes before it opened, worded as correlation', async ({ page, db }) => {
    test.setTimeout(150_000);
    await login(page, DEMO.owner);
    const rule = await apiAs(page, 'POST', `/api/v1/projects/${ctx.projectId}/alert-rules`, {
      name: ctx.ruleName, severity: 'critical', environmentId: ctx.prodEnv, query: { kind: 'logs', filters: [], errorsOnly: true, services: [SVC] },
      condition: { op: 'gt', threshold: 2 }, windowSeconds: 300, forSeconds: 0, resolveAfterSeconds: 0, intervalSeconds: 15,
    });
    expect(rule.status, JSON.stringify(rule.json)).toBe(201);
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${env().ingest}/v1/json-logs`, { method: 'POST', headers: { authorization: `Bearer ${ctx.telemetryToken}`, 'content-type': 'application/json' }, body: JSON.stringify([{ level: 'error', msg: `checkout failure ${i}`, service: SVC }]) });
      expect(r.status).toBeLessThan(300);
    }
    await expect.poll(async () => db.count('logs', { projectId: ctx.projectId, severity: 'error' }), { timeout: 30_000, intervals: [500] }).toBeGreaterThanOrEqual(5);
    await db.update('alert_config', { kind: 'rule', name: ctx.ruleName }, { $set: { nextEvalAt: { $date: new Date(Date.now() - 1000).toISOString() } } });
    await expect.poll(async () => db.count('incidents', { projectId: ctx.projectId, status: 'open' }), { timeout: 60_000, intervals: [500] }).toBe(1);
    ctx.incidentId = (await db.find('incidents', { projectId: ctx.projectId }))[0]._id;

    await page.goto(`/incidents/${ctx.incidentId}?p=${ctx.projectId}`);
    const timeline = page.getByTestId('incident-timeline');
    await expect(timeline).toBeVisible();
    const events = timeline.getByTestId('timeline-deployment');
    // Production deployments of the service in the last 30 minutes: 2.0.0 (21 min ago, finished 19) and 2.1.0 (9 min ago). Not the 30-minute-old hostile one's service, not Development.
    await expect(events).toHaveCount(2);
    await expect(events.first()).toContainText('2.0.0');
    await expect(events.last()).toContainText('2.1.0');
    await expect(events.last()).toContainText('rolled back');
    await expect(events.last()).toContainText('min before the incident opened');
    for (const n of await timeline.getByTestId('timeline-deployment-note').allTextContents()) expect(n).toContain('Deployed shortly before; correlation, not proof of cause.');
    await expect(timeline).not.toContainText('2.0.0-dev');
    await expect(timeline).not.toContainText(/caused by|root cause/i);
    await events.last().getByRole('link', { name: 'Deployment details' }).click();
    await expect(page.getByTestId('deployment-drawer')).toContainText('2.1.0');
  });

  test('RBAC: a viewer reads everything and sees no recording controls; an environment-restricted engineer sees only their environment, everywhere', async ({ page }) => {
    await login(page, DEMO.viewer);
    await page.goto(`/deployments?p=${ctx.projectId}`);
    await expect(page.getByTestId('deployment-row')).toHaveCount(4);
    await expect(page.getByTestId('ci-snippets')).toContainText('Project admins create tokens.');
    // the API agrees: no write with a session, read is fine
    const w = await apiAs(page, 'POST', '/api/v1/deployments', { service: SVC, version: 'v', status: 'succeeded', projectId: ctx.projectId, environmentId: ctx.prodEnv });
    expect(w.status).toBe(403);
    await page.getByRole('button', { name: 'Sign out' }).click();

    await login(page, DEMO.engineer); // restricted to Development
    await page.goto(`/deployments?p=${ctx.projectId}`);
    await expect(page.getByTestId('deployment-row')).toHaveCount(1);
    await expect(page.getByTestId('deployments-table')).toContainText('2.0.0-dev');
    await expect(page.getByTestId('deployments-table')).not.toContainText('2.1.0');
    expect((await apiAs(page, 'GET', `/api/v1/projects/${ctx.projectId}/deployments/${ctx.ids.v21}`)).status).toBe(404);
    expect((await apiAs(page, 'GET', `/api/v1/projects/${ctx.projectId}/deployments?environmentId=${ctx.prodEnv}`)).json.items).toEqual([]);
    const m = await apiAs(page, 'GET', `/api/v1/projects/${ctx.projectId}/deployments/markers?from=${encodeURIComponent(min(120))}&to=${encodeURIComponent(new Date().toISOString())}`);
    expect(m.json.items.map((x: { version: string }) => x.version)).toEqual(['2.0.0-dev']);
    expect((await apiAs(page, 'GET', `/api/v1/projects/${ctx.projectId}/incidents/${ctx.incidentId}/deployments`)).status).toBe(404); // the incident is in Production
    const own = await apiAs(page, 'POST', '/api/v1/deployments', { service: SVC, version: 'by-engineer', status: 'succeeded', projectId: ctx.projectId, environmentId: ctx.devEnv });
    expect([own.status, own.json.deployment.actor.type]).toEqual([201, 'user']);
    expect((await apiAs(page, 'POST', '/api/v1/deployments', { service: SVC, version: 'nope', status: 'succeeded', projectId: ctx.projectId, environmentId: ctx.prodEnv })).status).toBe(404);
  });

  test('another organization cannot see them', async ({ page }) => {
    await login(page, DEMO.globex);
    expect((await apiAs(page, 'GET', `/api/v1/projects/${ctx.projectId}/deployments`)).status).toBe(404);
    expect((await apiAs(page, 'GET', `/api/v1/projects/${ctx.projectId}/deployments/${ctx.ids.v2}`)).status).toBe(404);
    await page.goto(`/deployments?p=${ctx.projectId}`);
    await expect(page.getByText('Project not found')).toBeVisible();
  });

  test('the ingestion page offers the deployments scope, off by default', async ({ page }) => {
    await login(page, DEMO.owner);
    await page.goto(`/deployments?p=${ctx.projectId}`); // adopts (and remembers) the project from the link
    await expect(page.getByRole('heading', { name: 'Deployments', exact: true })).toBeVisible();
    await page.goto('/sources?tab=ingestion');
    const box = page.getByRole('checkbox', { name: 'deployments' });
    await expect(box).toBeVisible();
    await expect(box).not.toBeChecked();
    await expect(page.getByRole('checkbox', { name: 'logs' })).toBeChecked();
  });

  test('accessibility (WCAG A/AA) in both themes, with the drawer and with chart markers; no horizontal scroll on a phone', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, DEMO.owner);
    for (const theme of ['light', 'dark'] as const) {
      await page.goto(`/deployments?p=${ctx.projectId}&id=${ctx.ids.v2}`);
      await setTheme(page, theme);
      await expect(page.getByTestId('deployment-drawer')).toContainText('Blue/green switch done');
      expect(await accessibilityViolations(page), `deployments ${theme}`).toEqual([]);
      await page.goto(`/metrics?p=${ctx.projectId}&metric=http.server.request.duration&agg=p95&svc=${SVC}&range=1h`);
      await setTheme(page, theme);
      await expect(page.getByTestId('chart-marker').first()).toBeVisible();
      expect(await accessibilityViolations(page), `metrics with markers ${theme}`).toEqual([]);
      await page.goto(`/incidents/${ctx.incidentId}?p=${ctx.projectId}`);
      await setTheme(page, theme);
      await expect(page.getByTestId('timeline-deployment').first()).toBeVisible();
      expect(await accessibilityViolations(page), `incident ${theme}`).toEqual([]);
    }
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto(`/deployments?p=${ctx.projectId}`);
    await expect(page.getByTestId('deployments-table')).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
    await page.goto(`/metrics?p=${ctx.projectId}&metric=http.server.request.duration&agg=p95&svc=${SVC}&range=1h`);
    await expect(page.getByTestId('chart-marker').first()).toBeVisible();
    expect(await noHorizontalScroll(page)).toBe(true);
  });
});
