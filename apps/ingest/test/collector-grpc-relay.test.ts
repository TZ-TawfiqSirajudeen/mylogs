import { spawn, type ChildProcess } from 'node:child_process';
import http2 from 'node:http2';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AuditService, type Database } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import { IngestTokenService, TokenCreate } from '@nexus/ingest';
import { MongoMetricStore } from '@nexus/metricstore';
import { encodeTracesRequest } from '@nexus/telemetry';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildIngestApp, DEFAULT_APP_CONFIG } from '../src/app.js';

// The practical way to use a gRPC-only SDK with Nexus: gRPC -> the Collector's own gRPC receiver -> otlphttp -> this service.
// Real otelcol-contrib running the repository's UNMODIFIED config, a real gRPC unary call (hand-framed over node:http2, no gRPC library
// is installed), the real ingestion app and a real mongod. Needs OTELCOL_BIN; without it the test is skipped, loudly.
const BIN = process.env.OTELCOL_BIN;
const CONFIG = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../infra/otel-collector/config.yaml');
const SERVICE = `grpc-relay-${Date.now().toString(36)}`;

const freePort = () => new Promise<number>((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as AddressInfo).port; s.close(() => res(p)); }); });
async function waitPort(port: number, ms = 30_000) {
  const t0 = Date.now();
  for (;;) {
    const ok = await new Promise<boolean>((res) => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); res(true); }); s.on('error', () => res(false)); });
    if (ok) return;
    if (Date.now() - t0 > ms) throw new Error(`port ${port} did not open`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
const grpcFrame = (payload: Uint8Array) => Buffer.concat([Buffer.from([0, 0, 0, 0, payload.length]), payload]);

describe.skipIf(!BIN)('gRPC client -> real Collector gRPC receiver -> otlphttp -> Nexus ingestion (OTELCOL_BIN set)', () => {
  let mongo: Awaited<ReturnType<typeof startTestMongo>>;
  let db: Database;
  let collector: ChildProcess | undefined;
  let ingest: Awaited<ReturnType<typeof buildIngestApp>> | undefined;
  const out: string[] = [];

  beforeAll(async () => {
    mongo = await startTestMongo();
    db = await freshTestDatabase(mongo.uri);
  }, 300_000);
  afterAll(async () => {
    collector?.kill();
    await ingest?.app.close();
    await db?.close();
    await mongo?.stop();
  });

  test('a real gRPC Export call succeeds at the Collector and the span arrives in storage under the token\'s tenant', async () => {
    await db.c.environments.insertOne({ _id: 'env-r', orgId: 'org-r', projectId: 'proj-r', slug: 'r', name: 'R', isProduction: false, createdAt: new Date() });
    const tokens = new IngestTokenService(db, new AuditService(db));
    const { token } = await tokens.create({ orgId: 'org-r', projectId: 'proj-r', environmentIds: null }, 'env-r', { userId: 'u', ctx: { requestId: 'req-setup-01' } }, TokenCreate.parse({ name: 'relay', signals: ['logs', 'traces', 'metrics'] }));
    ingest = await buildIngestApp(db, { ...DEFAULT_APP_CONFIG, logLevel: 'silent' }, { metricStore: new MongoMetricStore(db) });
    await ingest.app.listen({ port: 0, host: '127.0.0.1' });
    const ingestUrl = `http://127.0.0.1:${(ingest.app.server.address() as AddressInfo).port}`;

    const [httpPort, grpcPort] = [await freePort(), await freePort()];
    collector = spawn(BIN!, ['--config', CONFIG], {
      env: { ...process.env, NEXUS_INGEST_TOKEN: token, NEXUS_INGEST_BASE_URL: ingestUrl, OTLP_HTTP_ENDPOINT: `127.0.0.1:${httpPort}`, OTLP_GRPC_ENDPOINT: `127.0.0.1:${grpcPort}`, NEXUS_FILELOG_INCLUDE: path.join(process.cwd(), 'no-such-dir', '*.log') },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    collector.stdout?.on('data', (b: Buffer) => out.push(b.toString()));
    collector.stderr?.on('data', (b: Buffer) => out.push(b.toString()));
    await waitPort(grpcPort);

    const now = BigInt(Date.now()) * 1_000_000n;
    const body = encodeTracesRequest({
      resource_spans: [{ resource: { attributes: [{ key: 'service.name', value: { string_value: SERVICE } }] }, scope_spans: [{ scope: { name: 'grpc-test' }, spans: [{
        trace_id: Buffer.from('c'.repeat(32), 'hex'), span_id: Buffer.from('d'.repeat(16), 'hex'), name: 'GET /via-grpc', kind: 2,
        start_time_unix_nano: String(now - 2_000_000_000n), end_time_unix_nano: String(now - 1_500_000_000n), status: { code: 1 },
      }] }] }],
    });

    const result = await new Promise<{ status: string; httpStatus: unknown }>((resolve, reject) => {
      const client = http2.connect(`http://127.0.0.1:${grpcPort}`);
      const timer = setTimeout(() => { client.destroy(); reject(new Error('gRPC call timed out')); }, 15_000);
      client.on('error', reject);
      const req = client.request({ ':method': 'POST', ':path': '/opentelemetry.proto.collector.trace.v1.TraceService/Export', 'content-type': 'application/grpc', te: 'trailers' });
      let httpStatus: unknown;
      let grpcStatus = 'none';
      req.on('response', (h) => { httpStatus = h[':status']; if (h['grpc-status'] !== undefined) grpcStatus = String(h['grpc-status']); });
      req.on('trailers', (t) => { if (t['grpc-status'] !== undefined) grpcStatus = String(t['grpc-status']); });
      req.on('data', () => undefined);
      req.on('close', () => { clearTimeout(timer); client.close(); resolve({ status: grpcStatus, httpStatus }); });
      req.on('error', reject);
      req.end(grpcFrame(body));
    });
    // eslint-disable-next-line no-console
    console.log(`[grpc relay] http=${String(result.httpStatus)} grpc-status=${result.status}`);
    expect(result).toEqual({ status: '0', httpStatus: 200 }); // gRPC OK

    // The Collector batches (1 s) and exports over HTTP: poll storage for the span.
    let found = 0;
    for (let i = 0; i < 60 && !found; i++) {
      found = await db.c.spans.countDocuments({ service: SERVICE });
      if (!found) await new Promise((r) => setTimeout(r, 500));
    }
    expect(found, out.join('').slice(-1500)).toBe(1);
    const span = await db.c.spans.findOne({ service: SERVICE });
    expect(span).toMatchObject({ orgId: 'org-r', projectId: 'proj-r', environmentId: 'env-r', name: 'GET /via-grpc' });
  }, 120_000);
});
