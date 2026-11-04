# Nexus Observability — implementation status

Last updated: 2026-10-31. Legend: ✅ done & tested · 🟡 partial · ⬜ not started.

**Where things stand:** Phases 1–4 are implemented (Phase 4 = distributed traces, OTLP metrics, service dashboard; see its section below), and the first slice of
Phase 5 (read-only metric collection from MongoDB and Redis connections) is implemented and verified against real local servers. What is **not** verified is listed
in "Unresolved risks and blockers" and in the Phase 5 section.

**Verification:** each section lists the commands it was verified with and their real results. The most recent complete runs (2026-10-31, final code) are in "Phase 4 — Commands and results":
`pnpm typecheck` clean · `pnpm test` 880 passed in 15 package runs · four production builds clean · `node infra/scripts/prod-smoke.mjs` 15/15 · container-file static check 248/248 ·
Playwright 102 passed, 0 failed, with the real OpenTelemetry Collector.
The 539-test / 81-spec figures quoted in the hardening section are historical (they were true when that pass finished).

## Phase 1 — Foundation ✅
Monorepo, strict TS, MongoDB layer with versioned migrations/rollback/real lock, cookie sessions + CSRF + throttling, RBAC policy with
environment scoping (restricted admins cannot escape their scope), tenant isolation, audit trail, web shell. Reviewed by an independent
agent; all findings fixed with regression tests. (OIDC/SSO was added afterwards — see the hardening section. **MFA is not implemented in Nexus**: enforce it at the identity provider.)

## Phase 2 — Secure source connections ✅
Threat model; SSRF guard; envelope-encrypted secret store with KEK rotation; connector SDK with contract test kit; HTTP-health, MongoDB and Redis
connectors (tested against real services, least-privilege roles verified); connection lifecycle (draft → test → discover → select → activate →
monitor → rotate → disconnect/delete); leased worker scheduling; 12-step wizard; capability matrix generated from the registry.
Phase 2 itself shipped connectors that **verify and monitor only**; the MongoDB and Redis connectors gained read-only metric collection in Phase 5 (see its section). The HTTP-health connector still does not collect. External secret managers and all cloud/host/other-DB connectors: ⬜ (listed as planned).

## Testing pass (before phase 3)
Browser automation found 7 defects that unit tests had not (wizard ignored the header selection, favicon 404, read-only roles saw mutation buttons,
no up-front non-admin notice, WCAG contrast failures in light **and** dark themes, theme-button label, long-name overflow). All fixed.

## Phase 3 — Logs: ingestion, storage, search ✅ (live Collector verification pending)

| Area | Status | Evidence |
|---|---|---|
| OTLP/HTTP logs endpoint (protobuf + JSON, gzip/deflate/br), generic JSON/NDJSON endpoint | ✅ | 13 service tests; **real OpenTelemetry JS SDK exporters (protobuf and JSON) verified end to end** |
| OpenTelemetry **Collector** run against the endpoint | ✅ binary · 🟡 rest | real `otelcol-contrib` v0.164.0 running `infra/otel-collector/config.yaml` **unmodified**: `validate` passes; authenticated OTLP/HTTP and a tailed log file reach storage and the UI; a wrong token stores nothing (`tests/e2e/specs/12`). **Not verified:** gRPC traffic, the container image, long outages, the download's sigstore signature |
| OTLP traces and metrics | ✅ since Phase 4 | see "Phase 4" below (at the end of Phase 3 these were ⬜) |
| OTLP/gRPC transport | ⬜ **not supported** (HTTP only), not claimed anywhere | — |
| Per-environment ingestion tokens (hash only, shown once, revocable, rate/retention/redaction per token) | ✅ | 20 + API + e2e tests |
| Normalization (timestamps, severity, semantic-convention fields, bounds), **redaction before persistence** (keys + credential-shaped text incl. vendor tokens, per-token extra keys) | ✅ | 43 unit tests; e2e proves secrets never reach the DB/API/UI |
| Idempotent writes, bounded concurrency + queue (backpressure), retries with jitter, storage-outage and mid-batch failure recovery | ✅ | pipeline tests incl. failure injection |
| Explicit loss accounting (per-minute, per-reason), "no telemetry received yet" for silent environments, refusal banner | ✅ | tests + e2e |
| Log store behind a `LogStore` interface (MongoDB), tenant-scoped, TTL retention per record | ✅ | 24 store tests (index usage asserted, no collection scans) |
| Query: validated builder (allow-listed fields/operators, ≤31 days, keyset pagination, 8 s timeout), injection-resistant | ✅ | store + API tests |
| Detail, related events (observed trace/request correlation), neighbours, histogram, facets, **live tail (SSE)**, export (engineer+, capped, CSV-formula-safe, audited), saved queries, history | ✅ | 19 API tests + 6 e2e journeys |
| Logs Explorer UI: URL-synced filters and deep links (carry the project, still authorized), virtualized list, detail drawer, JSON view, copy/search-for-value actions, keyboard operable | ✅ | e2e incl. keyboard-only; WCAG A/AA axe clean in both themes; no horizontal scroll at phone/tablet |
| Ingestion setup UI (token creation shown once, endpoints, snippets, per-environment health) | ✅ | e2e |
| Capability matrix lists OTLP/JSON logs as **implemented (push)**, traces/metrics as planned | ✅ then; **stale since Phase 4** | generated + tests. The `otlp` descriptor still says traces/metrics are planned: see "Known issues" under Phase 4 |
| Benchmarks with targets | ✅ | `docs/performance.md` — originally **4 of 11 targets missed**; after optimisation all 11 are met in 3 runs on the same 300k dataset, **two with thin margins** (no-match text search 692–941 ms vs 1,000; facets up to 461 vs 500). Targets were not changed. Filtered histograms/facets are still linear (e.g. attribute-filtered histogram p95 1.95 s) |

### Defects found by testing during phase 3 (all fixed)
Nested forms discarded filters; tail slots leaked because disconnects were detected on the wrong socket; export audit raced the response; trace/request
indexes were unusable partial indexes (900 ms → 1.5 ms); pivoting on a trace id kept narrowing filters; shared links lost the project; the filters panel
collapsed while editing; ARIA table structure invalid.

## Hardening pass (OIDC, full verification, production readiness) — 2026-10-28

Requested before starting phase 4; **phase 4 had not been started when this pass was written** (it has since been; this section is kept as the historical record of that pass).

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

## Phase 4 — Traces, metrics, service dashboard ✅ (with the gaps listed below)

Decision record: [ADR-0005](architecture/ADR-0005-traces-and-metrics.md) (storage choice, written before the code). Reference: [traces-metrics.md](traces-metrics.md),
[integrations/otlp-traces-metrics.md](integrations/otlp-traces-metrics.md). Measurements: [performance-traces-metrics.md](performance-traces-metrics.md).

### Delivered
| Area | Status | Evidence / notes |
|---|---|---|
| **OTLP/HTTP `POST /v1/traces` and `POST /v1/metrics`** (protobuf and JSON; gzip/deflate/br), same ingestion service and token model as logs | ✅ | `apps/ingest/test/signals.test.ts`; real OpenTelemetry JS SDK exporters (protobuf) through the sample app (`tests/e2e/specs/14-traces-e2e.spec.ts`); real Collector (`specs/12-collector-path.spec.ts`) |
| **OTLP/gRPC** | ⬜ **not supported, not claimed** | the Collector may receive gRPC from applications and export to Nexus over HTTP |
| Tokens: per-signal scopes (`logs`, `traces`, `metrics`); the tenant comes from the token, never from the payload | ✅ | `signals.test.ts` ("authentication and token scope", "stored under the token's tenant, whatever the payload claims"); a logs-only token relayed by the real Collector gets 403 and nothing is stored (`specs/12`, test 4) |
| **Trace storage** behind a `TraceStore` interface (`@nexus/tracestore`, MongoDB): one document per span, idempotent `_id`, nanosecond precision, trace summaries **recomputed** from stored spans after every write | ✅ | `packages/tracestore/src/tracestore.test.ts` (25 tests: arrival-order independence, duplicates, late/orphan repair, tenant/environment separation, TTL and index use asserted) |
| Completeness is observed, never assumed: partial traces flagged, no invented root, missing end times stored without a duration, skew reported | ✅ | `tracestore.test.ts`; `apps/api/test/traces.test.ts` ("a partial trace says so in plain language and never fabricates a root"); `specs/15-trace-edge-cases.spec.ts` |
| **Trace search** (validated query builder: trace id, service, span name, errors/ok, duration window, HTTP status/method/route, db system, exception type, environments, recent/slowest, keyset pagination, ≤ 31 days) | ✅ | `traces.test.ts`, `tracestore.test.ts` (no collection scans for the default and slowest sorts; operators/regex cannot be injected) |
| **Request waterfall**: hierarchy, exact timing, overlapping siblings, collapse/zoom, span details (attributes, events, exceptions, links), virtualized rows (1,500-span trace renders only visible rows), table alternative, keyboard operable, WCAG A/AA axe clean in both themes, phone width | ✅ | `apps/web/src/pages/traces/waterfall-model.test.ts` (pure model); `specs/14`, `specs/15` |
| **Trace ↔ log correlation** (logs by trace/span id, per-span counts, "this trace has not arrived" distinguished from "known") | ✅ | `traces.test.ts` ("trace-to-log correlation"); `specs/14` |
| **OTLP metrics**: gauge, sum (delta/cumulative, monotonic or not), histogram with explicit bounds; exponential histograms, summaries and unspecified temporality are **refused and counted** (OTLP partial success), never approximated | ✅ | `packages/telemetry/src/metrics.test.ts`, `signals.test.ts` |
| Metric storage (`@nexus/metricstore`, MongoDB): per-series per-minute pre-aggregation, reset-aware cumulative→delta, **percentiles from merged histogram buckets (never a percentile of percentiles)**, idempotent retransmission, out-of-order delta points accepted, series identity includes the service instance | ✅ | `metricstore.test.ts` (28), `process.test.ts` (22) |
| Cardinality control: ≤ 2,000 series per metric and 20,000 per environment (configurable), labels bounded, unbounded labels (`url.full`, `user.id`, …) dropped, excess refused and reported | ✅ | `metricstore.test.ts`, `signals.test.ts` ("cardinality"), `metrics.test.ts` |
| Bounded metric queries (≤ 5 label filters, ≤ 2 group-bys, ≤ 400 points per series, scan guard counted on the index first, 8 s timeout, no free-form expressions) | ✅ | `metricstore.test.ts` ("queries that would scan too much are refused"), `traces.test.ts` ("invalid, oversized and unsupported queries are explained, not executed") |
| **Service inventory + service dashboard**: rate, errors, p50/p95/p99, freshness by **event time** (not receive time), observed dependencies; explicit HTTP metrics are authoritative and trace-derived numbers are labelled as such (no double counting) | ✅ | `traces.test.ts` ("services"), `metricstore.test.ts`, `specs/14` |
| **Metric ↔ trace navigation**: exemplars link to concrete traces; otherwise an approximate time-window search, labelled as approximate; no causal claims | ✅ | `metricstore.test.ts` (exemplars), `traces.test.ts` ("not proof of cause"), `specs/14` |
| Two-service instrumented sample (gateway → inventory, W3C trace-context propagation, datastore span, logs carrying trace ids) | ✅ | `examples/sample-app`; `specs/14` asserts parent/child across the two services and exception events |
| Collector config with logs + traces + metrics pipelines | ✅ binary · 🟡 rest | real `otelcol-contrib` v0.164.0 (`docs/runbooks/collector.md`). Container image, gRPC, TLS and long outages **not** exercised |
| Retention per token (TTL) and migration v6 (collections, indexes, rollback) | ✅ | `packages/database/src/migrations.test.ts`; roles runbook consistency test `packages/database/src/roles.test.ts` |
| **MongoDB connection-string shortcut** in the data source wizard: paste `mongodb://` or `mongodb+srv://`, the form fills hosts/user/auth database/TLS and the password goes to the write-only credential field; SRV is expanded by the server (DNS only; only the host name is sent) | ✅ | `apps/web/src/pages/sources/mongo-uri.test.ts`, `packages/connectors/src/mongodb-srv.test.ts` (targets must sit below the seed's parent domain; lookalike suffixes refused), `apps/api/test/connections.test.ts` ("mongodb+srv helper"), `tests/e2e/specs/16-mongo-connection-string.spec.ts`. The connector itself was also run against a real 3-member Atlas replica set (read-only commands; MongoDB 8.0): all three members passed, **by hand, not part of the automated suite** |
| Chosen databases/signals stay visible after setup (Data Sources card lists what was chosen) | ✅ | `ConnectionDto.selection.resources`; `packages/connections/src/service.test.ts`; `tests/e2e/specs/17-mongo-wizard-journey.spec.ts` |

### Defects found during Phase 4 (all fixed; each has a test unless stated)
1. **Span and series ids collided across tenants**: ids did not include the organization. Added `orgId` to every derived id (`tracestore.test.ts`, `metricstore.test.ts`: same ids in different tenants never mix).
2. **Out-of-order delta metric points were silently dropped** by a single "newest timestamp" watermark. Delta and gauge series now remember the last 128 timestamps (`process.test.ts`).
3. **The first series cap (500 per metric) was far too small for a fleet** (series include the service instance). Raised to 2,000/20,000 and made configurable.
4. **Service freshness used receive time**, so a replayed old batch looked "fresh". Now event time (`traces.test.ts` services tests).
5. **Trace-summary sort indexes omitted `_id`**, producing blocking in-memory sorts; fixed and asserted by an explain test (`tracestore.test.ts`).
6. **`formatNs` printed trailing zeros wrongly** (UI duration text); fixed (`formatNs` cases in `waterfall-model.test.ts`).
7. **An `aria-label` that did not contain the visible text** failed axe (label-in-name); fixed. Now covered by the axe check in `specs/14` (waterfall test).
8. **The Metrics page ignored its deep link** (did not auto-run the query); fixed. Covered by the Metrics explorer test in `specs/14`.
9. **The Services dependencies table overflowed at phone width**; fixed. Covered by the phone-width test in `specs/14`.
10. **`GET /traces/:id/logs` returned 500 on an invalid time window** (raw `ZodError`); now a clear 400 (`traces.test.ts`: "an invalid or oversized time window is a clear 400, never a 500").
11. **Metric queries shipped every stored minute to Node** (first benchmark); aggregation now runs inside MongoDB. See the benchmark document for before/after numbers.
12. **A benchmark run taken while other processes were running (and a stale background run) produced invalid numbers**; the contaminated run is kept for the record as `docs/performance-traces-metrics.contaminated-run3.json` and is not used for any conclusion.
13. **The data source wizard could not take a connection string** (a pasted `mongodb+srv://…` was treated as a host name and `:27017` was appended). Fixed with the shortcut above.
14. **Chosen databases/signals vanished from the UI after setup** (saved, never displayed; nothing is collected for pull connectors in Phases 2–4). The card now lists them. Found by reproducing the user's journey in `specs/17`.
15. **Three specs were stale or racy**: `02-projects` expected `/traces` to be a placeholder page, `09-logs-explorer` expected the pre-Phase-4 token text, and `11-oidc` pressed Tab before the sign-in link had rendered (intermittent). Updated/fixed; the OIDC race was seen failing once and is fixed in the spec, not proven gone.

### Security checks (only what a test proves)
| Property | Where it is tested |
|---|---|
| No token / unknown token / malformed token: 401 with no detail; tokens never appear in error responses; a token scoped to one signal cannot write another (403) | `apps/ingest/test/signals.test.ts` ("authentication and token scope"); `specs/12` (through the real Collector) |
| Tenant and environment come from the token; identical trace/span ids in another environment or tenant are different spans | `signals.test.ts`; `tracestore.test.ts` ("never mix"); `metricstore.test.ts` ("tenants and environments are isolated in every query") |
| A trace in an environment the caller cannot read is indistinguishable from a trace that does not exist (404); other tenants, no-access roles and anonymous callers are refused; logs of other environments do not leak through a trace id | `apps/api/test/traces.test.ts` (trace detail, correlation, search scoping, metrics API authorization) |
| The in-process overview cache never serves a result across different permissions | `traces.test.ts` ("the overview cache never crosses permission boundaries") |
| Redaction **before persistence**: credential-named attributes, URL userinfo and credential query parameters, authorization headers, exception text, database connection strings, per-token extra keys; also masked at the Collector edge and again by the platform | `packages/telemetry/src/spans.test.ts`, `signals.test.ts` ("credentials are redacted BEFORE persistence"), `specs/12` (test 3). Redaction remains best-effort for arbitrary secrets in free text |
| Query-injection resistance (no operators or regular expressions from user input); malformed ids, oversized ranges and contradictory filters are 400s | `tracestore.test.ts`, `traces.test.ts` |
| Abuse limits: oversized bodies and decompression bombs → 413 before decoding; malformed JSON/protobuf → 400, never a crash; per-request span/data-point cap | `signals.test.ts`, `spans.test.ts` |
| Backpressure and failure: bounded queue → 503 + `Retry-After`; storage down → 503 and nothing claimed as accepted, the same request succeeds when storage returns; per-signal quotas with `Retry-After`; a metrics storage failure does not affect logs | `signals.test.ts` ("backpressure and recovery") |
| Cardinality abuse (many label combinations) is refused with an explanation; too-expensive metric queries are refused before scanning | `signals.test.ts`, `metricstore.test.ts` |
| Roles and collections: the documented MongoDB role covers every collection in the code | `packages/database/src/roles.test.ts` |
| SSRF on connectors and the SRV helper: metadata/private/shorthand-numeric targets refused at test time; the SRV endpoint needs `connection:manage`, refuses non-cluster names before any lookup and accepts no extra body fields; SRV answers outside the seed's parent domain are refused | `apps/api/test/connections.test.ts`, `packages/connectors/src/mongodb-srv.test.ts` |
| Production guard-rails still hold for the built bundles (15 checks, including "browser credentials do not authenticate telemetry senders") | `node infra/scripts/prod-smoke.mjs` |

**Findings that are not fixed (action required from the repository owner):**
* **A real MongoDB Atlas connection string with a password is committed** to this repository: it is in `docker-compose.yml` (`x-node-env`) and in `apps/api/src/config.test.ts`, both in the first git commit (a `.env.example` that also had it was replaced with placeholders before that commit). A git remote (`origin`) is configured; whether the commit was pushed is not known from the repository. **Rotate that password**, and purge it from history with a history rewrite if the commit was pushed. As committed, `docker-compose.yml` also points every service at that hosted cluster instead of the compose `mongo` service.
* A test fixture (`apps/web/src/pages/sources/mongo-uri.test.ts`) uses a real-looking Atlas user name and cluster host name with a made-up password; replace with `example.com` names.
* The Atlas cluster the user tried to use hit its **500-collection limit** ("cannot create a new collection -- already using 500 collections of 500"), so the platform could not be pointed at it. See [runbooks/atlas.md](runbooks/atlas.md).

### Known issues
* (Fixed 2026-10-31) The `otlp` push descriptor said traces and metrics were not accepted; it now describes all three signals and the capability matrix was regenerated. `registry.test.ts` now asserts that only the OTLP source claims traces and metrics.
* The `/dependencies` and `/dashboards` sidebar entries are "not implemented yet" placeholders (`/incidents` and `/alerts` were implemented on 2026-11-02, see "Alerting and incidents" below; `/deployments` on 2026-11-04, see "Deployments"). Observed dependencies are shown on **Services**.

### Commands and results
| Command | Result |
|---|---|
| `pnpm typecheck` | **clean (exit 0) on the final code** |
| `pnpm test` (one package at a time) | **exit 0, 880 tests passed across 15 package runs, 0 failed** (final code). The first full run after the Phase 5 work failed once: `packages/connectors/src/registry.test.ts` still asserted that the OTLP source must not claim traces/metrics, which contradicted the corrected descriptor. The test was updated and the whole suite re-run green. |
| `pnpm --filter @nexus/{api,worker,ingest-service,web} build` | all succeed (exit 0, final code); the web build still warns about a large chunk |
| `node infra/scripts/prod-smoke.mjs` | **15/15** (final code) |
| `node infra/scripts/check-container-files.mjs` | **248/248** static checks (not a build: see "Docker" below) |
| `OTELCOL_BIN=<otelcol-contrib> pnpm e2e` — first full pass of Phase 4 | **95 passed, 3 failed** (9.0 min): the three stale/racy specs in defect 15. Re-run in isolation after the fixes: `02`+`09`+`11` 27/27; `16`+`03`+`05` 11/11; `17`+`03` 6/6 |
| **FINAL FULL PLAYWRIGHT RUN** (all specs 00–18, real Collector enabled, `OTELCOL_BIN` set) | **102 passed, 0 failed, 0 skipped (14.4 min)**, run before the one-line `registry.test.ts` fix above (a unit-test-only change) |
| `pnpm --filter @nexus/ingest bench:signals` | see below and [performance-traces-metrics.md](performance-traces-metrics.md) |

### Benchmarks (one laptop, one `mongod` on the same machine, in-process pipelines: HTTP/TLS excluded; targets written before the first run and never changed)
* **Met:** trace lookup (p95 4.8 ms), waterfall load (432 spans, p95 21.9 ms), every trace search (p95 4–22 ms), slowest-first, per-service span statistics (p95 436 ms), observed dependencies (p95 1,245 ms against 1,500, and 514–1,479 ms across runs: close to the limit).
* **Span ingestion** (target ≥ 5,000/s): 6,119/s in the final run but **3,989 to 10,871 across runs**: it is around the target on this machine and cannot be claimed as a reliable pass.
* **Missed:** metric ingestion (3.3k points/s against ≥ 5,000/s in every run); grouped metric queries over 3 h (628 ms against 500 ms); HTTP service overview over 3 h (1,379 ms against 1,000 ms).
* **Round 2 (2026-10-31, after measured changes to the metric write and query paths; details and raw files in [performance-traces-metrics.md](performance-traces-metrics.md)):** metric ingestion is **still below target** (about 2.6–2.7k points/s against ≥ 5,000/s, +12–15% over the same-day baseline; it reaches 4,971/s with 2 intervals per request and 7,751/s with 6, so batching, not the store, is the lever). Grouped rate-by-service (3 h) now **meets** its target (403 and 426 ms). The HTTP overview (3 h) **still misses** it (p95 1.15–1.59 s, down from 2.9 s). Pre-aggregated rollups were **not built** (they need a migration and late-data rules).
* **Longer windows are now measured (24 h and 7 d, clones of stored documents for the longer spans):** only filtered queries stay interactive (one service's rate over 7 d: 1.3 s). All-series 24 h queries are not (p99 across everything 3.9 s, HTTP overview 7.6 s). The production scan guard (250,000 documents) deliberately refuses all-series 24 h and one-service 7 d queries. Cost is linear in window × series.
* **Defect found by the Round 2 work and fixed:** the gauge `last` value used an ascending sort inside `$top`, so any window with more than one stored minute or series showed the **oldest** value. The old tests used one document per window and could not see it. There is now an oracle test that recomputes every window from the stored documents (a mutation of the cumulative-baseline safeguard was confirmed to fail it).
* An earlier run taken under load is kept as a contaminated record and ignored.
* **Round 3 (2026-11-02, metric rollups, ADR-0007; see "Metric rollups" below):** the HTTP overview over 3 h now **meets** its target (p95 292 / 342 / 363 ms in the rollup author's three runs; **375 ms** in the supervisor's independent run, `performance-traces-metrics.round3-signals-supervisor.json`). Metric ingestion **still misses** it (4,738 points/s in the supervisor run against ≥ 5,000/s).

### Unresolved risks and blockers
* **Docker / compose / nginx**: still **never built or run** (no Docker, podman or nginx here; the only WSL distro is unusable). What is proven instead: 248 static checks (`infra/scripts/check-container-files.mjs`: COPY paths, workspace manifests, compose variables against the services' config schemas, nginx security headers, no credentials in container files). Real defects fixed by that pass: `.dockerignore` patterns were root-relative so the dev key-encryption key and a 219 MB local database folder would have entered the build context; nginx dropped the security headers (incl. CSP) on static locations; a fresh dev-secrets volume would have been root-owned; the Mongo health check could pass before a primary existed; `web` did not wait for a healthy API. The committed credential in `docker-compose.yml` and `apps/api/src/config.test.ts` was replaced with safe defaults (**rotate the password; it remains in git history**). Still to do in CI: image builds and sizes, `docker compose up`, `nginx -t`, registry tag existence (exact commands in `docs/deployment.md`).
* **Real identity provider**: still **never tried**. Verified by simulation instead: 48 provider-quirk tests (`apps/api/test/oidc-provider-quirks.test.ts`) found and fixed three real defects (an issuer path with a trailing slash failed discovery; a hanging token endpoint held sign-in for up to 30 s, now capped at 10 s; providers that require the client secret in the request body were not supported). A 12-step staging runbook is in `docs/runbooks/oidc-staging-verification.md`.
* **Real MongoDB Atlas**: cluster 1 (the original) is **full**: it holds 500 collections in user databases against the 500 cap and Nexus needs 23; the failed attempt left five empty collections in a `nexus` database. Cluster 2 has headroom by count (380 of 500) and the app's connect path works on it, but a **real run there needs your approval** (it would write): procedure in `docs/runbooks/atlas.md`. Only read-only commands were run against either cluster.
* **Real Redis server**: Redis collection was verified against Redis 5.0.14 installed on the development machine (with and without a password). Redis 6+ ACL users, TLS, replicas and cluster are not verified.
* **Collector**: gRPC from the Collector to Nexus is not supported (HTTP only). A real gRPC trace export *into* a real Collector (v0.164.0) that relays over HTTP was verified end to end (`apps/ingest/test/collector-grpc-relay.test.ts`); metrics and logs over gRPC through the Collector, the container image, TLS and multi-minute outages were not exercised. Native OTLP/gRPC is estimated at 3–5 days and not recommended unless a client cannot use the Collector.
* **Auto-instrumentation of MongoDB/Redis drivers and `fetch`/undici** was not exercised; the sample records manual datastore spans.
* **MongoDB is not a columnar store.** Span statistics and dependency discovery scan spans directly and are the first things to degrade with volume; metric aggregates scale with window × series. ClickHouse remains the documented upgrade path (ADR-0003, ADR-0005).
* Metric ingestion and the 3 h HTTP overview miss their targets on this hardware (see Benchmarks); exponential histograms and summaries are refused, not approximated.
* The mock identity provider could not run in the `oidc` compose profile (it bound to loopback only); `MOCK_IDP_HOST` and `MOCK_IDP_PUBLIC_ORIGIN` were added, **untested in a container**.
* Exemplar linkage depends on the SDK emitting exemplars (only verified for the sample's SDK versions).
* Deleting a project's telemetry on demand is not implemented (retention only).
* Browser coverage: Chrome on Windows only.

## Phase 5 (first slice): database metric collection (MongoDB/Redis) 🟡
Triggered by a real finding: after connecting MongoDB in the wizard and choosing databases, the choice vanished (nothing displayed it) and nothing was collected. Both fixed.

| Area | Status | Evidence / notes |
|---|---|---|
| Chosen resources and signals shown on the connection card (DTO `selection.resources`) | ✅ | `specs/17-mongo-wizard-journey.spec.ts` (full wizard, real mongod); `packages/connections` service test |
| MongoDB read-only collection (`serverStatus`, `hello`, `replSetGetStatus`, per-selected-database `dbStats`) | ✅ against real servers | MongoDB 8.2.6 standalone with auth using a `clusterMonitor`-only user, and a single-node replica set; command allow-list enforced; `opcounters.query` does not move (no documents read) |
| Redis read-only collection (`INFO` sections only; key counts only) | ✅ against **Redis 5.0.14** (with and without a password) | allow-list enforced; `get/set/keys/scan` counters do not move |
| Worker collection in the same lease as the health check; a failed check pauses collection; errors scrubbed with remediation; backoff | ✅ | `apps/worker` `collection.test.ts`; `packages/connections` `collection.test.ts` |
| Metrics land in the shared metric store through the normal path (cardinality limits, idempotency, reset-aware cumulative-to-delta, retention) | ✅ | `packages/metricstore` `connector-sink.test.ts`: inserting 5 documents shows exactly +5 |
| UI: card shows status, last success, live lag, errors, "See its metrics"; Metrics page banner for connector-sourced metrics; capability matrix says "collects metrics (read-only)" for the two database connectors only | ✅ | `specs/18-db-collection.spec.ts` |
| Connector metrics are **not services**: no `service`, never in the Services inventory or dashboards; labelled `nexus.source=connector`, `db.system`, `nexus.connection.id/name`, `server.address` | ✅ | sink test, worker test, spec 18 |

Limits: at most 500 series per connection (extras dropped and shown on the card); renaming a connection starts new series; editing an active connection's settings clears its selection and stops collection (stated in the UI); counter restarts are detected only by the value decreasing.
**Not verified:** real multi-member replica-set lag (synthetic data only), collection on Atlas (never run; shared tiers may refuse some commands), MongoDB versions other than 8.2.6, Redis 6+ ACL/TLS/replicas/cluster, sharded clusters, load. Docs: [integrations/db-collection.md](integrations/db-collection.md).
Also in this slice: a `mongodb+srv://` connection-string box in the wizard (browser-side parser, DNS-only SRV endpoint that never receives credentials; `mongo-uri.test.ts`, `mongodb-srv.test.ts`, API tests, `specs/16`).

## Phase 5 follow-ups: failure injection and multi-member replica sets ✅ (2026-11-02)
Verified against a **real 3-member authenticated MongoDB 8.2.6 replica set** (`mongodb-memory-server`) and **real Redis 5.0.14**; fake servers only where stated. Twelve defects were found and fixed, each with a regression test (details and the observed failure behaviour table: [integrations/db-collection.md](integrations/db-collection.md), [runbooks/db-collection-failures.md](runbooks/db-collection-failures.md)):
* Replica-set members were sampled one after another (one silent member could use the whole 30 s deadline): now concurrent with a per-member budget.
* A cancel or timeout discarded everything already gathered: partial results are now returned with a note.
* Replication lag used whole-second `optimeDate` (6 s shown where the real gap was 60 ms) and was computed against a down primary: now `lastAppliedWallTime`; a measured 3.4 s delayed member showed 3.4 s against 3.6 s from the primary's view.
* Redis had no run budget or reply-size cap; `ECONNRESET`/maxclients were reported as "not reachable"; NOPERM carried no remediation.
* Worker/service: a stalled worker whose lease had been taken over still wrote readings; the lease was shorter than the test + collection deadlines; a connector ignoring its abort signal held a worker slot forever; the 500-series cap was trusted to connectors; a degraded check (one member down) stopped collection and backed off; shutdown left leases held; back-off fell below the interval above 15 min and jitter piled up at the ceiling.
Verified on real servers: all members collected, secondary-only collection, collection through a primary step-down, killed primary and secondary, wrong password, permission denied, silent and blackholed members, Redis byte-offset cuts, SIGKILL and restart, slow INFO, auth, a real `maxclients` limit. Tests: connector-sdk 33, connections 53, connectors 132 (+16 in `pnpm --filter @nexus/connectors test:resilience`, re-run by the supervisor), worker 28.
**Still not verified:** Redis 6+ ACLs (a RESP fake covers NOPERM), TLS Redis (a `node:tls` endpoint was used), Atlas, sharded clusters, more than 3 members, real network partitions, sustained load, `/readyz` and signal handling in `main.ts`; the Windows Redis 5.0.14 build only resets the connection at `maxclients`, so that classification is covered by a fake.

## Metric rollups ✅ (2026-11-02, [ADR-0007](architecture/ADR-0007-metric-rollups.md))
* One new collection `metric_rollups` holds 5-minute and 1-hour tiers (+3 indexes, migration v30); histogram buckets are summed exactly. The write path only adds `$min: {rollFrom}` inside the existing series update. A **compactor in the worker** recomputes buckets from the first changed minute; the query planner trusts a rollup only below `min(watermark, earliest pending marker)` per series, so late data or a stopped worker can only make a query slower, never wrong. Backfill is idempotent and resumable.
* **Tests:** `rollup.test.ts` has four seeded randomized oracle scenarios (about 200 queries each) comparing every query type through rollups against minute documents; metricstore 92 tests (re-run by the supervisor). Removing the invalidation logic makes the oracle fail.
* **Results:** 3 h HTTP overview p95 375 ms (supervisor run, same-process A/B: minute-only p50 713 ms against 275 ms with rollups) against the < 1 s target: **met**. 24 h / 7 d queries over all 600 series, previously refused by the scan guard or timing out, took about 0.2–1.0 s in the rollup author's runs (not re-run by the supervisor). Backfill of 6.05 M minute documents took 369–411 s (84 MiB of rollups). Metric ingestion is unchanged by rollups (marker/no-marker ratio 0.968, within noise) and **still misses its target**.
* **Product change:** automatic steps now round up to 5 min (was 3) and 1 h (was 25 min), so the overview timeline for windows over 90 minutes has about 48 points.
* **Limits:** steps of 1–2 min, the last 2–7 minutes and unaligned window edges still read minute documents; rollups need the worker running; a bucket can hold up to one bucket-length of data whose minute documents already expired; the 20,000-series / 7 d case is extrapolated; older-than-1 h benchmark data is cloned, not ingested; the compactor costs up to about 19% of ingest speed at a 2 s cadence (worst case; the 30 s default was not measured separately). Benchmarks were taken while other agents were running.

## Alerting and incidents 🟡 first slice (2026-11-02, [ADR-0006](architecture/ADR-0006-alerting-incidents.md), [alerting.md](alerting.md), [runbook](runbooks/alerting.md))
* **Built:** project-scoped metric-threshold and log-count rules; leased worker evaluation with a state machine (ok → pending → firing → resolved), for-duration, resolve hysteresis, no-data policy, per-rule time budget; incidents with a bounded timeline and ack/resolve/comment; **webhook channels** (Slack and e-mail were added in Phase 6, below) (HMAC-signed, secret and URL path stored encrypted and write-only, SSRF protection incl. DNS-rebinding and no redirects, retries with backoff, per-channel rate limit, delivery log, test-send); silences; API, UI pages (Alert rules, Incidents, Channels & silences) and `specs/19-alerting.spec.ts`.
* **Tests:** 181 in `packages/alerting` (7 files) plus 17 API tests covering RBAC (viewers read-only), tenant isolation (another project's rules, incidents and channels are 404 and immutable), secret write-only behaviour, SSRF and a real signed webhook through the real stack.
* **Capacity (measured on one laptop, `docs/performance-alerting.json`):** 92.9 rules/s per worker at the default concurrency of 4, roughly 5,500 rules at a 60 s interval. 3 new collections: with rollups, Nexus now declares 26 collections + `schema_migrations` = 27 of the Atlas free tier's 500.
* **Not built:** Teams, PagerDuty/Opsgenie, anomaly detection, escalation policies, on-call schedules, multi-condition rules, percentile aggregations, cross-project rules, webhook templating, SLO/burn-rate alerts, exactly-once delivery, cron/monthly maintenance schedules.

### Phase 6 alerting depth 🟡 (2026-11-04; verified with in-process fakes and the real local stack, never against a real Slack workspace or mail provider)
* **Slack and e-mail channels** ([ADR-0008](architecture/ADR-0008-notification-channels.md)): Slack incoming webhook (Block Kit, encrypted write-only URL); e-mail over SMTP with an in-house minimal client (implicit TLS or required STARTTLS, certificate checks always on, max 20 recipients, CR/LF refused, HTML escaped), SSRF guard on both. Also fixed: a PATCH on a channel used to reset its rate limit to 20/min.
* **Rule preview and incident links** ([ADR-0009](architecture/ADR-0009-rule-preview-and-incident-links.md)): read-only preview replays a draft rule over up to 24 h through the real evaluator and state machine (bounded: 200 points, 400 queries, 15 s, 2 concurrent per process); "Related telemetry" panel on incidents (log/metric links and up to 5 sample traces, "not proof of cause"). Wide group-by over 24 h is the slow case (7 s of the 15 s budget, local database).
* **Recurring maintenance windows and missed-evaluation replay** ([ADR-0010](architecture/ADR-0010-maintenance-windows-and-replay.md)): weekly windows in an IANA timezone (DST tested), notifications suppressed while incidents are still recorded; per-rule `missedPolicy` skip (default) or replay (bounded catch-up, stale notices not sent). Known gaps: the catch-up notice is not crash-safe, and two concurrent creates at the 20-window limit can overshoot by one.
* **Gate on the combined Phase 6 code (supervisor run, 2026-11-04):** `pnpm typecheck` exit 0; `pnpm test` exit 0 (1,557 tests passed; the Collector relay test is skipped without `OTELCOL_BIN`); `pnpm build` exit 0; `check-container-files` 250/250; `prod-smoke` 15/15; secret scan (tree) no findings; infra tests 20/20; **full Playwright suite 144 passed, 0 failed, 0 skipped** (specs 00–22). Docker, nginx and GitHub Actions remain unrun.

## CI and credential hygiene 🟡 written, not yet run (2026-11-02)
* `.github/workflows/ci.yml` (typecheck, tests, builds, container static check, production smoke, secret scan, Docker image builds for every target with image-content checks, compose smoke with `nginx -t`), `oidc-staging.yml` (manual, real identity provider), Dependabot, gitleaks config; `infra/scripts/scan-secrets.mjs` (offline, works on the tree and on history; 20 infra tests pass), `docs/runbooks/credential-rotation.md`, `docs/runbooks/release-process.md`. **None of the GitHub Actions, Docker or nginx steps has ever run**; expect tuning on the first run.
* **The secret-scan job is red by design** until the Atlas password in the first commit (already on `origin/main`) is rotated and purged from history; the scanner reports exactly that one value (two locations, commit `7629819`).
* The OIDC staging script was only tested against a local fake provider.

## Final gate on the combined code (2026-11-02, supervisor-run)
| Command | Result |
|---|---|
| `pnpm typecheck` | clean (exit 0) |
| `pnpm test` (one package at a time) | exit 0, **1,149 tests passed** (1 skipped: the Collector relay test needs `OTELCOL_BIN`) |
| `pnpm build` | exit 0 |
| `node infra/scripts/check-container-files.mjs` | **250/250** static checks |
| `node infra/scripts/scan-secrets.mjs --tree` / `--history` | tree: no findings; history: only the known Atlas password |
| `OTELCOL_BIN=<otelcol-contrib> pnpm e2e` (specs 00–19, real Collector) | **110 passed, 1 failed** (8.5 min): the stale assertion in `02-projects` that `/incidents` and `/alerts` are "not implemented" (they now exist). The spec and a leftover placeholder entry were fixed; `02-projects` re-run **9/9**. The full suite was not re-run end to end after that fix. |

## Deployments (change markers) 🟡 first slice (2026-11-04, [ADR-0011](architecture/ADR-0011-deployments.md), [deployments.md](deployments.md))
* **Built:** a `deployments` collection (migration 32; 28 of the Atlas 500 declared) inside `packages/ingest/src/deployments/` (no new package; justification in the ADR); `POST /api/v1/deployments` written by CI with an **ingestion token carrying the new opt-in `deployments` scope** (tenant and environment from the token; a payload naming them is refused) or by an engineer / project admin session (CSRF, origin, grant, environment scope); idempotent on a key with forward-only status progress; validation (https-only links, length caps, control characters refused, notes credential-scrubbed); 30 writes/min per credential and 2,000 per environment per day; audit; read APIs (list, one, chart markers, incident correlation) for viewer and up, environment-scoped; the **Deployments page** (filters, table, details drawer, CI snippets); **change markers** (focusable, tooltip, text list) on the Metrics explorer and the service dashboard; **deployment entries on the incident timeline** (same service and environment, within 30 minutes before the incident opened, worded "correlation, not proof of cause").
* **Tests:** 36 store/unit tests (`packages/ingest`), 49 API tests, 2 ingestion-service tests, policy and migration tests, web model tests, and `tests/e2e/specs/22-deployments.spec.ts` (11, with axe in both themes). `specs/02` was updated: `/deployments` is a real page.
* **Not built:** hand-entry form, edit/delete, GitHub/GitLab/Argo webhooks, DORA metrics, markers on the Logs and trace views, deployment-aware alert rules, any claim of cause.

## Next recommended phase
1. **You, before relying on this beyond local development:** rotate both Atlas passwords, purge the committed one from history ([credential-rotation.md](runbooks/credential-rotation.md)), push, and let CI run for the first time (Docker builds, compose smoke, `nginx -t`, secret scan); run the staging sign-in against the real identity provider ([runbook](runbooks/oidc-staging-verification.md)).
2. **Phase 6 is built** (channels, previews, links, maintenance windows, replay, deployments; see above). What remains is real-world verification: send a real Slack message and a real e-mail through your own provider, and run one deployment POST from a real CI job.
3. **Phase 6b: raise the remaining performance target.** Metric ingestion still misses 5,000 points/s (4.7k in the latest runs). Round 2 showed that batching is the lever (4,971/s with 2 intervals per request, 7,751/s with 6), so measure the compactor at the production cadence, then decide between sender batching guidance, a bulk write path, or moving metrics to a columnar store (ClickHouse behind `MetricStore`, ADR-0005). Add span-statistics rollups if the 24 h trace statistics matter.
4. **Real-world verification you can approve:** a real Atlas run via the `nexus_verify` procedure in [runbooks/atlas.md](runbooks/atlas.md) (it writes; needs your approval); Redis 6+ ACL/TLS; load and partition tests for database collection.
5. Later: dependency map page, cloud/host collectors (AWS, Azure, GCP, Kubernetes, hosts), dashboards, AI module, on-demand telemetry deletion, retention UI.

## Not started (later phases)
Dependency map page, cloud/host metric collectors (AWS, Azure, GCP, Kubernetes, hosts), notification channels beyond webhooks, dashboards, AI module,
retention policies UI, on-demand telemetry deletion, sustained-load and network-partition suites, Kubernetes/Terraform (Docker files exist but are unverified).

## Known limitations / follow-ups
* MongoDB is not a columnar store; filtered histograms/facets and any search without an index prefix are linear in matching records (see performance doc). The same applies to spans and metrics: span statistics, dependency discovery and metric aggregates scan a time range ([performance-traces-metrics.md](performance-traces-metrics.md)). ClickHouse is the documented upgrade path.
* Credentials must never be committed: `.env` is gitignored, `.env.example` holds placeholders only (see the Phase 4 security findings about a credential that had been committed).
* Ingest rate limits are per process. No durable queue in front of storage (senders retry on 429/503).
* Redaction is best-effort: it cannot recognise an arbitrary secret in arbitrary text.
* MongoDB driver re-resolves hostnames (residual SSRF window, needs egress rules). TLS paths are covered by logic, not by a live TLS endpoint.
* Audit immutability relies on the API plus the insert/find-only role in `docs/runbooks/mongodb-roles.md` (verified against a real mongod).
* `trustProxy` is off; configure it behind a load balancer before relying on per-IP limits.
* No Docker on the dev machine: images/compose/nginx were not built or run (see `docs/deployment.md`).
