/**
 * Token-bucket rate limiter keyed by an arbitrary string (token id, project id, client address). The bucket holds one
 * minute of allowance and refills continuously, so short bursts are fine and sustained overuse is refused.
 * In-memory and per process: with several ingest replicas the effective limit is replicas x limit (documented).
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(private readonly now: () => number = Date.now, private readonly maxKeys = 50_000) {}

  /** Tries to take `n` units. When refused, says how long until `n` units would be available. */
  take(key: string, n: number, perMinute: number): { ok: true } | { ok: false; retryAfterMs: number } {
    const t = this.now();
    const rate = perMinute / 60_000;
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.evict(t);
      b = { tokens: perMinute, at: t };
      this.buckets.set(key, b);
    }
    b.tokens = Math.min(perMinute, b.tokens + (t - b.at) * rate);
    b.at = t;
    if (n > perMinute) return { ok: false, retryAfterMs: 60_000 }; // can never fit
    if (b.tokens >= n) { b.tokens -= n; return { ok: true }; }
    return { ok: false, retryAfterMs: Math.min(60_000, Math.max(1_000, Math.ceil((n - b.tokens) / rate))) };
  }

  /** Returns units taken by a request that was subsequently refused for another reason. */
  give(key: string, n: number, perMinute: number) {
    const b = this.buckets.get(key);
    if (b) b.tokens = Math.min(perMinute, b.tokens + n);
  }

  private evict(t: number) {
    for (const [k, b] of this.buckets) if (t - b.at > 120_000) this.buckets.delete(k);
    if (this.buckets.size >= this.maxKeys) this.buckets.clear(); // pathological key churn: fail open on accounting, never on memory
  }
}

/** Bounds concurrent work AND the number of callers waiting for a slot; beyond that, callers are told to back off. */
export class Gate {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly maxActive: number, private readonly maxWaiting: number) {}

  get inflight() { return this.active; }
  get queued() { return this.waiters.length; }

  /** Resolves with a release function, or null when the queue is full (caller must reject with backpressure). */
  async acquire(): Promise<(() => void) | null> {
    if (this.active < this.maxActive) { this.active++; return () => this.release(); }
    if (this.waiters.length >= this.maxWaiting) return null;
    await new Promise<void>((r) => this.waiters.push(r));
    return () => this.release();
  }

  private release() {
    const next = this.waiters.shift();
    if (next) next(); // hand the slot directly to the next waiter
    else this.active--;
  }
}
