# ADR-0001: Foundation architecture and stack decisions

Status: accepted · Date: 2026-10-28

## Context
Greenfield repository. Goal: a multi-tenant observability console (control plane + telemetry data plane).
Dev machine constraints discovered: Node 22, pnpm 10, **no Docker, no PostgreSQL, no ClickHouse**.

## Decisions

| # | Decision | Why / consequences |
|---|----------|--------------------|
| 1 | **MongoDB for control-plane metadata** (user decision; replaces the PostgreSQL in the original brief) | Orgs, users, projects, environments, sessions, audit. Requires a **replica set** (multi-document transactions are used for project create / env delete / membership + audit atomicity). No FKs or DB-trigger immutability: tenant integrity is enforced by always filtering on `orgId` in the service layer (tested by cross-tenant IDOR tests); audit append-only-ness is enforced by the API exposing insert/read only, plus a recommended insert/find-only MongoDB role for the API user. |
| 2 | UUID strings as `_id` | Stable, opaque, DTO-friendly; no ObjectId leakage in URLs. |
| 3 | Fastify + Zod (v4) + `fastify-type-provider-zod` | One schema = runtime validation + response serialization + OpenAPI (`/docs`, non-production only). Schemas live in `@nexus/contracts` and are shared with the web app. |
| 4 | Server-side cookie sessions | Opaque 256-bit token in an HttpOnly, SameSite=Lax cookie (`__Host-` prefixed + Secure in production); only SHA-256 stored; idle + absolute expiry; revocation takes effect on the next request; user/membership re-checked per request. |
| 5 | CSRF: Origin allow-list + per-session synchronizer token (`x-csrf-token`) | Token is kept in memory in the SPA, never in web storage. |
| 6 | Authorization as pure policy functions (`authz/policy.ts`) | Routes never compare roles. Inaccessible projects return **404**, not 403, to prevent id probing. Auditor deliberately has no project/telemetry access. |
| 7 | Auth modes: `dev` (passwordless seeded demo users) and `oidc` (implemented later: see ADR-0004) | `loadConfig()` refuses `AUTH_MODE=dev`, insecure cookies and non-https origins when `NODE_ENV=production`. |
| 8 | Workspace packages ship TypeScript source | API is bundled with `tsup` (`noExternal: @nexus/*`). |
| 9 | Dev/test MongoDB via `mongodb-memory-server` replica set | No Docker needed. Tests run against a real `mongod`, not mocks. |
| 10 | Telemetry plane (ClickHouse + OTel Collector + VictoriaMetrics) | **Unchanged from brief; not started.** To be revisited in phase 3 — the user may want MongoDB there too; ClickHouse remains the recommendation for log/trace search at volume. |

## Security notes (threat-model seed; full model due before phase 2)
- Secrets: nothing secret is stored yet. `redactSecrets()` (key- and URL-credential-based) already runs on every audit payload and is the shared primitive for future telemetry redaction.
- Config validation errors report variable *names* only (the Mongo URI contains credentials).
- Rate limiting: global + stricter on auth endpoints. Request ids are accepted from clients only if they match a conservative pattern.
- Known gaps: see `docs/STATUS.md`.

## Rollback
Migrations are versioned modules (`packages/database/src/migrations.ts`) with a `down()` each; `migrateDownOne()` reverts the latest. A lock document prevents concurrent runners.
