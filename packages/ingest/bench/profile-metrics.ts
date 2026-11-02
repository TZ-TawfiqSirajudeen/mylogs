/**
 * Stage-level profile of the metric WRITE path (not a pass/fail benchmark; bench-signals.ts holds the targets).
 *   pnpm --filter @nexus/ingest exec tsx bench/profile-metrics.ts              (default: 20 simulated minutes = 120 ticks x 4 writers)
 *   PROFILE_TICKS=360 PROFILE_BATCH=150 ...
 * Wraps the store's collection calls with timers and reports where the time of an ingest request goes (read series, cardinality counts,
 * transaction commit overhead, each bulkWrite), plus the explain of the hot write shapes. Same data shape as bench-signals.ts.
 */
import { createHash } from 'node:crypto';
import { AuditService } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import { MongoMetricStore } from '@nexus/metricstore';
import { DEFAULT_INGEST_CONFIG, IngestTokenService, MetricPipeline, TokenCreate } from '../src/index.js';

const TICKS = Number(process.env.PROFILE_TICKS ?? 120);
/** Consecutive ticks carried by ONE request (a Collector batch processor sends several scrape intervals per request): 1 = the bench-signals shape. */
const PER_REQUEST = Number(process.env.PROFILE_TICKS_PER_REQUEST ?? 1);
const CONCURRENCY = 4;
const ORG = 'org-p', PROJECT = 'proj-p', ENV = 'env-p';
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const nsOf = (t: number) => String(BigInt(Math.round(t)) * 1_000_000n);
const attr = (k: string, v: string) => ({ key: k, value: { stringValue: v } });

const totals = new Map<string, { n: number; ms: number; docs: number }>();
function wrap<T extends object>(obj: T, label: string, methods: string[]) {
  for (const m of methods) {
    const orig = (obj as Record<string, unknown>)[m] as (...a: unknown[]) => Promise<unknown>;
    (obj as Record<string, unknown>)[m] = async function (this: unknown, ...args: unknown[]) {
      const t = performance.now();
      try { return await orig.apply(obj, args); } finally {
        const e = totals.get(`${label}.${m}`) ?? { n: 0, ms: 0, docs: 0 };
        e.n++; e.ms += performance.now() - t;
        if (m === 'bulkWrite') e.docs += (args[0] as unknown[]).length;
        totals.set(`${label}.${m}`, e);
      }
    };
  }
}

async function main() {
  const mongo = await startTestMongo();
  const db = await freshTestDatabase(mongo.uri);
  await db.c.environments.insertOne({ _id: ENV, orgId: ORG, projectId: PROJECT, slug: 'p', name: 'P', isProduction: false, createdAt: new Date() });
  const tokens = new IngestTokenService(db, new AuditService(db));
  const { token } = await tokens.create({ orgId: ORG, projectId: PROJECT, environmentIds: null }, ENV, { userId: 'p', ctx: { requestId: 'prof-000001' } }, TokenCreate.parse({ name: 'p', retentionDays: 30 }));
  const tok = (await tokens.authenticate(token))!;
  const cfg = { ...DEFAULT_INGEST_CONFIG, tokenRecordsPerMinute: 1e9, projectRecordsPerMinute: 1e9, maxInflightWrites: CONCURRENCY, maxQueuedWrites: 1000 };
  const store = new MongoMetricStore(db);
  const pipe = new MetricPipeline(db, store, cfg);

  wrap(db.c.metricSeries, 'series', ['countDocuments', 'bulkWrite']);
  wrap(db.c.metricPoints, 'points', ['bulkWrite']);
  const origTxn = db.transaction.bind(db);
  let txnMs = 0, txnN = 0;
  db.transaction = async (fn) => { const t = performance.now(); try { return await origTxn(fn); } finally { txnMs += performance.now() - t; txnN++; } };

  const routes = ['/orders/:id', '/pay', '/cart', '/login', '/search'], statuses = ['200', '404', '500', '503'];
  const services = Array.from({ length: 10 }, (_, i) => `svc-${i}`), tick = 10_000, instances = 3;
  const bounds = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
  const start = Date.now() - TICKS * tick;
  const payload = (t0: number, writer: number) => ({
    resourceMetrics: services.filter((_, i) => i % CONCURRENCY === writer).flatMap((service) => Array.from({ length: instances }, (_, inst) => ({
      resource: { attributes: [attr('service.name', service), attr('service.instance.id', `${service}-${inst}`)] },
      scopeMetrics: [{ metrics: [{ name: 'http.server.request.duration', unit: 's', histogram: { aggregationTemporality: 1, dataPoints: Array.from({ length: Math.min(PER_REQUEST, TICKS - t0) }, (_, dt) => t0 + dt).flatMap((t) => routes.flatMap((route, ri) => statuses.map((st, si) => {
        const n = 1 + ((t + ri + si) % 9);
        const b = bounds.map((_, k) => (k === (ri + si) % bounds.length ? n : (k + t) % 3 === 0 ? 1 : 0)).concat([0]);
        return { timeUnixNano: nsOf(start + t * tick), count: String(b.reduce((a, c) => a + c, 0)), sum: 0.3 * n, bucketCounts: b.map(String), explicitBounds: bounds, attributes: [attr('http.route', route), attr('http.response.status_code', st), attr('http.request.method', 'GET')] };
      }))) } }] }],
    }))),
  });

  let accepted = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async (_, w) => {
    for (let t = 0; t < TICKS; t += PER_REQUEST) {
      const o = await pipe.handle(tok, { payload: payload(t, w), bodyBytes: 1000, bodyHash: md5(`p${t}-${w}`) });
      if (o.status !== 'ok') throw new Error(JSON.stringify(o));
      accepted += o.accepted;
    }
  }));
  const sec = (performance.now() - t0) / 1000;
  console.log(JSON.stringify({ ticks: TICKS, points: accepted, seconds: Math.round(sec * 10) / 10, pointsPerSecond: Math.round(accepted / sec), requests: Math.ceil(TICKS / PER_REQUEST) * CONCURRENCY, ticksPerRequest: PER_REQUEST, transactions: txnN, avgTxnMs: Math.round(txnMs / txnN * 10) / 10 }));
  for (const [k, v] of [...totals].sort((a, b) => b[1].ms - a[1].ms)) console.log(`${k.padEnd(28)} calls ${String(v.n).padStart(6)}  total ${(v.ms / 1000).toFixed(1).padStart(7)} s  avg ${(v.ms / v.n).toFixed(1).padStart(7)} ms${v.docs ? `  ops ${v.docs} (${(v.ms / v.docs).toFixed(2)} ms/op)` : ''}`);
  const st = await db.db.command({ collStats: 'metric_points' });
  console.log('metric_points', JSON.stringify({ docs: st.count, avgObjSize: st.avgObjSize, indexSizes: st.indexSizes }));
  const ss = await db.db.command({ collStats: 'metric_series' });
  console.log('metric_series', JSON.stringify({ docs: ss.count, avgObjSize: ss.avgObjSize }));
  await db.close();
  await mongo.stop();
}
main().catch((e) => { console.error(e); process.exit(1); });
