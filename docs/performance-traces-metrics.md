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

* MongoDB is not a columnar store. Every aggregate (service statistics, dependencies, metric percentiles) scans a time range of rollup or span documents, so cost grows **linearly with the window and with the number of series**. Longer windows (24 h, 7 d) were **not benchmarked**; expect them to be proportionally slower.
* Dependencies and the service span statistics scan spans directly (they do not use pre-aggregated data). They are the first queries to degrade as span volume grows. The documented fix is a rollup collection for span statistics (not built).
* Metric ingestion is limited by per-series bookkeeping (cumulative state, idempotency window, cardinality accounting) as well as by writes. Higher rates need either larger batches per series or the ClickHouse upgrade path in ADR-0005.
* A single `mongod` shared with the load generator is the best case for latency and the worst case for throughput.
* Not measured: HTTP overhead, TLS, gzip decoding cost at scale, multiple ingest replicas, a replica set with more than one node, an Atlas-hosted cluster, retention/TTL deletion under load.
