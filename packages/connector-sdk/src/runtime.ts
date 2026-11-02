import { ConnectorError, REMEDIATION, type ConnectorContext, type ConnectorErrorKind } from './types.js';

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ConnectorError('cancelled', 'Cancelled'));
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new ConnectorError('cancelled', 'Cancelled')); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

const RETRYABLE: ReadonlySet<ConnectorErrorKind> = new Set(['unreachable', 'timeout', 'rate_limited', 'unhealthy', 'internal']);
/** Retrying these cannot help and only burns quota / triggers account lockouts. */
export const isRetryable = (e: unknown): boolean => e instanceof ConnectorError && RETRYABLE.has(e.kind);

export interface RetryOptions {
  retries: number;
  baseMs: number;
  maxMs: number;
  signal?: AbortSignal;
  sleep?: Sleep;
  /** [0,1) source; injectable for deterministic tests. */
  random?: () => number;
  onRetry?: (attempt: number, delayMs: number, err: ConnectorError) => void;
}

/** Delay for attempt n (1-based): full jitter over min(maxMs, baseMs * 2^(n-1)); a provider Retry-After wins if larger. */
export function backoffDelay(attempt: number, o: Pick<RetryOptions, 'baseMs' | 'maxMs' | 'random'>, retryAfterMs?: number): number {
  const cap = Math.min(o.maxMs, o.baseMs * 2 ** (attempt - 1));
  const jittered = Math.floor((o.random ?? Math.random)() * cap);
  return Math.min(o.maxMs, Math.max(jittered, retryAfterMs ?? 0));
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, o: RetryOptions): Promise<T> {
  const sleep = o.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      const e = toConnectorError(err);
      if (o.signal?.aborted) throw new ConnectorError('cancelled', 'Cancelled');
      if (!isRetryable(e) || attempt > o.retries) throw e;
      const delay = backoffDelay(attempt, o, e.retryAfterMs);
      o.onRetry?.(attempt, delay, e);
      await sleep(delay, o.signal);
    }
  }
}

export function toConnectorError(err: unknown): ConnectorError {
  if (err instanceof ConnectorError) return err;
  if (err instanceof Error && err.name === 'AbortError') return new ConnectorError('cancelled', 'Cancelled');
  return new ConnectorError('internal', err instanceof Error ? err.message : 'Unknown error', { cause: err, remediation: REMEDIATION.internal });
}

/** Combines the caller's signal with a deadline. Always dispose() to clear the timer. */
export function withDeadline(parent: AbortSignal | undefined, ms: number): { signal: AbortSignal; dispose(): void; timedOut(): boolean } {
  const ctl = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, ms);
  const onParent = () => ctl.abort();
  parent?.addEventListener('abort', onParent, { once: true });
  if (parent?.aborted) ctl.abort();
  return {
    signal: ctl.signal,
    timedOut: () => timedOut,
    dispose: () => { clearTimeout(timer); parent?.removeEventListener('abort', onParent); },
  };
}

// ---------------------------------------------------------------- health scheduling

export interface HealthPolicy {
  intervalMs: number;
  maxBackoffMs: number;
}

/**
 * When the next check is due. Healthy connections are re-checked every interval; failures back off exponentially
 * (with a ceiling) so a dead target is not hammered, and rate-limited/Retry-After responses are respected.
 */
export function nextCheckDelay(consecutiveFailures: number, p: HealthPolicy, retryAfterMs?: number, random: () => number = Math.random): number {
  if (consecutiveFailures <= 0) return p.intervalMs;
  // A failing target is never polled MORE often than a healthy one: with a polling interval above the ceiling (e.g. 1 h vs 15 min) the ceiling is the interval.
  const ceiling = Math.max(p.maxBackoffMs, p.intervalMs);
  const exp = Math.min(ceiling, p.intervalMs * 2 ** Math.min(consecutiveFailures, 10));
  const jitter = 0.8 + random() * 0.4; // ±20 % so many connections do not synchronise
  let jittered = exp * jitter;
  // Clamping at the ceiling would put every connection whose jitter lands above it on the same instant (about half of them, every time). Fold the excess back instead.
  if (jittered > ceiling) jittered = ceiling - (jittered - ceiling);
  return Math.min(ceiling, Math.max(Math.floor(jittered), p.intervalMs, retryAfterMs ?? 0));
}

export type { ConnectorContext };
