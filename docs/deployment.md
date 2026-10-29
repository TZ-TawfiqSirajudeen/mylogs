# Deployment

> **Verification status, up front.** Docker was **not available** where this repository was developed, so the `Dockerfile`, `docker-compose.yml`
> and `infra/nginx/nginx.conf` have **never been built or started with Docker/nginx**. What *was* verified, and how, is in the table at the end.
> Nothing here has been deployed to Kubernetes, a cloud, or against a real identity provider.

## Components

| Service | Image target | Port | Purpose | Depends on |
|---|---|---|---|---|
| `api` | `--target api` | 4000 | REST API, sessions, OIDC callback | MongoDB, (IdP) |
| `ingest` | `--target ingest` | 4318 | OTLP/HTTP + JSON log ingestion (token auth) | MongoDB |
| `worker` | `--target worker` | 4100 (health) | connection health monitoring | MongoDB |
| `web` | `--target web` | 8080 | static UI + same-origin `/api` proxy (nginx, unprivileged) | `api` |
| MongoDB 7 | external | 27017 | metadata **and** log storage (behind the `LogStore` interface) | replica set required (transactions) |
| `mock-idp` | `--target mock-idp` | 9000 | **development only** test identity provider | — |

`ingest` is separate from `api` on purpose: telemetry senders authenticate with per-environment tokens and must keep working regardless of how
people sign in, and the two scale and are exposed differently (the ingest endpoint is public to your applications; the API is behind your SSO).

## Local development stack

```bash
docker compose up --build                       # web http://localhost:8080 (demo users, AUTH_MODE=dev)
AUTH_MODE=oidc docker compose --profile oidc up --build    # sign in through the bundled mock IdP (needs `127.0.0.1 mock-idp` in your hosts file)
NEXUS_INGEST_TOKEN=nxi_... docker compose --profile collector up otel-collector    # real Collector -> ingest
```

The compose file is for development: demo data (`--seed`), throw-away key-encryption key, loopback egress allowed. It cannot be used as-is in production
(the services refuse that configuration when `NODE_ENV=production`).

Without Docker, see the README ("Local development") — every service runs directly with `tsx`.

## Production checklist

**Secrets** (from your platform's secret manager — never the image, the repo, or a plain environment file in source control)
* `MONGODB_URI` (a dedicated user, roles per `docs/runbooks/mongodb-roles.md`; TLS to MongoDB).
* `SECRETS_KEYS` / `SECRETS_CURRENT_KEY_ID` — the key-encryption key ring for stored connection credentials (`docs/runbooks/secrets-and-kek-rotation.md`).
* `OIDC_CLIENT_SECRET_FILE` (preferred) or `OIDC_CLIENT_SECRET`.

**Configuration** — the services refuse to start (clear message, no values echoed) unless:
* `NODE_ENV=production`, `AUTH_MODE=oidc` with `OIDC_ISSUER` over https, `WEB_ORIGIN` an https origin (`COOKIE_SECURE` stays on),
* `SECRETS_KEYS` is set, `NETWORK_ALLOW_LOOPBACK` is off, `OIDC_ALLOW_INSECURE_ISSUER` is off, JIT provisioning (if used) has an org and a domain allow-list.
* `INGEST_PUBLIC_URL` should be the public https URL of the ingest service (it is only shown to users in the setup UI).

**Network**
* Terminate TLS in front of `web` and `ingest` (load balancer/ingress). The nginx image listens on plain HTTP :8080 and trusts nothing from the client.
* `trustProxy` is **off** in the API (see STATUS "known limitations"): per-IP rate limits and audit IPs see the proxy's address until you enable it deliberately.
* Do not publish `api`, `worker` or MongoDB to the internet. Only `web` (users) and `ingest` (your applications) need public routes.
* Egress: connectors reach customer targets from the `api`/`worker` network. Keep loopback/metadata addresses blocked (the default) and list approved private
  CIDRs in `NETWORK_ALLOW_PRIVATE_CIDRS`.

**Data**
* MongoDB must be a replica set. Run migrations as a deploy step with a privileged user (they take a lock, so several replicas starting at once is safe).
  **Migration v5 backfills a field on every existing log record** — schedule it for a quiet period on a large collection (`docs/performance.md`).
* Back up with the dedicated `backup` role; back the KEK up separately.
* Retention is per ingestion token and enforced by MongoDB TTL indexes.

**Identity provider** — `docs/auth-oidc.md` (registration steps for Microsoft Entra ID and generic OIDC providers).

**Not provided:** Kubernetes manifests/Helm chart, Terraform, autoscaling, a durable queue in front of ingestion (senders retry on 429/503), multi-region, MFA
(delegate it to your identity provider), SIEM export of the audit trail.

## What has been verified, and how

| Item | How verified | Result |
|---|---|---|
| `api`, `worker`, `ingest` bundles start and behave under `NODE_ENV=production` | `node infra/scripts/prod-smoke.mjs` runs `apps/*/dist` with production settings against a real `mongod` | 15 checks: production refuses dev auth / missing KEK / http origin / http issuer / insecure-issuer flag / open JIT; ready endpoints; no dev login; protected routes 401; no `/docs`; security headers; clean IdP-down redirect; ingest rejects bad tokens |
| The Docker runtime layout (`pnpm deploy --prod` dependency trees + `dist/`) works | same script with `SMOKE_DEPLOY_DIR` pointing at `pnpm deploy --prod --legacy` output | 15/15 on Windows. **Size not representative:** the deployed `node_modules` measured 258 MB for the API on Windows (symlinks copied by value); not measured on Linux |
| The production web bundle works under the nginx CSP | `tests/e2e/specs/13-production-csp.spec.ts` serves `apps/web/dist` with the exact `Content-Security-Policy` parsed from `infra/nginx/nginx.conf` | passes (it found and fixed two real problems: an inline script and Zod's `new Function` probe) |
| The OpenTelemetry Collector config and the Collector → ingest → UI path | real `otelcol-contrib` v0.164.0 binary, `docs/runbooks/collector.md` | `validate` passes; end-to-end spec passes |
| `Dockerfile` builds, images run, compose stack starts, nginx serves | **not verified** — no Docker/nginx available | ⚠ unverified |
| Compose YAML is well-formed, every `depends_on`/`target` resolves, every environment variable name exists in the service's config schema | static script check | passes |
| The `otel/opentelemetry-collector-contrib:0.164.0` and `mongo:7.0` / `nginxinc/nginx-unprivileged:1.27-alpine` image tags exist | **not verified** (no registry access attempted) | ⚠ unverified; pin digests when you first pull them |
