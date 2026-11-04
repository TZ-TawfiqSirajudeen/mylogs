import { ALERT_LIMITS, PREVIEW_LIMITS, type PreviewGroup, type RulePreviewBody, type RulePreviewResult } from '@nexus/contracts';
import { AlertingError } from './common.js';
import { evaluateQuery, type EvalDeps, type EvalResult, type GroupObservation } from './evaluator.js';
import { describeOp, formatDuration, step, type GroupSnapshot, type Observation } from './state.js';

/**
 * Rule PREVIEW (ADR-0009): replays a draft rule over a bounded stretch of history and reports what it WOULD have done.
 *
 * It contains no threshold, aggregation or hysteresis logic of its own: every evaluation time goes through the real `evaluateQuery` (with the
 * evaluation time as the injected clock) and every group's observations are folded through the real state machine `step()`.
 *
 * Read-only by construction: the service is given the two store read interfaces and a clock, and nothing else (no database, no incident service,
 * no notifier, no lease, no audit sink), so it cannot write an incident, a notification or a rule state.
 */
export interface PreviewOptions {
  /** The end of the replayed range ("now"). Injected so tests are deterministic. */
  now?: () => Date;
  /** Monotonic-ish wall clock in ms, used only for the deadline. */
  clockMs?: () => number;
  deadlineMs?: number;
  /** Time one evaluation may take (the engine's per-rule budget). */
  pointBudgetMs?: number;
  concurrency?: number;
  maxPoints?: number;
  maxStoreQueries?: number;
  maxConcurrentPreviews?: number;
}

/** Thrown inside an evaluation when the preview's own limits (not the store's) say stop. */
class StopPreview extends Error {
  constructor(readonly reason: 'deadline' | 'queries') { super(reason); }
}

const safeMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, 300);

interface Tracked {
  labels: Record<string, string>; snap: GroupSnapshot | null; values: (number | null)[]; states: PreviewGroup['states'];
  periods: PreviewGroup['periods']; open: { kind: 'pending' | 'firing'; from: number } | null; wouldOpen: number; noData: number;
}

export class RulePreviewService {
  private inflight = 0;
  constructor(private readonly deps: EvalDeps, private readonly o: PreviewOptions = {}) {}

  async preview(scope: { orgId: string; projectId: string }, body: RulePreviewBody): Promise<RulePreviewResult> {
    const maxConcurrent = this.o.maxConcurrentPreviews ?? PREVIEW_LIMITS.maxConcurrentPerProcess;
    if (this.inflight >= maxConcurrent) throw new AlertingError(429, 'busy', 'Too many rule previews are running right now. Try again in a few seconds.');
    this.inflight++;
    try { return await this.run(scope, body); } finally { this.inflight--; }
  }

  private async run(scope: { orgId: string; projectId: string }, body: RulePreviewBody): Promise<RulePreviewResult> {
    const clockMs = this.o.clockMs ?? Date.now;
    const started = clockMs();
    const deadline = started + (this.o.deadlineMs ?? PREVIEW_LIMITS.deadlineMs);
    const pointBudget = this.o.pointBudgetMs ?? 10_000;
    const concurrency = Math.max(1, this.o.concurrency ?? PREVIEW_LIMITS.concurrency);
    const maxPoints = Math.min(this.o.maxPoints ?? PREVIEW_LIMITS.maxPoints, PREVIEW_LIMITS.maxPoints);
    const maxQueries = this.o.maxStoreQueries ?? PREVIEW_LIMITS.maxStoreQueries;
    const rule = body.rule;
    const range = Math.min(Math.max(body.rangeSeconds, PREVIEW_LIMITS.minRangeSeconds), PREVIEW_LIMITS.maxRangeSeconds);

    // Evaluation times: the rule's interval, widened so the range never needs more than `maxPoints` evaluations.
    const stepSeconds = Math.max(rule.intervalSeconds, Math.ceil(range / (maxPoints - 1)));
    const endMs = Math.floor((this.o.now?.() ?? new Date()).getTime() / 1000) * 1000;
    const count = Math.floor(range / stepSeconds) + 1;
    const times = Array.from({ length: count }, (_, i) => endMs - (count - 1 - i) * stepSeconds * 1000);

    // The evaluator is handed the rule's own scope (taken from the session by the caller, never from the request body).
    const doc = { orgId: scope.orgId, projectId: scope.projectId, environmentId: rule.environmentId, query: rule.query as never, windowSeconds: rule.windowSeconds };
    let storeQueries = 0;
    const counted: EvalDeps = {
      metrics: { query: (s, q) => { if (++storeQueries > maxQueries) throw new StopPreview('queries'); return this.deps.metrics.query(s, q); } },
      logs: { histogram: (s, q, b) => { if (++storeQueries > maxQueries) throw new StopPreview('queries'); return this.deps.logs.histogram(s, q, b); } },
    };

    const evalAt = (t: number): Promise<EvalResult> => {
      const left = deadline - clockMs();
      if (left <= 0) return Promise.reject(new StopPreview('deadline'));
      const budget = Math.min(pointBudget, left);
      let timer: NodeJS.Timeout;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(budget === left ? new StopPreview('deadline') : new Error(`Evaluation exceeded its time budget of ${pointBudget} ms`)), budget);
      });
      return Promise.race([evaluateQuery(doc, counted, new Date(t)), timeout]).finally(() => clearTimeout(timer));
    };

    // The first evaluation runs alone: a query the store refuses (unsupported aggregation, too expensive, time-out) fails the preview once,
    // with the store's message, instead of failing 200 times.
    const results: ({ ok: true; res: EvalResult } | { ok: false; error: string })[] = [];
    let partial = false;
    let partialReason: 'deadline' | 'queries' | null = null;
    try {
      results.push({ ok: true, res: await evalAt(times[0]!) });
    } catch (e) {
      if (e instanceof StopPreview) throw new AlertingError(504, 'preview_timeout', 'The preview took too long. Try a shorter range or a narrower filter.');
      throw new AlertingError(422, 'preview_failed', `The rule could not be evaluated: ${safeMessage(e)}`);
    }

    outer: for (let i = 1; i < times.length; i += concurrency) {
      const chunk = times.slice(i, i + concurrency);
      const settled = await Promise.allSettled(chunk.map((t) => evalAt(t)));
      for (const s of settled) {
        if (s.status === 'fulfilled') { results.push({ ok: true, res: s.value }); continue; }
        if (s.reason instanceof StopPreview) { partial = true; partialReason = s.reason.reason; break outer; }
        results.push({ ok: false, error: safeMessage(s.reason) });
      }
    }

    // ---- fold the observations through the real state machine, oldest first
    const evaluated = results.length;
    const used = times.slice(0, evaluated);
    const tracked = new Map<string, Tracked>();
    let truncatedGroups = false;
    let storeTruncated = false;
    const skipped: number[] = [];
    let noDataPoints = 0;
    let noDataGroupPoints = 0;

    results.forEach((r, i) => {
      const t = used[i]!;
      if (!r.ok) {
        skipped.push(i);
        for (const g of tracked.values()) { g.values.push(null); g.states.push(g.snap?.status ?? 'ok'); }
        return;
      }
      if (r.res.truncated) { storeTruncated = true; }
      const observed = new Map<string, GroupObservation>(r.res.groups.map((g) => [g.key, g]));
      for (const [key, g] of observed) {
        if (tracked.has(key)) continue;
        if (tracked.size >= ALERT_LIMITS.maxGroupsPerRule) { truncatedGroups = true; continue; }
        tracked.set(key, { labels: g.labels, snap: null, values: Array<number | null>(i).fill(null), states: Array(i).fill('ok'), periods: [], open: null, wouldOpen: 0, noData: 0 });
      }
      if (r.res.truncated) truncatedGroups = truncatedGroups || r.res.groups.length >= ALERT_LIMITS.maxGroupsPerRule;
      let anyData = false;
      for (const [key, g] of tracked) {
        const obs: Observation = observed.get(key)?.obs ?? { kind: 'no_data' };
        if (obs.kind === 'no_data') { g.noData++; noDataGroupPoints++; } else anyData = true;
        const { next, transition } = step(g.snap, obs, rule, new Date(t));
        const before = g.snap?.status ?? 'ok';
        g.snap = next;
        g.values.push(obs.kind === 'value' ? obs.value : null);
        g.states.push(next.status);
        if (transition === 'fire') g.wouldOpen++;
        if (next.status !== before) {
          if (g.open) { g.periods.push({ kind: g.open.kind, from: new Date(g.open.from).toISOString(), to: new Date(t).toISOString(), ongoing: false }); g.open = null; }
          if (next.status === 'pending' || next.status === 'firing') g.open = { kind: next.status, from: t };
        }
      }
      if (!anyData) noDataPoints++;
    });
    const lastT = used[used.length - 1] ?? endMs;
    const groups: PreviewGroup[] = [...tracked].map(([key, g]) => {
      const periods = [...g.periods];
      if (g.open) periods.push({ kind: g.open.kind, from: new Date(g.open.from).toISOString(), to: new Date(lastT).toISOString(), ongoing: true });
      return { key, labels: g.labels, values: g.values, states: g.states, periods, wouldOpen: g.wouldOpen, noDataPoints: g.noData };
    });

    const totals = {
      wouldOpenIncidents: groups.reduce((n, g) => n + g.wouldOpen, 0),
      groupsThatWouldFire: groups.filter((g) => g.wouldOpen > 0).length,
      evaluationPoints: times.length, evaluatedPoints: evaluated - skipped.length, noDataPoints, skippedPoints: skipped.length, storeQueries,
    };

    // ---- plain-language notes (computed here so every client says the same thing)
    const notes: string[] = [];
    if (totals.evaluatedPoints > 0 && noDataPoints === totals.evaluatedPoints) {
      notes.push('There was no data at all in this range for this selection. Check the metric name, service, labels and environment; a rule on a missing series never fires unless the no-data policy is "treat as a problem".');
    } else if (noDataPoints > 0 || noDataGroupPoints > 0) {
      const policy = rule.noDataPolicy === 'keep'
        ? 'The policy "keep the current state" was applied, so those points neither fired nor resolved anything.'
        : rule.noDataPolicy === 'ok' ? 'The policy "treat missing data as healthy" was applied: those points counted as clear (a firing rule resolves after the clear period).'
          : 'The policy "treat missing data as a problem" was applied: those points counted as breaches (and can fire the rule after the "must hold for" time).';
      notes.push(`No data at ${noDataPoints > 0 ? `${noDataPoints} of ${totals.evaluatedPoints} evaluation times (for the whole rule)` : 'some evaluation times (for some groups)'}. ${policy} Missing data is never drawn as zero.`);
    }
    if (stepSeconds > rule.intervalSeconds) notes.push(`The range needs more than ${maxPoints} evaluations at the rule's ${formatDuration(rule.intervalSeconds)} interval, so it was replayed every ${formatDuration(stepSeconds)}. "Must hold for" and "stay clear" times are therefore only accurate to ${formatDuration(stepSeconds)}; a short spike between two evaluation times is not shown.`);
    notes.push('The replay starts from "ok": a problem that was already under way at the start of the range looks as if it started there.');
    notes.push('Computed from the data stored now, not from what each live evaluation could see at the time (late-arriving records are included). Silences, notifications and the number of channels are not part of a preview.');
    if (skipped.length) notes.push(`${skipped.length} evaluation time(s) failed and were skipped; like a live evaluation, a failure changes no state.`);
    if (truncatedGroups) notes.push(`More than ${ALERT_LIMITS.maxGroupsPerRule} groups matched: only the first ${ALERT_LIMITS.maxGroupsPerRule} are shown (a live rule tracks at most ${ALERT_LIMITS.maxGroupsPerRule} too).`);
    else if (storeTruncated) notes.push('The store returned only the largest series of this metric; add a service or label filter for a complete picture.');
    if (partial) notes.push(partialReason === 'queries'
      ? `The preview reached its limit of ${maxQueries} store queries after ${used.length} of ${times.length} evaluation times; only the first part of the range is shown. Use a shorter range.`
      : `The preview ran out of time after ${used.length} of ${times.length} evaluation times; only the first part of the range is shown. Use a shorter range or a narrower filter.`);

    return {
      from: new Date(times[0]!).toISOString(), to: new Date(endMs).toISOString(), rangeSeconds: range, stepSeconds, intervalSeconds: rule.intervalSeconds, windowSeconds: rule.windowSeconds,
      condition: { op: rule.condition.op, threshold: rule.condition.threshold }, times: used, skipped, groups, totals, truncatedGroups, partial, notes, elapsedMs: clockMs() - started,
    };
  }
}

/** One-line plain-language summary of a preview result (also used by the UI). */
export function summarizePreview(r: Pick<RulePreviewResult, 'totals' | 'condition' | 'windowSeconds' | 'rangeSeconds'>): string {
  const n = r.totals.wouldOpenIncidents;
  return `With ${describeOp(r.condition.op)} ${r.condition.threshold} over ${formatDuration(r.windowSeconds)}, this rule would have opened ${n} incident${n === 1 ? '' : 's'} in the last ${formatDuration(r.rangeSeconds)}.`;
}
