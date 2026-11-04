import { startTestMongo } from '@nexus/database/testing';
import { MongoLogStore } from '@nexus/logstore';
import { MongoMetricStore } from '@nexus/metricstore';
import type { MetricPointDraft } from '@nexus/telemetry';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ruleCol } from './common.js';
import { makeWorld, metricRule } from './testkit.js';

/**
 * The replay policy against the REAL metric store (MongoDB), not a function of the clock: after a simulated outage the replayed boundaries must read the
 * data as it was at each boundary (event-time windows over the stored minutes), so the incident opens at the minute the breach was confirmed.
 */
let mongo: Awaited<ReturnType<typeof startTestMongo>>;
beforeAll(async () => { mongo = await startTestMongo(); }, 240_000);
afterAll(async () => { await mongo?.stop(); });

const gauge = (time: Date, value: number): MetricPointDraft => ({
  name: 'cpu.load', unit: null, description: null, type: 'gauge', temporality: null, monotonic: null, service: 'checkout', serviceVersion: null, instance: 'i-1', attrs: [],
  time, startTime: null, value, count: 1, sum: value, min: null, max: null, bounds: null, buckets: null, exemplars: [],
});

describe('replay with the real metric store', () => {
  test('a breach confirmed during an outage opens its incident at the minute it was confirmed; skip only notices it afterwards', async () => {
    const w = await makeWorld(mongo.uri);
    const metrics = new MongoMetricStore(w.db), logs = new MongoLogStore(w.db);
    const deps = { metrics, logs };
    // 30 s into a minute, 30 minutes ago: the data is in the past but well inside retention
    const T0 = Math.floor((Date.now() - 30 * 60_000) / 60_000) * 60_000 + 30_000;
    w.clock.t = T0;
    const ctx = { orgId: w.orgA, projectId: w.projA, environmentId: w.envA, retentionMs: 30 * 86_400_000 };
    // one sample per minute; the load jumps from 10 to 90 in the minute that starts 4 minutes after T0
    const pts = Array.from({ length: 11 }, (_, m) => gauge(new Date(T0 - 20_000 + m * 60_000), m >= 4 ? 90 : 10));
    await metrics.ingest(ctx, pts, new Date(T0 + 11 * 60_000));

    const common = { windowSeconds: 300, intervalSeconds: 60, forSeconds: 120, resolveAfterSeconds: 120, condition: { op: 'gt' as const, threshold: 80 }, query: { kind: 'metric' as const, metric: 'cpu.load', filters: [], groupBy: [], agg: 'max' as const } };
    const replay = await w.svc.rules.create(w.scopeA, metricRule(w, { ...common, name: 'replaying', missedPolicy: 'replay', maxReplayEvaluations: 10 }), { requestId: 'r' });
    const skip = await w.svc.rules.create(w.scopeA, metricRule(w, { ...common, name: 'skipping' }), { requestId: 'r' });
    const engine = w.engine(deps);
    await engine.tick();                                   // T0: both see load 10
    expect(await w.db.c.incidents.countDocuments({})).toBe(0);

    w.clock.advance(600);                                  // the worker is down for 10 minutes
    const outcomes = await engine.tick();
    expect(outcomes.map((o) => o.ok)).toEqual([true, true]);

    // replay: boundaries T0+1m .. T0+9m were re-evaluated with windows ending there; the breach first shows at T0+4m (pending) and holds for 2 minutes at T0+6m
    const r = (await ruleCol(w.db).findOne({ _id: replay._id }))!;
    expect(r.missed).toMatchObject({ total: 9, replayed: 9, skipped: 0 });
    const inc = await w.db.c.incidents.findOne({ ruleId: replay._id });
    expect(inc).toMatchObject({ status: 'open', active: true, lastValue: 90 });
    expect(inc!.openedAt).toEqual(new Date(T0 + 6 * 60_000));
    expect(inc!.timeline[0]).toMatchObject({ type: 'opened', data: { replayed: true, evaluatedAt: new Date(T0 + 6 * 60_000).toISOString() } });
    expect(r.groups[0]).toMatchObject({ status: 'firing', since: new Date(T0 + 6 * 60_000) });

    // skip: only now does the breach start its for-duration
    const s = (await ruleCol(w.db).findOne({ _id: skip._id }))!;
    expect(s.missed).toMatchObject({ total: 9, replayed: 0, skipped: 9 });
    expect(s.groups[0]).toMatchObject({ status: 'pending', since: new Date(T0 + 600_000) });
    expect(await w.db.c.incidents.countDocuments({ ruleId: skip._id })).toBe(0);
  });
});
