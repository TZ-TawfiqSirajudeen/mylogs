# Sending logs to Nexus Observability

**Status: implemented and tested** for logs. Traces and metrics over OTLP/HTTP are implemented too (since phase 4): see [otlp-traces-metrics.md](otlp-traces-metrics.md). OTLP/gRPC is not supported.
Verified end to end with the OpenTelemetry JS SDK's OTLP exporters (protobuf and JSON) **and** with a real OpenTelemetry **Collector** (contrib v0.164.0) running
`infra/otel-collector/config.yaml` unmodified — see [the Collector runbook](../runbooks/collector.md) for what that does and does not cover.

## 1. Create a token
Data Sources → **Ingestion** → *Create token* (project admins). Choose the environment (a token can only ever write to that one), a retention
(1–90 days) and optional extra field names to mask. The token (`nxi_…`) is shown **once**; only its SHA-256 is stored. Revoke it any time.

## 2. Point the sender at the ingestion service
| What | Value |
|---|---|
| OTLP/HTTP logs | `POST {INGEST_PUBLIC_URL}/v1/logs` — `application/x-protobuf` or `application/json`, optional `Content-Encoding: gzip`/`deflate`/`br` |
| Generic JSON logs | `POST {INGEST_PUBLIC_URL}/v1/json-logs` — a JSON array, `{ "logs": [...] }`, a single object, or NDJSON |
| Auth | `Authorization: Bearer nxi_…` (or `X-Nexus-Token: nxi_…`) |
| Limits | body ≤ 4 MiB (decompressed), ≤ 5 000 records per request, message ≤ 32 KiB, ≤ 100 attributes |

### Any OpenTelemetry SDK (standard environment variables)
```
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=https://ingest.example.com/v1/logs
OTEL_EXPORTER_OTLP_LOGS_HEADERS=Authorization=Bearer nxi_...
```
See `examples/sample-app` for a complete instrumented service (logs with `http.*`, `exception.*`, `request.id`, trace/span ids).

### OpenTelemetry Collector
`infra/otel-collector/config.yaml` (otlphttp exporter, gzip, retry honouring `Retry-After`).

### Plain JSON
```
curl -X POST https://ingest.example.com/v1/json-logs \
  -H "Authorization: Bearer $NEXUS_INGEST_TOKEN" -H "Content-Type: application/json" \
  -d '[{"level":"error","msg":"payment failed","service":"checkout","http.response.status_code":500}]'
```
Recognised fields: timestamp (`timestamp|@timestamp|time|ts`), level/severity (text or pino numbers), message (`message|msg|log`), service,
`trace_id`, `span_id`, request id, and `http.*` / `req.*` / `res.statusCode` / `responseTime`. Everything else is kept as attributes.

## Response codes (what a sender should do)
| Code | Meaning | Sender behaviour |
|---|---|---|
| 200 | stored (a body with `partialSuccess.rejectedLogRecords` means some records were refused) | done; do not retry the refused records |
| 400 | nothing valid / malformed | **do not retry**, fix the data |
| 401 | missing, wrong or revoked token (all look identical) | stop and alert; repeated failures from one address are throttled (429) |
| 413 | too large (also for compression bombs) | split the batch |
| 415 | unsupported content type / encoding | fix the exporter |
| 429 | rate limit — `Retry-After` given | retry after the delay |
| 503 | overload or storage unavailable — `Retry-After` given | retry after the delay; resending the same request is idempotent |

## What is stored
Normalized fields (time, severity, message, service, version, host/container, trace/span/request ids, http method/route/status/duration, error type,
exception message, stack) plus **all** original attributes and resource attributes. Missing fields are `null`, never invented.
The platform is told the tenant by the **token only**: `deployment.environment`, `orgId`, etc. in the payload are just attributes.

## Redaction
Applied **before** storage: attributes named like `authorization`, `cookie`, `password`, `token`, `api_key`, `secret`, … are masked, credential-shaped text
(bearer/basic, JWT, vendor tokens, AWS keys, private keys, URL credentials, `password=…`) is masked in messages, stack traces and attribute values, plus the
extra names configured on the token. It is best-effort: do not log secrets.

## Operating it
* `GET /healthz` (liveness), `GET /readyz` (database), `GET /metrics` (Prometheus: accepted/duplicate/rejected-by-reason counters, in-flight and queued writes).
* In the UI, Data Sources → Ingestion shows per-environment *last telemetry received* and the refusal counts; the Logs page warns when anything was refused.
* Configuration: `INGEST_PORT` (default 4318), `INGEST_MAX_BODY_BYTES`, `INGEST_TOKEN_RECORDS_PER_MINUTE`, `INGEST_PROJECT_RECORDS_PER_MINUTE`,
  `INGEST_MAX_INFLIGHT_WRITES`, `INGEST_MAX_QUEUED_WRITES`.
