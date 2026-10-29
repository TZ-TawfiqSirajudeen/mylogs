# ADR-0005: Distributed traces and service metrics (Phase 4)

Status: accepted. Supersedes nothing; extends ADR-0003 (telemetry pipeline).

## Context
Phase 3 stores logs in MongoDB behind a `LogStore` interface. Phase 4 adds **spans** (OTLP `/v1/traces`) and **metrics** (OTLP `/v1/metrics`),
a trace explorer with a request waterfall, trace↔log correlation and a service dashboard.

Constraints discovered in the repository and on the development machine: Node 22, pnpm 10, **no Docker, no ClickHouse (no native Windows build), no
Prometheus/VictoriaMetrics/Tempo/Jaeger installed**; every test runs against a real `mongod` replica set; the ingest service, token model, redaction,
RBAC and deep-link conventions already exist and must be reused.

## Options considered
| Option | For | Against |
|---|---|---|
| **ClickHouse** (spans + metrics) | columnar, built for exactly this volume; the documented upgrade path in ADR-0003 | cannot be run or tested here; a second stateful service to deploy; would ship unverified |
| **Prometheus-compatible TSDB** (metrics) | PromQL, mature | needs a remote-write path and a second service; PromQL is not required by anything we render; cannot be verified here without downloading and operating a server |
| **Tempo / Jaeger** (traces) | purpose built | external services and UIs; authorization (project/environment RBAC) would have to be re-implemented in front of them |
| **MongoDB behind `TraceStore` / `MetricStore` interfaces** | already operated, already inside our tenant/RBAC model, fully testable here, replaceable | not columnar: aggregations are linear in the data scanned; needs deliberate rollups and bounded queries |

## Decision
Implement both signals on MongoDB, behind two new interfaces (`TraceStore` in `@nexus/tracestore`, `MetricStore` in `@nexus/metricstore`), and **measure
rather than assume**: `docs/performance-traces-metrics.md` records datasets, hardware, percentiles and the limits we found. This is a deliberate choice driven by
what can be verified, not a claim that MongoDB is the right store at high volume. ClickHouse remains the upgrade path; nothing above the interfaces
(API, UI) knows which store is used.

### Traces
* **One document per span** (`spans`), `_id = sha1(project|environment|traceId|spanId)`: a replayed or retransmitted span — in the same or a later request —
  is a duplicate by construction (idempotent). No full-trace documents are duplicated.
* **`trace_summaries`** (one small doc per trace) is **recomputed from the stored spans** of every trace touched by a batch (bounded per batch). Recompute, not
  increment: late, out-of-order and duplicate spans can therefore never skew counts, durations or the root. Search runs on summaries; the waterfall reads spans by
  `(scope, traceId)`.
* Timestamps keep **nanosecond precision**: `start`/`end` as `Date` (ms, for indexing) plus the sub-millisecond remainder and `durationNs`. Nothing is rounded for display.
* Completeness is **observed, never assumed**: a trace is flagged *partial* when no parentless span is stored or a stored span names a parent that is not stored.
  Missing services are never invented.
* Redaction (same rules as logs, plus URL query parameters and DB statements) runs before persistence. Retention: per-token, via TTL on `expireAt`.

### Metrics
* OTLP **gauge**, **sum** (delta or cumulative, monotonic or not) and **histogram** (explicit buckets, delta or cumulative) are supported.
  **Exponential histograms and summaries are rejected and counted** (reported as OTLP partial success), not silently approximated.
* Storage is **pre-aggregated per series per minute** (`metric_points`) plus a small series catalogue (`metric_series`) that carries identity, unit, temporality
  and the **cumulative state** needed to turn cumulative counters into deltas (reset-aware). Histograms keep **bucket counts**, so percentiles are computed
  from merged buckets (never a percentile of percentiles); gauges keep last/min/max/sum/count.
* **Cardinality control**: attributes are bounded (count, key and value length) and every metric may create at most N series per environment; further series are
  dropped and counted. Raw URLs / user ids are not labels by default — the service dashboard groups by `http.route`.
* Exemplars (trace/span ids on histogram points) are stored when present (bounded) and link a metric window to concrete traces. Without exemplars the UI links to
  a time-window trace search and says the link is approximate.
* Service rates/latency prefer explicit HTTP server metrics; **trace-derived** statistics are labelled as such and are used only where no explicit metric exists
  (no double counting).

### Service inventory
`services` (one row per service per environment) is maintained on ingest from valid `service.name` resources: last seen per signal, version. Health is never
inferred from absence of errors: stale or missing telemetry is shown as such.

## Consequences
* The performance of trace search, waterfall load and metric queries is **measured and documented**, with known limits (linear scans for un-indexed filters).
* Tokens gain a `scopes` list; **new tokens** carry `logs`, `traces` and `metrics`. Existing logs-only tokens are **not** silently widened: they continue to
  work for logs only (rotate/recreate to send other signals).
* OTLP/gRPC is **not** implemented and not claimed. Only OTLP/HTTP (protobuf and JSON, gzip) is.
* Real exemplar linkage depends on the SDK emitting exemplars; this is verified only for the SDK version in the sample.

## What measurement changed (kept here because it shaped the final design)
* A first version of the metric store used one "newest timestamp" watermark per series for idempotency. Tests showed it silently dropped **out-of-order** delta points (a Collector with
  several consumers reorders batches). It now remembers the last 128 timestamps for delta/gauge series; only cumulative series use "must be newer".
* Series identity includes the **service instance**; otherwise two instances exporting the same cumulative counter would corrupt each other's increases. That multiplies series by the
  number of instances, so the initial limit (500 per metric) was far too small for a real fleet: defaults are 2,000 per metric / 20,000 per environment, configurable.
* The first benchmark showed metric queries shipping every stored minute to Node. Aggregation now runs **inside MongoDB** (one row per window per label group comes back), and trace-summary sort
  indexes include `_id` so searches read in index order. See `docs/performance-traces-metrics.md` for before/after numbers and what is still slow.

## Plan (vertical slices, each tested before the next)
1. contracts, models, migration v6 · 2. span decode/normalize/redact + `/v1/traces` · 3. `TraceStore` search/detail · 4. waterfall UI · 5. log↔trace links ·
6. metric decode/store/query + `/v1/metrics` · 7. service dashboard · 8. two-service instrumented sample + e2e · 9. security/regression/perf/recovery · 10. docs.
