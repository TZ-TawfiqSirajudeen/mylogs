import { describe, expect, test } from 'vitest';
import { nextCheckDelay } from './runtime.js';

const MIN = 60_000;
const policy = { intervalMs: MIN, maxBackoffMs: 15 * MIN };
const sweep = (n: number, p = policy, retryAfter?: number) => Array.from({ length: 200 }, (_, i) => nextCheckDelay(n, p, retryAfter, () => i / 200));

describe('nextCheckDelay (failure back-off)', () => {
  test('no failures: the polling interval, exactly', () => {
    expect(nextCheckDelay(0, policy)).toBe(MIN);
  });

  test('doubles per consecutive failure, with +/-20 % jitter', () => {
    for (const [n, base] of [[1, 2 * MIN], [2, 4 * MIN], [3, 8 * MIN]] as const) {
      const d = sweep(n);
      expect(Math.min(...d)).toBeGreaterThanOrEqual(Math.floor(base * 0.8));
      expect(Math.max(...d)).toBeLessThanOrEqual(Math.ceil(base * 1.2));
      expect(new Set(d).size).toBeGreaterThan(50); // spread, so many failing connections do not retry in lockstep
    }
  });

  test('at the ceiling the jitter is folded back, not clamped: delays never exceed it AND do not pile up on one instant', () => {
    const d = sweep(8);
    expect(Math.max(...d)).toBeLessThanOrEqual(15 * MIN);
    expect(d.filter((x) => x === 15 * MIN).length).toBeLessThan(10); // clamping used to put ~half of all connections exactly here
    expect(new Set(d).size).toBeGreaterThan(50);
    expect(Math.min(...d)).toBeGreaterThanOrEqual(12 * MIN - 1);
  });

  test('a polling interval above the ceiling: a failing connection is never polled MORE often than a healthy one (it used to be capped at 15 min)', () => {
    const hourly = { intervalMs: 60 * MIN, maxBackoffMs: 15 * MIN };
    for (const n of [1, 2, 5, 12]) for (const d of sweep(n, hourly)) expect(d).toBeGreaterThanOrEqual(60 * MIN);
  });

  test('Retry-After is honoured up to the ceiling', () => {
    for (const d of sweep(1, policy, 10 * MIN)) expect(d).toBeGreaterThanOrEqual(10 * MIN);
    for (const d of sweep(1, policy, 60 * MIN)) expect(d).toBe(15 * MIN);
  });
});
