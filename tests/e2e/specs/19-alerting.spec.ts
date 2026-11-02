import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { DEMO, env, expect, login, test, apiAs } from '../support/fixtures.js';
import { accessibilityViolations, createProject, grant, noHorizontalScroll, orgMembers, uniq } from '../support/helpers.js';

// The whole alerting path with real processes: logs are sent to the real ingestion service, the real worker evaluates the rule, opens the
// incident and delivers a SIGNED webhook to a receiver this spec runs on loopback (the e2e stack runs with the development network policy;
// in production loopback and plain http are refused: see the API tests). Nothing in this file fakes an API response.

const SECRET = 'e2e-webhook-signing-secret-0123456789';
interface Hit { path: string; headers: http.IncomingHttpHeaders; body: string }
let receiver: http.Server;
let receiverUrl: string;
const hits: Hit[] = [];

interface Ctx { projectId: string; devEnv: string; prodEnv: string; token: string; ruleName: string; channelName: string; incidentId: string; users: Record<string, string> }
let ctx: Ctx;

test.beforeAll(async () => {
  receiver = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { hits.push({ path: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() }); res.writeHead(200); res.end('ok'); });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});
test.afterAll(async () => { receiver.closeAllConnections(); await new Promise((r) => receiver.close(r)); });

async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => { localStorage.setItem('nx-theme', t); document.documentElement.classList.toggle('dark', t === 'dark'); }, theme);
}
async function sendErrors(n: number, tag: string) {
  for (let i = 0; i < n; i++) {
    const r = await fetch(`${env().ingest}/v1/json-logs`, { method: 'POST', headers: { authorization: `Bearer ${ctx.token}`, 'content-type': 'application/json' }, body: JSON.stringify([{ level: 'error', msg: `${tag} failure ${i}`, service: 'checkout', 'http.response.status_code': 503 }]) });
    expect(r.status).toBeLessThan(300);
  }
}
const makeRuleDue = (db: { update(c: string, f: object, u: object): Promise<number> }) =>
  db.update('alert_config', { kind: 'rule', name: ctx.ruleName }, { $set: { nextEvalAt: { $date: new Date(Date.now() - 1000).toISOString() } } });
const verifySignature = (h: Hit) => {
  const sig = String(h.headers['x-nexus-signature']);
  const t = /t=(\d+)/.exec(sig)![1]!, v1 = /v1=([0-9a-f]{64})/.exec(sig)![1]!;
  expect(createHmac('sha256', SECRET).update(`${t}.${h.body}`).digest('hex')).toBe(v1);
  expect(Math.abs(Date.now() / 1000 - Number(t))).toBeLessThan(300);
};

test.describe.serial('alerting: logs -> worker evaluation -> incident -> signed webhook -> UI', () => {
  test('setup: a project, an ingestion token and a webhook channel (created in the UI, tested end to end)', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, DEMO.owner);
    const name = uniq('E2E Alerting');
    const p = await createProject(page, name);
    const devEnv = p.environments.find((e) => !e.isProduction)!.id, prodEnv = p.environments.find((e) => e.isProduction)!.id;
    const minted = await apiAs(page, 'POST', `/api/v1/projects/${p.id}/environments/${devEnv}/ingest-tokens`, { name: 'alerts' });
    expect(minted.status).toBe(201);
    const users = await orgMembers(page);
    await grant(page, p.id, users[DEMO.engineer]!, 'engineer');
    await grant(page, p.id, users[DEMO.viewer]!, 'viewer');
    ctx = { projectId: p.id, devEnv, prodEnv, token: minted.json.token, ruleName: uniq('5xx burst'), channelName: uniq('ops-hook'), incidentId: '', users };

    await page.goto(`/alerts/channels?p=${p.id}`);
    await expect(page.getByRole('heading', { name: 'Channels & silences', exact: true })).toBeVisible();
    await expect(page.getByTestId('channel-form')).toBeVisible();
    await page.getByTestId('channel-name').fill(ctx.channelName);
    await page.getByTestId('channel-url').fill(`${receiverUrl}/hook/secret-path-token-12345`);
    await page.getByTestId('channel-secret').fill(SECRET);
    await page.getByTestId('channel-create').click();
    const row = page.getByTestId(`channel-row-${ctx.channelName}`);
    await expect(row).toBeVisible();
    // the stored URL path and the secret are never displayed
    await expect(row).toContainText(`${receiverUrl}/…`);
    await expect(page.locator('body')).not.toContainText('secret-path-token-12345');
    await expect(page.locator('body')).not.toContainText(SECRET);
    await expect(page.getByTestId('channel-secret')).toHaveValue('');

    await row.getByTestId('channel-test').click();
    await expect(page.getByTestId('channel-message')).toContainText('delivered');
    await expect.poll(() => hits.length).toBeGreaterThanOrEqual(1);
    const t = hits.find((h) => h.headers['x-nexus-event'] === 'test')!;
    expect(t.path).toBe('/hook/secret-path-token-12345'); // the receiver got the real URL...
    verifySignature(t);                                    // ...signed with the secret that the UI never shows again
    expect(JSON.parse(t.body)).toMatchObject({ event: 'test' });
    await expect(row.getByTestId('channel-last-test')).toContainText('ok');
  });

  test('a project admin creates a log-count rule in the UI; logs sent to the real ingestion service open an incident and notify the webhook', async ({ page, db }) => {
    test.setTimeout(180_000);
    await login(page, DEMO.owner);
    await page.goto(`/alerts?p=${ctx.projectId}`);
    await expect(page.getByRole('heading', { name: 'Alert rules', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'No alert rules yet' })).toBeVisible();
    await page.getByTestId('new-rule').click();
    await page.getByTestId('rule-name').fill(ctx.ruleName);
    await page.getByTestId('rule-environment').selectOption({ label: 'Development' });
    await page.getByTestId('rule-severity').selectOption('critical');
    await page.getByTestId('rule-kind-logs').check();
    await page.getByTestId('rule-errors-only').check();
    await page.getByTestId('rule-op').selectOption('gt');
    await page.getByTestId('rule-threshold').fill('2');
    await page.getByTestId('rule-window').fill('5');
    await page.getByTestId('rule-for').fill('0');
    await page.getByTestId('rule-resolve').fill('0');
    await page.getByTestId('rule-interval').selectOption('15');
    await page.getByRole('checkbox', { name: ctx.channelName }).check();
    // an invalid value is refused by the server with a readable message (the form never silently fixes input)
    await page.getByTestId('rule-threshold').fill('-5');
    await page.getByTestId('rule-save').click();
    await expect(page.getByTestId('rule-form-error')).toContainText(/count|threshold|whole number/i);
    await page.getByTestId('rule-threshold').fill('2');
    await page.getByTestId('rule-save').click();
    await expect(page.getByTestId('rules-notice')).toContainText('saved');
    const row = page.getByTestId(`rule-row-${ctx.ruleName}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('count of logs (errors) > 2 over 5 min');
    // the worker evaluates it: zero errors so far is a value (ok), not "no data"
    await expect.poll(async () => (await db.find('alert_config', { kind: 'rule', name: ctx.ruleName }))[0]?.health, { timeout: 30_000, intervals: [500] }).toBe('ok');
    expect(await db.count('incidents', { projectId: ctx.projectId })).toBe(0);

    await sendErrors(5, 'first-burst');
    await expect.poll(async () => db.count('logs', { projectId: ctx.projectId, severity: 'error' }), { timeout: 30_000, intervals: [500] }).toBeGreaterThanOrEqual(5);
    await makeRuleDue(db);
    await expect.poll(async () => db.count('incidents', { projectId: ctx.projectId, status: 'open' }), { timeout: 30_000, intervals: [500] }).toBe(1);
    const inc = (await db.find('incidents', { projectId: ctx.projectId }))[0];
    ctx.incidentId = inc._id;
    expect(inc).toMatchObject({ ruleName: ctx.ruleName, severity: 'critical', environmentId: ctx.devEnv, status: 'open', active: true });
    expect(inc.lastValue).toBeGreaterThanOrEqual(5);

    // the signed notification reaches the receiver
    await expect.poll(() => hits.filter((h) => h.headers['x-nexus-event'] === 'incident.opened').length, { timeout: 30_000, intervals: [500] }).toBe(1);
    const opened = hits.find((h) => h.headers['x-nexus-event'] === 'incident.opened')!;
    verifySignature(opened);
    expect(JSON.parse(opened.body)).toMatchObject({ event: 'incident.opened', incident: { id: ctx.incidentId, severity: 'critical', ruleName: ctx.ruleName, environmentId: ctx.devEnv } });
    expect(opened.body).not.toContain(SECRET);

    // and the rules page shows it firing
    await page.reload();
    await expect(page.getByTestId(`rule-row-${ctx.ruleName}`).getByTestId('rule-state')).toContainText('firing', { timeout: 20_000 });
  });

  test('the incident list and detail show the timeline and the delivery log; acknowledge, comment and resolve work from the UI', async ({ page, db }) => {
    test.setTimeout(120_000);
    await login(page, DEMO.owner);
    await page.goto(`/incidents?p=${ctx.projectId}`);
    await expect(page.getByRole('heading', { name: 'Incidents', exact: true })).toBeVisible();
    const row = page.getByTestId(`incident-row-${ctx.ruleName}`);
    await expect(row).toBeVisible();
    await expect(row.getByTestId('incident-status')).toContainText('open');
    await row.getByRole('link', { name: ctx.ruleName }).click();
    await expect(page.getByTestId('incident-title')).toHaveText(ctx.ruleName);
    await expect(page.getByTestId('timeline-opened')).toBeVisible();
    await expect(page.getByTestId('deliveries-table')).toContainText(ctx.channelName);
    await expect(page.getByTestId('deliveries-table').getByTestId('delivery-status')).toContainText('delivered');
    await expect(page.getByTestId('timeline-notified')).toBeVisible();

    await page.getByTestId('incident-note').fill('looking now');
    await page.getByTestId('incident-ack').click();
    await expect(page.getByTestId('incident-detail-status')).toContainText('acknowledged');
    await expect(page.getByTestId('timeline-acknowledged')).toContainText('looking now');
    await expect(page.getByTestId('timeline-acknowledged')).toContainText('Olivia Owner');
    await expect(page.getByTestId('incident-ack')).toHaveCount(0);

    await page.getByTestId('incident-comment').fill('Suspect the checkout deploy');
    await page.getByTestId('incident-comment-submit').click();
    await expect(page.getByTestId('timeline-comment')).toContainText('Suspect the checkout deploy');

    await page.getByTestId('incident-resolve').click();
    await expect(page.getByTestId('incident-detail-status')).toContainText('resolved');
    await expect(page.getByTestId('timeline-resolved')).toBeVisible();
    await expect(page.getByTestId('incident-resolve')).toHaveCount(0);
    // the audit trail attributes each action
    const audit = (await apiAs(page, 'GET', `/api/v1/audit?projectId=${ctx.projectId}&limit=200`)).json.items.filter((e: { targetId: string }) => e.targetId === ctx.incidentId).map((e: { action: string }) => e.action);
    expect(audit).toEqual(expect.arrayContaining(['incident.opened', 'incident.acknowledged', 'incident.commented', 'incident.resolved']));
    // the recovery notification goes to the channel that heard about the opening
    await expect.poll(() => hits.filter((h) => h.headers['x-nexus-event'] === 'incident.resolved').length, { timeout: 30_000, intervals: [500] }).toBe(1);
    verifySignature(hits.find((h) => h.headers['x-nexus-event'] === 'incident.resolved')!);
    expect(await db.count('incidents', { projectId: ctx.projectId, active: true })).toBe(0);
  });

  test('a silence suppresses the notification but the incident is still recorded', async ({ page, db }) => {
    test.setTimeout(120_000);
    await login(page, DEMO.owner);
    await page.goto(`/alerts/channels?p=${ctx.projectId}`);
    await page.getByTestId('silence-comment').fill('Planned maintenance window');
    await page.getByTestId('silence-create').click();
    await expect(page.getByTestId('silence-row-Planned maintenance window')).toContainText('active');
    const before = hits.filter((h) => h.headers['x-nexus-event'] === 'incident.opened').length;

    await makeRuleDue(db); // errors are still in the window: the rule fires again (the person's manual resolution reset it)
    await expect.poll(async () => db.count('incidents', { projectId: ctx.projectId, status: 'open' }), { timeout: 30_000, intervals: [500] }).toBe(1);
    const second = (await db.find('incidents', { projectId: ctx.projectId, status: 'open' }))[0];
    await expect.poll(async () => (await db.find('alert_deliveries', { incidentId: second._id }))[0]?.status, { timeout: 15_000 }).toBe('suppressed');
    await new Promise((r) => setTimeout(r, 3000)); // give a (wrongly) sent notification time to arrive
    expect(hits.filter((h) => h.headers['x-nexus-event'] === 'incident.opened').length).toBe(before);

    await page.goto(`/incidents/${second._id}?p=${ctx.projectId}`);
    await expect(page.getByTestId('timeline-notification_suppressed')).toContainText('Planned maintenance window');
    await expect(page.getByTestId('deliveries-table').getByTestId('delivery-status')).toContainText('suppressed');
    await expect(page.getByTestId('incident-detail-status')).toContainText('open');
    ctx.incidentId = second._id;
  });

  test('an engineer can acknowledge; a viewer sees everything read-only (no buttons, and the API refuses)', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, DEMO.viewer);
    await page.goto(`/incidents/${ctx.incidentId}?p=${ctx.projectId}`);
    await expect(page.getByTestId('incident-title')).toBeVisible();
    await expect(page.getByTestId('incident-readonly')).toBeVisible();
    await expect(page.getByTestId('incident-ack')).toHaveCount(0);
    await expect(page.getByTestId('incident-resolve')).toHaveCount(0);
    await expect(page.getByTestId('incident-comment')).toHaveCount(0);
    expect((await apiAs(page, 'POST', `/api/v1/projects/${ctx.projectId}/incidents/${ctx.incidentId}/acknowledge`, {})).status).toBe(403);
    await page.goto(`/alerts?p=${ctx.projectId}`);
    await expect(page.getByTestId('rules-readonly')).toBeVisible();
    await expect(page.getByTestId('new-rule')).toHaveCount(0);
    await expect(page.getByTestId('rule-toggle')).toHaveCount(0);
    expect((await apiAs(page, 'POST', `/api/v1/projects/${ctx.projectId}/alert-rules`, { name: 'x' })).status).toBe(400); // validated first...
    expect((await apiAs(page, 'DELETE', `/api/v1/projects/${ctx.projectId}/alert-channels/${crypto.randomUUID()}`)).status).toBe(403); // ...and refused by role
    await page.goto(`/alerts/channels?p=${ctx.projectId}`);
    await expect(page.getByTestId('channels-readonly')).toBeVisible();
    await expect(page.getByTestId('channel-form')).toHaveCount(0);

    // an engineer: can act on the incident but not configure
    await page.getByRole('button', { name: 'Sign out' }).click();
    await login(page, DEMO.engineer);
    await page.goto(`/incidents/${ctx.incidentId}?p=${ctx.projectId}`);
    await page.getByTestId('incident-ack').click();
    await expect(page.getByTestId('incident-detail-status')).toContainText('acknowledged');
    await expect(page.getByTestId('timeline-acknowledged')).toContainText('Erin Engineer');
    await page.goto(`/alerts?p=${ctx.projectId}`);
    await expect(page.getByTestId('new-rule')).toHaveCount(0);
  });

  test('rules can be disabled and re-enabled from the UI; disabling closes live incidents', async ({ page, db }) => {
    test.setTimeout(120_000);
    await login(page, DEMO.owner);
    await page.goto(`/alerts?p=${ctx.projectId}`);
    const row = page.getByTestId(`rule-row-${ctx.ruleName}`);
    await row.getByTestId('rule-toggle').click();
    await expect(page.getByTestId('rules-notice')).toContainText('disabled');
    await expect(row.getByTestId('rule-state')).toContainText('disabled');
    await expect.poll(async () => db.count('incidents', { projectId: ctx.projectId, active: true }), { timeout: 15_000 }).toBe(0);
    expect((await db.find('incidents', { projectId: ctx.projectId, status: 'resolved' })).some((i) => i.resolvedBy?.reason === 'rule_disabled')).toBe(true);
    await row.getByTestId('rule-toggle').click();
    await expect(page.getByTestId('rules-notice')).toContainText('enabled');
  });

  test('another organization cannot see any of it, in the UI or the API', async ({ page }) => {
    await login(page, DEMO.globex);
    await page.goto(`/incidents/${ctx.incidentId}?p=${ctx.projectId}`);
    await expect(page.getByRole('heading', { name: 'Project not found' })).toBeVisible();
    for (const path of [`/alert-rules`, `/alert-channels`, `/alert-silences`, `/incidents`, `/incidents/${ctx.incidentId}`, `/incidents/${ctx.incidentId}/deliveries`]) {
      expect((await apiAs(page, 'GET', `/api/v1/projects/${ctx.projectId}${path}`)).status, path).toBe(404);
    }
    expect((await apiAs(page, 'POST', `/api/v1/projects/${ctx.projectId}/incidents/${ctx.incidentId}/acknowledge`, {})).status).toBe(404);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`accessibility (axe, WCAG 2 A/AA) of every alerting page, ${theme} theme, and no horizontal scroll on a phone`, async ({ page }) => {
      test.setTimeout(150_000);
      await login(page, DEMO.owner);
      await setTheme(page, theme);
      const failures: Record<string, unknown> = {};
      const scan = async (label: string) => { const v = await accessibilityViolations(page); if (v.length) failures[label] = v; };
      await page.goto(`/alerts?p=${ctx.projectId}`);
      await expect(page.getByTestId('rules-table')).toBeVisible(); await scan('rules');
      await page.getByTestId('new-rule').click(); await expect(page.getByTestId('rule-form')).toBeVisible(); await scan('rule form (metric)');
      await page.getByTestId('rule-kind-logs').check(); await scan('rule form (logs)');
      await page.getByRole('button', { name: 'Cancel' }).click();
      await page.goto(`/incidents?p=${ctx.projectId}&status=all`);
      await expect(page.getByTestId('incidents-table')).toBeVisible(); await scan('incident list');
      const link = page.getByTestId('incidents-table').getByRole('link').first();
      await link.click();
      await expect(page.getByTestId('incident-timeline')).toBeVisible(); await scan('incident detail');
      await page.goto(`/alerts/channels?p=${ctx.projectId}`);
      await expect(page.getByTestId('channels-table')).toBeVisible(); await scan('channels and silences');
      expect(failures).toEqual({});
      await page.setViewportSize({ width: 390, height: 800 });
      for (const path of ['/alerts', '/incidents?status=all', '/alerts/channels', `/incidents/${ctx.incidentId}`]) {
        await page.goto(`${path}${path.includes('?') ? '&' : '?'}p=${ctx.projectId}`);
        await expect(page.getByRole('navigation', { name: 'Alerting' })).toBeVisible();
        expect(await noHorizontalScroll(page), `${path} at phone width`).toBe(true);
      }
    });
  }
});
