# Database data collection (MongoDB and Redis connectors)

A MongoDB or Redis **data source** does more than check that the database is up: for the members, instance and databases you select in the
wizard it **samples read-only metrics on the polling interval** and stores them in the same metric store as application metrics, so they show up
on the **Metrics** page. This document says exactly what is read, what is stored, what permission is needed, and what has and has not been verified.

> Scope: pull connectors that declare `collection: 'implemented'` — today `mongodb` and `redis`. The application health check connector only
> verifies and monitors health. Planned connectors (AWS, Azure, Kubernetes, …) collect nothing and are not claimed to.

## How it works

1. In **Data Sources → Add data source** you choose MongoDB or Redis, connect, test, **discover**, and in *Select* tick the resources (the instance and/or
   databases) and the **metrics** signal. Without the *metrics* signal nothing is collected (the card says *"Not collected (metrics not selected)"*).
2. *Start monitoring* activates the connection. The **worker** (`apps/worker`) leases due connections; for each one it runs the usual health check and,
   **only if that check passes or is merely degraded** (the target answers but reports a problem, e.g. one replica-set member is down), one collection. Both happen under the same lease, every `pollIntervalSeconds` (30–3600 s, default 60 s).
3. The connector reads from the target (below), the worker's sink writes the samples with `MongoMetricStore.ingest`, the same code path (cardinality limits,
   idempotency, cumulative→delta, retention) that OTLP metrics use. Retention is the connection's *Retention (days)* setting.
4. The connection card shows **Collection** (*Waiting for first collection / Collecting metrics / Stopped / Not collected*), the last successful
   collection, the **lag** (seconds since the last success, so it grows if the worker is down), partial-failure notes, and — if it fails — the error and how to fix it.

The API process never collects: only a process started with a sink (the worker) does.

## What is read (exact commands)

Every command goes through a hard allow-list that refuses anything else, **before** anything is sent. Nothing reads collection documents or Redis keys/values.

| Connector | Commands | Allow-list |
|---|---|---|
| MongoDB | `serverStatus` (with `repl`, `metrics`, `locks`, `wiredTiger` disabled), `hello`, `replSetGetStatus` (replica-set members only), `dbStats` (selected databases only) | `ALLOWED_COMMANDS` in `packages/connectors/src/mongodb.ts` (`safeAdminCommand`) |
| Redis | `INFO server`, `INFO clients`, `INFO memory`, `INFO stats`, `INFO replication`, `INFO keyspace` (as selected) | `isAllowedRedisCommand` in `packages/connectors/src/redis.ts` (`safeRedisCall`): `PING`, `INFO <section>`, `SLOWLOG LEN`, `CONFIG GET maxmemory*`, `ACL WHOAMI` |

Tests prove it against real servers: the MongoDB `opcounters.query` counter does not move while collecting, and Redis `get/set/keys/scan/del/config/eval/…` call counters do not move
(`mongodb-collect.test.ts`, `redis-collect.test.ts`).

### Permissions
* **MongoDB:** the `clusterMonitor` role on `admin` (the same user the connection test already asks for). Verified with a user that has only that role.
* **Redis:** `+ping +info` (the ACL string in the wizard already grants them). Redis ≤ 5 has no ACLs; use the shared password and a private network.

## What is collected

Only values the server actually returned are emitted; a field a given version does not report is simply absent (never `0`, never estimated).
Names follow OpenTelemetry-style dotted names; units are UCUM. **sum** = cumulative counter turned into per-interval increases (see below); **gauge** = value at the instant.

### MongoDB (per selected member unless noted)
| Metric | Kind | Unit | Source field |
|---|---|---|---|
| `mongodb.connections.current` / `.available` | gauge | `{connection}` | `connections.current/available` |
| `mongodb.connections.created` | sum | `{connection}` | `connections.totalCreated` |
| `mongodb.operations` (`operation` = insert, query, update, delete, getmore, command) | sum | `{operation}` | `opcounters.*` |
| `mongodb.network.io` (`direction` = in, out) / `mongodb.network.requests` | sum | `By` / `{request}` | `network.*` |
| `mongodb.uptime` | gauge | `s` | `uptime` |
| `mongodb.memory.resident` / `.virtual` | gauge | `By` | `mem.*` (MongoDB up to 8.1; MiB converted to bytes) |
| `mongodb.memory.allocated` / `.heap` | gauge | `By` | `tcmalloc.generic.*` (what MongoDB 8.x reports instead of `mem`) |
| `mongodb.replication.member_state` | gauge | `1` | `replSetGetStatus.myState` (1 = primary, 2 = secondary, …) |
| `mongodb.replication.lag` (secondaries only) | gauge | `s` | primary `optimeDate` − this member's `optimeDate` |
| `mongodb.database.data_size` / `storage_size` / `index_size` | gauge | `By` | `dbStats` of each **selected** database |
| `mongodb.database.collections` / `.objects` | gauge | `{collection}` / `{document}` | `dbStats` |

### Redis (instance selected unless noted)
| Metric | Kind | Unit | Source field |
|---|---|---|---|
| `redis.clients.connected` / `.blocked` | gauge | `{client}` | `connected_clients`, `blocked_clients` |
| `redis.memory.used` / `.rss` | gauge | `By` | `used_memory`, `used_memory_rss` |
| `redis.memory.limit` | gauge | `By` | `maxmemory` (only when a limit is set) |
| `redis.commands.processed` | sum | `{command}` | `total_commands_processed` |
| `redis.commands.rate` | gauge | `{command}/s` | `instantaneous_ops_per_sec` |
| `redis.keyspace.hits` / `.misses` | sum | `{lookup}` | `keyspace_hits/misses` |
| `redis.keys.evicted` / `.expired` | sum | `{key}` | `evicted_keys`, `expired_keys` |
| `redis.connections.received` / `.rejected` | sum | `{connection}` | `total_connections_received`, `rejected_connections` |
| `redis.network.io` (`direction`) | sum | `By` | `total_net_input/output_bytes` |
| `redis.uptime` | gauge | `s` | `uptime_in_seconds` |
| `redis.replication.offset`, `.connected_replicas` (primary), `.link_up` (replica) | gauge | `{byte}`, `{replica}`, `1` | `master_repl_offset`, `connected_slaves`, `master_link_status` (label `redis.role`) |
| `redis.db.keys` / `redis.db.keys_with_expiry` | gauge | `{key}` | `INFO keyspace`, for each **selected** logical database (an empty selected database is reported as 0 keys) |

Every point carries labels `nexus.source=connector`, `db.system` (`mongodb`/`redis`), `nexus.connection.id`, `nexus.connection.name` and `server.address` (`host:port`), plus the metric-specific
labels above (`operation`, `direction`, `db.namespace`, `mongodb.replica_set`, `redis.role`). The connector cannot override the first four.

### Counters (sum)
Counters are sent as *cumulative, monotonic* with **no start time**. The first reading is only a **baseline** (it counts as no activity), each later reading adds the increase since the previous one,
and a reading **lower** than the previous one is a **reset** (server restart): the new value is the increase. A restart is therefore missed only if the counter has already passed its old value
before the next reading. A replayed timestamp is a duplicate and is not counted twice. Tested with exact numbers (`connector-sink.test.ts`; the worker test sees exactly 5 more inserts after inserting 5 documents).

## Cardinality and bounds
* At most **500 series** (metric name + label set) per connection per collection; the extras are **dropped and reported** on the card ("N series were dropped… Select fewer members or databases").
  Server metrics come first, then databases in the order discovered.
* The metric store's own limits still apply (2,000 series per metric, 20,000 per environment); points it refuses are counted and shown on the card.
* A collection has a deadline (the connection test timeout, default 30 s), honours cancellation, and is abandoned 1 s after its deadline even if the connector ignores cancellation; within it every MongoDB member has its own 12 s budget and every Redis run a 12 s budget and a 2 MiB reply cap. Failures back off exponentially (with jitter, up to 15 min, never below the polling interval) like failing health checks and
  show the error and remediation; the credential is scrubbed from every message.
* Renaming a connection changes the `nexus.connection.name` label, which starts new series (the old ones expire with retention). Changing a connection's settings clears its selection, which **stops collection** until you set the connection up again.

## Are connector metrics "services"? No — deliberately
They have **no `service`**, never touch the `services` inventory, and so never appear on the Services page, in service dashboards, in dependency maps or among "services" of the metric catalogue.
A database is not an instrumented application; showing it as one would invite reading "no errors" as "healthy" and mixing database numbers into service latency or error rates.
They appear only on **Metrics**, where a banner states that the metric comes from a data-source connector, and where you filter/group by `nexus.connection.name`.
(Database spans that your *applications* emit continue to appear in traces and as observed dependencies, as before.)

## Failure behaviour (observed)
Measured, not assumed: a real 3-member MongoDB 8.2.6 replica set (keyfile auth, three `mongod` processes), a real Redis 5.0.14, a fault-injecting TCP proxy (drop / silence / delay / cut), and a small RESP fake only where Redis 5
cannot show the behaviour (ACL denials, oversized replies). Tests: `packages/connectors/src/mongodb-replset.resilience.test.ts` (`pnpm --filter @nexus/connectors test:resilience`, about 35 s),
`packages/connectors/src/redis-faults.test.ts`, `apps/worker/test/resilience.test.ts`. Operator view: [runbooks/db-collection-failures.md](../runbooks/db-collection-failures.md).

| Situation | What happens | Result on the card |
|---|---|---|
| **MongoDB**: healthy 3-member set, all members listed | Each member sampled concurrently under its own address; states 1/2/2; lag only on secondaries (0.0 s idle) | Collecting |
| Read-only guarantee on a replica set | Oplog entries (excluding noops) and `insert/update/delete` counters unchanged on **all three** members after repeated runs; `dbStats` of a non-existent database does not create it | - |
| Collect from a **secondary only** (`secondaryPreferred`, direct connection) | Works without the primary; reports state 2 | Collecting |
| **Primary step-down** during continuous collection | No run threw; every run had data from at least two members; exactly one PRIMARY after the election; the old primary then reports lag like any secondary | Collecting throughout |
| **Secondary killed** (SIGKILL) | Survivors are collected, the dead member is named in a note and has no series; `test()` = *unhealthy* ("At least one configured host failed"); bounded by the member budget | State Degraded, Collecting, polling interval unchanged |
| Primary **and** a second member killed (no quorum) | The survivor reports state 2 and, once its heartbeats mark the primary down (up to about 10 s), **no lag** at all; before that a lag against the frozen primary can still be reported | Collecting |
| All members down | `unreachable` (connection refused) or `timeout`, never a crash | Unreachable, Stopped, back-off |
| Member behind a firewall that drops packets | Costs its own budget once (12 s by default; concurrent with the other members); the others are collected; the note names the member | Degraded, Collecting |
| A command hangs after the handshake (server goes silent) | Cut at the member budget, not at 10 s per command; what the member answered earlier is kept | Collecting with a note |
| The whole run is cancelled (deadline, shutdown) after some members answered | Their samples are returned (previously thrown away); with nothing gathered it is a cancellation | Collecting / timeout |
| **Wrong password** | `authentication`; the password is in no message | Misconfigured (first time) / Authentication expired |
| User without monitoring rights (`read` only) | `permission_denied` + remediation naming `clusterMonitor` | Permission denied |
| User that may `serverStatus` and `dbStats` on one database only | Succeeds: server + that database; notes "replication status unavailable (not authorized)" and "statistics for database "other" unavailable"; no zeros | Collecting with notes |
| Replication lag with real data | A secondary with `secondaryDelaySecs: 4` reported 3.4 s while the primary's own view said 3.6 s; the undelayed secondary 0.0 s. Uses `lastAppliedWallTime` (ms); `optimeDate` (whole seconds) had shown 6 s on an idle set whose wall times were 60 ms apart | - |
| **Redis**: connection cut after N reply bytes, N = 0 ... 14000 | Always either `unreachable`/`timeout` (nothing arrived) or a **partial result** with a note "INFO x unavailable" / "cut short"; always within 4 s | Collecting with notes / Unreachable |
| Server killed (SIGKILL) and restarted on the same port | `unreachable` within 3 s while down; fully working after; `uptime` and counters restart (the metric store sees a counter reset) | Unreachable, then Collecting |
| Slow INFO (every reply delayed beyond the command timeout) | One timeout, then stop (the remaining sections would each time out too); bounded by the run budget (12 s default) | Unreachable (timeout) |
| Silent after some sections | Cut at the run budget; the sections received are kept and reported as partial | Collecting with notes |
| Cancelled while waiting | `cancelled` within 2 s; the server's `connected_clients` returns to baseline (nothing leaked) | - |
| **AUTH**: wrong or missing password | `authentication`; the password is in no message | Misconfigured / Authentication expired |
| Password sent to a Redis without one | Redis (via ioredis) ignores it with a warning; the run succeeds | Collecting |
| **MAXCLIENTS** reached | Redis 5.0.14 for Windows **resets the connection without a message**; reported as "Redis reset the connection (client limit reached, server restarting, or a proxy dropped it)" with a `maxclients` remediation (it used to say "not reachable"). Builds that answer "max number of clients reached" are classified `unhealthy`. Recovers when a slot frees | Unreachable (back-off) |
| **TLS** on, plaintext server | "The TLS handshake with Redis did not complete in time" + remediation | Unreachable |
| TLS: untrusted / mismatched certificate | `misconfigured` with a certificate hint; verification is never disabled | Misconfigured |
| TLS off against a TLS endpoint | A clear error within the budget (not "unexpected") | - |
| ACL user without `INFO memory` (fake Redis 6+ replies) | Partial result; note "INFO memory unavailable (The ACL user is not allowed to run a required command)"; the metric is absent | Collecting with notes |
| ACL user with no `INFO` at all | `permission_denied`, remediation names `+ping +info` | Permission denied |
| Endpoint streaming an enormous INFO (64 MiB announced) | Cut after 2 MiB of reply bytes (including ioredis' own ready-check reply), `misconfigured` "does not look like a Redis server"; not buffered or parsed | Misconfigured |
| 5 000 databases selected / present | At most **500 series**; server metrics come first so the instance is never what is dropped; the same series every run | Collecting, "N series were dropped" |
| **Service/worker**: worker dies after claiming | Nobody else may take the connection until the lease (default `max(120 s, test + collection deadline + 30 s)`) expires; then exactly one worker does and collects once | - |
| Worker dies mid-collection | The next run is one interval away (the health check was already recorded); exactly one other worker collects then | - |
| Stalled worker wakes up after takeover | It does **not** write its older readings and does not change the status (previously it did both) | - |
| Same reading twice, an older one late, two writers racing on one counter | The stored increase is exactly the true increase | - |
| Collection fails for a while | Exponential back-off x2 with jitter, never above 15 min and never below the interval; 12 connections failing together are spread out (previously about half landed on the same instant at the ceiling, and with a 1 h interval failures were polled every 15 min) | Stopped, back-off |
| Health: healthy, one member down, unreachable, authentication expired, healthy | Degraded keeps collecting at the normal interval (previously collection stopped and polling backed off exactly when a member was down); unreachable pauses collection; recovery restores *Collecting* with 0 failures | as named |
| Hung targets (one honours cancellation, one ignores it), `concurrency` 2 | Slots freed at the deadline (the one that ignores cancellation 1 s later); the 4 healthy connections are then checked; the hung ones back off and stop competing | - |
| A connector that returns 3 000 distinct series | At most 500 reach the store; "2500 series were dropped" (previously the service trusted the connector) | Collecting |
| **SIGTERM** mid-collection, grace long enough | The collection finishes and its data is written | - |
| SIGTERM mid-collection, grace exhausted | The collection is **aborted** (the connector is told to stop), nothing is recorded as a target failure, the lease is released; the next run is a normal interval away (previously: abandoned, lease held until it expired) | unchanged |

## Limits and what has / has not been verified
Verified here (automated, real servers): MongoDB **8.2.6** standalone with authentication and a `clusterMonitor`-only user; MongoDB single-node replica set **and a 3-member authenticated replica set** (step-down, killed members, delayed secondary, silent members); Redis **5.0.14** standalone, with and without `requirepass`, killed and restarted, reset mid-reply, at `maxclients`;
the whole path worker → connector → metric store → Metrics page in a browser (`18-db-collection.spec.ts`), including connection loss (collection paused, resumes on recovery).

**Not verified — do not assume:**
* Replica sets of more than three members, hidden/arbiter members, sharded clusters (mongos), a replica set behind a load balancer or across a WAN with real latency. The 3-member tests ran on one machine: network partitions (as opposed to killed processes) were simulated with a proxy only.
* MongoDB Atlas, sharded clusters, and MongoDB versions other than 8.2.6 (the `mem.*` metrics are unit-tested on synthetic data, since 8.2.6 no longer returns `mem`). Atlas shared tiers may refuse some commands; refusals are reported as notes, never filled in. A *connection test* (not a collection run) was done once, by hand, against one Atlas cluster; collection itself was never run against Atlas.
* Redis 6+ ACL users (`+ping +info`): only against a fake that returns the documented `NOPERM` reply (Redis 5 has no ACLs); no real Redis 6/7 was available. TLS: verified against a TLS endpoint built with `node:tls` (untrusted/mismatched certificate, wrong protocol), **not** a TLS-enabled Redis. Redis Cluster, Sentinel, managed Redis services, replicas (`link_up`) — logic is unit-tested on synthetic INFO text only.
* Sustained load: not benchmarked. One connection issues a handful of small commands per interval (a few ms on a local server); the cost grows with the number of selected databases (one `dbStats` each).
* Production roles: the worker needs write access to `metric_series` and `metric_points` (already in the `nexusApp` role in `docs/runbooks/mongodb-roles.md`).
* Only the **metrics** signal is collected. *Inventory* (database names, key counts at discovery time) is stored at discovery; Redis slow-log entries, Mongo profiler data and server logs are not read.
