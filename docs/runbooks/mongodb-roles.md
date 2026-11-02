# Runbook: MongoDB roles for the platform itself

The control plane needs **a replica set** (multi-document transactions). Use dedicated users; never the root user.
The role definitions below are verified against a real auth-enabled `mongod` by `packages/database/src/roles.test.ts`.

## API / worker user: append-only audit trail
MongoDB roles are additive, so a database-wide grant would also cover `audit_events`. Grant the application role **per
collection**, and give `audit_events` its own insert/find-only role:

```js
use admin
db.createRole({
  role: "nexusApp",
  privileges: [
    "organizations", "users", "org_memberships", "projects", "environments", "project_memberships",
    "sessions", "counters", "secrets", "connections", "schema_migrations",
    "ingest_tokens", "logs", "ingest_stats", "saved_queries", "query_history", "auth_flows",
    "spans", "trace_summaries", "metric_series", "metric_points", "metric_rollups", "services"
  ].map(c => ({
    resource: { db: "nexus", collection: c },
    actions: ["find", "insert", "update", "remove", "createIndex", "createCollection", "dropIndex"]
  })),
  roles: []
})
db.createRole({
  role: "nexusAuditAppendOnly",
  privileges: [{ resource: { db: "nexus", collection: "audit_events" }, actions: ["find", "insert", "createIndex", "createCollection"] }],
  roles: []
})
db.createUser({ user: "nexus_app", pwd: passwordPrompt(), roles: ["nexusApp", "nexusAuditAppendOnly"] })
```

Verified outcome: the app user can insert/read audit events but `updateOne`, `deleteOne`, `deleteMany` and `drop` on
`audit_events` fail with "not authorized". When a new collection is added to the platform, add it to `nexusApp` — `packages/database/src/roles.test.ts` fails if this list and the code disagree.

The **ingestion service** and the **worker** use the same role (they read/write `logs`, `spans`, `trace_summaries`, `metric_series`, `metric_points`, `metric_rollups`, `services`, `ingest_*` and `connections`). Migration v6 (Phase 4) only creates the
span/metric/service collections and their indexes (`createCollection`, `createIndex`; rollback uses `dropIndex`). Migration v5 backfills `logs.searchText`
with `update` and replaces an index (`createIndex` + `dropIndex`), all covered above; on a large `logs` collection run it as a deploy step with a privileged user.

Migrations create collections and indexes at startup, hence `createIndex`/`createCollection`. A stricter option is to run
`migrateUp` as a deploy step with a privileged user and run the API/worker with only `find/insert/update/remove`.

## Backup user
A separate built-in `backup` role used only by the backup job. Backups contain ciphertext and wrapped keys for credentials
(see the secrets runbook); back up the KEK separately in your secret manager.

## Connection strings
Pass `MONGODB_URI` from your secret manager. Configuration errors never echo it. In development it comes from the gitignored root `.env` (never from `.env.example` or any committed file).
For a hosted cluster such as MongoDB Atlas (database users, IP allow-list, collection limits) see [atlas.md](atlas.md).
