import { arr, idToHex, isObj, kvList, pick, type OtlpOptions } from './otlp.js';
import { normalizeSpanId, normalizeTraceId } from './normalize.js';
import { redactAttrs } from './redact.js';
import { parseUnixNano } from './spans.js';
import type { KV } from './types.js';

export type MetricKind = 'gauge' | 'sum' | 'histogram';

export interface ExemplarDraft { traceId: string; spanId: string | null; value: number; ts: Date }

/** One OTLP data point, validated and normalized. Identity (name + service + labels + type + temporality + bounds) is derived later by the store. */
export interface MetricPointDraft {
  name: string; unit: string | null; description: string | null;
  type: MetricKind; temporality: 'delta' | 'cumulative' | null; monotonic: boolean | null;
  service: string | null; serviceVersion: string | null;
  /** service.instance.id / host.name / k8s.pod.name: part of series identity so two instances never share cumulative state. */
  instance: string | null;
  /** Bounded, sorted label set (see LABEL_POLICY). */
  attrs: KV[];
  time: Date; startTime: Date | null;
  /** gauge / sum */
  value: number;
  /** histogram */
  count: number; sum: number; min: number | null; max: number | null; bounds: number[] | null; buckets: number[] | null;
  exemplars: ExemplarDraft[];
}

export interface MetricMapResult {
  points: MetricPointDraft[];
  /** Data points that were refused (unsupported type, invalid values, over limits). Reported to the sender as OTLP partial success. */
  rejected: number;
  /** Subset of `rejected` that used an intentionally unsupported metric type (exponential histogram, summary) or unspecified temporality. */
  unsupported: number;
  /** Label keys removed by the cardinality policy (not data points). */
  droppedLabels: number;
  errors: string[];
}

/**
 * Cardinality policy for metric labels. Labels are part of series identity, so an unbounded label value creates unbounded series.
 *  - a few well-known unbounded keys (full URLs, user ids, client addresses) are dropped; route TEMPLATES (`http.route`) are kept;
 *  - at most MAX_LABELS labels per point, keys <= 64 and values <= 128 characters (longer values are truncated, deterministically);
 *  - credential-named labels are masked like everywhere else.
 */
export const LABEL_POLICY = {
  maxLabels: 12, maxKey: 64, maxValue: 128, maxBuckets: 160, maxExemplarsPerPoint: 3,
  dropKeys: new Set([
    'url.full', 'http.url', 'http.target', 'url.query', 'url.path', 'http.request.uri', 'user.id', 'enduser.id', 'user_id', 'userid',
    'client.address', 'client.port', 'net.peer.port', 'net.sock.peer.port', 'network.peer.port', 'http.client_ip', 'session.id', 'request.id', 'trace_id', 'span_id',
  ]),
};
const METRIC_NAME = /^[A-Za-z_][A-Za-z0-9_.\-/:]{0,199}$/;

const first = (m: Map<string, string>, ...keys: string[]) => { for (const k of keys) { const v = m.get(k); if (v !== undefined && v !== '') return v; } return null; };

function numberOf(dp: Record<string, unknown>): number | null {
  const d = pick(dp, 'asDouble', 'as_double'), i = pick(dp, 'asInt', 'as_int');
  const v = d !== undefined && d !== null ? Number(d) : i !== undefined && i !== null ? Number(i) : NaN;
  return Number.isFinite(v) ? v : null;
}

function labels(raw: unknown, o: OtlpOptions): { attrs: KV[]; dropped: number } {
  let dropped = 0;
  const kept: KV[] = [];
  const seen = new Set<string>();
  for (const { k, v } of kvList(raw)) {
    const key = k.replace(/[\u0000-\u001f]/g, '').slice(0, LABEL_POLICY.maxKey);
    if (!key || seen.has(key)) continue;
    if (LABEL_POLICY.dropKeys.has(key.toLowerCase())) { dropped++; continue; }
    seen.add(key);
    kept.push({ k: key, v: v.replace(/\u0000/g, '').slice(0, LABEL_POLICY.maxValue) });
  }
  kept.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  if (kept.length > LABEL_POLICY.maxLabels) { dropped += kept.length - LABEL_POLICY.maxLabels; kept.length = LABEL_POLICY.maxLabels; }
  return { attrs: redactAttrs(kept, o.redaction).attrs, dropped };
}

function exemplars(raw: unknown, valueOf: (e: Record<string, unknown>) => number | null): ExemplarDraft[] {
  const out: ExemplarDraft[] = [];
  for (const e of arr(raw)) {
    if (!isObj(e) || out.length >= LABEL_POLICY.maxExemplarsPerPoint) continue;
    const traceId = normalizeTraceId(idToHex(pick(e, 'traceId', 'trace_id')));
    const v = valueOf(e);
    const t = parseUnixNano(pick(e, 'timeUnixNano', 'time_unix_nano'));
    if (!traceId || v === null || !t) continue; // an exemplar that cannot point at a trace is of no use
    out.push({ traceId, spanId: normalizeSpanId(idToHex(pick(e, 'spanId', 'span_id'))), value: v, ts: new Date(t.ms) });
  }
  return out;
}

/**
 * Maps an OTLP ExportMetricsServiceRequest (JSON or protobuf-decoded) to validated data points.
 * Supported: gauge, sum (delta/cumulative, monotonic or not), histogram with explicit bounds (delta/cumulative).
 * Intentionally NOT supported (counted, reported, never approximated): exponential histogram, summary, UNSPECIFIED temporality.
 */
export function otlpMetricsToPoints(body: unknown, o: OtlpOptions): MetricMapResult {
  const out: MetricMapResult = { points: [], rejected: 0, unsupported: 0, droppedLabels: 0, errors: [] };
  if (!isObj(body)) { out.errors.push('Request body must be an object'); return out; }
  const note = (m: string) => { if (out.errors.length < 5 && !out.errors.includes(m)) out.errors.push(m); };
  const reject = (n: number, why: string, unsupported = false) => { out.rejected += n; if (unsupported) out.unsupported += n; note(why); };
  let seen = 0;
  const minTime = o.now.getTime() - o.limits.maxAgeMs, maxTime = o.now.getTime() + o.limits.maxFutureMs;

  for (const rm of arr(pick(body, 'resourceMetrics', 'resource_metrics')).slice(0, 1000)) {
    if (!isObj(rm)) { reject(1, 'resourceMetrics entry is not an object'); continue; }
    const res = new Map(redactAttrs(isObj(rm.resource) ? kvList(rm.resource.attributes) : [], o.redaction).attrs.map((a) => [a.k, a.v]));
    const service = first(res, 'service.name'), serviceVersion = first(res, 'service.version');
    const instance = first(res, 'service.instance.id', 'k8s.pod.name', 'host.name')?.slice(0, 128) ?? null;
    for (const sm of arr(pick(rm, 'scopeMetrics', 'scope_metrics')).slice(0, 1000)) {
      if (!isObj(sm)) { reject(1, 'scopeMetrics entry is not an object'); continue; }
      for (const m of arr(sm.metrics)) {
        if (!isObj(m)) { reject(1, 'metric is not an object'); continue; }
        const name = typeof m.name === 'string' ? m.name : '';
        const unit = typeof m.unit === 'string' && m.unit ? m.unit.slice(0, 64) : null;
        const description = typeof m.description === 'string' && m.description ? m.description.slice(0, 300) : null;
        const gauge = m.gauge, sum = m.sum, hist = m.histogram;
        const expo = pick(m, 'exponentialHistogram', 'exponential_histogram'), summary = m.summary;
        const count = (v: unknown) => arr(isObj(v) ? pick(v, 'dataPoints', 'data_points') : []).length;

        if (!METRIC_NAME.test(name)) { reject(Math.max(1, count(gauge) + count(sum) + count(hist)), 'Metric rejected: invalid name'); continue; }
        if (isObj(expo)) { reject(Math.max(1, count(expo)), `Metric "${name}": exponential histograms are not supported`, true); continue; }
        if (isObj(summary)) { reject(Math.max(1, count(summary)), `Metric "${name}": summary metrics are not supported`, true); continue; }

        let type: MetricKind, temporality: 'delta' | 'cumulative' | null = null, monotonic: boolean | null = null, dps: unknown[];
        if (isObj(gauge)) { type = 'gauge'; dps = arr(pick(gauge, 'dataPoints', 'data_points')); }
        else if (isObj(sum) || isObj(hist)) {
          const body2 = (isObj(sum) ? sum : hist) as Record<string, unknown>;
          type = isObj(sum) ? 'sum' : 'histogram';
          dps = arr(pick(body2, 'dataPoints', 'data_points'));
          const t = pick(body2, 'aggregationTemporality', 'aggregation_temporality');
          // OTLP/JSON may carry the enum name or its number; protobuf carries the number.
          temporality = t === 1 || t === 'AGGREGATION_TEMPORALITY_DELTA' ? 'delta' : t === 2 || t === 'AGGREGATION_TEMPORALITY_CUMULATIVE' ? 'cumulative' : null;
          if (!temporality) { reject(Math.max(1, dps.length), `Metric "${name}": aggregation temporality is unspecified`, true); continue; }
          if (type === 'sum') monotonic = pick(body2, 'isMonotonic', 'is_monotonic') === true;
        } else { reject(1, `Metric "${name}": no supported data (gauge, sum or histogram)`, true); continue; }

        for (const dp of dps) {
          seen++;
          if (seen > o.limits.maxRecordsPerRequest) { reject(1, `Too many data points in one request (max ${o.limits.maxRecordsPerRequest})`); continue; }
          if (!isObj(dp)) { reject(1, 'data point is not an object'); continue; }
          const t = parseUnixNano(pick(dp, 'timeUnixNano', 'time_unix_nano'));
          if (!t) { reject(1, `Metric "${name}": data point has no valid timestamp`); continue; }
          if (t.ms < minTime) { reject(1, `Metric "${name}": data point is older than the retention window`); continue; }
          if (t.ms > maxTime) { reject(1, `Metric "${name}": data point timestamp is too far in the future`); continue; }
          const st = parseUnixNano(pick(dp, 'startTimeUnixNano', 'start_time_unix_nano'));
          const lab = labels(dp.attributes, o);
          out.droppedLabels += lab.dropped;
          const base = { name, unit, description, type, temporality, monotonic, service, serviceVersion, instance, attrs: lab.attrs, time: new Date(t.ms), startTime: st ? new Date(st.ms) : null };

          if (type === 'histogram') {
            const c = Number(pick(dp, 'count', 'count'));
            const bounds = arr(pick(dp, 'explicitBounds', 'explicit_bounds')).map(Number);
            const buckets = arr(pick(dp, 'bucketCounts', 'bucket_counts')).map(Number);
            if (!Number.isFinite(c) || c < 0) { reject(1, `Metric "${name}": invalid histogram count`); continue; }
            if (bounds.length > LABEL_POLICY.maxBuckets) { reject(1, `Metric "${name}": too many histogram buckets (max ${LABEL_POLICY.maxBuckets})`); continue; }
            if (bounds.some((b, i) => !Number.isFinite(b) || (i > 0 && b <= bounds[i - 1]!))) { reject(1, `Metric "${name}": explicit bounds must be finite and strictly increasing`); continue; }
            let b2 = buckets;
            if (buckets.length === 0 && bounds.length === 0) b2 = [c]; // count/sum only histogram: one catch-all bucket
            if (b2.length !== bounds.length + 1 || b2.some((x) => !Number.isFinite(x) || x < 0)) { reject(1, `Metric "${name}": bucketCounts must have one more entry than explicitBounds`); continue; }
            if (b2.reduce((a, b) => a + b, 0) !== c) { reject(1, `Metric "${name}": histogram count does not equal the sum of its buckets`); continue; }
            const s = pick(dp, 'sum', 'sum');
            const sumV = s === undefined || s === null ? 0 : Number(s);
            const mn = pick(dp, 'min', 'min'), mx = pick(dp, 'max', 'max');
            out.points.push({
              ...base, value: 0, count: c, sum: Number.isFinite(sumV) ? sumV : 0,
              min: mn === undefined || mn === null || !Number.isFinite(Number(mn)) ? null : Number(mn), max: mx === undefined || mx === null || !Number.isFinite(Number(mx)) ? null : Number(mx),
              bounds, buckets: b2, exemplars: exemplars(dp.exemplars, numberOf),
            });
          } else {
            const v = numberOf(dp);
            if (v === null) { reject(1, `Metric "${name}": data point has no finite value`); continue; }
            out.points.push({ ...base, value: v, count: 1, sum: v, min: null, max: null, bounds: null, buckets: null, exemplars: exemplars(dp.exemplars, numberOf) });
          }
        }
      }
    }
  }
  return out;
}
