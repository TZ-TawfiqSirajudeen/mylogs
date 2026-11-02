# Runbook: using MongoDB Atlas (hosted MongoDB) with Nexus

Two different things get called "using Atlas". Keep them apart:

1. **Atlas as the platform's own database** (`MONGODB_URI` of the API, the ingestion service and the worker).
2. **An Atlas cluster as a monitored data source** (Data Sources → Add data source → MongoDB).

## What was and was not verified

| Claim | Status |
|---|---|
| The platform started against an Atlas `mongodb+srv://` URI, connected and authenticated, and began its migrations | observed once |
| It then **stopped** with `cannot create a new collection -- already using 500 collections of 500`: the cluster tried was a free/shared tier at its collection cap, so the platform's collections could not be created and the app never became usable on it | observed |
| The platform has been run end to end (migrations, UI, ingestion) on Atlas | **no, never** |
| The MongoDB **connector** (monitoring) against a real 3-member Atlas replica set: all members connected, authenticated and answered `ping`, `buildInfo`, `hello`, `serverStatus`, `replSetGetStatus` and `listDatabases` (MongoDB 8.0, read-only commands) | verified **by hand once**, not part of the automated suite |
| Atlas network allow-list behaviour, tier limits other than the 500-collection message, TLS settings of other Atlas tiers | not verified here: check Atlas's own documentation for your tier |

## 1. Atlas as the platform database

* **Room for the collections.** The platform creates about 23 collections (the 22 defined in `packages/database/src/models.ts`, including `audit_events`, plus `schema_migrations`;
  later phases may add more) and several indexes on them. Collection caps on hosted tiers apply to the **cluster**, so collections in *other* databases on the same cluster
  most likely count against the cap (an inference from the error message: confirm in the Atlas UI). Use a cluster with room, or a dedicated cluster, or a tier without
  that cap. Do not delete collections you do not own to make space.
* **Replica set.** The platform needs a replica set (multi-document transactions). Atlas clusters are replica sets; this is general MongoDB knowledge, not something verified here against this app.
* **Database user and roles.** Create a dedicated user for the platform (not an admin user). The roles are in [mongodb-roles.md](mongodb-roles.md): the role definition there names the
  database `nexus`; change it if you set a different `MONGODB_DB`. Migrations create collections and indexes at startup, so the first start needs `createCollection`/`createIndex`
  (or run migrations once as a deploy step with a privileged user).
* **Network access.** Add the IP address of every machine that runs the API, the ingestion service or the worker to the Atlas **Network Access** list (IP access list). Without an entry the connection fails or times out.
* **Same database everywhere.** The API, the ingestion service and the worker must use the same `MONGODB_URI` and `MONGODB_DB`, or the ingestion service will not see the tokens the API creates.
* **Where the URI goes.** Development: the gitignored `.env` in the repository root (the `dev` scripts read it). Production: your platform's secret manager. **Never** put the URI, its password or any other credential in
  `.env.example`, `docker-compose.yml`, a test fixture, a README or a chat message. Use `<user>:<password>@<cluster>` placeholders in anything committed.
* **If a real credential was committed or pasted anywhere: rotate it in Atlas now** (Database Access → edit the user → new password), then purge it from git history if the commit was pushed.
  Rotating is the fix; deleting the text afterwards is not.
* **Performance.** Every write crosses the internet. The benchmark numbers in [performance-traces-metrics.md](../performance-traces-metrics.md) were measured against a local `mongod` and are not representative of Atlas.

### Measured facts (read-only probe, 2026-10-31)

A read-only probe (commands used: `hello`, `buildInfo`, `ping`, `connectionStatus`, `listDatabases`, `listCollections`, `listIndexes`, `count`; no writes, no migrations) was run against the two clusters this
project was pointed at. Host names, user names and passwords are deliberately not recorded here.

| Fact | Cluster 1 (the one the app first tried) | Cluster 2 (test cluster) |
|---|---|---|
| MongoDB / topology | 8.0.36, replica set, 3 members, TLS, sessions supported (`logicalSessionTimeoutMinutes` 30) | same |
| Supplied user's role | `atlasAdmin` (has insert, update, remove, createCollection, createIndex, dropCollection, ...) | same |
| Collections visible (all databases) | **501**, of which 1 is `local.startup_log`; **500** in user databases | **381**, of which 1 is `local.startup_log`; **380** in user databases |
| Distance from the observed 500 cap | **0**: this is exactly the cap that produced `already using 500 collections of 500` | **120** collections of headroom (if the same cap applies; the tier is not proven by any command) |
| Nexus database `nexus` | exists with **5** collections left by the aborted migration (`organizations`, `users`, `org_memberships`, `projects`, `schema_migrations`), all empty | does not exist |
| Would Nexus fit? | **No.** It needs 23 collections; 18 more cannot be created | **Yes by count** (23 needed, 120 free) |
| App connect path (`connectDatabase(..., { migrate: false })`, ping) | ping ok | ping ok |

What the aborted migration left behind on cluster 1 matches the code exactly: the migration creates collections in order and swallows `createCollection` errors, so the failure surfaced at the first `createIndex`
on a collection that could not be created: `environments`, the fifth application collection (`schema_migrations`, which holds the migration lock, is created first and is the fifth collection that exists). `org_memberships` has both its indexes, `projects` has its one, and `environments` does not exist. `schema_migrations` has no migration record, so a restart simply retries and fails at the same place.
Nothing was written to either cluster by this verification; the 5 collections on cluster 1 are from the earlier failed start.

What Nexus creates (measured by running the migrations on a throwaway local `mongod`, not on Atlas): **23 collections, 73 indexes** (50 besides the automatic `_id` index). Later phases that add collections raise the first number.

How the connect path behaves (read from `packages/database/src/client.ts`, and the `ping` above): `mongodb+srv://` is resolved by the driver (SRV + TXT) and implies TLS; the app sets `retryWrites: true`, `writeConcern: { w: 'majority' }`
and `serverSelectionTimeoutMS: 5000`; multi-document transactions use `readConcern: snapshot` + `majority` and require a replica set (both clusters are). **`connectDatabase` runs the migrations by default** (`migrate !== false`), so
merely connecting with the app's normal code creates collections. A transaction was **not** exercised on Atlas (no command was allowed that could write).

### Verification procedure (requires approval)

Running the platform end to end on Atlas has never been done. It writes data, so **do not run it without the owner of the cluster approving**: which cluster, and the database name.

1. **Approval.** Record who approved which cluster and the database name (this procedure uses `nexus_verify`). Check headroom first: collections in user databases + 23 must be at most 500 on a capped tier. Cluster 1 above fails this check; cluster 2 passes it.
2. **A dedicated, limited user.** Atlas → Database Access → add a user (for example `nexus_verify_app`) with the built-in role `readWrite` on database `nexus_verify` **only** (it includes `createCollection`, `createIndex`, `insert`, `update`, `remove`, `find`).
   Do not use an `atlasAdmin` user for the app.
3. **Network access.** Atlas → Network Access → add the current public IP address (temporary entry).
4. **Run with shell variables** (they override the gitignored `.env`, which is left untouched). In three PowerShell windows from the repository root:
   ```powershell
   $env:MONGODB_URI = "mongodb+srv://nexus_verify_app:<password>@<cluster-host>/?retryWrites=true&w=majority"
   $env:MONGODB_DB  = "nexus_verify"
   pnpm --filter @nexus/api dev --seed     # window 1: runs the migrations (creates 23 collections), seeds the demo users into nexus_verify
   pnpm dev:ingest                         # window 2
   pnpm --filter @nexus/worker dev         # window 3 (optional)
   ```
   Stop the local API/ingest first if they hold ports 4000/4318 (they use the local MongoDB, not Atlas).
5. **Check.** `http://127.0.0.1:4000/healthz` and `http://127.0.0.1:4318/healthz` answer 200; in Atlas → Browse Collections, `nexus_verify` shows 23 collections; sign in as the demo owner in the web app, create a project and an ingestion token, send a few OTLP records,
   and confirm they appear in Logs/Traces/Metrics. Note any step that fails; record the real result in `docs/STATUS.md`.
6. **Clean up (only what you created).** Stop the three processes; drop **only** the database `nexus_verify` (Atlas → Browse Collections → drop database, or `mongosh` with the limited user: `use nexus_verify` then `db.dropDatabase()`);
   delete the `nexus_verify_app` user; remove the temporary IP access entry; close the PowerShell windows (the variables vanish with them). Do not delete or modify any other database on the cluster.

## 2. An Atlas cluster as a monitored data source

* In the wizard, step "Details", paste the connection string from Atlas (Connect → Drivers) into the **Connection string** box and choose "Fill the form from it". The browser reads the string;
  for `mongodb+srv://` only the cluster's DNS name is sent to the API, which looks up the member hostnames (SRV) and the `authSource` (TXT). The user name and password never leave your browser
  except in the normal write-only credential submission.
* The connector monitors **each member individually** (`directConnection`), so the form lists every member hostname the DNS lookup found (at most 7).
* Use a dedicated monitoring user with only the `clusterMonitor` role (see the wizard's "Permissions" step). The connector sends only read-only monitoring commands and never reads collection contents.
* The platform's server must be allowed through the cluster's IP access list, and (in production) the network policy must permit public addresses (the default) — loopback/private targets are refused unless explicitly allowed.
* A connected MongoDB source is verified and health-monitored. Whether it **collects** metrics yet is stated in `docs/STATUS.md` ("Phase 5"); do not assume it does.
