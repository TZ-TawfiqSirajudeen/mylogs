import { normalize, severityFromPino, severityFromText, type RawLog } from './normalize.js';
import type { KV, Limits, MapResult, RedactionPolicy, Severity } from './types.js';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);

const TS_KEYS = ['timestamp', '@timestamp', 'time', 'ts', 'date', 'datetime'];
const LEVEL_KEYS = ['level', 'severity', 'lvl', 'loglevel', 'log.level'];
const MSG_KEYS = ['message', 'msg', 'log', 'text', 'event'];

/** Accepts ISO strings, epoch ms/seconds (number or numeric string). */
export function parseTimestamp(v: unknown): Date | null {
  if (v === undefined || v === null || v === '') return null;
  let d: Date;
  if (typeof v === 'number' || (typeof v === 'string' && /^\d+(\.\d+)?$/.test(v.trim()))) {
    const n = Number(v);
    d = new Date(n < 1e11 ? n * 1000 : n); // seconds vs milliseconds
  } else if (typeof v === 'string') d = new Date(v);
  else return null;
  return Number.isFinite(d.getTime()) && d.getUTCFullYear() >= 2000 && d.getUTCFullYear() < 2200 ? d : null;
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  try { return JSON.stringify(v); } catch { return ''; }
}

/** Flattens nested objects to dotted keys (bounded); arrays are kept as JSON. */
function flatten(o: Obj, prefix = '', depth = 0, out: KV[] = []): KV[] {
  for (const [k, v] of Object.entries(o)) {
    if (out.length >= 500) break;
    const key = prefix ? `${prefix}.${k}` : k;
    if (isObj(v) && depth < 4) flatten(v, key, depth + 1, out);
    else out.push({ k: key, v: stringify(v) });
  }
  return out;
}

function mapOne(o: Obj, ctx: { now: Date; limits: Limits; redaction: RedactionPolicy }): ReturnType<typeof normalize> {
  const flat = flatten(o);
  const byKey = new Map(flat.map((e) => [e.k.toLowerCase(), e.v]));
  const find = (keys: string[]) => { for (const k of keys) { const v = byKey.get(k.toLowerCase()); if (v !== undefined && v !== '') return v; } return null; };
  const levelRaw = LEVEL_KEYS.map((k) => o[k]).find((v) => v !== undefined);
  let severity: Severity | null = null;
  let severityText: string | null = null;
  if (typeof levelRaw === 'number') severity = severityFromPino(levelRaw);
  else if (typeof levelRaw === 'string') { severityText = levelRaw; severity = severityFromText(levelRaw) ?? (/^\d+$/.test(levelRaw) ? severityFromPino(Number(levelRaw)) : null); }
  const used = new Set([...TS_KEYS, ...LEVEL_KEYS, ...MSG_KEYS].map((k) => k.toLowerCase()));
  const message = find(MSG_KEYS) ?? '';
  const raw: RawLog = {
    tsEvent: TS_KEYS.map((k) => parseTimestamp(o[k])).find((d) => d) ?? null,
    tsObserved: null, severity, severityText, message,
    // pino-http / express style names -> semantic-convention names so the normalizer can find them
    attrs: [
      ...flat.filter((e) => !used.has(e.k.toLowerCase())),
      ...aliases(byKey),
    ],
    resource: [], traceId: find(['trace_id', 'traceId', 'trace.id', 'dd.trace_id']), spanId: find(['span_id', 'spanId', 'span.id']),
    scope: null, source: 'json',
  };
  return normalize(raw, ctx);
}

function aliases(m: Map<string, string>): KV[] {
  const out: KV[] = [];
  const add = (k: string, ...from: string[]) => { for (const f of from) { const v = m.get(f); if (v !== undefined && v !== '') { out.push({ k, v }); return; } } };
  add('http.request.method', 'req.method', 'request.method');
  add('http.route', 'req.route', 'route');
  add('http.response.status_code', 'res.statuscode', 'response.status', 'statuscode');
  add('duration_ms', 'responsetime', 'response_time', 'elapsed', 'duration');
  add('request.id', 'req.id', 'reqid', 'req.headers.x-request-id');
  return out;
}

/**
 * Generic structured-JSON logs: a JSON array, `{ "logs": [...] }` / `{ "records": [...] }`, a single object, or NDJSON.
 * Field names are mapped from the common conventions (pino, winston, bunyan, ECS-ish).
 */
export function jsonLogsToDrafts(body: string | unknown, o: { now: Date; limits: Limits; redaction: RedactionPolicy }): MapResult {
  const out: MapResult = { records: [], rejected: 0, errors: [] };
  const note = (m: string) => { if (out.errors.length < 5 && !out.errors.includes(m)) out.errors.push(m); };
  let items: unknown[] = [];
  if (typeof body === 'string') {
    const text = body.trim();
    if (!text) return out;
    try {
      const j = JSON.parse(text) as unknown;
      items = Array.isArray(j) ? j : isObj(j) && Array.isArray(j.logs) ? j.logs : isObj(j) && Array.isArray(j.records) ? j.records : [j];
    } catch {
      // NDJSON: one object per line; bad lines are rejected individually
      for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { items.push(JSON.parse(line)); } catch { out.rejected++; note('Some lines are not valid JSON'); }
      }
    }
  } else if (Array.isArray(body)) items = body;
  else if (isObj(body)) items = Array.isArray(body.logs) ? body.logs : Array.isArray(body.records) ? body.records : [body];

  let seen = 0;
  for (const it of items) {
    if (++seen > o.limits.maxRecordsPerRequest) { out.rejected++; note(`Too many records in one request (max ${o.limits.maxRecordsPerRequest})`); continue; }
    if (!isObj(it)) { out.rejected++; note('Log entries must be JSON objects'); continue; }
    const n = mapOne(it, o);
    if ('rejected' in n) { out.rejected++; note(`Record rejected: ${n.rejected}`); } else out.records.push(n.draft);
  }
  return out;
}
