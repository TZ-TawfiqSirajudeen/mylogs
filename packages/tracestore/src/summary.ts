import type { SpanDoc, TraceSummaryDoc } from '@nexus/database';

/** The span fields a summary needs. Attributes, events and links are deliberately NOT loaded: summaries are cheap to recompute. */
export type SpanSlim = Pick<SpanDoc,
  'spanId' | 'parentSpanId' | 'name' | 'kind' | 'start' | 'end' | 'startNsFrac' | 'endNsFrac' | 'timingValid' | 'statusCode' | 'service' |
  'httpMethod' | 'httpRoute' | 'httpStatus' | 'dbSystem' | 'exceptionType' | 'expireAt'>;

export const SLIM_PROJECTION = {
  spanId: 1, parentSpanId: 1, name: 1, kind: 1, start: 1, end: 1, startNsFrac: 1, endNsFrac: 1, timingValid: 1, statusCode: 1, service: 1,
  httpMethod: 1, httpRoute: 1, httpStatus: 1, dbSystem: 1, exceptionType: 1, expireAt: 1,
} as const;

/** Exact nanosecond position of a span edge, as a BigInt (the Date holds milliseconds, the fraction the rest). */
export const startNs = (s: Pick<SpanDoc, 'start' | 'startNsFrac'>): bigint => BigInt(s.start.getTime()) * 1_000_000n + BigInt(s.startNsFrac);
export const endNs = (s: Pick<SpanDoc, 'end' | 'endNsFrac'>): bigint => BigInt(s.end.getTime()) * 1_000_000n + BigInt(s.endNsFrac);

const MAX_NAMES = 64, MAX_SMALL = 16;
const distinct = (xs: (string | null)[], max: number): string[] => {
  const out: string[] = [];
  for (const x of xs) if (x && !out.includes(x)) { out.push(x); if (out.length >= max) break; }
  return out;
};

/**
 * Computes the trace summary from ALL stored spans of the trace. Pure and order-independent: spans may have arrived in any order, in
 * any number of batches, and any of them may have been delivered more than once — the result depends only on the set of spans.
 *
 *  - start/end/duration use only spans with valid timing (an unfinished span does not stretch the trace to a made-up end);
 *  - `hasRoot` = some stored span has no parent;  `orphanCount` = stored spans naming a parent that is NOT stored;
 *  - the root is the earliest parentless span (never fabricated: with no parentless span there is no root).
 */
export function summarizeTrace(
  key: { _id: string; orgId: string; projectId: string; environmentId: string; traceId: string },
  spans: SpanSlim[], now: Date,
): TraceSummaryDoc | null {
  if (spans.length === 0) return null;
  const ids = new Set(spans.map((s) => s.spanId));
  const ordered = [...spans].sort((a, b) => (startNs(a) < startNs(b) ? -1 : startNs(a) > startNs(b) ? 1 : 0));
  const timed = ordered.filter((s) => s.timingValid);
  const basis = timed.length ? timed : ordered; // no span has a valid end: fall back to starts so the trace still has a position
  let minStart = startNs(basis[0]!), maxEnd = minStart;
  for (const s of basis) { const e = s.timingValid ? endNs(s) : startNs(s); if (startNs(s) < minStart) minStart = startNs(s); if (e > maxEnd) maxEnd = e; }

  const roots = ordered.filter((s) => s.parentSpanId === null);
  const root = roots[0] ?? null;
  const orphanCount = ordered.filter((s) => s.parentSpanId !== null && !ids.has(s.parentSpanId)).length;
  // HTTP facts come from the root when it has them, otherwise from the earliest SERVER span that does.
  const httpSource = [root, ...ordered.filter((s) => s.kind === 'server')].find((s) => s && (s.httpMethod || s.httpRoute || s.httpStatus !== null)) ?? null;
  const startMs = Number(minStart / 1_000_000n);
  const maxExpire = spans.reduce((m, s) => (s.expireAt > m ? s.expireAt : m), spans[0]!.expireAt);

  return {
    ...key,
    start: new Date(startMs), end: new Date(Number(maxEnd / 1_000_000n)),
    durationNs: Number(maxEnd - minStart), spanCount: spans.length, errorCount: spans.filter((s) => s.statusCode === 'error').length,
    services: distinct(ordered.map((s) => s.service), 50), names: distinct(ordered.map((s) => s.name), MAX_NAMES),
    dbSystems: distinct(ordered.map((s) => s.dbSystem), MAX_SMALL), exceptionTypes: distinct(ordered.map((s) => s.exceptionType), MAX_SMALL),
    rootSpanId: root?.spanId ?? null, rootName: root?.name ?? null, rootService: root?.service ?? null,
    httpMethod: httpSource?.httpMethod ?? null, httpRoute: httpSource?.httpRoute ?? null, httpStatus: httpSource?.httpStatus ?? null,
    hasRoot: root !== null, orphanCount, invalidTimingCount: ordered.length - timed.length,
    updatedAt: now, expireAt: maxExpire,
  };
}

/** Plain-language reasons a trace may be incomplete. Empty means: no evidence of incompleteness in what was received. */
export function completenessWarnings(s: Pick<TraceSummaryDoc, 'hasRoot' | 'orphanCount' | 'invalidTimingCount' | 'spanCount'>, truncated: boolean, totalSpans: number): string[] {
  const w: string[] = [];
  if (!s.hasRoot) w.push('No root span has been received. The first span of the request is missing or has not arrived yet, so the true start of the request is unknown.');
  if (s.orphanCount > 0) w.push(`${s.orphanCount} span${s.orphanCount === 1 ? '' : 's'} refer${s.orphanCount === 1 ? 's' : ''} to a parent span that has not been received (late delivery, a dropped span, or an uninstrumented service in between).`);
  if (s.invalidTimingCount > 0) w.push(`${s.invalidTimingCount} span${s.invalidTimingCount === 1 ? ' has' : 's have'} missing or inconsistent timestamps (end before start, or no end). Their durations are not shown and they do not extend the trace.`);
  if (truncated) w.push(`This trace has ${totalSpans} spans; only the first part is shown.`);
  return w;
}
