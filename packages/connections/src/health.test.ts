import type { TestReport } from '@nexus/connector-sdk';
import { describe, expect, test } from 'vitest';
import { applyReport, initialHealth, isStale, MAX_BACKOFF_MS, MAX_RECENT_ERRORS } from './health.js';

const now = new Date('2026-01-01T12:00:00Z');
const ok: TestReport = { ok: true, steps: [], capabilities: [], facts: {}, durationMs: 12 };
const bad = (kind: string, retryAfterMs?: number): TestReport => ({
  ok: false, steps: [], capabilities: [], facts: {}, durationMs: 5,
  failure: { kind: kind as never, message: `${kind} happened`, remediation: 'fix it', ...(retryAfterMs ? { retryAfterMs } : {}) },
});
const opts = { scheduled: true, intervalMs: 60_000, random: () => 0.5 };

describe('applyReport', () => {
  test('success -> healthy, counters reset, next check one interval away', () => {
    const failing = applyReport(initialHealth(), bad('unreachable'), now, opts);
    const h = applyReport(failing, ok, now, opts);
    expect(h.state).toBe('healthy');
    expect(h.consecutiveFailures).toBe(0);
    expect(h.lastError).toBeNull();
    expect(h.lastSuccessAt).toEqual(now);
    expect(h.nextCheckAt).toEqual(new Date(now.getTime() + 60_000));
    expect(h.recentErrors).toHaveLength(1); // history is kept for diagnosis
  });

  test.each([
    ['unreachable', 'unreachable'], ['timeout', 'unreachable'], ['permission_denied', 'permission_denied'],
    ['misconfigured', 'misconfigured'], ['unhealthy', 'degraded'], ['rate_limited', 'degraded'], ['internal', 'degraded'],
  ])('failure kind %s -> state %s', (kind, state) => {
    expect(applyReport(initialHealth(), bad(kind), now, opts).state).toBe(state);
  });

  test('authentication failure: misconfigured on first contact, authentication_expired after it ever worked', () => {
    expect(applyReport(initialHealth(), bad('authentication'), now, opts).state).toBe('misconfigured');
    const worked = applyReport(initialHealth(), ok, now, opts);
    expect(applyReport(worked, bad('authentication'), now, opts).state).toBe('authentication_expired');
  });

  test('repeated failures back off exponentially up to the ceiling', () => {
    let h = initialHealth();
    const delays: number[] = [];
    for (let i = 0; i < 12; i++) {
      h = applyReport(h, bad('unreachable'), now, opts);
      delays.push(h.nextCheckAt!.getTime() - now.getTime());
    }
    expect(delays[0]).toBeLessThan(delays[1]!);
    expect(delays[1]).toBeLessThan(delays[2]!);
    expect(Math.max(...delays)).toBeLessThanOrEqual(MAX_BACKOFF_MS);
    expect(delays.at(-1)).toBe(MAX_BACKOFF_MS);
    expect(h.consecutiveFailures).toBe(12);
  });

  test('Retry-After from a rate-limited provider is honoured', () => {
    const h = applyReport(initialHealth(), bad('rate_limited', 10 * 60_000), now, opts);
    expect(h.nextCheckAt!.getTime() - now.getTime()).toBeGreaterThanOrEqual(10 * 60_000);
  });

  test('error history is bounded and newest-first', () => {
    let h = initialHealth();
    for (let i = 0; i < MAX_RECENT_ERRORS + 5; i++) h = applyReport(h, bad('timeout'), new Date(now.getTime() + i * 1000), opts);
    expect(h.recentErrors).toHaveLength(MAX_RECENT_ERRORS);
    expect(h.recentErrors[0]!.at.getTime()).toBeGreaterThan(h.recentErrors[1]!.at.getTime());
  });

  test('unscheduled (draft) connections never get a next check', () => {
    expect(applyReport(initialHealth(), ok, now, { ...opts, scheduled: false }).nextCheckAt).toBeNull();
    expect(applyReport(initialHealth(), bad('timeout'), now, { ...opts, scheduled: false }).nextCheckAt).toBeNull();
  });

  test('collection lag is never invented', () => {
    expect(applyReport(initialHealth(), ok, now, opts).collectionLagSeconds).toBeNull();
  });
});

describe('isStale', () => {
  const active = (lastCheckAt: Date | null, extra = {}) => ({
    lifecycle: 'active' as const, activatedAt: new Date(now.getTime() - 3600_000), settings: { pollIntervalSeconds: 60 } as never,
    health: { ...initialHealth(), lastCheckAt, ...extra },
  });
  test('fresh checks are not stale; silence beyond 3 intervals is', () => {
    expect(isStale(active(new Date(now.getTime() - 60_000)), now)).toBe(false);
    expect(isStale(active(new Date(now.getTime() - 10 * 60_000)), now)).toBe(true);
  });
  test('failing connections legitimately back off, so they get more slack before being called stale', () => {
    expect(isStale(active(new Date(now.getTime() - 10 * 60_000), { consecutiveFailures: 5 }), now)).toBe(false);
    expect(isStale(active(new Date(now.getTime() - 60 * 60_000), { consecutiveFailures: 5 }), now)).toBe(true);
  });
  test('never-checked active connections are measured from activation; drafts and disconnected are never stale', () => {
    expect(isStale(active(null), now)).toBe(true);
    expect(isStale({ ...active(null), lifecycle: 'draft' }, now)).toBe(false);
    expect(isStale({ ...active(null), lifecycle: 'disconnected' }, now)).toBe(false);
  });
});
