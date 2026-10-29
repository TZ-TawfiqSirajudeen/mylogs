import { gzipSync, deflateSync } from 'node:zlib';
import { AuditService, type Database, type LogDoc } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import { DEFAULT_INGEST_CONFIG, IngestTokenService, TokenCreate } from '@nexus/ingest';
import { MongoLogStore, type LogStore } from '@nexus/logstore';
import { encodeLogsRequest } from '@nexus/telemetry';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildIngestApp, DEFAULT_APP_CONFIG, type IngestAppConfig } from '../src/app.js';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let db: Database;
let tokens: IngestTokenService;
let token: string;
let tokenId: string;
const ORG = 'org-a', PROJECT = 'proj-1', ENV = 'env-a';
const nsOf = (ms: number) => String(BigInt(ms) * 1_000_000n);
const NOW = Date.now();
const rec = (msg: string, over: object = {}) => ({ timeUnixNano: nsOf(NOW - 1000), severityNumber: 9, body: { stringValue: msg }, ...over });
const otlp = (records: object[]) => ({ resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] }, scopeLogs: [{ logRecords: records }] }] });
const protoReq = (msgs: string[]) => encodeLogsRequest({
  resource_logs: [{ resource: { attributes: [{ key: 'service.name', value: { string_value: 'proto' } }] }, scope_logs: [{ log_records: msgs.map((m) => ({ time_unix_nano: nsOf(NOW - 500), severity_number: 9, body: { string_value: m } })) }] }],
});

async function app(cfg: Partial<IngestAppConfig> = {}, deps: Parameters<typeof buildIngestApp>[2] = {}) {
  return buildIngestApp(db, { ...DEFAULT_APP_CONFIG, logLevel: 'silent', ...cfg }, deps);
}
const auth = (t = token) => ({ authorization: `Bearer ${t}` });
const post = (a: Awaited<ReturnType<typeof app>>, url: string, payload: string | Buffer, headers: Record<string, string>) => a.app.inject({ method: 'POST', url, payload, headers });

beforeAll(async () => {
  mongo = await startTestMongo();
  db = await freshTestDatabase(mongo.uri);
  tokens = new IngestTokenService(db, new AuditService(db));
  await db.c.environments.insertOne({ _id: ENV, orgId: ORG, projectId: PROJECT, slug: 'a', name: 'A', isProduction: false, createdAt: new Date() });
  const t = await tokens.create({ orgId: ORG, projectId: PROJECT, environmentIds: null }, ENV, { userId: 'u', ctx: { requestId: 'req-setup-01' } }, TokenCreate.parse({ name: 'http-test', recordsPerMinute: 1_000_000 }));
  token = t.token; tokenId = t.info.id;
}, 300_000);
afterAll(async () => { await db?.close(); await mongo?.stop(); });

describe('OTLP/HTTP logs', () => {
  test('JSON with a bearer token or X-Nexus-Token: 200 {} and the data is stored under the token\'s tenant', async () => {
    const a = await app();
    const r1 = await post(a, '/v1/logs', JSON.stringify(otlp([rec('via bearer')])), { 'content-type': 'application/json', ...auth() });
    expect(r1.statusCode).toBe(200);
    expect(r1.json()).toEqual({});
    const r2 = await post(a, '/v1/logs', JSON.stringify(otlp([rec('via x-header')])), { 'content-type': 'application/json', 'x-nexus-token': token });
    expect(r2.statusCode).toBe(200);
    expect(await db.c.logs.findOne({ message: 'via bearer' })).toMatchObject({ orgId: ORG, projectId: PROJECT, environmentId: ENV, tokenId });
    expect(await db.c.logs.countDocuments({ message: 'via x-header' })).toBe(1);
    expect(r1.headers['x-request-id']).toBeTruthy();
    await a.app.close();
  });

  test('protobuf (what the OpenTelemetry Collector sends) is decoded and stored', async () => {
    const a = await app();
    const r = await post(a, '/v1/logs', Buffer.from(protoReq(['proto one', 'proto two'])), { 'content-type': 'application/x-protobuf', ...auth() });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/x-protobuf');
    expect(await db.c.logs.countDocuments({ message: /^proto (one|two)$/ })).toBe(2);
    await a.app.close();
  });

  test('gzip and deflate bodies are accepted; corrupt or unsupported encodings are refused', async () => {
    const a = await app();
    const json = JSON.stringify(otlp([rec('gzipped')]));
    expect((await post(a, '/v1/logs', gzipSync(json), { 'content-type': 'application/json', 'content-encoding': 'gzip', ...auth() })).statusCode).toBe(200);
    expect((await post(a, '/v1/logs', gzipSync(Buffer.from(protoReq(['gz proto']))), { 'content-type': 'application/x-protobuf', 'content-encoding': 'gzip', ...auth() })).statusCode).toBe(200);
    expect((await post(a, '/v1/logs', deflateSync(JSON.stringify(otlp([rec('deflated')]))), { 'content-type': 'application/json', 'content-encoding': 'deflate', ...auth() })).statusCode).toBe(200);
    expect(await db.c.logs.countDocuments({ message: { $in: ['gzipped', 'gz proto', 'deflated'] } })).toBe(3);
    expect((await post(a, '/v1/logs', Buffer.from('not gzip at all'), { 'content-type': 'application/json', 'content-encoding': 'gzip', ...auth() })).statusCode).toBe(400);
    expect((await post(a, '/v1/logs', json, { 'content-type': 'application/json', 'content-encoding': 'compress', ...auth() })).statusCode).toBe(415);
    await a.app.close();
  });

  test('decompression bomb: a tiny gzip that expands past the limit is refused quickly with 413', async () => {
    const a = await app({ maxBodyBytes: 1024 * 1024 });
    const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024)); // 64 MB of zeros compresses to ~64 KB
    expect(bomb.length).toBeLessThan(200 * 1024);
    const t0 = Date.now();
    const r = await post(a, '/v1/logs', bomb, { 'content-type': 'application/json', 'content-encoding': 'gzip', ...auth() });
    expect(r.statusCode).toBe(413);
    expect(Date.now() - t0).toBeLessThan(5_000);
    await a.app.close();
  });

  test('oversized plain bodies, bad media types and malformed payloads', async () => {
    const a = await app({ maxBodyBytes: 2048 });
    expect((await post(a, '/v1/logs', 'x'.repeat(5000), { 'content-type': 'application/json', ...auth() })).statusCode).toBe(413);
    const b = await app();
    expect((await post(b, '/v1/logs', '<xml/>', { 'content-type': 'application/xml', ...auth() })).statusCode).toBe(415);
    const bad = await post(b, '/v1/logs', '{ not json', { 'content-type': 'application/json', ...auth() });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().message).toMatch(/not valid JSON/);
    expect((await post(b, '/v1/logs', Buffer.from([0xff, 0xff, 0xff, 0xff]), { 'content-type': 'application/x-protobuf', ...auth() })).statusCode).toBe(400);
    expect((await post(b, '/v1/logs', '', { 'content-type': 'application/json', ...auth() })).statusCode).toBe(200); // empty export is not an error
    await a.app.close(); await b.app.close();
  });

  test('partial success is reported in the OTLP shape; nothing valid is a 400', async () => {
    const a = await app();
    const mixed = await post(a, '/v1/logs', JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [null, rec('partial ok')] }] }] }), { 'content-type': 'application/json', ...auth() });
    expect(mixed.statusCode).toBe(200);
    expect(mixed.json().partialSuccess).toMatchObject({ rejectedLogRecords: '1' });
    expect(mixed.json().partialSuccess.errorMessage).toBeTruthy();
    const none = await post(a, '/v1/logs', JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [1, 2] }] }] }), { 'content-type': 'application/json', ...auth() });
    expect(none.statusCode).toBe(400);
    expect(none.json().error).toBe('invalid');
    await a.app.close();
  });

  test('a retransmitted request is not stored twice', async () => {
    const a = await app();
    const body = JSON.stringify(otlp([rec('exactly once')]));
    for (let i = 0; i < 3; i++) expect((await post(a, '/v1/logs', body, { 'content-type': 'application/json', ...auth() })).statusCode).toBe(200);
    expect(await db.c.logs.countDocuments({ message: 'exactly once' })).toBe(1);
    await a.app.close();
  });
});

describe('authentication', () => {
  test('missing, wrong, malformed and revoked tokens all get the same 401 (no oracle)', async () => {
    const a = await app();
    const revoked = (await tokens.create({ orgId: ORG, projectId: PROJECT, environmentIds: null }, ENV, { userId: 'u', ctx: { requestId: 'req-setup-02' } }, TokenCreate.parse({ name: 'to-revoke' })));
    await tokens.revoke({ orgId: ORG, projectId: PROJECT, environmentIds: null }, revoked.info.id, { userId: 'u', ctx: { requestId: 'req-setup-03' } });
    const bodies = new Set<string>();
    const variants: Record<string, string>[] = [{}, auth('nxi_' + 'A'.repeat(43)), auth('garbage'), auth(revoked.token), { authorization: 'Basic abc' }, { 'x-nexus-token': 'nope' }];
    for (const headers of variants) {
      const r = await post(a, '/v1/logs', JSON.stringify(otlp([rec('nope')])), { 'content-type': 'application/json', ...headers });
      expect(r.statusCode).toBe(401);
      bodies.add(JSON.stringify({ ...r.json(), requestId: '' }));
    }
    expect(bodies.size).toBe(1);
    expect(await db.c.logs.countDocuments({ message: 'nope' })).toBe(0);
    await a.app.close();
  });

  test('repeated failures from one address are throttled (brute-force protection) while valid tokens keep working', async () => {
    const a = await app({ authFailuresPerMinute: 5 });
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await post(a, '/v1/logs', '{}', { 'content-type': 'application/json', ...auth('nxi_' + 'B'.repeat(43)) })).statusCode);
    expect(codes).toEqual([401, 401, 401, 401, 401, 429, 429, 429]);
    const throttled = await post(a, '/v1/logs', '{}', { 'content-type': 'application/json', ...auth('nxi_' + 'B'.repeat(43)) });
    expect(throttled.headers['retry-after']).toBeTruthy();
    expect((await post(a, '/v1/logs', JSON.stringify(otlp([rec('still works')])), { 'content-type': 'application/json', ...auth() })).statusCode).toBe(200);
    await a.app.close();
  });

  test('the token never appears in logs or responses', async () => {
    const lines: string[] = [];
    const a = await app({ logLevel: 'trace' }, { logStream: { write: (m) => lines.push(m) } });
    const r = await post(a, '/v1/logs', JSON.stringify(otlp([rec('log hygiene')])), { 'content-type': 'application/json', ...auth() });
    await post(a, '/v1/logs', '{}', { 'content-type': 'application/json', 'x-nexus-token': token });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('\n')).not.toContain(token);
    expect(r.body).not.toContain(token);
    await a.app.close();
  });
});

describe('backpressure and failure signalling (what a sender sees)', () => {
  test('quota -> 429 with Retry-After; storage down -> 503 with Retry-After; recovery works', async () => {
    const limited = (await tokens.create({ orgId: ORG, projectId: PROJECT, environmentIds: null }, ENV, { userId: 'u', ctx: { requestId: 'req-setup-04' } }, TokenCreate.parse({ name: 'limited', recordsPerMinute: 100 }))).token;
    const a = await app();
    const big = JSON.stringify(otlp(Array.from({ length: 80 }, (_, i) => rec(`quota ${i}`))));
    expect((await post(a, '/v1/logs', big, { 'content-type': 'application/json', ...auth(limited) })).statusCode).toBe(200);
    const refused = await post(a, '/v1/logs', JSON.stringify(otlp(Array.from({ length: 80 }, (_, i) => rec(`quota2 ${i}`)))), { 'content-type': 'application/json', ...auth(limited) });
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    await a.app.close();

    let down = true;
    const base = new MongoLogStore(db);
    const outage: LogStore = Object.assign(Object.create(base) as LogStore, { insert: async (docs: LogDoc[]) => { if (down) throw new Error('db down'); return base.insert(docs); } });
    const b = await app({ ingest: { ...DEFAULT_INGEST_CONFIG, storeRetries: 0 } }, { store: outage });
    const payload = JSON.stringify(otlp([rec('survives outage')]));
    const r = await post(b, '/v1/logs', payload, { 'content-type': 'application/json', ...auth() });
    expect(r.statusCode).toBe(503);
    expect(r.headers['retry-after']).toBeTruthy();
    down = false;
    expect((await post(b, '/v1/logs', payload, { 'content-type': 'application/json', ...auth() })).statusCode).toBe(200);
    expect(await db.c.logs.countDocuments({ message: 'survives outage' })).toBe(1);
    await b.app.close();
  });
});

describe('generic JSON logs', () => {
  test('JSON array, wrapper object, NDJSON and text/plain bodies', async () => {
    const a = await app();
    const h = (t: string) => ({ 'content-type': t, ...auth() });
    expect((await post(a, '/v1/json-logs', JSON.stringify([{ level: 'warn', msg: 'json arr', time: new Date(NOW).toISOString() }]), h('application/json'))).statusCode).toBe(200);
    expect((await post(a, '/v1/json-logs', JSON.stringify({ logs: [{ level: 'error', msg: 'json wrap' }] }), h('application/json'))).statusCode).toBe(200);
    const nd = await post(a, '/v1/json-logs', `${JSON.stringify({ msg: 'nd 1' })}\n${JSON.stringify({ msg: 'nd 2' })}\nbroken\n`, h('application/x-ndjson'));
    expect(nd.statusCode).toBe(200);
    expect(nd.json().partialSuccess.rejectedLogRecords).toBe('1');
    expect((await post(a, '/v1/json-logs', JSON.stringify({ msg: 'plain text ct' }), h('text/plain'))).statusCode).toBe(200);
    expect(await db.c.logs.countDocuments({ message: { $in: ['json arr', 'json wrap', 'nd 1', 'nd 2', 'plain text ct'] } })).toBe(5);
    expect((await db.c.logs.findOne({ message: 'json arr' }))!.severity).toBe('warn');
    await a.app.close();
  });
});

describe('operations', () => {
  test('health, readiness and Prometheus metrics (including explicit refusal counters)', async () => {
    const a = await app();
    expect((await a.app.inject('/healthz')).statusCode).toBe(200);
    const ready = await a.app.inject('/readyz');
    expect(ready.statusCode).toBe(200);
    expect(ready.json().checks.mongodb).toBe('up');
    await post(a, '/v1/logs', JSON.stringify(otlp([rec('metric me'), { body: 5 }])), { 'content-type': 'application/json', ...auth() });
    const m = (await a.app.inject('/metrics')).body;
    expect(m).toMatch(/nexus_ingest_records_accepted_total [1-9]/);
    for (const name of ['rejected_invalid', 'rejected_quota', 'rejected_overload', 'rejected_storage']) expect(m).toContain(`nexus_ingest_records_${name}_total`);
    expect(m).toContain('nexus_ingest_inflight_writes 0');
    await a.app.close();
  });
});
