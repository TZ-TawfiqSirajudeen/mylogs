# Integration capability matrix

> Generated from the connector registry (`pnpm --filter @nexus/connectors matrix`). Do not edit by hand.
> "implemented" means connection test, discovery and health reporting exist and are tested against a real or simulated target.
> Telemetry **collection** is a separate column. Pull connectors (HTTP health, MongoDB, Redis) only verify and monitor; they do not collect.
> Push sources (OTLP, JSON logs) deliver **logs** through authenticated ingestion tokens. "Last successful collection" and live
> health are per-connection runtime values shown in the UI, not static facts.

| Connector | Status | Collection | Signals | Deployment types | Auth (★ recommended) | Required permissions | Operations | Known limitations |
|---|---|---|---|---|---|---|---|---|
| Authenticated application health check (`http-health`) | **implemented** | not yet (health/discovery only) | metrics: supported<br>logs: unsupported<br>traces: unsupported<br>events: unsupported<br>inventory: unsupported | any HTTP(S) service reachable from the platform | Bearer token ★<br>Custom header<br>No authentication | Read access to the health endpoint only | GET/HEAD probe, status check, latency measurement | Redirects are never followed<br>Response bodies are not stored<br>Probes one URL per connection |
| MongoDB (`mongodb`) | **implemented** | implemented | metrics: supported<br>inventory: supported<br>logs: unsupported<br>traces: unsupported<br>events: unsupported | self-managed standalone, self-managed replica set (each member listed individually), MongoDB Atlas (direct member hostnames) | Username + password (SCRAM) ★<br>No authentication | clusterMonitor role | ping, buildInfo, hello, serverStatus, replSetGetStatus, listDatabases, dbStats, connectionStatus | Topology discovery is disabled: list every member you want monitored<br>Metrics are collected only for the members and databases you select, at most 500 series per connection (extra series are dropped and reported)<br>Counter restarts are detected by the value decreasing; a restart is missed only if the counter has already passed its old value<br>Memory comes from whatever the server version reports: mem.resident/virtual (MongoDB up to 8.1) or the allocator figures (8.x); a field the server does not return is not shown<br>Atlas shared tiers (M0/M2/M5) may refuse some commands (e.g. replSetGetStatus); those metrics are then skipped and noted, not invented<br>DNS is resolved by the driver at connect time; network egress rules are still required (see threat model T2)<br>Collection contents, the profiler and server logs are never read |
| Redis / Redis-compatible (`redis`) | **implemented** | implemented | metrics: supported<br>inventory: supported<br>logs: unsupported<br>traces: unsupported<br>events: requires_config | standalone, primary/replica (each node listed individually), managed Redis-compatible services (direct endpoint) | Password / ACL user ★<br>No authentication | +ping +info +slowlog|len +config|get +acl|whoami | PING, INFO, SLOWLOG LEN, CONFIG GET maxmemory*, ACL WHOAMI | Cluster topology is not discovered; connect to each node<br>No key scans, no key/value reads, ever<br>Metrics are collected only for the instance and logical databases you select, at most 500 series per connection<br>Counter restarts are detected by the value decreasing; a restart is missed only if the counter has already passed its old value<br>Hostnames are pinned to the validated IP; TLS verifies the certificate against the configured hostname |
| OpenTelemetry (OTLP/HTTP) logs (`otlp`) | **implemented** | push (ingestion token) | logs: supported<br>traces: supported<br>metrics: supported<br>events: unsupported<br>inventory: unsupported | any OpenTelemetry SDK, OpenTelemetry Collector (otlphttp exporter) | Ingestion token (per environment) ★ | Project admin to create the token | POST /v1/logs, POST /v1/traces, POST /v1/metrics | Tokens created before traces and metrics existed carry the logs scope only: create a new token to send other signals<br>OTLP/gRPC is not supported (HTTP only); send gRPC to an OpenTelemetry Collector that exports with otlphttp<br>4 MiB body, 5 000 records per request, 32 KiB per message<br>Verified live with the OTel JS SDK and a real otelcol-contrib v0.164.0 (see docs/runbooks/collector.md); Docker images and a real identity provider are unverified |
| Generic JSON / NDJSON logs (`json-logs`) | **implemented** | push (ingestion token) | logs: supported<br>traces: unsupported<br>metrics: unsupported<br>events: unsupported<br>inventory: unsupported | any application or log shipper that can POST JSON | Ingestion token (per environment) ★ | Project admin to create the token | POST /v1/json-logs | Field mapping is by convention: unknown field names are kept as attributes, not interpreted<br>Syslog and file shippers need a collector in front (planned connectors) |
| AWS CloudWatch (logs + metrics) and resource discovery (`aws-cloudwatch`) | **planned** | not yet (health/discovery only) | logs: planned<br>metrics: planned<br>traces: unsupported<br>events: unsupported<br>inventory: planned | AWS accounts (cross-account role) | Cross-account IAM role + external ID ★<br>Access key (discouraged) | cloudwatch:GetMetricData, cloudwatch:ListMetrics, logs:FilterLogEvents, logs:DescribeLogGroups, tag:GetResources | — | Not implemented (planned for phase 5). Cannot be connected yet. |
| Azure Monitor and Application Insights (`azure-monitor`) | **planned** | not yet (health/discovery only) | logs: planned<br>metrics: planned<br>traces: planned<br>events: unsupported<br>inventory: planned | Azure subscriptions | Managed identity ★<br>Application identity (client secret/certificate) | Monitoring Reader / Log Analytics Reader | — | Not implemented (planned for phase 5). Cannot be connected yet. |
| Google Cloud Logging and Monitoring (`gcp-logging`) | **planned** | not yet (health/discovery only) | logs: planned<br>metrics: planned<br>traces: unsupported<br>events: unsupported<br>inventory: planned | GCP projects | Workload identity federation ★ | — | — | Not implemented (planned for phase 5). Cannot be connected yet. |
| PostgreSQL (`postgresql`) | **planned** | not yet (health/discovery only) | logs: unsupported<br>metrics: planned<br>traces: unsupported<br>events: unsupported<br>inventory: planned | self-managed, managed services | Dedicated read-only role (pg_monitor) ★ | — | — | Not implemented (planned for phase 5). Cannot be connected yet. |
| MySQL (`mysql`) | **planned** | not yet (health/discovery only) | logs: unsupported<br>metrics: planned<br>traces: unsupported<br>events: unsupported<br>inventory: planned | self-managed, managed services | Dedicated monitoring user ★ | — | — | Not implemented (planned for phase 5). Cannot be connected yet. |
| Docker containers (`docker`) | **planned** | not yet (health/discovery only) | logs: planned<br>metrics: planned<br>traces: unsupported<br>events: planned<br>inventory: planned | hosts running the Nexus agent | Customer-deployed agent (outbound connection) ★ | — | — | Not implemented (planned for phase 5). Cannot be connected yet. |
| Kubernetes clusters (`kubernetes`) | **planned** | not yet (health/discovery only) | logs: planned<br>metrics: planned<br>traces: unsupported<br>events: planned<br>inventory: planned | clusters running the Nexus collector | Narrowly scoped service account ★ | — | — | Not implemented (planned for phase 5). Cannot be connected yet. |
| Linux hosts (`linux-host`) | **planned** | not yet (health/discovery only) | logs: planned<br>metrics: planned<br>traces: unsupported<br>events: unsupported<br>inventory: planned | hosts running the Nexus agent | Customer-deployed agent (outbound connection) ★ | — | — | Not implemented (planned for phase 5). Cannot be connected yet. |
| Windows hosts (`windows-host`) | **planned** | not yet (health/discovery only) | logs: planned<br>metrics: planned<br>traces: unsupported<br>events: unsupported<br>inventory: planned | hosts running the Nexus agent | Customer-deployed agent (outbound connection) ★ | — | — | Not implemented (planned for phase 5). Cannot be connected yet. |
| Nginx access/error logs (`nginx-logs`) | **planned** | not yet (health/discovery only) | logs: planned<br>metrics: unsupported<br>traces: unsupported<br>events: unsupported<br>inventory: unsupported | via log-shipping agent | Authenticated ingestion token ★ | — | — | Not implemented (planned for phase 3). Cannot be connected yet. |
| Syslog / log shippers (`syslog`) | **planned** | not yet (health/discovery only) | logs: planned<br>metrics: unsupported<br>traces: unsupported<br>events: unsupported<br>inventory: unsupported | via collector | Authenticated ingestion token ★ | — | — | Not implemented (planned for phase 3). Cannot be connected yet. |

## Authenticated application health check: least-privilege setup

```
Create a token that can only call the health endpoint (for example, scope "health:read") and rotate it regularly.
```

**Required permissions**

- `Read access to the health endpoint only` (target application): The probe issues GET/HEAD requests and never sends a body.

**Known limitations**

- Redirects are never followed
- Response bodies are not stored
- Probes one URL per connection

## MongoDB: least-privilege setup

```
Create a dedicated monitoring user (run in mongosh as an admin):

  use admin
  db.createUser({ user: "nexus_monitor", pwd: passwordPrompt(), roles: [ { role: "clusterMonitor", db: "admin" } ] })

clusterMonitor grants read-only monitoring commands. It does NOT allow reading any collection.
```

**Required permissions**

- `clusterMonitor role` (admin): Allows ping, buildInfo, hello, serverStatus, replSetGetStatus, listDatabases and dbStats — and nothing that reads documents.
- `profile / system.profile read` (any) — optional: Slow-operation evidence needs the profiler (not used by this connector).

**Known limitations**

- Topology discovery is disabled: list every member you want monitored
- Metrics are collected only for the members and databases you select, at most 500 series per connection (extra series are dropped and reported)
- Counter restarts are detected by the value decreasing; a restart is missed only if the counter has already passed its old value
- Memory comes from whatever the server version reports: mem.resident/virtual (MongoDB up to 8.1) or the allocator figures (8.x); a field the server does not return is not shown
- Atlas shared tiers (M0/M2/M5) may refuse some commands (e.g. replSetGetStatus); those metrics are then skipped and noted, not invented
- DNS is resolved by the driver at connect time; network egress rules are still required (see threat model T2)
- Collection contents, the profiler and server logs are never read

## Redis / Redis-compatible: least-privilege setup

```
Redis 6+ — create a monitoring user that cannot touch data:

  ACL SETUSER nexus_monitor on >CHANGE_ME resetkeys -@all +ping +info +slowlog|len +config|get +acl|whoami

Older Redis only has the shared password (requirepass); prefer upgrading or placing the instance behind a private agent.
```

**Required permissions**

- `+ping +info +slowlog|len +config|get +acl|whoami` (ACL): The only commands the connector issues. No key access (~*) is needed.

**Known limitations**

- Cluster topology is not discovered; connect to each node
- No key scans, no key/value reads, ever
- Metrics are collected only for the instance and logical databases you select, at most 500 series per connection
- Counter restarts are detected by the value decreasing; a restart is missed only if the counter has already passed its old value
- Hostnames are pinned to the validated IP; TLS verifies the certificate against the configured hostname
