import type { MetricPointDraft } from '@nexus/telemetry';
import type { MetricStore } from './store.js';

/**
 * Stores what a data-source connector (MongoDB, Redis, ...) read from its target, through the SAME store, cardinality limits and
 * cumulative-to-delta handling as application metrics. Structurally typed on purpose: this package does not depend on the connector SDK.
 *
 * Connector metrics are deliberately NOT application services:
 *  - `service` is null, so they never appear in the Services inventory, service dashboards or the "services" of the metric catalogue;
 *  - every point carries `nexus.source=connector`, `db.system`, `nexus.connection.id` and `nexus.connection.name`, so the Metrics page can
 *    always tell them apart from instrumented applications and filter or group by connection.
 * Cumulative counters are sent with no start time: the first reading is a baseline (counts nothing), later readings add the increase, and a
 * reading lower than the previous one is treated as a counter reset (the new value is the increase).
 */
export interface ConnectorSample {
  name: string; unit: string; description: string; kind: 'gauge' | 'sum'; value: number; attributes: Record<string, string>;
}
export interface ConnectorBatch { connectionId: string; connectionName: string; connectorType: string; samples: ConnectorSample[] }

/** `db.system` values follow the OpenTelemetry semantic conventions. */
const DB_SYSTEM: Record<string, string> = { mongodb: 'mongodb', redis: 'redis' };

export function samplesToPoints(batch: ConnectorBatch, time: Date): MetricPointDraft[] {
  const common: Record<string, string> = {
    'nexus.source': 'connector',
    'nexus.connection.id': batch.connectionId,
    'nexus.connection.name': batch.connectionName,
    ...(DB_SYSTEM[batch.connectorType] ? { 'db.system': DB_SYSTEM[batch.connectorType]! } : {}),
  };
  return batch.samples.filter((s) => Number.isFinite(s.value)).map((s) => {
    const merged = { ...s.attributes, ...common }; // ours win: a connector cannot impersonate another source
    const attrs = Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => ({ k, v: v.length > 128 ? v.slice(0, 128) : v }));
    const sum = s.kind === 'sum';
    return {
      name: s.name, unit: s.unit, description: s.description, type: s.kind, temporality: sum ? 'cumulative' : null, monotonic: sum ? true : null,
      service: null, serviceVersion: null, instance: null, attrs, time, startTime: null,
      value: s.value, count: 1, sum: s.value, min: null, max: null, bounds: null, buckets: null, exemplars: [],
    } satisfies MetricPointDraft;
  });
}

/** Adapter used by the worker: satisfies the connections package's `CollectionSink` without importing it. */
export function connectorMetricSink(store: MetricStore) {
  return {
    async write(ctx: { orgId: string; projectId: string; environmentId: string; retentionMs: number }, batch: ConnectorBatch, now: Date) {
      const r = await store.ingest(ctx, samplesToPoints(batch, now), now);
      return { accepted: r.accepted, rejected: r.rejected, notes: r.notes };
    },
  };
}
