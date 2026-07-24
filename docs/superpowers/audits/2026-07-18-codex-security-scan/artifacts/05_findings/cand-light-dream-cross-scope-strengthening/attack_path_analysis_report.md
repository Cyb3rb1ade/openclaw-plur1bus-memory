# Attack-path analysis — Light dreaming strengthens semantically matched foreign-scope memories

Candidate: `cand-light-dream-cross-scope-strengthening`

## Path

1. **Source / trust boundary:** Conversation-derived insights drive a raw vector search that can return workspace- or user-scoped rows belonging to another principal in the same agent table.
2. **Nearest or broken control:** findActivatedMemories passes no ACL context or workspace filter to db.search, and lightDream forwards every non-dream hit UUID to strengthenMemory without checking entry.scope/owner/workspace.
3. **Sink:** strengthenMemory increments replayCount/lastReplayed in place; its compatibility fallback deletes and re-adds the complete foreign row.
4. **Security outcome if exploitable:** One conversation can alter another user's memory dynamics and potentially its lifecycle/salience metadata, violating object-level integrity even though the foreign text is not directly returned.

## Calibration

The code evidence establishes the proposed path, but this repository-only pass has no reproducible exploit transcript or confirmed privileged deployment topology for it. The final policy decision is **deferred**, not reportable, until targeted validation can establish reachability and impact in the intended deployment.

## Cross-Scope-/Cross-Principal-Addendum — 2026-07-18

### Attack-path facts from existing receipts

- **In scope / vector:** the threat model describes per-agent authoritative memory and chat-driven features. `review-005.json` records session-derived insights reaching light dreaming; its existing workspace-A mock selected and strengthened a victim-owned workspace-B row.
- **Identity and boundary:** the source run is workspace A while the durable target is `scope:'user'`, `owner:'victim'`, workspace B in the shared agent table. No ACL context, workspace filter, or owner comparison runs between vector selection and `strengthenMemory`.
- **Verified sink:** replay count changed from 2 to 3; the implementation also updates `lastReplayed` and has a delete/re-add compatibility fallback. This is a cross-principal memory-integrity effect, not merely an attempted search.
- **Preconditions:** a same-agent multi-scope deployment, enabled light dreaming, and a semantically matching foreign hit. These are plausible feature conditions; the multi-scope prerequisite is not an authorization control because the product's own scope model represents such rows.
- **Counterevidence:** output is bounded and foreign text is not returned. Existing evidence does not show deterministic target steering or quantify all recall/decay consequences of replay metadata. Those facts lower likelihood and severity, but they do not defeat the established foreign-object mutation.

### Calibration and final policy decision

Assess durable cross-user memory-dynamics mutation as medium integrity impact and likelihood as unknown because semantic targeting and feature topology are conditional. The policy matrix yields **Low (P3)**. **Final decision: reportable.**
