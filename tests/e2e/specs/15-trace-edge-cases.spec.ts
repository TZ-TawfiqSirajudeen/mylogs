import type { Page } from '@playwright/test';
import { DEMO, env, expect, login, test, apiAs } from '../support/fixtures.js';
import { accessibilityViolations, createProject, uniq } from '../support/helpers.js';

// Real traces are messy. These tests send crafted OTLP through the REAL ingestion endpoint and check what the UI says about each kind of mess.

const NOW = Date.now();
const nsOf = (ms: number, frac = 0) => String(BigInt(Math.round(ms)) * 1_000_000n + BigInt(frac));
const tid = (n: number) => `${n.toString(16).padStart(8, '0')}${'ab'.repeat(12)}`;
const sid = (n: number) => n.toString(16).padStart(16, '0');
interface S { id: number; parent?: number | null; name: string; startMs: number; durMs: number | null; status?: 'error'; service?: string; kind?: number; parentRaw?: string }

let projectId = '';
let token = '';

function body(trace: number, spans: S[]) {
  const bySvc = new Map<string, S[]>();
  for (const s of spans) bySvc.set(s.service ?? 'svc-edge', [...(bySvc.get(s.service ?? 'svc-edge') ?? []), s]);
  return {
    resourceSpans: [...bySvc].map(([service, list]) => ({
      resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] },
      scopeSpans: [{ spans: list.map((s) => ({
        traceId: tid(trace), spanId: sid(s.id), ...(s.parent ? { parentSpanId: sid(s.parent) } : {}), ...(s.parentRaw ? { parentSpanId: s.parentRaw } : {}), name: s.name, kind: s.kind ?? 1,
        startTimeUnixNano: nsOf(NOW - 60_000 + s.startMs, 123), ...(s.durMs !== null ? { endTimeUnixNano: nsOf(NOW - 60_000 + s.startMs + s.durMs, 456) } : {}),
        ...(s.status ? { status: { code: 2, message: 'boom' } } : {}),
      })) }],
    })),
  };
}
async function send(trace: number, spans: S[]) {
  const r = await fetch(`${env().ingest}/v1/traces`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body(trace, spans)) });
  expect(r.status, await r.clone().text()).toBe(200);
}
async function open(page: Page, trace: number) {
  await page.goto(`/traces/${tid(trace)}?p=${projectId}`);
  await expect(page.getByTestId('trace-header')).toBeVisible();
}

test.describe.serial('trace edge cases through the real ingestion endpoint', () => {
  test('setup', async ({ page }) => {
    await login(page, DEMO.owner);
    const p = await createProject(page, uniq('E2E Trace Edge'));
    projectId = p.id;
    const t = await apiAs(page, 'POST', `/api/v1/projects/${p.id}/environments/${p.environments[0]!.id}/ingest-tokens`, { name: 'edge' });
    expect(t.status).toBe(201);
    token = t.json.token;
  });

  test('a partial trace (a child whose parent never arrived) is flagged, never given an invented root; a late root repairs it; duplicates change nothing', async ({ page }) => {
    await send(1, [{ id: 2, parent: 1, name: 'db.query', startMs: 50, durMs: 20, service: 'backend' }, { id: 3, parent: 2, name: 'cache.get', startMs: 55, durMs: 5, service: 'backend' }]);
    await login(page, DEMO.owner);
    await open(page, 1);
    const warn = page.getByTestId('completeness-warning');
    await expect(warn).toContainText('This trace may be incomplete');
    await expect(warn).toContainText('No root span has been received');
    await expect(warn).toContainText('parent span that has not been received');
    await expect(page.getByTestId('trace-header')).toContainText('root span not received');
    await expect(page.getByRole('treeitem', { name: /db\.query.*parent not received/ })).toBeVisible();
    await expect(page.getByRole('treeitem')).toHaveCount(2);

    await page.goto(`/traces?p=${projectId}&range=1h&trace=${tid(1)}`);
    await expect(page.getByTestId('trace-row')).toContainText('partial');
    expect(await accessibilityViolations(page)).toEqual([]);

    // the root arrives late (and the same span is delivered twice): the picture is repaired, nothing is double counted
    await send(1, [{ id: 1, name: 'GET /checkout', startMs: 0, durMs: 120, service: 'gateway', kind: 2 }]);
    await send(1, [{ id: 1, name: 'GET /checkout', startMs: 0, durMs: 120, service: 'gateway', kind: 2 }]);
    await open(page, 1);
    await expect(page.getByTestId('completeness-warning')).toHaveCount(0);
    await expect(page.getByTestId('trace-header')).toContainText('GET /checkout');
    await expect(page.getByRole('treeitem')).toHaveCount(3);
    await expect(page.getByTestId('trace-header').locator('div', { hasText: /^Spans/ }).first()).toContainText('3');
    await page.goto(`/traces?p=${projectId}&range=1h&trace=${tid(1)}`);
    await expect(page.getByTestId('trace-row')).not.toContainText('partial');
  });

  test('missing end times and clock skew are reported plainly; positions are shown exactly as reported', async ({ page }) => {
    await send(2, [
      { id: 1, name: 'root', startMs: 100, durMs: 80, service: 'gateway', kind: 2 },
      { id: 2, parent: 1, name: 'never-finished', startMs: 120, durMs: null, service: 'worker' },
      { id: 3, parent: 1, name: 'skewed-child', startMs: 40, durMs: 10, service: 'worker' },   // starts BEFORE its parent: two hosts' clocks disagree
    ]);
    await login(page, DEMO.owner);
    await open(page, 2);
    const warn = page.getByTestId('completeness-warning');
    await expect(warn).toContainText('no valid end time');
    await expect(warn).toContainText(/before (its|their) parent/);
    await expect(warn).toContainText('Nothing has been estimated');
    await expect(page.getByRole('treeitem', { name: /never-finished.*duration unknown/ })).toBeVisible();
    await expect(page.getByRole('treeitem', { name: /skewed-child.*starts before its parent/ })).toBeVisible();
    await page.getByRole('treeitem', { name: /never-finished/ }).click();
    await expect(page.getByTestId('span-details')).toContainText('no valid end time was reported');
    // the trace is exactly as long as the VALID spans say (skewed child starts 60 ms before the root; root ends 80 ms after it starts)
    await expect(page.getByTestId('trace-header')).toContainText('140 ms');
  });

  test('overlapping siblings overlap on the axis; nothing is drawn sequentially by assumption', async ({ page }) => {
    await send(3, [
      { id: 1, name: 'parent', startMs: 0, durMs: 100, service: 'gateway', kind: 2 },
      { id: 2, parent: 1, name: 'sib-a', startMs: 10, durMs: 60, service: 'gateway' },
      { id: 3, parent: 1, name: 'sib-b', startMs: 30, durMs: 60, service: 'gateway' },
    ]);
    await login(page, DEMO.owner);
    await open(page, 3);
    const a = await page.locator('[title^="sib-a:"]').first().boundingBox();
    const b = await page.locator('[title^="sib-b:"]').first().boundingBox();
    expect(a && b).toBeTruthy();
    expect(b!.x).toBeLessThan(a!.x + a!.width);   // b starts before a ends
    expect(b!.x).toBeGreaterThan(a!.x);           // ...but after a starts: the offsets are the real 20 ms apart
    const total = (await page.locator('[title^="parent:"]').first().boundingBox())!.width;
    expect((b!.x - a!.x) / total).toBeCloseTo(0.2, 1);
  });

  test('a malformed parent id is refused (never silently orphaned) and reported to the sender as partial success', async () => {
    const r = await fetch(`${env().ingest}/v1/traces`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body(9, [{ id: 1, name: 'ok-root', startMs: 0, durMs: 5 }, { id: 2, name: 'bad-parent', parentRaw: 'zz', startMs: 1, durMs: 1 }])) });
    expect(r.status).toBe(200);
    expect((await r.json()).partialSuccess.rejectedSpans).toBe('1');
  });

  test('a trace with 1,500 spans loads quickly, renders only the visible rows, and offers the full data as a table', async ({ page }) => {
    test.setTimeout(120_000);
    const spans: S[] = [{ id: 1, name: 'big-root', startMs: 0, durMs: 2000, service: 'gateway', kind: 2 }];
    for (let g = 0; g < 30; g++) {
      spans.push({ id: 100 + g, parent: 1, name: `group-${g}`, startMs: g * 60, durMs: 55, service: 'worker' });
      for (let i = 0; i < 49; i++) spans.push({ id: 1000 + g * 50 + i, parent: 100 + g, name: `item-${g}-${i}`, startMs: g * 60 + i, durMs: 3, service: 'worker', ...(g === 29 && i === 48 ? { status: 'error' as const } : {}) });
    }
    expect(spans.length).toBe(1501);
    for (let i = 0; i < spans.length; i += 500) await send(4, spans.slice(i, i + 500));

    await login(page, DEMO.owner);
    const t0 = Date.now();
    await open(page, 4);
    await expect(page.getByTestId('waterfall').getByRole('treeitem').first()).toBeVisible();
    const loadMs = Date.now() - t0;
    expect(loadMs, `trace of 1,501 spans took ${loadMs} ms to show`).toBeLessThan(8000);
    await expect(page.getByTestId('trace-header')).toContainText('1501');
    expect(await page.getByRole('treeitem').count(), 'only the rows in view are in the DOM').toBeLessThan(80);
    await page.getByRole('button', { name: 'Collapse all' }).click();
    await expect(page.getByRole('treeitem')).toHaveCount(1);
    await page.getByRole('button', { name: 'Expand all' }).click();
    await page.getByRole('button', { name: 'Jump to first failed span' }).click();
    await expect(page.getByTestId('span-details')).toContainText('item-29-48');  // the single failure, buried in 1,500 spans, is one click away
    await page.getByRole('button', { name: 'Table', exact: true }).click();
    await expect(page.getByTestId('span-table').getByRole('row')).toHaveCount(301);            // header + the first 300
    await page.getByRole('button', { name: /Show more spans/ }).click();
    await expect(page.getByTestId('span-table').getByRole('row')).toHaveCount(601);
  });
});
