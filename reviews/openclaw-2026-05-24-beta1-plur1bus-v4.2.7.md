# PLUR1BUS 4.2.7 vs OpenClaw 2026.5.24-beta.1

## Verdict

- Beta compatibility: **pass with blocked functional smokes**.
- First-class plugin readiness: **pass** via isolated managed `npm-pack:` tarball install.
- PLUR1BUS breaking changes found: **none** in the checked target range.
- Confidence: **medium-high**. Static, package, install, runtime inspect, hook surface, and provider bridge are green; provider-backed tool calls and a real hook-fire turn were intentionally not run.

## Target Snapshot

- Local live OpenClaw before audit: `OpenClaw 2026.5.20 (e510042)`.
- Target beta: `openclaw@2026.5.24-beta.1`, tag `v2026.5.24-beta.1` = `0e2e7c66bd6a904518b9ca9efd54b9bb1a4c8c2c`.
- Final `openclaw@2026.5.24`: not published on npm during preflight.
- Local PLUR1BUS source: `4.2.7`, tag `v4.2.7`, commit `1a476e7ef49332d225417477da0a8e87224f2979`.
- Source mode for isolated runtime: `git archive HEAD`; no live OpenClaw instance was updated.

## Range Review

- Merge base `v2026.5.20` -> `v2026.5.24-beta.1`: `1b1580cbc3f578cac26ae516fa41e516d853a26c`.
- Target-side commits classified: **755**.
- Local-stable side context commits: **19**.
- Target-side changed files: **2368**.
- Forward-look `v2026.5.24-beta.1` -> `origin/main`: **92** commits, not part of the beta verdict.
- ClawSweeper: no high/medium report data; all **755** commits were unreviewed in the state repo, so local diff/runtime analysis is the source of truth.

## Runtime Harness

- Isolated base: `/home/kimi/openclaw-beta-20260524-runtime-m1gVbu`.
- Exact beta installed under non-root `kimi`: `/home/kimi/openclaw-beta-20260524-runtime-m1gVbu/prefix/bin/openclaw`.
- Bare `openclaw` was not used for isolated runtime checks.
- Tarball lane profile: `plur1bus-20260524-beta1-tarball`.
- Link lane profile: `plur1bus-20260524-beta1-link`.

## Plugin Gates

- Static gates: `node --check` pass, unit tests pass (**14/14**), `npm pack --dry-run` pass.
- Managed install: pass via `plugins install npm-pack:$BASE/artifacts/cyb3rb1ade-plur1bus-memory-4.2.7.tgz`.
- Runtime tools visible: `memory_recall`, `memory_search`, `memory_store`, `memory_forget`, `knowledge_update`.
- Runtime provider bridge visible: `plur1bus-openai`, `plur1bus-openai-compatible`, `plur1bus-e5-small`.
- Hook policy: non-bundled `agent_end` requires `hooks.allowConversationAccess=true`; after setting it in the isolated profile, runtime inspect shows `agent_end`, `before_prompt_build`, `gateway_start`, `gateway_stop`.
- Memory boundary: PLUR1BUS remains `kind: extension`, `capabilityMode: none`; no default `registerMemoryCapability` path.

## Functional Matrix

- memory_store: **blocked** - Runtime tool visible; actual write smoke blocked because no provider key/local E5/mock provider was used.
- memory_recall: **blocked** - Runtime tool visible; actual recall smoke blocked by provider setup.
- memory_forget: **blocked** - Runtime tool visible; destructive/DB-backed smoke not run against live state.
- knowledge_update: **blocked** - Runtime tool visible; mutation smoke not run against live workspace.
- Auto-Capture via agent_end: **pass** - agent_end typed hook registered in live and isolated tarball/link lanes when allowConversationAccess=true. Hook fire was not exercised.
- Auto-Recall via before_prompt_build: **pass** - before_prompt_build typed hook registered; policy allowPromptInjection=true in isolated lanes. Hook fire was not exercised.
- PromptSupplement: **pass** - Source registers registerMemoryPromptSupplement when API exists; no runtime inspect field exposes supplement separately.
- CorpusSupplement: **pass** - Source registers registerMemoryCorpusSupplement when API exists; no runtime inspect field exposes supplement separately.
- memory_search corpus=all visibility: **blocked** - memory_search tool visible; actual corpus=all query not run without provider-backed memory fixture.
- Turn Journal: **pass** - Unit/static gates passed; runtime mutation smoke not run.
- Candidates: **pass** - Unit/static gates passed; runtime mutation smoke not run.
- Reaction Ledger: **pass** - Unit/static gates passed; runtime mutation smoke not run.
- BehaviorCards: **pass** - Unit/static gates passed; runtime mutation smoke not run.
- Embedding Queue: **pass** - Unit/static gates passed; provider-backed drain not run.
- Categories: **pass** - Unit/static gates passed.
- Origins: **pass** - Unit/static gates passed.
- Trust-Level: **pass** - Unit/static gates passed.
- Status-Machine: **pass** - Unit/static gates passed.
- Recall-Lanes: **pass** - Unit/static gates passed; no live prompt injection smoke.
- Dreaming: **blocked** - Scheduled/deep dreaming not run; no live cron/session mutation in audit.
- Provider bridge plur1bus-openai: **pass** - Runtime memoryEmbeddingProviderIds exposes provider.
- Provider bridge plur1bus-openai-compatible: **pass** - Runtime memoryEmbeddingProviderIds exposes provider.
- Provider bridge plur1bus-e5-small: **pass** - Runtime memoryEmbeddingProviderIds exposes provider; local model load not smoked.
- OpenAI provider state: **implemented** - Implemented and visible; no real API call.
- OpenAI-compatible provider state: **implemented** - Implemented and visible; no real API call.
- Cohere reranker state: **implemented** - Live doctor shows Cohere reranker configured as rerank-v3.5; no isolated API call.
- disabled reranker state: **implemented** - Config schema supports disabled provider.
- local E5 state: **experimental** - Provider visible; local model smoke not run.
- local GTE reranker state: **experimental-blocked** - Code/config supports local-transformers reranker, but no Node/Transformers.js smoke was run.

## High-Risk Commit Classes

The full JSON contains every target-side commit. Representative high-risk commits/classes:

- `66dcc4ee8f` fix(codex): beta blocker - keep context engine on canonical session key (#84954) [plugins-sdk-packaging, gateway-lifecycle, sessions-transcripts] -> smoke-required
- `cf0657852f` feat(qa-lab): add jsonl replay harness [plugins-sdk-packaging, gateway-lifecycle, sessions-transcripts, tools-cli] -> smoke-required
- `229323d37a` test(qa-lab): add personal failure recovery scenario [plugins-sdk-packaging, gateway-lifecycle, providers-auth, tools-cli] -> smoke-required
- `277a4b6952` fix(ollama): allow Orb host local auth (#84999) [plugins-sdk-packaging, providers-auth] -> smoke-required
- `da1925cb67` test(e2e): isolate kitchen sink rpc gateway [gateway-lifecycle] -> smoke-required
- `9f2c0a80b4` fix(qa): keep searchable tool coverage report-only [plugins-sdk-packaging, tools-cli] -> smoke-required
- `652712e0ad` ci(qa): publish soak parity artifacts [memory-embedding] -> smoke-required
- `b33deb4159` fix(sessions): preserve compatible auth overrides (#85014) [gateway-lifecycle, sessions-transcripts, providers-auth, tools-cli] -> smoke-required
- `efb7e4742f` test(qa-lab): trace scenario issue evidence [plugins-sdk-packaging, tools-cli] -> smoke-required
- `5955f354f7` fix(status): add gateway delivery health telemetry (#85016) [plugins-sdk-packaging, gateway-lifecycle, cron-scheduling, tools-cli] -> smoke-required
- `178e510aae` test(qa-lab): cover update package sentinel [plugins-sdk-packaging] -> smoke-required
- `205c595b13` fix(auth): skip OAuth refresh adapter when credential has no refresh token (#85028) [providers-auth] -> smoke-required
- `23c58081d0` fix(docker): prune omitted plugin runtime deps [plugins-sdk-packaging] -> smoke-required
- `46c8864048` revert(qa-lab): remove scenario github traceability metadata [plugins-sdk-packaging, tools-cli] -> smoke-required
- `bbf3eec786` test(qa-lab): cover codex plugin lifecycle fixtures [plugins-sdk-packaging, gateway-lifecycle, providers-auth] -> smoke-required
- `7d5afcbb3f` fix #84745: scope Google preview model normalization to Google providers only (#84762) [providers-auth, tools-cli] -> smoke-required
- `b25a0d013b` test(gateway): relax e2e node status waits [gateway-lifecycle] -> smoke-required
- `ebd8b00cc3` fix(qa-lab): rename codex lifecycle fixtures to match knip ignore pattern (#85066) [plugins-sdk-packaging, gateway-lifecycle, providers-auth] -> smoke-required
- `4f80cc1943` perf(models): pre-warm provider auth state at gateway startup [gateway-lifecycle, providers-auth, tools-cli] -> smoke-required
- `180cecda85` test(model-provider-auth): cover prepared-state short-circuit and clear [providers-auth] -> smoke-required
- `01087cb936` address review: scope short-circuit by caller auth context + rewarm on reload [gateway-lifecycle, providers-auth] -> smoke-required
- `c452a1e7e5` address review v2: workspace scope, warm generation guard, plugin reload trigger [plugins-sdk-packaging, gateway-lifecycle, providers-auth] -> smoke-required
- `7ddcca6c77` address review v3: invalidate prepared map on auth-profile logout + defer plugin-reload rewarm [plugins-sdk-packaging, gateway-lifecycle, providers-auth] -> smoke-required
- `aef8d1771d` fix(models): reset warmed provider auth on hot reload [gateway-lifecycle, providers-auth] -> smoke-required
- `1d5b5db4d2` fix(codex): demote plugin thread eligibility log [plugins-sdk-packaging, gateway-lifecycle, sessions-transcripts] -> smoke-required
- `4399eee6e0` fix(auth): load legacy Codex OAuth sidecars in embedded secrets-runtime loaders (#85074) [gateway-lifecycle, providers-auth] -> smoke-required
- `faf96ff99b` test: fix environment sensitivity in resolveNpmCommandInvocation test (#83405) [plugins-sdk-packaging, tools-cli] -> smoke-required
- `9b7e431b89` refactor(gateway): remove unused readLastMessagePreviewFromTranscript helper (#84427) [gateway-lifecycle, sessions-transcripts] -> smoke-required
- `b77f36fb1c` fix(exec): protect pathPrepend against posix login-shell RC overrides (#81403) [gateway-lifecycle, tools-cli] -> smoke-required
- `01d95b9757` fix(gateway): allow bearer-auth session history reads (#81815) [gateway-lifecycle, sessions-transcripts, providers-auth, security-policy] -> smoke-required

## Integration Opportunities

- generic embeddingProviders: **feature-flag candidate** (medium-high, medium). Keep current memoryEmbeddingProviders for PLUR1BUS 4.2.7; prototype generic embeddingProviders only as optional bridge.
- awaited local agent_end hooks: **ready** (high, low). Positive for PLUR1BUS capture reliability; no code change required.
- session workflow helpers: **feature-flag candidate** (medium, medium). Candidate for future Dreaming/Review tasks; do not replace current hooks in compatibility branch.
- cron delivery/channel target routing: **feature-flag candidate** (medium, medium). Use for scheduled PLUR1BUS reviews only after a dedicated cron smoke.
- plugin metadata snapshots and lazy startup: **ready** (medium, low-medium). No change required; keep pack/install metadata complete.
- bundled dependency/shrinkwrap work: **ready** (high, low-medium). No PLUR1BUS fix required; tarball lane is the proof point.
- transcript/source reply rewrite hardening: **smoke-required** (medium, medium). Future hook-fire smoke should validate no duplicate capture from rewritten transcript entries.
- public memory artifacts: **ready** (medium, low). Possible future integration for companion tools; not required for PLUR1BUS augment mode.

## Go / No-Go

Go for compatibility: **yes, with two runtime-smoke caveats**.

No PLUR1BUS code change is required for OpenClaw `2026.5.24-beta.1` based on this audit. Before a live update, still run a provider-backed memory smoke and one real isolated turn to prove hook firing and no double injection.
