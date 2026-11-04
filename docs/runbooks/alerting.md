# Runbook: alerting and incidents

Design: [ADR-0006](../architecture/ADR-0006-alerting-incidents.md), [ADR-0010](../architecture/ADR-0010-maintenance-windows-and-replay.md) · Users: [alerting.md](../alerting.md)

## What runs where
| Component | Does |
|---|---|
| **Worker** (`apps/worker`) | Evaluates due rules (leases on rule documents), opens/closes incidents, sends queued notifications (webhook, Slack, e-mail). Alerting stops when no worker runs; **nothing alerts while the worker is down**. When it comes back, rules with `missedPolicy: replay` re-evaluate their latest missed intervals (see below); with the default `skip` the gap is only counted. |
| **API** (`apps/api`) | CRUD for rules, channels, silences, maintenance windows; incident actions; test-send (synchronous, one attempt). Never evaluates rules. |
| MongoDB | `alert_config` (rules, channels, silences, maintenance windows), `incidents`, `alert_deliveries` (queue + delivery log), channel secrets in `secrets`. |

Several workers can run: each rule is claimed by one worker at a time (atomic lease), each delivery likewise. Lease length is twice the per-rule budget plus 5 s for rules, 30 s for deliveries.

## Configuration (worker environment)
| Variable | Default | Meaning |
|---|---|---|
| `ALERTING_ENABLED` | `true` | `false` turns evaluation and delivery off on this worker |
| `ALERT_TICK_MS` | `2000` | idle polling interval (500–60 000). A backlog is drained without waiting |
| `ALERT_MAX_RULES_PER_TICK` | `50` | rules evaluated per tick (bound on burst work) |
| `ALERT_RULE_BUDGET_MS` | `10000` | time one rule may take; exceeding it records an evaluation error and moves on |
| `WEB_ORIGIN` | unset | puts an incident link in notifications |
| `NETWORK_ALLOW_*` | as for connectors | the outbound policy used for webhooks, Slack and SMTP (loopback, plain http, unencrypted SMTP and ports other than 587/465/2525 only in development) |
| `SECRETS_KEYS`, `SECRETS_CURRENT_KEY_ID` | required in production | the key-encryption key that protects channel URLs and secrets; **the worker and the API must have the same keys** |

Prometheus metrics on the worker's health port `/metrics`: `nexus_alert_rules_evaluated_total`, `nexus_alert_evaluation_errors_total`, `nexus_alert_evaluation_budget_exceeded_total`,
`nexus_alert_incidents_opened_total`, `nexus_alert_incidents_auto_resolved_total`, `nexus_alert_evaluations_missed_total`, `nexus_alert_evaluations_replayed_total`, `nexus_alert_catch_up_notices_total`, `nexus_alert_last_tick_duration_ms`, `nexus_alert_last_tick_rules`,
`nexus_alert_deliveries_{attempted,delivered,retried,failed}_total`, `nexus_alert_tick_errors_total`. Suggested alerts on the platform itself: evaluation errors rising, `last_tick_duration_ms` close to the interval,
deliveries failed rising, `nexus_worker_last_tick_timestamp_seconds` stale.

## Symptoms and what to do
| Symptom | Likely cause | Check / fix |
|---|---|---|
| Rules never evaluate (`Evaluated` column empty, state "unknown") | no worker, `ALERTING_ENABLED=false`, or the rule is disabled | worker `/readyz`, logs `alert tick failed`; `db.alert_config.find({kind:"rule", enabled:true}, {name:1, nextEvalAt:1, lease:1})` – a `nextEvalAt` far in the past with a live `lease` means a worker is stuck or died; the lease expires on its own |
| Rule shows **evaluation error** | the store refused the query (`query_too_expensive`: more than 2,000 series match – add a service/label filter; `unsupported_aggregation` – the metric's type does not support it, e.g. `avg` on a counter), a timeout, or MongoDB trouble | the message is on the rule (`lastError`). State is unchanged; fix the rule or the data, the next interval retries |
| Rule says no data although the service is running | the metric name or labels differ, the service stopped reporting, a delta counter had no increments, or ingestion is refusing data | Metrics explorer for the same query; Sources > Ingestion for refusals; set `noDataPolicy` to `ok` for activity-driven counters |
| An incident stays open after the problem went away | `noDataPolicy=keep` and the metric disappeared; or `resolveAfterSeconds` is long | resolve it by hand (engineer), or change the policy |
| Incident but no webhook | no channel on the rule, channel disabled, a **silence** or an active **maintenance window** matches, a replayed transition was **stale**, the channel **rate limit** was hit, or delivery failed | incident detail > *Notification delivery log* and the timeline say which (`suppressed` with a silence id or a maintenance id, `stale`, `rate limited`, `failed` with the reason) |
| A window did not suppress, or suppressed at the wrong time | the zone or the weekday is not what you meant: the start is **local wall-clock time in the window's IANA zone**, the weekday is the day it *starts* on, the duration is elapsed time; the window is disabled; its matchers (rule, severity, environment) do not match the rule | `GET .../alert-maintenance-windows` shows `state`, `currentOccurrence` and `nextOccurrence` computed by the server (UTC). A spring-forward start time that does not exist moves forward by the gap; a fall-back time uses the first occurrence. Notifications **already created** before the window started are not recalled |
| A suppressed incident is still firing after the window ended and nobody was told | by design: suppressed notifications are not re-sent when a window ends | the incident is visible in *Incidents*; acknowledge or resolve it, or end the window early (delete or disable it) *before* the rule fires if you want to be paged |
| Rule shows **N missed** in the list | the worker was down, a lease expired, or a backlog exceeded `maxRulesPerTick` for longer than one interval | `missedEvaluations` on the rule; with `skip` those checks were lost, with `replay` the latest `maxReplayEvaluations` were re-run (older ones counted as skipped). Check `nexus_alert_evaluations_missed_total` and the worker's uptime/`/readyz`; run more workers or raise `ALERT_MAX_RULES_PER_TICK` if it is a backlog rather than an outage |
| After an outage an incident was opened in the past, with deliveries `stale` | replay reconstructs incidents at the minute they began (event time) and never sends notifications for transitions older than `staleNotificationSeconds` (default 15 min) | expected. A still-firing incident gets one catch-up notice (payload `catchUp: true`); an announced incident that recovered gets one catch-up `incident.resolved`. If a receiver needs the old events too, read the incident timeline/delivery log |
| Replay stops partway (`replay budget exhausted` in the worker log) | the stores answered slowly: the whole replay may use twice the per-rule budget | the remaining boundaries are counted as skipped and the evaluation for now still runs; reduce `maxReplayEvaluations` or fix the store latency |
| Deliveries `failed` with `blocked_target` | the URL now resolves to a private/loopback/metadata address (or DNS changed) | fix the receiver's DNS; for an approved internal receiver an operator may add `NETWORK_ALLOW_PRIVATE_CIDRS` (metadata addresses stay blocked regardless) |
| Deliveries `failed` with `tls_error` | expired or untrusted certificate on the receiver | fix the certificate; verification cannot be disabled |
| Deliveries `failed` with `blocked_port` (e-mail) | the SMTP port is not 587, 465 or 2525 (port 25 and all others are refused outside development) | edit the channel to use the relay's submission port; if the relay only listens on 25, put a 587/465 listener in front of it |
| E-mail deliveries `failed` with `smtp_tls_required` | the server does not offer STARTTLS (or the channel is `none` outside development) | enable STARTTLS on the relay, or switch the channel to implicit `tls` on 465. There is deliberately no "send unencrypted anyway" |
| E-mail deliveries `failed` with `tls_error` | untrusted/expired certificate, or the certificate does not name the configured `smtp.host` (use the host name in the certificate, not an IP) | fix the certificate; verification cannot be disabled |
| E-mail deliveries `failed` with `smtp_auth_failed` | wrong user name/password, an app password is required, or the server offers neither AUTH PLAIN nor LOGIN | `PATCH` new credentials (`smtp.username` + `smtp.password`), then send a test. Check the provider's "less secure apps"/app-password rules |
| E-mail `smtp_rejected` / `recipients_rejected` (5xx) | the provider refuses the `from` address (not authorised/verified) or every recipient | use a sender the provider allows; check SPF/DKIM at the provider; fix recipients |
| E-mail `smtp_temporary_failure`, `timeout`, `connection_failed` | greylisting, provider rate limit, outage, firewall, or a send that exceeded 20 s | retried automatically (5 attempts with backoff); if persistent check egress rules from the worker to the relay |
| E-mail delivered but nothing in the inbox | spam folder, provider silently dropped, or some recipients were refused (`N of M recipients were refused` on the delivery) | look at the provider's logs for the `Message-ID` `<deliveryId@from-domain>`; the delivery id is in the delivery log |
| Slack deliveries `failed` with `http_client_error` (404/403/410) | the incoming webhook was revoked or the Slack channel archived | create a new incoming webhook in Slack and `PATCH` the channel's `url` |
| Slack/e-mail `invalid_address` | a stored recipient or from-address no longer passes validation (database edited by hand) | `PATCH` the channel with a valid list; the send is refused before any SMTP command is written |
| Deliveries `failed` with `The channel configuration could not be loaded` | the worker cannot decrypt the channel secrets (different `SECRETS_KEYS` than the API, or a rotated/removed key) | align the keys; re-save the channel secret if the old key is gone |
| Duplicate notifications at the receiver | delivery is at-least-once (a crash between the receiver answering and the status update) | de-duplicate on `X-Nexus-Delivery` |
| Many incidents at once for one rule | a grouped rule (one incident per label value; at most 20 groups tracked) | expected; add a silence or narrow the grouping |
| `limit_reached` when creating | 100 rules / 10 channels / 50 live silences / 20 maintenance windows per project | delete unused ones |

## Operations
- **Stop all alerting quickly** (during an incident storm or a bad rule): set `ALERTING_ENABLED=false` on the workers, or disable the rule(s) (disabling closes their live incidents). Silences and maintenance windows stop *notifications* only.
- **Inspect due work:** `db.alert_config.find({kind:"rule", enabled:true, nextEvalAt:{$lte:new Date()}}).count()` is the backlog; it should hover near zero.
- **Queue health:** `db.alert_deliveries.find({status:"pending"}).count()` and the oldest `nextAttemptAt`; failed deliveries are kept 30 days.
- **Rotate a channel secret:** `PATCH …/alert-channels/:id {"signingSecret": "<new>"}`, then update the receiver. There is a window in which the receiver rejects signatures; send a test afterwards. (No dual-secret overlap in this slice.)
- **KEK rotation:** channel secrets live in `secrets` and are re-wrapped by the normal procedure ([secrets-and-kek-rotation.md](secrets-and-kek-rotation.md)); no alerting-specific step.
- **Retention:** resolved incidents 90 days, deliveries 30 days, ended silences and ended one-off maintenance windows 1 day (TTL indexes; the TTL monitor runs about once a minute); recurring windows stay until deleted.
- **Worker outage drill:** stop the worker for a few intervals, start it, and open the rule list: *N missed (R replayed, S skipped)* appears, and for a `replay` rule an incident that began during the outage shows `openedAt` inside it (timeline event data `replayed: true`). To inspect without the UI: `db.alert_config.find({kind:"rule"}, {name:1, missedPolicy:1, missed:1, lastEvaluatedAt:1, nextEvalAt:1})`.
- **Maintenance windows after a time-zone database change:** windows store the IANA name and are evaluated with the worker's ICU time-zone data (Node). After a government changes a zone's rules, upgrade Node; occurrences are computed on demand, nothing is stored per occurrence, so no data fix is needed.
- **Disk/indexes:** maintenance windows and the replay fields add **no collection, no index and no migration** (migration number 31 was reserved and is unused); the declared collection count is unchanged.
- **MongoDB roles:** the three collections are in the `nexusApp` role in [mongodb-roles.md](mongodb-roles.md). Migration 20 creates them and their indexes; run it as a privileged deploy step if the application user may not create indexes.
- **Backups** contain incident history and encrypted channel secrets (see the secrets runbook for the KEK).

## Scale (measured, one worker)
See "Measured limits" in [alerting.md](../alerting.md). Rule of thumb: sustained rules per second × interval = rules per worker. Add workers to scale out (leases share the load); the metric and log
queries themselves load MongoDB, so watch its CPU first. Expensive rules (long windows, free-text log filters over busy projects, wide `groupBy`) cost far more than the average: check `nexus_alert_last_tick_duration_ms`.

## Security notes for operators
- Channel URLs and secrets are never in API responses, logs, audit metadata or the channel document; they are in `secrets` (AES-256-GCM, bound to the organization and channel).
- Webhook, Slack and SMTP targets pass the platform SSRF guard on save and on every send (resolve, classify every address, pin the connection); redirects are not followed; responses are not stored.
- **Slack incoming-webhook URLs and SMTP user names/passwords are credentials**: envelope-encrypted in `secrets` (namespace `alert-channel:<id>`: `url`, `signing`, `smtp-user`, `smtp-pass`), never in channel documents, API responses, logs, audit metadata, delivery rows or the incident timeline. Delivery errors carry reply codes and fixed sentences only, never server text. Recipient lists are stored in the channel document and masked in API responses.
- **Operating the e-mail transport:** the worker must be able to reach the relay on 587/465/2525 (egress rule); the relay must offer STARTTLS (or implicit TLS) with a certificate for the configured host name. `POST …/alert-channels/:id/test` is the safe way to check a change (it sends a real e-mail to every recipient: warn the team). Send an alert test after rotating credentials, after KEK rotation, and after moving the relay.
- **Not verified against a real mail provider or a real Slack workspace** (the test suite uses in-process fakes): validate with a test send on first use.
- Incident comments are free text written by users: treat them like any user content (the UI renders them as text).
- The audit log records who created, changed or deleted rules/channels/silences and who acknowledged, resolved or commented; engine actions are `system` events.
