# PLUR1BUS v5 → v6 Migration Guide

**Datum:** 2026-06-02
**Version:** 6.0.0

---

## Breaking Changes

### 1. Schema Migration (Automatic)
- **What:** LanceDB table schema is auto-migrated on first `init()`
- **New columns:** `status`, `versionNumber`, `previousVersion`, `supersededBy`, `updateSource`, `updateEvidence`, `reconsolidationConfidence`, `versionCreatedAt`, `updatedAt`
- **Action required:** None — migration is idempotent and non-destructive
- **Verify:** Check logs for `memory-lancedb-namespaced: schema migrated v5.2.11 → v6`

### 2. Command Input Handling (Semantic)
- **What:** Hard command length limits removed (`/memory` >2000, `/vergiss` >1000, `/korrigier` >1000)
- **New behavior:** Long inputs are semantically compressed via `lib/semantic-input.js`
- **Hard limit:** 100,000 chars — above this, user is asked to use a file/vault source
- **Action required:** None — existing commands work unchanged, but now accept longer inputs

### 3. Merging (`autoApply: false`)
- **What:** Memory Compaction no longer auto-applies merge candidates
- **New behavior:** Proposals are written to `.adaptive-learning/merge-proposals.jsonl`
- **Action required:** Review proposals and set `compaction.autoApply: true` if you want the old behavior

### 4. Obsidian Bridge Apply Mode
- **What:** New `mode: "apply"` option with safety gates
- **New behavior:** Requires `requireVaultPathConfirmation: true`, creates per-batch backups + manifest + audit-log
- **Action required:** If using Obsidian Bridge, confirm vault path explicitly or set `mode: "augment"` for read-only

### 5. Feature Profile Confirmation Gate
- **What:** v6 features require explicit confirmation via `featuresConfirmedAt`
- **New behavior:** On first start, plugin warns about unconfirmed features
- **Action required:** Run `/plur1bus setup` and confirm the Recommended Profile, or manually set `featuresConfirmedAt` in config

### 6. Config Schema Updates
- **New keys in `openclaw.plugin.json`:**
  - `reranker.timeoutMs` (default: 5000)
  - `reranker.fallbackOnError` (default: true)
  - `merging.autoApply` (default: false)
  - `merging.mode` (default: "safe-versioned")
  - `schicht15.maxPromotionsPerRun` (default: 0 = unlimited)
  - `obsidianBridge.backupBeforeApply` (default: true)
  - `obsidianBridge.auditLog` (default: true)
  - `obsidianBridge.requireVaultPathConfirmation` (default: true)
  - `morningReview.status` / `eveningReview.status` (default: "pending_setup")
  - `criticalPush.model` (no default — falls back to `merging.model`; without any chat model the classifier no-ops instead of mislabeling cards as `fakt`)
  - `criticalPush.maxPerDay` (default: 3 — now read from config instead of hard-coded)
  - `security.allowChatConfigCommands` (default: true — set `false` on shared channels to refuse chat-driven `openclaw.json` mutation)

> **Schema note:** the v6 config keys `criticalPush`, `dailyConsolidation`, `security`, `setupProfile`, `featuresConfirmedAt`, `morningReview` and `eveningReview` are now declared at the config root in `openclaw.plugin.json`. Earlier 6.0.0 shipped with `additionalProperties: false` at the config root but without these keys, so strict schema validators could reject a valid v6 config (including the `featuresConfirmedAt` gate written by `/plur1bus setup`).

---

## Recommended Migration Steps

1. **Backup** your `openclaw.json` and `.adaptive-learning/` directory
2. **Update** `openclaw.plugin.json` schema (or let the plugin merge defaults automatically)
3. **Start** the plugin — schema migration runs automatically
4. **Confirm** features via `/plur1bus setup` or manually set `featuresConfirmedAt`
5. **Review** `how-to-memory.md` for any changed command behavior
6. **Check** logs for pending_setup warnings and resolve them

---

## Rollback

If issues occur:
1. Set plugin config `setupProfile: "safe"` to disable all v6 features
2. Restore `openclaw.json` from backup
3. The LanceDB schema is forward-compatible — v5 code can read v6 tables (new columns are ignored)
