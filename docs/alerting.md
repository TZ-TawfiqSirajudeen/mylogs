# Alerting and incidents

Decision record: [ADR-0006](architecture/ADR-0006-alerting-incidents.md) · Operations: [runbooks/alerting.md](runbooks/alerting.md)

This is the **first slice**: threshold rules on metrics and log counts, incidents with a timeline, and signed **webhook** notifications. There is no
e-mail, Slack, PagerDuty, anomaly detection, escalation policy or on-call schedule yet (see [Limits](#honest-limits)).

## Concepts
| Term | Meaning |
|---|---|
| **Rule** | A question asked at a fixed interval about **one environment**: *a metric aggregate* or *a log count* over a window, compared with a threshold. |
| **Group** | A rule may evaluate separately per value of one label (for example per `service`). Each group has its own state and its own incident. A rule without grouping has one group. |
| **State** | `ok -> pending -> firing -> resolved`, per group. *Pending*: the condition holds but not yet for the whole "must hold for" time. *Firing*: an incident is open. |
| **Incident** | Opened when a group fires; **at most one live incident per rule and group** (enforced by the database). Statuses: `open`, `acknowledged`, `resolved`. Has a timeline. |
| **Channel** | Where notifications go. Only **webhook** exists. |
| **Silence** | A time window that suppresses notifications (not incidents) for matching rules, severities or environments. |

## Who can do what
| Action | Viewer | Engineer | Project admin (and org owner/admin) |
|---|---|---|---|
| Read rules, incidents, channels (no secrets), silences | yes | yes | yes |
| Acknowledge, resolve, comment on incidents | no | **yes** | yes |
| Create/edit/enable/disable/delete rules | no | no | yes |
| Create/edit/delete channels, send tests, manage silences | no | no | yes (unrestricted access only) |

A user restricted to some environments only sees and changes rules and incidents of those environments; channels and silences are project-wide and
need unrestricted access. A user without access to the project gets `404`. Every change and every incident action is in the audit log.

## Writing rules

### Metric threshold rule
`aggregation(metric) <op> threshold` over the last *window*, evaluated every *check interval*.

| Field | Notes |
|---|---|
| `query.metric` | A metric name as shown in the Metrics explorer. |
| `query.agg` | `sum`, `rate` (increase per second over the whole window), `avg` (exact: total sum / total count), `min`, `max`, `last`, `count`. **Percentiles (p50…p99) are not available**: a percentile over a sliding window cannot be computed exactly from the store's per-minute results. Which aggregations a metric supports depends on its type (for example `avg` is not defined for a counter): an unsupported choice shows up as an *evaluation error* on the rule. |
| `query.service`, `query.filters` | Exact-match service and up to 5 label filters. |
| `query.groupBy` | At most one label key (or `service`); up to 20 groups per rule are tracked. |

### Log count rule
Counts records matching the **same filter vocabulary as the Logs Explorer** (text, minimum severity or errors only, services, field filters such as
`httpStatus >= 500`) in the window and compares the count. Counting uses the record's *event time*; records that arrive late are counted by the next evaluation.

### Timing
- `windowSeconds` 60 s – 24 h. The metric store aggregates whole minutes, so the window can be up to one minute longer than configured.
- `intervalSeconds` 15 s – 1 h, and not more than twice the window (otherwise data between evaluations would never be examined).
- `forSeconds` (0 – 24 h): the condition must hold continuously this long before the rule fires. `0` fires on the first breaching evaluation.
- `resolveAfterSeconds` (0 – 24 h, default 120): flapping protection. A firing group resolves only after the condition has been clear this long; a breach during recovery restarts the timer.

### No data and errors
| Policy | Missing data is treated as |
|---|---|
| `keep` (default) | no information: the state does not change (a firing rule stays firing, an ok rule stays ok) |
| `ok` | healthy (a firing rule resolves after the hysteresis) |
| `alert` | a breach (fires after the "must hold for" time) |

A log count of 0 is a value, never "no data". **An evaluation error** (a store refusing the query, a timeout, a database problem) **never resolves an
incident and never opens one**: the rule shows *evaluation error* with the message, keeps its state, and is retried at its next interval.

### Editing and manual actions
- Changing what a rule *measures* (query, condition, window, timing, no-data policy) resets its state and **closes its live incidents** (`auto_resolved`, reason `rule_changed`). Changing only the name, description, severity or channels keeps everything. Disabling or deleting a rule also closes its live incidents.
- Resolving an incident by hand while the condition still holds: the group is judged again at the next evaluation (through *pending*, honouring "must hold for") and may open a **new** incident.

## Incidents
Timeline events: `opened`, `notified`, `notification_failed`, `notification_suppressed` (silence or rate limit), `acknowledged`, `resolved` (by a person),
`auto_resolved` (recovery, or the rule was changed/disabled/deleted), `comment`. The newest 500 events and up to 100 comments are kept per incident.
Resolved incidents are deleted 90 days after resolution.

## Webhook channels
1. **Create** a channel (project admin): a name, an `https://` URL and a **signing secret** (16–256 characters) that *you* choose. The URL and the secret are stored
   envelope-encrypted and are **never returned by any API or shown in the UI**; responses show only `scheme://host/…`. To rotate, `PATCH` a new secret.
2. **Send test** (`POST …/alert-channels/:id/test`): one signed request right now, no retries, at most 5 per minute per channel. The result is shown and recorded.
3. **Verify** every request on the receiver. Headers: `X-Nexus-Event` (`incident.opened`, `incident.resolved`, `test`), `X-Nexus-Delivery` (unique id: use it to de-duplicate, delivery is at-least-once),
   `X-Nexus-Signature: t=<unix seconds>,v1=<hex>` where `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`. Reject timestamps older than a few minutes.

```js
// Node.js receiver
const sig = req.headers['x-nexus-signature'];            // "t=1767225600,v1=9f2c…"
const [t, v1] = [/t=(\d+)/.exec(sig)[1], /v1=([0-9a-f]{64})/.exec(sig)[1]];
const expected = crypto.createHmac('sha256', SECRET).update(`${t}.${rawBody}`).digest('hex');
if (!crypto.timingSafeEqual(Buffer.from(v1), Buffer.from(expected)) || Math.abs(Date.now() / 1000 - Number(t)) > 300) return res.sendStatus(401);
```

Body (bounded to 16 KiB, contains no secrets):
```json
{ "event": "incident.opened", "occurredAt": "2026-03-01T12:02:00.000Z", "deliveryId": "…", "attempt": 1,
  "incident": { "id": "…", "title": "High error rate (service=checkout)", "severity": "critical", "status": "open", "ruleId": "…", "ruleName": "High error rate",
                "projectId": "…", "environmentId": "…", "group": { "service": "checkout" }, "value": 12.5, "condition": "> 10 over 5m",
                "openedAt": "…", "resolvedAt": null, "resolvedBy": null, "url": "https://nexus.example.com/incidents/…?p=…" } }
```
`url` is present when the worker has `WEB_ORIGIN` set.

**Delivery behaviour.** 5 attempts: after a failure the next attempt is 30 s, 2 min, 10 min, 30 min later (plus up to 20 % jitter). `429`, `408`, `5xx`, timeouts and connection errors are
retried; other `4xx`, redirects, TLS errors and blocked targets fail at once. A final failure is written to the incident timeline. Resolution notices go only to channels that were told about the opening.

**Network safety.** `https://` is required (plain `http://` only when the platform policy `NETWORK_ALLOW_INSECURE_HTTP=true`, a development setting). The target host is resolved and **every** address must be public:
private ranges, loopback, link-local, cloud-metadata (169.254.169.254, 100.100.100.200, …), reserved ports (SMTP, SSH, databases…), IPv4-mapped IPv6 and numeric shorthands are refused **when saving and again on every send**; the
connection goes to the validated address (DNS rebinding cannot redirect it); redirects are never followed; 5 s timeout; the response body is read to 2 KiB and discarded. Approved private networks are an operator decision
(`NETWORK_ALLOW_PRIVATE_CIDRS`), exactly as for connectors.

**Rate limit.** Each channel sends at most `rateLimitPerMinute` (default 20, max 60) notifications per minute; excess notifications are recorded as `rate_limited` and not sent.

## Silences
A silence has a reason, a start and an end (at most 30 days) and optional matchers: rule ids, severities, environments (all given kinds must match; empty = the whole project). While active, matching notifications are recorded as
`suppressed` (with the silence id) and the incident timeline says so; **incidents are still opened and shown**. Deleting a silence ends the suppression immediately. A project holds at most 50 live silences.

## API
Base: `/api/v1/projects/:projectId`. Session cookie + `x-csrf-token` on writes, like every route. Lists use keyset pagination (`?limit=1..100&cursor=…`, response `{ items, nextCursor }`).
Errors: `400 validation_error` (with field details), `403 forbidden`, `404 not_found` (also for another tenant's objects), `409 conflict`, `422 validation_error | limit_reached`, `429 rate_limited`. The OpenAPI document (`/docs`, non-production) describes every route.

| Method and path | Role | Notes |
|---|---|---|
| `GET /alert-rules` · `GET /alert-rules/:ruleId` | read | filters `environmentId`, `enabled` |
| `POST /alert-rules` · `PATCH /alert-rules/:ruleId` · `DELETE /alert-rules/:ruleId` | admin | `PATCH` takes any subset of the fields; `409` on a concurrent edit or duplicate name |
| `GET /alert-channels` | read | no secrets, `urlDisplay` only |
| `POST /alert-channels` · `PATCH …/:channelId` · `DELETE …/:channelId` | admin | body `{ type: "webhook", name, url, signingSecret, enabled?, rateLimitPerMinute? }` |
| `POST /alert-channels/:channelId/test` | admin | `{ ok, status, message, delivery }` |
| `GET /alert-silences` · `POST /alert-silences` · `DELETE /alert-silences/:silenceId` | read / admin | `{ comment, startsAt, endsAt, matchers }` |
| `GET /incidents` | read | filters `status` (`active`, `open`, `acknowledged`, `resolved`), `severity`, `ruleId`, `environmentId` |
| `GET /incidents/:incidentId` · `GET …/deliveries` | read | detail with timeline; delivery log |
| `POST /incidents/:incidentId/acknowledge` · `…/resolve` · `…/comments` | engineer | bodies `{ note? }`, `{ note? }`, `{ body }`; `409` when the state does not allow it |

Example:
```bash
curl -b cookies -H "x-csrf-token: $CSRF" -H "content-type: application/json" -X POST "$API/api/v1/projects/$P/alert-rules" -d '{
  "name": "Checkout 5xx burst", "severity": "critical", "environmentId": "'$ENV'",
  "query": { "kind": "logs", "errorsOnly": true, "services": ["checkout"], "filters": [{ "field": "httpStatus", "op": "gte", "value": 500 }] },
  "condition": { "op": "gt", "threshold": 20 }, "windowSeconds": 300, "forSeconds": 120, "resolveAfterSeconds": 300, "intervalSeconds": 60,
  "noDataPolicy": "keep", "channelIds": ["'$CHANNEL'"] }'
```

## Honest limits
Not built: **e-mail, Slack, Teams, PagerDuty/Opsgenie** (webhook only) · anomaly/ML detection · escalation policies · on-call schedules · multi-condition rules · percentile aggregations ·
cross-environment or cross-project rules · webhook body templating · recurring maintenance windows · SLO/burn-rate alerts · exactly-once delivery · a rule "preview". Other caveats are listed in ADR-0006:
log counts use event time; a metric that did not report looks like "no data"; missed evaluations (worker down) are not replayed; the window is up to a minute longer than configured.

### Measured limits
Collections: 3 new (`alert_config`, `incidents`, `alert_deliveries`); Atlas free tier counts: 22 declared + `schema_migrations` + 3 = **26 of 500**.
Evaluation throughput (one worker, in-memory `mongod` on the same laptop, real metric and log stores; reproduce with `pnpm --filter @nexus/alerting bench`; raw numbers in [performance-alerting.json](performance-alerting.json)):

Dataset: 1,000 rules (70 % metric, 30 % log; 20 % of the metric rules grouped by service) over 10 projects, each with 20 series x 60 minutes of metrics and 5,000 log records, 15-minute windows; no rule fires (state writes only).

| Setting | Rules/s | Store query p50 / p95 / max (ms) | One tick (50 rules) p50 / max (ms) |
|---|---|---|---|
| 1 worker, concurrency 1 | 30.0 | 5.8 / 19.1 / 73.8 | 1,698 / 1,798 |
| 1 worker, concurrency 4 (**the default**) | 92.9 | 8.5 / 28.0 / 82.7 | 537 / 725 |
| 1 worker, concurrency 8 | 115.6 | 18.8 / 53.4 / 132.6 | 393 / 693 |
| 2 workers, concurrency 4 each | 127.6 | 13.5 / 39.8 / 135.4 | 727 / 1,043 |

At the default setting that is roughly **5,500 rules at a 60 s interval (1,400 at 15 s) per worker** for rules of this cost (92.9 rules/s x interval). Opening or closing an incident adds a transaction (about two writes plus the audit event) and is not included; neither is delivery time.
Scaling is sub-linear: two workers gained about 10 % over one worker at concurrency 8 because both share one `mongod` on the same machine, so the database, not the worker, is the limit here. Heavier rules (longer windows, free-text log filters, wide groupBy, many series) cost more per evaluation; the 10 s per-rule budget and the 50-rule tick bound keep one expensive rule from delaying the rest.

The worker keeps draining while a backlog exists (each tick is still bounded to `ALERT_MAX_RULES_PER_TICK` = 50 rules and a 10 s budget per rule), so the practical limit is rules per second × interval.
These numbers are for an idle development machine with the database next to the worker; a hosted database adds round-trip time to every query, so measure in your environment before relying on them.
