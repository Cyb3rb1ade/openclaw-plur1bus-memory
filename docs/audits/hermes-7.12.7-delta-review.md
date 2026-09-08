# Independent review of the 7.12.2 → 7.12.7 Hermes port

The published `7.12.7-hermes.2` (6805947) merged all upstream JS commits but did
not adapt the corresponding Python behavior. Its six-runner build was real;
its model, host lifecycle and interactive guest acceptance were not established
by that build. `7.12.7-hermes.3` addresses the concrete native gaps below.

| Upstream change | Hermes treatment | Regression evidence |
| --- | --- | --- |
| 7.12.3 promotion rate limited to 24h, lifetime dedup retained | Count scoped unique confirmation timestamps, recheck immediately before writing; expired legacy entries do not exhaust budget. Also reject disabled feature and make repeated confirmation idempotent. | `test_knowledge_promotions.py` |
| 7.12.3 private REM workspace output | Already writes to own `profiles/<agent>/workspace`; other scopes have isolated subdirectories and cannot write the private diary. Hermes does not use OpenClaw's Neo output-root resolver. | `test_dream_diary.py`, `test_rem_dream_visibility.py` |
| 7.12.3 LightDream agent-private diary | Native LightDream now appends the existing managed DREAMS.md block, respects diary opt-out, stays private and deduplicates. | `test_opt_in_llm_cognition.py` |
| 7.12.4 undated transcript rules | Added to the native MemoryProvider system prompt; transcript order is not temporal evidence. Explicit host/message/tool timestamps remain valid. | `test_upstream_7127_contracts.py` |
| 7.12.4 semantic-discover homedir import | JS operator script retained verbatim. Hermes discovery uses pathlib and its scoped operator workflow, no JS `homedir` call. | upstream script diff; native Obsidian/code-index suites |
| 7.12.5 Unicode query refinement | Normalize composed/decomposed Unicode before tokenization; preserve umlauts. | `test_upstream_7127_contracts.py`, `test_temporal_refinement.py` |
| 7.12.5 timeout slot diagnostics and expired-queue removal | Native recall admission bounded to two workers/eight queued requests; 7s queue deadline, cancel not-started synchronous requests at timeout, log started/cancelled/pending state. Running Python storage threads retain their leases until completion. | `test_runtime_scheduler.py`, `test_upstream_7127_contracts.py`, provider regressions |
| 7.12.6 Int64/BigInt recall lifecycle | Python Arrow returns int, so no BigInt conversion shim. Real-LanceDB validity/TTL/recall tests cover zero sentinels and boundaries. Upstream JS fix retained unchanged. | `test_valid_time_runtime.py`, `test_runtime_recall_additive_scopes.py`, JS bigint row tests |
| 7.12.7 workspace MEMORY.md/USER.md provenance API | OpenClaw-only `classifyWorkspaceMemoryPaths` is retained in JS. Hermes has no such host callback and keeps its native memory-provider/prompt ownership. No fictitious API shim. | `tests/workspace-memory-provenance.test.js`; Hermes provider API inspection |
| 7.12.7 remote embedding timeout/no SDK retries | Hermes urllib already has no automatic SDK retry; now honors `requestTimeoutMs` with 15000ms default and invalid-value fallback; legacy `timeoutSeconds` remains accepted. Both OpenAI-compatible and oMLX paths covered. | `test_upstream_7127_contracts.py` |

## Packaging findings

The `.2` platform manifest included its own empty-file digest and a subsequently
deleted unsigned macOS ARM package. It could not pass the advertised plain
checksum command. The published manifest was repaired without changing package
bytes. `distribution/release_checksums.py` now rejects self references, missing
assets, duplicate names and changed bytes before upload.

## Scope of claims

The authoritative native feature inventory remains `plur1bus_hermes.parity`.
This delta review does not upgrade intentionally partial historical features to
full OpenClaw equivalence. Guest/model/UI acceptance is recorded separately from
unit, installer and stub-vector CI. All four requested targets remain required:
macOS ARM64, Windows ARM64, Windows x64 and Ubuntu/Linux x64.
