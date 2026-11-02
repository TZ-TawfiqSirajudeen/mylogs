import { describe, expect, test } from 'vitest';
import { replicationSamples } from './mongodb.js';

const d = (iso: string) => new Date(iso);
const status = (over: { selfWall?: string; primWall?: string; selfOp?: string; primOp?: string; primaryHealth?: number; primaryState?: string; noPrimary?: boolean }) => ({
  set: 'rs0', myState: 2,
  members: [
    { name: 'a:1', self: true, stateStr: 'SECONDARY', health: 1, optimeDate: d(over.selfOp ?? '2026-01-01T00:00:10Z'), ...(over.selfWall ? { lastAppliedWallTime: d(over.selfWall) } : {}) },
    ...(over.noPrimary ? [] : [{ name: 'b:1', stateStr: over.primaryState ?? 'PRIMARY', health: over.primaryHealth ?? 1, optimeDate: d(over.primOp ?? '2026-01-01T00:00:10Z'), ...(over.primWall ? { lastAppliedWallTime: d(over.primWall) } : {}) }]),
  ],
});
const lag = (rs: object) => replicationSamples(rs as never, 'a:1').find((s) => s.name === 'mongodb.replication.lag')?.value;

describe('replication lag arithmetic', () => {
  test('uses millisecond wall times when both members report them (optimeDate is whole seconds and can be seconds off on an idle set)', () => {
    expect(lag(status({ selfWall: '2026-01-01T00:00:08.064Z', primWall: '2026-01-01T00:00:08.121Z', selfOp: '2026-01-01T00:00:02Z', primOp: '2026-01-01T00:00:08Z' }))).toBeCloseTo(0.057, 6);
  });
  test('falls back to optimeDate for servers that do not report wall times', () => {
    expect(lag(status({ selfOp: '2026-01-01T00:00:05Z', primOp: '2026-01-01T00:00:12Z' }))).toBe(7);
  });
  test('never negative (the primary figure is a heartbeat old); never reported against a primary that is marked down or absent', () => {
    expect(lag(status({ selfWall: '2026-01-01T00:00:09Z', primWall: '2026-01-01T00:00:08Z' }))).toBe(0);
    expect(lag(status({ selfWall: '2026-01-01T00:00:01Z', primWall: '2026-01-01T00:00:30Z', primaryHealth: 0 }))).toBeUndefined();
    expect(lag(status({ primaryState: '(not reachable/healthy)' }))).toBeUndefined();
    expect(lag(status({ noPrimary: true }))).toBeUndefined();
  });
  test('only one of the two reports a wall time: optimeDate is used for both (never mixed units)', () => {
    expect(lag(status({ selfWall: '2026-01-01T00:00:10.500Z', selfOp: '2026-01-01T00:00:08Z', primOp: '2026-01-01T00:00:10Z' }))).toBe(2);
  });
});
