import { createHash } from 'node:crypto';
import { buildSearchText, type Database, type IngestTokenDoc, type LogDoc } from '@nexus/database';
import type { LogStore } from '@nexus/logstore';
import { DEFAULT_LIMITS, jsonLogsToDrafts, otlpLogsToDrafts, type Limits, type LogDraft } from '@nexus/telemetry';
import { Gate, RateLimiter } from './quota.js';
import { touchServices } from './signal-pipeline.js';

export interface IngestConfig {
  limits: Limits;
  /** Default per-token allowance (records/minute) and the per-project ceiling across all its tokens. */
  tokenRecordsPerMinute: number;
  projectRecordsPerMinute: number;
  maxInflightWrites: number;
  maxQueuedWrites: number;
  storeRetries: number;
  retryBaseMs: number;
  chunkSize: number;
}
export const DEFAULT_INGEST_CONFIG: IngestConfig = {
  limits: DEFAULT_LIMITS, tokenRecordsPerMinute: 60_000, projectRecordsPerMinute: 200_000,
  maxInflightWrites: 8, maxQueuedWrites: 64, storeRetries: 2, retryBaseMs: 50, chunkSize: 1000,
};

export type IngestStatus = 'ok' | 'invalid' | 'quota' | 'overloaded' | 'storage_unavailable';
export interface IngestOutcome {
  status: IngestStatus;
  accepted: number;
  duplicates: number;
  /** Records refused inside an otherwise accepted request (OTLP "partial success"). */
  rejected: number;
  retryAfterMs?: number;
  message?: string;
}

export interface PipelineMetrics {
  requests: number; accepted: number; duplicates: number; rejectedInvalid: number; rejectedQuota: number;
  rejectedOverload: number; rejectedStorage: number; storeErrors: number; storeRetries: number; redactions: number; bytes: number;
}

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');
const DAY = 86_400_000;

/**
 * Validation -> normalization/redaction -> quota -> bounded, retried, idempotent persistence.
 *
 * "Accepted" means durably stored: the caller gets its answer only after the write, so a 2xx can be trusted and a failure
 * is always visible to the sender (who retries). Nothing is buffered in memory beyond the bounded gate, and nothing is
 * ever dropped without being counted in the per-minute ingest statistics.
 */
export class IngestPipeline {
  readonly metrics: PipelineMetrics = {
    requests: 0, accepted: 0, duplicates: 0, rejectedInvalid: 0, rejectedQuota: 0, rejectedOverload: 0, rejectedStorage: 0,
    storeErrors: 0, storeRetries: 0, redactions: 0, bytes: 0,
  };
  private readonly limiter: RateLimiter;
  private readonly gate: Gate;

  constructor(
    private readonly db: Database, private readonly store: LogStore, private readonly cfg: IngestConfig = DEFAULT_INGEST_CONFIG,
    private readonly now: () => Date = () => new Date(), private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {
    this.limiter = new RateLimiter(() => this.now().getTime());
    this.gate = new Gate(cfg.maxInflightWrites, cfg.maxQueuedWrites);
  }

  get inflight() { return this.gate.inflight; }
  get queued() { return this.gate.queued; }

  async handle(token: IngestTokenDoc, input: { format: 'otlp' | 'json'; payload: unknown; bodyBytes: number; bodyHash: string }): Promise<IngestOutcome> {
    const now = this.now();
    this.metrics.requests++;
    this.metrics.bytes += input.bodyBytes;

    const mapped = input.format === 'otlp'
      ? otlpLogsToDrafts(input.payload, { now, limits: this.cfg.limits, redaction: token.redaction })
      : jsonLogsToDrafts(input.payload as string | unknown, { now, limits: this.cfg.limits, redaction: token.redaction });
    let rejected = mapped.rejected;

    // Records that would expire the moment they are written are refused, visibly, rather than stored and instantly deleted.
    const keep: LogDraft[] = [];
    for (const d of mapped.records) {
      if (d.ts.getTime() + token.retentionDays * DAY <= now.getTime()) rejected++; else keep.push(d);
    }

    if (keep.length === 0) {
      this.count('rejectedInvalid', rejected);
      await this.stat(token, { requests: 1, bytes: input.bodyBytes, rejectedInvalid: rejected });
      return { status: rejected > 0 ? 'invalid' : 'ok', accepted: 0, duplicates: 0, rejected, ...(mapped.errors[0] ? { message: mapped.errors[0] } : {}) };
    }

    const tokenLimit = token.recordsPerMinute ?? this.cfg.tokenRecordsPerMinute;
    const t1 = this.limiter.take(`token:${token._id}`, keep.length, tokenLimit);
    const t2 = t1.ok ? this.limiter.take(`project:${token.projectId}`, keep.length, this.cfg.projectRecordsPerMinute) : t1;
    if (!t1.ok || !t2.ok) {
      if (t1.ok) this.limiter.give(`token:${token._id}`, keep.length, tokenLimit);
      const wait = (t1.ok ? t2 : t1) as { retryAfterMs: number };
      this.count('rejectedQuota', keep.length + rejected);
      await this.stat(token, { requests: 1, bytes: input.bodyBytes, rejectedQuota: keep.length, rejectedInvalid: rejected });
      return { status: 'quota', accepted: 0, duplicates: 0, rejected: keep.length + rejected, retryAfterMs: wait.retryAfterMs, message: 'Ingestion rate limit exceeded' };
    }

    const docs = keep.map((d, i) => this.toDoc(token, d, now, input.bodyHash, i));
    const release = await this.gate.acquire();
    if (!release) {
      this.limiter.give(`token:${token._id}`, keep.length, tokenLimit);
      this.limiter.give(`project:${token.projectId}`, keep.length, this.cfg.projectRecordsPerMinute);
      this.count('rejectedOverload', keep.length + rejected);
      await this.stat(token, { requests: 1, bytes: input.bodyBytes, rejectedOverload: keep.length, rejectedInvalid: rejected });
      return { status: 'overloaded', accepted: 0, duplicates: 0, rejected: keep.length + rejected, retryAfterMs: 2_000, message: 'Ingestion is overloaded; retry shortly' };
    }
    try {
      let inserted = 0, duplicates = 0;
      for (let i = 0; i < docs.length; i += this.cfg.chunkSize) {
        const r = await this.writeWithRetry(docs.slice(i, i + this.cfg.chunkSize));
        inserted += r.inserted; duplicates += r.duplicates;
      }
      this.metrics.accepted += inserted;
      this.metrics.duplicates += duplicates;
      this.metrics.rejectedInvalid += rejected;
      this.metrics.redactions += keep.reduce((s, d) => s + d.redactions, 0);
      await this.stat(token, { requests: 1, bytes: input.bodyBytes, accepted: inserted, duplicates, rejectedInvalid: rejected, redactions: keep.reduce((s, d) => s + d.redactions, 0) });
      // Service inventory (best effort, after the response is decided): which services are sending logs.
      const seen = new Map<string, { version: string | null; at: Date }>();
      for (const d of keep) if (d.service) { const c = seen.get(d.service); seen.set(d.service, { version: d.serviceVersion ?? c?.version ?? null, at: c && c.at > d.ts ? c.at : d.ts }); }
      void touchServices(this.db, token, seen, 'logs').catch(() => undefined);
      return { status: 'ok', accepted: inserted, duplicates, rejected, ...(rejected && mapped.errors[0] ? { message: mapped.errors[0] } : {}) };
    } catch {
      this.limiter.give(`token:${token._id}`, keep.length, tokenLimit);
      this.limiter.give(`project:${token.projectId}`, keep.length, this.cfg.projectRecordsPerMinute);
      this.count('rejectedStorage', keep.length);
      await this.stat(token, { requests: 1, bytes: input.bodyBytes, rejectedStorage: keep.length });
      return { status: 'storage_unavailable', accepted: 0, duplicates: 0, rejected: keep.length + rejected, retryAfterMs: 5_000, message: 'Storage is temporarily unavailable; retry' };
    } finally {
      release();
    }
  }

  private async writeWithRetry(docs: LogDoc[]) {
    let last: unknown;
    for (let attempt = 0; attempt <= this.cfg.storeRetries; attempt++) {
      try { return await this.store.insert(docs); } catch (e) {
        last = e;
        this.metrics.storeErrors++;
        if (attempt < this.cfg.storeRetries) {
          this.metrics.storeRetries++;
          // exponential backoff with full jitter
          await this.sleep(Math.floor(Math.random() * this.cfg.retryBaseMs * 2 ** attempt));
        }
      }
    }
    throw last;
  }

  /**
   * Tenant fields come from the TOKEN. Anything in the payload that looks like an environment/project claim is just an
   * attribute. The id is derived from (token, request body hash, position) so a retransmitted request is idempotent.
   */
  private toDoc(token: IngestTokenDoc, d: LogDraft, now: Date, bodyHash: string, index: number): LogDoc {
    const { redactions, ...fields } = d;
    return {
      _id: sha1(`${token.projectId}|${token.environmentId}|${bodyHash}|${index}`),
      orgId: token.orgId, projectId: token.projectId, environmentId: token.environmentId, tokenId: token._id,
      receivedAt: now, expireAt: new Date(d.ts.getTime() + token.retentionDays * DAY), redactions, ...fields,
      // Built from the already-redacted text, so a masked secret is not searchable either.
      searchText: buildSearchText(d.message, d.errorType, d.exceptionMessage),
    };
  }

  private count(k: 'rejectedInvalid' | 'rejectedQuota' | 'rejectedOverload' | 'rejectedStorage', n: number) { this.metrics[k] += n; }

  private async stat(token: IngestTokenDoc, d: Partial<Record<'requests' | 'bytes' | 'accepted' | 'duplicates' | 'rejectedInvalid' | 'rejectedQuota' | 'rejectedOverload' | 'rejectedStorage' | 'redactions', number>>) {
    const minute = new Date(Math.floor(this.now().getTime() / 60_000) * 60_000);
    try {
      await this.db.c.ingestStats.updateOne(
        { _id: `${token.environmentId}:${minute.toISOString()}` },
        {
          $inc: Object.fromEntries(Object.entries(d).filter(([, v]) => v)),
          $setOnInsert: { orgId: token.orgId, projectId: token.projectId, environmentId: token.environmentId, minute, expireAt: new Date(minute.getTime() + 7 * DAY) },
        },
        { upsert: true },
      );
    } catch { /* accounting must never fail a request; the in-memory metrics still count it */ }
  }
}
