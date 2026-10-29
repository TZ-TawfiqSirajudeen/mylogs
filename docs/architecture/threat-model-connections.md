# Threat model: source connections, credentials and outbound access (Phase 2)

Scope: everything introduced by phase 2 — connection records, credential storage, connector execution (tests, discovery,
health checks) and the outbound network requests they cause. Telemetry ingestion/query (phase 3+) will extend this document.

## Assets
1. Customer credentials (DB passwords, API tokens, header secrets, later cloud keys/roles).
2. Tenant isolation: one org must never read, use or influence another org's connections or secrets.
3. Internal network reachability of the platform's own runtime (cloud metadata, internal admin APIs, the platform's own MongoDB).
4. Integrity of the audit trail and of connection health state (a spoofed "healthy" hides outages).

## Trust boundaries
Browser → API (TLS, cookie session + CSRF) → connection service → [secret store | connector runner] → **customer target** (untrusted network endpoint).
The customer-supplied target description (URL / host list) is **attacker-controlled input** that makes the platform open sockets.

## Threats and mitigations

| ID | Threat | Mitigation (status) |
|----|--------|---------------------|
| T1 | **SSRF**: user points a connection at `127.0.0.1`, `169.254.169.254`, RFC1918 hosts, internal DNS names, or the platform's own Mongo/Redis. | `packages/security` `resolveSafeTarget`: resolves DNS, rejects loopback / private / link-local / CGNAT / multicast / reserved / IPv4-mapped & 6to4/Teredo/NAT64 IPv6, shorthand-numeric hosts (`2130706433`, `0x7f.1`), known metadata names; **cloud-metadata addresses are hard-denied even if a CIDR allow-list contains them**; dangerous ports denied. Private ranges only via explicit `NETWORK_ALLOW_PRIVATE_CIDRS` (approved network path); loopback only when `NETWORK_ALLOW_LOOPBACK=true`, which config refuses in production. Re-validated on **every** test/health run, not just at save time. (implemented, unit-tested) |
| T2 | **DNS rebinding / TOCTOU** between validation and connect. | HTTP connector connects to the *validated IP* via a pinned `lookup` (SNI/Host preserved). MongoDB/Redis drivers resolve names themselves: we validate immediately before connecting; a residual window remains → **egress filtering at the network layer is required** (documented in deployment). (HTTP implemented+tested; driver residual risk documented) |
| T3 | **Redirect-based bypass**. | HTTP connector never follows redirects (3xx is a reported misconfiguration). (implemented, tested) |
| T4 | **Replica-set / topology discovery** makes a driver connect to hosts the user never listed. | MongoDB connector uses `directConnection` to each listed, validated host only. (implemented) |
| T5 | **Credential theft from storage** (DB dump, backup, export). | Envelope encryption: per-secret random 256-bit DEK, AES-256-GCM; DEK wrapped by a KEK (from platform secret manager / env, never in the DB). AAD binds ciphertext to `orgId|connectionId|secretName|version`, so rows cannot be swapped between tenants/connections. KEK rotation via keyring + `rewrap`. Local KEK refused in production unless explicitly provided. Backups contain ciphertext only. (implemented, tested). External KMS/Key Vault/Secrets Manager backends: **interface only, not implemented**. |
| T6 | **Credential leakage via API/logs/errors/audit/telemetry**. | Secrets are write-only: API responses expose only `{set, updatedAt}` per field. All error text from drivers/HTTP is passed through `redactSecrets` and also scrubbed of the exact secret values used in that run. Audit metadata is redacted before storage. Request logging redacts auth headers. (implemented, tested) |
| T7 | **Cross-tenant access** to connections/secrets (IDOR, wrong org in job). | Every connection query is scoped by `orgId` **and** project/environment access via `authz/policy`; inaccessible → 404. Secret decrypt requires the caller to present the connection's own `(orgId, connectionId)` — AAD mismatch fails closed. (implemented, tested) |
| T8 | **Privilege escalation**: engineers/viewers creating or rotating credentials. | `connection:manage` is project_admin-only; read of connection status needs `telemetry:read` and environment access. (implemented, tested) |
| T9 | **Resource exhaustion** via connection tests (slow targets, huge responses, many tests). | Per-run timeout + AbortSignal, response size cap, bounded concurrency in the monitor, per-route rate limit on test/discover, max connections per environment, capped stored error history. (implemented) |
| T10 | **Malicious target responses** (huge bodies, log-injection text, prototype-pollution JSON). | Bodies are size-capped and never evaluated; discovered strings are length-capped and treated as data; JSON is parsed into plain objects and re-validated with Zod before storage. (implemented) |
| T11 | **Destructive operations via connector** (writes, `FLUSHALL`, arbitrary shell). | Connectors are read-only by construction: Redis uses an allow-list wrapper (PING/INFO/SLOWLOG LEN/CONFIG GET of 2 keys/ACL WHOAMI), MongoDB uses an allow-list of admin commands, HTTP uses GET/HEAD. No arbitrary command execution connector exists. (implemented, tested) |
| T12 | **Stale/spoofed health** hiding outages. | State changes only from connector-run results; each snapshot stores timestamps and a bounded error history; "healthy" requires a successful run within 2× the check interval, otherwise reported as stale/degraded by the monitor. (implemented) |
| T13 | **Audit tampering / repudiation**. | Every create/test/discover/select/activate/rotate/disconnect/delete is audited with actor + request id, never secret values. Append-only by API design (+ recommended insert-only DB role). (implemented) |

## Residual risks / explicitly not solved in phase 2
- MongoDB/Redis DNS re-resolution window (T2) — mitigate with VPC egress rules.
- No private customer agent yet (needed for private-network targets without allow-listing CIDRs).
- Secrets exist as JS strings in process memory during a run; JavaScript cannot reliably zero memory. Keep runs short; no secret is cached across runs.
- No external KMS integration yet; the KEK is only as safe as the platform that injects it.
- Live verification against real cloud accounts is pending (no cloud connectors in this phase).
