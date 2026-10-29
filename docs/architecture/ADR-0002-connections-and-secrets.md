# ADR-0002: Source connections, secrets and the outbound network

Status: accepted · Date: 2026-10-28 · Builds on ADR-0001 · Threat model: `threat-model-connections.md`

| # | Decision | Why / consequences |
|---|----------|--------------------|
| 1 | Connections are **drafts first**: the wizard creates a server-side draft (credentials encrypted immediately), then test → discover → select → settings → activate. | The browser never holds credentials after submission and never needs them again; abandoned drafts are purged. |
| 2 | "Connected" = verified + health-monitored; **collection is a separate, explicit flag** (`collection: not_implemented`). | No fabricated lag/throughput; UI says "nothing is collected yet" until phase 3+. |
| 3 | One `Connector` contract + a **contract test kit** every connector must pass. | Leaking secrets, throwing for expected failures, ignoring cancellation, false collection claims are caught mechanically. |
| 4 | Connection **state is derived from the failure kind**; first-time auth failure = *misconfigured*, after a success = *authentication expired*. | Users see the right remediation; operators see real credential expiry. |
| 5 | SSRF guard is **re-run on every test and monitor run**; HTTP connects to pinned validated IPs; metadata addresses hard-denied even if a CIDR allows them. | Save-time validation alone is bypassable by DNS changes. |
| 6 | Connectors are **read-only by construction** with command allow-lists (Mongo admin commands, Redis commands). | Tested: `find`/`drop`/`FLUSHALL`/`KEYS`/`SCAN`… are refused before the wire. |
| 7 | MongoDB connector uses **directConnection per listed host** (no topology discovery); credentials as structured fields (no URI). | Prevents drivers from being steered to unlisted hosts and URI-option injection. |
| 8 | Secrets: envelope encryption with AAD binding; KEK injected by the platform; rotation by key-ring + rewrap. | Established primitives only (Node `crypto`, AES-256-GCM). External KMS backends are future work behind the same interface. |
| 9 | Worker scheduling uses **leases** on connection documents (claim = atomic `findOneAndUpdate`). | Horizontal scale without double-checking; crashed workers' leases expire. |
| 10 | Disconnect **deletes** credentials (revocation), delete removes everything; rotation revalidates immediately. | Least privilege over convenience. |
| 11 | `validateConfig(config, authMethod)`; secrets are never part of `ConnectionDoc` (separate collection). | The DTO builder cannot leak what the document does not contain. |

Rejected: storing credentials in the connection document (one query away from leaking); following redirects "for convenience"; allowing `directConnection=false` replica discovery in phase 2.
