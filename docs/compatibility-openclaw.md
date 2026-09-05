# OpenClaw compatibility contract

PLUR1BUS supports OpenClaw 2026.8.1 stable as its primary host target.
OpenClaw 2026.9.1 stable is additionally supported and verified; it replaces
2026.9.1-beta.1, which was only ever a source-verified forward-compatibility
target and is no longer referenced. The declared compatibility floor is
`openclaw@2026.8.1` and plugin API `>=2026.8.1`.

The immutable build baseline is `openclaw@2026.8.2`, commit
`0965053fe6b9341776df147a6934b7485c60b5ca`, and npm integrity
`sha512-I9aqK1attaONePpWs2gPqh23s1s1EDcN/6icF2AAfONdtowu4156QD7g6oD7KlA2vQ9yiqnvlAVH6yduvGH9Ig==`.
The package is built and tested against a host in its own supported range
rather than against a beta no operator runs. This matters beyond metadata: the
installed-host loader test drives that exact OpenClaw plugin loader, so the
build baseline decides which host contract the fast test loop measures.

The PLUR1BUS upstream base is the official annotated Git tag `v7.4.10`
(tag object `f6cf0e75b4f8df509cac7b68bc437a25d650af73`), dereferencing exact commit
`c0a8a4c28ff1cb9c632e185f21f4502d67d1b605` and tree
`dbdbc17ce194f4389b0399abdc8fcd80acf7095d`. The corresponding GitHub Release
was published at `2026-08-28T23:43:38Z` without binary or npm assets. The tag
commit's content-identical second parent is release-preparation commit
`0e7eb3c3d0f77c23d9e8adb94ac285fd424b3d80`; the annotated tag still resolves
only to `c0a8a4c28ff1cb9c632e185f21f4502d67d1b605`. Its Neo JSONL
cap-hysteresis fix is retained in 7.5.0.

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

OpenClaw 2026.8.1 exposes every plugin-SDK subpath and host API used by this
contract, including `skill_proposal_changed`; its public SDK surface is a
superset of the 2026.9.1 surface used here. Gateway behavior is not
assumed to be a superset. In particular, registry staging, focused config
mutation, config-watcher handoff, and restart recovery are explicit runtime
gates for 2026.8.1 rather than conclusions drawn from release-note PR credits.

OpenClaw suppresses its own pre-compaction memory flush for Incognito sessions,
but still dispatches the generic plugin `agent_end` hook. Before automatic
capture can schedule embedding or storage, PLUR1BUS therefore classifies the
session through the public `isIncognitoSessionKey` routing export. Incognito
sessions are skipped. A missing classifier, failed SDK import, missing session
key, thrown classifier, or non-boolean result also skips capture fail-closed and
emits a redacted warning; explicit memory tools remain subject to their normal
authorization and are not silently reclassified as automatic capture.

PLUR1BUS registers model preparation through an OpenClaw plugin service, so an
inactive or discarded registry builder cannot start a download. It keeps the
public runtime lifecycle as a fail-safe owner, drains in-flight inference
before disposal, and serializes model acquisition across activated registry
generations. It does not depend on private registry epochs or watcher
implementation details. The full 2026.8.1 matrix must capture evidence that
the `switching` config mutation activates exactly one replacement registry and
that restart recovery neither loses the durable handoff nor starts a second
runtime generation.

The enabled Obsidian watcher uses the public `registerService` lifecycle on
both supported targets. The compatibility contract requires OpenClaw to start
it only after the replacement registry is active and to stop the previous
service before handoff, so enabling the Bridge by supported config mutation
works without waiting for a second `gateway_start` event. The 2026.8.1 matrix
must exercise this handoff deliberately and retain evidence that only one
watcher owns the isolated vault. Older hosts without `registerService` retain
the typed start/stop hook fallback through capability detection. Periodic
watcher scans are deliberately queue-only: they may stage review candidates
but cannot start a non-cancellable LanceDB memory mutation. Approved memory
apply and tombstone operations remain explicit authorized actions. Shutdown
fences follow-up work, awaits active host and manual work fail-closed, and
prevents a stopped generation from writing a late Vault mirror or metrics
update. If non-cancellable I/O exceeds the service-stop deadline, the handoff
must reject the replacement instead of activating a second writer.

OpenClaw instantiates generic embedding providers for request-scoped agent and
tool-discovery registries outside the activated full-runtime JavaScript owner.
PLUR1BUS keeps one activation-owned local model and delegates only bounded
embedding requests over a private Unix socket below `baseDbPath`. A freshly
rotated 256-bit token, directory/socket permissions, and the complete immutable
embedding fingerprint bind every request to the active generation. A discovery
facade retained across a config hot reload constructs one fresh epoch-bound
client per pure embedding operation. Individual clients never rebind or reuse
a rotated token; a mid-operation rotation fails closed. The socket is not
exposed as a host port, begins only as an activated OpenClaw plugin service,
stops before the local model, and fails closed while no owner service is
available.

A confirmed re-embedding switch is handed off durably in `switching` state
before the focused config mutation replaces the plugin registry. Only the
activated replacement runtime runs the real provider/store/recall probe and
commits `completed`. A failed target probe persists a rollback intent, switches
back through the same public config API, and is finalized only by the activated
source runtime after its own probe. Unknown selection drift remains gated
rather than being reported as a completed or safely rolled-back switch.
Because this path depends directly on registry staging and config-watcher
handoff, the 2026.8.1 matrix must record the config mutation, registry
replacement, target probe, and durable terminal state as one explicit evidence
chain. The same switch has not been re-driven end to end on 2026.9.1; the
2026.9.1 evidence below covers plugin load and the full test suite, not a
second live re-embedding switch.
Reverse migrations derive their quarantined LanceDB generation from a bounded
digest rather than concatenating the operator-visible migration ID, so every
accepted rollback request also satisfies the backend's 64-character generation
identifier contract.

CPU-backed migration work is limited to one durable embedding batch per
operator RPC. Every additional batch is an explicit, token-bound,
crash-resumable `resume` operation against the persisted cursor. The TTL gates only the first
`planned` to `confirmed` transition: a confirmed migration remains resumable
after the original token TTL expires, while every subsequent apply, resume,
validation handoff, and switch still requires the exact token and plan binding.
An explicit new plan may atomically retire an expired, idle coordinator-owned
migration as `expired_migration_superseded`; it preserves the old cursor,
receipts, and quarantined data for audit or recovery. Unexpired work and any
switch or rollback state remain hard conflicts. Target-provider instances are
keyed by the complete Plan-Digest and shut down before a replacement plan can
load a different same-dimension model.

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

| OpenClaw feature | PLUR1BUS overlap | Compatibility policy |
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
| Memory Wiki / Obsidian mode | PLUR1BUS Obsidian Bridge and semantic graph | Keep a single writer per vault. The baseline disables both optional bridges; a separate isolated-vault probe enables PLUR1BUS apply/watch mode. The host-managed watcher mirrors authorized LanceDB records outbound and queues inbound candidates only; inbound memory mutation requires a separate authorized apply. Cross-plugin artifact import remains outside the 7.5.0 release claim. |
| Session/workspace ownership | Per-agent and per-workspace ACLs | OpenClaw session Owner is responsibility/display metadata, not authorization. PLUR1BUS authorizes by canonical agent, workspace, sender/chat ACL, and memory scope. `sessions.create({ cwd })` is resolved through `spawnedCwd` with feature-detected legacy fallbacks. Automatic captures remain agent-private; explicit workspace-scope cards are the workspace-isolated data path. |

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
| Optional Jina v5 Text Nano embedding (CC BY-NC 4.0, lab test pending) | `jinaai/jina-embeddings-v5-text-nano-retrieval` | `ac5d898c8d382b17167c33e5c8af644a3519b47d` | `onnx/model_quantized.onnx` + `onnx/model_quantized.onnx_data` |
| Optional Jina v2 reranker (CC BY-NC 4.0) | `jinaai/jina-reranker-v2-base-multilingual` | `9cfeff2df7d40d1b78e75e5e9cebec92a99813c9` | `onnx/model_quantized.onnx` |
| BGE reranker (recommended default, Apache 2.0) | `woxpas-ai/bge-reranker-v2-m3-onnx` | `c44ebc43de724ae8816668bb44d2e728e17faa18` | `onnx/model_quantized.onnx` |

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

The 7.4.10 to 7.5.0 upgrade is non-destructive. It introduces no breaking
LanceDB schema change and does not rewrite an existing database merely because
the plugin version changed. Existing per-agent paths, namespace routing,
memory IDs, embeddings, tombstones, history, and Obsidian mirrors remain in
place. Normal idempotent schema initialization continues to supply defaults
for older tables, and all filesystem paths remain subject to agent-id and
containment validation. The primary release gate performs this real upgrade on
OpenClaw 2026.8.1 with legacy data, package installation, recall before and
after a Gateway restart, and retained-data evidence.

Operators should still take a snapshot before any unrelated destructive
maintenance or explicit migration. Rollback consists of stopping the gateway,
installing the previously retained plugin package, and starting it again; no
OpenClaw rollback copy is required because 7.5.0 performs no host patch.

## Scope of the compatibility claim

OpenClaw 2026.8.1 stable is the declared compatibility floor. Two host
behaviours that decide whether this plugin works at all were verified in the
released 2026.8.1 package, not inferred from a beta: the restricted
`cli-metadata` registration proxy that aborted every CLI command before the
fix, and the Telegram command path's `entry?.sessionId || randomUUID()`
fallback that made two-step confirmations unreachable in a fresh chat. Both
fixes cover 2026.8.1 and 2026.8.2 alike. 2026.8.1 is source-verified in this
way; its runtime matrix has not been executed.

The full runtime matrix was executed against OpenClaw 2026.8.2 stable, testing
one packed 7.5.0 artifact from the frozen source commit in a fresh 2026.8.2
runtime, with every PLUR1BUS feature enabled. It covers registration, Gateway
readiness, explicit and automatic memory paths, workspace policy, cron
delivery, the Skill Workshop lifecycle, the Obsidian bridge including the
vault confirmation and apply driven through a real Telegram ingress, real
local-model providers, the re-embedding and rollback handoffs above, restart
persistence, agent isolation, and the install lifecycle. The real 7.4.10 to
7.5.0 upgrade test also runs on 2026.8.2 against the final commit. Runtime
evidence for both is recorded under the laboratory evidence root cited in the
release report.

## OpenClaw 2026.9.1

OpenClaw 2026.9.1 stable (published 2026-09-03) is a verified host target,
checked on 2026-09-04 against `openclaw@2026.9.1` from the npm registry with
that release's own `@openclaw/*` dependencies installed. Mixing a 2026.9.1
distribution with 2026.8.2 dependencies produces a spurious load failure
(`@openclaw/ai/diagnostics` missing `hasRetryableConnectionErrorCode`) that also
takes down OpenClaw's own memory-core plugin; that is a laboratory artefact, not
a compatibility finding.

Evidence:

- The `b13-installed-host-loader` test drives the real 2026.9.1 plugin loader.
  PLUR1BUS loads, and every registration the test pins (runtime lifecycle,
  local-model owner service, scoped embedding IPC service, preparation service,
  the `reply_dispatch` hook, and the named registrations) is present.
- The full suite runs against 2026.9.1: 4176 assertions pass. The two failures
  are not compatibility defects. `feature-cron-plugin-runtime` asserts the
  installed host is exactly the 2026.8.2 build baseline, which is the pin doing
  its job, and `local-inference-dependency` fails identically on 2026.8.2 in the
  same sandbox.
- Host contract comparison, 2026.8.2 against 2026.9.1: the accepted plugin API
  range is unchanged at `>=2026.5.17`, all 42 hook names are identical, every
  registrar used here is present, the export map only gains
  `./plugin-sdk/blob-runtime` and `./plugin-sdk/node-cli-runtime`, the plugin
  config key remains the manifest id, and the Control UI design tokens are
  value-identical, so the operator dashboard styling still matches its host.

No live re-embedding switch and no Telegram ingress run were repeated on
2026.9.1. Later OpenClaw commits are not silently incorporated.

The runtime matrix proves that every feature is enabled and coexists without
warnings; it asserts the behaviour of the paths listed above, not of every
feature individually. Emotion tiers, knowledge promotion, afterthoughts,
persona voice, dream echo and the other additive layers are covered by the
source test suite, not by a runtime stage.
