# OpenClaw 2026.9.1-beta.1 compatibility contract

PLUR1BUS 7.5.0 targets the immutable OpenClaw package
`openclaw@2026.9.1-beta.1`, Git tag `v2026.9.1-beta.1`, commit
`1d96e5aee2d49cde999ed055eda113e2523a7b5c`, and npm integrity
`sha512-XaK/3Vn+jDrudy8gVSUfFRUpJu4/E2LaXrvfyFUPrCMVze9LjASr8mI8YYOTu216jiOCfHd42VwINLaviklSog==`.

The PLUR1BUS upstream base is source version 7.4.10 at exact commit
`c0a8a4c28ff1cb9c632e185f21f4502d67d1b605` (release metadata commit
`0e7eb3c3d0f77c23d9e8adb94ac285fd424b3d80`). At integration time the official
remote had not yet published a `v7.4.10` Git tag or GitHub Release, so this
document identifies the immutable commit rather than treating `main` as a
release reference. Its Neo JSONL cap-hysteresis fix is retained in 7.5.0.

## Native host integration

PLUR1BUS uses only public OpenClaw capabilities:

- `kind: "memory"`, `plugins.slots.memory`, and `registerMemoryCapability`
  make PLUR1BUS the exclusive memory owner and advertise `memory_recall` as
  the deterministic recall tool.
- `registerEmbeddingProvider` plus `contracts.embeddingProviders` exposes the
  three reusable PLUR1BUS embedding adapters through OpenClaw's generic
  provider contract. The retired memory-specific registrar is not used.
- `registerGatewayMethod` registers the PLUR1BUS Gateway method.
- `registerCli` registers the PLUR1BUS CLI.
- `openclaw/plugin-sdk/gateway-runtime` submits exact, allowlisted feature
  commands through the native cron/dispatcher path.
- typed lifecycle hooks register capture, recall, startup, and shutdown work.

OpenClaw 2026.9.1-beta.1 preserves the public runtime lifecycle and focused
config mutation contracts while changing registry staging and config-watcher
handoff internally. PLUR1BUS therefore registers model preparation through an
OpenClaw plugin service, so an inactive or discarded registry builder cannot
start a download. It keeps the public runtime lifecycle as a fail-safe owner,
drains in-flight inference before disposal, and serializes model acquisition
across activated registry generations. It does not depend on private registry
epochs or watcher implementation details.

The enabled Obsidian watcher uses the same public `registerService` lifecycle
on this target. OpenClaw starts it only after the replacement registry is
active and stops the previous service before handoff, so enabling the Bridge by
supported config mutation works without waiting for a second
`gateway_start` event. Older hosts without `registerService` retain the typed
start/stop hook fallback through capability detection.

OpenClaw instantiates generic embedding providers for request-scoped agent and
tool-discovery registries outside the activated full-runtime JavaScript owner.
PLUR1BUS keeps one activation-owned local model and delegates only bounded
embedding requests over a private Unix socket below `baseDbPath`. A freshly
rotated 256-bit token, directory/socket permissions, and the complete immutable
embedding fingerprint bind every request to the active generation. Beta-1 can
retain a discovery facade across a config hot reload, so that facade constructs
one fresh epoch-bound client per pure embedding operation. Individual clients
never rebind or reuse a rotated token; a mid-operation rotation fails closed.
The socket is not exposed as a host port, begins only as an activated OpenClaw
plugin service, stops before the local model, and fails closed while no owner
service is available.

A confirmed re-embedding switch is handed off durably in `switching` state
before the focused config mutation replaces the plugin registry. Only the
activated replacement runtime runs the real provider/store/recall probe and
commits `completed`. A failed target probe persists a rollback intent, switches
back through the same public config API, and is finalized only by the activated
source runtime after its own probe. Unknown selection drift remains gated
rather than being reported as a completed or safely rolled-back switch.
Reverse migrations derive their quarantined LanceDB generation from a bounded
digest rather than concatenating the operator-visible migration ID, so every
accepted rollback request also satisfies the backend's 64-character generation
identifier contract.

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

PLUR1BUS does not write a live workspace skill directly. The Skill Miner
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

| OpenClaw 2026.9.1 feature | PLUR1BUS overlap | Compatibility policy |
| --- | --- | --- |
| Exclusive memory slot and `memory-core` tools | Recall, capture, search, persistence | Select `memory-lancedb-namespaced`; PLUR1BUS registers the native memory capability, so `memory-core` is not a second active memory owner. |
| Active Memory | Pre-reply deep recall can call `memory_recall` while PLUR1BUS also has `autoRecall` | Native integration is supported through `deterministicRecallToolName`. Enable only one automatic pre-reply lane per agent; the compatibility lab disables Active Memory and tests PLUR1BUS hooks directly. Raw private-transcript recall is explicitly not claimed. |
| Memory-core dreaming | Consolidation, REM, promotion, diary | Set persisted `plugins.entries.memory-lancedb-namespaced.config.dreaming.enabled: false` when PLUR1BUS owns dreaming. Otherwise OpenClaw intentionally loads `memory-core` as a sidecar. The lab also disables `memory-core` explicitly. |
| Skill Workshop self-learning | Skill Miner proposals and approval | PLUR1BUS feeds the Workshop and never bypasses its scanner, hashes, ownership, or rollback. Use Workshop autonomous `propose`/`off` when the PLUR1BUS miner is enabled. |
| System-owned skill collection review | Skill Miner cron creates Workshop proposals | The OpenClaw job reviews its collection; the PLUR1BUS job mines memory evidence. They have distinct ownership and job IDs. The lab verifies that each proposal is submitted once and that neither job applies a skill autonomously. |
| Scheduled tasks / cron dispatcher | PLUR1BUS consolidation, classifier, REM, miner, afterthought jobs | PLUR1BUS uses OpenClaw's public Gateway/CLI dispatcher and exact allowlisted commands; OpenClaw owns delivery, `NO_REPLY`, run status, and restart behavior. |
| Config-watcher handoff and restart recovery | Provider reload, model preparation, re-embedding checkpoints, automatic capture | Durable PLUR1BUS state remains under its own volume. Preparation begins only after the replacement plugin service is active; shutdown aborts and checkpoints owned work before disposal. Resumed OpenClaw turns do not create a second PLUR1BUS runtime generation. |
| Configurable model-selection scopes | Agent-inherited models for PLUR1BUS feature LLM calls | PLUR1BUS consumes the effective OpenClaw runtime model for the target agent/session and does not persist its own sticky chat-model selection. A feature-specific direct-provider override is used only when its provider configuration is complete. |
| Session provenance and `openclaw memory forget` | PLUR1BUS origin metadata, archive-first `/forget`, tombstones | The OpenClaw command operates on `memory-core`; PLUR1BUS forget operates only on its selected LanceDB memory slot and remains confirmation-bound and recoverable. Provenance is preserved in each store; there is no cross-store deletion or implicit import. |
| Compaction memory flush | Durable capture before compaction | PLUR1BUS supplies no file-memory flush plan because conversation capture is handled by typed hooks. This avoids a second file-memory write lane. |
| `USER.md` user model | Preference and relationship memories | `USER.md` remains the authoritative current directive; PLUR1BUS is provenance-bearing recall/history. Do not auto-promote contradictory PLUR1BUS observations into `USER.md`. |
| Standing intents | PLUR1BUS reminders | Complementary: OpenClaw owns event-conditioned intents; exact-time work stays on scheduled tasks/PLUR1BUS reminder state. Do not represent the same obligation in both. |
| Memory Wiki / Obsidian mode | PLUR1BUS Obsidian Bridge and semantic graph | Keep a single writer per vault. The baseline disables both optional bridges; a separate isolated-vault probe enables PLUR1BUS apply/watch mode and verifies outbound and inbound synchronization. Cross-plugin artifact import remains outside the 7.5.0 release claim. |
| Session/workspace ownership | Per-agent and per-workspace ACLs | OpenClaw session Owner is responsibility/display metadata, not authorization. PLUR1BUS authorizes by canonical agent, workspace, sender/chat ACL, and memory scope. Beta-1 `sessions.create({ cwd })` is resolved through `spawnedCwd` with feature-detected legacy fallbacks. Automatic captures remain agent-private; explicit workspace-scope cards are the workspace-isolated data path. |

The lab configuration makes every conflict decision explicit: PLUR1BUS owns
the memory slot; `memory-core`, Active Memory, OpenClaw dreaming, PLUR1BUS
dreaming/merging, and both vault bridges are disabled for the baseline memory
path. Separate controlled probes enable PLUR1BUS REM and its Obsidian Bridge
against synthetic lab data and a dedicated vault. Skill Workshop stays enabled
in proposal mode for the separate Skill Miner integration test.

## Immutable local model artifacts

The local provider downloads only the following pinned Hugging Face revisions.
Every required file has an expected byte size and SHA-256 in
`lib/providers/local-model-artifacts.js`; a file becomes visible at its final
path only after a unique temporary download has been fully flushed and
verified.

| Role | Repository | Revision | Required ONNX artifact |
| --- | --- | --- | --- |
| E5 embedding | `intfloat/multilingual-e5-small` | `614241f622f53c4eeff9890bdc4f31cfecc418b3` | `onnx/model.onnx` |
| Optional multilingual Jina v3 embedding (CC BY-NC 4.0) | `jinaai/jina-embeddings-v3` base `ab036b023d30b4d1138c4c3bfa9f0c445ab455d6`; Q8 conversion `ldwformat/jina-embeddings-v3-Q8-onnx` | `68ed94909d564380f954be27ae2e133214c1adc9` | local `onnx/model_quantized.onnx` from pinned `model.onnx` |
| Jina primary reranker | `jinaai/jina-reranker-v2-base-multilingual` | `9cfeff2df7d40d1b78e75e5e9cebec92a99813c9` | `onnx/model_quantized.onnx` |
| Free BGE fallback reranker | `woxpas-ai/bge-reranker-v2-m3-onnx` | `c44ebc43de724ae8816668bb44d2e728e17faa18` | `onnx/model_quantized.onnx` |

Jina's published null `model_type` is accepted only for the two validated Jina
profiles and normalized to their XLM-RoBERTa architecture. Jina v3 embedding
uses the published retrieval task IDs and only the seven declared Matryoshka
dimensions. Its pinned Q8 conversion is executed without ONNX graph rewriting,
because the optimizer in the pinned runtime otherwise fails on its precision-
cast nodes. The original BGE model
repository is rejected because it does not publish the ONNX artifact expected
by Transformers.js; the pinned ONNX export above is used instead. If Jina
inference fails and the configured free fallback is BGE, the request is tried
exactly once with BGE. Missing, partial, incorrectly sized, or incorrectly
hashed artifacts fail with a specific diagnostic and are never loaded.

Selecting one of the closed `modelPreparation.profile` values in OpenClaw
Config starts an isolated, resumable preparation stage. It downloads and
validates the pinned files atomically, persists aggregate progress for the
read-only Control UI, and coalesces a concurrent provider request for the same
artifact. Jina preparation additionally requires an explicit CC BY-NC 4.0
acknowledgement. The same gate is enforced by direct providers, OpenClaw
embedding adapters, scripts, artifact downloads, and re-embedding target
probes. Preparation and the eventual target provider resolve one shared local
cache path even while the active provider is remote. A changed target fingerprint produces a non-mutating row,
storage, and free-space recommendation only. It never writes LanceDB, creates a
migration, consumes a confirmation token, or changes the active provider; the
existing operator-admin plan/apply/switch confirmations remain authoritative.

## Data and upgrade compatibility

The 7.4.8 or 7.4.10 to 7.5.0 upgrade is non-destructive. It introduces no breaking
LanceDB schema change and does not rewrite an existing database merely because
the plugin version changed. Existing per-agent paths, namespace routing,
memory IDs, embeddings, tombstones, history, and Obsidian mirrors remain in
place. Normal idempotent schema initialization continues to supply defaults
for older tables, and all filesystem paths remain subject to agent-id and
containment validation.

Operators should still take a snapshot before any unrelated destructive
maintenance or explicit migration. Rollback consists of stopping the gateway,
installing the previously retained plugin package, and starting it again; no
OpenClaw rollback copy is required because 7.5.0 performs no host patch.

## Scope of the compatibility claim

The exact target above is the release gate. Newer OpenClaw commits are reviewed
for adjacent dispatcher, delivery, restart, and hook behavior but are not
silently incorporated. Compatibility is established only by testing the
packed 7.5.0 artifact in a fresh OpenClaw 2026.9.1-beta.1 runtime, including
runtime registration, gateway readiness, explicit and automatic memory paths,
restart persistence, agent isolation, cron delivery, and real local-model
inference.
