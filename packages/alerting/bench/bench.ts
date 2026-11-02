/**
 * Evaluation throughput benchmark (`pnpm --filter @nexus/alerting bench`). Real MongoDB (mongodb-memory-server) with the real MetricStore and LogStore,
 * 1,000 rules over 10 projects, each project holding 20 metric series x 60 minutes and 5,000 log records. Reports how fast one worker drains the
 * due rules at several concurrency settings. Numbers depend on the machine; the command is the reproducible part.
 */
import { writeFileSync } from 'node:fs';
import { AuditService } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import { buildSearchText, type LogDoc } from '@nexus/database';
import { MongoLogStore } from '@nexus/logstore';
import { MongoMetricStore } from '@nexus/metricstore';
import { generateKeyBase64, parseKeyring, SecretStore } from '@nexus/secrets';
import type { MetricPointDraft } from '@nexus/telemetry';
import type { AlertRuleCreate } from '@nexus/contracts';
import { ruleCol } from '../src/common.js';
import { AlertEngine } from '../src/engine.js';
import type { EvalDeps } from '../src/evaluator.js';
import { createAlertingServices } from '../src/services.js';

const PROJECTS = 10, RULES_PER_PROJECT = 100, SERIES = 20, MINUTES = 60, LOGS = 5000;
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0; };

const mongo = await startTestMongo();
const db = await freshTestDatabase(mongo.uri);
const metrics = new MongoMetricStore(db), logs = new MongoLogStore(db);
const secrets = new SecretStore(db, parseKeyring(`k1:${generateKeyBase64()}`, 'k1'));
const policy = { allowLoopback: false, allowPrivateCidrs: [], allowInsecureHttp: false };
const svc = createAlertingServices(db, new AuditService(db), secrets, policy);
const orgId = crypto.randomUUID(), userId = crypto.randomUUID();
const now = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 30_000);

console.log(`seeding ${PROJECTS} projects x (${SERIES} series x ${MINUTES} min of metrics, ${LOGS} logs, ${RULES_PER_PROJECT} rules)...`);
const t0 = Date.now();
const scopes: { projectId: string; envId: string }[] = [];
for (let p = 0; p < PROJECTS; p++) {
  const projectId = crypto.randomUUID(), envId = crypto.randomUUID();
  scopes.push({ projectId, envId });
  await db.c.environments.insertOne({ _id: envId, orgId, projectId, slug: 'dev', name: 'dev', isProduction: false, createdAt: new Date() });
  const points: MetricPointDraft[] = [];
  for (let s = 0; s < SERIES; s++) for (let m = 0; m < MINUTES; m++) {
    points.push({ name: 'bench.latency', unit: 'ms', description: null, type: 'gauge', temporality: null, monotonic: null, service: `svc-${s}`, serviceVersion: null, instance: 'i-1', attrs: [{ k: 'route', v: `/r${s % 5}` }],
      time: new Date(now.getTime() - m * 60_000 - 20_000), startTime: null, value: 50 + ((s * 7 + m * 13) % 100), count: 1, sum: 0, min: null, max: null, bounds: null, buckets: null, exemplars: [] });
  }
  for (let i = 0; i < points.length; i += 500) await metrics.ingest({ orgId, projectId, environmentId: envId, retentionMs: 86_400_000 }, points.slice(i, i + 500), now);
  const docs: LogDoc[] = Array.from({ length: LOGS }, (_, i) => {
    const message = i % 10 === 0 ? 'upstream timeout while calling payments' : `request ${i} handled`;
    return {
      _id: `${envId}-${i}`, orgId, projectId, environmentId: envId, tokenId: 't', ts: new Date(now.getTime() - (i % 3000) * 1000), tsSource: 'event', tsAdjusted: null, receivedAt: now, expireAt: new Date(now.getTime() + 86_400_000),
      severity: i % 10 === 0 ? 'error' : 'info', level: i % 10 === 0 ? 4 : 2, severityText: null, message, messageTruncated: false, searchText: buildSearchText(message, null, null), service: `svc-${i % SERIES}`, serviceVersion: null,
      deployment: null, host: 'h', container: null, traceId: null, spanId: null, requestId: null, httpMethod: null, httpRoute: null, httpStatus: i % 10 === 0 ? 503 : 200, durationMs: null, errorType: null, exceptionMessage: null, stack: null,
      scope: null, source: 'otlp', attrs: [], resource: [], attrsTruncated: false, redactions: 0,
    };
  });
  await logs.insert(docs);
  const scope = { orgId, projectId, environmentIds: null, userId };
  for (let r = 0; r < RULES_PER_PROJECT; r++) {
    const kind = r % 10 < 7 ? 'metric' : 'logs';
    const body: AlertRuleCreate = {
      name: `bench-${r}`, description: '', severity: 'warning', environmentId: envId, enabled: true,
      query: kind === 'metric'
        ? { kind: 'metric', metric: 'bench.latency', filters: r % 3 === 0 ? [{ key: 'route', value: '/r1' }] : [], groupBy: r % 5 === 0 ? ['service'] : [], agg: (['max', 'avg', 'min', 'last'] as const)[r % 4]!, ...(r % 4 === 1 ? { service: `svc-${r % SERIES}` } : {}) }
        : { kind: 'logs', filters: [], errorsOnly: r % 2 === 0, ...(r % 3 === 0 ? { text: 'upstream timeout' } : {}) },
      condition: { op: 'gt', threshold: kind === 'metric' ? 10_000 : 1_000_000 }, windowSeconds: 900, forSeconds: 0, resolveAfterSeconds: 120, noDataPolicy: 'keep', intervalSeconds: 60, channelIds: [],
    };
    await svc.rules.create(scope, body, { requestId: 'bench' });
  }
}
console.log(`seeded in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const totalRules = PROJECTS * RULES_PER_PROJECT;
const results: Record<string, unknown>[] = [];
for (const [concurrency, workers] of [[1, 1], [4, 1], [8, 1], [4, 2]] as const) {
  await ruleCol(db).updateMany({ kind: 'rule' }, { $set: { nextEvalAt: new Date(0), lease: null, groups: [], health: 'unknown' } });
  const queryMs: number[] = [];
  const timed: EvalDeps = {
    metrics: { query: async (s, q) => { const t = performance.now(); try { return await metrics.query(s, q); } finally { queryMs.push(performance.now() - t); } } },
    logs: { histogram: async (s, q, b) => { const t = performance.now(); try { return await logs.histogram(s, q, b); } finally { queryMs.push(performance.now() - t); } } },
  };
  const engines = Array.from({ length: workers }, (_, i) => new AlertEngine(db, timed, svc.incidents, { owner: `bench-${i}`, concurrency, maxRulesPerTick: 50, ruleBudgetMs: 10_000 }));
  const start = performance.now();
  let evaluated = 0, errors = 0, ticks = 0;
  const tickMs: number[] = [];
  while (evaluated < totalRules) {
    const out = (await Promise.all(engines.map(async (e) => { const t = performance.now(); const o = await e.tick(); tickMs.push(performance.now() - t); return o; }))).flat();
    ticks++; evaluated += out.length; errors += out.filter((o) => !o.ok).length;
    if (out.length === 0) break;
  }
  const secs = (performance.now() - start) / 1000;
  const row = {
    concurrency, workers, rules: evaluated, errors, seconds: Number(secs.toFixed(2)), rulesPerSecond: Number((evaluated / secs).toFixed(1)),
    storeQueryMsP50: Number(pct(queryMs, 0.5).toFixed(1)), storeQueryMsP95: Number(pct(queryMs, 0.95).toFixed(1)), storeQueryMsMax: Number(Math.max(...queryMs).toFixed(1)),
    tickMsP50: Math.round(pct(tickMs, 0.5)), tickMsMax: Math.round(Math.max(...tickMs)), ticks,
  };
  console.log(JSON.stringify(row));
  results.push(row);
}
const best = Math.max(...results.filter((r) => r.workers === 1).map((r) => r.rulesPerSecond as number));
const summary = {
  measuredAt: new Date().toISOString(), node: process.version, platform: `${process.platform} ${process.arch}`, dataset: { projects: PROJECTS, rules: totalRules, seriesPerProject: SERIES, minutes: MINUTES, logsPerProject: LOGS }, results,
  note: `At ${best} rules/s (best single-worker setting) one worker can sustain about ${Math.floor(best * 60)} rules at a 60 s interval or ${Math.floor(best * 15)} at 15 s (evaluation only, in-memory mongod on the same host, idle machine).`,
};
console.log(summary.note);
writeFileSync(new URL('../../../docs/performance-alerting.json', import.meta.url), `${JSON.stringify(summary, null, 2)}\n`);
await db.close();
await mongo.stop();
process.exit(0);
