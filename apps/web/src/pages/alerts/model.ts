import type { AlertRuleDto } from '@nexus/contracts';

type Rule = AlertRuleDto;

/** Role -> what the UI offers. The server enforces the same rules; hiding a button is only a courtesy. */
export const can = (role: string | undefined) => ({
  manage: role === 'project_admin',
  act: role === 'project_admin' || role === 'engineer',
});

export const OPS = { gt: '>', gte: '≥', lt: '<', lte: '≤', eq: '=', ne: '≠' } as const;
export const duration = (s: number) => (s % 3600 === 0 ? `${s / 3600} h` : s % 60 === 0 ? `${s / 60} min` : `${s} s`);
export const num = (n: number | null | undefined) => (n === null || n === undefined ? '—' : Number.isInteger(n) ? String(n) : String(Math.round(n * 1e4) / 1e4));

/** One-line plain-language description of what a rule measures. */
export function describeRule(r: Pick<Rule, 'query' | 'condition' | 'windowSeconds' | 'forSeconds'>): string {
  const q = r.query;
  const what = q.kind === 'metric'
    ? `${q.agg}(${q.metric}${q.service ? ` @ ${q.service}` : ''})${q.groupBy.length ? ` by ${q.groupBy.join(', ')}` : ''}`
    : `count of logs${q.errorsOnly ? ' (errors)' : q.minSeverity ? ` (≥ ${q.minSeverity})` : ''}${q.text ? ` matching "${q.text}"` : ''}${q.services?.length ? ` in ${q.services.join(', ')}` : ''}`;
  return `${what} ${OPS[r.condition.op]} ${r.condition.threshold} over ${duration(r.windowSeconds)}${r.forSeconds ? `, for ${duration(r.forSeconds)}` : ''}`;
}

/** The server's message plus its field-level details (validation errors say which field and why). */
export function errorText(e: unknown): string {
  const base = e instanceof Error ? e.message : 'Something went wrong';
  const d = (e as { details?: unknown })?.details;
  if (!Array.isArray(d)) return base;
  const parts = d.map((x) => (x && typeof x === 'object' && 'message' in x ? `${(x as { path?: string }).path ? `${String((x as { path?: string }).path).replace(/^\//, '').replace(/\//g, '.')}: ` : ''}${String((x as { message: unknown }).message)}` : '')).filter(Boolean).slice(0, 4);
  return parts.length ? `${base} — ${parts.join('; ')}` : base;
}
