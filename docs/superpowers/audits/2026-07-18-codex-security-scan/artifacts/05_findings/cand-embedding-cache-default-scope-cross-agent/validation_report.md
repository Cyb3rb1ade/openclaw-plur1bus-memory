# Validation — Agent-scoped embedding cache silently collapses missing identities into a shared default scope

Candidate: `cand-embedding-cache-default-scope-cross-agent`  
Scope: repository snapshot `6dff096e`  
Date: 2026-07-18

## Validation rubric

- [x] Discovery source, closest control, and sink are preserved below.
- [x] The repository code path was traced against the completed receipt.
- [ ] A bounded dynamic reproduction was not completed for this candidate.
- [x] The remaining proof gap and conservative disposition are stated.

## Method

Static source-to-sink trace using the independently reviewed discovery receipt. This bounded audit did not run a target-host exploit simulation for this candidate.

## Evidence

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-006.json`
- Attacker-controlled source: Recall queries, reminder text, and other agent-associated text reach the embedding providers; several production call sites omit the agentId option.
- Closest/broken control: In agent scope, _resolveScopeId returns options.agentId || 'default' instead of requiring a validated agent identity, and providers pass an omitted identity through to the cache.
- Sink: All such entries share the same in-memory key scope and persistent default.db; when embeddingCachePersistDebug is enabled, normalized plaintext is stored in that shared database.
- Claimed impact: The configured per-agent cache isolation guarantee is lost. This can mix cache accounting/state between agents and co-locate plaintext from different agents at rest; a direct confidentiality impact depends on whether another principal can inspect/export the default cache database.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).
