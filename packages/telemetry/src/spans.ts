import { REDACTED } from '@nexus/security';
import { arr, idToHex, isObj, kvList, pick, type OtlpOptions } from './otlp.js';
import { boundAttrs, normalizeSpanId, normalizeTraceId, truncateBytes } from './normalize.js';
import { redactAttrs, scrubText } from './redact.js';
import type { KV, Limits } from './types.js';

export type SpanKind = 'unspecified' | 'internal' | 'server' | 'client' | 'producer' | 'consumer';
export type SpanStatus = 'unset' | 'ok' | 'error';

export interface SpanEventDraft { ts: Date; tsNsFrac: number; name: string; attrs: KV[]; droppedAttrs: number }
export interface SpanLinkDraft { traceId: string; spanId: string; traceState: string | null; attrs: KV[]; droppedAttrs: number }

/** One span after validation, normalization and redaction, before tenant fields are attached. Absent facts are null, never invented. */
export interface SpanDraft {
  traceId: string; spanId: string; parentSpanId: string | null;
  name: string; kind: SpanKind;
  start: Date; end: Date; startNsFrac: number; endNsFrac: number;
  durationNs: number | null; timingValid: boolean;
  statusCode: SpanStatus; statusMessage: string | null;
  service: string | null; serviceVersion: string | null; host: string | null; deployment: string | null;
  scopeName: string | null; scopeVersion: string | null; traceState: string | null; flags: number | null;
  attrs: KV[]; resource: KV[]; events: SpanEventDraft[]; links: SpanLinkDraft[];
  droppedAttrs: number; droppedEvents: number; droppedLinks: number; attrsTruncated: boolean;
  httpMethod: string | null; httpRoute: string | null; httpStatus: number | null;
  dbSystem: string | null; peerService: string | null; exceptionType: string | null;
  redactions: number;
}

export interface SpanMapResult { records: SpanDraft[]; rejected: number; errors: string[] }

export const MAX_EVENTS_PER_SPAN = 128;
export const MAX_LINKS_PER_SPAN = 64;
const MAX_EVENT_ATTRS = 32;
const MAX_NAME = 512;

const KINDS: SpanKind[] = ['unspecified', 'internal', 'server', 'client', 'producer', 'consumer'];
const KIND_BY_NAME: Record<string, SpanKind> = {
  SPAN_KIND_UNSPECIFIED: 'unspecified', SPAN_KIND_INTERNAL: 'internal', SPAN_KIND_SERVER: 'server', SPAN_KIND_CLIENT: 'client',
  SPAN_KIND_PRODUCER: 'producer', SPAN_KIND_CONSUMER: 'consumer',
};
const STATUSES: SpanStatus[] = ['unset', 'ok', 'error'];
const STATUS_BY_NAME: Record<string, SpanStatus> = { STATUS_CODE_UNSET: 'unset', STATUS_CODE_OK: 'ok', STATUS_CODE_ERROR: 'error' };

/**
 * OTLP timestamps are unsigned 64-bit NANOSECONDS (JSON: decimal string; protobuf: fixed64). Parsed as BigInt so no precision is lost
 * before the split into (milliseconds, nanoseconds-within-the-millisecond). Absent / zero / unparsable -> null (never "now").
 */
export function parseUnixNano(v: unknown): { ns: bigint; ms: number; frac: number } | null {
  if (v === undefined || v === null || v === '' || v === 0 || v === '0') return null;
  try {
    const ns = typeof v === 'bigint' ? v : typeof v === 'number' ? (Number.isFinite(v) ? BigInt(Math.trunc(v)) : null) : /^\d{1,20}$/.test(String(v)) ? BigInt(String(v)) : null;
    if (ns === null || ns <= 0n) return null;
    const ms = Number(ns / 1_000_000n);
    const y = new Date(ms).getUTCFullYear();
    if (!Number.isFinite(ms) || y < 2000 || y >= 2200) return null;
    return { ns, ms, frac: Number(ns % 1_000_000n) };
  } catch { return null; }
}

const SENSITIVE_QUERY = /(^|[_\-.])(token|access[_-]?token|id[_-]?token|refresh[_-]?token|key|api[_-]?key|apikey|secret|pass(word|wd)?|pwd|auth(orization)?|sig(nature)?|session(id)?|sid|jwt|credential|bearer|code|sas|x-amz-signature|x-amz-credential|x-amz-security-token)([_\-.]|$)/i;
const URL_KEYS = /^(url\.full|url\.query|url\.path|http\.url|http\.target|http\.request\.uri|http\.route|http\.uri|messaging\.url|db\.connection_string)$/;

/** Masks the VALUES of credential-looking query parameters (and any `user:password@` userinfo) while keeping the parameter names. */
export function redactUrlText(value: string): { text: string; count: number } {
  let count = 0;
  let text = value.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/:@?#]+:[^\s/@?#]*@/gi, (_m, scheme) => { count++; return `${scheme}${REDACTED}@`; });
  text = text.replace(/([?&;])([^=&#\s]+)=([^&#\s]*)/g, (m, sep: string, name: string, val: string) => {
    if (!val || !SENSITIVE_QUERY.test(decodeURIComponentSafe(name))) return m;
    count++;
    return `${sep}${name}=${REDACTED}`;
  });
  return { text, count };
}
const decodeURIComponentSafe = (s: string) => { try { return decodeURIComponent(s); } catch { return s; } };

/** Per-attribute redaction for spans: key-based masking, credential-shaped text, and URL query/userinfo masking. */
function redactSpanAttrs(list: KV[], o: OtlpOptions): { attrs: KV[]; count: number } {
  if (!o.redaction.enabled) return { attrs: list, count: 0 };
  let urlCount = 0;
  const pre = list.map(({ k, v }) => {
    if (URL_KEYS.test(k) || /^https?:\/\//i.test(v) || (v.includes('?') && /^\/|^[a-z][a-z0-9+.-]*:/i.test(v))) {
      const r = redactUrlText(v);
      urlCount += r.count;
      return { k, v: r.text };
    }
    return { k, v };
  });
  const r = redactAttrs(pre, o.redaction);
  return { attrs: r.attrs, count: r.count + urlCount };
}

const first = (m: Map<string, string>, ...keys: string[]) => { for (const k of keys) { const v = m.get(k); if (v !== undefined && v !== '') return v; } return null; };
const asInt = (s: string | null) => (s !== null && /^-?\d{1,6}$/.test(s.trim()) ? Number(s) : null);

function boundedList(v: unknown, max: number, limits: Limits, o: OtlpOptions): { attrs: KV[]; count: number; truncated: boolean } {
  const b = boundAttrs(kvList(v).slice(0, max), { ...limits, maxAttrs: max });
  const r = redactSpanAttrs(b.attrs, o);
  return { attrs: r.attrs, count: r.count, truncated: b.truncated };
}

const num = (v: unknown): number => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(n, 2 ** 31) : 0; };

/**
 * Maps an OTLP ExportTraceServiceRequest (JSON or protobuf-decoded) to normalized, redacted span drafts.
 * Invalid spans are counted as rejected (OTLP "partial success") with the first reasons reported; they never crash the request.
 * Nothing is invented: a span without a valid start time is rejected, a span whose end is missing or before its start is stored
 * with `timingValid = false` and no duration, and a parent id that is present but malformed rejects the span (it would silently orphan it).
 */
export function otlpTracesToDrafts(body: unknown, o: OtlpOptions): SpanMapResult {
  const out: SpanMapResult = { records: [], rejected: 0, errors: [] };
  if (!isObj(body)) { out.errors.push('Request body must be an object'); return out; }
  const note = (m: string) => { if (out.errors.length < 5 && !out.errors.includes(m)) out.errors.push(m); };
  let seen = 0;

  for (const rs of arr(pick(body, 'resourceSpans', 'resource_spans')).slice(0, 1000)) {
    if (!isObj(rs)) { out.rejected++; note('resourceSpans entry is not an object'); continue; }
    const resBounded = boundAttrs(isObj(rs.resource) ? kvList(rs.resource.attributes) : [], o.limits);
    const resR = redactSpanAttrs(resBounded.attrs, o);
    const resMap = new Map(resR.attrs.map((a) => [a.k, a.v]));
    const service = first(resMap, 'service.name'), serviceVersion = first(resMap, 'service.version');
    const host = first(resMap, 'host.name', 'hostname'), deployment = first(resMap, 'deployment.environment.name', 'deployment.environment');

    for (const ss of arr(pick(rs, 'scopeSpans', 'scope_spans')).slice(0, 1000)) {
      if (!isObj(ss)) { out.rejected++; note('scopeSpans entry is not an object'); continue; }
      const scope = isObj(ss.scope) ? ss.scope : null;
      const scopeName = scope && typeof scope.name === 'string' && scope.name ? scope.name.slice(0, 200) : null;
      const scopeVersion = scope && typeof scope.version === 'string' && scope.version ? scope.version.slice(0, 64) : null;

      for (const sp of arr(ss.spans)) {
        seen++;
        if (seen > o.limits.maxRecordsPerRequest) { out.rejected++; note(`Too many spans in one request (max ${o.limits.maxRecordsPerRequest})`); continue; }
        if (!isObj(sp)) { out.rejected++; note('span is not an object'); continue; }

        const traceId = normalizeTraceId(idToHex(pick(sp, 'traceId', 'trace_id')));
        const spanId = normalizeSpanId(idToHex(pick(sp, 'spanId', 'span_id')));
        if (!traceId) { out.rejected++; note('Span rejected: traceId must be 16 bytes (32 hex characters) and not all zero'); continue; }
        if (!spanId) { out.rejected++; note('Span rejected: spanId must be 8 bytes (16 hex characters) and not all zero'); continue; }
        const parentRaw = pick(sp, 'parentSpanId', 'parent_span_id');
        let parentSpanId: string | null = null;
        const parentHex = parentRaw === undefined || parentRaw === null || parentRaw === '' ? null : idToHex(parentRaw);
        if (parentHex !== null && parentHex !== '' && !/^0{16}$/.test(parentHex)) {
          parentSpanId = normalizeSpanId(parentHex);
          if (!parentSpanId) { out.rejected++; note('Span rejected: parentSpanId is present but not a valid 8-byte id'); continue; }
        }

        const startT = parseUnixNano(pick(sp, 'startTimeUnixNano', 'start_time_unix_nano'));
        if (!startT) { out.rejected++; note('Span rejected: missing or invalid start time'); continue; }
        if (startT.ms > o.now.getTime() + o.limits.maxFutureMs) { out.rejected++; note('Span rejected: start time is too far in the future (client clock?)'); continue; }
        const endT = parseUnixNano(pick(sp, 'endTimeUnixNano', 'end_time_unix_nano'));
        const timingValid = !!endT && endT.ns >= startT.ns;
        // end < start or absent: keep the span (it is evidence), keep end = start so it renders as a point, and report NO duration.
        const end = timingValid ? endT! : startT;
        const durationNs = timingValid ? Number(endT!.ns - startT.ns) : null;
        if (durationNs !== null && !Number.isSafeInteger(durationNs)) { out.rejected++; note('Span rejected: duration out of range'); continue; }

        const kindRaw = pick(sp, 'kind', 'kind');
        const kind = typeof kindRaw === 'string' ? KIND_BY_NAME[kindRaw] ?? 'unspecified' : KINDS[Number(kindRaw)] ?? 'unspecified';
        const st = isObj(sp.status) ? sp.status : null;
        const stCodeRaw = st ? st.code : undefined;
        const statusCode = typeof stCodeRaw === 'string' ? STATUS_BY_NAME[stCodeRaw] ?? 'unset' : STATUSES[Number(stCodeRaw)] ?? 'unset';
        let redactions = resR.count;
        const stMsg = st && typeof st.message === 'string' && st.message ? st.message.slice(0, 1024) : null;
        const statusMessage = stMsg === null || !o.redaction.enabled ? stMsg : (() => { const r = scrubText(redactUrlText(stMsg).text); redactions += r.count; return r.text; })();

        const a = boundedList(sp.attributes, o.limits.maxAttrs, o.limits, o);
        redactions += a.count;
        const attrMap = new Map(a.attrs.map((x) => [x.k, x.v]));

        const events: SpanEventDraft[] = [];
        let eventsTruncated = false;
        for (const ev of arr(sp.events)) {
          if (!isObj(ev)) continue;
          if (events.length >= MAX_EVENTS_PER_SPAN) { eventsTruncated = true; break; }
          const t = parseUnixNano(pick(ev, 'timeUnixNano', 'time_unix_nano')) ?? startT; // an event without a time sits at the span start; that is not "now"
          const ea = boundedList(ev.attributes, MAX_EVENT_ATTRS, o.limits, o);
          redactions += ea.count;
          const nm = truncateBytes(typeof ev.name === 'string' ? ev.name : '', 512).text;
          events.push({ ts: new Date(t.ms), tsNsFrac: t.frac, name: o.redaction.enabled ? scrubText(nm).text : nm, attrs: ea.attrs, droppedAttrs: num(pick(ev, 'droppedAttributesCount', 'dropped_attributes_count')) });
        }
        const links: SpanLinkDraft[] = [];
        for (const ln of arr(sp.links)) {
          if (!isObj(ln) || links.length >= MAX_LINKS_PER_SPAN) continue;
          const lt = normalizeTraceId(idToHex(pick(ln, 'traceId', 'trace_id'))), ls = normalizeSpanId(idToHex(pick(ln, 'spanId', 'span_id')));
          if (!lt || !ls) continue; // a link to nothing is dropped; it is not repaired
          const la = boundedList(ln.attributes, MAX_EVENT_ATTRS, o.limits, o);
          redactions += la.count;
          links.push({ traceId: lt, spanId: ls, traceState: typeof pick(ln, 'traceState', 'trace_state') === 'string' ? String(pick(ln, 'traceState', 'trace_state')).slice(0, 256) : null, attrs: la.attrs, droppedAttrs: num(pick(ln, 'droppedAttributesCount', 'dropped_attributes_count')) });
        }

        const exEvent = events.find((e) => e.name === 'exception');
        const exType = exEvent ? exEvent.attrs.find((x) => x.k === 'exception.type')?.v ?? null : first(attrMap, 'exception.type', 'error.type');
        const name = truncateBytes(typeof sp.name === 'string' ? sp.name : '', MAX_NAME).text;

        out.records.push({
          traceId, spanId, parentSpanId, name: o.redaction.enabled ? scrubText(redactUrlText(name).text).text : name, kind,
          start: new Date(startT.ms), end: new Date(end.ms), startNsFrac: startT.frac, endNsFrac: end.frac, durationNs, timingValid,
          statusCode, statusMessage, service, serviceVersion, host, deployment, scopeName, scopeVersion,
          traceState: typeof pick(sp, 'traceState', 'trace_state') === 'string' && String(pick(sp, 'traceState', 'trace_state')) ? String(pick(sp, 'traceState', 'trace_state')).slice(0, 512) : null,
          flags: Number.isFinite(Number(sp.flags)) && sp.flags !== undefined ? Number(sp.flags) : null,
          attrs: a.attrs, resource: resR.attrs, events, links,
          droppedAttrs: num(pick(sp, 'droppedAttributesCount', 'dropped_attributes_count')),
          droppedEvents: num(pick(sp, 'droppedEventsCount', 'dropped_events_count')) + (eventsTruncated ? 1 : 0),
          droppedLinks: num(pick(sp, 'droppedLinksCount', 'dropped_links_count')),
          attrsTruncated: a.truncated || resBounded.truncated || eventsTruncated,
          httpMethod: (first(attrMap, 'http.request.method', 'http.method') ?? '').toUpperCase().slice(0, 16) || null,
          httpRoute: first(attrMap, 'http.route'),
          httpStatus: ((s) => (s !== null && s >= 100 && s <= 599 ? s : null))(asInt(first(attrMap, 'http.response.status_code', 'http.status_code'))),
          dbSystem: first(attrMap, 'db.system.name', 'db.system'),
          peerService: first(attrMap, 'peer.service', 'server.address', 'net.peer.name', 'http.host'),
          exceptionType: exType, redactions,
        });
      }
    }
  }
  return out;
}
