import type { DeploymentMarker } from '@nexus/contracts';

/**
 * Change markers on time-line charts (ADR-0011). Pure helpers: where a marker goes on a chart's category axis, and the text that describes it.
 * A marker says "something was recorded at this time". It never says that it caused anything.
 */
export interface ChartMarker {
  id: string; t: number; status: DeploymentMarker['status'];
  /** Complete, human-readable description: also the accessible name and the tooltip text. */
  label: string;
  /** Where activating the marker leads (a route), if anywhere. */
  href?: string;
}

export const STATUS_STYLE: Record<DeploymentMarker['status'], { glyph: string; word: string; tone: 'emerald' | 'red' | 'amber' | 'indigo'; dash: string | undefined }> = {
  succeeded: { glyph: '✓', word: 'succeeded', tone: 'emerald', dash: undefined },
  failed: { glyph: '✕', word: 'failed', tone: 'red', dash: '3 3' },
  rolled_back: { glyph: '↺', word: 'rolled back', tone: 'amber', dash: '7 3' },
  started: { glyph: '▶', word: 'started', tone: 'indigo', dash: '1 3' },
};

const utcMinute = (t: number) => (Number.isFinite(t) ? new Date(t).toISOString().slice(0, 16).replace('T', ' ') : 'unknown time');

/** "checkout 1.2.3 — succeeded — 2026-11-04 12:03 UTC (Prod)". Plain text; callers render it as a text node. */
export function markerLabel(m: { service: string; version: string; status: DeploymentMarker['status']; at: string }, envName?: string | null): string {
  return `${m.service} ${m.version} — ${STATUS_STYLE[m.status].word} — ${utcMinute(Date.parse(m.at))} UTC${envName ? ` (${envName})` : ''}`;
}

export function toChartMarkers(items: DeploymentMarker[], opts: { envName?: (id: string) => string | null; href?: (m: DeploymentMarker) => string; environmentId?: string } = {}): ChartMarker[] {
  return items
    .filter((m) => !opts.environmentId || m.environmentId === opts.environmentId)
    .map((m) => ({ id: m.id, t: Date.parse(m.at), status: m.status, label: markerLabel(m, opts.envName?.(m.environmentId) ?? null), ...(opts.href ? { href: opts.href(m) } : {}) }))
    .filter((m) => Number.isFinite(m.t));
}

/**
 * Fractional position of time `t` on a chart whose category axis holds the sorted window starts `ts` (each `stepMs` long): index i means "at the i-th
 * window start", i + 0.5 half way to the next one. Null when `t` is outside the charted range (such a marker is not drawn).
 */
export function markerIndex(t: number, ts: number[], stepMs: number): number | null {
  const n = ts.length;
  if (n === 0 || !Number.isFinite(t)) return null;
  if (t < ts[0]! || t >= ts[n - 1]! + stepMs) return null;
  let lo = 0, hi = n - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ts[mid]! <= t) lo = mid; else hi = mid - 1; }
  if (lo === n - 1) return lo;
  return lo + Math.min(1, Math.max(0, (t - ts[lo]!) / (ts[lo + 1]! - ts[lo]!)));
}
