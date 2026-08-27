# PLUR1BUS 7.5.0 Workspace Control Plane and Re-Embedding Design

Date: 2026-08-27

Status: approved in chat; written review pending

Target host: exactly OpenClaw `2026.8.1-beta.3`

Target plugin: PLUR1BUS `7.5.0` on the local compatibility branch

## Purpose

PLUR1BUS must be controllable per OpenClaw workspace without treating the
assignable session owner as a security boundary. Operators also need a safe
configuration surface for feature flags and credentials, plus a complete,
resumable re-embedding workflow whenever the active embedding space changes.

The design keeps OpenClaw unmodified. It uses only the public plugin, Gateway,
session-action, configuration, SecretRef, lifecycle, hook, tool, and CLI
contracts published by OpenClaw `2026.8.1-beta.3`.

## Non-goals

- Do not patch OpenClaw source, `dist`, `node_modules`, or Control UI assets.
- Do not create a second PLUR1BUS login, token store, or authorization system.
- Do not use session owner, display name, participant history, or a caller-
  supplied filesystem path as a workspace identity or authorization proof.
- Do not rewrite or delete an existing LanceDB namespace during re-embedding.
- Do not switch provider, model, revision, dimensions, prefixes, or namespace
  merely because a configuration form was edited.
- Do not infer compatibility from a successful build or cold manifest check.

## OpenClaw Beta-3 Findings

OpenClaw session ownership is an assignable responsibility/display feature.
Its own multi-user documentation explicitly says that ownership is not an
access or isolation boundary. PLUR1BUS policy therefore remains stable when a
session is reassigned to a human or agent.

Beta 3 supports external plugin sidebar tabs through
`api.session.controls.registerControlUiDescriptor`. The tab is served by a
plugin-owned, Gateway-authenticated HTTP route in a sandboxed frame. The host
deliberately gives that frame a route-bound, read-only operator grant. A
plugin must not convert that read grant into configuration or data mutations.

Beta 3 also supports typed session actions and plugin Gateway methods with
operator scopes. Those are the write boundary for clients that can invoke
them. The built-in Config and Secrets pages already own authenticated config
writes and protected secret storage. PLUR1BUS will reuse them instead of
building an independent admin surface.

## Architecture

The control plane has four independent components:

1. `WorkspacePolicyStore` owns durable per-workspace enablement decisions.
2. `WorkspacePolicyGuard` applies one policy decision consistently to tools,
   hooks, commands, services, Skill Miner, Cron, and Obsidian integration.
3. `ControlPlaneProjection` provides redacted status through read APIs and the
   official read-only PLUR1BUS Control UI tab.
4. `ReembeddingCoordinator` plans, executes, verifies, commits, resumes, and
   rolls back copy-on-write embedding migrations.

Each component exposes a small interface and has no authority beyond its own
role. In particular, rendering status cannot mutate policy, secrets, config,
or LanceDB data.

## Workspace Identity and Default Policy

The policy key is the tuple:

```text
(safeAgentId(agentId), canonical workspaceIdentity)
```

`workspaceIdentity` is resolved by the existing conflict-checking PLUR1BUS
memory request context from trusted OpenClaw hook, tool, command, or stored
session facts. Aliases are normalized by `normalizeWorkspaceTarget`; paths are
canonicalized through the existing host/runtime resolver. Conflicting facts
fail closed.

The default is `enabled`. Absence of an override therefore preserves all
existing installation behavior. A record stores only an explicit disabled or
enabled override, its revision, timestamp, and a non-secret audit actor
identifier. Session owner changes never modify or select a policy record.

Policy state lives under the PLUR1BUS state root, outside any user-writable
workspace, using `resolveInside`, an atomic JSON replacement, mode `0600`, a
schema version, and optimistic revision checks. It never lives in
`AGENTS.md`, workspace config, a vault, or LanceDB memory rows.

## Meaning of Disabled

For a disabled workspace, PLUR1BUS performs no memory read, memory write,
embedding request, reranking request, automatic prompt injection, automatic
capture, Skill Miner scan, workspace Feature Cron work, workspace Obsidian
work, or workspace-specific background maintenance.

Explicit tools and commands return a structured `workspace_disabled` result.
Automatic hooks return an unchanged/no-op result so that PLUR1BUS failure or
disablement never blocks normal OpenClaw messaging. Direct feature Cron jobs
finish successfully with a typed `NO_REPLY` skip result and do not start an
outer model run.

Status, policy enable, and policy disable remain available. Disabling does not
delete memories, proposals, skills, vectors, audit history, or namespaces.
Re-enabling restores access to the unchanged data.

The guard runs at the last trustworthy common boundary before each operation,
not only in UI or command parsing. Background and internal callers cannot
bypass it. A policy change invalidates affected in-memory recall/injection
state and pending route tickets before the mutation is acknowledged.

## Policy API and Commands

The plugin registers these versioned capabilities exactly once:

- `plur1bus.workspacePolicy.get` with `operator.read`
- `plur1bus.workspacePolicy.list` with `operator.read`
- `plur1bus.workspacePolicy.set` with `operator.write`
- typed session action `workspace-policy.set` with `operator.write`
- `openclaw plur1bus workspace status|enable|disable`
- authorized `/plur1bus workspace status|enable|disable`

Session-scoped mutations accept a session key and resolve the agent/workspace
through host-owned session state. They do not accept a raw workspace path.
Administrative configured-workspace operations accept an agent id plus a
declared canonical workspace alias and reject unknown or conflicting aliases.

Mutations use an expected policy revision. Stale concurrent writes fail with
a conflict and the current redacted state. Destructive chat authorization
continues to use PLUR1BUS `isAuthorized()` and its existing private-chat or
whitelist rules in addition to host operator scopes.

## Configuration Surface

PLUR1BUS adds complete manifest `uiHints` for supported feature flags,
providers, models, dimensions, revisions, fallback behavior, and advanced
options. Common safe toggles appear first; dangerous or low-level values remain
advanced. The schema remains `additionalProperties: false`.

The built-in OpenClaw Config page is the authoritative write UI. It already
performs authenticated, schema-validated configuration writes. PLUR1BUS does
not duplicate that path inside its iframe.

The PLUR1BUS sidebar tab is an official external plugin tab and is read-only
on Beta 3. It displays:

- configured and effective feature states, including dependency warnings;
- current workspace policy and canonical workspace identity;
- active embedding and reranker fingerprints;
- credential presence/reference status without values;
- LanceDB namespace, schema dimension, and row counts;
- migration plan, progress, validation, failure, and rollback state;
- links to OpenClaw's Config and Secrets pages;
- exact CLI/RPC guidance for write actions unavailable in the Beta-3 frame.

The plugin also registers typed write actions so a future OpenClaw client can
render controls after feature detection. No version-string check enables a
write UI. A write control appears only when the host exposes a public bridge
that preserves the action's declared operator scope.

## Feature Configuration Rules

The existing closed feature whitelist remains the only set writable through
PLUR1BUS feature-toggle commands. The configuration projection distinguishes:

- `configured`: the stored boolean or provider choice;
- `effective`: the value after dependencies and workspace policy;
- `reason`: a stable non-secret reason when configured and effective differ.

Dependencies fail closed. Examples include Skill Miner without Skill Workshop,
automatic capture without conversation access, and workspace jobs in a
disabled workspace. The UI and API report these conditions; they do not
silently enable dependencies.

Configuration changes use OpenClaw's config mutation/reload lifecycle. The
model-provider shutdown contract must dispose the previous generation before
the replacement is initialized, preventing duplicate ONNX pipelines during an
in-process reload.

## Secret Handling

Every PLUR1BUS credential field becomes a sensitive SecretInput accepting
OpenClaw `env`, `store`, `file`, and `exec` SecretRefs plus backward-compatible
plaintext strings. The manifest declares the fields through
`configContracts.secretInputs`, and all UI hints mark them sensitive.

Runtime resolution uses the public OpenClaw secret-input SDK. PLUR1BUS never
lists, reveals, echoes, logs, hashes into a report, or persists a resolved
secret. Status reports only `missing`, `configured`, or the non-secret source
kind. Error messages name the configuration path, never the supplied value.

Operators create or rotate protected values in OpenClaw's Secrets page. A
rotation of a SecretRef backing the same embedding fingerprint requires only a
provider probe/reload, not re-embedding. A migration record stores the SecretRef
descriptor needed to reconstruct the target config, never resolved material.

Existing plaintext configuration remains readable for upgrade compatibility,
but the UI recommends conversion to a SecretRef. No automatic migration copies
plaintext into another file or store.

## Embedding Fingerprint

Every writable namespace is bound to an immutable embedding fingerprint that
includes all values capable of changing the vector space:

- provider adapter id;
- model id;
- immutable model revision when applicable;
- vector dimensions;
- endpoint identity without credentials;
- query and passage prefixes or pooling/normalization options;
- local artifact identities for pinned models;
- fingerprint schema version.

A provider/model/revision/prefix change requires re-embedding even when the
dimension is unchanged. A credential-only rotation with an otherwise identical
fingerprint does not. A dimension mismatch or fingerprint mismatch prevents
new writes and vector recall against the affected namespace and provides a
clear migration diagnostic.

## Re-Embedding State Machine

One durable coordinator serializes migrations per PLUR1BUS state root. States
are:

```text
planned -> confirmed -> running -> validating -> ready_to_switch
        -> switching -> completed

running|validating|switching -> failed
completed -> rollback_planned -> rolling_back -> rolled_back
```

Every state transition is atomically persisted and audit logged. Unknown,
skipped, or backward transitions fail closed.

### Plan

Planning is data-plane and host-config read-only. It may persist only its
redacted plan receipt and audit entry under the PLUR1BUS control-state root.
It resolves the active embedding fingerprint, validates the requested target,
enumerates every active physical private/shared
namespace and agent partition, reads table schema and row counts, estimates
target bytes and provider calls, checks available disk headroom, and performs
one real target embedding probe when that can be done without writing local
state. A remote provider is probed directly. A local provider is probed only
when every pinned artifact is already present and verified; otherwise the plan
records `probe_deferred_local_artifact` and the apply preflight must download,
verify, load, and probe the model before any target table is created.

The plan identifies the exact source table versions and produces a hash-bound,
expiring confirmation token. It does not create a table, download a model,
write config, or switch a namespace.

### Apply

Apply requires `operator.admin`, the exact confirmation token, and unchanged
source versions/config hash. It creates a uniquely named target generation
under the PLUR1BUS base path. All paths use `safeAgentId` and `resolveInside`.

Rows are copied, not moved. Every schema field, id, ownership binding,
provenance field, status, tombstone-related field, validity field, and audit
field is preserved; only the vector and embedding fingerprint change. The
operation includes inactive rows required for history/restore semantics.

Processing is bounded by configurable batch size, concurrency, provider-call
budget, byte budget, and deadline. A cursor advances only after a target row
has been written and read-back verified. Retries are idempotent. Partial target
generations remain quarantined and are never selected for recall or writes.

Model artifacts are downloaded through the existing atomic, revision- and
hash-verified local artifact path. Remote-provider failures preserve the cursor
and return a redacted diagnosis.

### Validate

Validation requires:

- exact source/target row counts for every table;
- stable content hash equality excluding vector/fingerprint fields;
- preserved ids, ownership, status, provenance, and validity metadata;
- finite target vectors with the exact target dimension;
- no duplicate ids in the target generation;
- deterministic sample embedding checks;
- real recall probes with semantically plausible ordering;
- no writes to source namespaces.

Any failure leaves the old configuration active and the target quarantined.

### Switch

Switch is a separate confirmed `operator.admin` action. It rechecks the plan,
source versions, validation receipt, config revision, and target availability.
It first enters a bounded maintenance gate in which new PLUR1BUS reads and
writes return a retryable `migration_switching` result while ordinary OpenClaw
messaging remains available. It then applies one host-mediated config patch
selecting the new embedding fingerprint and target namespace generation. The
old namespace is recorded as the immutable rollback baseline and remains
untouched.

The plugin reloads through OpenClaw's lifecycle, disposes old providers, opens
the new namespace, and performs Gateway readiness plus real store/recall probes
before acknowledging completion. The synthetic probe row has a reserved audit
origin and is removed from the target after read-back verification; both writes
are audited and cannot select a pre-existing id. Failure after the config patch
triggers the bounded rollback transition while the maintenance gate still
prevents user-memory divergence; it is never reported as completed.

### Rollback

Automatic rollback during `switching` may restore the prior config fingerprint
and immutable baseline directly because the maintenance gate has admitted no
user-memory writes since validation.

A manual rollback after `completed` is a confirmed `operator.admin` action
bound to a new reverse-migration plan. It must not merely repoint the stale
baseline: the current target generation may contain memories or updates written
after the switch. The coordinator therefore treats the current generation as
the authoritative source and runs the same copy-on-write plan/apply/validate
workflow into a new generation using the prior embedding fingerprint. Only
that fully validated generation can become active. It then reloads the plugin
and verifies readiness/store/recall. Neither the original baseline nor the
superseded forward generation is deleted. Cleanup is always a separate, later
operator decision and is outside this feature.

## Concurrency and Lifecycle

Only one migration may run for a state root. A process restart reads the
durable state and resumes from the last verified cursor; it never assumes an
in-flight row completed. Gateway shutdown aborts new work, waits for the active
batch within the registered timeout, closes tables/providers, and persists a
resumable state.

Workspace disable during migration prevents new workspace memory activity but
does not silently alter the migration scope. The coordinator pauses before the
next batch and requires an explicit resume so the operator can inspect the new
policy state.

Feature toggles, provider reloads, and migrations share a control-plane mutex
and optimistic config revision. Competing mutations return a conflict instead
of overwriting each other.

## Security and Audit Invariants

- Read surfaces never invoke write helpers.
- Workspace policy writes require host scope and PLUR1BUS command auth where
  applicable.
- Migration apply, switch, resume after policy change, and rollback require
  `operator.admin` plus a hash-bound confirmation.
- All user-facing text, aliases, ids, and queries use existing input validators.
- All paths use `safeAgentId` and `resolveInside`.
- Secrets never appear in process arguments, reports, audit records, logs,
  generated HTML, migration state, or test snapshots.
- Every destructive or authority-changing operation uses
  `appendDestructiveOpLog`.
- Unknown schemas, multiple matching namespaces, changed source versions,
  insufficient disk, wrong dimensions, incomplete artifacts, or ambiguous
  workspace facts fail closed.
- No source namespace, rollback generation, or evidence is deleted
  automatically.

## Test Strategy

Implementation is test-first. Unit and contract tests cover:

- default enabled and explicit per-workspace disable/enable;
- agent/workspace key isolation and owner reassignment invariance;
- atomic persistence, optimistic revisions, malformed state, and path safety;
- gating of every tool, typed hook, command, Cron path, Skill Miner, service,
  and Obsidian path;
- no embeddings, DB access, model call, or prompt injection while disabled;
- cache/route invalidation and data survival across disable/re-enable;
- exact-once API/action/UI descriptor registration and reload cleanup;
- SecretRef schema, resolution, redaction, rotation, and error messages;
- embedding fingerprint equality and mismatch behavior;
- plan purity and confirmation-token binding;
- zero/one/many source detection, schema drift, changed versions, low disk,
  provider failure, cancellation, resume, and concurrent mutation;
- copy/readback idempotency and preservation of every non-vector field;
- validation failure, switch failure, automatic bounded rollback, manual
  rollback, and restart recovery;
- local E5/Jina/BGE artifacts and remote embeddings through real inference.

The exact packed `7.5.0` artifact is then installed with OpenClaw's
`npm-pack:` installer in fresh isolated Beta-3 containers. Runtime tests prove:

- five tools, seven typed hooks, CLI, Gateway methods, session actions, and UI
  descriptors register exactly once;
- the PLUR1BUS tab is present and read-only under its route grant;
- Config and Secrets surfaces accept the manifest contracts without exposing
  a secret;
- two workspaces and two agents remain isolated through disable, restart, and
  re-enable;
- explicit and automatic capture/recall obey policy independently;
- Skill Miner and Feature Cron obey policy and use native Beta-3 dispatch;
- a real model/fingerprint migration completes, survives restart, recalls old
  memories in the new vector space, and rolls back to the preserved source;
- Jina, E5, BGE, and configured primary-to-fallback inference are real;
- provider reloads do not retain a second ONNX pipeline;
- fresh logs contain no load, patch, SQLite, LanceDB, hook, or secret errors;
- the production host Gateway and pre-existing Docker resources remain
  unchanged.

## Acceptance Criteria

The feature is complete only when:

- unknown workspaces default to enabled;
- a workspace can be disabled and re-enabled without data loss or Gateway
  restart;
- another workspace and agent remain unaffected;
- session ownership changes do not alter policy;
- all configured feature and credential fields are safely editable through
  official OpenClaw surfaces;
- no credential is revealed by PLUR1BUS;
- model-space changes cannot write into an incompatible namespace;
- a real copy-on-write re-embedding, validation, switch, restart, recall, and
  rollback pass against exact OpenClaw `2026.8.1-beta.3`;
- the packed artifact, not a source link, passes the full compatibility matrix;
- three unchanged serial full runs pass and the host invariants remain stable.
