import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEMO, env, expect, login, selectProject, test, apiAs } from '../support/fixtures.js';
import { createProject, uniq } from '../support/helpers.js';
import { freePort } from '../support/stack.js';

// The REAL OpenTelemetry Collector (contrib distribution) running the repository's own, unmodified config
// (infra/otel-collector/config.yaml) -> authenticated OTLP/HTTP -> ingestion service -> storage -> Logs Explorer UI.
// Set OTELCOL_BIN to an otelcol-contrib binary (see docs/runbooks/collector.md). Without it these tests are SKIPPED, loudly.
const BIN = process.env.OTELCOL_BIN;
const CONFIG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../infra/otel-collector/config.yaml');

interface Collector { http: string; output(): string; stop(): Promise<void> }

async function waitPort(port: number, ms = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const ok = await new Promise<boolean>((res) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
    if (ok) return;
    if (Date.now() - t0 > ms) throw new Error(`collector did not open port ${port}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

async function startCollector(token: string, logGlob: string): Promise<Collector> {
  const [httpPort, grpcPort] = [await freePort(), await freePort()];
  const out: string[] = [];
  const p: ChildProcess = spawn(BIN!, ['--config', CONFIG], {
    env: {
      ...process.env,
      NEXUS_INGEST_TOKEN: token, NEXUS_INGEST_BASE_URL: env().ingest,
      OTLP_HTTP_ENDPOINT: `127.0.0.1:${httpPort}`, OTLP_GRPC_ENDPOINT: `127.0.0.1:${grpcPort}`, NEXUS_FILELOG_INCLUDE: logGlob,
    },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  p.stdout?.on('data', (b: Buffer) => out.push(b.toString()));
  p.stderr?.on('data', (b: Buffer) => out.push(b.toString()));
  let exited = false;
  p.on('exit', () => { exited = true; });
  try { await waitPort(httpPort); } catch (e) { p.kill(); throw new Error(`${(e as Error).message}\n${out.join('')}`); }
  return {
    http: `http://127.0.0.1:${httpPort}`, output: () => out.join(''),
    async stop() { if (exited) return; await new Promise<void>((r) => { p.once('exit', () => r()); p.kill(); setTimeout(r, 5000); }); },
  };
}

const nano = (ms: number) => String(BigInt(ms) * 1_000_000n);
const otlpBody = (service: string, message: string, extra: object[] = []) => ({
  resourceLogs: [{
    resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }, { key: 'host.name', value: { stringValue: 'collector-e2e' } }] },
    scopeLogs: [{ logRecords: [{
      timeUnixNano: nano(Date.now() - 2000), severityNumber: 17, severityText: 'ERROR', body: { stringValue: message },
      attributes: [
        { key: 'http.response.status_code', value: { intValue: '502' } }, { key: 'http.route', value: { stringValue: '/collector/e2e' } },
        { key: 'http.request.header.authorization', value: { stringValue: 'Bearer leak-this-token-0123456789' } }, // masked at the edge by the Collector
        { key: 'customer.tier', value: { stringValue: 'gold' } }, ...extra,
      ],
    }] }],
  }],
});

test.describe('OpenTelemetry Collector (real binary) -> authenticated ingestion -> UI', () => {
  test.skip(!BIN, 'OTELCOL_BIN is not set: the Collector path is NOT verified in this run (see docs/runbooks/collector.md)');

  test('OTLP/HTTP and a tailed log file arrive with the right tenant, are masked, searchable and visible in the UI', async ({ page, db }) => {
    test.setTimeout(240_000);
    const name = uniq('E2E Collector');
    await login(page, DEMO.owner);
    const project = await createProject(page, name);
    const envId = project.environments[0]!.id;
    const minted = await apiAs(page, 'POST', `/api/v1/projects/${project.id}/environments/${envId}/ingest-tokens`, { name: 'collector' });
    expect(minted.status).toBe(201);

    const dir = mkdtempSync(path.join(tmpdir(), 'nx-collector-'));
    const marker = `collector-${Date.now().toString(36)}`;
    const service = `svc-${marker}`;
    writeFileSync(path.join(dir, 'app.log'), `${JSON.stringify({ time: new Date(Date.now() - 1500).toISOString().replace(/Z$/, '.000Z'), level: 'warn', msg: `file line ${marker} password=hunter2hunter2` })}\n`);
    const collector = await startCollector(minted.json.token, path.join(dir, '*.log').replace(/\\/g, '/'));
    try {
      const sent = await fetch(`${collector.http}/v1/logs`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(otlpBody(service, `otlp failure ${marker}`)),
      });
      expect(sent.status, collector.output()).toBe(200);

      await expect.poll(async () => db.count('logs', { projectId: project.id, message: { $regex: marker } }), { timeout: 60_000, intervals: [500], message: collector.output() }).toBeGreaterThanOrEqual(2);
      const logs = await db.find('logs', { projectId: project.id, message: { $regex: marker } });

      // The tenant comes from the token the Collector presented, never from the data.
      expect(logs.every((l) => l.environmentId === envId && l.projectId === project.id && l.source === 'otlp')).toBe(true);
      const viaOtlp = logs.find((l) => l.service === service)!;
      expect(viaOtlp).toMatchObject({ severity: 'error', httpStatus: 502, httpRoute: '/collector/e2e' });
      const authAttr = viaOtlp.attrs.find((a: { k: string }) => a.k === 'http.request.header.authorization');
      expect(authAttr.v).toBe('[REDACTED]');
      const viaFile = logs.find((l) => l.message.includes('file line'))!;
      expect(viaFile.severity).toBe('warn');
      expect(JSON.stringify(logs)).not.toContain('leak-this-token');
      expect(JSON.stringify(logs)).not.toContain('hunter2hunter2'); // redacted by the platform even though the Collector does not mask free text

      // ---- the human-visible end of the pipe
      await page.goto('/');
      await selectProject(page, name);
      await page.goto('/logs');
      await page.getByLabel('Time range').selectOption('1h');
      await page.getByLabel('Search messages and errors').fill(marker);
      await page.getByRole('button', { name: 'Run search' }).click();
      const table = page.getByRole('table', { name: 'Log results' });
      await expect(table).toContainText(`otlp failure ${marker}`, { timeout: 30_000 });
      await expect(table).toContainText(`file line ${marker}`);
      await expect(table).not.toContainText('hunter2hunter2');
    } finally { await collector.stop(); }
  });

  test('a wrong token is rejected by the ingestion service: nothing is stored and the Collector reports the failure', async ({ page, db }) => {
    test.setTimeout(180_000);
    await login(page, DEMO.owner);
    const project = await createProject(page, uniq('E2E Collector Bad Token'));
    const marker = `badtoken-${Date.now().toString(36)}`;
    const dir = mkdtempSync(path.join(tmpdir(), 'nx-collector-'));
    writeFileSync(path.join(dir, 'x.log'), '');
    const collector = await startCollector('nxi_this_token_does_not_exist_000000000000', path.join(dir, '*.log').replace(/\\/g, '/'));
    try {
      const sent = await fetch(`${collector.http}/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(otlpBody(`svc-${marker}`, `must not be stored ${marker}`)) });
      expect(sent.status).toBe(200); // the Collector accepts it; delivery happens asynchronously
      await expect.poll(() => collector.output(), { timeout: 30_000, intervals: [500] }).toMatch(/401|Unauthorized|not retryable|permanent|Dropping data/i);
      expect(await db.count('logs', { message: { $regex: marker } })).toBe(0);
      expect(await db.count('logs', { projectId: project.id })).toBe(0);
    } finally { await collector.stop(); }
  });

  const T = 'ab'.repeat(16);
  const tracesJson = (service: string, now = Date.now()) => ({
    resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] }, scopeSpans: [{ spans: [
      { traceId: T, spanId: '1111111111111111', name: 'GET /collector', kind: 2, startTimeUnixNano: nano(now - 900), endTimeUnixNano: nano(now - 400),
        attributes: [{ key: 'http.request.header.authorization', value: { stringValue: 'Bearer leak-this-too-0123456789' } }, { key: 'http.route', value: { stringValue: '/collector' } }, { key: 'http.response.status_code', value: { intValue: '200' } }] },
      { traceId: T, spanId: '2222222222222222', parentSpanId: '1111111111111111', name: 'db.find', kind: 3, startTimeUnixNano: nano(now - 800), endTimeUnixNano: nano(now - 500), attributes: [{ key: 'db.system', value: { stringValue: 'redis' } }] },
    ] }] }],
  });
  const metricsJson = (service: string, now = Date.now()) => ({
    resourceMetrics: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: service } }] }, scopeMetrics: [{ metrics: [
      { name: 'http.server.request.duration', unit: 's', histogram: { aggregationTemporality: 1, dataPoints: [{ timeUnixNano: nano(now - 1000), count: '5', sum: 1.1, bucketCounts: ['2', '2', '1'], explicitBounds: [0.1, 0.5],
        attributes: [{ key: 'http.route', value: { stringValue: '/collector' } }, { key: 'http.response.status_code', value: { stringValue: '200' } }] }] } },
      { name: 'collector.jobs', sum: { aggregationTemporality: 1, isMonotonic: true, dataPoints: [{ timeUnixNano: nano(now - 1000), asInt: '7' }] } },
    ] }] }],
  });

  test('traces and metrics travel through the real Collector too: authenticated, scoped to the token, masked at the edge, visible in the UI', async ({ page, db }) => {
    test.setTimeout(240_000);
    await login(page, DEMO.owner);
    const project = await createProject(page, uniq('E2E Collector Signals'));
    const envId = project.environments[0]!.id;
    const minted = await apiAs(page, 'POST', `/api/v1/projects/${project.id}/environments/${envId}/ingest-tokens`, { name: 'collector-all' });
    expect(minted.status).toBe(201);
    const dir = mkdtempSync(path.join(tmpdir(), 'nx-collector-'));
    writeFileSync(path.join(dir, 'x.log'), '');
    const collector = await startCollector(minted.json.token, path.join(dir, '*.log').replace(/\\/g, '/'));
    const service = `svc-coll-${Date.now().toString(36)}`;
    try {
      const post = (p: string, b: object) => fetch(`${collector.http}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
      expect((await post('/v1/traces', tracesJson(service))).status, collector.output()).toBe(200);
      expect((await post('/v1/metrics', metricsJson(service))).status, collector.output()).toBe(200);

      await expect.poll(async () => db.count('spans', { projectId: project.id, service }), { timeout: 60_000, intervals: [500], message: collector.output() }).toBe(2);
      await expect.poll(async () => db.count('metric_points', { projectId: project.id, service }), { timeout: 60_000, intervals: [500], message: collector.output() }).toBeGreaterThanOrEqual(2);
      const spans = await db.find('spans', { projectId: project.id, service });
      expect(spans.every((s) => s.environmentId === envId && s.projectId === project.id)).toBe(true);   // tenant comes from the token the Collector presented
      expect(spans.find((s) => s.name === 'db.find')).toMatchObject({ parentSpanId: '1111111111111111', dbSystem: 'redis' });
      expect(JSON.stringify(spans)).not.toContain('leak-this-too');                                     // masked (Collector edge + platform)
      expect(spans.find((s) => s.name === 'GET /collector').attrs.find((a: { k: string }) => a.k === 'http.request.header.authorization').v).toBe('[REDACTED]');

      // the UI
      await page.goto(`/traces/${T}?p=${project.id}`);
      await expect(page.getByTestId('trace-header')).toContainText('GET /collector');
      await expect(page.getByRole('treeitem')).toHaveCount(2);
      await page.goto(`/services?p=${project.id}&minutes=60`);
      await expect(page.getByTestId(`service-${service}`)).toContainText('HTTP metrics');
      await expect(page.getByTestId(`service-${service}`)).toContainText('5');                          // five requests from the explicit histogram
      const q = await apiAs(page, 'POST', `/api/v1/projects/${project.id}/metrics/query`, { from: new Date(Date.now() - 3600_000).toISOString(), to: new Date(Date.now() + 60_000).toISOString(), metric: 'collector.jobs', agg: 'sum' });
      expect(q.status).toBe(200);
      expect(q.json.series[0].points.reduce((n: number, p: { v: number | null }) => n + (p.v ?? 0), 0)).toBe(7);
    } finally { await collector.stop(); }
  });

  test('a token without the "traces" signal is refused by ingestion (403) when relayed by the Collector: nothing is stored and the Collector reports it', async ({ page, db }) => {
    test.setTimeout(180_000);
    await login(page, DEMO.owner);
    const project = await createProject(page, uniq('E2E Collector Scope'));
    const minted = await apiAs(page, 'POST', `/api/v1/projects/${project.id}/environments/${project.environments[0]!.id}/ingest-tokens`, { name: 'logs-only', signals: ['logs'] });
    const dir = mkdtempSync(path.join(tmpdir(), 'nx-collector-'));
    writeFileSync(path.join(dir, 'x.log'), '');
    const collector = await startCollector(minted.json.token, path.join(dir, '*.log').replace(/\\/g, '/'));
    const service = `svc-scope-${Date.now().toString(36)}`;
    try {
      expect((await fetch(`${collector.http}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(tracesJson(service)) })).status).toBe(200);
      await expect.poll(() => collector.output(), { timeout: 30_000, intervals: [500] }).toMatch(/403|Forbidden|not retryable|permanent|Dropping data/i);
      expect(await db.count('spans', { projectId: project.id })).toBe(0);
    } finally { await collector.stop(); }
  });
});
