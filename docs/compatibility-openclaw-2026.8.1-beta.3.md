# OpenClaw 2026.8.1-beta.3 compatibility contract

PLUR1BUS 7.4.9 targets the immutable OpenClaw package
`openclaw@2026.8.1-beta.3`, Git tag `v2026.8.1-beta.3`, commit
`5831b80721f802072b0ec1893b30a16cf42d538c`, and npm integrity
`sha512-8v+2Knr+0i1qzWXgJmtcBg78VaoMENahLxcuThOqyCmVaCGPj++mI9yv0R440wMv9Siv4fysd5e0YmBVftDvuQ==`.

## Native host integration

PLUR1BUS uses only public OpenClaw capabilities:

- `kind: "memory"`, `plugins.slots.memory`, and `registerMemoryCapability`
  make PLUR1BUS the exclusive memory owner and advertise `memory_recall` as
  the deterministic recall tool.
- `registerEmbeddingProvider` plus `contracts.embeddingProviders` exposes the
  three reusable PLUR1BUS embedding adapters through Beta 3's generic
  provider contract. The retired memory-specific registrar is not used.
- `registerGatewayMethod` registers the PLUR1BUS Gateway method.
- `registerCli` registers the PLUR1BUS CLI.
- `openclaw/plugin-sdk/gateway-runtime` submits exact, allowlisted feature
  commands through the native cron/dispatcher path.
- typed lifecycle hooks register capture, recall, startup, and shutdown work.

These capabilities are detected from the runtime objects and exports before
use. Missing capabilities produce a fail-closed diagnostic. There is no
version-string branch and no OpenClaw runtime files are patched. PLUR1BUS does
not modify `node_modules`, generated OpenClaw bundles, or OpenClaw source files.

Feature cron planning is non-mutating. Only the exact shipped PLUR1BUS command
payloads are eligible. Native `commandArgv` execution is bounded, validates the
reply payload, preserves `NO_REPLY`, and lets OpenClaw own final status and
announce delivery. A command failure remains visible and cannot enable an
unsafe fallback carrier-model run.

## Skill Miner and Skill Workshop

PLUR1BUS does not write a live workspace skill on Beta 3. The Skill Miner
submits a pending draft through `skills.proposals.create`, stores the returned
proposal id and exact revision hash in its local evidence record, and exposes
that record through its existing review command. An authorized approval first
inspects the Workshop proposal, verifies proposal id, agent-scoped target,
skill name, status, and revision hash, then calls `skills.proposals.apply` with
that hash. Reject follows the same inspect-and-bind rule. A changed revision or
missing Workshop capability leaves the proposal unapplied.

OpenClaw's autonomous self-learning defaults to `auto`; PLUR1BUS deployments
that enable the Skill Miner should set `skills.workshop.autonomous.mode` to
`propose` (used by the compatibility lab) or `off`. This keeps OpenClaw's own
experience reviewer and PLUR1BUS's LanceDB evidence miner from independently
applying overlapping skills. Both can still share the same Workshop proposal
queue and scanner.

## Feature-overlap policy

| OpenClaw Beta-3 feature | PLUR1BUS overlap | Compatibility policy |
| --- | --- | --- |
| Exclusive memory slot and `memory-core` tools | Recall, capture, search, persistence | Select `memory-lancedb-namespaced`; PLUR1BUS registers the native memory capability, so `memory-core` is not a second active memory owner. |
| Active Memory | Pre-reply deep recall can call `memory_recall` while PLUR1BUS also has `autoRecall` | Native integration is supported through `deterministicRecallToolName`. Enable only one automatic pre-reply lane per agent; the compatibility lab disables Active Memory and tests PLUR1BUS hooks directly. Raw private-transcript recall is explicitly not claimed. |
| Memory-core dreaming | Consolidation, REM, promotion, diary | Set persisted `plugins.entries.memory-lancedb-namespaced.config.dreaming.enabled: false` when PLUR1BUS owns dreaming. Otherwise OpenClaw intentionally loads `memory-core` as a sidecar. The lab also disables `memory-core` explicitly. |
| Skill Workshop self-learning | Skill Miner proposals and approval | PLUR1BUS feeds the Workshop and never bypasses its scanner, hashes, ownership, or rollback. Use Workshop autonomous `propose`/`off` when the PLUR1BUS miner is enabled. |
| Scheduled tasks / cron dispatcher | PLUR1BUS consolidation, classifier, REM, miner, afterthought jobs | PLUR1BUS uses OpenClaw's public Gateway/CLI dispatcher and exact allowlisted commands; OpenClaw owns delivery, `NO_REPLY`, run status, and restart behavior. |
| Compaction memory flush | Durable capture before compaction | PLUR1BUS supplies no file-memory flush plan because conversation capture is handled by typed hooks. This avoids a second file-memory write lane. |
| `USER.md` user model | Preference and relationship memories | `USER.md` remains the authoritative current directive; PLUR1BUS is provenance-bearing recall/history. Do not auto-promote contradictory PLUR1BUS observations into `USER.md`. |
| Standing intents | PLUR1BUS reminders | Complementary: OpenClaw owns event-conditioned intents; exact-time work stays on scheduled tasks/PLUR1BUS reminder state. Do not represent the same obligation in both. |
| Memory Wiki / Obsidian mode | PLUR1BUS Obsidian Bridge and semantic graph | Keep a single writer per vault. The lab disables both optional bridges; cross-plugin artifact import is outside the 7.4.9 release claim. |
| Session/workspace ownership | Per-agent and per-workspace ACLs | OpenClaw session Owner is responsibility/display metadata, not authorization. PLUR1BUS continues to authorize by canonical agent, workspace, sender/chat ACL, and memory scope. |

The lab configuration makes every conflict decision explicit: PLUR1BUS owns
the memory slot; `memory-core`, Active Memory, OpenClaw dreaming, PLUR1BUS
dreaming/merging, and both vault bridges are disabled for the baseline memory
path; Skill Workshop stays enabled in proposal mode for the separate Skill
Miner integration test.

## Immutable local model artifacts

The local provider downloads only the following pinned Hugging Face revisions.
Every required file has an expected byte size and SHA-256 in
`lib/providers/local-model-artifacts.js`; a file becomes visible at its final
path only after a unique temporary download has been fully flushed and
verified.

| Role | Repository | Revision | Required ONNX artifact |
| --- | --- | --- | --- |
| E5 embedding | `intfloat/multilingual-e5-small` | `614241f622f53c4eeff9890bdc4f31cfecc418b3` | `onnx/model.onnx` |
| Jina primary reranker | `jinaai/jina-reranker-v2-base-multilingual` | `9cfeff2df7d40d1b78e75e5e9cebec92a99813c9` | `onnx/model_quantized.onnx` |
| Free BGE fallback reranker | `woxpas-ai/bge-reranker-v2-m3-onnx` | `c44ebc43de724ae8816668bb44d2e728e17faa18` | `onnx/model_quantized.onnx` |

Jina's published null `model_type` is accepted only for this validated model
profile and normalized to its XLM-RoBERTa architecture. The original BGE model
repository is rejected because it does not publish the ONNX artifact expected
by Transformers.js; the pinned ONNX export above is used instead. If Jina
inference fails and the configured free fallback is BGE, the request is tried
exactly once with BGE. Missing, partial, incorrectly sized, or incorrectly
hashed artifacts fail with a specific diagnostic and are never loaded.

## Data and upgrade compatibility

The 7.4.8 to 7.4.9 upgrade is non-destructive. It introduces no breaking
LanceDB schema change and does not rewrite an existing database merely because
the plugin version changed. Existing per-agent paths, namespace routing,
memory IDs, embeddings, tombstones, history, and Obsidian mirrors remain in
place. Normal idempotent schema initialization continues to supply defaults
for older tables, and all filesystem paths remain subject to agent-id and
containment validation.

Operators should still take a snapshot before any unrelated destructive
maintenance or explicit migration. Rollback consists of stopping the gateway,
installing the previously retained plugin package, and starting it again; no
OpenClaw rollback copy is required because 7.4.9 performs no host patch.

## Scope of the compatibility claim

The exact target above is the release gate. Newer OpenClaw commits are reviewed
for adjacent dispatcher, delivery, restart, and hook behavior but are not
silently incorporated. Compatibility is established only by testing the
packed 7.4.9 artifact in a fresh OpenClaw 2026.8.1-beta.3 runtime, including
runtime registration, gateway readiness, explicit and automatic memory paths,
restart persistence, agent isolation, cron delivery, and real local-model
inference.
