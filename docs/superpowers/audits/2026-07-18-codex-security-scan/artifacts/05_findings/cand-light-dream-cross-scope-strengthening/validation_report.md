# Validation — Light dreaming strengthens semantically matched foreign-scope memories

Candidate: `cand-light-dream-cross-scope-strengthening`  
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

- Discovery receipt: `artifacts/02_discovery/file_reviews/review-005.json`
- Attacker-controlled source: Conversation-derived insights drive a raw vector search that can return workspace- or user-scoped rows belonging to another principal in the same agent table.
- Closest/broken control: findActivatedMemories passes no ACL context or workspace filter to db.search, and lightDream forwards every non-dream hit UUID to strengthenMemory without checking entry.scope/owner/workspace.
- Sink: strengthenMemory increments replayCount/lastReplayed in place; its compatibility fallback deletes and re-adds the complete foreign row.
- Claimed impact: One conversation can alter another user's memory dynamics and potentially its lifecycle/salience metadata, violating object-level integrity even though the foreign text is not directly returned.

## Result

The trace is a plausible security condition and remains preserved for remediation triage. It has **not** met the reportable-evidence bar in this audit because an end-to-end runtime or deployment-topology proof is absent.

**Disposition:** deferred — targeted validation required.  
**Confidence:** 0.30 (static trace only).

## Cross-Scope-/Cross-Principal-Addendum — 2026-07-18

This re-evaluation relies on existing `review-005.json` validation facts, not a new PoC. Its recorded workspace-A light-dream run returned a valid `scope:'user'`, `owner:'victim'`, workspace-B hit from `db.search` and changed the victim row's `replayCount` from 2 to 3. The same receipt identifies the missing ACL/workspace predicate before `strengthenMemory`, including the compatibility fallback that can delete and re-add the complete selected row.

**Preconditions:** one agent serves more than one protected workspace/user scope, light dreaming is enabled, and a session-derived insight is semantically close enough to a foreign memory to rank among the bounded hits. Conversation-derived source data is an actual chat/session input, and the existing proof demonstrates a workspace-A run mutating a victim B object. **Counterevidence:** the top-five cap limits breadth, no foreign text is directly returned, and the receipt has not traced every downstream consequence of replay metadata. These facts reduce likelihood/severity; they do not authorize the proven object mutation.

**Disposition (supersedes the initial conservative result): reportable, recommended Low/P3.** This is a verified cross-principal integrity path affecting a durable memory record. Exact target steering through embeddings remains a likelihood qualifier rather than a countercontrol.
