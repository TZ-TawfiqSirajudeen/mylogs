# Performance: logs ingestion and query

Measured with `pnpm bench` (`packages/ingest/bench/bench.ts`). **These numbers describe one development laptop** (Intel i7-8650U, 8 threads,
16 GiB, Node 22) running a single `mongod` (in-memory-server defaults, WiredTiger) **and** the load generator on the same machine. They are
evidence for the figures below, not a capacity guarantee. Re-run the benchmark on target hardware before sizing.

Raw results, all on the **same 300,000-record dataset** and the same generator:

| File | What |
|---|---|
| `performance-results.before.json` | before the optimisation work (the original run) |
| `performance-results.after-run1.json`, `…after-run2.json` | after, two independent runs |
| `performance-results.json` | after, third run (also adds the four extra cases marked † below) |

## Dataset
300,000 log records spread over 6 hours, 8 services, ~543 bytes per record as OTLP/JSON on the wire. Stored: ~1.08 KB/document before, ~1.13 KB after
(the new `searchText` field), 52–57 MiB on disk after compression, 113–137 MiB of indexes (it varies between runs by a few percent; the baseline was 124 MiB).

## Targets and results
Targets were set **before** the first measurement, from what an engineer needs during an incident. **They were not changed afterwards.** Each cell is
p95 in ms (p50 in brackets) — the baseline and three runs after the work.

| Measurement | Target | Before | After run 1 | Run 2 | Run 3 | Met now? |
|---|---|---|---|---|---|---|
| Ingestion, in-process pipeline, 4 writers, 1,000-record batches | ≥ 5,000 rec/s | 9,065 | 9,830 | 9,871 | 9,390 | ✅ |
| Ingestion while 8 readers query continuously | ≥ 2,000 rec/s | 3,750 | 3,250 | 4,000 | 4,000 | ✅ (varies ±15 % between runs) |
| Latest 100 records (15 min, 6 h) | p95 < 100 | 4.5 / 4.3 | 4.6 / 3.4 | 3.9 / 5.3 | 4.3 / 3.1 | ✅ |
| Errors-only / service+severity / HTTP status filter | p95 < 250 | 100 / 61 / 127 | 96 / 59 / 95 | **207** / 74 / 93 | 115 / 52 / 86 | ✅ (run 2's 207 is within 17 % of the limit) |
| Attribute filter | p95 < 250 | 13.9 | 14.3 | 13.3 | 13.0 | ✅ |
| Trace lookup / request-id lookup | p95 < 50 | 2.3 / 3.5 | 3.6 / 3.0 | 2.0 / 2.1 | 1.8 / 1.7 | ✅ |
| Deep keyset page (after 2,000 rows) | p95 < 100 | 19 | 16 | 8.7 | 9.1 | ✅ |
| **Text search with matches** (6 h) | p95 < 1,000 | **1,100** (192) | 77 (67) | 158 (77) | 70 (65) | ✅ — was ❌ |
| **Text search, no match** (full range scan) | p95 < 1,000 | **4,279** (1,603) | 692 (627) | **941** (754) | 817 (604) | ✅ — was ❌. **Borderline: 6–31 % under the limit** |
| **Histogram**, 60 buckets, 6 h | p95 < 500 | **1,195** (1,148) | 115 (109) | 217 (192) | 107 (101) | ✅ — was ❌ |
| **Facets** (services + severities), 6 h | p95 < 500 | **630** (608) | 339 (281) | 320 (255) | 461 (344) | ✅ — was ❌. Run 3 is within 8 % of the limit |

All eleven targets are met in all three post-change runs. The four that were missed before are met **with a thin margin in some runs** (no-match text search,
facets): treat them as "at the edge on this machine", not as comfortable.

### Paths that are *not* on the fast path (measured in run 3, † — no target was set for these)

| Query | p50 / p95 (ms) | Why |
|---|---|---|
| Histogram, errors only † | 350 / 406 | index-count path, but each bucket's error count walks the level index |
| Histogram with a text filter † | 730 / 834 | aggregation fallback: needs the matching documents |
| Histogram with an **attribute** filter † | **1,187 / 1,952** | aggregation fallback over attributes; **this would miss a 500 ms target** |
| Facets with a text filter † | 917 / 1,074 | single pass, but every matching record is fetched |

## What changed, and why it is faster
(`packages/database` migration v5, `packages/logstore`, `packages/ingest`; all covered by tests, see below.)

* **Histogram:** instead of grouping every record (`$toLong`/`$mod` per document — CPU-bound even when fully covered by an index, ~800 ms measured), when
  the filter can be answered from the index (scope, time, severity, service) each bucket is an **index-range COUNT**, run 12 at a time. ~10× faster.
  Filters that need document fields (text, attributes, fields) use the previous aggregation.
* **Facets:** one pass grouping by `(service, level)` over a new **covering index** `logs_scope_ts_svc_lvl` (reads index entries only, 0 documents examined)
  feeds both facets, instead of two scans over documents.
* **Free-text search:** terms are matched with a plain, case-sensitive match against a stored, pre-lowercased `searchText`, **inside** a covering index
  (`logs_scope_ts_search`, which also serves every "newest first" query and replaces the old `logs_scope_ts`). A miss now fetches **zero documents**
  (asserted by a test), a hit fetches only the page.
* The migration adds two indexes and drops one (net **+1 index** per record). Total index size did not clearly grow (124 MiB before; 113–137 MiB after, within
  run-to-run spread); ingestion throughput did not drop (9,065 → 9,390–9,871 rec/s). Longer real-world messages than this synthetic data (~60 characters)
  make the search index larger; measure with your own data.

## Behaviour changes you should know about (documented, tested)
* **Search window:** only the first **2,048 characters of the message** and **512 of the exception message** (the error type in full) are searchable.
  Text beyond that is stored and displayed but not found by free-text search. (The previous implementation scanned everything.)
* Matching is now Unicode-aware lower-casing on both sides (`ÜBERFÄLLIG` finds `überfällig`); phrases can no longer match across the boundary between
  message, error type and exception message (a test asserts that).
* **Migration v5 backfills `searchText` for existing records in batches** while holding the migration lock. On a large collection run it in a
  maintenance window. Until a record has the field it is not found by text search; the migration is idempotent and re-runnable. Deploy the new service
  version together with the migration: an *old* ingest process still running afterwards would write records without `searchText`.
* The histogram's index-count path returns the same buckets as the aggregation (a test compares them for eight filter combinations, including unaligned
  time ranges); empty buckets are omitted in both.

## What this still does not solve
* **Everything that needs documents is still linear in the number of matching records:** attribute/field-filtered histograms, facets under a text
  filter, and *any* search without an index prefix. 10× the data ≈ 10× the time for those; and the no-match text scan (817–941 ms) has no headroom at 10×.
  MongoDB is not a columnar store. Next steps if this matters: per-minute rollup documents for the unfiltered histogram/facets (not built), an inverted
  index or the ClickHouse `LogStore` (ADR-0003).
* Several measurements are **5 samples**; their "p95" is effectively the maximum. Run-to-run noise on this laptop is large (e.g. the errors-only p95 was 96, 207
  and 115 ms in three runs). Do not read differences of a few tens of percent as real.
* The mixed-load ingest figure comes from a single 4-second window (3,250–4,000 rec/s between runs).

## Not measured (do not infer anything about these)
HTTP/TLS overhead and the HTTP parsing path at volume; multiple ingest replicas; multi-node MongoDB; sustained soak (hours); datasets above 300k records or
ranges above 6 h; cold-cache behaviour; compressed (gzip) request throughput; concurrent live tails (functional limit of 3 per user is tested, not its cost);
the migration backfill time on a large existing collection.

## A defect the original benchmark found (and fixed earlier)
The trace and request-id indexes were *partial* indexes. MongoDB cannot use a partial index for a plain equality query, so the lookups scanned (~900 ms and
~170 ms). They are ordinary compound indexes now (1–2 ms). A regression test asserts the main query plan uses the tenant/time index and never scans the collection.
