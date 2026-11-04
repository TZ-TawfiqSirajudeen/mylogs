/**
 * Cost of a rule PREVIEW (ADR-0009): `pnpm --filter @nexus/alerting exec tsx bench/preview-bench.ts`.
 * Real MongoDB (mongodb-memory-server) with the real MetricStore and LogStore (rollups off, as in the default store construction), one project with
 * 20 series x 24 h of minute data and 20,000 log records spread over 24 h. Prints elapsed time, evaluation points and store queries per scenario.
 */
import { buildSearchText, type LogDoc } from '@nexus/database';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import { RulePreviewBody } from '@nexus/contracts';
import { MongoLogStore } from '@nexus/logstore';
import { MongoMetricStore } from '@nexus/metricstore';
import type { MetricPointDraft } from '@nexus/telemetry';
import { RulePreviewService } from '../src/preview.js';

const SERIES = 20, HOURS = 24, LOGS = 20_000;
const mongo = await startTestMongo();
const db = await freshTestDatabase(mongo.uri);
const metrics = new MongoMetricStore(db), logs = new MongoLogStore(db);
const orgId = crypto.randomUUID(), projectId = crypto.randomUUID(), envId = crypto.randomUUID();
const now = new Date(Math.floor(Date.now() / 60_000) * 60_000 + 30_000);
await db.c.environments.insertOne({ _id: envId, orgId, projectId, slug: 'dev', name: 'dev', isProduction: false, createdAt: new Date() });

const t0 = Date.now();
for (let s = 0; s < SERIES; s++) {
  const points: MetricPointDraft[] = [];
  for (let m = 0; m < HOURS * 60; m++) {
    points.push({ name: 'bench.latency', unit: 'ms', description: null, type: 'gauge', temporality: null, monotonic: null, service: `svc-${s}`, serviceVersion: null, instance: 'i-1', attrs: [{ k: 'route', v: `/r${s % 5}` }],
      time: new Date(now.getTime() - m * 60_000 - 20_000), startTime: null, value: 50 + ((s * 7 + m * 13) % 100) + (m % 360 < 20 ? 500 : 0), count: 1, sum: 0, min: null, max: null, bounds: null, buckets: null, exemplars: [] });
  }
  for (let i = 0; i < points.length; i += 1000) await metrics.ingest({ orgId, projectId, environmentId: envId, retentionMs: 172_800_000 }, points.slice(i, i + 1000), now);
}
const docs: LogDoc[] = Array.from({ length: LOGS }, (_, i) => {
  const message = i % 10 === 0 ? 'upstream timeout while calling payments' : `request ${i} handled`;
  return {
    _id: `${envId}-${i}`, orgId, projectId, environmentId: envId, tokenId: 't', ts: new Date(now.getTime() - (i % 86_400) * 1000), tsSource: 'event', tsAdjusted: null, receivedAt: now, expireAt: new Date(now.getTime() + 172_800_000),
    severity: i % 10 === 0 ? 'error' : 'info', level: i % 10 === 0 ? 4 : 2, severityText: null, message, messageTruncated: false, searchText: buildSearchText(message, null, null), service: `svc-${i % SERIES}`, serviceVersion: null,
    deployment: null, host: 'h', container: null, traceId: null, spanId: null, requestId: null, httpMethod: null, httpRoute: null, httpStatus: i % 10 === 0 ? 503 : 200, durationMs: null, errorType: null, exceptionMessage: null, stack: null,
    scope: null, source: 'otlp', attrs: [], resource: [], attrsTruncated: false, redactions: 0,
  };
});
await logs.insert(docs);
console.log(`seeded ${SERIES} series x ${HOURS} h of minutes and ${LOGS} logs in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

const svc = new RulePreviewService({ metrics, logs }, { now: () => now });
const rule = { forSeconds: 300, resolveAfterSeconds: 120, noDataPolicy: 'keep', intervalSeconds: 60, windowSeconds: 900, condition: { op: 'gt', threshold: 400 }, environmentId: envId };
const scenarios: [string, Record<string, unknown>, number][] = [
  ['metric max, ungrouped, 6 h (default)', { query: { kind: 'metric', metric: 'bench.latency', agg: 'max' } }, 6 * 3600],
  ['metric max, ungrouped, 24 h', { query: { kind: 'metric', metric: 'bench.latency', agg: 'max' } }, 24 * 3600],
  ['metric avg (2 queries/point), 6 h', { query: { kind: 'metric', metric: 'bench.latency', agg: 'avg' } }, 6 * 3600],
  ['metric max grouped by service (20 groups), 6 h', { query: { kind: 'metric', metric: 'bench.latency', agg: 'max', groupBy: ['service'] } }, 6 * 3600],
  ['metric max grouped by service, 24 h, 1 h window', { windowSeconds: 3600, query: { kind: 'metric', metric: 'bench.latency', agg: 'max', groupBy: ['service'] } }, 24 * 3600],
  ['logs errors only, 6 h', { condition: { op: 'gt', threshold: 5 }, query: { kind: 'logs', errorsOnly: true } }, 6 * 3600],
  ['logs free text "upstream timeout", 24 h', { condition: { op: 'gt', threshold: 5 }, query: { kind: 'logs', text: 'upstream timeout' } }, 24 * 3600],
];
const rows: Record<string, unknown>[] = [];
for (const [name, over, range] of scenarios) {
  for (let run = 0; run < 3; run++) {
    const t = performance.now();
    const r = await svc.preview({ orgId, projectId }, RulePreviewBody.parse({ rule: { ...rule, ...over }, rangeSeconds: range }));
    const ms = Math.round(performance.now() - t);
    if (run === 2) rows.push({ scenario: name, points: r.times.length, stepSeconds: r.stepSeconds, storeQueries: r.totals.storeQueries, groups: r.groups.length, wouldOpen: r.totals.wouldOpenIncidents, partial: r.partial, skipped: r.totals.skippedPoints, ms });
  }
}
console.table(rows);
await db.close();
await mongo.stop();
