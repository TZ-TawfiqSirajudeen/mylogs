# ADR-0003: Telemetry pipeline (logs) — ingestion, storage, query

Status: accepted · Date: 2026-10-28 · Builds on ADR-0001/0002

## Decision on the telemetry store (open question from the brief)
The brief recommended ClickHouse. This machine has no Docker and no ClickHouse, and the owner chose MongoDB for metadata, so
logs are stored in **MongoDB behind a `LogStore` interface** (`packages/logstore`). It is testable here against a real `mongod`,
and a ClickHouse implementation can replace it without touching ingestion, the API or the UI.
**Honest limit:** MongoDB with regular indexes is appropriate for the volumes measured in `docs/performance.md`; it is not a
substitute for a columnar store at very high volume (see "When to move to ClickHouse").

## Architecture
```
 app / collector ──OTLP/HTTP (protobuf|JSON, gzip)──►  apps/ingest   (port 4318, stateless, own deployable)
                                                         │ token auth → validate → normalize → redact → quota → bounded write
                                                         ▼
                                                      logs (TTL)  ◄── apps/api (search, detail, tail, export)  ◄── web
```
* **Separate data plane.** The ingestion service shares only the database package with the control plane. If it is overloaded or down,
  sign-in, projects, connections and everything already collected keep working; if the API is down, senders still deliver.
* **"Accepted" means durably stored.** The sender receives its response after the write, so a 2xx can be trusted and every failure
  is visible to the sender (which retries; OpenTelemetry exporters retry 429/503). Nothing is buffered beyond a bounded gate.
* **Idempotent.** A record id is `sha1(project | environment | sha256(request body) | position)`; a retransmitted request is recognised
  (`duplicates`), a legitimately repeated line in a *different* request is kept.
* **Tenant comes from the token.** A token is bound to one environment of one project. Environment/project/org claims in the payload are
  ordinary attributes and are never used for placement.
* **No silent loss.** Every refusal is counted per minute and per reason (invalid/too old, rate limit, overload, storage). The UI shows
  the counts, a banner when anything was refused, and "No telemetry received yet" for environments that never sent data.

## Normalization and redaction (before persistence)
One code path (`packages/telemetry`) for OTLP and generic JSON: timestamp rules (event → observed → receive time, recorded in
`tsSource`; far-future clocks replaced and flagged; too-old rejected), severity mapping (OTLP numbers, text, pino levels),
semantic-convention extraction (service, host, http.*, exception.*, request id, trace/span id), size bounds (message, attribute count/key/value),
control-character stripping, then redaction. Absent facts stay `null`; the UI renders them as "unavailable".
Redaction = sensitive **keys** (authorization, cookie, password, token, …, plus per-token extra keys) and credential-shaped **text**
(URL credentials, bearer/basic, JWT, vendor tokens, AWS keys, private keys, `password=…`). It is best-effort by nature.

## Query safety
`LogQuery` (in `@nexus/contracts`) is the only way to search: allow-listed fields, operators by type, ≤10 filters, ≤31-day range, ≤500 rows,
keyset pagination (tie-safe), 8 s server timeout. Values are strings/numbers under allow-listed fields and regexes are escaped literals, so
operator injection and regex DoS are not possible. Tenant scope is applied first and unconditionally; environment scope is the intersection of
the caller's grants and the request. Export needs engineer access, is capped (10 000 rows), CSV-formula-safe, and audited.

## Retention
Each record carries `expireAt = ts + token.retentionDays` (1–90, default 30) removed by MongoDB's TTL monitor (which runs about once a minute, so
deletion is not instantaneous). Records that would expire immediately are refused, visibly, instead of stored and deleted.

## Live tail
Server-sent events over an authenticated POST (EventSource cannot send the CSRF header). It follows **arrival order** (`receivedAt`), so a late
event with an old timestamp is still delivered. ≤3 streams per user, ≤10 minutes each (the client reconnects), disconnects are detected on the
response socket (not the request) so slots are released.

## Not done / follow-ups
* OTLP **traces and metrics** — written here as phase 4; **implemented since** (`/v1/traces`, `/v1/metrics`; see ADR-0005). **gRPC transport is still not supported.** The endpoint rejects nothing it cannot parse silently.
* Per-process rate limits (several ingest replicas multiply the effective limit).
* No durable queue in front of storage: during a storage outage senders must retry (they are told to, with Retry-After).
* Full-text search is a case-insensitive substring match on a pre-lowercased `searchText` field held in a covering index (first 2,048 characters of the message). It is
  not an inverted index: a miss scans the index range for the selected time window (linear; see `docs/performance.md`).
* The OpenTelemetry **Collector** configuration (`infra/otel-collector/`) is validated with the real `otelcol-contrib` v0.164.0 binary and an authenticated
  Collector → ingestion → UI path is covered by an end-to-end test (`docs/runbooks/collector.md`); a gRPC trace call through the Collector's gRPC receiver was later exercised (`apps/ingest/test/collector-grpc-relay.test.ts`; metrics/logs over gRPC were not), the container image was not.

## When to move to ClickHouse
Sustained ingest above ~5–10k records/s per node, retention beyond a few weeks at that rate, or interactive queries over hundreds of millions of rows.
The `LogStore` interface (insert, search, get, related, neighbors, histogram, facets, tail, exportRows) is the seam.
