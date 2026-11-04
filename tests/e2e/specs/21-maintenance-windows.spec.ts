import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from '@playwright/test';
import { DEMO, env, expect, login, test, apiAs } from '../support/fixtures.js';
import { accessibilityViolations, createProject, grant, noHorizontalScroll, orgMembers, uniq } from '../support/helpers.js';

// Recurring maintenance windows and the replay policy, with real processes: windows are created in the UI, the real worker evaluates a rule fed by logs sent to
// the real ingestion service, and the notification that a window suppresses is looked for at a receiver this spec runs on loopback. Nothing fakes an API response.

const SECRET = 'e2e-maintenance-signing-secret-0123456789';
interface Hit { event: string; body: string }
let receiver: http.Server;
let receiverUrl: string;
const hits: Hit[] = [];

interface Ctx { projectId: string; devEnv: string; token: string; channelId: string; channelName: string; ruleId: string; ruleName: string; quietRuleId: string; quietRuleName: string; windowName: string; onceName: string; incidentId: string }
let ctx: Ctx;

test.beforeAll(async () => {
  receiver = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { hits.push({ event: String(req.headers['x-nexus-event']), body: Buffer.concat(chunks).toString() }); res.writeHead(200); res.end('ok'); });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});
test.afterAll(async () => { receiver.closeAllConnections(); await new Promise((r) => receiver.close(r)); });

const pad = (n: number) => String(n).padStart(2, '0');
/** A `datetime-local` value in this machine's local time (the browser under test runs on the same machine). */
const local = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const base = () => `/api/v1/projects/${ctx.projectId}`;
const makeRuleDue = (db: { update(c: string, f: object, u: object): Promise<number> }, id: string) =>
  db.update('alert_config', { _id: id }, { $set: { nextEvalAt: { $date: new Date(Date.now() - 1000).toISOString() } } });
async function sendErrors(n: number, tag: string) {
  for (let i = 0; i < n; i++) {
    const r = await fetch(`${env().ingest}/v1/json-logs`, { method: 'POST', headers: { authorization: `Bearer ${ctx.token}`, 'content-type': 'application/json' }, body: JSON.stringify([{ level: 'error', msg: `${tag} failure ${i}`, service: 'checkout', 'http.response.status_code': 503 }]) });
    expect(r.status).toBeLessThan(300);
  }
}
async function setTheme(page: Page, theme: 'light' | 'dark') {
  await page.evaluate((t) => { localStorage.setItem('nx-theme', t); document.documentElement.classList.toggle('dark', t === 'dark'); }, theme);
}
const openWindowsPage = async (page: Page) => {
  await page.goto(`/alerts/channels?p=${ctx.projectId}`);
  await expect(page.getByTestId('maintenance-card')).toBeVisible();
};
const logRule = (name: string, over: Record<string, unknown> = {}) => ({
  name, severity: 'critical', environmentId: ctx.devEnv, query: { kind: 'logs', errorsOnly: true, services: ['checkout'], filters: [] },
  condition: { op: 'gt', threshold: 2 }, windowSeconds: 300, forSeconds: 0, resolveAfterSeconds: 0, intervalSeconds: 60, noDataPolicy: 'keep', channelIds: [ctx.channelId], ...over,
});

test.describe.serial('maintenance windows: UI, suppression, replay status', () => {
  test('setup: a project, roles, an ingestion token, a webhook channel and two rules', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, DEMO.owner);
    const p = await createProject(page, uniq('E2E Maintenance'));
    const devEnv = p.environments.find((e) => !e.isProduction)!.id;
    const users = await orgMembers(page);
    await grant(page, p.id, users[DEMO.engineer]!, 'engineer');
    await grant(page, p.id, users[DEMO.viewer]!, 'viewer');
    const minted = await apiAs(page, 'POST', `/api/v1/projects/${p.id}/environments/${devEnv}/ingest-tokens`, { name: 'maint' });
    expect(minted.status).toBe(201);
    ctx = { projectId: p.id, devEnv, token: minted.json.token, channelId: '', channelName: uniq('maint-hook'), ruleId: '', ruleName: uniq('burst'), quietRuleId: '', quietRuleName: uniq('quiet'), windowName: uniq('Weekly release'), onceName: uniq('Active now'), incidentId: '' };
    const ch = await apiAs(page, 'POST', `${base()}/alert-channels`, { type: 'webhook', name: ctx.channelName, url: `${receiverUrl}/hook/maintenance-secret-path`, signingSecret: SECRET });
    expect(ch.status, JSON.stringify(ch.json)).toBe(201);
    ctx.channelId = ch.json.id;
    const rule = await apiAs(page, 'POST', `${base()}/alert-rules`, logRule(ctx.ruleName));
    expect(rule.status, JSON.stringify(rule.json)).toBe(201);
    ctx.ruleId = rule.json.id;
    expect(rule.json).toMatchObject({ missedPolicy: 'skip', maxReplayEvaluations: 5, staleNotificationSeconds: 900 });
    // a rule that never matches anything: its numbers show what a replay does without any alert noise
    const quiet = await apiAs(page, 'POST', `${base()}/alert-rules`, logRule(ctx.quietRuleName, { query: { kind: 'logs', text: 'zzz-matches-nothing-zzz', filters: [] }, channelIds: [] }));
    expect(quiet.status).toBe(201);
    ctx.quietRuleId = quiet.json.id;
  });

  test('a project admin creates a recurring window in the UI: plain-language schedule, time zone, next occurrence', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, DEMO.owner);
    await openWindowsPage(page);
    await expect(page.getByTestId('no-maintenance')).toBeVisible();
    await page.getByTestId('maint-new').click();
    await page.getByTestId('maint-name').fill(ctx.windowName);
    await page.getByTestId('maint-comment').fill('Sunday release train');
    await page.getByTestId('maint-start').fill('02:00');
    await page.getByTestId('maint-duration').fill('120');
    await page.getByTestId('maint-timezone').fill('Europe/Berlin');
    await page.getByTestId('maint-day-sat').check();
    await page.getByTestId('maint-save').click();
    const row = page.getByTestId(`maint-row-${ctx.windowName}`);
    await expect(row).toBeVisible();
    await expect(row).toContainText('Sat, Sun at 02:00 (Europe/Berlin) for 2 h');
    await expect(row).toContainText('the whole project');
    await expect(row.getByTestId('maint-state')).toContainText('scheduled');
    await expect(row.getByTestId('maint-next')).toContainText('(Europe/Berlin)');
    await expect(row.getByTestId('maint-next')).toContainText('UTC');
    await expect(page.getByTestId('maint-notice')).toContainText('saved');

    // the API agrees with the page, and the occurrence really is 02:00 local time in Berlin (03:00 on the one night the clocks skip 02:00)
    const list = (await apiAs(page, 'GET', `${base()}/alert-maintenance-windows`)).json.items;
    const w = list.find((x: { name: string }) => x.name === ctx.windowName);
    expect(w).toMatchObject({ state: 'scheduled', activeNow: false, version: 1, schedule: { type: 'weekly', timezone: 'Europe/Berlin', weekdays: ['sat', 'sun'] } });
    const start = new Date(w.nextOccurrence.startsAt);
    expect(start.getTime()).toBeGreaterThan(Date.now());
    const berlin = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).format(start);
    expect(berlin).toMatch(/^(Sat|Sun) (02|03):00$/);
    expect(new Date(w.nextOccurrence.endsAt).getTime() - start.getTime()).toBe(120 * 60_000);
  });

  test('the form refuses an offset or unknown zone before sending; the server refuses a window that already ended', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, DEMO.owner);
    await openWindowsPage(page);
    await page.getByTestId('maint-new').click();
    await page.getByTestId('maint-name').fill(uniq('bad'));
    await page.getByTestId('maint-timezone').fill('+05:30');
    await expect(page.getByTestId('maint-issues')).toContainText('IANA');
    await expect(page.getByTestId('maint-save')).toBeDisabled();
    await page.getByTestId('maint-timezone').fill('Mars/Olympus');
    await expect(page.getByTestId('maint-issues')).toContainText('Unknown time zone');
    await page.getByTestId('maint-timezone').fill('Asia/Kolkata');
    await expect(page.getByTestId('maint-issues')).toHaveCount(0);
    await page.getByTestId('maint-day-sun').uncheck();
    await expect(page.getByTestId('maint-save')).toBeDisabled(); // no day chosen
    await page.getByTestId('maint-type-once').check();
    await page.getByTestId('maint-once-start').fill(local(Date.now() - 2 * 3_600_000));
    await page.getByTestId('maint-once-end').fill(local(Date.now() - 3_600_000));
    await page.getByTestId('maint-save').click();
    await expect(page.getByTestId('maint-error')).toContainText('future');
    await page.getByTestId('maint-cancel').click();
    await expect(page.getByTestId('maint-form')).toHaveCount(0);
  });

  test('a one-off window that is active shows an "active now" badge; it can be edited', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, DEMO.owner);
    await openWindowsPage(page);
    await page.getByTestId('maint-new').click();
    await page.getByTestId('maint-name').fill(ctx.onceName);
    await page.getByTestId('maint-type-once').check();
    await page.getByTestId('maint-once-start').fill(local(Date.now() - 10 * 60_000));
    await page.getByTestId('maint-once-end').fill(local(Date.now() + 90 * 60_000));
    await page.getByTestId('maint-save').click();
    const row = page.getByTestId(`maint-row-${ctx.onceName}`);
    await expect(row.getByTestId('maint-state')).toContainText('active now');
    await expect(row.getByTestId('maint-state')).toContainText('until');
    await expect(row.getByTestId('maint-next')).toHaveText('—');

    await row.getByTestId('maint-edit').click();
    await expect(page.getByTestId('maint-name')).toHaveValue(ctx.onceName);
    await page.getByTestId('maint-comment').fill('Database failover test');
    await page.getByTestId('maint-save').click();
    await expect(row).toContainText('Database failover test');
    const w = (await apiAs(page, 'GET', `${base()}/alert-maintenance-windows`)).json.items.find((x: { name: string }) => x.name === ctx.onceName);
    expect(w).toMatchObject({ state: 'active', activeNow: true, version: 2, comment: 'Database failover test' });
  });

  test('while a window is active the worker still opens the incident, but the notification is suppressed and recorded with the window', async ({ page, db }) => {
    test.setTimeout(180_000);
    await login(page, DEMO.owner);
    // the rule has been evaluated once (no errors yet): wait for that, then send errors
    await expect.poll(async () => (await db.find('alert_config', { _id: ctx.ruleId }))[0]?.health, { timeout: 30_000, intervals: [500] }).toBe('ok');
    await sendErrors(5, 'maintenance-burst');
    await expect.poll(async () => db.count('logs', { projectId: ctx.projectId, severity: 'error' }), { timeout: 30_000, intervals: [500] }).toBeGreaterThanOrEqual(5);
    await makeRuleDue(db, ctx.ruleId);
    await expect.poll(async () => db.count('incidents', { projectId: ctx.projectId, status: 'open' }), { timeout: 30_000, intervals: [500] }).toBe(1);
    const inc = (await db.find('incidents', { projectId: ctx.projectId }))[0];
    ctx.incidentId = inc._id;
    const windows = (await apiAs(page, 'GET', `${base()}/alert-maintenance-windows`)).json.items;
    const active = windows.find((x: { name: string }) => x.name === ctx.onceName);
    await expect.poll(async () => (await db.find('alert_deliveries', { incidentId: inc._id }))[0]?.status, { timeout: 15_000 }).toBe('suppressed');
    expect((await db.find('alert_deliveries', { incidentId: inc._id }))[0]).toMatchObject({ status: 'suppressed', maintenanceId: active.id, silenceId: null, channelName: ctx.channelName });
    await new Promise((r) => setTimeout(r, 3000)); // give a (wrongly) sent notification time to arrive
    expect(hits.filter((h) => h.event === 'incident.opened')).toHaveLength(0);

    await page.goto(`/incidents/${inc._id}?p=${ctx.projectId}`);
    await expect(page.getByTestId('incident-detail-status')).toContainText('open');
    await expect(page.getByTestId('timeline-notification_suppressed')).toContainText(`maintenance window "${ctx.onceName}"`);
    await expect(page.getByTestId('deliveries-table').getByTestId('delivery-status')).toContainText('suppressed');
  });

  test('disabling the window ends the suppression at once: the next incident notifies the channel', async ({ page, db }) => {
    test.setTimeout(180_000);
    await login(page, DEMO.owner);
    await openWindowsPage(page);
    const row = page.getByTestId(`maint-row-${ctx.onceName}`);
    await row.getByTestId('maint-toggle').click();
    await expect(page.getByTestId('maint-notice')).toContainText('disabled');
    await expect(row.getByTestId('maint-state')).toContainText('disabled');
    // resolve the first incident by hand so the still-breaching rule can open a new one
    expect((await apiAs(page, 'POST', `${base()}/incidents/${ctx.incidentId}/resolve`, {})).status).toBe(200);
    await makeRuleDue(db, ctx.ruleId);
    await expect.poll(async () => db.count('incidents', { projectId: ctx.projectId, status: 'open' }), { timeout: 30_000, intervals: [500] }).toBe(1);
    const second = (await db.find('incidents', { projectId: ctx.projectId, status: 'open' }))[0];
    expect(second._id).not.toBe(ctx.incidentId);
    await expect.poll(() => hits.filter((h) => h.event === 'incident.opened').length, { timeout: 30_000, intervals: [500] }).toBe(1);
    expect(JSON.parse(hits.find((h) => h.event === 'incident.opened')!.body)).toMatchObject({ incident: { id: second._id } });
    expect((await db.find('alert_deliveries', { incidentId: second._id }))[0]).toMatchObject({ status: 'delivered', maintenanceId: null });
  });

  test('a window is deleted from the UI and the audit trail has every step', async ({ page }) => {
    test.setTimeout(120_000);
    await login(page, DEMO.owner);
    await openWindowsPage(page);
    page.once('dialog', (d) => void d.accept());
    await page.getByTestId(`maint-row-${ctx.onceName}`).getByTestId('maint-delete').click();
    await expect(page.getByTestId(`maint-row-${ctx.onceName}`)).toHaveCount(0);
    await expect(page.getByTestId('maint-notice')).toContainText('deleted');
    await expect(page.getByTestId(`maint-row-${ctx.windowName}`)).toBeVisible();
    const actions = (await apiAs(page, 'GET', `/api/v1/audit?projectId=${ctx.projectId}&limit=200`)).json.items.map((e: { action: string }) => e.action);
    expect(actions.filter((a: string) => a === 'alert.maintenance.created')).toHaveLength(2);
    expect(actions).toEqual(expect.arrayContaining(['alert.maintenance.updated', 'alert.maintenance.deleted']));
  });

  test('replay policy: set in the rule form; after the worker "missed" checks the rule shows what was replayed and what was skipped', async ({ page, db }) => {
    test.setTimeout(180_000);
    await login(page, DEMO.owner);
    await page.goto(`/alerts?p=${ctx.projectId}`);
    const row = page.getByTestId(`rule-row-${ctx.quietRuleName}`);
    await expect(row).toBeVisible();
    await row.getByTestId('rule-edit').click();
    await expect(page.getByTestId('rule-missed-policy')).toContainText('If checks are missed');
    await expect(page.getByTestId('rule-max-replay')).toBeDisabled(); // skip is the default: the replay settings do not apply
    await page.getByTestId('rule-missed-policy-select').selectOption('replay');
    await page.getByTestId('rule-max-replay').fill('4');
    await page.getByTestId('rule-stale-minutes').fill('10');
    await page.getByTestId('rule-save').click();
    await expect(page.getByTestId('rules-notice')).toContainText('saved');
    expect((await apiAs(page, 'GET', `${base()}/alert-rules/${ctx.quietRuleId}`)).json).toMatchObject({ missedPolicy: 'replay', maxReplayEvaluations: 4, staleNotificationSeconds: 600 });
    // out-of-range values are refused by the server with a readable message
    const bad = await apiAs(page, 'PATCH', `${base()}/alert-rules/${ctx.quietRuleId}`, { maxReplayEvaluations: 21 });
    expect(bad.status).toBe(400);

    // pretend the worker was away for ten minutes: the next claim finds the rule ten minutes overdue
    await expect.poll(async () => (await db.find('alert_config', { _id: ctx.quietRuleId }))[0]?.health, { timeout: 30_000, intervals: [500] }).toBe('ok');
    const before = (await db.find('alert_config', { _id: ctx.quietRuleId }))[0];
    expect(before.missed?.total ?? 0).toBe(0);
    await db.update('alert_config', { _id: ctx.quietRuleId }, { $set: { nextEvalAt: { $date: new Date(Date.now() - 10 * 60_000).toISOString() } } });
    await expect.poll(async () => (await db.find('alert_config', { _id: ctx.quietRuleId }))[0]?.missed?.total ?? 0, { timeout: 30_000, intervals: [500] }).toBeGreaterThanOrEqual(9);
    const dto = (await apiAs(page, 'GET', `${base()}/alert-rules/${ctx.quietRuleId}`)).json;
    expect(dto.missedEvaluations.replayed).toBe(4);                                   // at most N boundaries are re-run
    expect(dto.missedEvaluations.skipped).toBe(dto.missedEvaluations.total - 4);      // the older ones are only counted
    expect(dto.missedEvaluations.lastAt).not.toBeNull();
    expect(dto.health).toBe('ok');
    expect(await db.count('incidents', { ruleId: ctx.quietRuleId })).toBe(0);         // nothing to alert about: replay produced no noise

    await page.reload();
    await expect(page.getByTestId(`rule-row-${ctx.quietRuleName}`).getByTestId('rule-missed')).toContainText('4 replayed');
    await expect(page.getByTestId(`rule-row-${ctx.quietRuleName}`).getByTestId('rule-evaluated')).toContainText('replays missed checks (up to 4)');
    // the rule that keeps the default shows no missed-check note
    await expect(page.getByTestId(`rule-row-${ctx.ruleName}`).getByTestId('rule-missed')).toHaveCount(0);
  });

  test('viewers and engineers see the windows read-only; the API refuses them; another organization sees nothing', async ({ page }) => {
    test.setTimeout(120_000);
    for (const who of [DEMO.viewer, DEMO.engineer]) {
      await login(page, who);
      await openWindowsPage(page);
      await expect(page.getByTestId('maintenance-table')).toBeVisible();
      await expect(page.getByTestId('maint-new')).toHaveCount(0);
      await expect(page.getByTestId('maint-edit')).toHaveCount(0);
      await expect(page.getByTestId('maint-delete')).toHaveCount(0);
      const id = (await apiAs(page, 'GET', `${base()}/alert-maintenance-windows`)).json.items[0].id;
      const valid = { name: uniq('x'), schedule: { type: 'weekly', timezone: 'UTC', weekdays: ['mon'], startTime: '01:00', durationMinutes: 30 } };
      expect((await apiAs(page, 'POST', `${base()}/alert-maintenance-windows`, valid)).status).toBe(403);
      expect((await apiAs(page, 'PATCH', `${base()}/alert-maintenance-windows/${id}`, { comment: 'x' })).status).toBe(403);
      expect((await apiAs(page, 'DELETE', `${base()}/alert-maintenance-windows/${id}`)).status).toBe(403);
      await page.getByRole('button', { name: 'Sign out' }).click();
    }
    await login(page, DEMO.globex);
    for (const path of ['/alert-maintenance-windows']) expect((await apiAs(page, 'GET', `${base()}${path}`)).status).toBe(404);
    expect((await apiAs(page, 'POST', `${base()}/alert-maintenance-windows`, { name: 'x', schedule: { type: 'weekly', timezone: 'UTC', weekdays: ['mon'], startTime: '01:00', durationMinutes: 30 } })).status).toBe(404);
  });

  for (const theme of ['light', 'dark'] as const) {
    test(`accessibility (axe, WCAG 2 A/AA) with the window form open, ${theme} theme, and no horizontal scroll on a phone`, async ({ page }) => {
      test.setTimeout(150_000);
      await login(page, DEMO.owner);
      await setTheme(page, theme);
      await openWindowsPage(page);
      await expect(page.getByTestId('maintenance-table')).toBeVisible();
      const failures: Record<string, unknown> = {};
      const scan = async (label: string) => { const v = await accessibilityViolations(page); if (v.length) failures[label] = v; };
      await scan('list');
      await page.getByTestId('maint-new').click();
      await expect(page.getByTestId('maint-form')).toBeVisible();
      await scan('weekly form');
      await page.getByTestId('maint-type-once').check();
      await scan('one-off form');
      expect(failures).toEqual({});
      await page.setViewportSize({ width: 390, height: 800 });
      await page.goto(`/alerts/channels?p=${ctx.projectId}`);
      await expect(page.getByTestId('maintenance-card')).toBeVisible();
      await page.getByTestId('maint-new').click();
      expect(await noHorizontalScroll(page), 'maintenance form at phone width').toBe(true);
      await page.getByTestId('maint-cancel').click();
      expect(await noHorizontalScroll(page), 'maintenance list at phone width').toBe(true);
    });
  }
});
