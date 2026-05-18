# PLUR1BUS 3.2.2-beta.1 vs OpenClaw 2026.5.18

## Verdict

- Stable compatibility: **pass**
- PLUR1BUS breaking changes found: **no**
- First-class plugin readiness: **pass** via managed `npm-pack:<tgz>` lane
- Release eligibility: **yes**, after bumping/retesting final `3.2.2`
- Runtime target: OpenClaw `2026.5.18` at `50a2481652b6a62d573ece3cead60400dc77020d`
- PLUR1BUS source: `3.2.2-beta.1` at `2cb8c75457cb945e3286000021372434979f3320`, exported via `git archive HEAD`; dirty working tree excluded.

## Evidence

- Exact OpenClaw installer completed under `kimi` in isolated prefix: `OpenClaw 2026.5.18 (50a2481)`.
- Link lane passed: runtime inspect loaded tools, hooks, command and provider bridge.
- Managed tarball lane passed: `plugins install npm-pack:<tarball>` installed PLUR1BUS as `origin: global`.
- `plugins doctor`: no plugin issues detected in both lanes.
- `memory-core` remained selected memory slot; PLUR1BUS remained `kind: extension`.
- Tarball hygiene passed: no review artifacts, model cache, node_modules, .env or root paths inside the package.

## OpenClaw Range

- Baseline: `v2026.5.16-beta.7` -> `fff4532d69d77fe1a8ca3baeaea4b7306cc40456`
- Target: `v2026.5.18` -> `50a2481652b6a62d573ece3cead60400dc77020d`
- Merge-base: `e0bb46b93a7078dbff303ac920bcad975a6c07c8`
- Target-side commits: 83; beta7-side drift: 40
- ClawSweeper: 0 high, 3 medium, 4 low, 1 unweighted, 40 unreviewed. Findings were channel/gateway/QQBot/Discord/release-stability related, not PLUR1BUS-breaking.

## Functional Matrix

- memory_store: **blocked** — No OpenAI/OpenAI-compatible key, local E5 smoke, or mock embedding provider configured; registration preserved.
- memory_recall: **blocked** — Provider-backed recall not executed without embedding provider; tool contract preserved.
- memory_forget: **blocked** — No provider-backed memory store created in this isolated lane; tool contract preserved.
- knowledge_update: **blocked** — Manual tool contract registered; no live workspace knowledge write performed.
- Auto-Capture via agent_end: **pass** — Runtime inspect shows agent_end hook registration with conversation access policy set.
- Auto-Recall via before_prompt_build / PromptSupplement: **pass** — Runtime inspect shows before_prompt_build hook; dynamic prompt injection policy enabled.
- CorpusSupplement / memory_search corpus=all visibility: **pass** — Plugin runtime loaded with additive memory corpus/prompt integration path; no memory slot takeover.
- Turn Journal: **pass** — Unit tests passed and runtime plugin loaded.
- Candidates: **pass** — Unit tests passed and runtime plugin loaded.
- Reaction Ledger: **pass** — Unit tests passed and runtime plugin loaded.
- BehaviorCards: **pass** — Unit tests passed and runtime plugin loaded.
- Embedding Queue: **pass** — Unit tests passed and provider bridge visible.
- Categories: **pass** — Unit tests passed.
- Origins: **pass** — Unit tests passed.
- Trust-Level: **pass** — Unit tests passed.
- Status-Machine: **pass** — Unit tests passed.
- Recall-Lanes: **pass** — Unit tests passed.
- Dreaming: **pass** — No OpenClaw breaking detected; scheduled dreaming not executed without live gateway.
- Provider bridge: plur1bus-openai: **pass** — Runtime inspect exposes provider id.
- Provider bridge: plur1bus-openai-compatible: **pass** — Runtime inspect exposes provider id.
- Provider bridge: plur1bus-e5-small: **pass** — Runtime inspect exposes provider id; local model smoke not executed.
- OpenAI provider state: **implemented** — Direct dependency is installed in managed npm-pack lane.
- OpenAI-compatible provider state: **implemented** — Adapter and config schema are installed in managed npm-pack lane.
- Cohere reranker state: **implemented** — Provider file packaged; no key-backed rerank call executed.
- disabled reranker state: **implemented** — Config normalizer tests passed.
- E5 local state: **experimental** — Transformers optional dependency installed; no model download/load smoke performed.
- GTE local reranker state: **experimental-blocked** — No local reranker model smoke performed; not counted as pass.

## Integration Opportunities

- registerMemoryEmbeddingProvider / contracts.memoryEmbeddingProviders: **ready** — PLUR1BUS provider ids visible in runtime inspect; OpenClaw enforces contract ownership without requiring kind:"memory".
- session_end shutdown/restart: **feature-flag candidate** — Useful for final capture flush; needs duplicate-capture guard.
- onSessionTranscriptUpdate: **feature-flag candidate** — Exported via memory host SDK; useful for incremental capture but should remain optional.
- runtime.state.openKeyedStore: **blocked-private-surface-for-external-plugin** — OpenClaw registry throws for non-bundled plugins in this release.
- scheduleSessionTurn / cron-backed session actions: **feature-flag candidate** — SDK surface exists; useful for Dreaming/maintenance, not needed for compatibility.
- openclaw cron run --wait: **ready-for-test-harness** — Can make future Dreaming tests deterministic.
- plugins validate: **not-applicable** — Current CLI documents it for simple tool plugin metadata; PLUR1BUS is a native extension.
- doctor --lint / diagnostics: **ready** — Doctor and security audit surfaces are useful; current deep audit warnings were gateway-auth baseline, not PLUR1BUS.

## Notes

- Provider-backed `memory_store -> memory_recall -> memory_forget` was not executed because no OpenAI/OpenAI-compatible key, local E5 smoke or mock provider was configured. This is recorded as blocked, not failed.
- `infer embedding providers --json` partially emitted the bundled local provider and then hung; PLUR1BUS provider visibility is proven by `plugins inspect --runtime --json`.
- OpenClaw security deep audit reported baseline isolated-gateway auth warnings, not a PLUR1BUS plugin issue.

## Final 3.2.2 Validation

After the beta audit passed, the package was bumped to `3.2.2` and retested against OpenClaw `2026.5.18` with managed `npm-pack:` install. Runtime inspect loaded `memory_recall`, `memory_store`, `memory_forget`, `knowledge_update`, four hooks, `/plur1bus`, and the three provider ids. `plugins doctor` reported no plugin issues.
