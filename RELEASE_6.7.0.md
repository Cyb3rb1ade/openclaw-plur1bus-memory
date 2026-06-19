# PLUR1BUS Memory 6.7.0 — PLUR1BUS Full Experience Defaults

**Release Date:** 2026-06-19  
**Theme:** Full Experience Defaults & Temporal Continuity

PLUR1BUS v6.7.0 simplifies the onboarding and setup experience by introducing a "Full Experience by Default" policy, ensuring fresh installations get the complete suite of PLUR1BUS cognitive features active immediately. It also adds Zeitempfinden (Temporal Continuity Context) to give agents an organic awareness of elapsed time between conversation turns.

---

## 🚀 Key Features in v6.7.0

### 1. PLUR1BUS Full Experience Policy
* **Fresh Installs:** Auto-enables 28 core cognitive features out of the box (including embedding cache, reranking, meta-cognition, Obsidian bridge, reviews, and SoulPatch).
* **Existing Updates:** Respects existing config settings as the source of truth. Missing new core features are merged as enabled by default (opt-out).
* **Zero History Overhead:** Does not write feature-selection logs (such as `fullExperiencePromptedAt`, `explicitOptOuts`, or `featuresConfirmedAt`) to keep configuration files clean.
* **Non-Interactive Updates:** Non-interactive or auto-accept updates preserve settings, enable missing defaults, and write a start notice without hanging/blocking setup.

### 2. Temporal Continuity Context
* Injects a local `<temporal-context>` block at the start of each turn.
* Inclusions: Current time, previous turn timestamp, elapsed time, gap bucket classification (immediate, recent, same_day, overnight, multi_day, stale), and a continuity hint.
* **Safety First:** Not stored as memory, not embedded, not knowledge-promoted. The `<temporal-context>` tag and contents are strictly filtered from memory capture.

### 3. Start Wizard: `/plur1bus start`
* The designated command to complete installation.
* Renders a comprehensive dashboard displaying:
  * Full Experience activation status
  * Active/disabled/missing features
  * Active safety gates
  * Path resolutions for Obsidian, Reviews, and Dashboard
* Consumes any pending Start Notice.
* Does not write history, create embeddings, or promote memories.

### 4. Shipped Start Notice
When updates run non-interactively, a pending notice is queued:
```text
+++ PLUR1BUS — Make your agent yours! +++

Please complete the installation by running:

/plur1bus start
```
* Notice is operational, consumed after display, and fully filtered from memory capture and embedding pipelines.

---

## 🛡️ Config Defaults & Safety Gates

### Shipped Feature Defaults (Fresh Installs)
* `temporalContext`: ON
* `runtime.embeddingCacheEnabled`: ON
* `reranker`: ON
* `emotion.t2`: ON
* `emotion.t3`: ON (provider-gated/fail-soft)
* `metaCognition`: ON
* `metaCognition.llmReport`: ON (budgeted/fail-soft)
* `merging.enabled`: ON
* `merging.autoApply`: ON (for low-risk only)
* `schicht15`: ON
* `skillMiner`: ON
* `dailyConsolidation`: ON
* `obsidianBridge`: ON
* `morningReview`: ON
* `eveningReview`: ON
* `dashboardLayer`: ON
* `soulPatch.enabled`: ON
* `soulPatch.createIfMissing`: ON
* `soulPatch.backup`: ON

### Safety Gates (Guarded Behavior)
* `soulPatch.force`: OFF (prevents overriding without consent)
* `soulPatch.migrateLegacy`: OFF (prompt + backup required for legacy migrations)
* `merging.autoApplyRisk`: `"low-only"` (high-risk or meaning-changing merges are kept as proposals)
* `obsidianBridge.semanticGraph.mutateMemory`: `false` (blocks metadata scripts from altering memory text)
* `obsidianBridge.allowDotObsidianWrite`: `false` (protects Obsidian internal configuration)
* **Path Safety:** If no vault path or workspace root is configured, the bridge features remain active but inert; no directories are silently invented or created.
* **Provider Safety:** All external API-backed tasks fail soft (degrade gracefully) when API keys/configurations are absent or budgets are exceeded.

---

## 🛠️ Package and Deploy Integrity
* Root entrypoint: `./index.js`
* Extension path: `openclaw.extensions: ["./index.js"]`
* The npm package distribution strictly includes `lib/`, `scripts/`, `docs/`, `index.js`, `openclaw.plugin.json`, `README.md`, and `LICENSE`.
* A deployment-integrity guard runs tests against the deployed file listing to prevent loading stale indexes or missing critical modules.

---

**PLUR1BUS Memory** — *Make your agent yours.*
