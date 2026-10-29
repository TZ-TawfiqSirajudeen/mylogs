import { FIELD_TYPES, SEVERITIES, type FieldName, type LogFilter, type LogQueryInput, type Severity } from '@nexus/contracts';

export const PRESETS = [
  { key: '5m', label: 'Last 5 minutes', ms: 5 * 60_000 },
  { key: '15m', label: 'Last 15 minutes', ms: 15 * 60_000 },
  { key: '1h', label: 'Last hour', ms: 3600_000 },
  { key: '24h', label: 'Last 24 hours', ms: 24 * 3600_000 },
  { key: '7d', label: 'Last 7 days', ms: 7 * 24 * 3600_000 },
] as const;

export interface Filters {
  /** A preset key, or "custom" (then `from`/`to` are used). */
  range: string;
  from: string;
  to: string;
  text: string;
  minSeverity: Severity | '';
  errorsOnly: boolean;
  services: string[];
  envIds: string[];
  filters: LogFilter[];
  sort: 'desc' | 'asc';
}

export const DEFAULT_FILTERS: Filters = { range: '15m', from: '', to: '', text: '', minSeverity: '', errorsOnly: false, services: [], envIds: [], filters: [], sort: 'desc' };

const OPS_BY_TYPE = {
  string: [['eq', 'is'], ['ne', 'is not'], ['contains', 'contains'], ['exists', 'exists']],
  number: [['eq', '='], ['ne', '≠'], ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'], ['exists', 'exists']],
} as const;
export const opsFor = (field: string) => OPS_BY_TYPE[field.startsWith('attr:') || FIELD_TYPES[field as FieldName] !== 'number' ? 'string' : 'number'];
export const FIELD_LABELS: Record<string, string> = {
  service: 'Service', serviceVersion: 'Service version', host: 'Host', container: 'Container', traceId: 'Trace ID', spanId: 'Span ID',
  requestId: 'Request ID', httpMethod: 'HTTP method', httpRoute: 'HTTP route', httpStatus: 'HTTP status', durationMs: 'Duration (ms)',
  errorType: 'Error type', deployment: 'Deployment', source: 'Source', scope: 'Instrumentation scope', severity: 'Severity',
};

export const describeFilter = (f: LogFilter): string => {
  const name = f.field.startsWith('attr:') ? f.field.slice(5) : FIELD_LABELS[f.field] ?? f.field;
  const op = ([...OPS_BY_TYPE.string, ...OPS_BY_TYPE.number].find(([k]) => k === f.op)?.[1]) ?? f.op;
  return f.op === 'exists' ? `${name} exists` : `${name} ${op} ${String(f.value)}`;
};

// ---------------------------------------------------------------- URL <-> filters (so every view is a shareable deep link)

export function fromParams(sp: URLSearchParams): Filters {
  const f: Filters = { ...DEFAULT_FILTERS, services: [], envIds: [], filters: [] };
  const range = sp.get('range');
  if (range && (range === 'custom' || PRESETS.some((p) => p.key === range))) f.range = range;
  f.from = sp.get('from') ?? '';
  f.to = sp.get('to') ?? '';
  f.text = (sp.get('q') ?? '').slice(0, 200);
  const sev = sp.get('sev');
  if (sev && (SEVERITIES as readonly string[]).includes(sev)) f.minSeverity = sev as Severity;
  f.errorsOnly = sp.get('err') === '1';
  f.services = (sp.get('svc') ?? '').split(',').filter(Boolean).slice(0, 20);
  f.envIds = (sp.get('env') ?? '').split(',').filter(Boolean).slice(0, 20);
  if (sp.get('sort') === 'asc') f.sort = 'asc';
  for (const raw of sp.getAll('f').slice(0, 10)) {
    const [field, op, ...rest] = raw.split('~');
    if (!field || !op) continue;
    const value = rest.join('~');
    const num = FIELD_TYPES[field as FieldName] === 'number' && value !== '' && Number.isFinite(Number(value));
    f.filters.push({ field, op: op as LogFilter['op'], ...(value !== '' ? { value: num ? Number(value) : value } : {}) });
  }
  return f;
}

export function toParams(f: Filters, selected?: string | null, projectId?: string | null): URLSearchParams {
  const sp = new URLSearchParams();
  // The project travels in the link so it can be shared; the server still authorizes whoever opens it.
  if (projectId) sp.set('p', projectId);
  if (f.range !== DEFAULT_FILTERS.range) sp.set('range', f.range);
  if (f.range === 'custom') { if (f.from) sp.set('from', f.from); if (f.to) sp.set('to', f.to); }
  if (f.text) sp.set('q', f.text);
  if (f.minSeverity) sp.set('sev', f.minSeverity);
  if (f.errorsOnly) sp.set('err', '1');
  if (f.services.length) sp.set('svc', f.services.join(','));
  if (f.envIds.length) sp.set('env', f.envIds.join(','));
  if (f.sort === 'asc') sp.set('sort', 'asc');
  for (const x of f.filters) sp.append('f', [x.field, x.op, x.value ?? ''].join('~'));
  if (selected) sp.set('id', selected);
  return sp;
}

/** Resolves the selected range into absolute times. `now` is injected so a refresh re-anchors "last 15 minutes". */
export function toQuery(f: Filters, now: number, extra: Partial<LogQueryInput> = {}): LogQueryInput {
  let from: number, to: number;
  if (f.range === 'custom' && f.from && f.to) { from = Date.parse(f.from); to = Date.parse(f.to); }
  else { const p = PRESETS.find((x) => x.key === f.range) ?? PRESETS[1]; to = now; from = now - p.ms; }
  return {
    from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    ...(f.text ? { text: f.text } : {}), ...(f.minSeverity ? { minSeverity: f.minSeverity } : {}), ...(f.errorsOnly ? { errorsOnly: true } : {}),
    ...(f.services.length ? { services: f.services } : {}), ...(f.envIds.length ? { environmentIds: f.envIds } : {}),
    filters: f.filters, sort: f.sort, limit: 100, ...extra,
  };
}

export const utc = (iso: string) => iso.replace('T', ' ').replace('Z', '');
export const localTime = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });

export const SEVERITY_TONE: Record<Severity, 'neutral' | 'info' | 'warn' | 'danger'> = { trace: 'neutral', debug: 'neutral', info: 'info', warn: 'warn', error: 'danger', fatal: 'danger' };

/** Applies a saved query (a filter set without times) on top of the current filters. */
export function applySaved(base: Filters, q: Record<string, unknown>): Filters {
  const arr = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
  return {
    ...base,
    text: typeof q.text === 'string' ? q.text : '',
    minSeverity: (SEVERITIES as readonly string[]).includes(String(q.minSeverity)) ? (q.minSeverity as Severity) : '',
    errorsOnly: q.errorsOnly === true,
    services: arr(q.services), envIds: arr(q.environmentIds),
    filters: Array.isArray(q.filters) ? (q.filters as LogFilter[]) : [],
    sort: q.sort === 'asc' ? 'asc' : 'desc',
  };
}
