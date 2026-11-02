/**
 * Longer-window benchmark for traces and metrics (24 h and 7 d). Companion of bench-signals.ts (which fixes the targets for 3 h / 6 h windows).
 *   pnpm --filter @nexus/ingest exec tsx bench/bench-windows.ts
 *   BENCH_WIN_TRACES=20000 (traces in the base 6 h; the 24 h dataset repeats them 4x)   BENCH_WIN_SKIP_TRACES=1 / BENCH_WIN_SKIP_METRICS=1
 * Writes docs/performance-traces-metrics.windows.json.
 *
 * ROUND 3 (metric rollups, ADR-0007): the metric part builds the rollups of the cloned data with the real compactor (a full rebuild: timed, sized; BENCH_WIN_ROLLUPS=0
 * skips it) and then runs every metric query BOTH ways on the same data in the same process, back to back per query: "before" = a store that reads minute
 * documents only (the code path before rollups), "after" = the shipped planner. BENCH_WIN_FULL7D=1 clones ALL 600 series for 7 d (6.05 million minute
 * documents) instead of only the 60 series of one service. BENCH_WIN_RUNS=9 (runs per cheap query), BENCH_WIN_TAG=run1 names the output:
 *   BENCH_WIN_SKIP_TRACES=1 BENCH_WIN_FULL7D=1 BENCH_WIN_TAG=run1 pnpm --filter @nexus/ingest exec tsx bench/bench-windows.ts
 *   -> docs/performance-traces-metrics.round3-windows-run1.json   (the trace part is untouched by rollups: skip it)
 *
 * HOW THE DATA IS BUILT (stated in the output too, because it matters for reading the numbers):
 *  - the BASE data goes through the real pipelines (6 h of spans; 1 h of metrics: 600 series, 10 s interval);
 *  - longer windows are made by CLONING the stored documents backwards in time (new ids, shifted timestamps; traces get new trace ids). Cloned spans
 *    have no trace_summaries (the statistics, timeline and dependency queries read spans only). Cloned minute documents are identical in shape to
 *    ingested ones. Seeding 24 h / 7 d through the pipelines would take hours at the measured ingest rate.
 *  - metrics: all 600 series for 24 h (864,000 minute documents); the 60 series of ONE service for 7 d (604,800 documents). 600 series for 7 d
 *    (about 6 million documents, ~2.7 GB) was NOT built: it does not fit this test server, and the production guard refuses it anyway.
 * Each query is run with the PRODUCTION scan guard (250,000 stored minute documents: the answer is a refusal when the window is too big) and with the
 * guard raised, which measures what the query would cost if it were allowed.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { MetricQuery } from '@nexus/contracts';
import { AuditService, type Database } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import { MetricQueryError, MetricRollupCompactor, MongoMetricStore, type Piece } from '@nexus/metricstore';
import type { MetricPointDraft } from '@nexus/telemetry';
import { MongoTraceStore } from '@nexus/tracestore';
import { DEFAULT_INGEST_CONFIG, IngestTokenService, TokenCreate, TracePipeline } from '../src/index.js';

const N_TRACES = Number(process.env.BENCH_WIN_TRACES ?? 20_000);
const SKIP_TRACES = process.env.BENCH_WIN_SKIP_TRACES === '1', SKIP_METRICS = process.env.BENCH_WIN_SKIP_METRICS === '1';
const ROLLUPS = process.env.BENCH_WIN_ROLLUPS !== '0', FULL7D = process.env.BENCH_WIN_FULL7D === '1', TAG = process.env.BENCH_WIN_TAG ?? 'run';
const CONCURRENCY = 4, BATCH_TRACES = 80;
const ORG = 'org-w', PROJECT = 'proj-w', ENV = 'env-w';
const HOUR = 3_600_000;
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const ms = (n: number) => Math.round(n * 10) / 10;
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]!;
const nsOf = (t: number, frac = 0) => String(BigInt(Math.round(t)) * 1_000_000n + BigInt(frac));
const attr = (k: string, v: string | number) => ({ key: k, value: typeof v === 'number' ? { intValue: String(v) } : { stringValue: v } });
const mib = (n: number | undefined) => (n === undefined ? null : Math.round((n / 2 ** 20) * 10) / 10);
const INTERACTIVE_MS = 2000;

interface Timing { p50: number; p95: number; min: number; max: number; runs: number }
interface Result { name: string; window: string; docsInWindow?: number; guard: 'refused' | 'allowed' | 'n/a'; refusal?: string; p50?: number; p95?: number; max?: number; runs?: number; interactive?: boolean | null; before?: Timing | null; beforeNote?: string; after?: Timing; guardAfter?: 'refused' | 'allowed'; readsAfter?: string; interactiveAfter?: boolean }

async function main() {
  const mongo = await startTestMongo();
  const db: Database = await freshTestDatabase(mongo.uri);
  await db.c.environments.insertOne({ _id: ENV, orgId: ORG, projectId: PROJECT, slug: 'w', name: 'W', isProduction: false, createdAt: new Date() });
  const tokens = new IngestTokenService(db, new AuditService(db));
  const { token } = await tokens.create({ orgId: ORG, projectId: PROJECT, environmentIds: null }, ENV, { userId: 'bench', ctx: { requestId: 'bench-000002' } }, TokenCreate.parse({ name: 'bench', retentionDays: 30 }));
  const tok = (await tokens.authenticate(token))!;
  const cfg = { ...DEFAULT_INGEST_CONFIG, tokenRecordsPerMinute: 1e9, projectRecordsPerMinute: 1e9, maxInflightWrites: CONCURRENCY, maxQueuedWrites: 1000 };
  const scope = { orgId: ORG, projectId: PROJECT, environmentIds: [ENV] };
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const traceStore = new MongoTraceStore(db);
  const guarded = new MongoMetricStore(db);                                   // production limits
  // "before": minute documents only, guard raised: the cost the guard protects against (what Rounds 1 and 2 measured)
  const legacyStep = (f: Date, t: Date) => Math.max(60_000, Math.ceil((t.getTime() - f.getTime()) / 400 / 60_000) * 60_000); // the Round 2 overview timeline
  const raised = new MongoMetricStore(db, { maxPointDocsScanned: 50_000_000, rollups: false, overviewStep: legacyStep });
  const report: Record<string, unknown> = {
    machine: { cpus: cpus().length, cpuModel: cpus()[0]?.model, memGiB: Math.round(totalmem() / 2 ** 30), node: process.version },
    method: 'base data through the real pipelines; longer windows by cloning stored documents backwards in time (see the header of bench/bench-windows.ts)',
    interactiveThresholdMs: INTERACTIVE_MS,
  };

  const timeIt = async (fn: () => Promise<unknown>, runs: number, warm = true) => {
    if (warm) await fn();
    const xs: number[] = [];
    for (let i = 0; i < runs; i++) { const s = performance.now(); await fn(); xs.push(performance.now() - s); if (xs[0]! > 20_000) break; }
    return { p50: ms(pct(xs, 50)), p95: ms(pct(xs, 95)), min: ms(Math.min(...xs)), max: ms(Math.max(...xs)), runs: xs.length };
  };

  // =============================================================== TRACES
  if (!SKIP_TRACES) {
    const traces = new TracePipeline(db, traceStore, cfg);
    const SERVICES = ['gateway', 'orders', 'inventory', 'payments', 'auth', 'search', 'email', 'worker'];
    const spanWindow = 6 * HOUR;
    function genTrace(i: number) {
      const trace = md5(`t${i}`);
      const start = now - 60_000 - Math.floor((i / N_TRACES) * (spanWindow - 120_000));
      const failing = i % 20 === 0;
      const extra = i % 100 === 0 ? 300 + (i % 7) * 20 : i % 9;
      const dur = 60 + (i % 400);
      const sid = (n: number) => md5(`s${i}-${n}`).slice(0, 16);
      const out: Record<string, object[]> = {};
      const add = (service: string, span: object) => { (out[service] ??= []).push(span); };
      const base = { traceId: trace };
      add('gateway', { ...base, spanId: sid(1), name: 'GET /orders/:id', kind: 2, startTimeUnixNano: nsOf(start, 111), endTimeUnixNano: nsOf(start + dur, 222), status: failing ? { code: 2, message: 'upstream failed' } : { code: 0 },
        attributes: [attr('http.request.method', 'GET'), attr('http.route', '/orders/:id'), attr('http.response.status_code', failing ? 500 : 200)] });
      add('gateway', { ...base, spanId: sid(2), parentSpanId: sid(1), name: 'GET orders', kind: 3, startTimeUnixNano: nsOf(start + 2), endTimeUnixNano: nsOf(start + dur - 2), attributes: [attr('server.address', 'orders')] });
      add('orders', { ...base, spanId: sid(3), parentSpanId: sid(2), name: 'GET /internal/orders', kind: 2, startTimeUnixNano: nsOf(start + 4), endTimeUnixNano: nsOf(start + dur - 4), attributes: [attr('http.route', '/internal/orders'), attr('http.response.status_code', failing ? 500 : 200)] });
      for (let k = 0; k < 3; k++) add('orders', { ...base, spanId: sid(10 + k), parentSpanId: sid(3), name: k === 0 ? 'orders.find' : k === 1 ? 'cache.get' : 'orders.enrich', kind: k === 2 ? 1 : 3, startTimeUnixNano: nsOf(start + 6 + k * 3), endTimeUnixNano: nsOf(start + 12 + k * 3), attributes: k === 2 ? [] : [attr('db.system', k === 0 ? 'mongodb' : 'redis')] });
      add('orders', { ...base, spanId: sid(20), parentSpanId: sid(3), name: 'GET inventory', kind: 3, startTimeUnixNano: nsOf(start + 10), endTimeUnixNano: nsOf(start + 40), attributes: [] });
      add('inventory', { ...base, spanId: sid(21), parentSpanId: sid(20), name: 'GET /stock/:sku', kind: 2, startTimeUnixNano: nsOf(start + 12), endTimeUnixNano: nsOf(start + 38), attributes: [attr('http.route', '/stock/:sku')] });
      for (let k = 0; k < 4; k++) add('inventory', { ...base, spanId: sid(30 + k), parentSpanId: sid(21), name: `stock.query.${k}`, kind: 3, startTimeUnixNano: nsOf(start + 14 + k * 4), endTimeUnixNano: nsOf(start + 17 + k * 4), attributes: [attr('db.system', 'mongodb')] });
      for (let k = 0; k < extra; k++) add(SERVICES[(k % 5) + 3]!, { ...base, spanId: sid(100 + k), parentSpanId: sid(3), name: `step.${k % 17}`, kind: 1, startTimeUnixNano: nsOf(start + 20 + (k % 30)), endTimeUnixNano: nsOf(start + 22 + (k % 30)), attributes: [] });
      return out;
    }
    const payloadFor = (from: number, to: number) => {
      const per: Record<string, object[]> = {};
      for (let i = from; i < Math.min(to, N_TRACES); i++) for (const [svc, spans] of Object.entries(genTrace(i))) (per[svc] ??= []).push(...spans);
      return { resourceSpans: Object.entries(per).map(([service, spans]) => ({ resource: { attributes: [attr('service.name', service), attr('service.version', '1.0.0'), attr('host.name', `host-${service}`)] }, scopeSpans: [{ scope: { name: 'bench' }, spans }] })) };
    };
    const batches = Math.ceil(N_TRACES / BATCH_TRACES);
    let next = 0;
    const t0 = performance.now();
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      for (;;) {
        const b = next++; if (b >= batches) return;
        const o = await traces.handle(tok, { payload: payloadFor(b * BATCH_TRACES, (b + 1) * BATCH_TRACES), bodyBytes: 1000, bodyHash: md5(`b${b}`) });
        if (o.status !== 'ok') throw new Error(JSON.stringify(o));
      }
    }));
    const baseSpans = await db.c.spans.countDocuments({});
    console.log(`traces: ${baseSpans} spans ingested for 6 h in ${Math.round((performance.now() - t0) / 1000)} s`);

    // clone 3 more 6 h blocks backwards: 24 h at the same density
    const tc = performance.now();
    for (let k = 1; k <= 3; k++) {
      const shift = k * spanWindow;
      const cur = db.c.spans.find({ bench: { $exists: false } } as never).batchSize(5000);
      let buf: unknown[] = [];
      for await (const d of cur) {
        const traceId = md5(`${d.traceId}#${k}`);
        buf.push({
          ...d, _id: sha1(`${PROJECT}|${ENV}|${traceId}|${d.spanId}`), traceId, start: new Date(d.start.getTime() - shift), end: new Date(d.end.getTime() - shift), receivedAt: new Date(d.receivedAt.getTime() - shift),
          expireAt: new Date(d.expireAt.getTime() - shift), events: d.events.map((e) => ({ ...e, ts: new Date(e.ts.getTime() - shift) })), bench: 'clone',
        });
        if (buf.length >= 5000) { await db.c.spans.insertMany(buf as never, { ordered: false }); buf = []; }
      }
      if (buf.length) await db.c.spans.insertMany(buf as never, { ordered: false });
    }
    const spans24 = await db.c.spans.countDocuments({});
    console.log(`traces: cloned to ${spans24} spans (24 h) in ${Math.round((performance.now() - tc) / 1000)} s`);
    const st = await db.db.command({ collStats: 'spans' });
    report.traceDataset = { baseSpans, spans24h: spans24, baseTraces: N_TRACES, density: `${Math.round(baseSpans / 6)} spans per hour`, storageMiB: mib(st.storageSize), indexMiB: mib(st.totalIndexSize), note: 'cloned spans have no trace summaries; 7 d windows contain the same 24 h of data (7 d at this density = about 11 million spans, not built)' };

    const rows: Result[] = [];
    const windows: [string, number][] = [['6 h', 6], ['24 h', 24], ['7 d', 168]];
    for (const [label, hours] of windows) {
      const from = new Date(now - hours * HOUR), to = new Date(now + 60_000);
      const docs = await db.c.spans.countDocuments({ start: { $gte: from, $lte: to }, kind: 'server' } as never);
      const stepMs = Math.max(60_000, Math.ceil((hours * HOUR) / 60 / 60_000) * 60_000);
      for (const [name, fn] of [
        ['per-service SERVER span statistics', () => traceStore.serverSpanStats(scope, from, to)],
        ['observed dependencies', () => traceStore.dependencies(scope, from, to)],
        [`server span timeline (${Math.round(stepMs / 60_000)}-minute windows)`, () => traceStore.serverSpanTimeline(scope, from, to, stepMs)],
      ] as [string, () => Promise<unknown>][]) {
        const t = await timeIt(fn, 3);
        rows.push({ name: name, window: label, docsInWindow: docs, guard: 'n/a', ...t, interactive: t.p95 < INTERACTIVE_MS });
        console.log(`trace  ${label.padEnd(5)} ${name.padEnd(48)} p50 ${String(t.p50).padStart(8)}  p95 ${String(t.p95).padStart(8)}  (${docs} server spans in window)`);
      }
    }
    report.traceQueries = rows;
    await db.c.spans.deleteMany({}); await db.c.traceSummaries.deleteMany({}); // free the test server before the metric datasets
  }

  // =============================================================== METRICS
  if (!SKIP_METRICS) {
    const routes = ['/orders/:id', '/pay', '/cart', '/login', '/search'], statuses = ['200', '404', '500', '503'];
    const services = Array.from({ length: 10 }, (_, i) => `svc-${i}`), tick = 10_000, instances = 3;
    const bounds = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
    const ticks = HOUR / tick, start = now - HOUR;
    const mctx = { orgId: ORG, projectId: PROJECT, environmentId: ENV, retentionMs: 30 * 86_400_000 };
    const t0 = performance.now();
    const PER = 18;
    for (let t = 0; t < ticks; t += PER) {
      const pts: MetricPointDraft[] = [];
      for (const svc of services) for (let inst = 0; inst < instances; inst++) for (let dt = 0; dt < Math.min(PER, ticks - t); dt++) {
        const tt = t + dt;
        routes.forEach((route, ri) => statuses.forEach((st, si) => {
          const n = 1 + ((tt + ri + si) % 9);
          const b = bounds.map((_, k) => (k === (ri + si) % bounds.length ? n : (k + tt) % 3 === 0 ? 1 : 0)).concat([0]);
          pts.push({ name: 'http.server.request.duration', unit: 's', description: null, type: 'histogram', temporality: 'delta', monotonic: null, service: svc, serviceVersion: null, instance: `${svc}-${inst}`,
            attrs: [{ k: 'http.route', v: route }, { k: 'http.response.status_code', v: st }, { k: 'http.request.method', v: 'GET' }], time: new Date(start + tt * tick), startTime: null, value: 0,
            count: b.reduce((a, c) => a + c, 0), sum: 0.3 * n, min: null, max: null, bounds, buckets: b, exemplars: [] });
        }));
      }
      await guarded.ingest(mctx, pts, new Date(now));
    }
    const baseDocs = await db.c.metricPoints.countDocuments({});
    console.log(`metrics: ${baseDocs} minute documents (1 h, 600 series) ingested in ${Math.round((performance.now() - t0) / 1000)} s`);

    const cloneHours = async (fromK: number, toK: number, filter: object) => {
      const src = await db.c.metricPoints.find({ ...filter, bench: { $exists: false } } as never).toArray();
      for (let k = fromK; k <= toK; k++) {
        const shift = k * HOUR;
        for (let i = 0; i < src.length; i += 20_000) {
          await db.c.metricPoints.insertMany(src.slice(i, i + 20_000).map((d) => ({ ...d, _id: `${d.seriesId}:${d.minute.getTime() - shift}`, minute: new Date(d.minute.getTime() - shift), expireAt: new Date(d.expireAt.getTime() - shift), bench: 'clone' })) as never, { ordered: false });
        }
      }
    };
    const tcl = performance.now();
    await cloneHours(1, 23, {});
    const svc1Ids = (await db.c.metricSeries.find({ service: 'svc-1' }).project({ _id: 1 }).toArray()).map((s) => s._id as string);
    if (FULL7D) await cloneHours(24, 167, {}); else await cloneHours(24, 167, { seriesId: { $in: svc1Ids }, minute: { $gte: new Date(start) } });
    const totalDocs = await db.c.metricPoints.countDocuments({});
    const sp = await db.db.command({ collStats: 'metric_points' });
    console.log(`metrics: cloned to ${totalDocs} minute documents in ${Math.round((performance.now() - tcl) / 1000)} s`);
    report.metricDataset = { series: 600, base: '1 h through the pipeline', allSeries24h: baseDocs * 24, oneService7d: svc1Ids.length * 60 * 168, allSeries7d: FULL7D, totalMinuteDocuments: totalDocs, dataMiB: mib(sp.size), storageMiB: mib(sp.storageSize), indexMiB: mib(sp.totalIndexSize), note: FULL7D ? 'all 600 series for 7 d (6.05 million minute documents)' : '600 series for 7 d (about 6.0 million documents) was not built' };

    // ---- Round 3: build the rollups of everything that was cloned, with the real compactor (the clones bypassed the write path, so a rebuild is requested)
    let lastPlan: Piece[] = [];
    const rolled = new MongoMetricStore(db, { maxPointDocsScanned: 50_000_000, onPlan: (g) => { lastPlan = g.flatMap((x) => x.pieces); } });
    const guardedRollups = new MongoMetricStore(db);
    const guardedMinutes = new MongoMetricStore(db, { rollups: false, overviewStep: legacyStep });
    if (ROLLUPS) {
      const compactor = new MetricRollupCompactor(db, { lagMs: 0, batch: 50 });
      await compactor.requestRebuild();
      const tb = performance.now();
      const rr = await compactor.runOnce(new Date(now + 60_000), 3 * 3_600_000);
      const sec = (performance.now() - tb) / 1000;
      const rs = await db.db.command({ collStats: 'metric_rollups' });
      const rolls = await db.c.metricRollups.countDocuments({});
      report.rollupBuild = {
        seconds: Math.round(sec * 10) / 10, minuteDocumentsRead: totalDocs, minuteDocumentsPerSecond: Math.round(totalDocs / sec), series: rr.claimed, buckets5m: rr.buckets5, buckets1h: rr.buckets60, rounds: rr.rounds,
        rollupDocuments: rolls, rollupDataMiB: mib(rs.size), rollupStorageMiB: mib(rs.storageSize), rollupIndexMiB: mib(rs.totalIndexSize), pendingAfter: await compactor.pending(new Date(now + 60_000)),
      };
      console.log(`rollups: built in ${Math.round(sec)} s (${Math.round(totalDocs / sec)} minute documents/s): ${rolls} rollup documents`);
    }

    const mq = (hours: number, over: object) => MetricQuery.parse({ from: new Date(now - hours * HOUR).toISOString(), to: new Date(now).toISOString(), metric: 'http.server.request.duration', ...over });
    const rows: Result[] = [];
    const run = async (name: string, label: string, hours: number, docs: number, fn: (s: MongoMetricStore) => Promise<unknown>, runs = 7, warm = true) => {
      let refusal: string | undefined, refusalAfter = false;
      try { await fn(guardedMinutes); } catch (e) { if (e instanceof MetricQueryError) refusal = e.message; else throw e; }
      try { await fn(guardedRollups); } catch (e) { if (e instanceof MetricQueryError) refusalAfter = true; else throw e; }
      // the minute-document path may exceed the store's own 8 s query timeout on the biggest windows: that IS the result ("cannot be answered"), not a failure of the run
      let before: Timing | null = null, beforeNote: string | undefined;
      try { before = await timeIt(() => fn(raised), runs, warm); } catch (e) { if ((e as { code?: number }).code === 50) beforeNote = 'exceeded the 8 s query timeout (maxTimeMS) with minute documents only'; else throw e; }
      let after: Timing | undefined, reads: string | undefined;
      if (ROLLUPS) {
        lastPlan = []; after = await timeIt(() => fn(rolled), runs, warm);
        const by = new Map<number, number>(); for (const p of lastPlan) by.set(p.tier, (by.get(p.tier) ?? 0) + 1);
        reads = [...by].sort((a, b) => b[0] - a[0]).map(([t, n]) => `${n}x ${t === 1 ? 'minute docs' : t === 60 ? '1 h rollups' : '5 min rollups'}`).join(', ');
      }
      rows.push({ name, window: label, docsInWindow: docs, guard: refusal ? 'refused' : 'allowed', ...(refusal ? { refusal: refusal.slice(0, 90) } : {}), ...(before ?? {}), interactive: before ? before.p95 < INTERACTIVE_MS : false, before, ...(beforeNote ? { beforeNote } : {}), ...(after ? { after, guardAfter: refusalAfter ? 'refused' : 'allowed', readsAfter: reads, interactiveAfter: after.p95 < INTERACTIVE_MS } : {}) });
      const fmt = (t?: Timing | null) => (t ? `p50 ${String(t.p50).padStart(8)} p95 ${String(t.p95).padStart(8)} min ${String(t.min).padStart(8)}` : '');
      console.log(`metric ${label.padEnd(5)} ${name.padEnd(40)} guard ${refusal ? 'REFUSES' : 'allows '}->${refusalAfter ? 'REFUSES' : 'allows '}  before ${fmt(before)}  after ${fmt(after)}  [${reads ?? ''}]${beforeNote ? ' (before: ' + beforeNote + ')' : ''}`);
    };
    const R3 = Number(process.env.BENCH_WIN_RUNS ?? 9);
    for (const [label, hours] of [['3 h', 3], ['6 h', 6], ['24 h', 24]] as [string, number][]) {
      const docs = 600 * hours * 60;
      await run('request rate by service (all 600 series)', label, hours, docs, (s) => s.query(scope, mq(hours, { agg: 'rate', groupBy: ['service'] })), hours <= 6 ? R3 : 5);
      await run('p99 across everything (all 600 series)', label, hours, docs, (s) => s.query(scope, mq(hours, { agg: 'p99' })), hours <= 6 ? R3 : 5);
      await run('HTTP service overview (all 600 series)', label, hours, docs, (s) => s.httpOverview(scope, new Date(now - hours * HOUR), new Date(now)), hours <= 3 ? Math.max(R3, 15) : hours <= 6 ? R3 : 4);
    }
    for (const [label, hours] of [['3 h', 3], ['24 h', 24], ['7 d', 168]] as [string, number][]) {
      const docs = 60 * hours * 60;
      await run('p95 by route, one service (60 series)', label, hours, docs, (s) => s.query(scope, mq(hours, { agg: 'p95', service: 'svc-1', groupBy: ['http.route'] })), hours <= 24 ? R3 : 4);
      await run('request rate, one service (60 series)', label, hours, docs, (s) => s.query(scope, mq(hours, { agg: 'rate', service: 'svc-1', groupBy: ['http.route'] })), hours <= 24 ? R3 : 4);
    }
    if (FULL7D) {
      // 600 series for 7 d: the minute-document run is slow (millions of documents), so it is timed twice without a warm-up
      const docs = 600 * 168 * 60;
      await run('request rate by service (all 600 series)', '7 d', 168, docs, (s) => s.query(scope, mq(168, { agg: 'rate', groupBy: ['service'] })), 2, false);
      await run('p99 across everything (all 600 series)', '7 d', 168, docs, (s) => s.query(scope, mq(168, { agg: 'p99' })), 2, false);
      await run('HTTP service overview (all 600 series)', '7 d', 168, docs, (s) => s.httpOverview(scope, new Date(now - 168 * HOUR), new Date(now)), 2, false);
    }
    rows.push({ name: 'metric catalogue (names)', window: 'any', guard: 'n/a', ...(await timeIt(() => guarded.names(scope), 5)) });
    rows.push({ name: 'label values (labels)', window: 'any', guard: 'n/a', ...(await timeIt(() => guarded.labels(scope, 'http.server.request.duration'), 5)) });
    report.metricQueries = rows;
    // a cheap sanity check that both ways answer the same on the full-size data (the oracle tests are the real proof)
    if (ROLLUPS) {
      const a = await raised.httpOverview(scope, new Date(now - 24 * HOUR), new Date(now)), b = await rolled.httpOverview(scope, new Date(now - 24 * HOUR), new Date(now));
      report.sanityOverview24h = { sameRequestsErrorsP95: JSON.stringify(a.services.map((x) => [x.service, x.requests, x.errors, x.p95Ms])) === JSON.stringify(b.services.map((x) => [x.service, x.requests, x.errors, x.p95Ms])) };
    }
  }

  console.log(JSON.stringify(report, null, 2));
  const out = resolve(process.cwd(), ROLLUPS && !SKIP_METRICS ? `../../docs/performance-traces-metrics.round3-windows-${TAG}.json` : '../../docs/performance-traces-metrics.windows.json');
  mkdirSync(resolve(out, '..'), { recursive: true });
  writeFileSync(out, JSON.stringify({ ...report, measuredAt: new Date().toISOString() }, null, 2));
  await db.close();
  await mongo.stop();
}
main().catch((e) => { console.error(e); process.exit(1); });
