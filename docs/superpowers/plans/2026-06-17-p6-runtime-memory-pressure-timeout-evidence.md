# P6 Runtime Memory Pressure / Timeout Evidence

## 1. Current host/time

- Host: vmd190201
- Date: 2026-06-17T02:40:40+02:00
- User: root
- Repo: /root
- Branch: fix/runtime-memory-pressure-timeout-stability-2026-06-17
- Live HEAD: f607388 fix(memory): mark stale operational memories as requiring live verification (#58)

## 2. Current gateway memory

- ActiveState: active
- MainPID: 1119965
- MemoryCurrent: 2002096128 (~1.9 GiB)
- MemoryPeak: 2512457728 (~2.3 GiB)
- CPUUsageNSec: 1289659480000

## 3. Error counts in last 2h (pre-restart and post-restart)

| Signature | Count |
|---|---|
| MemoryDB.store timed out | 190 |
| MemoryDB.search.countRows timed out | 117 |
| MemoryDB.vectorSearchActive timed out | 37 |
| MemoryDB.purgeExpired timed out | 13 |
| recall worker timed out | 23 |
| capture worker timed out | 19 |
| agent cleanup timed out | 28 |
| Cannot read properties of undefined (reading 'summary') | 32 |
| memory pressure (critical) | 44 |
| Context overflow | 2 |
| prompt too large | 2 |
| rerank failed | 1 |

## 4. Post-restart window (since 2026-06-17 02:33:00)

| Signature | Count |
|---|---|
| MemoryDB.vectorSearchActive timed out | 5 |
| agent cleanup timed out | 1 |
| memory pressure | 2 |
| recall worker timed out | 1 |
| rerank failed | 1 |

The gateway was restarted at 02:33:35 CEST. RSS dropped from ~8.2 GiB to ~2.0 GiB, but timeout symptoms persist at a lower rate, indicating the root cause is not solely accumulated memory — it is event-loop pressure / LanceDB contention / unbounded work during capture/recall.

## 5. Bernhardine context overflow

- Context overflow precheck observed at 01:54:15: `estimatedPromptTokens=268523`, `promptBudgetBeforeReserve=245760`, `overflowTokens=22763`.
- Context overflow error at 01:54:38: `observedTokens=unknown`, `compactionTokens=262145`, `error=Context overflow: prompt too large for the model (precheck).`
- This occurred before #58; post-restart the session was reset, so no post-#58 overflow yet, but the formatter still has no hard char/token cap on its own output.

## 6. Cron/timer state

- Cron read-only: standard user crontab present (details not printed for brevity).
- Systemd user timers: standard OpenClaw timers active.
- No cronjobs were disabled.

## 7. Initial hypothesis

1. **LanceDB/event-loop contention**: `MemoryDB.search.countRows`, `vectorSearchActive`, `store`, and `purgeExpired` all time out simultaneously, clustered around capture/recall bursts for agent `bernhardine`. This points to a single event-loop or DB lock bottleneck rather than slow queries in isolation.
2. **Unbounded capture concurrency**: Captures run many dedup checks (one per candidate) in parallel; if the DB is already slow, the concurrent calls pile up and every one times out.
3. **Rerank summary TypeError**: The reranker returns a malformed/undefined entry and the fallback code reads `.summary` without a guard, turning a soft degradation into a hard recall failure.
4. **Context formatter lacks hard output cap**: `formatRelevantMemoriesContext` can produce an arbitrary amount of XML, which then contributes to model prompt overflow on the OpenClaw side.
5. **Memory pressure snapshot disabled**: `diagnostics.memoryPressureSnapshot=false`, so we lack heap dumps; but heap usage (~400-600 MiB) is far below RSS (~8 GiB), suggesting native memory growth (LanceDB/Arrow/Node buffers, retained vectors, unbounded caches) rather than pure JS heap leak.

## 8. Watch items

- Monitor whether MemoryCurrent grows back toward 8 GiB over the next hours.
- If RSS growth resumes, investigate native memory / LanceDB table handles and embedding cache size.
