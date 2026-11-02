# Performance: traces and metrics (Phase 4)

Measured with `pnpm --filter @nexus/ingest bench:signals` (`packages/ingest/bench/bench-signals.ts`). Raw numbers: [`performance-traces-metrics.json`](performance-traces-metrics.json)
(the final run), plus the earlier runs kept for comparison.

**What this is:** evidence for one machine and one storage configuration. **It is not a capacity guarantee.**

* Machine: 8 logical CPUs (Intel i7-8650U laptop, 1.9 GHz), 16 GiB, Windows 11, Node 22.17. A single `mongod` 8.2 (WiredTiger, `mongodb-memory-server` defaults) on the same machine as the load generator.
* Ingestion goes through the real in-process pipelines (validate, normalise, redact, quota, bounded retried idempotent write). **HTTP/TLS is not included.**
* Dataset: 20,000 traces / 391,200 spans over 6 h (about 20 spans per trace, 8 services); 600 metric series x 3 h at a 10 s interval = 648,000 data points (3 instances per service).
* The targets were written in the header of the benchmark file **before the first measurement** and were not changed afterwards.

## Results against the targets (final run)

| Measure | Target | Final run | Range over runs | Verdict |
|---|---|---|---|---|
| Span ingestion | >= 5,000/s | 6,119/s | 3,989 to 10,871 | **met, but unstable on this machine** |
| Metric point ingestion | >= 5,000/s | 3,304/s | 1,809 to 3,304 | **missed** |
| Trace lookup by id, p95 | < 50 ms | 4.8 ms | 4.8 to 8.6 | met |
| Waterfall load, 432 spans, p95 | < 100 ms | 21.9 ms | 21.9 to 45 | met |
| Trace search (recent / filtered), p95 | < 250 ms | 5 to 22 ms | up to 57 | met |
| Slowest-first search, p95 | < 500 ms | 6.2 ms | 6 to 13 | met |
| Deep page after 1,000 traces, p95 | (no target) | 20.6 ms | 20 to 73 | n/a |
| Per-service span statistics (6 h), p95 | < 1,500 ms | 436 ms | 436 to 1,927 | met (was missed before optimisation) |
| Observed dependencies (6 h), p95 | < 1,500 ms | 1,245 ms | 514 to 1,479 | met, **close to the limit** |
| Grouped metric query (3 h), p95 | < 500 ms | 628 ms (rate by service) | 628 to 720 after optimisation | **missed** |
| HTTP service overview (3 h), p95 | < 1,000 ms | 1,379 ms | 1,379 to 2,661 | **missed** |
| p99 across everything (3 h) | (no target) | 1,351 ms | 1,089 to 2,800 | n/a, slow |

Other results from the final run:

* Mixed load (8 concurrent readers while ingesting for 5 s): reader p50 46 ms, p95 66 ms, ingestion continued at 639 spans/s (the concurrent readers and the writes share one `mongod`).
* Backpressure: with 8 concurrent requests against a pipeline allowing 1 write in flight and none queued, 1 was accepted and 7 were refused with 503 (retryable). Nothing was silently dropped.
* Recovery: a **simulated** 2 s storage failure (the store wrapper throws; `mongod` itself was not stopped) produced 7 refused attempts, and a sender that retries every 250 ms (as `Retry-After` asks) lost 0 of 10 batches; the first success came 2.3 s after the outage began (the figure includes the outage). A real database outage or failover was not tested here.
* Storage: about 179 bytes per span on disk plus about 290 bytes of index per span (spans 66.9 MiB data + 110 MiB indexes for 391k spans; summaries 5 MiB; metric points 12 MiB for 108,600 rollup documents). The 648,000 raw points collapse into 108,600 per-minute rollup documents.
* Memory: peak RSS 486 MiB for the Node process that generates the load and runs the pipelines (mongod not included).

## Before and after

Same datasets and targets in every run. "Before" is the first implementation, "after" is the current code.

| Measure | before | after (run 2, quietest) | final |
|---|---|---|---|
| Metric ingestion | 1,809 pts/s | 3,104 | 3,304 |
| Rate by service (3 h) p95 | 3,168 ms | 720 | 628 |
| p99 across everything p95 | 2,800 ms | 1,089 | 1,351 |
| HTTP overview p95 | 3,468 ms | 1,464 | 1,379 |
| Per-service span statistics p95 | 1,927 ms | 496 | 436 |
| Server-span timeline p95 | 1,468 ms | 222 | 626 |

What changed the numbers:

1. Metric queries now aggregate **inside MongoDB** (`$group` per window and label set) instead of shipping every stored minute to Node.
2. Metric writes use operators (`$inc`, `$min`, `$max`, `$push`) for counters and histograms, so the series read-modify-write is gone from the hot path.
3. Trace-summary sort indexes include `_id`, so searches read in index order and stop using blocking sorts.

## Variance, and why the single numbers above should not be over-read

The same code and dataset gave **3,989 to 10,871 spans/s** across runs. An earlier run (kept as `performance-traces-metrics.contaminated-run3.json`) was taken while the API, the web dev server and another benchmark process were running and is **not** used for any conclusion. Even the "quiet" final run was taken on a laptop that was
already about 44% busy with unrelated processes. The only conclusions the data supports:

* Trace reads (lookup, waterfall, search) are fast with a large margin: p95 at least 4x under target in every run.
* Span ingestion is around the 5,000/s target on this machine and cannot be claimed as a reliable pass.
* Metric ingestion **does not reach** 5,000 points/s in any run.
* Aggregate queries over 3 h of metrics are **between 1.2x and 2.7x over target**. They are acceptable for interactive use over a few hours, but they are not "fast".

## Known limits and what would change them

* MongoDB is not a columnar store. Every aggregate (service statistics, dependencies, metric percentiles) scans a time range of rollup or span documents, so cost grows **linearly with the window and with the number of series**. Longer windows (24 h, 7 d) were measured in Round 2 below: cost is linear in window x series.
* Dependencies and the service span statistics scan spans directly (they do not use pre-aggregated data). They are the first queries to degrade as span volume grows. The documented fix is a rollup collection for span statistics (not built).
* Metric ingestion is limited by per-series bookkeeping (cumulative state, idempotency window, cardinality accounting) as well as by writes. Higher rates need either larger batches per series or the ClickHouse upgrade path in ADR-0005.
* A single `mongod` shared with the load generator is the best case for latency and the worst case for throughput.
* Not measured: HTTP overhead, TLS, gzip decoding cost at scale, multiple ingest replicas, a replica set with more than one node, an Atlas-hosted cluster, retention/TTL deletion under load.

---

# Round 2 (2026-10-31): metric write path, metric queries, 24 h and 7 d windows

The targets above were **not** changed. Raw files: `performance-traces-metrics.round2-baseline-1.json` (the code as it was at the start of Round 2), `...round2-after-1/2.json` (first set of changes), `...round2-final-1/2.json` (final code; `performance-traces-metrics.json` is a copy of the last one) and `performance-traces-metrics.windows.json` (24 h / 7 d). The contaminated run from Round 1 is kept as `...contaminated-run3.json` and is not used anywhere.

**Conditions.** Same laptop, same configuration as above. The baseline run was taken while the machine was about 19 to 28 % busy (the developer's dev servers and several helper processes were running); the final runs at 6 to 7 % CPU, with the dev servers idling. Because the Round 1 numbers came from yet another machine state, **only comparisons made on the same day are used here**, and the isolated A/B timings below (old and new store code alternating on the same data inside one process) are the most reliable evidence of what each change is worth.

## Results against the targets (final code, two runs)

| Measure | Target | Round 2 baseline | Final run 1 | Final run 2 | Verdict |
|---|---|---|---|---|---|
| Span ingestion | >= 5,000/s | 6,246/s | 5,366/s | 5,472/s | met, **barely and unstable** (4.0k to 10.9k across all runs on this machine) |
| Metric point ingestion | >= 5,000/s | 2,356/s | 2,720/s | 2,640/s | **missed** (about +12 to 15 %) |
| Rate by service (3 h), p95 | < 500 ms | 877 ms | 403 ms | 426 ms | **met** |
| p99 across everything (3 h), p95 | (no target) | 2,820 ms | 685 ms | 723 ms | 4x faster |
| p95 by route, one service (3 h), p95 | (no target) | 123 ms | 143 ms | 144 ms | unchanged |
| HTTP service overview (3 h), p95 | < 1,000 ms | 2,917 ms | 1,153 ms | 1,590 ms | **missed** (p50 1,110 / 1,149 ms) |
| Per-service span statistics (6 h), p95 | < 1,500 ms | 881 ms | 1,275 ms | 1,290 ms | met (trace code untouched; the spread is noise) |
| Observed dependencies (6 h), p95 | < 1,500 ms | 1,966 ms | 1,261 ms | 1,452 ms | met in both final runs, **close to the limit, missed in the baseline run** |

Isolated A/B on the same 3 h dataset (600 series, 108,000 minute documents), median of 7 alternating runs, results compared and **identical** in every case:

| Query | old code | new code |
|---|---|---|
| p95 by route, one service | 126 ms | 112 ms |
| rate by service | 749 ms | 433 ms |
| count by route and status | 805 ms | 476 ms |
| p99 across everything | 2,039 ms | 562 ms |
| HTTP service overview | 2,401 ms | 1,083 ms |

## What was measured, and what changed

**Metric writes** (`pnpm --filter @nexus/ingest profile:metrics` times each stage). In the benchmark shape (one point per series per request, 150 series per request, 4 writers) one request costs about 150 ms, of which roughly a third is the series-state write, a third the minute-document writes, and the rest reading the series, computing and committing the transaction. The cost per database operation was about 0.3 ms **regardless of document size**, so the lever is the number of operations, not their size.

| Change | Effect |
|---|---|
| A minute document that the series state proves does not exist yet is written with **one** operation (it used to be create-then-increment), an existing minute is incremented without being created first, and a counter needs one operation in every case. A cumulative series' baseline point writes no document, so that one case keeps the safe path. | 3 to 2 operations per point; isolated profile 2,447 to 2,915 points/s |
| The series state is updated with a targeted `$set` of the fields that change (no longer a whole-document replace) | isolated profile about +7 % (within noise) |
| Tried and **rejected**: `$push` with `$slice` for the 128-entry "recent timestamps" list | no gain (3,086 against 3,127 points/s), reverted |

In the full benchmark (the same data written after 391,000 spans, so a busier server) the combined effect was smaller: **+12 to 15 %**, 2,356 to 2,640 and 2,720 points/s. The 5,000/s target is **still missed**.

**Why it stays missed, and what moves it.** Every series costs about two database operations per request no matter how many points it carries. Sweeping the number of scrape intervals carried by one request (same series, same data, isolated profile, `PROFILE_TICKS_PER_REQUEST`):

| Intervals per request | Points per second |
|---|---|
| 1 (the benchmark shape) | about 3,100 |
| 2 | 4,971 |
| 6 | 7,751 |

So a sender (or a Collector batch processor) that puts two or more intervals of the same series into one request clears 5,000 points/s on this machine; a stream of one point per series per request does not. The benchmark shape is realistic for a Collector with the default 200 ms batch timeout, and it is kept as the target definition.

**Metric queries.**

| Change | Effect (isolated, single pipeline over 108,000 documents) |
|---|---|
| Bucket counts are summed only when a percentile will be read (rate, count, sum, avg, min, max never look at them) | rate by service 749 to about 500 ms |
| Large series sets are aggregated in **parallel chunks** (about 100 series each, 8 pipelines at a time store-wide) and merged exactly | p99 across everything 2,039 to about 600 ms |
| Two-stage windowing: group by the stored minute first, then fold the few resulting rows into query windows. Measured: the per-document window arithmetic cost about as much as everything else in the pipeline put together (1,095 ms to 540 ms in the stripped test) | included in the figures above |
| The scan guard does not count documents when series x minutes cannot exceed the limit | removes one index scan per query |
| Tried and **rejected**: dropping the redundant `$ifNull` around each bucket sum; chunk sizes 25 to 200 and 4 to 16 slots (100 and 8 are at the optimum, within noise) | no measurable gain |

**A defect found by the new oracle test, fixed here.** The gauge `last` aggregation used `$top` with an *ascending* sort, which returns the **oldest** value. Whenever a window contained more than one stored minute or more than one series, `last` showed the oldest value instead of the newest. Existing tests only used one document per window and never saw it. It now sorts descending, and `write-path.test.ts` recomputes every window from the stored documents in plain JavaScript (steps of 1, 7 and 26 minutes, gauge/counter/histogram) and compares.

## Longer windows (24 h and 7 d)

`bench/bench-windows.ts` (run: `pnpm --filter @nexus/ingest bench:windows`). **How the data was built:** the base data went through the real pipelines (6 h of spans, 1 h of metrics); longer windows were made by **cloning** stored documents backwards in time (new ids, shifted timestamps; cloned spans get new trace ids and have no trace summaries, which the statistics queries do not read). Seeding 24 h or 7 d through the pipelines would take hours at the measured ingest rate.

* Spans: 391,200 (6 h, 65,200 per hour) cloned to 1,564,800 (24 h): 262 MiB on disk plus 411 MiB of indexes. A 7 d window here contains the same 24 h of data (7 d at this density is about 11 million spans and was **not built**).
* Metrics: 600 series for 24 h (864,000 minute documents) and the 60 series of one service for 7 d (604,800): 1,382,400 documents in total, 612 MiB of data, 76 MiB on disk, 184 MiB of indexes. **600 series for 7 d (about 6 million documents) was not built.**
* Each query ran with the production scan guard (250,000 stored minute documents) and with the guard raised. "Refused" means the **product would answer with a clear 422 asking for a narrower window or a filter**; the timing is what the query would cost without the guard. Interactive threshold used here: p95 < 2 s.

| Query | Window | Documents scanned | Production guard | p50 / p95 (guard raised) | Interactive |
|---|---|---|---|---|---|
| rate by service, 600 series | 3 h | 108,000 | allows | 304 / 366 ms | yes |
| rate by service, 600 series | 6 h | 216,000 | allows | 471 / 542 ms | yes |
| rate by service, 600 series | 24 h | 864,000 | **refuses** | 1,582 / 2,082 ms | borderline |
| p99 across everything, 600 series | 3 h | 108,000 | allows | 543 / 545 ms | yes |
| p99 across everything, 600 series | 6 h | 216,000 | allows | 1,127 / 1,198 ms | yes |
| p99 across everything, 600 series | 24 h | 864,000 | **refuses** | 3,850 / 3,882 ms | no |
| HTTP service overview, 600 series | 3 h | 108,000 | allows | 1,083 ms | yes (but over its 1 s target) |
| HTTP service overview, 600 series | 6 h | 216,000 | allows | 2,110 ms | no |
| HTTP service overview, 600 series | 24 h | 864,000 | **refuses** | 7,638 ms | no |
| p95 by route, one service (60 series) | 3 h | 10,800 | allows | 102 / 108 ms | yes |
| p95 by route, one service | 24 h | 86,400 | allows | 550 / 576 ms | yes |
| p95 by route, one service | 7 d | 604,800 | **refuses** | 3,834 / 4,505 ms | no |
| request rate, one service | 24 h | 86,400 | allows | 216 / 273 ms | yes |
| request rate, one service | 7 d | 604,800 | **refuses** | 1,223 / 1,311 ms | yes (if allowed) |
| trace: per-service SERVER span statistics | 6 h | 60,000 server spans | n/a | 1,101 / 1,234 ms | yes |
| trace: per-service SERVER span statistics | 24 h | 240,000 server spans | n/a | 2,900 / 3,066 ms | no |
| trace: observed dependencies (bounded: at most 20,000 client spans are read, `sampled` says so) | 6 h / 24 h / 7 d | | n/a | 1,255 / 1,164 / 1,135 ms | yes (flat, by design) |
| trace: server span timeline | 24 h | 240,000 server spans | n/a | 1,913 / 2,059 ms | borderline |

**How limits scale.** Cost is **linear in documents scanned**, that is in (window length) x (number of series): for the all-series queries about 0.002 to 0.003 ms per document for a rate, about 0.005 ms for a percentile and about 0.01 ms for the overview, in the parallel chunked form (wall-clock on 8 cores). The scan guard turns "too many documents" into an explicit refusal instead of a slow query. The span statistics and timeline are also linear in the server spans in the window (covered index scans); only the dependency query is capped. The 7 d trace figures only show that window length by itself costs nothing (same data as 24 h); a 7 d window at this density would be roughly 7x the 24 h figure, **extrapolated, not measured**.

## Verdict for Round 2

| Item | Status |
|---|---|
| Metric ingest >= 5,000/s (benchmark shape) | **missed** (2.6 to 2.7k/s). Reached at two or more intervals per request (4,971/s and 7,751/s in the sweep). |
| Rate by service (3 h) < 500 ms | **met** (403 and 426 ms p95) |
| HTTP service overview (3 h) < 1,000 ms | **missed** (p50 about 1.1 s; p95 1.15 to 1.59 s) |
| 24 h and 7 d windows | measured; **only filtered or single-service queries stay interactive**; the all-series percentile and overview queries do not at 24 h, and the production guard refuses them |

## What would change the remaining limits

1. **Pre-aggregated rollups** (for example hourly documents maintained at write time, or by a compaction job). Windows of 24 h and more would scan about 60x fewer documents. Not built: it needs a migration, a retention rule, a late-data rule for out-of-order points, and either extra write operations (which cost ingest) or an invalidation scheme. It was judged too risky to add without its own design and test round.
2. **Larger batches per series per request** for ingest (Collector batch processor settings), which the sweep shows is worth 1.6x to 2.5x.
3. **The ClickHouse path** in ADR-0005 for long windows and high series counts.
4. Not measured in Round 2: multiple concurrent users on the same query, retention deletion under load, a multi-node replica set.

# Round 3 (2026-11-02): metric rollups (5-minute and 1-hour tiers)

Design and rules: [ADR-0007](architecture/ADR-0007-metric-rollups.md). Semantics for users: [traces-metrics.md](traces-metrics.md). **The targets were not changed.** This closes item 1 of "What would change the remaining limits" above.
Raw files: `performance-traces-metrics.round3-signals-run1/2/3.json` (the official benchmark, `bench-signals.ts`, 3 h dataset), `...round3-windows-run1/2.json` (24 h and 7 d, `bench-windows.ts`, `BENCH_WIN_FULL7D=1`),
`...round3-write-path.json` (`bench-rollup-write.ts`). `performance-traces-metrics.json` and `...windows.json` are Round 2 files and were not touched.

**Conditions, stated plainly.** Same laptop (8 logical CPUs, 16 GiB). The machine was **not isolated**: other agents were running tests and builds in the same repository while these were taken (I sampled CPU load only at the end: 5 to 18 %
while idle between runs; Windows has no load average, so the per-round load list in the write-path file is zeros and means nothing). The machine was visibly quieter than during Round 2: the same code path ingests metric points at
4.7k/s now against 2.6 to 2.7k/s then, so **absolute numbers must not be compared with Round 2's**. What is comparable: every "before" below was measured **in the same process, on the same data, back to back** with the "after"
(`before` = a store that reads minute documents only, the Round 2 read path; `after` = the shipped planner). Each query row has two independent complete runs (fresh server, fresh data), or three for the official benchmark. p95 over
5 to 15 runs of a query is close to its maximum: single outliers (for example 2,123 ms in the 3 h p99 row, 5,661 ms in the 24 h p99 row) are scheduler noise from other processes, which is why p50 and the minimum (in the JSON) are reported too.

## Results against the targets (official benchmark, `bench-signals.ts`, 600 series, 3 h, after 391,000 spans)

| Run | HTTP service overview (3 h), minute documents only: p50 / p95 ms (same run) | **HTTP service overview (3 h) with rollups: p50 / p95 ms** (target p95 < 1,000) | Rate by service (3 h), p50 / p95 (target < 500) | Metric ingest points/s (target >= 5,000) | Span ingest /s (target >= 5,000) | Compaction (once, after the load) |
|---|---|---|---|---|---|---|
| 1 | 700 / 849 | **238 / 342** | 194 / 275 | 4,665 | 6,719 | 7.4 s for 108,600 minute documents |
| 2 | 674 / 730 | **200 / 292** | 191 / 217 | 4,719 | 10,528 | 8.6 s for 108,600 minute documents |
| 3 | 721 / 1,108 | **243 / 363** | 187 / 284 | 4,772 | 9,966 | 8.1 s for 108,000 minute documents |

| Target | Verdict |
|---|---|
| HTTP service overview (3 h) p95 < 1,000 ms | **met**: 292 to 363 ms with rollups (3 runs, 15 samples each). Round 2 measured 1,153 to 1,590 ms (p50 about 1,110) on the busier machine. In the same runs the minute-document path took 730 to 1,108 ms p95 (p50 674 to 721), i.e. **about 3.1x slower at p50**: on a quiet machine the old path nearly meets the target, which is why the in-run comparison and not Round 2's figure is the honest "before". The 5-minute timeline (36 points instead of 180) contributes a little; the rollup read the rest. |
| Rate by service (3 h) p95 < 500 ms | met (217 to 284 ms): unchanged by rollups (a 1-minute step cannot use a 5-minute bucket) |
| Metric point ingestion >= 5,000/s | **still missed**: 4,665, 4,719, 4,772/s. The write path with rollups ingests as fast as without (next section); the shortfall is Round 2's, and moved only because the machine was quieter. Reached with 2 or more intervals per request (Round 2). |
| Span ingestion >= 5,000/s | met in these runs (6.7k to 10.5k/s; trace code untouched, this figure swings 4k to 11k on this machine) |

## 24 h and 7 d windows, all series (`bench-windows.ts`, 6,048,000 minute documents: all 600 series for 7 d)

Round 2 could not build 600 series for 7 d ("did not fit"); this run did (6.05 million minute documents, 2,679 MiB of data, 380 MiB on disk compressed because the clones repeat; 763 MiB of indexes).
Data was built as in Round 2 (1 h through the real pipeline, the rest **cloned** backwards in time), then the rollups were built from scratch by the real compactor. The interactive threshold used here is p95 < 2 s.

| Query | Window | Minute documents only, p50 / p95 ms (run 1 ; run 2) | With rollups, p50 / p95 ms (run 1 ; run 2) | Scan guard before, after | Reads (last plan of the query) |
|---|---|---|---|---|---|
| request rate by service, all 600 series | 3 h | 221 / 273 ; 168 / 184 | 189 / 231 ; 176 / 236 | allowed, allowed | 1x minute docs |
| p99 across everything, all 600 series | 3 h | 361 / 516 ; 358 / 2,123 | 364 / 421 ; 415 / 632 | allowed, allowed | 1x minute docs |
| HTTP service overview, all 600 series | 3 h | 666 / 866 ; 699 / 881 | 216 / 227 ; 208 / 327 | allowed, allowed | 1x 5 min rollups, 2x minute docs |
| request rate by service, all 600 series | 6 h | 290 / 329 ; 306 / 470 | 285 / 319 ; 285 / 326 | allowed, allowed | 1x minute docs |
| p99 across everything, all 600 series | 6 h | 725 / 1,203 ; 670 / 837 | 684 / 824 ; 787 / 887 | allowed, allowed | 1x minute docs |
| HTTP service overview, all 600 series | 6 h | 1,271 / 2,938 ; 1,234 / 1,792 | 473 / 586 ; 268 / 304 | allowed, allowed | 1x 5 min rollups, 2x minute docs |
| request rate by service, all 600 series | 24 h | 1,211 / 1,343 ; 1,226 / 1,361 | 273 / 323 ; 258 / 265 | refused, allowed | 1x 5 min rollups, 2x minute docs |
| p99 across everything, all 600 series | 24 h | 2,561 / 2,649 ; 3,270 / 5,661 | 577 / 621 ; 626 / 798 | refused, allowed | 1x 5 min rollups, 2x minute docs |
| HTTP service overview, all 600 series | 24 h | 5,849 / 5,967 ; 5,302 / 5,436 | 551 / 554 ; 342 / 359 | refused, allowed | 1x 1 h rollups, 2x 5 min rollups, 2x minute docs |
| p95 by route, one service, one service | 3 h | 78 / 84 ; 55 / 68 | 79 / 96 ; 62 / 66 | allowed, allowed | 1x minute docs |
| request rate, one service, one service | 3 h | 35 / 42 ; 35 / 41 | 35 / 50 ; 29 / 33 | allowed, allowed | 1x minute docs |
| p95 by route, one service, one service | 24 h | 423 / 746 ; 346 / 393 | 99 / 147 ; 94 / 100 | allowed, allowed | 1x 5 min rollups, 2x minute docs |
| request rate, one service, one service | 24 h | 142 / 193 ; 128 / 140 | 44 / 47 ; 42 / 45 | allowed, allowed | 1x 5 min rollups, 2x minute docs |
| p95 by route, one service, one service | 7 d | 3,943 / 6,563 ; 4,247 / 4,490 | 67 / 67 ; 64 / 66 | refused, allowed | 1x 1 h rollups, 2x 5 min rollups, 2x minute docs |
| request rate, one service, one service | 7 d | 1,674 / 1,824 ; 1,557 / 1,744 | 47 / 48 ; 46 / 54 | refused, allowed | 1x 1 h rollups, 2x 5 min rollups, 2x minute docs |
| request rate by service, all 600 series | 7 d | 10,459 / 10,459 ; 15,764 / 15,764 | 284 / 284 ; 202 / 202 | refused, allowed | 1x 1 h rollups, 2x 5 min rollups, 2x minute docs |
| p99 across everything, all 600 series | 7 d | timeout (> 8 s) ; timeout (> 8 s) | 516 / 516 ; 408 / 408 | refused, allowed | 1x 1 h rollups, 2x 5 min rollups, 2x minute docs |
| HTTP service overview, all 600 series | 7 d | timeout (> 8 s) ; timeout (> 8 s) | 725 / 725 ; 1,000 / 1,000 | refused, allowed | 1x 1 h rollups, 2x 5 min rollups, 2x minute docs |

"Timeout" means the minute-document query exceeded the store's own 8 s limit, so it **cannot be answered at all** on that path (the production guard refuses it before). The "before" 3 h and 6 h rows are the same code path as "after" for most queries
(the planner correctly reads minute documents when a step is 1 or 2 minutes): equal within noise is the expected result there, and it shows the planner adds no cost.

**What changed for the product:** every query in the table is now **allowed by the scan guard and interactive** (largest p95: 7 d HTTP overview over all series, 725 and 1,000 ms; all others under 830 ms), including 24 h and 7 d over all 600 series.
Before, the 24 h all-series queries took 1.2 to 6 s and were refused, 7 d all-series took 10 to 16 s or timed out. Speed-up at p50: 24 h rate 4.5x, 24 h p99 4.4 to 5.2x, 24 h overview 10 to 15x, 7 d one-service p95-by-route 59 to 66x, 7 d rate over all series 37 to 78x.

## Building the rollups (backfill) and what they cost to store

| | Run 1 | Run 2 |
|---|---|---|
| Rebuild of everything (the compactor, 8 cores shared, 50 series per batch) | 369.1 s | 410.6 s |
| Minute documents read per second | 16,387 | 14,728 |
| Rollup documents written (5 min + 1 h) | 1,209,600 + 100,800 = 1,310,400 (21.7 % of the minute documents) | same |
| Rollup collection: data / on disk / indexes | 611.5 / 83.9 / 140.3 MiB | 611.5 / 83.5 / 137.7 MiB |

At about 15,000 minute documents per second, backfilling one day of 600 series (864,000 documents) takes about a minute, a week of them about 6.5 minutes; it runs in the background, in chunks, and queries read minute documents until a series is done.
In the official benchmark the first compaction after 3 h of load (108,000 minute documents, 600 series) took 7 to 9 s. The measured cost per series per steady-state pass is not isolated here (see the next section for the impact on ingestion).

## Write path: what rollups cost ingestion (`bench-rollup-write.ts`, alternating variants in one process, 6 rounds, 4 writers, 150 series per request)

| Variant | median points/s | best | worst |
|---|---|---|---|
| A: no marker (the pre-rollup update) | 5,854 | 5,990 | 5,347 |
| **B: marker (shipped)** | **5,664** | 5,766 | 5,362 |
| C: marker + a compactor pass every 2 s | 4,767 | 4,779 | 4,071 |
| D: marker + a compactor running back to back (300 ms pause) | 4,262 | 4,464 | 4,028 |

* **B / A = 0.968**: the marker (one `$min` field inside the series update that already exists) costs **3 % at the median, inside the spread of A itself** (5,347 to 5,990). The write path does **not** regress: it stays far above the 2.7k/s of Round 2.
* C and D are **upper bounds, not the production cost**: this benchmark's data is already 3 h old, so *every* series is claimable *every* pass (600 claims per pass). In production a series is claimed once per 5 minutes (its marker minute must be sealed first), 150x fewer claims than variant C.
  The honest reading: a compactor pass costs ingestion up to about 19 % when it runs every 2 s against permanently claimable data, and up to 27 % when it never sleeps. The production steady state (30 s interval, series claimable once per 5 minutes) was **not measured separately**.
  If it ever matters, the compactor interval (`METRIC_ROLLUP_INTERVAL_MS`) and batch size are the levers.
* Rejected without building: maintaining the two rollup documents per series in the write transaction (2 extra operations per series on a path that spends about 2; an estimate, ADR-0007).

## Verdict for Round 3

| Item | Status |
|---|---|
| HTTP service overview (3 h) < 1,000 ms p95 | **met** (292 to 363 ms; minute documents alone 730 to 1,108 ms in the same runs) |
| 24 h and 7 d, all series, interactive (< 2 s p95) and allowed by the guard | **met** for rate, p99 and HTTP overview (24 h: 0.3 to 0.8 s p95; 7 d: 0.2 to 1.0 s). Before: 1.2 to 15.8 s, refused or timed out |
| Write path does not regress below the Round 2 level | **met** (marker costs about 3 %, inside the noise; 4.7k to 5.9k points/s on the quiet machine against 2.7k in Round 2) |
| Metric ingestion >= 5,000/s (official benchmark shape) | **missed** (4.7k/s; rollups are neutral to it) |
| Correctness | proven by `rollup.test.ts` (17 tests: 4 seeded randomized oracle scenarios of 150+ queries each, comparing through rollups and through minute documents including resets, gaps, late/out-of-order data, two bucket layouts, unaligned windows, writers racing the compactor; plus crash, backfill, rebuild, retention and cardinality tests). Deleting the invalidation rule in `coverageOf` makes the oracle test fail (checked). |

## Limits that remain

* 7 d over **all series** was measured with 600 series. Cost is linear in series x buckets: 20,000 series for 7 d would be about 3.4 million hourly buckets, and would not be interactive; that is the ClickHouse path of ADR-0005. **Extrapolated, not measured.**
* Windows between 3 min and about 90 min at 1-minute resolution (and 1-minute steps in general) still read minute documents: a 5-minute bucket cannot answer a 1-minute point. Those queries are as fast as before and bounded by the guard.
* The last 2 to 7 minutes and the unaligned edges of a window are always read from minute documents; a series with late data reads minute documents for the affected range until the next compaction (30 s by default).
* The data was cloned, not ingested, for everything older than 1 h (as in Round 2): cloned minutes are identical in shape, but bucket counts and values repeat hourly, so compression and cache behaviour are friendlier than real data. Concurrent users, retention deletion under load and multi-node replica sets were not measured.
* A second compactor instance is safe (leases), but running several was not measured.
