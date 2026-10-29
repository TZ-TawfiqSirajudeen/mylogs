import type { Database, IngestTokenDoc, SpanDoc } from '@nexus/database';
import { otlpTracesToDrafts, type SpanDraft } from '@nexus/telemetry';
import { spanId, type TraceStore } from '@nexus/tracestore';
import { DEFAULT_INGEST_CONFIG, type IngestConfig } from './pipeline.js';
import { SignalPipeline, touchServices, type Mapped, type WriteResult } from './signal-pipeline.js';

/**
 * OTLP traces -> validated, redacted spans -> idempotent storage. The span id is derived from (organization, project, environment,
 * traceId, spanId): a retransmitted request — or the same span delivered again later, in any batch — is a duplicate, not a second span.
 * Tenant fields come from the TOKEN; anything in the payload that looks like a tenant claim is just an attribute.
 */
export class TracePipeline extends SignalPipeline<SpanDraft> {
  constructor(
    db: Database, private readonly store: TraceStore, cfg: IngestConfig = DEFAULT_INGEST_CONFIG,
    now: () => Date = () => new Date(), sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) { super(db, cfg, 'traces', now, sleep); }

  protected map(token: IngestTokenDoc, payload: unknown, now: Date): Mapped<SpanDraft> {
    const m = otlpTracesToDrafts(payload, { now, limits: this.cfg.limits, redaction: token.redaction });
    return { items: m.records, rejected: m.rejected, errors: m.errors };
  }

  protected expired(s: SpanDraft, token: IngestTokenDoc, now: Date): boolean { return s.start.getTime() + this.retentionMs(token) <= now.getTime(); }

  protected redactionsOf(items: SpanDraft[]): number { return items.reduce((n, s) => n + s.redactions, 0); }

  protected async write(token: IngestTokenDoc, items: SpanDraft[], now: Date): Promise<WriteResult> {
    const docs: SpanDoc[] = items.map((d) => {
      const { redactions, ...fields } = d;
      return {
        _id: spanId(token.orgId, token.projectId, token.environmentId, d.traceId, d.spanId),
        orgId: token.orgId, projectId: token.projectId, environmentId: token.environmentId, tokenId: token._id,
        receivedAt: now, expireAt: new Date(d.start.getTime() + this.retentionMs(token)), redactions, ...fields,
      };
    });
    const r = await this.store.insert(docs);
    return { accepted: r.inserted, duplicates: r.duplicates, rejected: 0 };
  }

  protected override async afterWrite(token: IngestTokenDoc, items: SpanDraft[], now: Date): Promise<void> {
    void now;
    const seen = new Map<string, { version: string | null; at: Date }>();
    for (const s of items) if (s.service) { const c = seen.get(s.service); seen.set(s.service, { version: s.serviceVersion ?? c?.version ?? null, at: c && c.at > s.start ? c.at : s.start }); }
    await touchServices(this.db, token, seen, 'traces');
  }
}
