/**
 * Repeatable ingestion + query benchmark against a real mongod (WiredTiger) on this machine.
 *   pnpm --filter @nexus/ingest bench            (default 300,000 records)
 *   BENCH_RECORDS=1000000 pnpm --filter @nexus/ingest bench
 * Prints a JSON report and writes it to docs/performance-results.json. It measures THIS machine and THIS in-memory-server
 * configuration; it is evidence for the numbers it prints, not a capacity guarantee.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { AuditService } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import { LogQuery, MongoLogStore, type Scope } from '@nexus/logstore';
import { DEFAULT_INGEST_CONFIG, IngestPipeline, IngestTokenService, TokenCreate } from '../src/index.js';

const N = Number(process.env.BENCH_RECORDS ?? 300_000);
const BATCH = 1000;
const CONCURRENCY = 4;
const ORG = 'org-b', PROJECT = 'proj-b', ENV = 'env-b';

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;
const ms = (n: number) => Math.round(n * 10) / 10;

async function main() {
  const mongo = await startTestMongo();
  const db = await freshTestDatabase(mongo.uri);
  await db.c.environments.insertOne({ _id: ENV, orgId: ORG, projectId: PROJECT, slug: 'b', name: 'B', isProduction: false, createdAt: new Date() });
  const tokens = new IngestTokenService(db, new AuditService(db));
  const { token } = await tokens.create({ orgId: ORG, projectId: PROJECT, environmentIds: null }, ENV, { userId: 'bench', ctx: { requestId: 'bench-000001' } }, TokenCreate.parse({ name: 'bench', retentionDays: 30 }));
  const doc = (await tokens.authenticate(token))!;
  const store = new MongoLogStore(db);
  const pipe = new IngestPipeline(db, store, { ...DEFAULT_INGEST_CONFIG, tokenRecordsPerMinute: 1e9, projectRecordsPerMinute: 1e9, maxInflightWrites: CONCURRENCY, maxQueuedWrites: 1000 });

  const services = ['checkout', 'payments', 'inventory', 'gateway', 'auth', 'search', 'email', 'worker'];
  const routes = ['/orders/:id', '/pay', '/cart', '/login', '/search', '/health'];
  const now = Date.now();
  const spanMs = 6 * 3600_000;
  const mkBatch = (b: number, salt = '') => {
    const records = Array.from({ length: BATCH }, (_, i) => {
      const n = (b * BATCH + i) % N; // keep timestamps inside the 6 h window and inside retention
      const err = n % 37 === 0;
      const svc = services[n % services.length]!;
      const ts = now - Math.floor((n / N) * spanMs) - 5_000;
      return {
        timeUnixNano: String(BigInt(ts) * 1_000_000n), severityNumber: err ? 17 : n % 11 === 0 ? 13 : 9,
        body: { stringValue: err ? `request failed: upstream ${svc} returned 500 for order ${n}` : `handled request ${n} in ${svc}` },
        traceId: n % 5 === 0 ? createHash('md5').update(String(n % 20000)).digest('hex') : undefined,
        attributes: [
          { key: 'http.request.method', value: { stringValue: 'GET' } }, { key: 'http.route', value: { stringValue: routes[n % routes.length]! } },
          { key: 'http.response.status_code', value: { intValue: String(err ? 500 : 200) } }, { key: 'duration_ms', value: { doubleValue: (n % 900) + 0.5 } },
          { key: 'request.id', value: { stringValue: `req-${n}` } }, { key: 'customer.tier', value: { stringValue: n % 3 === 0 ? 'gold' : 'silver' } },
          { key: 'region', value: { stringValue: n % 2 ? 'eu-west-1' : 'us-east-1' } },
          ...(err ? [{ key: 'exception.type', value: { stringValue: 'UpstreamError' } }, { key: 'exception.stacktrace', value: { stringValue: 'UpstreamError: 500\n    at call (client.js:10:5)\n    at handler (api.js:55:3)' } }] : []),
        ],
      };
    });
    const body = { resourceLogs: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: services[b % services.length]! } }, { key: 'host.name', value: { stringValue: `host-${b % 16}` } }] }, scopeLogs: [{ logRecords: records }] }] };
    const text = JSON.stringify(body);
    return { payload: body, bytes: text.length, hash: createHash('sha256').update(text + salt).digest('hex') }; // salt: distinct requests, not retransmissions
  };

  // ---------------------------------------------------------------- ingestion
  const batches = Math.ceil(N / BATCH);
  let next = 0, accepted = 0, bytes = 0;
  const latencies: number[] = [];
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const b = next++;
      if (b >= batches) return;
      const m = mkBatch(b);
      const s = performance.now();
      const r = await pipe.handle(doc, { format: 'otlp', payload: m.payload, bodyBytes: m.bytes, bodyHash: m.hash });
      latencies.push(performance.now() - s);
      if (r.status !== 'ok') throw new Error(`ingest failed: ${JSON.stringify(r)}`);
      accepted += r.accepted; bytes += m.bytes;
    }
  }));
  const ingestSec = (performance.now() - t0) / 1000;
  const total = await db.c.logs.countDocuments({});

  // ---------------------------------------------------------------- queries
  const scope: Scope = { orgId: ORG, projectId: PROJECT, environmentIds: [ENV] };
  const range = (minutes: number, over: object = {}) => LogQuery.parse({ from: new Date(now - minutes * 60_000).toISOString(), to: new Date(now + 60_000).toISOString(), ...over });
  const time = async (name: string, fn: () => Promise<unknown>, runs = 15) => {
    await fn();
    const xs: number[] = [];
    for (let i = 0; i < runs; i++) { const s = performance.now(); await fn(); xs.push(performance.now() - s); }
    return { name, p50: ms(pct(xs, 50)), p95: ms(pct(xs, 95)), max: ms(Math.max(...xs)), runs };
  };
  const sample = await db.c.logs.findOne({ traceId: { $ne: null } });
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) cursor = (await store.search(scope, range(360, { limit: 100, cursor }))).nextCursor ?? cursor;

  const queries = [
    await time('latest 100 (last 15 min)', () => store.search(scope, range(15))),
    await time('latest 100 (last 6 h, whole dataset)', () => store.search(scope, range(360))),
    await time('errors only (last 6 h)', () => store.search(scope, range(360, { errorsOnly: true }))),
    await time('service filter + min severity (6 h)', () => store.search(scope, range(360, { services: ['payments'], minSeverity: 'warn' }))),
    await time('HTTP status >= 500 filter (6 h)', () => store.search(scope, range(360, { filters: [{ field: 'httpStatus', op: 'gte', value: 500 }] }))),
    await time('attribute filter customer.tier=gold (6 h)', () => store.search(scope, range(360, { filters: [{ field: 'attr:customer.tier', op: 'eq', value: 'gold' }] })), 8),
    await time('text search "upstream payments" (6 h, regex)', () => store.search(scope, range(360, { text: 'upstream payments' })), 8),
    await time('text search, no match (6 h) — worst case scan', () => store.search(scope, range(360, { text: 'zzz-no-such-text' })), 5),
    await time('trace lookup (indexed)', () => store.related(scope, sample!)),
    await time('request id filter (indexed)', () => store.search(scope, range(360, { filters: [{ field: 'requestId', op: 'eq', value: 'req-12345' }] }))),
    await time('deep page (cursor after 2,000 rows)', () => store.search(scope, range(360, { limit: 100, cursor }))),
    await time('histogram, 60 buckets (6 h)', () => store.histogram(scope, range(360)), 5),
    await time('facets (6 h)', () => store.facets(scope, range(360)), 5),
    // Added after the optimisation work: paths that do NOT use the index-only fast path (no target was set for them; reported as measured).
    await time('histogram, errors only (index-count path)', () => store.histogram(scope, range(360, { errorsOnly: true })), 5),
    await time('histogram + text filter (aggregation fallback)', () => store.histogram(scope, range(360, { text: 'upstream' })), 5),
    await time('histogram + attribute filter (aggregation fallback)', () => store.histogram(scope, range(360, { filters: [{ field: 'attr:customer.tier', op: 'eq', value: 'gold' }] })), 5),
    await time('facets + text filter', () => store.facets(scope, range(360, { text: 'upstream' })), 5),
  ];

  // ---------------------------------------------------------------- concurrent readers while ingesting
  let ingestDuringReads = 0;
  const stopAt = performance.now() + 4000;
  const writer = (async () => { let b = 0; while (performance.now() < stopAt) { const m = mkBatch(b, `mixed-${b++}`); const r = await pipe.handle(doc, { format: 'otlp', payload: m.payload, bodyBytes: m.bytes, bodyHash: m.hash }); ingestDuringReads += r.accepted; } })();
  const readerLat: number[] = [];
  const readers = Array.from({ length: 8 }, async () => { while (performance.now() < stopAt) { const s = performance.now(); await store.search(scope, range(360, { errorsOnly: true })); readerLat.push(performance.now() - s); } });
  await Promise.all([writer, ...readers]);

  const stats = await db.db.command({ collStats: 'logs' }).catch(() => null);
  const report = {
    machine: { cpus: cpus().length, cpuModel: cpus()[0]?.model, memGiB: Math.round(totalmem() / 2 ** 30), node: process.version },
    dataset: { records: total, spanHours: 6, avgRecordBytesOnWire: Math.round(bytes / accepted) },
    ingestion: {
      recordsPerSecond: Math.round(accepted / ingestSec), seconds: ms(ingestSec), batchSize: BATCH, concurrency: CONCURRENCY,
      batchLatencyMs: { p50: ms(pct(latencies, 50)), p95: ms(pct(latencies, 95)), max: ms(Math.max(...latencies)) },
      note: 'in-process pipeline (validation, normalization, redaction, quota, bounded idempotent insert), JSON OTLP bodies pre-built; excludes HTTP and TLS',
    },
    storage: stats ? { dataMiB: Math.round(stats.size / 2 ** 20), storageMiB: Math.round(stats.storageSize / 2 ** 20), indexMiB: Math.round(stats.totalIndexSize / 2 ** 20), avgObjBytes: Math.round(stats.avgObjSize) } : null,
    queries,
    mixedLoad: { durationSec: 4, ingestRecordsPerSecond: Math.round(ingestDuringReads / 4), concurrentReaders: 8, readerQueriesCompleted: readerLat.length, readerLatencyMs: { p50: ms(pct(readerLat, 50)), p95: ms(pct(readerLat, 95)) } },
    caveats: ['single mongod, in-memory-server defaults, same machine as the load generator', 'regex text search scans the time-bounded index range: cost grows with the range'],
  };
  console.log(JSON.stringify(report, null, 2));
  const out = resolve(process.cwd(), '../../docs/performance-results.json');
  mkdirSync(resolve(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify({ ...report, measuredAt: new Date().toISOString() }, null, 2));
  await db.close();
  await mongo.stop();
}
main().catch((e) => { console.error(e); process.exit(1); });
