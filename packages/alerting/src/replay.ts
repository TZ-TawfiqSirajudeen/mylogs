import { REPLAY_LIMITS, type MissedPolicy } from '@nexus/contracts';

/**
 * Which evaluations were missed, and which of them to re-run (ADR-0010 #9-#10). Pure: the caller passes both instants.
 *
 * A rule is claimed when its scheduled time `scheduledAt` (= nextEvalAt) has passed. With interval `I`, the boundaries `scheduledAt + k*I` that are
 * not after `now` are DUE; the newest of them is satisfied by the evaluation that is happening right now, so the earlier ones were MISSED.
 * A merely late worker (less than one interval) therefore misses nothing.
 */
export interface CatchUpInput { scheduledAt: Date; now: Date; intervalSeconds: number; policy: MissedPolicy; maxReplay: number }
export interface CatchUpPlan {
  /** Boundaries that were due and not run on time. */
  missed: number;
  /** The boundaries to re-evaluate, oldest first (empty for `skip`). */
  replay: Date[];
  /** Missed boundaries that are only counted: all of them for `skip`, the oldest beyond the limit for `replay`. */
  skipped: number;
}

export function planCatchUp(i: CatchUpInput): CatchUpPlan {
  const intervalMs = i.intervalSeconds * 1000;
  const lateMs = i.now.getTime() - i.scheduledAt.getTime();
  if (!(intervalMs > 0) || !Number.isFinite(lateMs) || lateMs < 0) return { missed: 0, replay: [], skipped: 0 };
  const missed = Math.floor(lateMs / intervalMs);
  const limit = i.policy === 'replay' ? Math.max(0, Math.min(Math.floor(i.maxReplay) || 0, REPLAY_LIMITS.maxEvaluations)) : 0;
  const count = Math.min(limit, missed);
  const replay: Date[] = [];
  for (let k = missed - count; k < missed; k++) replay.push(new Date(i.scheduledAt.getTime() + k * intervalMs));
  return { missed, replay, skipped: missed - count };
}
