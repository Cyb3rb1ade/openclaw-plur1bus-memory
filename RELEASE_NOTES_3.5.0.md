# PLUR1BUS 3.5.0 — Obsidian Bridge

## Summary

PLUR1BUS 3.5.0 adds an optional Obsidian Bridge as a Markdown-first review and
control-room layer. PLUR1BUS remains authoritative: `memory-core` stays the
OpenClaw memory slot owner, PLUR1BUS remains an augment plugin, and Obsidian is
never required for startup or runtime memory tools.

## Obsidian Bridge

- Writes safe artifacts under `00-system/plur1bus/`: ReviewBundles, Vault
  Doctor reports, conflicts, Project Hubs, memory explanations, stale/hygiene
  reports, and task suggestions.
- Keeps `memory/KNOWLEDGE.md` curated truth; it is never silently overwritten
  from Obsidian.
- Uses managed Markdown blocks with checksum markers and atomic writes.
- Rejects path traversal and `.obsidian` writes unless explicitly configured.

## Capability-Equal Agents

All configured agents receive the same Obsidian Bridge capability pack.
`standard`, `conservative`, `adversarial`, `maintenance`, and
`project_manager` are review perspectives, not permissions.

## Morning Review via OpenClaw Cron

The Morning Review pipeline prepares proposals only:

1. snapshot / lock
2. maintenance_light
3. collect_changes
4. generate_review_proposals
5. adversarial_light
6. risk_classification
7. deduplication
8. write ReviewBundle
9. notify user
10. await explicit approval

Recommended schedule:

```bash
openclaw cron add \
  --name "PLUR1BUS Morning Review" \
  --cron "0 9 * * *" \
  --tz "Europe/Zurich" \
  --session isolated \
  --message "Run /plur1bus obsidian morning-review. Prepare proposals only. Run maintenance_light before proposal generation and adversarial_light before user presentation. Do not apply changes without explicit user approval. Write the ReviewBundle to Obsidian and return a concise approval summary." \
  --announce
```

## Approval-Gated Apply

`prepare` is not `apply`. A checked box in Obsidian is not enough to mutate
memory. Apply re-reads ReviewBundle state, verifies approved item status,
revalidates source/target hashes, checks scope/trust invariants, and applies
approved safe items only.

## Safety Invariants

- No manifest `kind:"memory"`.
- No `registerMemoryCapability`.
- No OpenClaw dist patching.
- No `ExecStartPre`, host cron, or root cron as the primary path.
- Existing provider IDs, dimensions, and LanceDB paths are unchanged.
- Obsidian text is untrusted input.
- Assistant-only assertions are not promoted to trusted/global memory.
- `agent_private` does not leak to `workspace_shared` without explicit approval.
- `workspace_shared` does not leak to `global_user` without explicit policy.

## Upgrade Notes

Set `obsidianBridge.enabled=true` only after configuring `vaultPath` and
reviewing `/plur1bus obsidian doctor`. Leave `allowDotObsidianWrite=false`
unless you explicitly want the bridge to manage `.obsidian` files.

## Verification Commands

```bash
node --check extensions/memory-lancedb-namespaced/index.js
node --check extensions/memory-lancedb-namespaced/lib/neo-arch.js
node --check extensions/memory-lancedb-namespaced/lib/obsidian-bridge.js
node --check extensions/memory-lancedb-namespaced/lib/obsidian-control-room.js
node --test extensions/memory-lancedb-namespaced/__tests__/*.test.js
node scripts/memory-doctor.mjs provider-check
openclaw plugins doctor
npm pack --dry-run
```
