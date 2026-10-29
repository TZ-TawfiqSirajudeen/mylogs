import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from './stack.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export interface RunningApp { url: string; stop(): Promise<void>; output(): string }

/** Starts the instrumented sample app (real OpenTelemetry SDK, OTLP exporter) pointed at the platform's ingestion service. */
export async function startSampleApp(opts: { ingestUrl: string; token: string; protocol?: 'proto' | 'json'; service?: string }): Promise<RunningApp> {
  const port = await freePort();
  const out: string[] = [];
  const p: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/app.ts'], {
    cwd: path.join(ROOT, 'examples/sample-app'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env, PORT: String(port), SAMPLE_PROTOCOL: opts.protocol ?? 'proto', SAMPLE_SERVICE_NAME: opts.service ?? 'sample-shop', SAMPLE_FLUSH_MS: '200',
      OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${opts.ingestUrl}/v1/logs`, OTEL_EXPORTER_OTLP_LOGS_HEADERS: `Authorization=Bearer ${opts.token}`,
    },
  });
  p.stdout?.on('data', (b: Buffer) => out.push(b.toString()));
  p.stderr?.on('data', (b: Buffer) => out.push(b.toString()));
  const url = `http://127.0.0.1:${port}`;
  const t0 = Date.now();
  for (;;) {
    try { if ((await fetch(`${url}/ok`)).ok) break; } catch { /* starting */ }
    if (Date.now() - t0 > 60_000) { p.kill(); throw new Error(`sample app did not start: ${out.join('')}`); }
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    url, output: () => out.join(''),
    async stop() { if (p.pid) spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); },
  };
}

/** The same mix of requests as `pnpm --filter sample-app traffic`, awaited so the caller knows when it is done. */
export async function sendTraffic(base: string, count = 24, tag = 'e2e') {
  const plan: [string, string][] = [['GET', '/ok'], ['GET', '/orders/17'], ['GET', '/orders/404'], ['GET', '/orders/500'], ['POST', '/login'], ['GET', '/slow']];
  for (let i = 0; i < count; i++) {
    const [method, p] = plan[i % plan.length]!;
    await (await fetch(`${base}${p}`, { method, headers: { 'x-request-id': `${tag}-${i}-${Date.now().toString(36)}` } })).text();
  }
}

export interface RunningShop { gateway: string; inventory: string; gatewayName: string; inventoryName: string; flush(): Promise<void>; stop(): Promise<void>; output(): string }

/**
 * Starts the TWO instrumented services (gateway -> inventory) with the real OpenTelemetry SDK, exporting traces, metrics and logs to the
 * platform with the standard OTEL_* environment variables. The gateway uses delta metrics and the stable HTTP semantic conventions; the
 * inventory service uses the SDK defaults (cumulative, legacy HTTP metric name) so both code paths of the metric store are exercised.
 */
export async function startShop(opts: { ingestUrl: string; token: string; suffix: string; protocol?: 'proto' | 'json' }): Promise<RunningShop> {
  const [gwPort, invPort] = [await freePort(), await freePort()];
  const out: string[] = [];
  const procs: ChildProcess[] = [];
  const gatewayName = `gateway-${opts.suffix}`, inventoryName = `inventory-${opts.suffix}`;
  const common = {
    ...process.env, SAMPLE_PROTOCOL: opts.protocol ?? 'proto', SAMPLE_FLUSH_MS: '200', SAMPLE_METRIC_MS: '1000',
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${opts.ingestUrl}/v1/traces`, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${opts.ingestUrl}/v1/metrics`,
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: `${opts.ingestUrl}/v1/logs`, OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${opts.token}`,
  };
  const spawnOne = (env: Record<string, string>) => {
    const p = spawn(process.execPath, ['--import', 'tsx', 'src/shop.ts'], { cwd: path.join(ROOT, 'examples/sample-app'), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...common, ...env } });
    p.stdout?.on('data', (b: Buffer) => out.push(b.toString()));
    p.stderr?.on('data', (b: Buffer) => out.push(b.toString()));
    procs.push(p);
  };
  spawnOne({ SAMPLE_ROLE: 'inventory', SAMPLE_SERVICE_NAME: inventoryName, PORT: String(invPort) });
  spawnOne({ SAMPLE_ROLE: 'gateway', SAMPLE_SERVICE_NAME: gatewayName, PORT: String(gwPort), INVENTORY_URL: `http://127.0.0.1:${invPort}`, OTEL_SEMCONV_STABILITY_OPT_IN: 'http', OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'delta' });
  const gateway = `http://127.0.0.1:${gwPort}`, inventory = `http://127.0.0.1:${invPort}`;
  const t0 = Date.now();
  for (const url of [gateway, inventory]) {
    for (;;) {
      try { if ((await fetch(`${url}/ok`)).ok) break; } catch { /* starting */ }
      if (Date.now() - t0 > 60_000) { for (const p of procs) p.kill(); throw new Error(`shop did not start: ${out.join('')}`); }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return {
    gateway, inventory, gatewayName, inventoryName, output: () => out.join(''),
    async flush() { await Promise.all([fetch(`${gateway}/__flush`), fetch(`${inventory}/__flush`)]); },
    async stop() { for (const p of procs) if (p.pid) spawn('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); },
  };
}
