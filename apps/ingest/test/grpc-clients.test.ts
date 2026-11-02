import http2 from 'node:http2';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { AuditService, type Database } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import { IngestTokenService, TokenCreate } from '@nexus/ingest';
import { MongoMetricStore } from '@nexus/metricstore';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildIngestApp, DEFAULT_APP_CONFIG } from '../src/app.js';

// OTLP/gRPC is NOT supported. These tests pin down what a gRPC client experiences: a clear refusal, never a crash or a hang.
let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let db: Database;
let token: string;

beforeAll(async () => {
  mongo = await startTestMongo();
  db = await freshTestDatabase(mongo.uri);
  await db.c.environments.insertOne({ _id: 'env-g', orgId: 'org-g', projectId: 'proj-g', slug: 'g', name: 'G', isProduction: false, createdAt: new Date() });
  const tokens = new IngestTokenService(db, new AuditService(db));
  token = (await tokens.create({ orgId: 'org-g', projectId: 'proj-g', environmentIds: null }, 'env-g', { userId: 'u', ctx: { requestId: 'req-setup-01' } }, TokenCreate.parse({ name: 'grpc probe', signals: ['logs', 'traces', 'metrics'] }))).token;
}, 300_000);
afterAll(async () => { await db?.close(); await mongo?.stop(); });

const build = () => buildIngestApp(db, { ...DEFAULT_APP_CONFIG, logLevel: 'silent' }, { metricStore: new MongoMetricStore(db) });
// A gRPC message is a 5-byte frame header (compressed flag + big-endian length) followed by the protobuf.
const grpcFrame = (payload: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, 0, payload.length]), payload]);
const noStack = (text: string) => { expect(text).not.toMatch(/\bat \S+ \(|node_modules|\.ts:\d+|\.js:\d+/); };

describe('OTLP/gRPC clients get a clear refusal (gRPC is not supported)', () => {
  test.each(['/v1/traces', '/v1/metrics', '/v1/logs'])('HTTP/1.1 POST with Content-Type application/grpc to %s is 415 with a plain message, with and without a valid token', async (url) => {
    const a = await build();
    for (const authorization of [`Bearer ${token}`, undefined]) {
      const res = await a.app.inject({ method: 'POST', url, payload: grpcFrame(Buffer.from('0a00', 'hex')), headers: { 'content-type': 'application/grpc', te: 'trailers', ...(authorization ? { authorization } : {}) } });
      // Unauthenticated callers may be refused earlier (401) but never with a crash; an authenticated gRPC client must be told why.
      expect([401, 415], `${url} auth=${!!authorization}: ${res.body}`).toContain(res.statusCode);
      if (authorization) {
        expect(res.statusCode).toBe(415);
        expect(res.json().error).toBe('unsupported_media_type');
        expect(res.json().message).toMatch(/OTLP\/gRPC is not supported.*otlphttp/);
      }
      // eslint-disable-next-line no-console
      console.log(`[grpc probe] ${url} auth=${!!authorization} -> ${res.statusCode} ${res.body}`);
      noStack(res.body);
    }
    await a.app.close();
  });

  test('a real network listener: an HTTP/2 prior-knowledge gRPC call is refused without a crash or hang, and the server keeps serving HTTP/1.1 afterwards', async () => {
    const a = await build();
    await a.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (a.app.server.address() as AddressInfo).port;

    // (1) a gRPC client over cleartext HTTP/2 (what an OTLP/gRPC exporter without TLS does against port 4318)
    const outcome = await new Promise<string>((resolve) => {
      const done = (s: string) => { clearTimeout(timer); try { client.destroy(); } catch { /* already closed */ } resolve(s); };
      const timer = setTimeout(() => done('HANG'), 8_000);
      const client = http2.connect(`http://127.0.0.1:${port}`);
      client.on('error', (e) => done(`client error: ${(e as NodeJS.ErrnoException).code ?? e.message}`));
      client.on('close', () => done('connection closed'));
      const req = client.request({ ':method': 'POST', ':path': '/opentelemetry.proto.collector.trace.v1.TraceService/Export', 'content-type': 'application/grpc', te: 'trailers', authorization: `Bearer ${token}` });
      req.on('response', (h) => done(`h2 response ${h[':status']}`));
      req.on('error', (e) => done(`stream error: ${(e as NodeJS.ErrnoException).code ?? e.message}`));
      req.end(grpcFrame(Buffer.from('0a00', 'hex')));
    });
    expect(outcome).not.toBe('HANG');
    // eslint-disable-next-line no-console
    console.log(`[grpc probe] raw HTTP/2 prior-knowledge call -> ${outcome}`);

    // (2) the raw bytes of the HTTP/2 preface sent to an HTTP/1.1 server: what does a human or a proxy see?
    const raw = await new Promise<string>((resolve) => {
      let data = '';
      const s = net.connect(port, '127.0.0.1', () => s.write('PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n'));
      s.on('data', (d) => { data += d.toString('latin1'); });
      s.on('close', () => resolve(data));
      s.on('error', () => resolve(data));
      setTimeout(() => { s.destroy(); resolve(data || 'NO RESPONSE (timeout)'); }, 5_000).unref();
    });
    // eslint-disable-next-line no-console
    console.log(`[grpc probe] raw h2 preface -> ${JSON.stringify(raw.slice(0, 200))}`);
    noStack(raw);

    // (3) still alive
    const ok = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(ok.status).toBe(200);
    const stillRefuses = await fetch(`http://127.0.0.1:${port}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/grpc', authorization: `Bearer ${token}` }, body: grpcFrame(Buffer.from('0a00', 'hex')) });
    expect(stillRefuses.status).toBe(415);
    expect(((await stillRefuses.json()) as { message: string }).message).toContain('OTLP/gRPC is not supported');
    await a.app.close();
  });
});
