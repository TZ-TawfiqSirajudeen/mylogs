# ADR-0007: Metric rollups (5-minute and 1-hour tiers)

Status: accepted. Extends ADR-0005 (traces and metrics storage). Measurements: [performance-traces-metrics.md](../performance-traces-metrics.md), "Round 3".
Code: `packages/metricstore/src/rollup.ts` (planner and compactor), `store.ts` (write marker, planner use), tests `rollup.test.ts`.

## Context
ADR-0005 stores metrics as one document per series per minute and answers every query by aggregating those documents inside MongoDB. Round 2 measured the
consequence: cost is linear in (window) x (series). Queries over all series stopped being interactive at 24 h (p99 across 600 series: 3.9 s; HTTP overview: 7.6 s;
the production scan guard refuses them) and a 7 d window over one service took 3.8 s. The 3 h HTTP overview also missed its 1 s target (1.15 to 1.59 s p95).
Round 2 listed "pre-aggregated rollups" as the lever and as too risky without a design of its own: this is that design.

## Decision
Keep the minute documents as the single source of truth and add **two coarser, disposable copies** of them, behind the unchanged `MetricStore` interface:

| | |
|---|---|
| Tiers | **5 minutes** and **1 hour**. 5 min divides every window of 5 min or more, so it serves 6 h to 2 d windows; 1 h serves anything from 25 min steps up (7 d: 168 buckets per series instead of 10,080). A 15-minute or 30-minute tier would only matter for windows the 5-minute tier already serves in well under a second (measured), and each tier costs another range of documents. |
| Storage | **one new collection `metric_rollups`** (both tiers; `tier` is a field), same field names as `metric_points` (`minute` = bucket start) so the same aggregation pipeline reads both. One new index per query shape `{seriesId, tier, minute}`, a TTL index, and one **partial** index on `metric_series.rollFrom`. Collections 23 to **24**, indexes +3 (Atlas free-tier limit: 500). Migration v30 (the number is reserved on purpose, not contiguous). |
| What a bucket holds | count, sum, min, max, newest value by timestamp (gauges), the **exact sum of the histogram bucket counts** (so percentiles are computed from the merged distribution, identical to the minute-document computation, never a percentile of percentiles), the newest minute that had data, up to five exemplars of the newest minute, `expireAt` = the latest `expireAt` of its minutes. Rates, resets and temporality were already resolved at ingest (cumulative to delta), so a rollup of increments is an increment. |
| Step snapping | A window must be a whole number of buckets. Automatic steps are rounded **up** to 5 minutes (from 3) and to 1 hour (from 25 minutes): 24 h uses 5-minute windows (was 4), 7 d uses 1-hour windows (was 26 minutes). A step the caller asked for is kept as asked. Short windows (up to about 3 h at one point per minute) are unchanged. |
| Overview timeline | The HTTP overview timeline now has about 48 points for windows longer than 90 minutes (3 h: 5-minute windows instead of 1-minute ones; 24 h: hourly). This is a product change taken to make the target reachable; it is what lets the overview read rollups. Up to 90 minutes it stays at one point per minute. |

### Freshness and late data: a marker in the write path, a compactor outside it
The write path must not regress and must not be able to make a rollup wrong. Measured alternatives: updating two rollup documents per series per request in the same
transaction would add about two database operations per series to the roughly two the path already costs (about 0.3 ms each, independent of document size, ADR-0005 / Round 2),
that is, by that arithmetic (an estimate from the measured per-operation cost, not a separate experiment), up to **-50 % ingest** against a path that was already 2x below its target. Not acceptable. A compaction job without any hint from the write path would have to
rescan everything to find late data. So:

1. **Marker.** In the same series update the write path already makes (same operation, same transaction as the minute documents) it adds `$min: { rollFrom: <earliest minute of the request> }`.
   The series document is the atomic, durable "something changed from minute X on". A concurrent writer of the same series conflicts on that document and retries (already the case); there is no new operation.
2. **Compactor** (`MetricRollupCompactor`, runs in the worker every 30 s, `METRIC_ROLLUP_INTERVAL_MS`). It finds series whose marker lies before the sealed boundary (a bucket is rolled up once it ended 2 minutes ago; this is an optimisation, not a correctness rule), and per series:
   claims it with ONE atomic update (marker moves to `rollWork`, `rollFrom` becomes a sentinel year 9999 so the pending index still finds it if the claimant dies, a lease is set),
   **recomputes** every bucket from the first changed one to the sealed boundary from the minute documents (a bucket is replaced by its recomputation, never incremented: idempotent, no double counting),
   and finally publishes `rolled5` / `rolled60` (coverage watermark) and releases the claim. A write that arrived meanwhile re-set `rollFrom`, and that marker survives the release.
3. **Planner** (`planGroups`). A reader trusts a rollup only **below `min(rolled, floor(earliest pending marker))`** of each series and reads minute documents for everything above and for the unaligned edges of the window.
   So a late point, a crashed compactor, a half-finished backfill, a rebuild in progress, or a series that was never rolled up can only make a query slower, never wrong. A series that has no minute document above its coverage is treated as fully covered (quiet series cost nothing).
   The plan covers [from, to] with at most five pieces per group (minute documents at the edges, 5-minute buckets, 1-hour buckets, minute documents above the coverage); series with identical plans share one group, at most three plans per query (the rest read minute documents).

Every tenant boundary is untouched: rollup documents carry organization, project and environment; a query reaches them only through the series ids it already resolved inside the caller's scope. Cardinality limits are enforced where series are created (unchanged) and a rollup cannot exist without its series.

### Backfill, resume, retention
* **Backfill** (series that existed before rollups): `markUnrolled()` marks every series without coverage; the compactor processes them from their first minute document in chunks of one day (5 min tier) or one week (1 h tier). It runs at worker start and every 30 minutes. `requestRebuild(filter)` is the operator repair: coverage is dropped (queries read minute documents at once) and rebuilt, removing buckets whose minute documents are gone.
* **Resumable and idempotent**: the claim carries a lease (5 minutes); after a crash another run takes the series over, starting again from `rollWork`. Running a compaction twice, or rebuilding, yields identical documents (tested). Progress is persisted per series (a series is published only when complete), so a crash re-does at most one batch.
* **Retention**: a bucket expires with the latest of its minute documents (`expireAt` = max), i.e. the same per-token retention as the data it summarises; both tiers have the same TTL index. At the very edge of the retention window a bucket may therefore still hold a few minutes the minute documents no longer have (never the other way round). Longer retention for coarse tiers would be a one-line change (`expireAt`) and a policy decision; it is not made here.

## Consequences
* 24 h and 7 d windows over all series become interactive and are allowed by the scan guard (the guard counts the documents actually read: rollup buckets). Numbers in the performance document.
* Storage: one rollup document per series per 5 minutes and per hour: about 1/5 + 1/60 of the minute documents' count (see the performance document for measured sizes). Write path: one extra field inside an existing update (measured, same document).
* New moving part: a compactor. If it stops, nothing breaks: coverage stops advancing and queries read minute documents (the behaviour of Round 2). `diagnostics` and the worker log show claims; `pending()` counts the backlog.
* A 1-hour step is the coarsest automatic step now, so a 7 d chart has 168 points.
* Limits that remain: percentiles inside a 1-hour bucket keep bucket-boundary resolution as before (they are estimated from bucket counts); the newest-value rule for gauges is by timestamp as before; exemplars of a rollup bucket are those of its newest minute (the minute path returned those of an arbitrary series in that minute: neither is "the" exemplar). Series with more than three distinct coverage states in one query fall back to minute documents for the rest. A single-node, single-collection design does not remove the linear cost at, say, 100,000 series: the ClickHouse path of ADR-0005 stays the answer for that scale.

## What was tried and rejected
* Updating rollups in the write path (see above: -50 % ingest).
* A rollup per series per day: 24 h windows need 5-minute resolution anyway; a 1-day tier does not change any measured query.
* A generic "last compacted timestamp" per collection instead of a per-series marker: late data older than the watermark is exactly what such a scheme loses.
* Reading a series' coverage from the rollup collection (max bucket): costs a query per series; the series document is already in memory at planning time.
