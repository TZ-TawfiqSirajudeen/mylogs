import { describe, expect, test } from 'vitest';
import { compare, INITIAL, step, type GroupSnapshot, type Observation, type StateConfig, type Transition } from './state.js';

const T0 = Date.UTC(2026, 0, 1);
const at = (s: number) => new Date(T0 + s * 1000);
const cfg = (over: Partial<StateConfig> = {}): StateConfig => ({ condition: { op: 'gt', threshold: 10 }, forSeconds: 120, resolveAfterSeconds: 120, noDataPolicy: 'keep', ...over });
const hi: Observation = { kind: 'value', value: 50 };
const lo: Observation = { kind: 'value', value: 1 };
const nodata: Observation = { kind: 'no_data' };
const error: Observation = { kind: 'error' };

/** Feeds observations at the given offsets (seconds) and returns the status/transition after each. */
function run(c: StateConfig, steps: [number, Observation][], start: GroupSnapshot | null = null) {
  let s: GroupSnapshot | null = start;
  const out: { status: string; transition: Transition }[] = [];
  for (const [sec, o] of steps) {
    const r = step(s, o, c, at(sec));
    s = r.next;
    out.push({ status: r.next.status, transition: r.transition });
  }
  return out;
}

describe('comparison operators', () => {
  test.each([
    ['gt', 5, 5, false], ['gt', 6, 5, true], ['gte', 5, 5, true], ['lt', 4, 5, true], ['lt', 5, 5, false],
    ['lte', 5, 5, true], ['eq', 5, 5, true], ['eq', 5, 6, false], ['ne', 5, 6, true], ['ne', 5, 5, false],
  ] as const)('%s value=%s threshold=%s -> %s', (op, v, t, expected) => expect(compare(op, v, t)).toBe(expected));
});

describe('ok -> pending -> firing -> resolved', () => {
  test('the for-duration must elapse before a rule fires', () => {
    const r = run(cfg(), [[0, hi], [60, hi], [119, hi], [120, hi], [180, hi]]);
    expect(r.map((x) => x.status)).toEqual(['pending', 'pending', 'pending', 'firing', 'firing']);
    expect(r.map((x) => x.transition)).toEqual(['pending', 'none', 'none', 'fire', 'none']);
  });
  test('a for-duration of zero fires on the first breaching evaluation', () => {
    expect(run(cfg({ forSeconds: 0 }), [[0, hi]])).toEqual([{ status: 'firing', transition: 'fire' }]);
  });
  test('a pending rule that clears goes back to ok without ever firing', () => {
    const r = run(cfg(), [[0, hi], [60, lo], [120, hi]]);
    expect(r.map((x) => x.transition)).toEqual(['pending', 'cancel_pending', 'pending']); // the timer restarted at 120
    expect(r[2]!.status).toBe('pending');
  });
  test('resolve needs the condition to stay clear for resolveAfterSeconds (hysteresis)', () => {
    const r = run(cfg({ forSeconds: 0 }), [[0, hi], [10, lo], [60, lo], [129, lo], [130, lo]]);
    expect(r.map((x) => x.status)).toEqual(['firing', 'firing', 'firing', 'firing', 'resolved']);
    expect(r[4]!.transition).toBe('resolve');
  });
  test('flapping: a breach during recovery restarts the resolve timer and no new incident is opened', () => {
    const r = run(cfg({ forSeconds: 0, resolveAfterSeconds: 100 }), [[0, hi], [10, lo], [80, hi], [90, lo], [180, lo], [190, lo]]);
    expect(r.map((x) => x.transition)).toEqual(['fire', 'none', 'none', 'none', 'none', 'resolve']); // clear since 90 -> resolves at 190, never re-fired
  });
  test('resolveAfterSeconds of zero resolves on the first clear evaluation', () => {
    expect(run(cfg({ forSeconds: 0, resolveAfterSeconds: 0 }), [[0, hi], [5, lo]]).map((x) => x.transition)).toEqual(['fire', 'resolve']);
  });
  test('after resolving, a new breach starts over at pending (or fires at once without a for-duration)', () => {
    const r = run(cfg(), [[0, hi], [120, hi], [130, lo], [260, lo], [300, hi]]);
    expect(r.map((x) => x.status)).toEqual(['pending', 'firing', 'firing', 'resolved', 'pending']);
  });
});

describe('no data policy', () => {
  test('keep: missing data changes nothing (a firing rule stays firing, an ok rule stays ok)', () => {
    expect(run(cfg({ forSeconds: 0, noDataPolicy: 'keep' }), [[0, hi], [60, nodata], [600, nodata]]).map((x) => x.status)).toEqual(['firing', 'firing', 'firing']);
    expect(run(cfg({ noDataPolicy: 'keep' }), [[0, nodata], [60, nodata]]).map((x) => x.status)).toEqual(['ok', 'ok']);
  });
  test('ok: missing data counts as healthy, so a firing rule resolves after the hysteresis', () => {
    const r = run(cfg({ forSeconds: 0, noDataPolicy: 'ok' }), [[0, hi], [10, nodata], [200, nodata]]);
    expect(r.map((x) => x.transition)).toEqual(['fire', 'none', 'resolve']);
  });
  test('alert: missing data counts as a breach and fires after the for-duration', () => {
    const r = run(cfg({ noDataPolicy: 'alert' }), [[0, nodata], [120, nodata]]);
    expect(r.map((x) => x.transition)).toEqual(['pending', 'fire']);
  });
  test('noDataSince is remembered while data is missing and cleared when it returns', () => {
    let s = step(null, nodata, cfg(), at(0)).next;
    expect(s.noDataSince).toEqual(at(0));
    s = step(s, nodata, cfg(), at(60)).next;
    expect(s.noDataSince).toEqual(at(0));
    s = step(s, lo, cfg(), at(120)).next;
    expect(s.noDataSince).toBeNull();
  });
});

describe('evaluation errors', () => {
  test('an error never resolves a firing rule, never fires a pending one and never cancels it', () => {
    const c = cfg({ forSeconds: 0, resolveAfterSeconds: 0 });
    const fired = step(null, hi, c, at(0)).next;
    const afterErr = step(fired, error, c, at(10));
    expect(afterErr.transition).toBe('none');
    expect(afterErr.next).toEqual(fired);
    const pending = step(null, hi, cfg(), at(0)).next;
    const p2 = step(pending, error, cfg(), at(500));
    expect(p2.next.status).toBe('pending');
    expect(p2.transition).toBe('none');
  });
  test('an error in the middle of recovery does not advance or reset the hysteresis timer', () => {
    const c = cfg({ forSeconds: 0, resolveAfterSeconds: 100 });
    const r = run(c, [[0, hi], [10, lo], [50, error], [60, error], [110, lo]]);
    expect(r.map((x) => x.transition)).toEqual(['fire', 'none', 'none', 'none', 'resolve']); // clear since 10 -> resolves at 110
  });
});

// ------------------------------------------------------------------------------------------------ property-style tests
/** Small deterministic PRNG (mulberry32) so a failing sequence can be replayed from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

describe('property: invariants hold for thousands of random observation sequences', () => {
  const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);
  test('transitions are always legal and the timing guarantees hold', () => {
    for (const seed of SEEDS) {
      const rand = rng(seed);
      const c: StateConfig = {
        condition: { op: 'gt', threshold: 10 }, forSeconds: Math.floor(rand() * 4) * 60, resolveAfterSeconds: Math.floor(rand() * 4) * 60,
        noDataPolicy: (['ok', 'alert', 'keep'] as const)[Math.floor(rand() * 3)]!,
      };
      let snap: GroupSnapshot | null = null;
      let now = 0;
      let breachSince: number | null = null; // start of the current uninterrupted run of breaching observations (errors/keep-no-data do not interrupt)
      let clearSince: number | null = null;
      let fires = 0, resolves = 0;
      for (let i = 0; i < 80; i++) {
        now += 15 + Math.floor(rand() * 90);
        const roll = rand();
        const obs: Observation = roll < 0.4 ? hi : roll < 0.75 ? lo : roll < 0.9 ? nodata : error;
        const prev: GroupSnapshot = snap ?? INITIAL;
        const { next, transition } = step(snap, obs, c, at(now));
        const ctx = `seed=${seed} step=${i} obs=${obs.kind} prev=${prev.status} -> ${next.status} (${transition})`;

        // errors never change anything
        if (obs.kind === 'error') { expect(next, ctx).toEqual(prev); expect(transition, ctx).toBe('none'); }
        // legal edges only
        const legal: Record<string, string[]> = {
          ok: ['ok', 'pending', 'firing'], resolved: ['resolved', 'pending', 'firing'], pending: ['pending', 'ok', 'firing'], firing: ['firing', 'resolved'],
        };
        expect(legal[prev.status], ctx).toContain(next.status);
        // a rule can never go from ok straight to resolved, nor from pending to resolved
        if (prev.status === 'ok' || prev.status === 'pending') expect(next.status, ctx).not.toBe('resolved');

        const breaching = obs.kind === 'value' ? compare(c.condition.op, obs.value, c.condition.threshold) : obs.kind === 'no_data' && c.noDataPolicy === 'alert';
        const clear = obs.kind === 'value' ? !breaching : obs.kind === 'no_data' && c.noDataPolicy === 'ok';
        if (breaching) { breachSince ??= now; clearSince = null; } else if (clear) { clearSince ??= now; breachSince = null; }
        if (obs.kind === 'no_data' && c.noDataPolicy === 'keep') expect(next.status, ctx).toBe(prev.status);

        if (transition === 'fire') {
          fires++;
          // it fired only after the condition held for the whole for-duration (measured from the first breaching evaluation of this run)
          expect(['ok', 'resolved', 'pending'], ctx).toContain(prev.status);
          expect(now - breachSince!, ctx).toBeGreaterThanOrEqual(c.forSeconds);
        }
        if (transition === 'resolve') {
          resolves++;
          expect(prev.status, ctx).toBe('firing');
          expect(now - clearSince!, ctx).toBeGreaterThanOrEqual(c.resolveAfterSeconds);
        }
        // a firing rule never gives up while the condition is breaching
        if (prev.status === 'firing' && breaching) expect(next.status, ctx).toBe('firing');
        // resolves and fires alternate: never two fires without a resolve in between
        expect(fires - resolves, ctx).toBeGreaterThanOrEqual(0);
        expect(fires - resolves, ctx).toBeLessThanOrEqual(1);
        snap = next;
      }
    }
  });

  test('replaying the same observations gives byte-identical results (determinism)', () => {
    for (const seed of [7, 42, 1234]) {
      const play = () => {
        const rand = rng(seed);
        const c = cfg();
        let s: GroupSnapshot | null = null; const trace: string[] = [];
        for (let i = 0; i < 60; i++) {
          const r = step(s, rand() < 0.5 ? hi : lo, c, at(i * 30));
          s = r.next; trace.push(`${r.transition}:${r.next.status}:${r.next.since?.getTime() ?? 'x'}`);
        }
        return trace.join('|');
      };
      expect(play()).toBe(play());
    }
  });
});
