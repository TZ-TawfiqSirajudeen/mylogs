import { MetricQuery } from '@nexus/contracts';
import { freshTestDatabase, startTestMongo } from '@nexus/database/testing';
import type { Database } from '@nexus/database';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { connectorMetricSink, samplesToPoints, type ConnectorBatch } from './connector-sink.js';
import { MongoMetricStore } from './store.js';

let mongo: Awaited<ReturnType<typeof startTestMongo>>;
let db: Database;
let store: MongoMetricStore;
const CTX = { orgId: 'o', projectId: 'p', environmentId: 'e', retentionMs: 7 * 86_400_000 };
const scope = { orgId: 'o', projectId: 'p', environmentIds: ['e'] };
const T0 = Date.UTC(2026, 5, 1, 12, 0, 0);
const at = (sec: number) => new Date(T0 + sec * 1000);

const batch = (samples: ConnectorBatch['samples'], over: Partial<ConnectorBatch> = {}): ConnectorBatch => ({ connectionId: 'conn-1', connectionName: 'orders-db', connectorType: 'mongodb', samples, ...over });
const counter = (value: number, op = 'insert') => ({ name: 'mongodb.operations', unit: '{operation}', description: 'ops', kind: 'sum' as const, value, attributes: { operation: op, 'server.address': 'h:1' } });
const gauge = (value: number) => ({ name: 'mongodb.connections.current', unit: '{connection}', description: 'c', kind: 'gauge' as const, value, attributes: { 'server.address': 'h:1' } });
const q = (over: Record<string, unknown>) => MetricQuery.parse({ from: at(-60).toISOString(), to: at(600).toISOString(), stepSeconds: 60, ...over });

beforeAll(async () => { mongo = await startTestMongo(); db = await freshTestDatabase(mongo.uri); store = new MongoMetricStore(db); }, 300_000);
afterAll(async () => { await db?.close(); await mongo?.stop(); });

describe('samplesToPoints', () => {
  test('connector points are never application services: no service, always labelled as a connector source; a sample cannot claim another source', () => {
    const [p] = samplesToPoints(batch([{ ...gauge(3), attributes: { 'nexus.source': 'application', 'db.system': 'postgresql', 'server.address': 'h:1' } }]), at(0));
    expect(p!.service).toBeNull();
    expect(p!.instance).toBeNull();
    const a = Object.fromEntries(p!.attrs.map((x) => [x.k, x.v]));
    expect(a).toMatchObject({ 'nexus.source': 'connector', 'db.system': 'mongodb', 'nexus.connection.id': 'conn-1', 'nexus.connection.name': 'orders-db', 'server.address': 'h:1' });
    expect(p!.attrs.map((x) => x.k)).toEqual([...p!.attrs.map((x) => x.k)].sort());
  });
  test('counters are cumulative monotonic with no start time (restarts are detected by decrease); gauges carry no temporality; non-finite values are dropped', () => {
    const pts = samplesToPoints(batch([counter(5), gauge(2), { ...gauge(NaN) }, { ...gauge(Infinity) }]), at(0));
    expect(pts).toHaveLength(2);
    expect(pts[0]).toMatchObject({ type: 'sum', temporality: 'cumulative', monotonic: true, startTime: null, value: 5, sum: 5, count: 1 });
    expect(pts[1]).toMatchObject({ type: 'gauge', temporality: null, monotonic: null, value: 2 });
  });
  test('labels are bounded', () => {
    const [p] = samplesToPoints(batch([{ ...gauge(1), attributes: { 'db.namespace': 'x'.repeat(500) } }]), at(0));
    expect(p!.attrs.find((x) => x.k === 'db.namespace')!.v).toHaveLength(128);
  });
});

describe('through the real metric store', () => {
  const sink = () => connectorMetricSink(store);
  test('a counter becomes per-interval increases: the first reading is only a baseline, later ones add the difference', async () => {
    await sink().write(CTX, batch([counter(100)]), at(10));
    await sink().write(CTX, batch([counter(130)]), at(70));
    await sink().write(CTX, batch([counter(190)]), at(130));
    const r = await store.query(scope, q({ metric: 'mongodb.operations', agg: 'sum', groupBy: ['operation'] }));
    expect(r.type).toBe('sum');
    const series = r.series.find((s) => s.labels.operation === 'insert')!;
    const total = series.points.reduce((a, p) => a + (p.v ?? 0), 0);
    expect(total).toBe(90); // 130-100 + 190-130; the 100 baseline is NOT counted as activity
    expect(series.labels['nexus.source'] ?? 'connector').toBe('connector');
  });

  test('a counter reset (server restart) counts the new value as the increase; it never produces a negative or huge value', async () => {
    await sink().write(CTX, batch([counter(1000, 'delete')]), at(200));
    await sink().write(CTX, batch([counter(1010, 'delete')]), at(260));
    await sink().write(CTX, batch([counter(4, 'delete')]), at(320)); // restarted: 4 operations since
    const r = await store.query(scope, q({ metric: 'mongodb.operations', agg: 'sum', groupBy: ['operation'] }));
    const total = r.series.find((s) => s.labels.operation === 'delete')!.points.reduce((a, p) => a + (p.v ?? 0), 0);
    expect(total).toBe(10 + 4);
  });

  test('a replayed reading (same timestamp) is a duplicate and is not double counted', async () => {
    const before = await store.query(scope, q({ metric: 'mongodb.operations', agg: 'sum', groupBy: ['operation'] }));
    const sum = (r: typeof before, op: string) => r.series.find((s) => s.labels.operation === op)!.points.reduce((a, p) => a + (p.v ?? 0), 0);
    const res = await sink().write(CTX, batch([counter(190)]), at(130)); // same timestamp as an earlier write
    expect(res.accepted).toBe(0);
    const after = await store.query(scope, q({ metric: 'mongodb.operations', agg: 'sum', groupBy: ['operation'] }));
    expect(sum(after, 'insert')).toBe(sum(before, 'insert'));
  });

  test('gauges keep the latest value per window and are listed as a connector metric with no service', async () => {
    await sink().write(CTX, batch([gauge(5)]), at(15));
    await sink().write(CTX, batch([gauge(9)]), at(45));
    const r = await store.query(scope, q({ metric: 'mongodb.connections.current', agg: 'last' }));
    expect(r.series[0]!.points.find((p) => p.v !== null)!.v).toBe(9);
    const info = (await store.names(scope)).find((n) => n.name === 'mongodb.connections.current')!;
    expect(info.services).toEqual([]); // not an application service
    expect((await store.labels(scope, 'mongodb.connections.current')).find((l) => l.key === 'nexus.source')!.values).toEqual(['connector']);
  });

  test('two connections with the same metric are separate series (grouped by connection name)', async () => {
    await sink().write(CTX, batch([gauge(1)], { connectionId: 'conn-2', connectionName: 'billing-db' }), at(20));
    const r = await store.query(scope, q({ metric: 'mongodb.connections.current', agg: 'last', groupBy: ['nexus.connection.name'] }));
    expect(r.series.map((s) => s.labels['nexus.connection.name']).sort()).toEqual(['billing-db', 'orders-db']);
  });

  test('the store\'s cardinality limit still applies and is reported back (nothing silently lost)', async () => {
    const small = new MongoMetricStore(db, { maxSeriesPerMetric: 2 });
    const many = Array.from({ length: 5 }, (_, i) => ({ ...gauge(i), name: 'capped.metric', attributes: { 'db.namespace': `d${i}` } }));
    const res = await connectorMetricSink(small).write(CTX, batch(many), at(30));
    expect(res.accepted).toBe(2);
    expect(res.rejected).toBe(3);
    expect(res.notes.join(' ')).toMatch(/reached its limit of 2 series/);
  });
});
