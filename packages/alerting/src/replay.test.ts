import { describe, expect, test } from 'vitest';
import { planCatchUp } from './replay.js';

const S = new Date('2026-06-01T10:00:00Z');
const at = (sec: number) => new Date(S.getTime() + sec * 1000);
const plan = (lateSec: number, over: Partial<Parameters<typeof planCatchUp>[0]> = {}) =>
  planCatchUp({ scheduledAt: S, now: at(lateSec), intervalSeconds: 60, policy: 'replay', maxReplay: 5, ...over });
const iso = (ds: Date[]) => ds.map((d) => d.toISOString().slice(11, 19));

describe('planCatchUp', () => {
  test('on time or less than one interval late: nothing is missed', () => {
    for (const late of [0, 1, 30, 59, 59.999]) expect(plan(late)).toEqual({ missed: 0, replay: [], skipped: 0 });
  });
  test('the newest due boundary is the evaluation happening now; the earlier ones are missed', () => {
    expect(plan(60).missed).toBe(1);           // boundaries 10:00 and 10:01 are due; 10:01 is "now", 10:00 was missed
    expect(iso(plan(60).replay)).toEqual(['10:00:00']);
    expect(plan(119.9).missed).toBe(1);
    expect(plan(120).missed).toBe(2);
    expect(iso(plan(125).replay)).toEqual(['10:00:00', '10:01:00']);
  });
  test('replay re-runs the LATEST N missed boundaries, oldest first; the older ones are only counted', () => {
    const p = plan(60 * 12, { maxReplay: 5 }); // 12 missed
    expect(p.missed).toBe(12);
    expect(iso(p.replay)).toEqual(['10:07:00', '10:08:00', '10:09:00', '10:10:00', '10:11:00']);
    expect(p.skipped).toBe(7);
    expect(p.replay.length + p.skipped).toBe(p.missed);
  });
  test('skip counts everything and replays nothing', () => {
    expect(plan(60 * 12, { policy: 'skip' })).toEqual({ missed: 12, replay: [], skipped: 12 });
  });
  test('the limit is clamped to 20 and a non-positive or fractional limit is safe', () => {
    expect(plan(60 * 100, { maxReplay: 999 }).replay).toHaveLength(20);
    expect(plan(60 * 100, { maxReplay: 0 }).replay).toHaveLength(0);
    expect(plan(60 * 100, { maxReplay: -3 })).toMatchObject({ replay: [], skipped: 100 });
    expect(plan(60 * 100, { maxReplay: 2.9 }).replay).toHaveLength(2);
    expect(plan(60 * 100, { maxReplay: Number.NaN }).replay).toHaveLength(0);
  });
  test('fewer missed boundaries than the limit: all of them are replayed', () => {
    const p = plan(60 * 3.5, { maxReplay: 20 });
    expect(p).toMatchObject({ missed: 3, skipped: 0 });
    expect(iso(p.replay)).toEqual(['10:00:00', '10:01:00', '10:02:00']);
  });
  test('a long outage stays cheap and bounded (a year at 15 s)', () => {
    const p = planCatchUp({ scheduledAt: S, now: new Date(S.getTime() + 365 * 86_400_000), intervalSeconds: 15, policy: 'replay', maxReplay: 20 });
    expect(p.missed).toBe(2_102_400);
    expect(p.replay).toHaveLength(20);
    expect(p.replay.at(-1)!.getTime()).toBe(S.getTime() + (p.missed - 1) * 15_000);
  });
  test('degenerate input: a future schedule, an invalid date or a zero interval miss nothing', () => {
    expect(planCatchUp({ scheduledAt: at(600), now: S, intervalSeconds: 60, policy: 'replay', maxReplay: 5 })).toEqual({ missed: 0, replay: [], skipped: 0 });
    expect(planCatchUp({ scheduledAt: new Date('x'), now: S, intervalSeconds: 60, policy: 'replay', maxReplay: 5 }).missed).toBe(0);
    expect(planCatchUp({ scheduledAt: S, now: at(600), intervalSeconds: 0, policy: 'replay', maxReplay: 5 }).missed).toBe(0);
  });
});
