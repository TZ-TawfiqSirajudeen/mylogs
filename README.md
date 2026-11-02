# Nexus Observability

Unified observability console (work in progress). See [docs/STATUS.md](docs/STATUS.md) for exactly what works and what does not, the
[capability matrix](docs/integrations/capability-matrix.md), performance results for [logs](docs/performance.md) and for [traces and metrics](docs/performance-traces-metrics.md), and the decision records in
[docs/architecture/](docs/architecture/).

## What works today
Projects/environments/RBAC with single sign-on, secure source connections with health monitoring (HTTP health, MongoDB, Redis), and the three telemetry signals over
**OTLP/HTTP** (protobuf or JSON; gRPC is not supported) → authenticated ingestion → redaction → storage → UI:
* **Logs**: search, filters, live tail, export, request/trace correlation.
* **Traces**: Trace Explorer, an interactive **request waterfall** (hierarchy, exact timing, orphan/late/partial-trace handling, span details, exceptions, logs of the trace), deep links.
* **Metrics and services**: gauge/sum/histogram metrics, a metric explorer with real percentiles, and a service overview (rate, errors, latency, freshness, observed dependencies).
Incidents, alerting, deployments and AI are not built yet. See [docs/traces-metrics.md](docs/traces-metrics.md) and
[docs/integrations/otlp-traces-metrics.md](docs/integrations/otlp-traces-metrics.md) (how to instrument Node.js services, verified versions, limits).

## Local development (no Docker needed)

Settings live in a **gitignored `.env` file in the repository root** (copy [.env.example](.env.example); never commit real values). The `dev` scripts of the API, the ingestion
service and the worker read it automatically (`tsx watch --env-file-if-exists=../../.env`); variables already set in your shell win over the file. **Production starts
(`node dist/server.js`) never read `.env`**: production secrets come from the platform. Minimum local `.env`:

```bash
NODE_ENV=development
MONGODB_URI=mongodb://127.0.0.1:27017/?replicaSet=testset     # the database started by `pnpm dev:mongo`
MONGODB_DB=nexus
NETWORK_ALLOW_LOOPBACK=true                                    # lets connectors reach services on this machine (development only; refused in production)
```

```bash
pnpm install
pnpm dev:mongo     # terminal 1: local MongoDB replica set on :27017 (data in packages/database/.mongo-data); start it first
pnpm --filter @nexus/api dev --seed          # terminal 2: API + DEMO users/orgs  (:4000)
pnpm dev:ingest                              # terminal 3: ingestion service      (:4318)
pnpm --filter @nexus/worker dev              # terminal 4: connection monitor     (:4100)   (optional unless you use data source connections)
pnpm dev:web                                 # terminal 5: http://localhost:5173  (open it as localhost, not 127.0.0.1)
```
(`pnpm dev:api` is the same API without `--seed`; the API, ingest and worker must all use the same `MONGODB_URI` and `MONGODB_DB`.) A hosted cluster such as MongoDB Atlas
needs room for the platform's collections and an IP allow-list entry: see [docs/runbooks/atlas.md](docs/runbooks/atlas.md).

Sign in (dev auth mode only; for single sign-on see [docs/auth-oidc.md](docs/auth-oidc.md) — `pnpm dev:idp` starts a mock provider) as `owner@acme.test`, create a project, then **Data Sources → Ingestion → Create token**. To monitor a database, use **Data Sources → Add data source → MongoDB**: you can paste a `mongodb://` or `mongodb+srv://` connection string into the "Connection string" box (read in the browser; for `+srv` only the cluster's DNS name goes to the server), and it fills hosts, user, auth database and TLS, with the password going to the write-only credential field. A connected MongoDB/Redis source is verified and health-monitored; see [docs/STATUS.md](docs/STATUS.md) ("Phase 5") for whether it collects data yet. Send logs with the sample app:

```bash
OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://127.0.0.1:4318/v1/logs \
OTEL_EXPORTER_OTLP_LOGS_HEADERS="Authorization=Bearer nxi_..." \
  pnpm --filter sample-app start                    # an OpenTelemetry-instrumented web shop (:3100)
pnpm --filter sample-app traffic                    # sends a mix of 200/404/500 requests; then open Logs
```
Traces and metrics across **two instrumented services** (gateway → inventory, W3C trace-context propagation, a datastore span, logs correlated by trace id):
```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318 OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer nxi_..."   # token with logs+traces+metrics
pnpm --filter sample-app shop:inventory      # terminal A (:3101)
pnpm --filter sample-app shop:gateway        # terminal B (:3100)
curl http://127.0.0.1:3100/orders/17 ; curl http://127.0.0.1:3100/orders/500    # a success and a failure that originates in the inventory service
# then open Traces, Services and Metrics in the UI
```
Setup guide: [docs/integrations/otlp-logs.md](docs/integrations/otlp-logs.md). Demo users: `owner|admin|engineer|viewer|auditor@acme.test`, `owner@globex.test` (second tenant).
API docs: http://localhost:4000/docs (non-production only). Metrics/health: ingest `:4318/metrics|/readyz`, worker `:4100`.

## Tests

```bash
pnpm test         # unit/integration tests, one package at a time (throwaway mongod replica sets; Redis tests use `redis-server` if installed)
pnpm e2e          # browser automation with system Chrome (starts the whole stack, incl. an OIDC variant + mock IdP; about 10 minutes)
                  # OTELCOL_BIN=<path to otelcol-contrib> pnpm e2e   also runs the real-Collector specs (otherwise they are skipped)
node infra/scripts/prod-smoke.mjs   # after `pnpm build`: runs the built bundles with NODE_ENV=production and checks the guard-rails
pnpm typecheck
pnpm bench        # log ingestion/query benchmark -> docs/performance-results.json
pnpm --filter @nexus/ingest bench:signals   # trace + metric benchmark -> docs/performance-traces-metrics.json (results and limits: docs/performance-traces-metrics.md)
pnpm --filter @nexus/connectors matrix   # regenerate docs/integrations/capability-matrix.md
```

Configuration: [.env.example](.env.example). Production refuses `AUTH_MODE=dev`, insecure cookies, non-https origins, a missing `SECRETS_KEYS`, and loopback egress.
Single sign-on (OpenID Connect, Authorization Code + PKCE) is implemented and tested against a mock provider and in a real browser; it has **not** been tried against a real identity provider
([docs/auth-oidc.md](docs/auth-oidc.md)). Docker files exist but were **not built** (no Docker available): see [docs/deployment.md](docs/deployment.md) for exactly what is and is not verified.
