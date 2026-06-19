# PLUR1BUS v5 → v6 Migration Guide

**Datum:** 2026-06-19
**Version:** 6.7.0 (PLUR1BUS Full Experience Defaults)

---

## Breaking Changes & Core Behaviors

### 1. Schema Migration (Automatic & Idempotent)
- **What:** LanceDB table schema is auto-migrated on first `init()`
- **New columns:** `status`, `versionNumber`, `previousVersion`, `supersededBy`, `updateSource`, `updateEvidence`, `reconsolidationConfidence`, `versionCreatedAt`, `updatedAt`
- **Action required:** None — migration is idempotent and non-destructive.

### 2. Command Input Handling (Semantic Compression)
- **What:** Hard command length limits removed (`/memory` >2000, `/vergiss` >1000, `/korrigier` >1000)
- **New behavior:** Long inputs (>6k characters) are semantically compressed. Above 100k characters, the agent will prompt the user to use a file or vault source instead.

### 3. Low-Risk Merge Auto-Apply
- **What:** Memory Compaction auto-applies merge candidates only when they are classified as low risk.
- **New behavior:** High-risk or meaning-changing merges remain proposals in `.adaptive-learning/merge-proposals.jsonl` or separate memories.
- **Config Key:** `merging.autoApply` is `true` by default with `merging.autoApplyRisk: "low-only"`.

### 4. Obsidian Bridge Apply Mode
- **What:** Managed writes to the markdown vault with safety checks.
- **New behavior:** Uses `mode: "apply"`. Backups, managed manifests (beforeHash/afterHash), and audit logs are kept. It blocks unbefugt writes to `.obsidian` (`allowDotObsidianWrite: false`).
- **Path Behavior:** If no workspace or vault path is configured, the bridge features remain enabled but inert (no directories are silently created without a canonical configured path).

### 5. Full Experience Feature Policy & Defaults
- **What:** Fresh installs get the complete PLUR1BUS core features default-on. Updates preserve your current choices.
- **New behavior:**
  - Fresh installs enable all core features.
  - Updates preserve existing configured settings.
  - Missing new core features are enabled as default-on (opt-out).
  - No feature-selection history is written (no `fullExperiencePromptedAt`, `explicitOptOuts`, or `featuresConfirmedAt`).
  - Non-interactive updates do not block; they preserve config, enable missing defaults, and write the Start Notice.

### 6. Installations-Abschluss via `/plur1bus start`
- **What:** Shows installation completion summary.
- **New behavior:** Shows Full Experience status, active/disabled features, safety gates, and Obsidian/Review/Dashboard paths. It consumes the pending Start Notice without writing memories or history.

---

## Shipped Configuration Keys (under `plugins.entries["memory-lancedb-namespaced"].config`)

The following features and configurations are available in v6.7.0:

* `temporalContext.enabled` (default: `true`)
* `runtime.embeddingCacheEnabled` (default: `true`)
* `reranker.enabled` (default: `true`)
* `merging.autoApply` (default: `true`)
* `merging.autoApplyRisk` (default: `"low-only"`)
* `obsidianBridge.soulPatch.enabled` (default: `true`)
* `obsidianBridge.soulPatch.createIfMissing` (default: `true`)
* `obsidianBridge.soulPatch.backup` (default: `true`)
* `obsidianBridge.soulPatch.force` (default: `false`)
* `obsidianBridge.soulPatch.migrateLegacy` (default: `false`)
* `emotion.t2.enabled` (default: `true`)
* `emotion.t3.enabled` (default: `true`, provider-gated/fail-soft)
* `metaCognition.enabled` (default: `true`)
* `metaCognition.llmReport` (default: `true`, budgeted/fail-soft)

---

## Recommended Migration Steps

1. **Backup** your `openclaw.json` configuration file.
2. **Update** the plugin package (dependencies are automatically verified).
3. **Restart** the gateway. LanceDB schema migration will run automatically.
4. **Complete** the installation by running `/plur1bus start` in the chat.
5. **Review** `how-to-memory.md` for daily commands and usage details.

---

## Rollback

If you need to roll back to a pre-v6 version:
1. Revert the plugin directory to the desired commit/version.
2. The LanceDB schema is backward-compatible — v5 code can safely read v6 tables (the new columns are ignored).
3. You can safely remove the v6-specific configuration keys from your `openclaw.json` file.
