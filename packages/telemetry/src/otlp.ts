import { normalize, nsToDate, severityFromNumber, severityFromText, type RawLog } from './normalize.js';
import type { KV, Limits, MapResult, RedactionPolicy } from './types.js';

type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
export const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
/** OTLP/JSON uses camelCase, protobuf-decoded objects use snake_case; accept either. */
export const pick = (o: Obj, camel: string, snake: string) => o[camel] ?? o[snake];

const MAX_DEPTH = 6;

/** AnyValue -> string. Arrays and maps become compact JSON; bytes become base64; nothing is evaluated. */
export function anyValueToString(v: unknown, depth = 0): string {
  if (!isObj(v) || depth > MAX_DEPTH) return '';
  const s = pick(v, 'stringValue', 'string_value');
  if (typeof s === 'string') return s;
  const b = pick(v, 'boolValue', 'bool_value');
  if (typeof b === 'boolean') return String(b);
  const i = pick(v, 'intValue', 'int_value');
  if (typeof i === 'string' || typeof i === 'number') return String(i);
  const d = pick(v, 'doubleValue', 'double_value');
  if (typeof d === 'number' || typeof d === 'string') return String(d);
  const a = pick(v, 'arrayValue', 'array_value');
  if (isObj(a)) return JSON.stringify(arr(a.values).slice(0, 100).map((x) => anyValueToString(x, depth + 1)));
  const kv = pick(v, 'kvlistValue', 'kvlist_value');
  if (isObj(kv)) {
    const o: Record<string, string> = {};
    for (const e of arr(kv.values).slice(0, 100)) if (isObj(e) && typeof e.key === 'string') o[e.key.slice(0, 128)] = anyValueToString(e.value, depth + 1);
    return JSON.stringify(o);
  }
  const by = pick(v, 'bytesValue', 'bytes_value');
  if (typeof by === 'string') return by;
  return '';
}

export function kvList(v: unknown): KV[] {
  const out: KV[] = [];
  for (const e of arr(v).slice(0, 1000)) {
    if (isObj(e) && typeof e.key === 'string') out.push({ k: e.key, v: anyValueToString(e.value) });
  }
  return out;
}

export function idToHex(v: unknown): string | null {
  if (typeof v === 'string') {
    if (/^[0-9a-fA-F]+$/.test(v)) return v.toLowerCase();
    // base64 (protobuf toObject with bytes: String)
    try { return Buffer.from(v, 'base64').toString('hex'); } catch { return null; }
  }
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  return null;
}

export interface OtlpOptions { now: Date; limits: Limits; redaction: RedactionPolicy }

/**
 * Maps an OTLP ExportLogsServiceRequest (JSON or protobuf-decoded) to normalized, redacted drafts.
 * Malformed records are counted as rejected (OTLP "partial success"), never silently dropped, and never crash the request.
 */
export function otlpLogsToDrafts(body: unknown, o: OtlpOptions): MapResult {
  const out: MapResult = { records: [], rejected: 0, errors: [] };
  if (!isObj(body)) { out.errors.push('Request body must be an object'); return out; }
  const resourceLogs = arr(pick(body, 'resourceLogs', 'resource_logs'));
  let seen = 0;
  const note = (m: string) => { if (out.errors.length < 5 && !out.errors.includes(m)) out.errors.push(m); };

  for (const rl of resourceLogs.slice(0, 1000)) {
    if (!isObj(rl)) { out.rejected++; note('resourceLogs entry is not an object'); continue; }
    const resource = isObj(rl.resource) ? kvList(rl.resource.attributes) : [];
    for (const sl of arr(pick(rl, 'scopeLogs', 'scope_logs')).slice(0, 1000)) {
      if (!isObj(sl)) { out.rejected++; note('scopeLogs entry is not an object'); continue; }
      const scope = isObj(sl.scope) && typeof sl.scope.name === 'string' ? sl.scope.name : null;
      const recs = arr(pick(sl, 'logRecords', 'log_records'));
      for (const r of recs) {
        seen++;
        if (seen > o.limits.maxRecordsPerRequest) { out.rejected++; note(`Too many records in one request (max ${o.limits.maxRecordsPerRequest})`); continue; }
        if (!isObj(r)) { out.rejected++; note('logRecord is not an object'); continue; }
        const sevNum = Number(pick(r, 'severityNumber', 'severity_number'));
        const sevText = pick(r, 'severityText', 'severity_text');
        const bodyV = r.body;
        let message = anyValueToString(bodyV);
        if (!message) {
          const ev = pick(r, 'eventName', 'event_name');
          message = typeof ev === 'string' ? ev : '';
        }
        const raw: RawLog = {
          tsEvent: nsToDate(pick(r, 'timeUnixNano', 'time_unix_nano')),
          tsObserved: nsToDate(pick(r, 'observedTimeUnixNano', 'observed_time_unix_nano')),
          severity: severityFromNumber(Number.isFinite(sevNum) ? sevNum : null) ?? severityFromText(typeof sevText === 'string' ? sevText : null),
          severityText: typeof sevText === 'string' && sevText ? sevText : null,
          message, attrs: kvList(r.attributes), resource,
          traceId: idToHex(pick(r, 'traceId', 'trace_id')), spanId: idToHex(pick(r, 'spanId', 'span_id')),
          scope, source: 'otlp',
        };
        const n = normalize(raw, o);
        if ('rejected' in n) { out.rejected++; note(`Record rejected: ${n.rejected}`); } else out.records.push(n.draft);
      }
    }
  }
  return out;
}
