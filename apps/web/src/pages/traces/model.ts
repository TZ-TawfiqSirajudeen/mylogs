import type { TraceQueryInput } from '@nexus/contracts';
import { PRESETS } from '../logs/model';

export { PRESETS };
export interface TraceFilters {
  range: string; from: string; to: string;
  traceId: string; services: string[]; spanName: string;
  errorsOnly: boolean; okOnly: boolean; minMs: string; maxMs: string;
  httpStatus: string; httpMethod: string; httpRoute: string; dbSystem: string; exceptionType: string;
  envIds: string[]; sort: 'recent' | 'slowest';
}
export const DEFAULT_TRACE_FILTERS: TraceFilters = {
  range: '1h', from: '', to: '', traceId: '', services: [], spanName: '', errorsOnly: false, okOnly: false, minMs: '', maxMs: '',
  httpStatus: '', httpMethod: '', httpRoute: '', dbSystem: '', exceptionType: '', envIds: [], sort: 'recent',
};

const HEX32 = /^[0-9a-f]{32}$/;

/** URL <-> filters, so every search is a shareable deep link (the project travels as `p`; the server still authorizes whoever opens it). */
export function traceFiltersFromParams(sp: URLSearchParams): TraceFilters {
  const f: TraceFilters = { ...DEFAULT_TRACE_FILTERS, services: [], envIds: [] };
  const range = sp.get('range');
  if (range && (range === 'custom' || PRESETS.some((p) => p.key === range))) f.range = range;
  f.from = sp.get('from') ?? ''; f.to = sp.get('to') ?? '';
  const id = (sp.get('trace') ?? '').toLowerCase();
  f.traceId = HEX32.test(id) ? id : '';
  f.services = (sp.get('svc') ?? '').split(',').filter(Boolean).slice(0, 20);
  f.spanName = (sp.get('name') ?? '').slice(0, 200);
  f.errorsOnly = sp.get('err') === '1';
  f.okOnly = sp.get('ok') === '1' && !f.errorsOnly;
  for (const [key, field] of [['min', 'minMs'], ['max', 'maxMs']] as const) { const v = sp.get(key); if (v && Number.isFinite(Number(v)) && Number(v) >= 0) f[field] = v; }
  const st = sp.get('status'); if (st && /^[1-5]\d\d$/.test(st)) f.httpStatus = st;
  f.httpMethod = (sp.get('method') ?? '').toUpperCase().slice(0, 16);
  f.httpRoute = (sp.get('route') ?? '').slice(0, 200);
  f.dbSystem = (sp.get('db') ?? '').slice(0, 64);
  f.exceptionType = (sp.get('exc') ?? '').slice(0, 200);
  f.envIds = (sp.get('env') ?? '').split(',').filter(Boolean).slice(0, 20);
  if (sp.get('sort') === 'slowest') f.sort = 'slowest';
  return f;
}

export function traceFiltersToParams(f: TraceFilters, projectId?: string | null): URLSearchParams {
  const sp = new URLSearchParams();
  if (projectId) sp.set('p', projectId);
  if (f.range !== DEFAULT_TRACE_FILTERS.range) sp.set('range', f.range);
  if (f.range === 'custom') { if (f.from) sp.set('from', f.from); if (f.to) sp.set('to', f.to); }
  if (f.traceId) sp.set('trace', f.traceId);
  if (f.services.length) sp.set('svc', f.services.join(','));
  if (f.spanName) sp.set('name', f.spanName);
  if (f.errorsOnly) sp.set('err', '1');
  if (f.okOnly) sp.set('ok', '1');
  if (f.minMs) sp.set('min', f.minMs);
  if (f.maxMs) sp.set('max', f.maxMs);
  if (f.httpStatus) sp.set('status', f.httpStatus);
  if (f.httpMethod) sp.set('method', f.httpMethod);
  if (f.httpRoute) sp.set('route', f.httpRoute);
  if (f.dbSystem) sp.set('db', f.dbSystem);
  if (f.exceptionType) sp.set('exc', f.exceptionType);
  if (f.envIds.length) sp.set('env', f.envIds.join(','));
  if (f.sort === 'slowest') sp.set('sort', 'slowest');
  return sp;
}

export function resolveRange(f: Pick<TraceFilters, 'range' | 'from' | 'to'>, now: number): { from: string; to: string } {
  let from: number, to: number;
  if (f.range === 'custom' && f.from && f.to) { from = Date.parse(f.from); to = Date.parse(f.to); }
  else { const p = PRESETS.find((x) => x.key === f.range) ?? PRESETS[2]; to = now; from = now - p.ms; }
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

export function toTraceQuery(f: TraceFilters, now: number, extra: Partial<TraceQueryInput> = {}): TraceQueryInput {
  const num = (s: string) => (s !== '' && Number.isFinite(Number(s)) ? Number(s) : undefined);
  return {
    ...resolveRange(f, now),
    ...(f.traceId ? { traceId: f.traceId } : {}), ...(f.services.length ? { services: f.services } : {}), ...(f.spanName ? { spanName: f.spanName } : {}),
    ...(f.errorsOnly ? { errorsOnly: true } : {}), ...(f.okOnly ? { okOnly: true } : {}),
    ...(num(f.minMs) !== undefined ? { minDurationMs: num(f.minMs)! } : {}), ...(num(f.maxMs) !== undefined ? { maxDurationMs: num(f.maxMs)! } : {}),
    ...(f.httpStatus ? { httpStatus: Number(f.httpStatus) } : {}), ...(f.httpMethod ? { httpMethod: f.httpMethod } : {}), ...(f.httpRoute ? { httpRoute: f.httpRoute } : {}),
    ...(f.dbSystem ? { dbSystem: f.dbSystem } : {}), ...(f.exceptionType ? { exceptionType: f.exceptionType } : {}),
    ...(f.envIds.length ? { environmentIds: f.envIds } : {}), sort: f.sort, limit: 50, ...extra,
  };
}

/** A deep link to one trace (optionally one span). The project and environment travel in the URL; authorization is still enforced by the server. */
export function traceLink(traceId: string, projectId: string, envId?: string | null, spanId?: string | null): string {
  const sp = new URLSearchParams({ p: projectId });
  if (envId) sp.set('env', envId);
  if (spanId) sp.set('span', spanId);
  return `/traces/${traceId}?${sp}`;
}

/** The trace explorer pre-filtered to one service and time window (used by the service dashboard and metric charts). */
export function tracesLink(projectId: string, opts: { service?: string; from: string; to: string; errorsOnly?: boolean; sort?: 'recent' | 'slowest'; envId?: string | null }): string {
  const sp = new URLSearchParams({ p: projectId, range: 'custom', from: opts.from, to: opts.to });
  if (opts.service) sp.set('svc', opts.service);
  if (opts.errorsOnly) sp.set('err', '1');
  if (opts.sort === 'slowest') sp.set('sort', 'slowest');
  if (opts.envId) sp.set('env', opts.envId);
  return `/traces?${sp}`;
}

/** The logs explorer filtered to one trace (and optionally span), around the trace's own time. */
export function logsLink(projectId: string, traceId: string, around: { from: string; to: string }, spanId?: string | null): string {
  const sp = new URLSearchParams({ p: projectId, range: 'custom', from: around.from, to: around.to });
  sp.append('f', ['traceId', 'eq', traceId].join('~'));
  if (spanId) sp.append('f', ['spanId', 'eq', spanId].join('~'));
  return `/logs?${sp}`;
}

export const SPAN_KIND_LABEL: Record<string, string> = { unspecified: 'unspecified', internal: 'internal', server: 'server', client: 'client', producer: 'producer', consumer: 'consumer' };
export const utcNs = (unixNano: string): string => {
  const ms = Number(BigInt(unixNano) / 1_000_000n);
  const frac = String(BigInt(unixNano) % 1_000_000_000n).padStart(9, '0');
  return `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')}.${frac}`;
};
