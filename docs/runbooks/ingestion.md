# Runbook: the ingestion service

## What it is
`apps/ingest` — stateless Fastify service, OTLP/HTTP on port 4318. Talks only to MongoDB. Scale horizontally behind a load balancer
(rate limits are per process: effective limit = replicas × limit). Run it separately from `apps/api`.

## Health and signals
| Signal | Where | Meaning |
|---|---|---|
| `GET /healthz` | liveness | process is up (never touches the database) |
| `GET /readyz` | readiness | database reachable (503 = take out of rotation) |
| `nexus_ingest_records_accepted_total` | `/metrics` | **log** records durably stored |
| `nexus_ingest_records_rejected_{invalid,quota,overload,storage}_total` | `/metrics` | refused **log** records by reason — **alert on any sustained non-zero `storage`/`overload`** |
| `nexus_ingest_inflight_writes`, `nexus_ingest_queued_writes` | `/metrics` | saturation of the bounded write gate for logs |
| `nexus_ingest_store_errors_total` | `/metrics` | log storage write errors (including retried ones) |
| `nexus_ingest_spans_*` (traces) and `nexus_ingest_datapoints_*` (metrics): `accepted`, `duplicate`, `rejected_{invalid,quota,overload,storage}`, `store_errors`, `redactions`, `inflight_writes`; plus `nexus_ingest_metric_datapoints_unsupported_total` | `/metrics` | the same signals for traces and metrics. **Each signal has its own bounded write gate**, so apply the same alerts per signal |
| Data Sources → Ingestion | UI | per-environment *last telemetry received*, refusal counts |

Alert suggestions: no accepted records for a production environment for N minutes (silence); `rejected_storage` > 0 for 5 min; `queued_writes`
at its maximum for 1 min; `store_errors` rising.

## Symptoms and actions
* **Senders get 503 `storage_unavailable`** — MongoDB is unreachable or slow. Ingestion keeps answering; senders retry with `Retry-After`; resending is
  idempotent. Fix MongoDB; no data accepted during the outage is lost, but data a sender gave up on is. Check sender retry budgets.
* **Senders get 503 `overloaded`** — the bounded queue is full. Add replicas or raise `INGEST_MAX_INFLIGHT_WRITES` (watch MongoDB write latency).
* **Senders get 429** — a token or the project exceeded its allowance. Raise `recordsPerMinute` on the token (project ceiling:
  `INGEST_PROJECT_RECORDS_PER_MINUTE`) or reduce log volume at the source.
* **Senders get 401** — token revoked/typo. A burst of 401s from one address is throttled (429) after 30 failures/minute.
* **Senders get 403 `forbidden_signal`** — the token was created without that signal (for example a logs-only token sending traces or metrics). Create a token that includes it.
* **Metrics are refused with a cardinality explanation** — a metric reached its series limit (`METRIC_MAX_SERIES_PER_METRIC`, default 2,000; `METRIC_MAX_SERIES_PER_ENVIRONMENT`, default 20,000).
  Fix the unbounded label at the source (use `http.route`, not the raw URL); raise the limits only after checking storage and query cost. `GET /api/v1/projects/:projectId/telemetry/diagnostics` shows series counts against the limits.
* **A sender reports "partial success"** — some records were invalid (bad shape) or older than the token's retention. The refusals are counted in the UI.
* **Logs missing from the explorer** — check *Ingestion* first (was anything accepted? refused?), then the time range, environment scope and the user's
  environment grants. Records with timestamps older than retention are refused; far-future clocks are replaced by receive time (flagged in the detail view).

## Retention and deletion
`expireAt = event time + token retention` (1–90 days) for logs, spans, trace summaries and metric points. MongoDB's TTL monitor deletes in the background roughly every minute. To delete earlier,
revoke the token and delete by `{ tokenId }` (`db.logs.deleteMany`; spans carry `tokenId` too). **There is no on-demand delete for traces/metrics in the product** (retention only); trace
summaries and metric points do not carry the token id, so deleting them early means deleting by environment and time range with a privileged user. Per-minute ingest statistics expire after 7 days, saved-query history after 30.

## Capacity
Measured numbers for this implementation are in `docs/performance.md` (and `docs/performance-results.json`). Re-run `pnpm --filter @nexus/ingest bench` on
your hardware before sizing. Plan the move to a columnar store (see ADR-0003) before sustained ingest approaches the measured ceiling.

## Backups
`logs` can be large; back up `ingest_tokens` (hashes, no secrets), `saved_queries` and the control-plane collections; treat `logs` per your retention policy.
Tokens are not recoverable by design — after a restore, tokens keep working (their hashes are restored), lost plaintext tokens must be re-issued.
