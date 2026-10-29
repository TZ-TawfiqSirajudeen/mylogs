import { redactAttrs, scrubText } from './redact.js';
import { levelOf, type KV, type Limits, type LogDraft, type RedactionPolicy, type Severity } from './types.js';

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

/** OTLP SeverityNumber (1–24) -> our six levels. 0/absent = unspecified (treated as info, flagged by severityText = null). */
export function severityFromNumber(n: number | null | undefined): Severity | null {
  if (!n || n < 1 || n > 24) return null;
  if (n <= 4) return 'trace';
  if (n <= 8) return 'debug';
  if (n <= 12) return 'info';
  if (n <= 16) return 'warn';
  if (n <= 20) return 'error';
  return 'fatal';
}

const TEXT_LEVELS: Record<string, Severity> = {
  trace: 'trace', verbose: 'trace', silly: 'trace', debug: 'debug', dbg: 'debug', info: 'info', information: 'info', notice: 'info',
  log: 'info', warn: 'warn', warning: 'warn', error: 'error', err: 'error', severe: 'error', critical: 'fatal', crit: 'fatal',
  fatal: 'fatal', alert: 'fatal', emerg: 'fatal', emergency: 'fatal', panic: 'fatal',
};
export function severityFromText(t: string | null | undefined): Severity | null {
  return t ? TEXT_LEVELS[t.trim().toLowerCase()] ?? null : null;
}
/** pino-style numeric levels (10 trace … 60 fatal). */
export function severityFromPino(n: number): Severity | null {
  if (n <= 10) return 'trace';
  if (n <= 20) return 'debug';
  if (n <= 30) return 'info';
  if (n <= 40) return 'warn';
  if (n <= 50) return 'error';
  if (n <= 60) return 'fatal';
  return null;
}

export function normalizeTraceId(v: unknown): string | null {
  const s = typeof v === 'string' ? v.toLowerCase() : null;
  return s && HEX32.test(s) && s !== '0'.repeat(32) ? s : null;
}
export function normalizeSpanId(v: unknown): string | null {
  const s = typeof v === 'string' ? v.toLowerCase() : null;
  return s && HEX16.test(s) && s !== '0'.repeat(16) ? s : null;
}

export function truncateBytes(s: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(s) <= max) return { text: s, truncated: false };
  let t = s.slice(0, max);
  while (Buffer.byteLength(t) > max) t = t.slice(0, -1);
  return { text: `${t}…`, truncated: true };
}

/** Builds a clean attribute list: bounded count, key and value sizes; control characters stripped. */
export function boundAttrs(list: KV[], l: Limits): { attrs: KV[]; truncated: boolean } {
  let truncated = false;
  const out: KV[] = [];
  const seen = new Set<string>();
  for (const { k, v } of list) {
    const key = k.replace(/[\u0000-\u001f]/g, '').slice(0, l.maxAttrKey);
    if (!key || seen.has(key)) continue;
    if (out.length >= l.maxAttrs) { truncated = true; break; }
    seen.add(key);
    const val = truncateBytes(v.replace(/\u0000/g, ''), l.maxAttrValue);
    if (val.truncated) truncated = true;
    out.push({ k: key, v: val.text });
  }
  return { attrs: out, truncated };
}

export function nsToDate(v: unknown): Date | null {
  if (v === undefined || v === null || v === '' || v === '0' || v === 0) return null;
  try {
    const ns = typeof v === 'bigint' ? v : BigInt(typeof v === 'number' ? Math.trunc(v) : String(v));
    if (ns <= 0n) return null;
    const ms = Number(ns / 1_000_000n);
    const d = new Date(ms);
    return Number.isFinite(ms) && d.getUTCFullYear() >= 2000 && d.getUTCFullYear() < 2200 ? d : null;
  } catch { return null; }
}

const first = (m: Map<string, string>, ...keys: string[]) => { for (const k of keys) { const v = m.get(k); if (v !== undefined && v !== '') return v; } return null; };
const asInt = (s: string | null) => { if (s === null || !/^-?\d{1,6}$/.test(s.trim())) return null; return Number(s); };
const asMs = (s: string | null, factor = 1) => { if (s === null) return null; const n = Number(s); return Number.isFinite(n) && n >= 0 ? Math.round(n * factor * 1000) / 1000 : null; };

export interface RawLog {
  tsEvent: Date | null;
  tsObserved: Date | null;
  severity: Severity | null;
  severityText: string | null;
  message: string;
  attrs: KV[];
  resource: KV[];
  traceId: unknown;
  spanId: unknown;
  scope: string | null;
  source: 'otlp' | 'json';
}

/**
 * The single normalization path shared by every ingestion format: timestamp rules, severity, field extraction from
 * semantic-convention attributes, bounding, then redaction. Returns null when the record must be rejected.
 */
export function normalize(raw: RawLog, ctx: { now: Date; limits: Limits; redaction: RedactionPolicy }): { draft: LogDraft } | { rejected: string } {
  const { now, limits, redaction } = ctx;
  let ts = raw.tsEvent;
  let tsSource: LogDraft['tsSource'] = 'event';
  if (!ts) { ts = raw.tsObserved; tsSource = 'observed'; }
  if (!ts) { ts = now; tsSource = 'received'; }
  let tsAdjusted: LogDraft['tsAdjusted'] = null;
  if (ts.getTime() > now.getTime() + limits.maxFutureMs) { ts = now; tsAdjusted = 'future'; }
  if (now.getTime() - ts.getTime() > limits.maxAgeMs) return { rejected: 'older than the retention window' };

  const severity = raw.severity ?? 'info';
  const msg = truncateBytes(raw.message, limits.maxMessageBytes);

  const resourceB = boundAttrs(raw.resource, limits);
  const attrsB = boundAttrs(raw.attrs, limits);
  const all = new Map<string, string>();
  for (const { k, v } of [...resourceB.attrs, ...attrsB.attrs]) all.set(k, v);

  const ex = first(all, 'exception.type', 'error.type', 'error.name');
  const stack = first(all, 'exception.stacktrace', 'error.stack');
  const exMsg = first(all, 'exception.message', 'error.message');
  const reqIdRaw = first(all, 'request.id', 'http.request.id', 'request_id', 'requestId', 'x-request-id', 'http.request.header.x-request-id');
  const durationMs = asMs(first(all, 'duration_ms', 'http.duration_ms', 'http.server.duration_ms', 'response_time_ms', 'responseTime'))
    ?? asMs(first(all, "http.server.request.duration", "http.server.duration"), 1000);

  const attrsR = redactAttrs(attrsB.attrs, redaction);
  const resR = redactAttrs(resourceB.attrs, redaction);
  let redactions = attrsR.count + resR.count;
  const scrub = (s: string | null) => { if (s === null || !redaction.enabled) return s; const r = scrubText(s); redactions += r.count; return r.text; };
  const message = redaction.enabled ? (() => { const r = scrubText(msg.text); redactions += r.count; return r.text; })() : msg.text;

  const draft: LogDraft = {
    ts, tsSource, tsAdjusted,
    severity, level: levelOf(severity), severityText: raw.severityText ? raw.severityText.slice(0, 32) : null,
    message, messageTruncated: msg.truncated,
    service: first(all, 'service.name') ?? first(all, 'service', 'app', 'application'),
    serviceVersion: first(all, 'service.version', 'version'),
    deployment: first(all, 'deployment.id', 'deployment.version', 'release', 'git.sha', 'vcs.revision'),
    host: first(all, 'host.name', 'hostname', 'host'),
    container: first(all, 'container.id', 'container.name', 'k8s.pod.name'),
    traceId: normalizeTraceId(raw.traceId) ?? normalizeTraceId(first(all, 'trace_id', 'traceId', 'trace.id')),
    spanId: normalizeSpanId(raw.spanId) ?? normalizeSpanId(first(all, 'span_id', 'spanId', 'span.id')),
    requestId: reqIdRaw ? reqIdRaw.slice(0, 128) : null,
    httpMethod: (first(all, 'http.request.method', 'http.method', 'method') ?? '').toUpperCase().slice(0, 16) || null,
    httpRoute: first(all, 'http.route', 'route'),
    httpStatus: ((s) => (s !== null && s >= 100 && s <= 599 ? s : null))(asInt(first(all, 'http.response.status_code', 'http.status_code', 'status_code', 'status'))),
    durationMs,
    errorType: scrub(ex), exceptionMessage: scrub(exMsg), stack: scrub(stack),
    scope: raw.scope ? raw.scope.slice(0, 128) : null,
    source: raw.source,
    attrs: attrsR.attrs, resource: resR.attrs,
    attrsTruncated: attrsB.truncated || resourceB.truncated,
    redactions,
  };
  return { draft };
}
