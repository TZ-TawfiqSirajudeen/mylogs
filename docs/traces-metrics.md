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

### Services (`services`)
One row per service per environment, written on ingest from valid `service.name`: version, first seen, and the **event time** (not receive time) of the newest span / metric point / log.

## 2. Indexes (all created by migration v6, with the rollback in `down()`)
| Collection | Index | Serves |
|---|---|---|
| `spans` | `(scope, traceId, start)` | loading a trace (the waterfall) and summary recompute |
| `spans` | `(scope, kind, start↓, service, statusCode, durationNs)` | per-service request/error/latency statistics and the span timeline **from index entries only** (`totalDocsExamined = 0`), dependency discovery |
| `spans` | `(scope, service, start↓)` | service-scoped scans |
| `spans`, `trace_summaries`, `metric_series`, `metric_points` | `expireAt` TTL | retention |
| `trace_summaries` | `(scope, traceId)` · `(scope, start↓, _id↓)` · `(scope, durationNs↓, _id↓)` · `(scope, services, start↓)` | trace-id lookup; newest-first and slowest-first search with keyset pagination **in index order** (no blocking sort) |
| `metric_series` | `(scope, name, service)` | catalogue, label discovery, series selection |
| `metric_points` | `(scope, metric, service, minute)` · `(seriesId, minute)` | range reads by series (the query path) |
| `services` | `(scope, name)` | inventory |

`scope` = `(orgId, projectId, environmentId)`. Every query starts with the caller's scope; an `environmentIds` filter can only narrow it.

## 3. API (all under `/api/v1/projects/:projectId`, session + CSRF for POST, `telemetry:read` required)
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
| `GET /telemetry/endpoints` | where to send OTLP |

Authorization is enforced **on the server for every call**: project RBAC → the exact environments the caller may read → every query filtered to them. A trace the caller may not see and a trace that
does not exist are both `404` with the same message. Cache entries (10 s, in process) are keyed by the authorized scope (organization, project, sorted environment set) plus the request, so a result
can never be served to someone with different access.

Metric query protections: time range ≤ 31 days, ≤ 400 points per series (the window is widened automatically), ≤ 2,000 series considered, ≤ 50 result series (largest kept, `truncated: true`),
≤ 250,000 stored measurements scanned (counted on the index first; otherwise `422 query_too_expensive` with advice), 8 s server timeout, no free-form expressions.

## 4. Retention and operations
* Retention is set per ingestion token (1–90 days) and applies to spans, trace summaries and metric points through TTL indexes.
* Roles: the MongoDB role in [runbooks/mongodb-roles.md](runbooks/mongodb-roles.md) lists the new collections (a test fails if the list and the code disagree).
* Watch `GET /telemetry/diagnostics` and the ingestion service's `/metrics` (`nexus_ingest_spans_*`, `nexus_ingest_datapoints_*`, `nexus_ingest_metric_datapoints_unsupported_total`).
* Deleting a project's telemetry on demand is **not** implemented (retention only).
* Migration v6 creates collections and indexes only; it does not touch existing data.
