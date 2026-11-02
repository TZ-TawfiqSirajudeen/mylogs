# OpenTelemetry Collector → Nexus ingestion

`infra/otel-collector/config.yaml` forwards OTLP **logs, traces and metrics** (and optionally tailed JSON log files) to the Nexus ingestion service over OTLP/HTTP with a
per-environment bearer token. It targets the **contrib** distribution (needs the `filelog` receiver and `attributes` processor).

## What has been verified, and how

| Claim | Evidence | Date / version |
|---|---|---|
| The config is valid for a real Collector | `otelcol-contrib validate --config infra/otel-collector/config.yaml` exit 0 (also with the environment overrides used by the test) | otelcol-contrib **v0.164.0**, Windows amd64 |
| The Collector, running that **unmodified** file, delivers authenticated OTLP/HTTP logs to the ingestion service, which stores them under the right tenant, masks secrets, and the Logs Explorer shows them | `tests/e2e/specs/12-collector-path.spec.ts` (real binary, real ingestion service, real browser) | same |
| **Traces** (parent/child preserved, `Authorization` attribute masked at the edge and again by the platform) and **metrics** (histogram + counter) sent to the Collector's OTLP/HTTP receiver reach storage and the Traces, Services and Metrics views | same spec, tests 3 | same |
| A token **without** the `traces` signal is refused with 403 by the ingestion service when relayed by the Collector; nothing is stored and the Collector reports the failure | same spec, test 4 | same |
| Records tailed from a JSON-lines file by the Collector's `filelog` receiver arrive the same way | same spec | same |
| A wrong token is refused (HTTP 401) and nothing is stored | same spec | same |
| **gRPC in, HTTP out (the workaround for gRPC-only SDKs):** a real gRPC `TraceService/Export` call (hand-framed over HTTP/2) to the Collector's own gRPC receiver answers `grpc-status 0`, and the span reaches storage under the token's tenant | `apps/ingest/test/collector-grpc-relay.test.ts` (real binary, unmodified config, real ingestion app and mongod; needs `OTELCOL_BIN`, otherwise skipped) | otelcol-contrib **v0.164.0**, Windows amd64, 2026-10-31 |

**Not verified:** OTLP/gRPC *into Nexus* (Nexus does not accept it: gRPC clients get a 415/400 refusal, pinned by `apps/ingest/test/grpc-clients.test.ts`); gRPC **metrics and logs** through the Collector (only traces were sent through the gRPC receiver), a real gRPC *library* client (the call was framed by hand), Kubernetes/Helm deployment, the container
image `otel/opentelemetry-collector-contrib` (only the release **binary** was run — Docker was not available), TLS to the ingestion
endpoint, long-running behaviour (retry queue under multi-minute outages, memory limiter under load), other Collector versions.

## Running it yourself

1. In the UI: *Data Sources → Ingestion → create token* for the environment, with the signals you need (logs, traces, metrics). The token (`nxi_…`) is shown once.
2. Run the Collector:

```bash
NEXUS_INGEST_TOKEN=nxi_... \
NEXUS_INGEST_BASE_URL=https://ingest.example.com \
OTLP_HTTP_ENDPOINT=0.0.0.0:14318 \
  otelcol-contrib --config infra/otel-collector/config.yaml
```

   (Use a port other than 4318 for `OTLP_HTTP_ENDPOINT` when the Collector shares a host with the ingestion service.)

   Docker Compose: `NEXUS_INGEST_TOKEN=nxi_... docker compose --profile collector up otel-collector` (written, not run — see the
   status note in `docker-compose.yml`).
3. Point applications at the Collector (`OTEL_EXPORTER_OTLP_ENDPOINT=http://<collector>:14318`). The Collector exports to `$NEXUS_INGEST_BASE_URL/v1/logs|traces|metrics`.

## Reproducing the verification

```powershell
# 1. Download the official release and its checksum into a NEW empty directory (use any scratch location)
$v = "0.164.0"; $base = "https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v$v"
Invoke-WebRequest "$base/otelcol-contrib_${v}_windows_amd64.tar.gz" -OutFile otelcol.tar.gz
Invoke-WebRequest "$base/otelcol-contrib_${v}_windows_amd64.tar.gz.sha256" -OutFile otelcol.tar.gz.sha256
(Get-FileHash otelcol.tar.gz -Algorithm SHA256).Hash.ToLower()   # must equal the content of otelcol.tar.gz.sha256
# 2. Extract (another new directory) and validate
tar -xzf otelcol.tar.gz -C collector-bin
$env:NEXUS_INGEST_TOKEN = "nxi_dummy"; .\collector-bin\otelcol-contrib.exe validate --config infra\otel-collector\config.yaml
# 3. Run the end-to-end spec against it
$env:OTELCOL_BIN = "$PWD\collector-bin\otelcol-contrib.exe"; pnpm e2e -- specs/12-collector-path.spec.ts
```

On Linux/macOS use the matching `linux_amd64` / `darwin_arm64` archive. The checksum file only proves the download is intact; for supply-chain
assurance also verify the release's sigstore bundle (`*.sigstore.json`) with `cosign verify-blob-attestation`/`verify-blob` — **not done here**
(no `cosign` available).

Without `OTELCOL_BIN` the two Collector specs are **skipped** (reported as skipped, never as passed).

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Collector log: `401` / `Permanent error` / `Dropping data` | Wrong or revoked token. The ingest service answers 401; the Collector does not retry it. Mint a new token. |
| `403` / `forbidden_signal` | The token was created without that signal (e.g. a logs-only token sending traces). Create a token that includes it. |
| `429` / `503` with `Retry-After` | Ingestion quota or backpressure. The exporter's `retry_on_failure` + `sending_queue` retry with backoff (up to 10 min, 5000 batches queued; beyond that data is dropped and the Collector says so). |
| Nothing arrives, no errors | The `filelog` glob matched nothing (`NEXUS_FILELOG_INCLUDE`), or the application sends to the wrong Collector port. |
| Timestamps are "now" instead of the log's own time | The `json_parser` `layout` does not match your timestamp format; adjust it in the config. |
| Port 4318 already in use | Set `OTLP_HTTP_ENDPOINT` to another port when the Collector shares a host with the ingestion service. |
