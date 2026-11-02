# Runbook: database collection (MongoDB / Redis) is failing, partial or stale

Applies to data sources of type MongoDB and Redis that have the *metrics* signal selected. What each failure looks like, what the platform does by itself, and what you do.
The behaviour below was **observed** (real 3-member MongoDB 8.2.6 replica set, real Redis 5.0.14, fault-injecting proxies); see
[integrations/db-collection.md](../integrations/db-collection.md#failure-behaviour-observed) for the evidence and `packages/connectors/src/*resilience*`, `redis-faults.test.ts`, `apps/worker/test/resilience.test.ts`.

## Where to look
* **Data Sources → the connection card:** *State* (health check) and *Collection* (status, last success, lag, notes, last error with remediation).
* Worker: `GET :4100/metrics` (`nexus_worker_checks_*`, `nexus_worker_inflight_checks`, `nexus_worker_last_tick_timestamp_seconds`), `GET :4100/readyz`, JSON logs `check finished` / `check crashed`.
* Platform database: `connections` documents (`health.*`, `collection.*`, `lease`).

## Reading the card

| You see | It means | Do |
|---|---|---|
| State **Healthy**, collection **Collecting**, lag small | Normal. | Nothing. |
| State **Degraded** with *"At least one configured host failed"*, collection **Collecting**, a note naming one member | One replica-set member does not answer; the others are still being collected. Polling continues at the **normal** interval (it does not back off). | Fix or remove the member. Until then its series have a gap (never zeros). |
| State **Unreachable**, collection **Stopped** | The target does not answer (refused, reset, timeout). Collection is paused and the next attempts back off (x2 each time, +/-20 % jitter, never above 15 min, never below the polling interval). | See "Cannot connect" below. Recovery is automatic on the next successful check. |
| State **Misconfigured** (first-time) / **Authentication expired** (worked before) | Credentials rejected. | Rotate the credential on the card. The platform does not retry faster; it backs off. |
| State **Permission denied** | The user lacks a command. | MongoDB: grant `clusterMonitor` on `admin`. Redis (6+): `+ping +info`. |
| Collection **Stopped** but State **Healthy** | The health check passes but the collection itself failed (deadline, a refused command). The error and remediation are on the card. | Read the note; collection retries with back-off. |
| Collection **Collecting** but with notes ("replication status unavailable", "statistics for database … unavailable", "INFO memory unavailable") | Partial result: the user lacks one command, or one section was cut. The metrics that could not be read are **absent**, never `0`. | Grant the missing permission, or ignore. |
| Lag growing, State still Healthy | The worker is not running or not ticking (lag is "seconds since last success"). | Check `readyz`, worker logs and that exactly the expected number of workers run. |

## Cannot connect (Unreachable / Timeout)
1. **Connection refused** (answers within milliseconds): service down or wrong port. Start it / fix the address.
2. **Timeout** after ~5 s per member (MongoDB: 5 s server selection, 12 s budget per member for everything; Redis: 5 s connect, 12 s budget per run): a firewall silently dropping packets, or an overloaded server.
   A member that accepts the connection and then stops answering costs **its own** 12 s budget once; other members are collected concurrently and are not delayed.
3. **Redis "reset the connection (client limit reached, server restarting, or a proxy dropped it)":** check `INFO clients` / `CONFIG GET maxclients`. Redis builds that say *"max number of clients reached"* are reported as **Degraded** with that explanation; the Windows 5.0.14 build only resets the socket (so the message names all three causes).
4. **TLS:** `tls on` against a plaintext Redis shows *"The TLS handshake with Redis did not complete in time"*; an untrusted or mismatched certificate is *Misconfigured* with a certificate hint. Certificate validation is never turned off; fix the certificate or the host name, or (development only) turn TLS off.
5. **Oversized reply:** *"The endpoint sent more than 2048 KiB"* — the host/port is not a Redis, or something in between is streaming data. Check the address.

## MongoDB replica sets
* List **every member** you want monitored (each is a separate direct connection; topology discovery is deliberately off). Reads use `secondaryPreferred` and are safe on secondaries; nothing is ever written (verified: oplog and insert/update/delete counters unchanged).
* **Primary step-down / election:** collection keeps returning data from every member that answers; `member_state` shows 1/2 as the servers state it. During an election **no lag** is emitted (there is no primary to be behind).
* **Primary killed:** for up to about 10 s the survivors still list the dead primary as PRIMARY (heartbeat timeout). The platform stops emitting lag against a primary that its heartbeats mark as down (`health: 0`); in the first seconds a lag figure measured against the frozen primary can still appear. Read lag together with `member_state`.
* **Lag precision:** computed from `lastAppliedWallTime` (milliseconds). The primary's figure reaches a secondary with heartbeats (about 2 s), so the metric can be up to about 2 s stale and is clamped at 0. Observed: a member with `secondaryDelaySecs: 4` showed 3.4 s while the primary's own view said 3.6 s.
* **Losing quorum:** the surviving secondary reports `member_state` 2 and no lag; all members down is *Unreachable*.

## Worker and lease behaviour (what you can rely on)
* A worker claims a connection with a **lease** of `max(120 s, test deadline + collection deadline + 30 s)`. A worker that dies keeps nobody else out for longer than that; then exactly one other worker takes over. Nothing is collected twice per interval.
* A stalled worker that wakes up after losing its lease **does not write** its (older) readings or change the status.
* Readings are idempotent: a replayed timestamp is ignored and an older reading arriving late is ignored; cumulative counters turn into increases exactly once.
* A failing or hung connection occupies a worker slot only until its deadline (health check 30 s, collection 30 s by default; a connector that ignores cancellation is abandoned 1 s after the deadline) and then backs off, so it cannot starve the others.
* A connector can never put more than **500 series per connection** into the metric store, even if it forgot to cap itself; the overflow is reported on the card.
* **Shutdown (SIGTERM):** running checks get 15 s to finish and write their data. After that they are **aborted** (sockets closed), nothing is recorded as a failure of the target, and the leases are released at once.
  An interrupted run does not back off.

## When it is the worker, not the database
* `nexus_worker_last_tick_timestamp_seconds` not advancing, or `/readyz` 503: the scheduler loop or the platform database is down.
* `nexus_worker_inflight_checks` stuck at `WORKER_CONCURRENCY`: many targets are slow; each is cut at its deadline, but with a small `WORKER_CONCURRENCY` that delays the others by up to a deadline. Raise concurrency (max 64) or fix the slow targets.
* Two workers are fine (leases); a worker started with a clock far from the others' is not (lease times are compared against each worker's clock): keep NTP on.
