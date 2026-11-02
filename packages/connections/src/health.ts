import type { ConnectionDoc, ConnectionHealthState } from '@nexus/database';
import { nextCheckDelay, stateForError, type ConnectorErrorKind, type TestReport } from '@nexus/connector-sdk';

export const TEST_FRESH_MS = 30 * 60_000;
export const MAX_RECENT_ERRORS = 10;
export const MAX_BACKOFF_MS = 15 * 60_000;
const RANDOM_FREE: () => number = () => Math.random();

export type Health = ConnectionDoc['health'];

export function initialHealth(): Health {
  return {
    state: 'pending', lastCheckAt: null, lastSuccessAt: null, lastCheckDurationMs: null, consecutiveFailures: 0,
    nextCheckAt: null, lastError: null, recentErrors: [], collectionLagSeconds: null,
  };
}

/**
 * Folds one check result into the health record. Pure so every transition is unit-testable.
 * - success -> healthy, failure counter reset;
 * - failure -> state derived from the error kind (first-time auth failure = misconfigured, later = authentication_expired);
 * - the next check is scheduled only for active connections, with exponential backoff + jitter, honouring Retry-After.
 */
export function applyReport(
  h: Health, report: TestReport, now: Date,
  o: { scheduled: boolean; intervalMs: number; random?: () => number },
): Health {
  const base: Health = { ...h, lastCheckAt: now, lastCheckDurationMs: report.durationMs };
  if (report.ok) {
    return {
      ...base, state: 'healthy', lastSuccessAt: now, consecutiveFailures: 0, lastError: null,
      nextCheckAt: o.scheduled ? new Date(now.getTime() + o.intervalMs) : null,
    };
  }
  const f = report.failure!;
  const state = stateForError(f.kind as ConnectorErrorKind, h.lastSuccessAt !== null) as ConnectionHealthState;
  const failures = h.consecutiveFailures + 1;
  const err = { at: now, kind: f.kind, message: f.message, remediation: f.remediation };
  return {
    ...base, state, consecutiveFailures: failures, lastError: err,
    recentErrors: [err, ...h.recentErrors].slice(0, MAX_RECENT_ERRORS),
    nextCheckAt: o.scheduled
      // 'unhealthy' = the target answers but reports a problem (e.g. one replica-set member is down). It is not hammered by polling, so it keeps its normal
      // interval instead of backing off: backing off would blind monitoring - and the metric collection that follows a degraded check - exactly when it matters.
      ? new Date(now.getTime() + nextCheckDelay(f.kind === 'unhealthy' ? 0 : failures, { intervalMs: o.intervalMs, maxBackoffMs: MAX_BACKOFF_MS }, f.retryAfterMs, o.random ?? RANDOM_FREE))
      : null,
  };
}

/**
 * An active connection that has not been checked for far longer than its interval is "stale": the monitor may be down,
 * so the last state can no longer be trusted. Shown explicitly rather than letting an old "healthy" stand.
 */
export function isStale(c: Pick<ConnectionDoc, 'lifecycle' | 'health' | 'activatedAt' | 'settings'>, now: Date): boolean {
  if (c.lifecycle !== 'active') return false;
  const interval = (c.settings?.pollIntervalSeconds ?? 60) * 1000;
  const reference = c.health.lastCheckAt ?? c.activatedAt;
  if (!reference) return false;
  // Failures back off up to MAX_BACKOFF_MS, so allow for that before declaring the monitor itself missing.
  const allowed = Math.max(3 * interval, c.health.consecutiveFailures > 0 ? MAX_BACKOFF_MS * 1.5 : 0) + 60_000;
  return now.getTime() - reference.getTime() > allowed;
}
