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

> **`MONGODB_URI` in compose.** The compose file defines a `mongo` service (single-node replica set `rs0`) that the other services wait for. `MONGODB_URI` now defaults to
> `mongodb://mongo:27017/?replicaSet=rs0` and can be overridden from the environment (`${MONGODB_URI:-...}`). An earlier version of this file held a hosted-cluster URI with a real
> credential; that value is gone from the working tree but is still in git history, so rotate it and purge it as described in
> [runbooks/credential-rotation.md](runbooks/credential-rotation.md). The file has still never been run (no Docker on the development machine); CI runs it.

Without Docker, see the README ("Local development") — every service runs directly with `tsx`, reading a gitignored root `.env` in development (production starts never read `.env`).

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

### Static verification of container files

`node infra/scripts/check-container-files.mjs` (no Docker, no nginx, no network; uses the `yaml` package that `pnpm install` already provides). It exits 1 on any failure. Last run: **245/245 checks passed**. It checks:

* **Dockerfile:** every `FROM` resolves to an earlier stage or an image; every `COPY --from` names an existing stage; every `COPY` source exists **and is not removed by `.dockerignore`**; **every workspace package manifest** (from `pnpm-workspace.yaml`) is copied before `pnpm install --frozen-lockfile`; `packageManager` is pinned; `EXPOSE` and the `HEALTHCHECK` port equal the default read from each app's source (4000, 4100, 4318) and 8080 for nginx; api and ingest bind `0.0.0.0`; the `CMD` entry file is what `tsup` builds; `USER node` and no switch back to root; `/data/dev-secrets` is owned by `node` before the user switch.
* **`.dockerignore`** (re-implemented Docker matching: root-relative patterns, `**`, `!`, last match wins) against representative and real paths: nested `.env`, `apps/api/.dev-secrets/kek.json`, `packages/database/.mongo-data`, logs, `node_modules`, `dist`, `.git`, test artefacts are excluded; `.env.example`, the lockfile, source and `infra/` files are kept.
* **docker-compose.yml:** parses (YAML merge keys included); `${VAR...}` syntax is valid; no required `${VAR:?}`; build targets exist; `depends_on` targets and conditions are valid and `service_healthy` targets have a healthcheck; default services do not depend on profile services; named volumes are declared, bind mounts exist; host ports are unique; every environment variable name is read by the service it is given to (api, worker, ingest, mock-idp schemas).
* **infra/nginx/nginx.conf** (tokenised, not run): braces and semicolons, directive-name typo guard, listens on 8080 only, `/nginx-health` exists, `/api/` proxies to the compose service `api` on the API port without buffering and with a read timeout of at least 1 h, body ceiling not below the API's own limit, no security headers added on `/api/`, **every static location repeats all four security headers** (nginx drops inherited `add_header` when a location has its own) with identical values, CSP present and still extractable by `tests/e2e/specs/13`, SPA fallback, `index.html` revalidated, `/assets/` immutable and 404 for missing files, gzip on static locations only.
* **Collector:** every pipeline component is defined, every `${env:...}` has a default or is supplied by compose, the compose image tag equals the version the config was verified with (0.164.0), the mounted path equals `--config`, the exporter target is the compose `ingest` service.
* **Credentials:** no MongoDB URI with an embedded password, password literal, ingest token, private key or key-encryption key in the container/infra files (the documented dev default `local-dev-secret-change-me` is allowed).

Defects this found and fixed: `.dockerignore` patterns were root-relative, so `apps/api/.dev-secrets` (the dev key-encryption key) and the ~219 MB `packages/database/.mongo-data` entered the build context (and the `mock-idp` image, which is built `FROM build`); nginx dropped CSP, `nosniff` and `X-Frame-Options` on `index.html` and assets; `/data/dev-secrets` would have been root-owned in the named volume; `web` started before the API was healthy; the Mongo healthcheck passed before a primary was elected.

**Still not verified (needs Docker/nginx/registry; run in CI):**
`docker build --target api|worker|ingest|web|mock-idp .` (image builds, size), `docker compose config -q` and `docker compose up --build` (stack starts, `rs.initiate` works with `host: mongo:27017`, health checks go green, `curl -f http://localhost:8080/nginx-health`), `docker run --rm -v "$PWD/infra/nginx/nginx.conf:/etc/nginx/conf.d/default.conf:ro" nginxinc/nginx-unprivileged:1.27-alpine nginx -t` (the file is only tokenised here), response headers from the real nginx (`curl -sI http://localhost:8080/ | grep -i content-security`), and that the image tags (`mongo:7.0`, `nginxinc/nginx-unprivileged:1.27-alpine`, `otel/opentelemetry-collector-contrib:0.164.0`) exist. Known limitation: nginx resolves `api` once at start-up; recreate or reload `web` after recreating the API container. The `oidc` profile has a known problem (the mock IdP binds 127.0.0.1 only, so the published port and the API container cannot reach it); see the report that accompanied this change.

## CI

Two GitHub Actions workflows live in `.github/workflows/`. **Neither has been run yet**: they were written on a machine without Docker and without access to GitHub Actions
(YAML parsed, every script they call was run locally). The first run on GitHub is the first real verification of the Docker items in the table above; expect to tune it.

| Workflow / job | What it runs | Proves | Does not prove |
|---|---|---|---|
| [`ci.yml`](../.github/workflows/ci.yml) `verify` | `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm test` (sequential, mongodb-memory-server), `pnpm run test:infra`, `pnpm build` (api, worker, ingest, web), `check-container-files.mjs`, `prod-smoke.mjs` (repository layout and the `pnpm deploy --prod` layout) | code compiles, tests pass, bundles start under production settings | Docker, browsers (Playwright is not in CI), a real IdP |
| `ci.yml` `docker-images` (matrix: api, worker, ingest, web, mock-idp) | `docker build --target X`; fails if the image holds `.env`, `kek.json`, `.dev-secrets`, `.mongo-data` or a **canary secret** planted in the build context; non-root user; expected entry point | the Dockerfile builds; `.dockerignore` keeps local secrets out of images | image vulnerabilities, size budgets |
| `ci.yml` `docker-compose` | `docker compose config` (all profiles), `nginx -t` on `infra/nginx/nginx.conf` with the Dockerfile's nginx image, `docker compose up --wait`, [`infra/scripts/compose-smoke.sh`](../infra/scripts/compose-smoke.sh) (healthz of api/ingest/worker, web and `/api` through nginx, security headers, then the `oidc` profile with the mock IdP), logs dumped on failure, `down -v` always | the stack starts and nginx accepts and serves the config | TLS, Kubernetes, a real IdP, load |
| `ci.yml` `secret-scan` | `infra/scripts/scan-secrets.mjs` (tree + `git log -p --all`) and gitleaks ([`.gitleaks.toml`](../.gitleaks.toml)) | no credential-shaped value in the tree or history | the gitignored `.env` (never read) |
| [`oidc-staging.yml`](../.github/workflows/oidc-staging.yml) (manual `workflow_dispatch` only) | `infra/scripts/oidc-staging-verify.mjs` with `OIDC_STAGING_*` repository variables / secret: discovery, issuer equality, JWKS, token-endpoint auth method, client id/secret probe, redirect URIs to register | the provider's metadata matches what Nexus needs | the interactive browser sign-in (stays manual: [oidc-staging-verification.md](runbooks/oidc-staging-verification.md) steps 4-12) |

Run the same checks locally: `pnpm run test:infra`, `pnpm run check:containers`, `pnpm run smoke:prod`, `pnpm run scan:secrets`, `pnpm run verify:oidc` (needs `OIDC_*` variables).
Credential exposure and rotation: [runbooks/credential-rotation.md](runbooks/credential-rotation.md). Dependabot (`.github/dependabot.yml`) proposes updates to actions, base images and npm packages; consider pinning actions to commit SHAs.
