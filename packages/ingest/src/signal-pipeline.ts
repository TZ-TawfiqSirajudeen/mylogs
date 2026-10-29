import type { Database, IngestTokenDoc, TelemetrySignal } from '@nexus/database';
import type { IngestConfig, IngestOutcome, PipelineMetrics } from './pipeline.js';
import { Gate, RateLimiter } from './quota.js';

const DAY = 86_400_000;

export interface WriteResult {
  accepted: number; duplicates: number;
  /** Items refused AFTER mapping (for metrics: series beyond the cardinality limit). Reported to the sender as partial success. */
  rejected: number;
  /** Explanations for refusals decided at write time (e.g. cardinality limits). */
  notes?: string[];
}

export interface Mapped<Item> { items: Item[]; rejected: number; errors: string[] }

/**
 * Shared flow for the span and metric pipelines — identical guarantees to the log pipeline:
 *   validate/normalize/redact -> refuse what would expire at once -> per-token and per-project quota -> bounded gate (backpressure)
 *   -> retried, idempotent persistence -> per-minute accounting.
 * "Accepted" means durably stored; a failure is always visible to the sender (503 + Retry-After) and nothing is dropped uncounted.
 */
export abstract class SignalPipeline<Item> {
  readonly metrics: PipelineMetrics = {
    requests: 0, accepted: 0, duplicates: 0, rejectedInvalid: 0, rejectedQuota: 0, rejectedOverload: 0, rejectedStorage: 0,
    storeErrors: 0, storeRetries: 0, redactions: 0, bytes: 0,
  };
  private readonly limiter: RateLimiter;
  private readonly gate: Gate;

  protected constructor(
    protected readonly db: Database, protected readonly cfg: IngestConfig, readonly signal: TelemetrySignal,
    protected readonly now: () => Date, private readonly sleep: (ms: number) => Promise<void>,
  ) {
    this.limiter = new RateLimiter(() => this.now().getTime());
    this.gate = new Gate(cfg.maxInflightWrites, cfg.maxQueuedWrites);
  }

  get inflight() { return this.gate.inflight; }
  get queued() { return this.gate.queued; }

  protected abstract map(token: IngestTokenDoc, payload: unknown, now: Date): Mapped<Item> & { unsupported?: number };
  /** True when the item's retention would already have passed: refused visibly instead of stored and instantly deleted. */
  protected abstract expired(item: Item, token: IngestTokenDoc, now: Date): boolean;
  protected abstract write(token: IngestTokenDoc, items: Item[], now: Date, bodyHash: string): Promise<WriteResult>;
  protected abstract redactionsOf(items: Item[]): number;
  /** Called after a successful write so subclasses can maintain the service inventory. */
  protected afterWrite(_token: IngestTokenDoc, _items: Item[], _now: Date): Promise<void> { return Promise.resolve(); }

  async handle(token: IngestTokenDoc, input: { payload: unknown; bodyBytes: number; bodyHash: string }): Promise<IngestOutcome> {
    const now = this.now();
    this.metrics.requests++;
    this.metrics.bytes += input.bodyBytes;

    const mapped = this.map(token, input.payload, now);
    let rejected = mapped.rejected;
    const keep: Item[] = [];
    for (const it of mapped.items) { if (this.expired(it, token, now)) rejected++; else keep.push(it); }

    if (keep.length === 0) {
      this.metrics.rejectedInvalid += rejected;
      await this.stat(token, { requests: 1, bytes: input.bodyBytes, rejectedInvalid: rejected });
      return { status: rejected > 0 ? 'invalid' : 'ok', accepted: 0, duplicates: 0, rejected, ...(mapped.errors[0] ? { message: mapped.errors[0] } : {}) };
    }

    const tokenLimit = token.recordsPerMinute ?? this.cfg.tokenRecordsPerMinute;
    const t1 = this.limiter.take(`token:${token._id}`, keep.length, tokenLimit);
    const t2 = t1.ok ? this.limiter.take(`project:${token.projectId}`, keep.length, this.cfg.projectRecordsPerMinute) : t1;
    if (!t1.ok || !t2.ok) {
      if (t1.ok) this.limiter.give(`token:${token._id}`, keep.length, tokenLimit);
      const wait = (t1.ok ? t2 : t1) as { retryAfterMs: number };
      this.metrics.rejectedQuota += keep.length + rejected;
      await this.stat(token, { requests: 1, bytes: input.bodyBytes, rejectedQuota: keep.length, rejectedInvalid: rejected });
      return { status: 'quota', accepted: 0, duplicates: 0, rejected: keep.length + rejected, retryAfterMs: wait.retryAfterMs, message: 'Ingestion rate limit exceeded' };
    }

    const release = await this.gate.acquire();
    const giveBack = () => { this.limiter.give(`token:${token._id}`, keep.length, tokenLimit); this.limiter.give(`project:${token.projectId}`, keep.length, this.cfg.projectRecordsPerMinute); };
    if (!release) {
      giveBack();
      this.metrics.rejectedOverload += keep.length + rejected;
      await this.stat(token, { requests: 1, bytes: input.bodyBytes, rejectedOverload: keep.length, rejectedInvalid: rejected });
      return { status: 'overloaded', accepted: 0, duplicates: 0, rejected: keep.length + rejected, retryAfterMs: 2_000, message: 'Ingestion is overloaded; retry shortly' };
    }
    try {
      const w = await this.writeWithRetry(token, keep, now, input.bodyHash);
      rejected += w.rejected;
      const note = mapped.errors[0] ?? w.notes?.[0];
      const redactions = this.redactionsOf(keep);
      this.metrics.accepted += w.accepted; this.metrics.duplicates += w.duplicates; this.metrics.rejectedInvalid += rejected; this.metrics.redactions += redactions;
      await this.stat(token, { requests: 1, bytes: input.bodyBytes, accepted: w.accepted, duplicates: w.duplicates, rejectedInvalid: rejected, redactions });
      void this.afterWrite(token, keep, now).catch(() => undefined); // inventory is best-effort and must never fail a request
      return { status: 'ok', accepted: w.accepted, duplicates: w.duplicates, rejected, ...(rejected && note ? { message: note } : {}) };
    } catch {
      giveBack();
      this.metrics.rejectedStorage += keep.length;
      await this.stat(token, { requests: 1, bytes: input.bodyBytes, rejectedStorage: keep.length });
      return { status: 'storage_unavailable', accepted: 0, duplicates: 0, rejected: keep.length + rejected, retryAfterMs: 5_000, message: 'Storage is temporarily unavailable; retry' };
    } finally {
      release();
    }
  }

  private async writeWithRetry(token: IngestTokenDoc, items: Item[], now: Date, bodyHash: string): Promise<WriteResult> {
    let last: unknown;
    for (let attempt = 0; attempt <= this.cfg.storeRetries; attempt++) {
      try {
        const out: WriteResult = { accepted: 0, duplicates: 0, rejected: 0, notes: [] };
        for (let i = 0; i < items.length; i += this.cfg.chunkSize) {
          const r = await this.write(token, items.slice(i, i + this.cfg.chunkSize), now, bodyHash);
          out.accepted += r.accepted; out.duplicates += r.duplicates; out.rejected += r.rejected;
          for (const n of r.notes ?? []) if (out.notes!.length < 5 && !out.notes!.includes(n)) out.notes!.push(n);
        }
        return out;
      } catch (e) {
        last = e;
        this.metrics.storeErrors++;
        if (attempt < this.cfg.storeRetries) {
          this.metrics.storeRetries++;
          await this.sleep(Math.floor(Math.random() * this.cfg.retryBaseMs * 2 ** attempt)); // exponential backoff with full jitter
        }
      }
    }
    throw last;
  }

  protected retentionMs(token: IngestTokenDoc) { return token.retentionDays * DAY; }

  protected async stat(token: IngestTokenDoc, d: Partial<Record<'requests' | 'bytes' | 'accepted' | 'duplicates' | 'rejectedInvalid' | 'rejectedQuota' | 'rejectedOverload' | 'rejectedStorage' | 'redactions', number>>) {
    const minute = new Date(Math.floor(this.now().getTime() / 60_000) * 60_000);
    try {
      await this.db.c.ingestStats.updateOne(
        { _id: `${token.environmentId}:${this.signal}:${minute.toISOString()}` },
        {
          $inc: Object.fromEntries(Object.entries(d).filter(([, v]) => v)),
          $setOnInsert: { orgId: token.orgId, projectId: token.projectId, environmentId: token.environmentId, signal: this.signal, minute, expireAt: new Date(minute.getTime() + 7 * DAY) },
        },
        { upsert: true },
      );
    } catch { /* accounting must never fail a request; the in-memory metrics still count it */ }
  }
}

/**
 * Service inventory: remembers that a service was seen, per environment and signal. Never invents a service.
 * `at` is the newest EVENT time in the data (span start, metric point time, log timestamp) — not the time it was received — so replayed or
 * delayed old telemetry cannot make a silent service look active.
 */
export async function touchServices(db: Database, token: IngestTokenDoc, seen: Map<string, { version: string | null; at: Date }>, signal: TelemetrySignal): Promise<void> {
  if (seen.size === 0) return;
  const field = signal === 'traces' ? 'lastSpanAt' : signal === 'metrics' ? 'lastMetricAt' : 'lastLogAt';
  await db.c.services.bulkWrite([...seen].slice(0, 200).map(([name, { version, at }]) => ({
    updateOne: {
      filter: { _id: `${token.orgId}|${token.environmentId}|${name}` },
      update: {
        $max: { [field]: at },
        $setOnInsert: { orgId: token.orgId, projectId: token.projectId, environmentId: token.environmentId, name, firstSeen: at },
        ...(version ? { $set: { version } } : {}),
      },
      upsert: true,
    },
  })) as never, { ordered: false });
}
