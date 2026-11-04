# Alerting and incidents

Decision record: [ADR-0006](architecture/ADR-0006-alerting-incidents.md) · Operations: [runbooks/alerting.md](runbooks/alerting.md)

This is the **first slice** (plus rule preview and incident links, see below): threshold rules on metrics and log counts, incidents with a timeline, and **webhook**, **Slack** and **e-mail** notifications ([ADR-0008](architecture/ADR-0008-notification-channels.md)). There is no
PagerDuty/Opsgenie, Teams, anomaly detection, escalation policy or on-call schedule yet (see [Limits](#honest-limits)).

## Concepts
| Term | Meaning |
|---|---|
| **Rule** | A question asked at a fixed interval about **one environment**: *a metric aggregate* or *a log count* over a window, compared with a threshold. |
| **Group** | A rule may evaluate separately per value of one label (for example per `service`). Each group has its own state and its own incident. A rule without grouping has one group. |
| **State** | `ok -> pending -> firing -> resolved`, per group. *Pending*: the condition holds but not yet for the whole "must hold for" time. *Firing*: an incident is open. |
| **Incident** | Opened when a group fires; **at most one live incident per rule and group** (enforced by the database). Statuses: `open`, `acknowledged`, `resolved`. Has a timeline. |
| **Channel** | Where notifications go: a signed **webhook**, a **Slack** incoming webhook or **e-mail** over SMTP. All three share the same queue, retries, silences, rate limit and audit. |
| **Silence** | A time window that suppresses notifications (not incidents) for matching rules, severities or environments. |
| **Maintenance window** | Like a silence, but **recurring** (weekly, in an IANA time zone, daylight-saving aware) or one-off. Same matchers; evaluation and incidents continue, notifications are suppressed and recorded. |

## Who can do what
| Action | Viewer | Engineer | Project admin (and org owner/admin) |
|---|---|---|---|
| Read rules, incidents, channels (no secrets), silences | yes | yes | yes |
| Acknowledge, resolve, comment on incidents | no | **yes** | yes |
| Create/edit/enable/disable/delete rules | no | no | yes |
| Create/edit/delete channels, send tests, manage silences and maintenance windows | no | no | yes (unrestricted access only) |

A user restricted to some environments only sees and changes rules and incidents of those environments; channels, silences and maintenance windows are project-wide and
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

### Missed evaluations (worker down, lease expired)
The rule is evaluated by the worker. If the worker was not running (or a lease expired and nobody picked the rule up), evaluations are **missed**: with interval `I`, a claim that finds the rule more than one interval overdue has `floor(late / I)` missed boundaries. Being a few seconds late misses nothing.

| `missedPolicy` | What happens at the next claim |
|---|---|
| `skip` (default) | Only the evaluation for *now* runs, exactly as before; the missed boundaries are **counted** (`missedEvaluations.skipped`). A breach that happened and ended during the outage is never seen, and a `for` duration only starts counting at *now*. |
| `replay` | The **latest N** missed boundaries (`maxReplayEvaluations`, 1-20, default 5) are re-evaluated **oldest first**, each with its query window ending **at that boundary** (event time), through the same state machine with the boundary as its clock. Then the evaluation for now runs. Incidents opened or resolved by a replayed boundary carry that boundary's time (`openedAt`, timeline `at`) and the timeline event data `replayed: true`, `evaluatedAt` (the boundary), `processedAt`. Older missed boundaries beyond N are counted as skipped. |

Properties: replay progress is saved after **every** boundary (a crash resumes at the next one; the lease is renewed on each save); a worker that lost its lease, or a rule edited meanwhile, makes the next save match nothing and the replay **stops without writing**; incident creation stays idempotent through the unique `(rule, group)` index, so two workers can never leave two live incidents. A replayed evaluation that fails changes nothing and counts as skipped; a total replay time budget (twice the per-rule budget) bounds the work.

**No notification storm.** A replayed transition older than `staleNotificationSeconds` (0-86,400 s, default 900) is recorded as a delivery with status **`stale`** and a `notification_suppressed` timeline event (`reason: stale`) and is **not sent**. Younger ones are sent normally (silences, maintenance windows and the channel rate limit still apply). To avoid being *quieter* than `skip` for a real ongoing problem, an incident that is **still firing** after the replay gets **one catch-up notice** (`incident.opened` with `catchUp: true` in the payload), and an incident that **had been announced** and recovered during the outage gets one catch-up `incident.resolved`. The worst case is one notice per incident, never one per replayed transition. A crash in the middle of a replay can lose that catch-up notice (the incident and its stale records stay visible).

The rule list shows *N missed (R replayed, S skipped), last ...*; the API has `missedEvaluations { total, replayed, skipped, lastAt }`, and the worker exports `nexus_alert_evaluations_missed_total`, `nexus_alert_evaluations_replayed_total` and `nexus_alert_catch_up_notices_total`. Replay is a catch-up of *evaluations*, not of notifications: it uses today's stored data at those past times (late-arriving records are included).

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

### Previewing a rule against history
In the rule form, **Preview** replays the *draft* (exactly what Save would store) over the last hour, 6 hours (default) or 24 hours of stored data and shows what it would have done. Nothing is created: no rule, no incident, no notification, no audit event. Decision record: [ADR-0009](architecture/ADR-0009-rule-preview-and-incident-links.md).

* **What you see:** a sentence ("this rule would have opened N incidents in the last 6 h, in M groups"), a chart per group with the threshold line and the **pending** and **would fire** periods shaded (the periods are also listed as text, and the chart has a table of every evaluation time, value and state behind it), and plain-language notes.
* **How it works:** for every evaluation time of the range the server runs the *same* evaluator the worker runs (`evaluateQuery`) with that time as the clock, and folds the results through the *same* state machine (`step`): "must hold for", the clear period before resolving, flapping protection and the no-data policy all apply. There is no second implementation of the threshold logic.
* **Evaluation times:** the rule's check interval, widened so a range never needs more than 200 evaluations (24 h at a 15 s interval is replayed every 7 min 15 s; the notes say so, because "must hold for" times are then only accurate to that step).
* **No data:** a point without data is shown as a gap (never as zero). The notes say how many points had no data and what your no-data policy did with them (kept the state, counted as healthy, counted as a problem). If there is no data anywhere in the range the panel says so instead of "would not fire".
* **What it is not:** a plausibility check, not a replay of what the live rule saw. It reads *today's* stored data at past times (late-arriving records are included), it starts from "ok" (a problem already under way at the start of the range looks as if it began there), and silences, notification channels and the group-tracking history of a live rule are not part of it. A failed evaluation point is skipped and counted (like a live failure it changes no state); a query the store refuses (for example an aggregation the metric type does not support) fails the preview once with the store's message.
* **Limits:** range 5 min – 24 h (default 6 h); at most 200 evaluation points, 4 evaluations at a time, 400 store queries and 15 s for the whole preview (a result cut short is returned as *partial* with a note); at most 2 previews at the same time per API process (`429 busy`) and 10 requests per minute per session. The store's own protections (series scanned, point documents scanned, query time-out) apply to every query. Same access as creating a rule: project admins, and only for environments in their scope (`404` otherwise).

Measured cost (`pnpm --filter @nexus/alerting exec tsx bench/preview-bench.ts`; in-memory `mongod` on a laptop next to the API, 20 series x 24 h of minute data, 20,000 logs, rollups off; third run of each, so caches are warm; one run, not a statistical benchmark):

| Scenario (15-minute window, 1-minute interval) | Evaluation points | Store queries | Elapsed |
|---|---|---|---|
| metric `max`, ungrouped, 6 h | 199 | 199 | 0.7 s |
| metric `max`, ungrouped, 24 h | 199 | 199 | 0.9 s |
| metric `avg` (two queries per point), 6 h | 199 | 398 | 1.2 s |
| metric `max` grouped by service (20 groups), 6 h | 199 | 199 | 4.1 s |
| metric `max` grouped by service (20 groups), 24 h, 1 h window | 199 | 199 | 7.0 s |
| logs, errors only, 6 h | 199 | 199 | 0.5 s |
| logs, free text, 24 h | 199 | 199 | 0.2 s |

Wide groupings over long windows are the expensive case (7 s of the 15 s budget here, with the database next to the API); a hosted database adds round-trip time to every one of the queries, so a slow preview is expected to end *partial* rather than fail.

## Incidents
Timeline events: `opened`, `notified`, `notification_failed`, `notification_suppressed` (silence, maintenance window, stale replay or rate limit), `acknowledged`, `resolved` (by a person),
`auto_resolved` (recovery, or the rule was changed/disabled/deleted), `comment`. The newest 500 events and up to 100 comments are kept per incident.
Resolved incidents are deleted 90 days after resolution.

### Related telemetry on an incident
The incident page has a **Related telemetry** panel (ADR-0009). It reads the incident's rule and builds links; it needs no extra permission (everyone who can read the incident sees it) and the pages it opens authorize the person who opens them.

* **Window:** from the start of the rule window that produced the first breaching value (opened − window) until the incident was resolved (or *now* for a live incident); at least 5 minutes and at most 24 hours.
* **Log-count rules:** a link to the **Logs Explorer** pre-filled with the rule's own filter (text, severity or errors-only, services, field filters such as `httpStatus >= 500`), the rule's environment and the window.
* **Metric rules:** a link to the **Metrics explorer** with the metric, aggregation, service, label filters (plus the incident's group labels), the environment and the window (the explorer accepts `range=custom&from=…&to=…&env=…`), and, when the rule or its group names a service, a link to the **Traces explorer** for that service's failed traces in the window. **Up to 5 example traces** are listed: exemplars of the metric first (explicit references the sender attached to measurements), otherwise failed traces of the same service in the window.
* **Wording:** every example list says *"A sample from the window, not proof of cause"*: these are traces that were recorded and received in that window and may be unrelated to the incident (same policy as the metric and service pages). If no exemplars or failed traces exist the panel says so. If the rule has been deleted, the panel says that no links can be built.
* **What the links carry:** only the project id, the environment id, the rule's own filters and UTC times. Never tokens, secrets, webhook data or session information.

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

## Slack channels
Decision record: [ADR-0008](architecture/ADR-0008-notification-channels.md).

1. **Create** (project admin): in Slack create an *Incoming Webhook* for the channel you want and paste its URL. Body: `{ "type": "slack", "name": "...", "url": "https://hooks.slack.com/services/..." }`.
   The URL **is the credential** (its path is a bearer token), so it is stored envelope-encrypted, is **write-only** (never returned, never in the audit log or the UI) and responses show only `https://hooks.slack.com/…`. To rotate: `PATCH` a new `url`.
   There is no signing secret for Slack. Any Slack-compatible receiver (for example Mattermost) works, because the safety control is the network guard, not a host allow-list.
2. **What Slack receives:** a Block Kit message: a header (`Firing: <title>` or `Resolved: <title>` with a severity marker), a field grid (severity, status, rule, condition, value, group labels), a context line with the incident id and time, and a **View incident** button (when the worker has `WEB_ORIGIN`); plus a plain-text fallback for notifications. Every value from telemetry is escaped (`&`, `<`, `>`), so a label such as `<!channel>` or `<https://evil|click>` is shown as text and cannot ping anyone or create a link. Texts are truncated to Slack's block limits.
3. **Send test** works like webhooks (5 per minute, one attempt, recorded) and posts a short test message.
4. **Delivery:** the same queue, retries (30 s, 2 min, 10 min, 30 min; 5 attempts), silences, rate limit and audit as webhooks. Slack's answers map to: `2xx` delivered; `429`, `408`, `5xx` retried; other `4xx` (for example `404 no_service` after the webhook was revoked, `403 action_prohibited`) fail at once; redirects and TLS errors fail at once. The Slack response body is never stored or shown.

## E-mail channels
1. **Create** (project admin):
   ```json
   { "type": "email", "name": "On-call mail",
     "smtp": { "host": "smtp.example.com", "port": 587, "security": "starttls", "username": "…", "password": "…" },
     "from": "alerts@example.com", "recipients": ["oncall@example.com", "sre@example.com"] }
   ```
   | Field | Rules |
   |---|---|
   | `smtp.host` | A host name or public IP. Resolved and checked by the platform SSRF guard **when saving and on every send**: private, loopback, link-local and cloud-metadata addresses are refused (an operator may approve internal relays with `NETWORK_ALLOW_PRIVATE_CIDRS`; metadata stays blocked) and the connection is pinned to the validated address. |
   | `smtp.port` | `587` (default), `465` or `2525`. **Port 25 and every other port are refused** outside development. |
   | `smtp.security` | `starttls` (default; the upgrade is **required**: a server that does not offer STARTTLS is a failure, never a silent downgrade), `tls` (implicit TLS, usually 465) or `none` (development only: refused unless `NETWORK_ALLOW_INSECURE_HTTP=true`). Certificates are always verified; verification cannot be disabled. |
   | `smtp.username`, `smtp.password` | Optional, both or neither. AUTH PLAIN or LOGIN, **never over an unencrypted connection**. **Write-only**: envelope-encrypted, never returned (the DTO has `hasSmtpCredentials` only), never in logs, errors, the audit trail or the delivery log. Rotate with `PATCH { "smtp": { "username": "…", "password": "…" } }`; remove with `PATCH { "clearSmtpCredentials": true }`. |
   | `from` | One plain address (`name@example.com`). The display name is fixed ("Nexus Observability"). The provider must allow this sender. |
   | `recipients` | 1 to **20** plain ASCII addresses, lower-cased and de-duplicated. No display names, quotes, commas, whitespace or CR/LF (checked in the API contract, again in the service, and again immediately before the SMTP command is written). Readers of the channel list see them **masked** (`o***@example.com`); to change the list send the whole new list. |
2. **What recipients get:** `Subject: [Nexus] CRITICAL: <title>` (or `RESOLVED:`), a `multipart/alternative` message with a **plain-text part and an HTML part** (UTF-8). All dynamic text in the HTML is entity-escaped and the incident link is only used when it is an http(s) URL. Headers `Message-ID` (stable per delivery, so a retry is recognisable), `X-Nexus-Delivery` and `Auto-Submitted: auto-generated` are set. Subjects are stripped of control characters and RFC 2047-encoded when not ASCII, so a title cannot inject a header.
3. **Send test** sends a short test message to every recipient and reports the SMTP outcome (`Delivered (accepted by the SMTP server)` or a failure reason); 5 per minute, one attempt, recorded.
4. **Delivery:** same queue, silences, rate limit, audit and backoff as webhooks. SMTP outcomes: connection errors, time-outs (20 s overall) and `4xx` replies are retried; `5xx` replies, authentication failures, a missing STARTTLS, TLS certificate problems, invalid addresses and blocked targets fail at once. If *some* recipients are refused but at least one accepts, the delivery counts as delivered and says `N of M recipients were refused` (a retry would mail the accepted ones twice). Failure messages carry only the SMTP reply **code** and a fixed sentence, never the server's text.
5. **Limits of the built-in client:** no DKIM signing, no OAuth2 (Gmail/Microsoft 365 need an app password or an SMTP relay), no attachments, no non-ASCII addresses, one delivery row per channel and event (not per recipient). Delivery is at-least-once.

## Silences
A silence has a reason, a start and an end (at most 30 days) and optional matchers: rule ids, severities, environments (all given kinds must match; empty = the whole project). While active, matching notifications are recorded as
`suppressed` (with the silence id) and the incident timeline says so; **incidents are still opened and shown**. Deleting a silence ends the suppression immediately. A project holds at most 50 live silences.

## Maintenance windows
A window has a name, an optional reason, `enabled`, a **schedule** and optional matchers (rule ids, severities, environments; all given kinds must match, empty = the whole project).

| Schedule | Fields |
|---|---|
| `weekly` | `timezone` (an **IANA name** such as `Europe/Berlin` or `UTC`; numeric offsets like `+05:00` are refused because they cannot follow daylight saving), `weekdays` (`mon` to `sun`), `startTime` (local 24-hour `HH:MM`), `durationMinutes` (1-1440) |
| `once` | `startsAt`, `endsAt` (UTC instants, at most 30 days apart, must end in the future); removed a day after it ends |

**Time semantics.** A weekly occurrence **starts at the local wall-clock time** on each listed weekday; its **duration is elapsed real time** and may cross midnight (it belongs to the weekday it starts on). Clock changes: a start time that does not exist (spring forward, e.g. 02:30 when 02:00 jumps to 03:00) is **shifted forward by the length of the gap** (03:30); a start time that exists twice (fall back) uses the **first** occurrence. Because the duration is elapsed time, a "02:00 for 3 h" window ends at 05:00 or 06:00 wall-clock on the clock-change nights.

**Behaviour while active.** Rules are still evaluated and incidents are still opened and shown. Matching notifications are not sent: each is recorded as a delivery with status `suppressed` and the `maintenanceId`, and as a `notification_suppressed` timeline event (`reason: maintenance`). If a silence also matches, the record names the silence. A window counts if it was active when the notification is created **or** (for a replayed transition) when the transition happened. A resolution notice goes only to channels that were told about the opening, so an incident whose opening was suppressed does not send "resolved" either, and **a window ending while such an incident is still firing does not send a late notice** (it stays visible in the UI; use a silence or end the window early if you want to be paged).

The API returns computed fields from the server clock: `state` (`active`, `scheduled`, `expired`, `disabled`), `activeNow`, `currentOccurrence` and `nextOccurrence` (UTC). Limits: 20 windows per project, name unique per project. Every change is an audit event (`alert.maintenance.created`, `.updated`, `.deleted`). In the UI they are on **Channels & silences**: list with an *active now* badge and next occurrence (shown in the window's zone and in UTC), create, edit, enable/disable and delete.

## API
Base: `/api/v1/projects/:projectId`. Session cookie + `x-csrf-token` on writes, like every route. Lists use keyset pagination (`?limit=1..100&cursor=…`, response `{ items, nextCursor }`).
Errors: `400 validation_error` (with field details), `403 forbidden`, `404 not_found` (also for another tenant's objects), `409 conflict`, `422 validation_error | limit_reached`, `429 rate_limited`. The OpenAPI document (`/docs`, non-production) describes every route.

| Method and path | Role | Notes |
|---|---|---|
| `GET /alert-rules` · `GET /alert-rules/:ruleId` | read | filters `environmentId`, `enabled` |
| `POST /alert-rules/preview` | admin (rule's environment must be in scope) | body `{ rule: { environmentId, query, condition, windowSeconds, forSeconds?, resolveAfterSeconds?, noDataPolicy?, intervalSeconds? }, rangeSeconds? }` (300–86400, default 21600). Read-only. Returns `{ from, to, stepSeconds, times[], groups[{ key, labels, values[], states[], periods[], wouldOpen }], totals, partial, notes[] }`; `422 preview_failed` (store refused the query), `504 preview_timeout`, `429 busy` / `rate_limited` |
| `POST /alert-rules` · `PATCH /alert-rules/:ruleId` · `DELETE /alert-rules/:ruleId` | admin | `PATCH` takes any subset of the fields; `409` on a concurrent edit or duplicate name |
| `GET /alert-channels` | read | no secrets; `urlDisplay`, `type`, masked recipients, `hasSmtpCredentials` |
| `POST /alert-channels` · `PATCH …/:channelId` · `DELETE …/:channelId` | admin | body by `type`: `webhook` `{ name, url, signingSecret }` · `slack` `{ name, url }` · `email` `{ name, smtp: { host, port?, security?, username?, password? }, from, recipients }`; all take `enabled?`, `rateLimitPerMinute?`. `PATCH` takes any subset of the fields of the channel's own type (a field of another type is a `422`) |
| `POST /alert-channels/:channelId/test` | admin | `{ ok, status, message, delivery }` |
| `GET /alert-silences` · `POST /alert-silences` · `DELETE /alert-silences/:silenceId` | read / admin | `{ comment, startsAt, endsAt, matchers }` |
| `GET /alert-maintenance-windows` / `GET .../:windowId` | read | computed `state`, `activeNow`, `currentOccurrence`, `nextOccurrence` |
| `POST /alert-maintenance-windows` / `PATCH .../:windowId` / `DELETE .../:windowId` | admin (unrestricted access only) | body `{ name, comment?, enabled?, schedule: { type: "weekly", timezone, weekdays, startTime, durationMinutes } or { type: "once", startsAt, endsAt }, matchers? }`; `409` on a duplicate name or concurrent edit, `422 limit_reached` after 20 |
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
Not built: **Teams, PagerDuty/Opsgenie, SMS** (webhook, Slack and e-mail only; see ADR-0008 for what the e-mail client lacks) · anomaly/ML detection · escalation policies · on-call schedules · multi-condition rules · percentile aggregations ·
cross-environment or cross-project rules · webhook body templating · SLO/burn-rate alerts · exactly-once delivery. Other caveats are listed in ADR-0006:
log counts use event time; a metric that did not report looks like "no data"; with the default `missedPolicy: skip` missed evaluations (worker down) are counted but not replayed (see "Missed evaluations"); the window is up to a minute longer than configured. Maintenance windows are weekly or one-off only (no cron, monthly or holiday exclusions), and replay re-runs at most 20 boundaries per claim. Decision record: [ADR-0010](architecture/ADR-0010-maintenance-windows-and-replay.md); **no migration** was needed (windows are a `kind` in `alert_config`), the declared collection count is unchanged.

### Measured limits
Collections: 3 new (`alert_config`, `incidents`, `alert_deliveries`); Atlas free tier counts: 22 declared + `schema_migrations` + 3 = 26 of 500 when this was measured; with the `metric_rollups` collection (ADR-0007) Nexus now declares 26 + `schema_migrations` = **27 of 500**.
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
