import type { Database, IngestTokenDoc } from '@nexus/database';
import type { MetricStore } from '@nexus/metricstore';
import { otlpMetricsToPoints, type MetricPointDraft } from '@nexus/telemetry';
import { DEFAULT_INGEST_CONFIG, type IngestConfig } from './pipeline.js';
import { SignalPipeline, touchServices, type Mapped, type WriteResult } from './signal-pipeline.js';

/**
 * OTLP metrics -> validated data points -> pre-aggregated, idempotent storage with cardinality limits.
 * Supported: gauge, sum (delta/cumulative), explicit-bucket histogram. Exponential histograms and summaries are refused and counted
 * (OTLP partial success) rather than approximated. Quota is counted in data points.
 */
export class MetricPipeline extends SignalPipeline<MetricPointDraft> {
  /** Data points refused as an unsupported metric type or temporality (since start). */
  unsupported = 0;

  constructor(
    db: Database, private readonly store: MetricStore, cfg: IngestConfig = DEFAULT_INGEST_CONFIG,
    now: () => Date = () => new Date(), sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) { super(db, cfg, 'metrics', now, sleep); }

  protected map(token: IngestTokenDoc, payload: unknown, now: Date): Mapped<MetricPointDraft> {
    const m = otlpMetricsToPoints(payload, { now, limits: this.cfg.limits, redaction: token.redaction });
    this.unsupported += m.unsupported;
    return { items: m.points, rejected: m.rejected, errors: m.errors };
  }

  protected expired(p: MetricPointDraft, token: IngestTokenDoc, now: Date): boolean { return p.time.getTime() + this.retentionMs(token) <= now.getTime(); }

  protected redactionsOf(): number { return 0; }

  protected async write(token: IngestTokenDoc, items: MetricPointDraft[], now: Date): Promise<WriteResult> {
    const r = await this.store.ingest({ orgId: token.orgId, projectId: token.projectId, environmentId: token.environmentId, retentionMs: this.retentionMs(token) }, items, now);
    return { accepted: r.accepted, duplicates: r.duplicates, rejected: r.rejected, notes: r.notes };
  }

  protected override async afterWrite(token: IngestTokenDoc, items: MetricPointDraft[], now: Date): Promise<void> {
    void now;
    const seen = new Map<string, { version: string | null; at: Date }>();
    for (const p of items) if (p.service) { const c = seen.get(p.service); seen.set(p.service, { version: p.serviceVersion ?? c?.version ?? null, at: c && c.at > p.time ? c.at : p.time }); }
    await touchServices(this.db, token, seen, 'metrics');
  }
}
