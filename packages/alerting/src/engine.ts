import { ALERT_LIMITS, REPLAY_LIMITS } from '@nexus/contracts';
import type { AlertGroupState, AlertRuleDoc, Database } from '@nexus/database';
import { ruleCol } from './common.js';
import { evaluateQuery, type EvalDeps, type EvalResult, type GroupObservation } from './evaluator.js';
import type { IncidentService, ReplayInfo } from './incidents.js';
import { planCatchUp } from './replay.js';
import { INITIAL, step, type GroupSnapshot, type Observation } from './state.js';

export interface EngineOptions {
  owner: string;
  /** The clock. Injected so tests are deterministic. */
  now?: () => Date;
  /** Upper bound on rules evaluated per tick: a backlog is worked off over several ticks, never in one unbounded burst. */
  maxRulesPerTick?: number;
  /** Rules evaluated at the same time. */
  concurrency?: number;
  /** Time one rule may take (queries included). A rule that exceeds it is abandoned for this round and recorded as an evaluation error. */
  ruleBudgetMs?: number;
  /** Total time one claim may spend replaying missed boundaries (default: twice the rule budget); the remaining boundaries are counted as skipped. */
  replayBudgetMs?: number;
  /** How long a `resolved` group stays visible in the rule's state before it is dropped. */
  keepResolvedMs?: number;
  log?: (level: 'info' | 'warn' | 'error', msg: string, fields?: Record<string, unknown>) => void;
}

export interface EngineMetrics {
  ticks: number; rulesEvaluated: number; evaluationErrors: number; budgetExceeded: number; incidentsOpened: number; incidentsResolved: number;
  /** Interval boundaries that were due but not run on time, boundaries re-evaluated by a replay, and catch-up notices created (ADR-0010). */
  evaluationsMissed: number; evaluationsReplayed: number; catchUpNotices: number;
  lastTickAt: number | null; lastTickDurationMs: number | null; lastTickRules: number;
}

export interface EvalOutcome {
  ruleId: string; ok: boolean; error?: string; opened: number; resolved: number;
  /** Boundaries that were due and not run on time, and how many of them were re-evaluated. */
  missed: number; replayed: number;
  /** True when a replay stopped because the rule was edited or its lease was taken over: nothing more was written. */
  aborted?: boolean;
}
interface CatchUpNotice { incidentId: string; event: 'incident.opened' | 'incident.resolved' }

const ERROR_TEXT_MAX = 300;
const safeMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, ERROR_TEXT_MAX);

const toSnapshot = (g: AlertGroupState | undefined): GroupSnapshot | null =>
  g ? { status: g.status, since: g.since, okSince: g.okSince, lastValue: g.lastValue, noDataSince: g.noDataSince } : null;

/**
 * The evaluation scheduler. A tick LEASES due rules (atomic claim, so several workers share the load without ever evaluating the same rule at the
 * same time), evaluates each one against the metric/log stores, advances the per-group state machine, opens/closes incidents and releases the lease.
 *
 * Guarantees (each covered by tests):
 *  - bounded work: at most `maxRulesPerTick` rules per tick and `concurrency` at once; rules are taken oldest-due first, and a rule's next run is
 *    always scheduled (even after an error or a timeout), so one slow or failing rule cannot starve the others;
 *  - an evaluation error never changes state and never resolves anything;
 *  - a rule edited while it was being evaluated discards that evaluation's state (optimistic version check);
 *  - a crashed worker's leases expire and the rules are picked up again;
 *  - missed evaluations (worker down, lease expired) are counted, and for rules with `missedPolicy: replay` the latest few are re-evaluated in order at
 *    their own interval boundary, each persisted before the next (ADR-0010).
 */
export class AlertEngine {
  readonly metrics: EngineMetrics = {
    ticks: 0, rulesEvaluated: 0, evaluationErrors: 0, budgetExceeded: 0, incidentsOpened: 0, incidentsResolved: 0, evaluationsMissed: 0, evaluationsReplayed: 0, catchUpNotices: 0,
    lastTickAt: null, lastTickDurationMs: null, lastTickRules: 0,
  };
  private readonly now: () => Date;
  private readonly maxRules: number;
  private readonly concurrency: number;
  private readonly budgetMs: number;
  private readonly keepResolvedMs: number;
  private readonly replayBudgetMs: number;

  constructor(private readonly db: Database, private readonly deps: EvalDeps, private readonly incidents: IncidentService, private readonly o: EngineOptions) {
    this.now = o.now ?? (() => new Date());
    this.maxRules = o.maxRulesPerTick ?? 50;
    this.concurrency = o.concurrency ?? 4;
    this.budgetMs = o.ruleBudgetMs ?? 10_000;
    this.keepResolvedMs = o.keepResolvedMs ?? 3_600_000;
    this.replayBudgetMs = o.replayBudgetMs ?? this.budgetMs * 2;
  }

  private leaseMs() { return this.budgetMs * 2 + 5_000; }

  private claim(now: Date): Promise<AlertRuleDoc | null> {
    return ruleCol(this.db).findOneAndUpdate(
      { kind: 'rule', enabled: true, nextEvalAt: { $lte: now }, $or: [{ lease: null }, { 'lease.until': { $lt: now } }] },
      { $set: { lease: { owner: this.o.owner, until: new Date(now.getTime() + this.leaseMs()) } } },
      { sort: { nextEvalAt: 1 }, returnDocument: 'after' },
    );
  }

  /** One scheduling pass. Resolves when every rule it claimed has been processed. */
  async tick(): Promise<EvalOutcome[]> {
    const t0 = Date.now();
    const outcomes: EvalOutcome[] = [];
    let remaining = this.maxRules;
    const lane = async () => {
      while (remaining > 0) {
        remaining--;
        const rule = await this.claim(this.now());
        if (!rule) return;
        outcomes.push(await this.evaluateRule(rule));
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, this.maxRules) }, lane));
    this.metrics.ticks++;
    this.metrics.lastTickAt = Date.now();
    this.metrics.lastTickDurationMs = Date.now() - t0;
    this.metrics.lastTickRules = outcomes.length;
    return outcomes;
  }

  private withBudget<T>(p: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Evaluation exceeded its time budget of ${this.budgetMs} ms`)), this.budgetMs); });
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
  }

  private isStale(at: Date, replay: ReplayInfo) { return replay.processedAt.getTime() - at.getTime() > replay.staleAfterSeconds * 1000; }

  /**
   * Applies one set of observations to the stored group states at `at` and performs the incident side effects. `at` is the clock of the state machine:
   * the real time for a normal evaluation, the interval boundary for a replayed one (ADR-0010). Never throws.
   */
  private async advance(rule: AlertRuleDoc, prevGroups: AlertGroupState[], result: EvalResult, at: Date, replay: ReplayInfo | undefined, outcome: EvalOutcome, notices: CatchUpNotice[]) {
    const live = await this.incidents.liveGroupKeys(rule.orgId, rule.projectId, rule._id);
    const observed = new Map<string, GroupObservation>(result.groups.map((g) => [g.key, g]));
    const known = new Map(prevGroups.map((g) => [g.key, g]));
    const keys = [...new Set([...known.keys(), ...observed.keys()])];
    const next: AlertGroupState[] = [];
    let truncated = result.truncated;
    let failure: string | null = null;
    let lastValue: number | null = null;
    let ruleNoDataSince: Date | null = null;
    const stale = !!replay && this.isStale(at, replay);

    for (const key of keys) {
      const g = observed.get(key);
      // A group that was tracked but is absent from the result has no data now. An ungrouped rule always reports exactly one group.
      const obs: Observation = g?.obs ?? { kind: 'no_data' };
      const labels = g?.labels ?? known.get(key)?.labels ?? {};
      const prevDoc = known.get(key);
      let prev = toSnapshot(prevDoc);
      // The incident of a firing group was resolved by a person: judge the group afresh (it may open a new incident if it is still breaching).
      if (prev?.status === 'firing' && !live.has(key)) prev = INITIAL;
      if (!prev && next.filter((n) => n.status !== 'resolved').length >= ALERT_LIMITS.maxGroupsPerRule) { truncated = true; continue; }

      const { next: snap, transition } = step(prev, obs, rule, at);
      let incidentId = prevDoc?.incidentId ?? null;
      let keep = snap;
      try {
        if (transition === 'fire') {
          const r = await this.incidents.open(rule, { key, labels }, snap.lastValue, at, replay);
          incidentId = r.incident._id;
          if (r.created) {
            this.metrics.incidentsOpened++; outcome.opened++;
            if (stale) notices.push({ incidentId: r.incident._id, event: 'incident.opened' });
          }
        } else if (transition === 'resolve') {
          const r = await this.incidents.autoResolve({ orgId: rule.orgId, projectId: rule.projectId, ruleId: rule._id, groupKey: key }, 'recovered', at, snap.lastValue, replay);
          if (r) {
            this.metrics.incidentsResolved++; outcome.resolved++;
            if (stale) notices.push({ incidentId: r._id, event: 'incident.resolved' });
          }
          incidentId = null;
        } else if (snap.status === 'firing' && obs.kind === 'value') {
          await this.incidents.touchValue(rule.orgId, rule.projectId, rule._id, key, obs.value);
        }
      } catch (e) {
        // The side effect failed: keep the previous state so the same transition is attempted again on the next evaluation.
        failure = safeMessage(e);
        keep = prev ?? INITIAL;
        if (!prev) continue;
      }
      if (key === '' && obs.kind === 'value') lastValue = obs.value;
      if (key === '' && snap.noDataSince) ruleNoDataSince = snap.noDataSince;
      if (keep.status === 'ok') continue;
      if (keep.status === 'resolved' && at.getTime() - (keep.since?.getTime() ?? 0) > this.keepResolvedMs) continue;
      next.push({ key, labels, status: keep.status, since: keep.since ?? at, lastValue: keep.lastValue, lastEvalAt: at, okSince: keep.okSince, incidentId, noDataSince: keep.noDataSince });
    }
    return { groups: next, truncated, failure, lastValue, noDataSince: ruleNoDataSince };
  }

  /** Evaluates one claimed rule, replaying missed interval boundaries first when its policy says so, and persists the result. Never throws. */
  async evaluateRule(rule: AlertRuleDoc): Promise<EvalOutcome> {
    const now = this.now();
    const intervalMs = rule.intervalSeconds * 1000;
    const nextEvalAt = new Date(now.getTime() + intervalMs);
    const guard = { kind: 'rule' as const, _id: rule._id, version: rule.version, 'lease.owner': this.o.owner };
    const catchUp = planCatchUp({
      scheduledAt: rule.nextEvalAt ?? now, now, intervalSeconds: rule.intervalSeconds, policy: rule.missedPolicy ?? 'skip', maxReplay: rule.maxReplayEvaluations ?? REPLAY_LIMITS.defaultMaxEvaluations,
    });
    const outcome: EvalOutcome = { ruleId: rule._id, ok: true, opened: 0, resolved: 0, missed: catchUp.missed, replayed: 0 };
    this.metrics.rulesEvaluated++;
    this.metrics.evaluationsMissed += catchUp.missed;

    // Counters not yet written. They are flushed by the next guarded update (the same write that moves the rule forward), so a retried step is never counted twice.
    const pending = { total: catchUp.missed, replayed: 0, skipped: catchUp.skipped };
    const withCounters = (set: Record<string, unknown>) => {
      const inc: Record<string, number> = {};
      if (pending.total) inc['missed.total'] = pending.total;
      if (pending.replayed) inc['missed.replayed'] = pending.replayed;
      if (pending.skipped) inc['missed.skipped'] = pending.skipped;
      const hadMissed = pending.total > 0;
      pending.total = pending.replayed = pending.skipped = 0;
      return { $set: { ...set, ...(hadMissed ? { 'missed.lastAt': now } : {}) }, ...(Object.keys(inc).length ? { $inc: inc } : {}) };
    };

    let groups = rule.groups;
    let truncatedGroups = rule.truncatedGroups;
    const notices: CatchUpNotice[] = [];

    // ---- replay of missed boundaries: oldest first, each persisted before the next (a crash resumes, it never starts over)
    if (catchUp.replay.length > 0) {
      const info: ReplayInfo = { processedAt: now, staleAfterSeconds: rule.staleNotificationSeconds ?? REPLAY_LIMITS.defaultStaleSeconds };
      const deadline = Date.now() + this.replayBudgetMs;
      for (let i = 0; i < catchUp.replay.length; i++) {
        const at = catchUp.replay[i]!;
        if (Date.now() >= deadline) {
          pending.skipped += catchUp.replay.length - i;
          this.o.log?.('warn', 'replay budget exhausted', { rule: rule._id, remaining: catchUp.replay.length - i });
          break;
        }
        let result: EvalResult;
        try {
          result = await this.withBudget(evaluateQuery(rule, this.deps, at));
        } catch (e) {
          // like any failed evaluation: nothing changes; this boundary is simply lost
          pending.skipped++;
          this.metrics.evaluationErrors++;
          this.o.log?.('warn', 'replayed evaluation failed', { rule: rule._id, at: at.toISOString(), error: safeMessage(e) });
          continue;
        }
        try {
          const adv = await this.advance(rule, groups, result, at, info, outcome, notices);
          groups = adv.groups; truncatedGroups = adv.truncated;
          pending.replayed++; outcome.replayed++; this.metrics.evaluationsReplayed++;
          if (adv.failure) { this.metrics.evaluationErrors++; this.o.log?.('error', 'incident update failed during replay', { rule: rule._id, error: adv.failure }); }
          const u = await ruleCol(this.db).updateOne(guard, withCounters({
            groups, truncatedGroups, lastEvaluatedAt: at, nextEvalAt: new Date(at.getTime() + intervalMs),
            lease: { owner: this.o.owner, until: new Date(this.now().getTime() + this.leaseMs()) },
          }) as never);
          if (u.matchedCount === 0) return { ...outcome, aborted: true }; // the rule was edited or its lease was taken over: it is not ours any more
        } catch (e) {
          const message = safeMessage(e);
          this.metrics.evaluationErrors++;
          this.o.log?.('error', 'replay state update failed', { rule: rule._id, error: message });
          await ruleCol(this.db).updateOne(guard, { $set: { lease: null, health: 'error', lastError: { at: now, message: `State update failed: ${message}` } } }).catch(() => undefined);
          return { ...outcome, ok: false, error: message };
        }
      }
    }

    // ---- the evaluation that is due now
    const release = { lease: null, nextEvalAt, lastEvaluatedAt: now };
    let result: EvalResult;
    try {
      result = await this.withBudget(evaluateQuery(rule, this.deps, now));
    } catch (e) {
      // A failed evaluation changes NOTHING about the alert state: a broken query must not resolve a real incident or open a phantom one.
      const message = safeMessage(e);
      if (/time budget/.test(message)) this.metrics.budgetExceeded++;
      this.metrics.evaluationErrors++;
      this.o.log?.('warn', 'rule evaluation failed', { rule: rule._id, error: message });
      await ruleCol(this.db).updateOne(guard, withCounters({ ...release, health: 'error', lastError: { at: now, message } }) as never);
      return { ...outcome, ok: false, error: message };
    }

    try {
      const adv = await this.advance(rule, groups, result, now, undefined, outcome, notices);
      const failure = adv.failure;
      // Progress is persisted even when one group's side effect failed (the failed group keeps its previous state and is retried next time).
      if (failure) { this.metrics.evaluationErrors++; this.o.log?.('error', 'incident update failed', { rule: rule._id, error: failure }); }
      const u = await ruleCol(this.db).updateOne(guard, withCounters({
        ...release, groups: adv.groups, truncatedGroups: adv.truncated, lastValue: adv.lastValue, noDataSince: adv.noDataSince,
        health: failure ? 'error' : 'ok', lastError: failure ? { at: now, message: `Incident update failed: ${failure}` } : null,
      }) as never);
      if (u.matchedCount > 0) await this.sendCatchUpNotices(rule, notices, now);
      return failure ? { ...outcome, ok: false, error: failure } : outcome;
    } catch (e) {
      const message = safeMessage(e);
      this.metrics.evaluationErrors++;
      this.o.log?.('error', 'rule state update failed', { rule: rule._id, error: message });
      await ruleCol(this.db).updateOne(guard, { $set: { ...release, health: 'error', lastError: { at: now, message: `State update failed: ${message}` } } }).catch(() => undefined);
      return { ...outcome, ok: false, error: message };
    }
  }

  /** At most one notice per incident about its CURRENT state, for incidents whose own (replayed, stale) notification was not sent. Best effort. */
  private async sendCatchUpNotices(rule: AlertRuleDoc, notices: CatchUpNotice[], now: Date) {
    const seen = new Set<string>();
    for (const n of notices) {
      const key = `${n.incidentId}:${n.event}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        if (await this.incidents.notifyCatchUp(rule, n.incidentId, n.event, now)) this.metrics.catchUpNotices++;
      } catch (e) {
        this.o.log?.('warn', 'catch-up notice failed', { rule: rule._id, incident: n.incidentId, error: safeMessage(e) });
      }
    }
  }
}
