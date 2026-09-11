# Additional native contract gaps — 7.12.44 candidate

Pinned upstream: `a3f48f28ac647e81c5260e8a1dbab7977bf9fb51`.
These are read-only audit findings, **not implemented or verified fixes**.
Each native-achievable gap requires its own bounded implementation/review gate
before candidate completion; candidate-verification Task1 owns reconciliation.

## Recall and consolidation

- **Event-relative temporal anchors:** pinned temporal-parser supports
  `nach dem <event>` / `after the <event>` separately from pure date ranges.
  Native parser currently returns ranges only. Storage Task3 ports pure ranges;
  a bounded scoped anchor-resolution task remains required before claiming full
  temporal recall parity. Any reference lookup must preserve ACL/TTL/validity
  and stay optional; do not infer a date from an unauthorized or ambiguous hit.

- **Invalidated recall exclusion:** owned by storage Task5 (plan e41af4a,
  refined 33f50aa). Imported active+invalidated rows currently survive primary,
  refined, shared-pool and booster routes. Require pre-limit and final gates.
- **Semantic merge proposals:** owned by consolidation Task1 (plan 5a397c4).
  Current automatic_merge.py only concatenates after advisory LLM decision.
- **Actionable daily consolidation:** owned by consolidation Task2. Current
  domain.run_consolidation exact-text report is not the UUID durable proposal
  format consumed by controls; semantic clustering and actionable review remain.
- **Upstream defect candidate:** lib/jobs/memory-compaction.js archives source
  rows before replacement table.add. Reproduce add-failure preservation in an
  isolated upstream fix task and review before submitting the user-requested PR.
  Do not copy this mutation ordering into Hermes or report a PR as already made.
- **Reproduced upstream temporal defect:** `parseTemporal("im Dezember",
  Date.parse("2026-09-11T12:00:00Z"))` returns
  `{from:1796083200000,to:1789128000000}`, so from>to. Read-only Node probe on
  pinned merged source confirmed this. Native Task3 returns None for that
  ambiguous future month-only context; a separate reviewed upstream regression
  and PR remain pending. No upstream change/publication has been made.

## Retrieval provider contracts — required owning fix tasks not yet executed

Actual native files are `runtime.py`, `provider.py`, `retrieval_admin.py`,
`setup_retrieval.py`, `reembed_staged.py`, and dashboard controls; no files named
retrieval_settings.py or retrieval_migrate.py exist in this candidate.

1. **Vector identity bypass (high priority).** EmbeddingBackend accepts a
   fallback vector by dimension alone; provider._central_route_is_store_compatible
   checks model+dimension but not the full semantic identity. Staging already
   fingerprints more fields. Introduce/reuse one shared identity contract for
   runtime, central route adoption and staging: adapter, model, revision/artifact,
   dimension, credential-free endpoint and semantic prefix/pooling/instruction.
   Exclude credentials, cache and timeout. Query and document embeddings must
   remain in the same space. Preserve existing configured legacy routes but
   reject uncertain route switches/fallbacks and require staged migration.
   Regression: equal dimensions (and even equal model name) with different
   endpoint/revision/prefix cannot switch a populated store or write fallback
   vectors. Existing BGE/Jina nano/optional oMLX behavior remains explicit.
2. **Reranker settings/validation.** Admin lacks candidates/timeoutMs/
   fallbackOnError; Cohere and oMLX use divergent timeout defaults. Manual unknown
   reranker config currently degrades silently. Implement shared startup/admin
   validation, bounded candidate input and timeout, preserving original recall
   order on configured fail-open. Audit explicit fallbackOnError=false semantics
   against upstream; do not accept a setting that is then ignored. Tests must
   inspect actual backend input and malformed/timeout responses, not selectors.
3. **Misleading remote reranker name.** Native `openai-compatible` reranking
   actually requires POST /rerank with Cohere/Jina-style request/results, which
   an OpenAI embedding endpoint does not guarantee. Add an explicit capability/
   rerank-compatible label with legacy config migration compatibility and clear
   probe/status behavior. Embeddings-success plus rerank-404 is NOT ready.
4. **Jina ONNX reranker profile absent.** Upstream pins a model revision and
   ONNX artifacts; generic native CrossEncoder is not equivalent. Audit exact
   artifacts, license and architecture before adding a separate verified profile
   following native BGE's prepare/probe/offline/hash guarantees. No implicit
   download, remote model code or user-license acceptance. Until implemented and
   tested, retain an explicit missing status, not an optimistic selector claim.

## Physical maintenance and health — required owning tasks not yet executed

- **Nightly physical optimization missing:** upstream417ed73 with a72c3eb
  defaults enabled, keepVersionsHours24 (minimum1), timeoutMs240000. Native
  jobs.run_jobs calls semantic consolidation only. Add a distinct physical
  result and scoped executor; do not count semantic proposals as this feature.
- **Manual retention documentation is wrong:** installed Python LanceDB0.34.0
  `LanceTable.optimize(cleanup_older_than=None, delete_unverified=False,
  retrain=False)` defaults to seven-day historical-version pruning as well as
  fragment/index optimization. Native operator_status says no retention but
  calls bare optimize(). Preserve the manual action's actual seven-day behavior
  explicitly and report versionRetentionHours168; do not silently shorten it.
  Current rows/statuses are distinct from historical table versions.
- **Stats/cancellation limitations:** the sync wrapper returns None, so fake
  test stats do not prove real telemetry. AsyncTable.optimize returns stats but
  exposes no documented safe cancellation or timeout parameter. Never claim
  asyncio.wait_for stops Rust/I/O work. A measured budget/exceeded flag is an
  intentional limited contract unless real cancellation safety is proven.
  Keep delete_unverified=False explicitly; True has concurrent corruption risk.
- **Maintenance concurrency:** manual process-only _OPTIMIZE_LOCK does not
  coordinate with other processes/writers. Use the existing writer lock plus
  active route revalidation and compatible maintenance exclusion. Jobs already
  hold a shared generation lease; requesting an exclusive lease inside the
  same job self-blocks. Tests must exercise actual cross-process exclusion and
  route changes, not only a fake optimizer counter.
- **Bounded nonblocking health absent:** upstream eafa43a scans without links,
  caps entries at10000, yields every200, reports bytes+complete and caches SWR.
  Native dashboard status calls synchronous row-count projection and has no
  storage-byte completeness/cache. Implement an off-request-path bounded scanner
  over certified owned roots, route-keyed cache, no path/secret disclosure, safe
  missing/error/truncation behavior and UI responsiveness tests. Do not reuse
  cache_budget.disk_bytes, which only measures SQLite+WAL cache files.
- **Doctor scope check required:** controls doctor directly uses table.count_rows
  while operator status has a scoped query. Prove scope routing and reuse the
  scoped projection where required; a raw table total is not proof of an
  authorized per-scope count. No new leak claim is certified without that test.

## Intentional boundaries to retain (all audit families)

- Jina v3 native execution is deliberately blocked pending remote-code/security
  audit; keep the approved design boundary. Jina v5 nano is a native addition.
- BGE/Jina nano CPU ONNX profiles require actual prepared artifacts and supported
  dependencies; platform/package presence is not model runtime evidence.
- Native default E5-base/768 differs from upstream E5-small/384. Generic local
  configuration is not default parity; do not change populated stores silently.
- No model calls/downloads, production changes or external publication occurred
  during these audits. New gap closure needs measured implementation evidence.
