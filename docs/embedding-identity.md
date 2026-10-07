# Embedding identities and multi-identity recall (PR-10)

Engine contract **1.14.0** adds vector-space routes and complete identities without
changing the plugin release version. The single-identity recall and prefix corpus
are the compatibility gate. This implements the owner's ADR-006 decision to ship
multi-identity recall in v0.1.

## Identity model

`lib/providers/embedding-identity.js` canonicalizes `provider`, `model`, `revision`,
`dimension`, `normalization`, `prefixScheme`, `instruction`, `dtype`, `tokenCap`,
`pooling`, and sorted `{path, sha256}` artifact identities. Its SHA-256 is over a
fixed-order UTF-8 JSON record. Credentials and transport are excluded. Empty
instructions and prefixes remain meaningful; the exact local prefix bytes are
recorded in `prefixScheme`, including whitespace. No field is inferred from a
vector's width alone. Artifact records are immutable and duplicate paths are refused.

Provider caches include this hash for ordinary single-identity installations too.
The canonical KNOWLEDGE.md cache also binds its vectors to the identity. A changed
revision, prefix, normalization, token cap, pooling or dtype invalidates cached
vectors even when the width stays the same.

`engine.embedding.identities()` retains the existing `fingerprintId`, `provider`,
`model`, `dimensions` envelope and adds `space`, the complete identity. For a routed
identity its `fingerprintId` is the complete identity hash. `embedding.embed()`
selects the requested identity and refuses an unavailable provider.

## Routes and stores

`embedding.routes` is an ordered array. Each entry supplies `identity` and optional
`agentId`, `namespace`, `scope` (`workspace` or `user`) and `provider` configuration.
Selectors are conjunctive; the first match wins. Config projections redact the
route array because provider profiles can contain credentials; the identity
service exposes the non-secret identity records. A route without selectors is a
catch-all. An unmatched store uses the default embedding identity. `provider` uses
the existing provider configuration and must describe exactly the declared identity.
Omitting it makes that identity unavailable; it never selects a different model.
Hosts and tests may inject the corresponding providers through the construction seam.

Each AgentDbPool resolves the identity for the actual agent and route. MemoryDB uses
that identity's dimension, including its zero-vector schema seed. Newly created
stores record the entire immutable identity in a separate `_embedding_identity`
LanceDB table. Reads validate this record before the memories schema is migrated.
Same-width foreign identities are refused with `EMBEDDING_IDENTITY_MISMATCH`.

Existing stores with no identity record are explicitly `legacy` and produce an
`embedding.identity.legacy` warning. Their existing vectors are preserved and their
width must match the configured identity. Width compatibility is not proof of
identity: an operator must establish the old provider/revision/prefix before
migration. Legacy metadata is not silently rewritten as a verified identity.
Existing re-embedding fingerprints remain in migration records; complete source and
target identities and hashes are additive. New quarantined generations record them
in `generation.json` and in every target store. Resume checks the target identity.
Old generation selections using the pre-PR-10 fingerprint remain loadable with
a legacy warning, and their old service envelope is accepted as an alias for the
configured identity. Known foreign store metadata still fails closed. Old
generations remain available for rollback.

## Recall, fusion and degradation

Recall embeds the query once for every identity present in the leased stores. The
multi-identity calls run concurrently with a shared AbortSignal and at most a 400 ms
embedding budget, reduced by time already spent in the recall. Even an embedder that
ignores cancellation cannot hold up the other identities. Single-identity calls
retain the existing scheduler's timeout and error behavior and share their query
promise across stores.

Within one identity, the existing namespace ranking applies. Across identities,
reciprocal rank fusion uses `sum(1 / (k + rank))`, with one-based ranks and
`embedding.rrfK` defaulting to 60. Raw distances from different identities are never
compared. If configured, one reranker sees the merged candidate set exactly once;
its timeout uses the remaining 600 ms budget. Reranker failures retain RRF order
when fallback is enabled. Storage/ACL failures retain their existing fail-closed
behavior and are not disguised as an embedding outage.

A failed identity is omitted while the other identities continue. Recall reports
`degraded.identities[] = {identityId, code}`, emits the existing typed
`recall.degraded` event and adds a visible `<memory-degraded>` hint to the memories
ContextBlock. The warm-only path carries the same routing through memory-only
provider wrappers and does not persist embeddings or emit recall events.

## Share

Share holds the source lease, validates the source ACL and policy, acquires the
destination store and embeds its text through the destination identity's passage
provider. It validates the destination width and revalidates the source before
writing. A missing target provider returns `EMBEDDER_UNAVAILABLE`; a foreign vector
returns `EMBEDDING_IDENTITY_MISMATCH`. No stored source vector is copied. Existing
share lineage (`sourceMemoryId`, `sourceAgentId`, idempotency and provenance fields)
is retained. Legacy pools preserve the previous single-provider sequencing.

## ADR-006 coverage inventory (Z1)

| ADR-006 requirement | Code after M1a/M1b | Change | Test |
| --- | --- | --- | --- |
| Full identity, not just dimension | `lib/reembedding/fingerprint.js`, `lib/providers/dimension-guard.js` | Complete canonical identity/hash, exact prefix scheme, typed mismatch | `multi-identity.test.js`, `reembedding-fingerprint.test.js` |
| Every cache key | `lib/embedding-cache.js`, `lib/recall-pipeline.js` KNOWLEDGE cache | Full identity hash isolates vectors | `multi-identity.test.js`, cache regression suites |
| Per-store dimension | `engine/create-engine.js`, `engine/store/agent-db-pool.js`, `engine/store/memory-db.js` | Ordered route identity resolver, store metadata and width | Two agents opened concurrently; real 2D/3D stores |
| One query per identity | `engine/recall/namespace-recall.js` (formerly index.js) | Shared query promise or concurrent per-identity embedding | Different widths checked at vectorSearch; duplicate identity embeds once |
| Never compare raw cross-model scores | `lib/recall-pipeline.js` namespace merge | Group by identity, RRF before global merge, one union reranker | Deliberately opposite raw score scales; union reranker called once |
| Destination re-embedding | `lib/telegram-commands/memory-edit.js`, `lib/shared-memory.js` | Provider selected from destination metadata; source revalidation | Real DB share, destination vector and source provenance; absent-provider refusal |
| Visible degradation and budget | `engine/recall/namespace-recall.js`, `assemble-prompt-context.js` | Remaining identities continue, structured degraded field and hint | Failed/hung fake embedder, elapsed 400/600 ms bounds |
| Identity per generation | `lib/reembedding/planner.js`, `coordinator.js`, `lance-backend.js` | Complete identities on plan and persisted target generation | Planner/coordinator/backend regression suites |
| Single-identity neutrality | Existing namespace merge and adapter joiner | Original ranking and prefix construction retained | Frozen `golden-prefix.test.js`, recall golden corpus, abort/warm-only gates |
| Host-neutral contract | `types/engine.d.ts`, engine config schema | Additive 1.14.0, optional `space` and degraded identity notes | Type conformance, schema projection and Engine contract suites |

## Harness follow-ups

After review and merge, the Harness must bump its exact engine commit pin, expose
route identities in its wizard and migrations UI, project the additive contract
fields through RPC, and include the complete identity hash in prompt-builder cache
keys. Its migration UI must distinguish a verified identity from a legacy width
match. Local-model RAM limits, endpoint compatibility probes and per-identity
threshold calibration remain separate ADR-006 workstreams. This PR does not publish
a release or change the Harness repository.
