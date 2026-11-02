# Sending traces and metrics to Nexus Observability

**Status.** OTLP/HTTP **traces** and **metrics** (and logs) are implemented and verified end to end with the real OpenTelemetry JS SDK and the real
OpenTelemetry Collector (contrib v0.164.0). **OTLP/gRPC is not supported**: Nexus accepts OTLP over HTTP only, protobuf or JSON, optionally compressed
(gzip, deflate, brotli). A Collector may *receive* gRPC from your applications; it exports to Nexus over HTTP.

| Endpoint | Content types | Token must include |
|---|---|---|
| `POST /v1/traces` | `application/x-protobuf`, `application/json` | `traces` |
| `POST /v1/metrics` | `application/x-protobuf`, `application/json` | `metrics` |
| `POST /v1/logs` | `application/x-protobuf`, `application/json` | `logs` |

Authentication is `Authorization: Bearer nxi_…` (or `X-Nexus-Token`). A token belongs to **one environment of one project**; whatever a payload claims
(`deployment.environment`, tenant attributes) is stored as data and never changes where telemetry lands. Tokens created before this release are **logs only**
and keep working for logs; create a new token (UI: *Data Sources → Ingestion*; choose the signals) to send traces and metrics.

## 1. Node.js with the OpenTelemetry SDK

The working reference is [`examples/sample-app`](../../examples/sample-app/src/telemetry.ts) (two services, `pnpm --filter sample-app shop:gateway` and
`shop:inventory`). Minimum configuration — the exporters read the **standard environment variables**; nothing is hard-coded:

```bash
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.example.com          # the SDK appends /v1/traces, /v1/metrics, /v1/logs
OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer <token>          # from your secret store; never commit it
OTEL_SERVICE_NAME=gateway
OTEL_RESOURCE_ATTRIBUTES=service.version=1.4.2,deployment.environment=production
# optional
OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=delta          # default is cumulative; both are supported
OTEL_SEMCONV_STABILITY_OPT_IN=http                               # http.server.request.duration (seconds) instead of the legacy http.server.duration (ms)
```

**If your SDK or agent defaults to gRPC** (the default differs between languages and versions; check your language's OpenTelemetry documentation), set `OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf`
explicitly as above, and pick an HTTP exporter package where the language has separate ones (in Node.js: `exporter-trace-otlp-proto`, not `-grpc`). A gRPC client that is pointed at this
service is **refused, not served**: an HTTP/1.1 request with `Content-Type: application/grpc` gets `415 unsupported_media_type` with the message "OTLP/gRPC is not supported…", and a real
HTTP/2 gRPC connection is closed with an HTTP `400` (the client library typically reports a generic protocol or "unavailable" error, because the server does not speak HTTP/2). If the
language really only offers gRPC, send gRPC to an OpenTelemetry Collector and export to Nexus from there with the `otlphttp` exporter ([collector runbook](../runbooks/collector.md)).

Bootstrap order matters: **register the SDK and instrumentation before the framework is imported** (instrumentation patches modules as they load).

```ts
// telemetry.ts — import this FIRST
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';

const tracerProvider = new NodeTracerProvider({ spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())] });
tracerProvider.register();                       // W3C Trace Context + baggage propagation, async context manager
const meterProvider = new MeterProvider({ readers: [new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() })] });
registerInstrumentations({ instrumentations: [new HttpInstrumentation()], tracerProvider, meterProvider });
```

### Verified package set (the versions the sample and the tests actually run)

`@opentelemetry/api 1.10`, `sdk-trace-node 2.12`, `sdk-trace-base 2.12`, `sdk-metrics 3.0`, `sdk-logs 3.0`, `resources 3.0`, `exporter-{trace,metrics,logs}-otlp-{proto,http} 0.300`,
`instrumentation 0.300`, `instrumentation-http 0.300`, on Node 22 with Fastify 5. Mixing SDK major versions is allowed here only because this exact set was run; when you
upgrade, re-run the sample (`pnpm e2e`, spec `14-traces-e2e`) rather than assuming compatibility.

## 2. Trace-context propagation across services

With `HttpInstrumentation` an incoming request becomes a **SERVER** span (continuing a remote `traceparent` header when present) and an outgoing `http.request` call
becomes a **CLIENT** span that injects `traceparent` into the request. Verified: the sample gateway calls the sample inventory service and the stored spans have the
same trace id and `inventory.server.parentSpanId == gateway.client.spanId`.

Caveats you must know:
* Node's global `fetch` uses undici, which `instrumentation-http` does **not** patch — use `@opentelemetry/instrumentation-undici` (not verified here) or the `http` module.
* Propagation needs both sides instrumented. A service without instrumentation breaks the chain: its callee's span appears as a **partial trace** (orphan), and Nexus
  says so instead of inventing the missing service or its time.
* Asynchronous hops (queues, schedulers) need explicit context propagation in message headers; span **links** are stored and shown but do not create parent/child relations.

## 3. Datastores (MongoDB, Redis)

The sample creates **manual** CLIENT spans with the database semantic-convention attributes (`db.system`, `db.operation.name`, `db.collection.name`, `server.address`).
Automatic instrumentation exists (`@opentelemetry/instrumentation-mongodb`, `@opentelemetry/instrumentation-ioredis`) and Nexus stores whatever spans they emit, but **they were
not exercised in this repository's tests**: pick versions compatible with your driver and runtime, and verify in staging.

Do **not** put credentials into spans. Nexus masks the usual suspects before storing (see below), but the safest span never contained them: keep `db.statement` free of literals
(use the parameterised form) and never record connection strings.

## 4. Metrics

Supported OTLP metric types: **Gauge**, **Sum** (delta or cumulative; monotonic or not), **Histogram with explicit bucket bounds** (delta or cumulative).
**Refused and counted** (OTLP partial success with an explanation): **ExponentialHistogram**, **Summary**, and any Sum/Histogram whose aggregation temporality is *unspecified*.

How measurements are interpreted:
* Storage is **per series per minute** (a series = metric name + service + service instance + label set + type/temporality/bucket layout). Cumulative counters are converted to
  **increases** using the previous value; a restart (new start time, or a decreasing monotonic counter) is detected and handled. The first point of an *old* cumulative series only
  establishes a baseline (its history is unknown); a series that started within 5 minutes counts from zero.
* Histograms keep **bucket counts**. p50/p90/p95/p99 are computed from the merged distribution with linear interpolation inside a bucket (an **estimate**, error bounded by bucket
  width). Percentiles are never averaged across series, instances or windows.
* Retransmitted requests are idempotent: delta/gauge series ignore a data point whose timestamp was already seen (the last 128 timestamps are remembered), cumulative series ignore
  points that are not newer. Out-of-order points are accepted.
* **Cardinality limits** (defaults; configurable): at most 2,000 series per metric and 20,000 per environment (`METRIC_MAX_SERIES_PER_METRIC`, `METRIC_MAX_SERIES_PER_ENVIRONMENT`).
  Beyond that, new series are refused and reported. Labels are bounded (12 per point; key ≤ 64, value ≤ 128 characters) and these unbounded labels are **dropped** by default:
  `url.full`, `http.url`, `http.target`, `url.query`, `url.path`, `user.id`, `client.address`, `session.id`, `request.id`… Use the **route template** (`http.route`), never the raw URL.
* Exemplars (trace/span ids attached to histogram points by the SDK) are stored (≤ 5 per series-minute) and shown as links to the trace.

## 5. Collector

`infra/otel-collector/config.yaml` has logs, traces and metrics pipelines to Nexus (verified with the real Collector, see [the runbook](../runbooks/collector.md)).
Deployment pattern: applications send OTLP to a Collector **inside your network**; only the Collector needs outbound HTTPS to Nexus. You do not have to expose any internal service.

## 6. What Nexus redacts before storing spans

Same principles as logs, applied to every span name, status message, attribute (span, resource, event, link) and exception:
* attribute **keys** that name credentials (authorization, cookie, password, token, secret, api key, connection string, …) → value masked;
* credential-shaped text (bearer tokens, JWTs, vendor key formats, `password=…`, private keys) → masked;
* **URLs** (`url.full`, `http.url`, `http.target`, …): `user:password@` userinfo and the *values* of credential-looking query parameters (`token`, `key`, `signature`, `code`, `session`, …) are
  masked; harmless parameters stay readable;
* per-token extra keys (token settings) are masked too.
Redaction is best-effort: it cannot recognise an arbitrary secret in arbitrary text. Request/response bodies are never collected by the HTTP instrumentation by default; keep it that way.

## 7. Limits and failure behaviour

* Body limit 4 MiB after decompression (decompression bombs → 413; setting `INGEST_MAX_BODY_BYTES`); at most 5,000 spans / data points per request (setting `INGEST_MAX_RECORDS_PER_REQUEST`; the rest are refused and counted).
* Per-token and per-project rate limits → `429 Retry-After`; bounded queue → `503 Retry-After` (backpressure); storage failure → `503 Retry-After`. All exporters retry these.
* Invalid items are refused individually and reported in the response (`partialSuccess.rejectedSpans` / `rejectedDataPoints`); the rest of the request is stored.
* A span with an invalid trace/span/parent id or no start time is refused; a span with no valid end time is stored **without** a duration.
* Spans retained per token (`retentionDays`, 1–90, default 30), metric points likewise; expiry is by MongoDB TTL.
