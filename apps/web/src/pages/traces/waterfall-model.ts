import type { SpanDto } from '@nexus/contracts';

/**
 * Pure layout of a trace for the waterfall. No DOM, no I/O: every rule about hierarchy, timing, orphans, overlap, clock skew and
 * incomplete spans lives here so it can be tested exhaustively.
 *
 * Principles
 *  - Positions come ONLY from the spans' own timestamps. Siblings are never assumed to run one after another: overlapping spans
 *    overlap on the axis exactly as their timestamps say.
 *  - Hierarchy comes ONLY from parent ids. A span whose parent was not received is shown as an "orphan root", never attached to a guess.
 *  - Nothing is invented: a span with no valid end has no duration (it is drawn as a point at its start), and the trace window never
 *    stretches to a missing end.
 */

export interface WaterfallRow {
  span: SpanDto;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  /** Number of descendants (shown when collapsed). */
  descendants: number;
  /** Top-level span whose parent was not received. */
  orphan: boolean;
  /** Offset from the trace start and the exact duration, in nanoseconds (null duration = unknown). */
  offsetNs: number;
  durationNs: number | null;
  /** Position inside the trace window, 0..1 (before zoom). */
  left: number;
  width: number;
  /** Rendering/semantic flags. */
  failed: boolean;
  slow: boolean;
  /** Starts before its parent starts (clock skew between hosts, or missing context): shown as-is, flagged. */
  startsBeforeParent: boolean;
  /** Ends after its parent ends (asynchronous work or skew). Informational. */
  endsAfterParent: boolean;
  /** Part of a parent cycle (invalid data): shown as a root so that it is not lost. */
  cyclic: boolean;
}

export interface WaterfallModel {
  /** All rows in display order for the CURRENT collapsed set. */
  rows: WaterfallRow[];
  traceStartNs: bigint;
  /** Length of the trace window in nanoseconds (>= 1). */
  traceDurationNs: number;
  spanCount: number;
  services: string[];
  /** Plain-language facts a reader should know before trusting the picture. */
  issues: string[];
  /** Span ids that have children (for expand/collapse-all). */
  parents: string[];
}

const big = (s: string): bigint => { try { return BigInt(s); } catch { return 0n; } };
const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);

/** Slow = at least this share of the whole trace duration. A span that takes half the request is worth looking at. */
export const SLOW_SHARE = 0.5;

export function buildWaterfall(spans: SpanDto[], collapsed: ReadonlySet<string> = new Set()): WaterfallModel {
  const issues: string[] = [];
  if (spans.length === 0) return { rows: [], traceStartNs: 0n, traceDurationNs: 1, spanCount: 0, services: [], issues: ['This trace has no spans.'], parents: [] };

  const info = new Map<string, { span: SpanDto; start: bigint; end: bigint | null }>();
  for (const s of spans) {
    const start = big(s.startUnixNano);
    const end = s.timingValid ? big(s.endUnixNano) : null;
    info.set(s.spanId, { span: s, start, end });
  }

  // ---- trace window: earliest start .. latest VALID end (spans without a valid end never extend it)
  let t0 = [...info.values()][0]!.start;
  let t1 = t0;
  for (const i of info.values()) {
    if (i.start < t0) t0 = i.start;
    const e = i.end ?? i.start;
    if (e > t1) t1 = e;
    if (i.start > t1) t1 = i.start;
  }
  const traceDurationNs = Math.max(1, Number(t1 - t0));

  // ---- hierarchy from parent ids
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  const orphanRoots = new Set<string>();
  for (const [id, i] of info) {
    const p = i.span.parentSpanId;
    if (p === null) roots.push(id);
    else if (info.has(p) && p !== id) { const l = children.get(p) ?? []; l.push(id); children.set(p, l); }
    else { roots.push(id); orphanRoots.add(id); } // parent not received (or self-parent)
  }
  const byStart = (a: string, b: string) => cmp(info.get(a)!.start, info.get(b)!.start) || (a < b ? -1 : a > b ? 1 : 0);
  roots.sort(byStart);
  for (const l of children.values()) l.sort(byStart);

  // ---- cycles: spans reachable from no root (every ancestor present, but they loop). Surface them rather than drop them.
  const reachable = new Set<string>();
  const stack = [...roots];
  while (stack.length) { const id = stack.pop()!; if (reachable.has(id)) continue; reachable.add(id); stack.push(...(children.get(id) ?? [])); }
  const cyclicRoots = [...info.keys()].filter((id) => !reachable.has(id)).sort(byStart);
  const cyclic = new Set<string>();
  for (const id of cyclicRoots) { if (reachable.has(id)) continue; cyclic.add(id); roots.push(id); const st = [id]; while (st.length) { const x = st.pop()!; if (reachable.has(x) && x !== id) continue; reachable.add(x); for (const c of children.get(x) ?? []) if (!reachable.has(c)) st.push(c); } }

  const countDesc = new Map<string, number>();
  const count = (id: string, seen = new Set<string>()): number => {
    if (countDesc.has(id)) return countDesc.get(id)!;
    if (seen.has(id)) return 0;
    seen.add(id);
    let n = 0;
    for (const c of children.get(id) ?? []) n += 1 + count(c, seen);
    countDesc.set(id, n);
    return n;
  };

  const rows: WaterfallRow[] = [];
  const emitted = new Set<string>();
  const walk = (id: string, depth: number) => {
    if (emitted.has(id)) return;
    emitted.add(id);
    const i = info.get(id)!;
    const kids = children.get(id) ?? [];
    const isCollapsed = collapsed.has(id) && kids.length > 0;
    const parent = i.span.parentSpanId !== null ? info.get(i.span.parentSpanId) : undefined;
    const dur = i.span.timingValid && i.span.durationNs !== null ? i.span.durationNs : null;
    rows.push({
      span: i.span, depth, hasChildren: kids.length > 0, collapsed: isCollapsed, descendants: count(id), orphan: orphanRoots.has(id), cyclic: cyclic.has(id),
      offsetNs: Number(i.start - t0), durationNs: dur,
      left: Number(i.start - t0) / traceDurationNs, width: dur === null ? 0 : dur / traceDurationNs,
      failed: i.span.statusCode === 'error', slow: dur !== null && dur / traceDurationNs >= SLOW_SHARE && spans.length > 1,
      startsBeforeParent: !!parent && i.start < parent.start,
      endsAfterParent: !!parent && parent.end !== null && i.end !== null && i.end > parent.end,
    });
    if (!isCollapsed) for (const c of kids) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);

  // ---- what a reader should know
  const missingRoot = ![...info.values()].some((i) => i.span.parentSpanId === null);
  if (missingRoot) issues.push('No root span was received; the first span of the request is missing, so the timeline may start later than the real request.');
  if (orphanRoots.size) issues.push(`${orphanRoots.size} span${orphanRoots.size === 1 ? ' is' : 's are'} shown at the top level because ${orphanRoots.size === 1 ? 'its parent was' : 'their parents were'} not received.`);
  const invalid = [...info.values()].filter((i) => !i.span.timingValid).length;
  if (invalid) issues.push(`${invalid} span${invalid === 1 ? ' has' : 's have'} no valid end time and ${invalid === 1 ? 'is' : 'are'} drawn as a point; ${invalid === 1 ? 'its' : 'their'} duration is unknown.`);
  const skew = rows.filter((r) => r.startsBeforeParent).length;
  if (skew) issues.push(`${skew} span${skew === 1 ? ' starts' : 's start'} before ${skew === 1 ? 'its' : 'their'} parent. This usually means the clocks of two hosts disagree; positions are shown exactly as reported.`);
  if (cyclic.size) issues.push('Some spans refer to each other as parents (invalid data); they are shown at the top level.');

  const services = [...new Set(spans.map((s) => s.service).filter((s): s is string => !!s))];
  const parents = [...children.keys()];
  return { rows, traceStartNs: t0, traceDurationNs, spanCount: spans.length, services, issues, parents };
}

// ------------------------------------------------------------------ zoom / formatting helpers

export interface View { start: number; end: number } // fractions of the trace window, 0..1
export const FULL: View = { start: 0, end: 1 };

/** Maps a row onto the zoomed viewport. Returns null when the span lies completely outside it. */
export function project(row: Pick<WaterfallRow, 'left' | 'width'>, v: View): { left: number; width: number; clippedLeft: boolean; clippedRight: boolean } | null {
  const span = v.end - v.start;
  const a = row.left, b = row.left + row.width;
  if (b < v.start || a > v.end) return null;
  const l = Math.max(a, v.start), r = Math.min(b, v.end);
  return { left: (l - v.start) / span, width: Math.max(0, (r - l) / span), clippedLeft: a < v.start, clippedRight: b > v.end };
}

export function zoomTo(v: View, centre: number, factor: number): View {
  const span = Math.min(1, Math.max(0.001, (v.end - v.start) * factor));
  let start = centre - span / 2;
  start = Math.max(0, Math.min(1 - span, start));
  return { start, end: start + span };
}

/** 1234 -> "1.23 µs", 1_500_000 -> "1.5 ms": always the exact value, never rounded to zero. */
export function formatNs(ns: number | null): string {
  if (ns === null) return 'unknown';
  const a = Math.abs(ns);
  if (a < 1_000) return `${ns} ns`;
  if (a < 1_000_000) return `${trim(ns / 1_000)} µs`;
  if (a < 1_000_000_000) return `${trim(ns / 1_000_000)} ms`;
  if (a < 60_000_000_000) return `${trim(ns / 1_000_000_000)} s`;
  return `${Math.floor(ns / 60_000_000_000)} min ${trim((ns % 60_000_000_000) / 1_000_000_000)} s`;
}
const trim = (n: number) => {
  const t = Math.abs(n) >= 100 ? n.toFixed(0) : Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2);
  return t.includes('.') ? t.replace(/\.?0+$/, '') : t; // strip trailing zeros of a DECIMAL only ("250" must stay "250")
};

/** "Nice" tick marks for the time axis, as offsets in ns from the trace start, inside the visible window. */
export function axisTicks(traceDurationNs: number, v: View, target = 6): { ns: number; frac: number }[] {
  const winStart = v.start * traceDurationNs, winLen = (v.end - v.start) * traceDurationNs;
  const raw = winLen / target;
  const pow = 10 ** Math.floor(Math.log10(Math.max(raw, 1)));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? pow * 10;
  const out: { ns: number; frac: number }[] = [];
  for (let t = Math.ceil(winStart / step) * step; t <= winStart + winLen + 1e-6; t += step) out.push({ ns: Math.round(t), frac: (t - winStart) / winLen });
  return out;
}
