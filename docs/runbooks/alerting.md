# Runbook: alerting and incidents

Design: [ADR-0006](../architecture/ADR-0006-alerting-incidents.md) · Users: [alerting.md](../alerting.md)

## What runs where
| Component | Does |
|---|---|
| **Worker** (`apps/worker`) | Evaluates due rules (leases on rule documents), opens/closes incidents, sends queued webhook notifications. Alerting stops when no worker runs; **nothing alerts while the worker is down** and missed evaluations are not replayed. |
| **API** (`apps/api`) | CRUD for rules, channels, silences; incident actions; test-send (synchronous, one attempt). Never evaluates rules. |
| MongoDB | `alert_config` (rules, channels, silences), `incidents`, `alert_deliveries` (queue + delivery log), channel secrets in `secrets`. |

Several workers can run: each rule is claimed by one worker at a time (atomic lease), each delivery likewise. Lease length is twice the per-rule budget plus 5 s for rules, 30 s for deliveries.

## Configuration (worker environment)
| Variable | Default | Meaning |
|---|---|---|
| `ALERTING_ENABLED` | `true` | `false` turns evaluation and delivery off on this worker |
| `ALERT_TICK_MS` | `2000` | idle polling interval (500–60 000). A backlog is drained without waiting |
| `ALERT_MAX_RULES_PER_TICK` | `50` | rules evaluated per tick (bound on burst work) |
| `ALERT_RULE_BUDGET_MS` | `10000` | time one rule may take; exceeding it records an evaluation error and moves on |
| `WEB_ORIGIN` | unset | puts an incident link in notifications |
| `NETWORK_ALLOW_*` | as for connectors | the outbound policy used for webhooks (loopback and plain http only in development) |
| `SECRETS_KEYS`, `SECRETS_CURRENT_KEY_ID` | required in production | the key-encryption key that protects channel URLs and secrets; **the worker and the API must have the same keys** |

Prometheus metrics on the worker's health port `/metrics`: `nexus_alert_rules_evaluated_total`, `nexus_alert_evaluation_errors_total`, `nexus_alert_evaluation_budget_exceeded_total`,
`nexus_alert_incidents_opened_total`, `nexus_alert_incidents_auto_resolved_total`, `nexus_alert_last_tick_duration_ms`, `nexus_alert_last_tick_rules`,
`nexus_alert_deliveries_{attempted,delivered,retried,failed}_total`, `nexus_alert_tick_errors_total`. Suggested alerts on the platform itself: evaluation errors rising, `last_tick_duration_ms` close to the interval,
deliveries failed rising, `nexus_worker_last_tick_timestamp_seconds` stale.

## Symptoms and what to do
| Symptom | Likely cause | Check / fix |
|---|---|---|
| Rules never evaluate (`Evaluated` column empty, state "unknown") | no worker, `ALERTING_ENABLED=false`, or the rule is disabled | worker `/readyz`, logs `alert tick failed`; `db.alert_config.find({kind:"rule", enabled:true}, {name:1, nextEvalAt:1, lease:1})` – a `nextEvalAt` far in the past with a live `lease` means a worker is stuck or died; the lease expires on its own |
| Rule shows **evaluation error** | the store refused the query (`query_too_expensive`: more than 2,000 series match – add a service/label filter; `unsupported_aggregation` – the metric's type does not support it, e.g. `avg` on a counter), a timeout, or MongoDB trouble | the message is on the rule (`lastError`). State is unchanged; fix the rule or the data, the next interval retries |
| Rule says no data although the service is running | the metric name or labels differ, the service stopped reporting, a delta counter had no increments, or ingestion is refusing data | Metrics explorer for the same query; Sources > Ingestion for refusals; set `noDataPolicy` to `ok` for activity-driven counters |
| An incident stays open after the problem went away | `noDataPolicy=keep` and the metric disappeared; or `resolveAfterSeconds` is long | resolve it by hand (engineer), or change the policy |
| Incident but no webhook | no channel on the rule, channel disabled, a **silence** matches, the channel **rate limit** was hit, or delivery failed | incident detail > *Notification delivery log* and the timeline say which (`suppressed`, `rate limited`, `failed` with the reason) |
| Deliveries `failed` with `blocked_target` | the URL now resolves to a private/loopback/metadata address (or DNS changed) | fix the receiver's DNS; for an approved internal receiver an operator may add `NETWORK_ALLOW_PRIVATE_CIDRS` (metadata addresses stay blocked regardless) |
| Deliveries `failed` with `tls_error` | expired or untrusted certificate on the receiver | fix the certificate; verification cannot be disabled |
| Deliveries `failed` with `The channel configuration could not be loaded` | the worker cannot decrypt the channel secrets (different `SECRETS_KEYS` than the API, or a rotated/removed key) | align the keys; re-save the channel secret if the old key is gone |
| Duplicate notifications at the receiver | delivery is at-least-once (a crash between the receiver answering and the status update) | de-duplicate on `X-Nexus-Delivery` |
| Many incidents at once for one rule | a grouped rule (one incident per label value; at most 20 groups tracked) | expected; add a silence or narrow the grouping |
| `limit_reached` when creating | 100 rules / 10 channels / 50 live silences per project | delete unused ones |

## Operations
- **Stop all alerting quickly** (during an incident storm or a bad rule): set `ALERTING_ENABLED=false` on the workers, or disable the rule(s) (disabling closes their live incidents). Silences stop *notifications* only.
- **Inspect due work:** `db.alert_config.find({kind:"rule", enabled:true, nextEvalAt:{$lte:new Date()}}).count()` is the backlog; it should hover near zero.
- **Queue health:** `db.alert_deliveries.find({status:"pending"}).count()` and the oldest `nextAttemptAt`; failed deliveries are kept 30 days.
- **Rotate a channel secret:** `PATCH …/alert-channels/:id {"signingSecret": "<new>"}`, then update the receiver. There is a window in which the receiver rejects signatures; send a test afterwards. (No dual-secret overlap in this slice.)
- **KEK rotation:** channel secrets live in `secrets` and are re-wrapped by the normal procedure ([secrets-and-kek-rotation.md](secrets-and-kek-rotation.md)); no alerting-specific step.
- **Retention:** resolved incidents 90 days, deliveries 30 days, ended silences 1 day (TTL indexes; the TTL monitor runs about once a minute).
- **MongoDB roles:** the three collections are in the `nexusApp` role in [mongodb-roles.md](mongodb-roles.md). Migration 20 creates them and their indexes; run it as a privileged deploy step if the application user may not create indexes.
- **Backups** contain incident history and encrypted channel secrets (see the secrets runbook for the KEK).

## Scale (measured, one worker)
See "Measured limits" in [alerting.md](../alerting.md). Rule of thumb: sustained rules per second × interval = rules per worker. Add workers to scale out (leases share the load); the metric and log
queries themselves load MongoDB, so watch its CPU first. Expensive rules (long windows, free-text log filters over busy projects, wide `groupBy`) cost far more than the average: check `nexus_alert_last_tick_duration_ms`.

## Security notes for operators
- Channel URLs and secrets are never in API responses, logs, audit metadata or the channel document; they are in `secrets` (AES-256-GCM, bound to the organization and channel).
- Webhook targets pass the platform SSRF guard on save and on every send; redirects are not followed; responses are not stored.
- Incident comments are free text written by users: treat them like any user content (the UI renders them as text).
- The audit log records who created, changed or deleted rules/channels/silences and who acknowledged, resolved or commented; engine actions are `system` events.
