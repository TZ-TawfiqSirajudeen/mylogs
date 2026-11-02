# Traces and metrics: data model, storage, API, operations

Decision record: [ADR-0005](architecture/ADR-0005-traces-and-metrics.md). Sending data: [otlp-traces-metrics.md](integrations/otlp-traces-metrics.md).
Measurements: [performance-traces-metrics.md](performance-traces-metrics.md).

## 1. Data model

### Spans (`spans`, one document per OTLP span)
| Field | Meaning |
|---|---|
| `_id` | `sha1(org, project, environment, traceId, spanId)`: a replayed span, in this or any later request, is a **duplicate** (idempotent) |
| `orgId, projectId, environmentId, tokenId` | **from the ingestion token**, never from the payload |
| `traceId` (32 hex), `spanId` (16 hex), `parentSpanId` | validated; all-zero ids are invalid; a parent id that is *present but malformed* refuses the span (it would silently orphan it) |
| `name`, `kind` | span name (scrubbed) and `internal/server/client/producer/consumer/unspecified` |
| `start`, `end`, `startNsFrac`, `endNsFrac`, `durationNs`, `timingValid` | **nanosecond precision**: a `Date` (ms, for indexing) plus the sub-millisecond remainder. `durationNs`/`end` are absent (`timingValid=false`) when the end time is missing or before the start: **no duration is invented** |
| `statusCode`, `statusMessage` | `unset/ok/error` |
| `service`, `serviceVersion`, `host`, `deployment` | from the resource (`service.name`, `service.version`, `host.name`, `deployment.environment[.name]`) |
| `scopeName/scopeVersion`, `traceState`, `flags` | instrumentation scope and W3C context metadata |
| `attrs`, `resource`, `events`, `links` | span attributes, resource attributes, events (incl. `exception` events with type/message/stack trace), links; all bounded and redacted |
| `droppedAttrs/Events/Links`, `attrsTruncated` | what the SDK dropped and what Nexus truncated: loss is visible |
| `httpMethod/httpRoute/httpStatus`, `dbSystem`, `peerService`, `exceptionType` | extracted for filtering (the full attributes stay in `attrs`) |
| `receivedAt`, `expireAt`, `redactions` | arrival time, TTL date (`start + token retention`), values masked |

Limits: 128 events and 64 links per span, 100 attributes (4 KiB per value), span names ≤ 512 bytes.

### Trace summaries (`trace_summaries`, one small document per trace)
Search runs on these. A summary is **recomputed from all stored spans of the trace** after every write that touches it (never incremented), so late, out-of-order and duplicated
spans cannot skew it. Fields: start/end/`durationNs` (earliest valid start to latest valid end), `spanCount`, `errorCount`, `services`, first 64 span `names`, `dbSystems`, `exceptionTypes`,
root (earliest parentless span) and HTTP facts, and the completeness facts `hasRoot`, `orphanCount` (stored spans naming a parent that is **not** stored), `invalidTimingCount`.
*Complete* means "a root is stored and no stored span names a missing parent"; it describes what was **received**, not a guarantee that nothing is missing.

### Metrics (`metric_series`, `metric_points`)
* **Series** (identity: org, environment, metric name, service, **service instance**, type, temporality, monotonicity, bucket layout, label set). Holds unit, description, bounds,
  the cumulative state used to convert counters to increases, the watermark and the recent-timestamp set used for idempotency, and `expireAt`.
* **Points** (`_id = seriesId:minute`): `count`, `sum`, `min`, `max`, `last/lastAt` (gauges), `buckets` (histograms), up to 5 `exemplars`. Gauges keep last/min/max/sum/count; sums keep the
  **increase** per minute; histograms keep merged bucket counts.
* **Rollups** (`metric_rollups`, since migration v30; [ADR-0007](architecture/ADR-0007-metric-rollups.md)): disposable coarser copies of the points, one document per series per **5-minute** or **1-hour**
  bucket (`_id = seriesId:tier:bucketStart`, same fields as a point plus `tier` and `lastMinute`; histogram bucket counts are summed exactly, so percentiles are computed from the merged distribution).
  They are never the source of truth and can be rebuilt from the points at any time.

### Rollup semantics and limits (what a reader of a chart can rely on)
* **Same answer, fewer documents.** A query answered from rollups returns what the minute documents would return (values within floating-point rounding; percentiles identical), for sums and rates, gauges
  (min, max, avg, count, sum, newest value by timestamp) and explicit-bucket histograms. `rollup.test.ts` proves it against the minute documents with randomized data (resets, gaps, late and
  out-of-order points, two bucket layouts under one name, windows that do not line up with bucket boundaries, writers racing the compactor).
* **Which tier.** Query windows are `step` long and aligned to multiples of it, so a tier is used only if it divides the step: 5-minute buckets for steps that are multiples of 5 minutes, 1-hour buckets for
  multiples of 1 hour. The unaligned edges of the window, the newest few minutes (a bucket is rolled up about 2 minutes after it ended) and anything the compactor has not covered yet are read from the minute documents.
  An automatic step is rounded **up** to 5 minutes (from 3 min) and to 1 hour (from 25 min): 24 h windows have 5-minute points, 7 d windows 1-hour points (168). A step you ask for is kept.
  The HTTP overview timeline has about 48 points for windows longer than 90 minutes (3 h: 5-minute points).
* **Late data** (a point for an older minute) marks its series; until the compactor has recomputed the affected buckets the query reads the minute documents for that range. Usually within one compaction interval (30 s).
  There is no way to see stale rollups: coverage per series is `min(published watermark, earliest pending marker)`.
* **If the compactor is down** nothing is wrong, only slower: coverage stops advancing and queries read minute documents (and the scan guard applies to what is read).
* **Retention.** A bucket lives as long as the latest of its minutes, so at the edge of the retention window it can hold up to one bucket-length (5 min or 1 h) of data the minute documents have already expired. It never lacks data the minute documents have.
* **Exemplars** of a window read from rollups come from the newest minute in each bucket, so they can differ from the minute-document answer (which picked an arbitrary series in the newest minute); both are real exemplars.
* **Limits that stay.** Series per query (2,000), result series (50), points per series (400), the scan guard (250,000 documents *read*; rollup buckets count) and the 8 s timeout. Percentiles stay estimates at histogram bucket resolution.
  Cost is still linear in series x buckets: 600 series for 7 d is about 100,000 hourly buckets; 20,000 series would be about 3.4 million (not measured, extrapolated).
* **Operations.** `METRIC_ROLLUP_INTERVAL_MS` (worker, default 30,000; 0 disables compaction). Backfill of series that predate rollups is automatic (worker start, then every 30 min). An operator can force
  `MetricRollupCompactor.requestRebuild({ orgId, ... })` (queries read minute documents until it is done).

### Services (`services`)
One row per service per environment, written on ingest from valid `service.name`: version, first seen, and the **event time** (not receive time) of the newest span / metric point / log.

## 2. Indexes (created by migration v6, with the rollback in `down()`; the rollup indexes by migration v30)
| Collection | Index | Serves |
|---|---|---|
| `spans` | `(scope, traceId, start)` | loading a trace (the waterfall) and summary recompute |
| `spans` | `(scope, kind, start↓, service, statusCode, durationNs)` | per-service request/error/latency statistics and the span timeline **from index entries only** (`totalDocsExamined = 0`), dependency discovery |
| `spans` | `(scope, service, start↓)` | service-scoped scans |
| `spans`, `trace_summaries`, `metric_series`, `metric_points` | `expireAt` TTL | retention |
| `trace_summaries` | `(scope, traceId)` · `(scope, start↓, _id↓)` · `(scope, durationNs↓, _id↓)` · `(scope, services, start↓)` | trace-id lookup; newest-first and slowest-first search with keyset pagination **in index order** (no blocking sort) |
| `metric_series` | `(scope, name, service)` | catalogue, label discovery, series selection |
| `metric_points` | `(scope, metric, service, minute)` · `(seriesId, minute)` | range reads by series (the query path) |
| `metric_rollups` (migration v30) | `(seriesId, tier, minute)` · `expireAt` TTL | range reads of one tier by series; retention |
| `metric_series` (migration v30) | `rollFrom` (partial: only series with unprocessed minutes) | the compactor's work list |
| `services` | `(scope, name)` | inventory |

`scope` = `(orgId, projectId, environmentId)`. Every query starts with the caller's scope; an `environmentIds` filter can only narrow it.

## 3. API (paths below are under `/api/v1/projects/:projectId` unless stated; session + CSRF for POST; `telemetry:read` required)
| Endpoint | Purpose |
|---|---|
| `POST /traces/search` | validated query builder: trace id, services, span name, errors / ok only, min/max duration, HTTP status/method/route, db system, exception type, environments, sort recent/slowest, limit ≤ 200, keyset cursor; time range ≤ 31 days |
| `GET /traces/:traceId` | summary + up to 5,000 spans in start order, `totalSpans`, `truncated`, plain-language `warnings` |
| `GET /traces/:traceId/spans/:spanId` | one span, all attributes/events/links |
| `GET /traces/:traceId/logs` | logs carrying the trace id (±1 h around a known trace), per-span counts, and whether the trace itself is `known` (arrived) |
| `GET /services?minutes=` | observed services: rate, errors, p50/p95/p99, freshness, data source, trace count, dependencies |
| `GET /services/:service` | health rows + representative slow and failed traces + the correlation caveat |
| `GET /metrics/names`, `GET /metrics/labels?metric=` | catalogue |
| `POST /metrics/query` | bounded query (metric, service, ≤ 5 exact label filters, ≤ 2 group-by keys, aggregation by type, step ≥ 60 s) |
| `GET /telemetry/diagnostics` | per-signal ingestion counters (accepted/duplicates/refused by reason), storage counts, metric cardinality vs limits, query timings and failures of this API process |
| `GET /api/v1/telemetry/endpoints` (not project-scoped) | where to send OTLP (the ingestion URLs for logs, traces and metrics) |

Authorization is enforced **on the server for every call**: project RBAC → the exact environments the caller may read → every query filtered to them. A trace the caller may not see and a trace that
does not exist are both `404` with the same message. Cache entries (10 s, in process) are keyed by the authorized scope (organization, project, sorted environment set) plus the request, so a result
can never be served to someone with different access.

Metric query protections: time range ≤ 31 days, ≤ 400 points per series (the window is widened automatically), ≤ 2,000 series considered, ≤ 50 result series (largest kept, `truncated: true`),
≤ 250,000 stored measurements scanned (counted on the index first; otherwise `422 query_too_expensive` with advice), 8 s server timeout, no free-form expressions.

## 4. Retention and operations
* Retention is set per ingestion token (1–90 days) and applies to spans, trace summaries and metric points through TTL indexes.
* Roles: the MongoDB role in [runbooks/mongodb-roles.md](runbooks/mongodb-roles.md) lists the new collections (a test, `packages/database/src/roles.test.ts`, fails if the list and the code disagree).
* Watch `GET /telemetry/diagnostics` and the ingestion service's `/metrics`: `nexus_ingest_spans_*` (traces), `nexus_ingest_datapoints_*` (metrics) and `nexus_ingest_metric_datapoints_unsupported_total`;
  the older `nexus_ingest_records_*` counters are the **logs** pipeline. Each signal has its own bounded write gate (`INGEST_MAX_INFLIGHT_WRITES` / `INGEST_MAX_QUEUED_WRITES` apply to each), so a storage problem in one signal is reported as that signal's `*_rejected_storage_total`.
* Cardinality limits are settings of the ingestion service: `METRIC_MAX_SERIES_PER_METRIC` (default 2,000) and `METRIC_MAX_SERIES_PER_ENVIRONMENT` (default 20,000).
* The span and metric storage cost is measured in [performance-traces-metrics.md](performance-traces-metrics.md) (about 180 bytes of data and about 290 bytes of index per span on this hardware); aggregate queries scan a time range and grow with the window and the number of series.
* Deleting a project's telemetry on demand is **not** implemented (retention only).
* Migration v6 creates collections and indexes only; it does not touch existing data. Migration v30 adds the rollup collection and indexes (one collection and three indexes in total: 24 collections); existing series are backfilled by the worker, not by the migration.
