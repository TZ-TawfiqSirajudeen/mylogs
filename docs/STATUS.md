# Nexus Observability — implementation status

Last updated: 2026-10-28. Legend: ✅ done & tested · 🟡 partial · ⬜ not started.

**Verification at the time of writing** (commands in the table in the hardening section below): `pnpm typecheck` clean · `pnpm test` **539 tests / 13 suites pass, 0 fail**
(real `mongod` replica sets, real HTTP servers; packages run one at a time) · four production builds clean · `node infra/scripts/prod-smoke.mjs` 15/15 ·
`pnpm e2e` (Playwright + system Chrome, whole stack incl. an OIDC variant and the real OpenTelemetry Collector): **81 passed, 0 failed, 0 skipped (7.0 min, clean state, real Collector enabled)**.

## Phase 1 — Foundation ✅
Monorepo, strict TS, MongoDB layer with versioned migrations/rollback/real lock, cookie sessions + CSRF + throttling, RBAC policy with
environment scoping (restricted admins cannot escape their scope), tenant isolation, audit trail, web shell. Reviewed by an independent
agent; all findings fixed with regression tests. (OIDC/SSO was added afterwards — see the hardening section. **MFA is not implemented in Nexus**: enforce it at the identity provider.)

## Phase 2 — Secure source connections ✅
Threat model; SSRF guard; envelope-encrypted secret store with KEK rotation; connector SDK with contract test kit; HTTP-health, MongoDB and Redis
connectors (tested against real services, least-privilege roles verified); connection lifecycle (draft → test → discover → select → activate →
monitor → rotate → disconnect/delete); leased worker scheduling; 12-step wizard; capability matrix generated from the registry.
Pull connectors **verify and monitor only; they do not collect**. External secret managers and all cloud/host/other-DB connectors: ⬜ (listed as planned).

## Testing pass (before phase 3)
Browser automation found 7 defects that unit tests had not (wizard ignored the header selection, favicon 404, read-only roles saw mutation buttons,
no up-front non-admin notice, WCAG contrast failures in light **and** dark themes, theme-button label, long-name overflow). All fixed.

## Phase 3 — Logs: ingestion, storage, search ✅ (live Collector verification pending)

| Area | Status | Evidence |
|---|---|---|
| OTLP/HTTP logs endpoint (protobuf + JSON, gzip/deflate/br), generic JSON/NDJSON endpoint | ✅ | 13 service tests; **real OpenTelemetry JS SDK exporters (protobuf and JSON) verified end to end** |
| OpenTelemetry **Collector** run against the endpoint | ✅ binary · 🟡 rest | real `otelcol-contrib` v0.164.0 running `infra/otel-collector/config.yaml` **unmodified**: `validate` passes; authenticated OTLP/HTTP and a tailed log file reach storage and the UI; a wrong token stores nothing (`tests/e2e/specs/12`). **Not verified:** gRPC traffic, the container image, long outages, the download's sigstore signature |
| OTLP traces, metrics, gRPC transport | ⬜ | phase 4 |
| Per-environment ingestion tokens (hash only, shown once, revocable, rate/retention/redaction per token) | ✅ | 20 + API + e2e tests |
| Normalization (timestamps, severity, semantic-convention fields, bounds), **redaction before persistence** (keys + credential-shaped text incl. vendor tokens, per-token extra keys) | ✅ | 43 unit tests; e2e proves secrets never reach the DB/API/UI |
| Idempotent writes, bounded concurrency + queue (backpressure), retries with jitter, storage-outage and mid-batch failure recovery | ✅ | pipeline tests incl. failure injection |
| Explicit loss accounting (per-minute, per-reason), "no telemetry received yet" for silent environments, refusal banner | ✅ | tests + e2e |
| Log store behind a `LogStore` interface (MongoDB), tenant-scoped, TTL retention per record | ✅ | 24 store tests (index usage asserted, no collection scans) |
| Query: validated builder (allow-listed fields/operators, ≤31 days, keyset pagination, 8 s timeout), injection-resistant | ✅ | store + API tests |
| Detail, related events (observed trace/request correlation), neighbours, histogram, facets, **live tail (SSE)**, export (engineer+, capped, CSV-formula-safe, audited), saved queries, history | ✅ | 19 API tests + 6 e2e journeys |
| Logs Explorer UI: URL-synced filters and deep links (carry the project, still authorized), virtualized list, detail drawer, JSON view, copy/search-for-value actions, keyboard operable | ✅ | e2e incl. keyboard-only; WCAG A/AA axe clean in both themes; no horizontal scroll at phone/tablet |
| Ingestion setup UI (token creation shown once, endpoints, snippets, per-environment health) | ✅ | e2e |
| Capability matrix lists OTLP/JSON logs as **implemented (push)**, traces/metrics as planned | ✅ | generated + tests |
| Benchmarks with targets | ✅ | `docs/performance.md` — originally **4 of 11 targets missed**; after optimisation all 11 are met in 3 runs on the same 300k dataset, **two with thin margins** (no-match text search 692–941 ms vs 1,000; facets up to 461 vs 500). Targets were not changed. Filtered histograms/facets are still linear (e.g. attribute-filtered histogram p95 1.95 s) |

### Defects found by testing during phase 3 (all fixed)
Nested forms discarded filters; tail slots leaked because disconnects were detected on the wrong socket; export audit raced the response; trace/request
indexes were unusable partial indexes (900 ms → 1.5 ms); pivoting on a trace id kept narrowing filters; shared links lost the project; the filters panel
collapsed while editing; ARIA table structure invalid.

## Hardening pass (OIDC, full verification, production readiness) — 2026-10-28

Requested before starting phase 4; **phase 4 has not been started.**

### Delivered
| Area | Status | Evidence / notes |
|---|---|---|
| **OIDC single sign-on** (Authorization Code + PKCE S256, state, nonce, RFC 9207 `iss`, ID-token signature/iss/aud/azp/exp/nbf, exact redirect URI, one-time server-side flow records bound to the browser, server-side sessions, rotation on login, RP-initiated logout, no tokens stored) | ✅ with a **mock provider** · ⬜ **not tried against a real IdP** | `docs/auth-oidc.md`, ADR-0004. 80 API tests (`apps/api/test/oidc.test.ts`) + 12 browser specs (`specs/11`). Entra ID / generic OIDC registration steps are written but **unverified against a live tenant** |
| Provisioning and RBAC mapping | ✅ | invite-only default; JIT opt-in (needs org + domain allow-list); claims/e-mail never grant roles; group map only at first provisioning, never owner; (issuer, sub) identity, no takeover by e-mail reuse; read-only/auditor/export restrictions re-tested under SSO; cross-tenant tests |
| Org member management (API + Settings UI) | ✅ | admins manage member/auditor only, owners everyone; no self-change; **last owner can never be removed (race-safe; the test reproduces the race without the fix)**; removals and role changes revoke sessions; audited. 11 tests + browser spec |
| Every API route needs a session (except an explicit allow-list) | ✅ | route-inventory test: every non-public route answers 401 anonymously and with a forged cookie/bearer/CSRF |
| Secret hygiene | ✅ | client secret non-enumerable in config, never in logs/responses/storage (asserted); callback query string stripped from request logs |
| Telemetry senders unaffected by OIDC | ✅ | ingest and worker have no auth-mode dependency; the Collector e2e and prod smoke run alongside the OIDC deployment |
| Production Dockerfile (multi-target), docker-compose (mongo replica set, oidc and collector profiles), nginx config | 🟡 **written, NOT built or run** (no Docker/nginx here) | `docs/deployment.md` lists what *was* verified instead (bundles under production settings; `pnpm deploy` layout; CSP) |
| OpenTelemetry Collector validated with a real binary + authenticated end-to-end | ✅ | `docs/runbooks/collector.md` (binary from the official GitHub release, checksum verified, run from a scratch directory) |
| Performance: free-text search, histogram, facets | ✅ | Phase 3 row above and `docs/performance.md`: before/after on the same dataset, 3 runs, trade-offs and remaining slow paths |
| Docs reviewed for accuracy | ✅ | README, STATUS, ADR-0001/0003, otlp-logs, roles runbook (was stale), deployment, OIDC |

### Defects this pass found (all fixed, each with a regression test)
1. **ID tokens were accepted with a bad signature or wrong `azp`** — `openid-client` does not verify the signature for the code flow. Added explicit `jose` JWKS verification. (Found by the tamper tests.)
2. **The built `api`/`worker`/`ingest` bundles crashed at startup** (`Dynamic require of "timers/promises"`): they had only ever been *built*, never *run*. Fixed with a `createRequire` banner. (Found by the production smoke test.)
3. **The last-owner guard had a write-skew race** (two owners demoting each other could leave none). Now transactional. (Found in review; reproduced 3/3 without the fix.)
4. **The Members page sent the old role** (it read `e.target.value` after React had reset the controlled select). (Found by the browser spec; API tests could not see it.)
5. **The production CSP would have broken the app**: an inline theme script and Zod's `new Function` probe. Fixed. (Found by `specs/13`.)
6. **The MongoDB role runbook omitted 7 collections** (all telemetry collections and `auth_flows`): the documented production DB user could not have run the platform. Fixed, plus a test that compares the runbook to the code.
7. `pnpm -r test` failed intermittently on Windows (parallel vitest cache race): the root `test` script now runs packages one at a time.

### Commands and results
| Command | Result |
|---|---|
| `pnpm install --frozen-lockfile` | ok |
| `pnpm typecheck` | clean (all packages incl. tests) |
| `pnpm test` | 539 passed, 0 failed (13 suites; `contracts` and `mock-idp` have no tests of their own, the latter is exercised through the API/e2e suites) |
| `pnpm --filter @nexus/{api,worker,ingest-service,web} build` | all succeed (web warns about a chunk over 500 kB; not addressed) |
| `node infra/scripts/prod-smoke.mjs` | 15/15 (also 15/15 from `pnpm deploy --prod --legacy` trees, the layout the Docker images use) |
| `OTELCOL_BIN=<otelcol-contrib> pnpm e2e` | **81 passed, 0 failed, 0 skipped (7.0 min, clean state, real Collector enabled)** |
| `pnpm bench` | all 11 targets met in 3 runs (`docs/performance.md`) |

### Unresolved risks and blockers
* **Real identity provider:** needs a tenant, an app registration and a client secret I do not have. Provider quirks (Entra optional claims, absent `email_verified`, end-session URL rules, JWKS key rotation, group claims) are untested against live services.
* **Docker / compose / nginx:** never built or run; the image tags (`mongo:7.0`, `nginxinc/nginx-unprivileged:1.27-alpine`, `otel/opentelemetry-collector-contrib:0.164.0`) are not verified to exist. Run `docker compose build && docker compose up` in CI before relying on them. The deployed Linux image size is unmeasured.
* **Collector:** the download's sigstore signature was not verified (no `cosign`); gRPC, the container image and multi-minute outages were not exercised.
* **Secure cookies in a real browser:** `__Host-`/`Secure` attributes are asserted at the HTTP level (API tests); the browser specs run over plain `http://localhost`, so HTTPS cookie behaviour in a browser is not exercised.
* **Performance margins are thin** for no-match text search and facets; attribute-filtered histograms (1.2-1.95 s) and text-filtered facets (about 1 s) were measured and are slow; everything that needs documents is linear in matching records. Free-text search now covers only the first 2,048 characters of a message. Migration v5 backfills every existing log record under the migration lock.
* **No MFA in Nexus, no back-channel logout:** a user disabled at the IdP keeps their Nexus session until idle/absolute expiry or an admin revokes it.
* Browser coverage is Chrome on Windows only; benchmark numbers are from one laptop.

### Next recommended phase
Phase 4 (traces, request waterfall, service metrics) **after you have reviewed this report**. Before or alongside it: (1) a staging sign-in against your real identity provider; (2) build and run the Docker images in CI; (3) decide whether the thin performance margins justify per-minute rollups before volume grows.

## Not started (phases 4–8)
Traces & service metrics (OTLP traces/metrics), request waterfall, dependency map, cloud/host/DB metric collectors, incidents, alerting & notifications,
deployments, AI module, retention policies UI, load/failure-injection suite beyond what is listed, Kubernetes/Terraform (Docker files exist but are unverified).

## Known limitations / follow-ups
* MongoDB is not a columnar store; filtered histograms/facets and any search without an index prefix are linear in matching records (see performance doc). ClickHouse is the documented upgrade path.
* Ingest rate limits are per process. No durable queue in front of storage (senders retry on 429/503).
* Redaction is best-effort: it cannot recognise an arbitrary secret in arbitrary text.
* MongoDB driver re-resolves hostnames (residual SSRF window, needs egress rules). TLS paths are covered by logic, not by a live TLS endpoint.
* Audit immutability relies on the API plus the insert/find-only role in `docs/runbooks/mongodb-roles.md` (verified against a real mongod).
* `trustProxy` is off; configure it behind a load balancer before relying on per-IP limits.
* No Docker on the dev machine: images/compose/nginx were not built or run (see `docs/deployment.md`).
