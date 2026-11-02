import type { ComparisonOp, NoDataPolicy } from '@nexus/contracts';

/**
 * The alert state machine for ONE group of ONE rule. Pure: no I/O, no clock (the caller passes `now`), so every transition is deterministic
 * and unit/property testable.
 *
 *   ok --breach--> pending --breach for >= forSeconds--> firing --clear for >= resolveAfterSeconds--> resolved
 *                     |                                    ^  |                                          |
 *                     +--clear--> ok                       +--+ breach during recovery resets the timer  +--breach--> pending/firing
 *
 * `resolved` behaves exactly like `ok` for the next observation; it only exists so the UI can show a recent recovery.
 * An evaluation ERROR never changes the state (a broken query must not resolve a real incident, nor open one).
 */
export type Observation = { kind: 'value'; value: number } | { kind: 'no_data' } | { kind: 'error' };
export type GroupStatus = 'ok' | 'pending' | 'firing' | 'resolved';
export type Transition = 'none' | 'pending' | 'fire' | 'cancel_pending' | 'resolve';

export interface StateConfig {
  condition: { op: ComparisonOp; threshold: number };
  forSeconds: number;
  resolveAfterSeconds: number;
  noDataPolicy: NoDataPolicy;
}
export interface GroupSnapshot {
  status: GroupStatus;
  /** When the group entered `status` (null for ok). */
  since: Date | null;
  /** While firing: when the condition first became clear (null = currently breaching). */
  okSince: Date | null;
  lastValue: number | null;
  noDataSince: Date | null;
}
export const INITIAL: GroupSnapshot = { status: 'ok', since: null, okSince: null, lastValue: null, noDataSince: null };

export function compare(op: ComparisonOp, value: number, threshold: number): boolean {
  switch (op) {
    case 'gt': return value > threshold;
    case 'gte': return value >= threshold;
    case 'lt': return value < threshold;
    case 'lte': return value <= threshold;
    case 'eq': return value === threshold;
    case 'ne': return value !== threshold;
  }
}

export function step(prev: GroupSnapshot | null, obs: Observation, cfg: StateConfig, now: Date): { next: GroupSnapshot; transition: Transition } {
  const p = prev ?? INITIAL;
  if (obs.kind === 'error') return { next: { ...p }, transition: 'none' };

  let breaching: boolean;
  let lastValue = p.lastValue;
  let noDataSince: Date | null = null;
  if (obs.kind === 'value') {
    breaching = compare(cfg.condition.op, obs.value, cfg.condition.threshold);
    lastValue = obs.value;
  } else {
    noDataSince = p.noDataSince ?? now;
    if (cfg.noDataPolicy === 'keep') return { next: { ...p, noDataSince }, transition: 'none' };
    breaching = cfg.noDataPolicy === 'alert';
  }

  const base = { lastValue, noDataSince };
  const inactive = p.status === 'ok' || p.status === 'resolved';
  if (breaching) {
    if (inactive) {
      if (cfg.forSeconds === 0) return { next: { ...base, status: 'firing', since: now, okSince: null }, transition: 'fire' };
      return { next: { ...base, status: 'pending', since: now, okSince: null }, transition: 'pending' };
    }
    if (p.status === 'pending') {
      if (now.getTime() - p.since!.getTime() >= cfg.forSeconds * 1000) return { next: { ...base, status: 'firing', since: now, okSince: null }, transition: 'fire' };
      return { next: { ...base, status: 'pending', since: p.since, okSince: null }, transition: 'none' };
    }
    // firing and still breaching: a breach during recovery restarts the hysteresis timer
    return { next: { ...base, status: 'firing', since: p.since, okSince: null }, transition: 'none' };
  }

  // not breaching
  if (inactive) return { next: { ...base, status: p.status, since: p.since, okSince: null }, transition: 'none' };
  if (p.status === 'pending') return { next: { ...base, status: 'ok', since: null, okSince: null }, transition: 'cancel_pending' };
  const okSince = p.okSince ?? now;
  if (cfg.resolveAfterSeconds === 0 || now.getTime() - okSince.getTime() >= cfg.resolveAfterSeconds * 1000) {
    return { next: { ...base, status: 'resolved', since: now, okSince: null }, transition: 'resolve' };
  }
  return { next: { ...base, status: 'firing', since: p.since, okSince }, transition: 'none' };
}

export const describeOp = (op: ComparisonOp) => ({ gt: '>', gte: '>=', lt: '<', lte: '<=', eq: '=', ne: '!=' })[op];
export const formatDuration = (seconds: number) =>
  seconds % 3600 === 0 && seconds >= 3600 ? `${seconds / 3600}h` : seconds % 60 === 0 ? `${seconds / 60}m` : `${seconds}s`;
