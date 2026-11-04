# Deployments (change markers)

Decision record: [ADR-0011](architecture/ADR-0011-deployments.md). This page is the reference: what is recorded, how CI writes it, who can read it, where it shows up, and what it does **not** claim.

A deployment is a fact reported by your CI: *service X version Y reached environment Z at time T with this outcome*. Nexus stores it and shows it as a **marker** on the metric charts and as **context** on an incident. Nexus never starts, approves, gates or rolls back a deployment, and it never says that a deployment *caused* anything: a marker is a coincidence in time.

## What is stored
| Field | Rules |
|---|---|
| organization, project, environment | **From the credential, never the payload.** An ingestion token is bound to one environment; a session write names the project and environment and is authorized against the caller's grant. |
| `service` | 1–128 characters, no control characters. Compared by exact equality with the telemetry `service.name`, so use the same string. |
| `version` | 1–128 characters, no control characters (a tag, a semantic version, a build number: free text). |
| `commitSha` | optional, 7–64 hexadecimal characters, stored lower-case |
| `status` | `started`, `succeeded`, `failed`, `rolled_back` |
| `startedAt`, `finishedAt` | ISO 8601 date-times. `startedAt` defaults to now, must be within the last 90 days and at most 5 minutes ahead; `finishedAt` must not precede `startedAt` and is **not allowed** with `started`; for a finished status it defaults to now |
| `notes` | optional, up to 1,000 characters of plain text (newline and tab allowed, other control characters refused). **Credential-shaped text is scrubbed** (`password=…`, bearer tokens, vendor token formats) before storage; the scrubber is best-effort, so do not put secrets in notes |
| `linkUrl` | optional, **https only**, up to 2,000 characters, no user-info, no whitespace. Never fetched by Nexus; the UI shows it as a link that opens in a new tab with `rel="noopener noreferrer nofollow"` |
| `triggeredBy` | optional label of who/what triggered it in CI (up to 100 characters). It is a *label the sender chose*; it is shown as such |
| `idempotencyKey` | optional, up to 128 characters of letters, digits and `. _ : @ / -` |
| actor | **server-derived**: the ingestion token (by name) or the signed-in user (by display name) |

Records expire 365 days after `startedAt` (TTL index). There is no edit or delete API: status can only move forward (below), and wrong records age out.

## Recording a deployment: `POST /api/v1/deployments`
Two ways to authenticate, never mixed:

1. **CI: an ingestion token with the `deployments` scope** (`Authorization: Bearer nxi_…` or `X-Nexus-Token`). Create it as a project admin under *Data Sources → Ingestion* and tick “deployments” (it is **off by default**; tokens created before this feature are not widened; the same token can also carry telemetry scopes). The token decides the project and environment: create one per environment. A body that names `projectId`, `environmentId` or any other unknown field is refused with 400 (`scope_in_payload` for the first two) rather than ignored. No cookie, CSRF token or `Origin` header is needed, and a presented token **never falls back to a cookie**.
2. **A signed-in engineer or project admin** (cookie + CSRF token + origin check, like every other state change). The body must carry `projectId` and `environmentId`; the caller needs the engineer or project-admin role on the project and access to that environment (a restricted user writing to an environment outside their grant gets 404). Viewers get 403.

```bash
curl --fail-with-body -sS -X POST "https://nexus.example.com/api/v1/deployments" \
  -H "Authorization: Bearer $NEXUS_DEPLOY_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: build-1234-checkout" \
  -d '{"service":"checkout","version":"1.4.2","commitSha":"9fe8544","status":"succeeded","linkUrl":"https://ci.example.com/runs/1234","triggeredBy":"ci"}'
```
The Deployments page shows this snippet and a GitHub Actions step (a ready-to-copy `if: always()` step that maps `job.status` to `succeeded`/`failed` and uses `run_id` + `run_attempt` in the key, so a re-run is a new attempt, not a conflict).

### Idempotency and status progress
The key may be in the body (`idempotencyKey`) or the `Idempotency-Key` header (if both are present they must be equal). Keys are unique **per environment**.

| Situation | Answer |
|---|---|
| first write | `201` `{ "outcome": "created", "deployment": … }` |
| same key, same service/version (and commit, when sent), same status | `200` `outcome: "unchanged"` (nothing is written or audited; a changed `startedAt` on a retry is ignored) |
| same key, a legal progress | `200` `outcome: "updated"` |
| same key, different service, version or commit | `409` `idempotency_conflict` (never an overwrite) |
| same key, an illegal move | `409` `invalid_transition` |

Legal moves: `started` → `succeeded` / `failed` / `rolled_back`; `succeeded` and `failed` → `rolled_back`; nothing leaves `rolled_back`. Concurrent requests with one key create exactly one record (a unique partial index decides; the loser takes the replay path); concurrent identical updates apply once.
Without a key nothing is de-duplicated: every request is a new deployment.

### Errors
| Status | `error.code` | Meaning |
|---|---|---|
| 400 | `validation_error`, `invalid_time`, `scope_in_payload`, `scope_required`, `invalid_link` | field-level details are in `error.details` |
| 401 | `unauthenticated` | no credential, or an unknown, malformed or revoked token (identical answers; failed attempts are throttled per address) |
| 403 | `forbidden_scope` | the token has no `deployments` scope (telemetry-only token) |
| 403 | `forbidden` | a session without the engineer / project-admin role, or a missing CSRF token / wrong origin |
| 404 | `not_found` | project or environment not accessible (indistinguishable from not existing) |
| 409 | `idempotency_conflict`, `invalid_transition` | see above |
| 413 | | body over 16 KiB (refused before parsing) |
| 429 | `rate_limited` | more than 30 writes per minute for one credential (`Retry-After` is set); also failed-authentication throttling |
| 429 | `environment_limit` | more than 2,000 deployments started in the last 24 hours in this environment |

## Reading (session only; viewer and up)
An ingestion token never authenticates these routes. All of them are scoped to the **environments the caller may read**; anything in another environment, project or organization is a 404.

| Route | Purpose |
|---|---|
| `GET /api/v1/projects/:projectId/deployments` | list, newest first. Filters: `environmentId`, `service`, `status`, `from`, `to`; `limit` (≤ 100) and keyset `cursor` |
| `GET /api/v1/projects/:projectId/deployments/:deploymentId` | one deployment |
| `GET /api/v1/projects/:projectId/deployments/markers?from&to[&service][&environmentId]` | chart markers: window ≤ 31 days, **at most 200** (the newest; `truncated: true` says so), oldest first, no notes or links |
| `GET /api/v1/projects/:projectId/incidents/:incidentId/deployments` | the incident correlation (below) |

## Where it shows up
* **Deployments page** (`/deployments`): table (started, service, version, status with glyph, environment, commit, who recorded it, duration), filters by service, status, environment and time (URL-synced, shareable), details drawer (also by `?id=`; Escape closes it), and the CI snippets (open by default when nothing has been recorded). Every sender-controlled value is rendered as a text node: markup, Markdown and URLs inside notes stay literal text.
* **Change markers** on the **Metrics explorer** and on the **service dashboard** charts (per environment). Each is a vertical line with a handle, a real focusable control (`role="button"`, Tab to reach, Enter opens the deployment, Escape hides the tooltip) with an accessible name and a tooltip: *service version — status — time (environment)*. Status is also a glyph (✓ succeeded, ✕ failed, ↺ rolled back, ▶ started) and a line style, and **every chart lists its markers as text** under the chart. Markers sit in a separate SVG layer from the chart image, because focusable controls inside an `img` role are an accessibility defect. If the marker request fails the charts are unchanged and a note says markers could not be loaded. Many markers close together overlap on the line; the text list is the reliable way to read them.
* **Incident timeline**: for an incident, deployments of the service it is about, in its environment, that **started no later than the incident opened and ended (or, if unfinished, started) at most 30 minutes before it**. The service comes from the rule (the metric rule's `service`, a log rule's `services`) and the incident group's `service` label; a rule that names no service gets no deployments (the correlation is empty rather than guessed). Each entry reads *“Deployed shortly before; correlation, not proof of cause.”*, shows the distance in minutes, and links to the deployment. Nothing is created, linked back or changed on the incident.

## Security notes
* A `deployments` token can only add deployment records to **one environment**; it reads nothing and sends no telemetry. Leaking one allows **false markers** (rate limited to 30/min, 2,000/day/environment, attributable to the token by name, audited, expiring after a year, revocable in *Ingestion*). Treat it as a CI secret.
* Audit: `deployment.recorded` and `deployment.updated` (actor: the user, or a system event carrying the token id and name as `senderId`/`senderName`). Notes and links are never copied into the audit trail.
* The server never fetches `linkUrl` (no SSRF surface). Only `https:` is accepted; the UI re-checks before rendering a link.
* `linkUrl` may contain a query string with credentials if a sender puts one there; Nexus cannot know. Do not.
* Rate limits are in memory per API process (like the ingestion limits): with several replicas the effective limit is replicas × limit.

## Storage
One collection, `deployments` (migration **32**). Nexus now declares 27 collections + `schema_migrations` = **28 of the Atlas free tier's 500** (it was 27 before this change; collections that other work streams add are not counted here). Indexes: `dep_scope_started`, `dep_scope_service_started`, `dep_idem_uq` (unique partial), `dep_ttl`. Rollback drops them. Add `deployments` to the MongoDB role in [runbooks/mongodb-roles.md](runbooks/mongodb-roles.md) (a test compares the runbook to the code).

## Tests
* `packages/ingest/src/deployments/deployments.test.ts` (36): contract validation (lengths, control characters, https-only links, hex commits), the status transition table, creation, idempotency (replay, progress, conflicts, tenant and environment separation, concurrent first writes and concurrent updates), the per-environment cap, audit content, list filters and keyset paging, tenant and environment isolation, markers (cap, scoping), query plans (index use, no in-memory sort), the correlation window at its boundaries.
* `apps/api/test/deployments.test.ts` (49): token scope opt-in, 401/403 behaviour, no cookie fallback, tokens cannot read, tenant/environment from the token, idempotency over HTTP, validation and XSS strings, body limit, rate limit, session writes (RBAC, CSRF, origin, grants), reads (restricted users, other tenants), incident correlation. `apps/ingest/test/deployments-scope.test.ts`: a deployments token cannot send telemetry. `apps/api/src/authz/policy.test.ts`: the role matrix. `packages/database/src/migrations.test.ts`: migration 32 up/down.
* Web: `apps/web/src/chart-markers.test.ts` (marker positions, labels), `apps/web/src/pages/deployments/model.test.ts` (filters, links, CI snippets validated against the API contract).
* Browser: `tests/e2e/specs/22-deployments.spec.ts` (11): CI writes over HTTP, list/filter/drawer, hostile text, markers on the Metrics explorer and the service dashboard (keyboard, tooltip, failure of the marker request), the incident timeline, RBAC and environment scoping, another organization, the Ingestion scope checkbox, axe (WCAG A/AA) in both themes with the drawer, markers and the incident, no horizontal scroll at 375 px. `specs/02` now expects `/deployments` to be a real page.

## Not built
Triggering or rolling back deployments · webhooks from GitHub/GitLab/Argo/Flux (CI calls the API) · a form to record a deployment by hand · editing or deleting a deployment · detecting deployments from `service.version` changes · DORA metrics (frequency, lead time, change failure rate) · markers on the Logs histogram and trace views · deployment-aware alert rules · any claim of cause · per-token retention · rate limits shared across API replicas.
