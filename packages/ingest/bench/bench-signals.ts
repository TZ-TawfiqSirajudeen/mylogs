/**
 * Repeatable TRACE + METRIC benchmark against a real mongod (WiredTiger) on this machine.
 *   pnpm --filter @nexus/ingest bench:signals          (default: 20,000 traces ≈ 240k spans; 600 metric series × 3 h at 10 s)
 *   BENCH_TRACES=5000 BENCH_METRIC_HOURS=1 pnpm --filter @nexus/ingest bench:signals
 * Prints a JSON report and writes docs/performance-traces-metrics.json. It measures THIS machine and THIS in-memory-server configuration:
 * evidence for the numbers it prints, not a capacity guarantee. Ingestion goes through the in-process pipelines (validate → normalize →
 * redact → quota → bounded, retried, idempotent write); HTTP/TLS are NOT included.
 *
 * TARGETS (written down BEFORE the first measurement; see docs/performance-traces-metrics.md):
 *   spans ingest >= 5,000/s · metric points ingest >= 5,000/s · trace lookup p95 < 50 ms · 12-span waterfall load p95 < 50 ms ·
 *   400-span waterfall load p95 < 100 ms · recent / filtered trace search p95 < 250 ms · slowest-first search p95 < 500 ms ·
 *   per-service span stats (6 h) p95 < 1,500 ms · dependencies (6 h) p95 < 1,500 ms · metric query (3 h, grouped) p95 < 500 ms ·
 *   HTTP service overview (3 h) p95 < 1,000 ms
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { MetricQuery, TraceQuery } from '@nexus/contracts';
import { AuditService, type Database } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import { MongoMetricStore } from '@nexus/metricstore';
import { MongoTraceStore, type TraceStore } from '@nexus/tracestore';
import { DEFAULT_INGEST_CONFIG, IngestTokenService, MetricPipeline, TokenCreate, TracePipeline } from '../src/index.js';

const N_TRACES = Number(process.env.BENCH_TRACES ?? 20_000);
const METRIC_HOURS = Number(process.env.BENCH_METRIC_HOURS ?? 3);
const BATCH_TRACES = 80;
const CONCURRENCY = 4;
const ORG = 'org-b', PROJECT = 'proj-b', ENV = 'env-b';
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;
const ms = (n: number) => Math.round(n * 10) / 10;
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const nsOf = (t: number, frac = 0) => String(BigInt(Math.round(t)) * 1_000_000n + BigInt(frac));

async function main() {
  const mongo = await startTestMongo();
  const db: Database = await freshTestDatabase(mongo.uri);
  await db.c.environments.insertOne({ _id: ENV, orgId: ORG, projectId: PROJECT, slug: 'b', name: 'B', isProduction: false, createdAt: new Date() });
  const tokens = new IngestTokenService(db, new AuditService(db));
  const { token } = await tokens.create({ orgId: ORG, projectId: PROJECT, environmentIds: null }, ENV, { userId: 'bench', ctx: { requestId: 'bench-000001' } }, TokenCreate.parse({ name: 'bench', retentionDays: 30 }));
  const tok = (await tokens.authenticate(token))!;
  const cfg = { ...DEFAULT_INGEST_CONFIG, tokenRecordsPerMinute: 1e9, projectRecordsPerMinute: 1e9, maxInflightWrites: CONCURRENCY, maxQueuedWrites: 1000 };
  const traceStore = new MongoTraceStore(db);
  const traces = new TracePipeline(db, traceStore, cfg);
  const metricStore = new MongoMetricStore(db);
  const metrics = new MetricPipeline(db, metricStore, cfg);
  const scope = { orgId: ORG, projectId: PROJECT, environmentIds: [ENV] };

  // ---------------------------------------------------------------- memory sampling
  let peakRss = 0, peakHeap = 0;
  const sampler = setInterval(() => { const m = process.memoryUsage(); peakRss = Math.max(peakRss, m.rss); peakHeap = Math.max(peakHeap, m.heapUsed); }, 200);

  // ---------------------------------------------------------------- trace generator: ~12 spans per trace across 3 services
  const SERVICES = ['gateway', 'orders', 'inventory', 'payments', 'auth', 'search', 'email', 'worker'];
  const now = Date.now();
  const spanWindow = 6 * 3600_000;
  const attr = (k: string, v: string | number) => ({ key: k, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v } });
  let spansTotal = 0;
  function genTrace(i: number) {
    const trace = md5(`t${i}`);
    const start = now - 60_000 - Math.floor((i / N_TRACES) * (spanWindow - 120_000));
    const failing = i % 20 === 0;
    // Realistic shape: most traces have 12-20 spans; 1% are large (300-420 spans).
    const extra = i % 100 === 0 ? 300 + (i % 7) * 20 : i % 9;
    const total = 12 + extra;
    const dur = 60 + (i % 400);
    const sid = (n: number) => md5(`s${i}-${n}`).slice(0, 16);
    const out: Record<string, { span: object; service: string }[]> = {};
    const add = (service: string, span: object) => { (out[service] ??= []).push({ span, service }); spansTotal++; };
    const base = { traceId: trace };
    add('gateway', { ...base, spanId: sid(1), name: 'GET /orders/:id', kind: 2, startTimeUnixNano: nsOf(start, 111), endTimeUnixNano: nsOf(start + dur, 222), status: failing ? { code: 2, message: 'upstream failed' } : { code: 0 },
      attributes: [attr('http.request.method', 'GET'), attr('http.route', '/orders/:id'), attr('http.response.status_code', failing ? 500 : 200)] });
    add('gateway', { ...base, spanId: sid(2), parentSpanId: sid(1), name: 'GET orders', kind: 3, startTimeUnixNano: nsOf(start + 2), endTimeUnixNano: nsOf(start + dur - 2), attributes: [attr('server.address', 'orders')] });
    add('orders', { ...base, spanId: sid(3), parentSpanId: sid(2), name: 'GET /internal/orders', kind: 2, startTimeUnixNano: nsOf(start + 4), endTimeUnixNano: nsOf(start + dur - 4), attributes: [attr('http.route', '/internal/orders'), attr('http.response.status_code', failing ? 500 : 200)] });
    for (let k = 0; k < 3; k++) {
      add('orders', { ...base, spanId: sid(10 + k), parentSpanId: sid(3), name: k === 0 ? 'orders.find' : k === 1 ? 'cache.get' : 'orders.enrich', kind: k === 2 ? 1 : 3, startTimeUnixNano: nsOf(start + 6 + k * 3), endTimeUnixNano: nsOf(start + 12 + k * 3),
        attributes: k === 2 ? [] : [attr('db.system', k === 0 ? 'mongodb' : 'redis')], ...(failing && k === 0 ? { status: { code: 2, message: 'timeout' }, events: [{ name: 'exception', timeUnixNano: nsOf(start + 11), attributes: [attr('exception.type', 'TimeoutError'), attr('exception.stacktrace', 'TimeoutError: x\n at a (a.js:1)')] }] } : {}) });
    }
    add('orders', { ...base, spanId: sid(20), parentSpanId: sid(3), name: 'GET inventory', kind: 3, startTimeUnixNano: nsOf(start + 10), endTimeUnixNano: nsOf(start + 40), attributes: [] });
    add('inventory', { ...base, spanId: sid(21), parentSpanId: sid(20), name: 'GET /stock/:sku', kind: 2, startTimeUnixNano: nsOf(start + 12), endTimeUnixNano: nsOf(start + 38), attributes: [attr('http.route', '/stock/:sku')] });
    for (let k = 0; k < 4; k++) add('inventory', { ...base, spanId: sid(30 + k), parentSpanId: sid(21), name: `stock.query.${k}`, kind: 3, startTimeUnixNano: nsOf(start + 14 + k * 4), endTimeUnixNano: nsOf(start + 17 + k * 4), attributes: [attr('db.system', 'mongodb')] });
    for (let k = 0; k < extra; k++) add(SERVICES[(k % 5) + 3]!, { ...base, spanId: sid(100 + k), parentSpanId: sid(3), name: `step.${k % 17}`, kind: 1, startTimeUnixNano: nsOf(start + 20 + (k % 30)), endTimeUnixNano: nsOf(start + 22 + (k % 30)), attributes: [] });
    return out;
  }
  const payloadFor = (from: number, to: number) => {
    const per: Record<string, object[]> = {};
    for (let i = from; i < Math.min(to, N_TRACES); i++) for (const [svc, list] of Object.entries(genTrace(i))) (per[svc] ??= []).push(...list.map((x) => x.span));
    return { resourceSpans: Object.entries(per).map(([service, spans]) => ({ resource: { attributes: [attr('service.name', service), attr('service.version', '1.0.0'), attr('host.name', `host-${service}`)] }, scopeSpans: [{ scope: { name: 'bench' }, spans }] })) };
  };

  // ---------------------------------------------------------------- trace ingestion
  const batches = Math.ceil(N_TRACES / BATCH_TRACES);
  let next = 0, accepted = 0, rejected = 0;
  const lat: number[] = [];
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const b = next++;
      if (b >= batches) return;
      const payload = payloadFor(b * BATCH_TRACES, (b + 1) * BATCH_TRACES);
      const s = performance.now();
      const o = await traces.handle(tok, { payload, bodyBytes: 1000, bodyHash: md5(`b${b}`) });
      lat.push(performance.now() - s);
      if (o.status !== 'ok') throw new Error(`trace ingest failed: ${JSON.stringify(o)}`);
      accepted += o.accepted; rejected += o.rejected;
    }
  }));
  const ingestSec = (performance.now() - t0) / 1000;
  const spanCount = await db.c.spans.countDocuments({});
  const traceCount = await db.c.traceSummaries.countDocuments({});

  // ---------------------------------------------------------------- queries
  const time = async (name: string, fn: () => Promise<unknown>, runs = 15) => {
    await fn();
    const xs: number[] = [];
    for (let i = 0; i < runs; i++) { const s = performance.now(); await fn(); xs.push(performance.now() - s); }
    return { name, p50: ms(pct(xs, 50)), p95: ms(pct(xs, 95)), max: ms(Math.max(...xs)), runs };
  };
  const range = (minutes: number, over: object = {}) => TraceQuery.parse({ from: new Date(now - minutes * 60_000).toISOString(), to: new Date(now + 60_000).toISOString(), ...over });
  const anyTrace = (await db.c.traceSummaries.find({ spanCount: { $gte: 12, $lte: 40 } }).limit(1).next())!;
  const bigTrace = (await db.c.traceSummaries.find({ spanCount: { $gte: 300 } }).sort({ spanCount: -1 }).limit(1).next())!;
  const traceQueries = [
    await time('trace lookup by id (getTrace, ~20-40 spans)', () => traceStore.getTrace(scope, anyTrace.traceId)),
    await time(`waterfall load of a large trace (${bigTrace.spanCount} spans)`, () => traceStore.getTrace(scope, bigTrace.traceId, 5000), 10),
    await time('search: newest 50 (6 h)', () => traceStore.search(scope, range(360))),
    await time('search: errors only (6 h)', () => traceStore.search(scope, range(360, { errorsOnly: true }))),
    await time('search: one service (6 h)', () => traceStore.search(scope, range(360, { services: ['inventory'] }))),
    await time('search: HTTP status 500 (6 h)', () => traceStore.search(scope, range(360, { httpStatus: 500 }))),
    await time('search: db system = redis (6 h)', () => traceStore.search(scope, range(360, { dbSystem: 'redis' }))),
    await time('search: duration >= 300 ms (6 h)', () => traceStore.search(scope, range(360, { minDurationMs: 300 }))),
    await time('search: span name contains "orders.find" (6 h)', () => traceStore.search(scope, range(360, { spanName: 'orders.find' })), 8),
    await time('search: by trace id', () => traceStore.search(scope, range(360, { traceId: anyTrace.traceId }))),
    await time('search: slowest first (6 h)', () => traceStore.search(scope, range(360, { sort: 'slowest' }))),
    await time('deep page (cursor after 1,000 traces)', async () => { let c: string | undefined; for (let i = 0; i < 1; i++) c = (await traceStore.search(scope, range(360, { limit: 200, cursor: c }))).nextCursor ?? c; return traceStore.search(scope, range(360, { limit: 50, cursor: c })); }),
    await time('per-service SERVER span statistics (6 h, all spans)', () => traceStore.serverSpanStats(scope, new Date(now - 6 * 3600_000), new Date(now + 60_000)), 5),
    await time('observed dependencies (6 h)', () => traceStore.dependencies(scope, new Date(now - 6 * 3600_000), new Date(now + 60_000)), 5),
    await time('server span timeline (6 h, 6-minute windows)', () => traceStore.serverSpanTimeline(scope, new Date(now - 6 * 3600_000), new Date(now + 60_000), 360_000), 5),
  ];

  // ---------------------------------------------------------------- concurrent readers while ingesting traces
  let ingestedDuring = 0;
  const readerLat: number[] = [];
  const mixedStart = performance.now();
  const writerReal = (async () => {
    let b = 0;
    while (performance.now() < mixedStart + 5000) {
      // late-arriving spans of existing traces (exercises summary recompute under read load)
      const payload = payloadFor((b * 7) % (N_TRACES - 10), (b * 7) % (N_TRACES - 10) + 8); b++;
      const o = await traces.handle(tok, { payload, bodyBytes: 1, bodyHash: md5(`late${b}`) });
      ingestedDuring += o.accepted + o.duplicates;
    }
  })();
  const readers = Array.from({ length: 8 }, async () => { while (performance.now() < mixedStart + 5000) { const s = performance.now(); await traceStore.search(scope, range(360, { errorsOnly: true })); readerLat.push(performance.now() - s); } });
  await Promise.all([writerReal, ...readers]);

  // ---------------------------------------------------------------- backpressure and recovery
  const small = new TracePipeline(db, traceStore, { ...cfg, maxInflightWrites: 1, maxQueuedWrites: 0 });
  const bpResults = await Promise.all(Array.from({ length: 8 }, (_, i) => small.handle(tok, { payload: payloadFor(i * 5, i * 5 + 5), bodyBytes: 1, bodyHash: md5(`bp${i}${Math.random()}`) })));
  const backpressure = { concurrentRequests: 8, accepted: bpResults.filter((r) => r.status === 'ok').length, refused503: bpResults.filter((r) => r.status === 'overloaded').length };
  let failing = true;
  const flaky: TraceStore = { ...traceStore, search: traceStore.search.bind(traceStore), getTrace: traceStore.getTrace.bind(traceStore), getSpan: traceStore.getSpan.bind(traceStore), knownTraces: traceStore.knownTraces.bind(traceStore),
    serverSpanStats: traceStore.serverSpanStats.bind(traceStore), serverSpanTimeline: traceStore.serverSpanTimeline.bind(traceStore), dependencies: traceStore.dependencies.bind(traceStore),
    insert: async (d) => { if (failing) throw new Error('storage unavailable'); return traceStore.insert(d); } };
  const recoverPipe = new TracePipeline(db, flaky, { ...cfg, storeRetries: 0 });
  const outageStart = performance.now();
  setTimeout(() => { failing = false; }, 2000);
  let outageRefused = 0, recoveredAfterMs = -1, lost = 0;
  const batchesToSend = Array.from({ length: 10 }, (_, i) => payloadFor(N_TRACES - 100 - i * 3, N_TRACES - 100 - i * 3 + 3));
  for (const [i, payload] of batchesToSend.entries()) {
    for (;;) {
      const o = await recoverPipe.handle(tok, { payload, bodyBytes: 1, bodyHash: md5(`rec${i}`) });
      if (o.status === 'ok') { if (recoveredAfterMs < 0) recoveredAfterMs = performance.now() - outageStart; break; }
      outageRefused++;
      await new Promise((r) => setTimeout(r, 250)); // a sender honouring Retry-After
      if (performance.now() - outageStart > 30_000) { lost++; break; }
    }
  }
  const recovery = { outageMs: 2000, refusedWhileDown: outageRefused, firstSuccessAfterMs: Math.round(recoveredAfterMs), batchesLost: lost, batchesSent: batchesToSend.length };

  // ---------------------------------------------------------------- METRICS
  const routes = ['/orders/:id', '/pay', '/cart', '/login', '/search'];
  const statuses = ['200', '404', '500', '503'];
  const instances = 3;
  const mservices = Array.from({ length: 10 }, (_, i) => `svc-${i}`);
  const tick = 10_000;
  const ticks = Math.floor((METRIC_HOURS * 3600_000) / tick);
  const seriesCount = mservices.length * routes.length * statuses.length * instances;
  const mStart = now - METRIC_HOURS * 3600_000;
  const bounds = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
  // Each concurrent writer plays one exporter FLEET: it owns a distinct set of services and walks the ticks in order, exactly as real exporters
  // do (a series is only ever written by its own exporter, in time order). Several writers contending for the SAME series would not be realistic.
  const metricPayload = (t: number, writer: number) => ({
    resourceMetrics: mservices.filter((_, idx) => idx % CONCURRENCY === writer).flatMap((service) => Array.from({ length: instances }, (_, inst) => ({
      resource: { attributes: [attr('service.name', service), attr('service.instance.id', `${service}-${inst}`)] },
      scopeMetrics: [{ metrics: [{
        name: 'http.server.request.duration', unit: 's',
        histogram: { aggregationTemporality: 1, dataPoints: routes.flatMap((route, ri) => statuses.map((st, si) => {
          const n = 1 + ((t + ri + si) % 9);
          const b = bounds.map((_, k) => (k === (ri + si) % bounds.length ? n : (k + t) % 3 === 0 ? 1 : 0)).concat([0]);
          return { timeUnixNano: nsOf(mStart + t * tick), count: String(b.reduce((a, c) => a + c, 0)), sum: 0.3 * n, bucketCounts: b.map(String), explicitBounds: bounds, attributes: [attr('http.route', route), attr('http.response.status_code', st), attr('http.request.method', 'GET')] };
        })) },
      }] }],
    }))),
  });
  let mAccepted = 0;
  const mLat: number[] = [];
  const m0 = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async (_, writer) => {
    for (let t = 0; t < ticks; t++) {
      const s = performance.now();
      const o = await metrics.handle(tok, { payload: metricPayload(t, writer), bodyBytes: 1000, bodyHash: md5(`m${t}-${writer}`) });
      mLat.push(performance.now() - s);
      if (o.status !== 'ok') throw new Error(`metric ingest failed: ${JSON.stringify(o)}`);
      mAccepted += o.accepted;
    }
  }));
  const mSec = (performance.now() - m0) / 1000;
  const mq = (over: object) => MetricQuery.parse({ from: new Date(mStart).toISOString(), to: new Date(now).toISOString(), metric: 'http.server.request.duration', ...over });
  const metricQueries = [
    await time('metric catalogue (names)', () => metricStore.names(scope), 10),
    await time('label values (labels)', () => metricStore.labels(scope, 'http.server.request.duration'), 10),
    await time('p95 by route, one service (3 h)', () => metricStore.query(scope, mq({ agg: 'p95', service: 'svc-1', groupBy: ['http.route'] })), 8),
    await time('request rate, all services, by service (3 h)', () => metricStore.query(scope, mq({ agg: 'rate', groupBy: ['service'] })), 5),
    await time('p99 across everything (3 h)', () => metricStore.query(scope, mq({ agg: 'p99' })), 5),
    await time('HTTP service overview (3 h)', () => metricStore.httpOverview(scope, new Date(mStart), new Date(now)), 5),
    await time('diagnostics', () => metricStore.diagnostics(scope), 5),
  ];
  const guarded = await metricStore.query(scope, mq({ agg: 'count', groupBy: ['http.route', 'http.response.status_code'] }));

  clearInterval(sampler);
  const stats = async (c: string) => db.db.command({ collStats: c }).catch(() => null);
  const [sSpans, sSum, sPts, sSer] = await Promise.all([stats('spans'), stats('trace_summaries'), stats('metric_points'), stats('metric_series')]);
  const mib = (n: number | undefined) => (n === undefined ? null : Math.round(n / 2 ** 20 * 10) / 10);
  const report = {
    machine: { cpus: cpus().length, cpuModel: cpus()[0]?.model, memGiB: Math.round(totalmem() / 2 ** 30), node: process.version },
    targets: 'see the header of packages/ingest/bench/bench-signals.ts (written before the first run)',
    traceDataset: { traces: traceCount, spans: spanCount, spansAcceptedByPipeline: accepted, rejected, spanWindowHours: 6, avgSpansPerTrace: Math.round(spanCount / traceCount) },
    traceIngestion: { spansPerSecond: Math.round(accepted / ingestSec), seconds: ms(ingestSec), requestSpansApprox: Math.round(accepted / batches), concurrency: CONCURRENCY, batchLatencyMs: { p50: ms(pct(lat, 50)), p95: ms(pct(lat, 95)), max: ms(Math.max(...lat)) }, includesSummaryRecompute: true },
    traceQueries,
    traceMixedLoad: { durationSec: 5, ingestedSpansPerSecond: Math.round(ingestedDuring / 5), concurrentReaders: 8, readerQueries: readerLat.length, readerLatencyMs: { p50: ms(pct(readerLat, 50)), p95: ms(pct(readerLat, 95)) } },
    backpressure, recovery,
    metricDataset: { series: seriesCount, hours: METRIC_HOURS, intervalSeconds: tick / 1000, dataPoints: mAccepted, instancesPerService: instances },
    metricIngestion: { pointsPerSecond: Math.round(mAccepted / mSec), seconds: ms(mSec), requests: ticks * CONCURRENCY, pointsPerRequest: Math.round(seriesCount / CONCURRENCY), concurrency: CONCURRENCY, model: 'each writer = one exporter fleet owning distinct services, ticks in order', requestLatencyMs: { p50: ms(pct(mLat, 50)), p95: ms(pct(mLat, 95)), max: ms(Math.max(...mLat)) } },
    metricQueries, metricGroupedQueryResultSeries: guarded.series.length,
    storage: {
      spans: { docs: spanCount, dataMiB: mib(sSpans?.size), storageMiB: mib(sSpans?.storageSize), indexMiB: mib(sSpans?.totalIndexSize), bytesPerSpanOnDisk: sSpans ? Math.round(sSpans.storageSize / spanCount) : null },
      traceSummaries: { docs: traceCount, storageMiB: mib(sSum?.storageSize), indexMiB: mib(sSum?.totalIndexSize) },
      metricPoints: { docs: await db.c.metricPoints.countDocuments({}), storageMiB: mib(sPts?.storageSize), indexMiB: mib(sPts?.totalIndexSize) },
      metricSeries: { docs: await db.c.metricSeries.countDocuments({}), storageMiB: mib(sSer?.storageSize) },
    },
    memory: { peakRssMiB: Math.round(peakRss / 2 ** 20), peakHeapUsedMiB: Math.round(peakHeap / 2 ** 20), note: 'the Node process generating load AND running the pipelines (mongod runs separately and is not included)' },
    caveats: ['single mongod, in-memory-server defaults, same machine as the load generator', 'in-process pipelines: HTTP/TLS excluded', 'summary recompute runs inside every trace write (included in ingestion figures)'],
  };
  console.log(JSON.stringify(report, null, 2));
  const out = resolve(process.cwd(), '../../docs/performance-traces-metrics.json');
  mkdirSync(resolve(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify({ ...report, measuredAt: new Date().toISOString() }, null, 2));
  await db.close();
  await mongo.stop();
}
main().catch((e) => { console.error(e); process.exit(1); });
