/**
 * What do rollups cost the metric WRITE path? A/B/C in ONE process, alternating, so the noise of the machine hits every variant alike:
 *   A  no rollup marker: the series update without `$min: { rollFrom }` (what the code did before rollups) and series documents without the field
 *   B  marker (the shipped write path)
 *   C  marker AND a compactor pass every 2 s next to the writers (15x the production cadence of 30 s)
 *   D  marker AND a compactor running back to back (a 300 ms pause between passes): the worst case, every series is re-claimed again and again
 *   pnpm --filter @nexus/ingest exec tsx bench/bench-rollup-write.ts        (ROUNDS=6 TICKS=60 by default)
 * Same data shape and writer layout as profile-metrics.ts / bench-signals.ts (150 series per request, 4 writers, one point per series per request).
 * Writes docs/performance-traces-metrics.round3-write-path.json.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { AuditService } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import { MetricRollupCompactor, MongoMetricStore } from '@nexus/metricstore';
import { DEFAULT_INGEST_CONFIG, IngestTokenService, MetricPipeline, TokenCreate } from '../src/index.js';

const TICKS = Number(process.env.TICKS ?? 60), ROUNDS = Number(process.env.ROUNDS ?? 6), CONCURRENCY = 4;
const ORG = 'org-rw', PROJECT = 'proj-rw', ENV = 'env-rw';
const md5 = (s: string) => createHash('md5').update(s).digest('hex');
const nsOf = (t: number) => String(BigInt(Math.round(t)) * 1_000_000n);
const attr = (k: string, v: string) => ({ key: k, value: { stringValue: v } });
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function round(mongoUri: string, variant: 'A' | 'B' | 'C' | 'D'): Promise<number> {
  const db = await freshTestDatabase(mongoUri);
  await new MetricRollupCompactor(db).ensureIndexes();
  await db.c.environments.insertOne({ _id: ENV, orgId: ORG, projectId: PROJECT, slug: 'p', name: 'P', isProduction: false, createdAt: new Date() });
  const tokens = new IngestTokenService(db, new AuditService(db));
  const { token } = await tokens.create({ orgId: ORG, projectId: PROJECT, environmentIds: null }, ENV, { userId: 'p', ctx: { requestId: 'rw-000001' } }, TokenCreate.parse({ name: 'p', retentionDays: 30 }));
  const tok = (await tokens.authenticate(token))!;
  const cfg = { ...DEFAULT_INGEST_CONFIG, tokenRecordsPerMinute: 1e9, projectRecordsPerMinute: 1e9, maxInflightWrites: CONCURRENCY, maxQueuedWrites: 1000 };
  const pipe = new MetricPipeline(db, new MongoMetricStore(db), cfg);
  if (variant === 'A') {
    // strip the marker from the series writes: the exact pre-rollup shape
    const orig = db.c.metricSeries.bulkWrite.bind(db.c.metricSeries) as (ops: Record<string, Record<string, unknown>>[], o: unknown) => Promise<unknown>;
    (db.c.metricSeries as unknown as { bulkWrite: unknown }).bulkWrite = (ops: Record<string, Record<string, unknown>>[], o: unknown) => orig(ops.map((op) => {
      const u = op.updateOne as { update?: { $min?: unknown } } | undefined;
      if (u?.update?.$min) { const { $min: _drop, ...rest } = u.update; return { updateOne: { ...u, update: rest } }; }
      const ins = op.insertOne as { document: Record<string, unknown> } | undefined;
      if (ins) { const { rollFrom: _drop, ...doc } = ins.document; return { insertOne: { document: doc } }; }
      return op;
    }), o);
  }
  const routes = ['/orders/:id', '/pay', '/cart', '/login', '/search'], statuses = ['200', '404', '500', '503'];
  const services = Array.from({ length: 10 }, (_, i) => `svc-${i}`), tick = 10_000, instances = 3;
  const bounds = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
  const start = Date.now() - 3 * 3_600_000; // old enough that every minute is sealed: the compactor of variant C has real work from the first request
  const payload = (t: number, writer: number) => ({
    resourceMetrics: services.filter((_, i) => i % CONCURRENCY === writer).flatMap((service) => Array.from({ length: instances }, (_, inst) => ({
      resource: { attributes: [attr('service.name', service), attr('service.instance.id', `${service}-${inst}`)] },
      scopeMetrics: [{ metrics: [{ name: 'http.server.request.duration', unit: 's', histogram: { aggregationTemporality: 1, dataPoints: routes.flatMap((route, ri) => statuses.map((st, si) => {
        const n = 1 + ((t + ri + si) % 9);
        const b = bounds.map((_, k) => (k === (ri + si) % bounds.length ? n : (k + t) % 3 === 0 ? 1 : 0)).concat([0]);
        return { timeUnixNano: nsOf(start + t * tick), count: String(b.reduce((a, c) => a + c, 0)), sum: 0.3 * n, bucketCounts: b.map(String), explicitBounds: bounds, attributes: [attr('http.route', route), attr('http.response.status_code', st), attr('http.request.method', 'GET')] };
      })) } }] }],
    }))),
  });
  let stop = false;
  const compactor = new MetricRollupCompactor(db, { batch: 50 });
  const pause = variant === 'C' ? 2_000 : 300;
  const background = variant === 'C' || variant === 'D' ? (async () => { while (!stop) { await compactor.runOnce(new Date(), 5_000); await new Promise((r) => setTimeout(r, pause)); } })() : Promise.resolve();
  let accepted = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, async (_, w) => {
    for (let t = 0; t < TICKS; t++) {
      const o = await pipe.handle(tok, { payload: payload(t, w), bodyBytes: 1000, bodyHash: md5(`rw${t}-${w}`) });
      if (o.status !== 'ok') throw new Error(JSON.stringify(o));
      accepted += o.accepted;
    }
  }));
  const sec = (performance.now() - t0) / 1000;
  stop = true; await background;
  await db.close();
  return Math.round(accepted / sec);
}

async function main() {
  const mongo = await startTestMongo();
  const results: Record<'A' | 'B' | 'C' | 'D', number[]> = { A: [], B: [], C: [], D: [] };
  const loads: number[] = [];
  await round(mongo.uri, 'B'); // warm-up, discarded
  for (let i = 0; i < ROUNDS; i++) {
    for (const v of ['A', 'B', 'C', 'D'] as const) { loads.push(loadavg()[0]!); const pps = await round(mongo.uri, v); results[v].push(pps); console.log(`round ${i + 1} variant ${v}: ${pps} points/s`); }
  }
  const summary = Object.fromEntries((['A', 'B', 'C', 'D'] as const).map((v) => [v, { runs: results[v], median: median(results[v]), best: Math.max(...results[v]), min: Math.min(...results[v]) }]));
  const out = {
    what: 'metric ingestion throughput (points/s), alternating A/B/C in one process; A = no rollup marker, B = marker (shipped), C = marker + compactor pass every 2 s, D = marker + compactor back to back (worst case)',
    shape: { writers: CONCURRENCY, seriesPerRequest: 150, pointsPerSeriesPerRequest: 1, ticks: TICKS, rounds: ROUNDS },
    summary, medianRatioBOverA: Math.round((summary.B.median / summary.A.median) * 1000) / 1000, medianRatioCOverA: Math.round((summary.C.median / summary.A.median) * 1000) / 1000, medianRatioDOverA: Math.round((summary.D.median / summary.A.median) * 1000) / 1000,
    machine: { cpus: cpus().length, cpuModel: cpus()[0]?.model, memGiB: Math.round(totalmem() / 2 ** 30), node: process.version }, loadavg1mAtRoundStarts: loads, measuredAt: new Date().toISOString(),
  };
  console.log(JSON.stringify(out, null, 2));
  const file = resolve(process.cwd(), '../../docs/performance-traces-metrics.round3-write-path.json');
  mkdirSync(resolve(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify(out, null, 2));
  await mongo.stop();
}
main().catch((e) => { console.error(e); process.exit(1); });
