# Changelog — PLUR1BUS Memory

Alle wichtigen Änderungen an diesem Projekt werden in dieser Datei dokumentiert.

Das Format basiert auf [Keep a Changelog](https://keepachangelog.com/de/1.1.0/),
und dieses Projekt folgt [Semantic Versioning](https://semver.org/lang/de/).

## [6.8.10] — 2026-06-28 — Datenverlust-, Korruptions- & Integritäts-Fixes (Review-Audit)

Ergebnis eines vollständigen Bug-/Security-Reviews (Semgrep + manuelle Layer +
parallele Modul-Reviews). Findings dokumentiert in
`docs/audits/2026-06-28-review-findings.md`.

### Fixed

- **Datenverlust-Klasse „destruktiv vor durabel" (3 Stellen)**: `db-adapter.updateCard`,
  `safe-update.safeUpdate` und `light-dream.strengthenMemory` markierten/löschten
  die alte Memory, BEVOR die neue Version durabel geschrieben war. Crash/Timeout
  dazwischen = stiller, unwiederbringlicher Verlust. Jetzt: erst neu schreiben,
  dann alt superseden (bzw. Rollback bei delete+add). Failure wird zur
  wiederherstellbaren Fork statt zum Verlust.
- **GC archivierte neverForget/core-Memories**: Die Active-Scan-Projektion
  (`buildActiveScanQuery.select` + `normalizeActiveScanRow`) strippte
  `neverForget`/`memoryClass`, und `selectCandidatesForGc` hatte keinen Guard.
  Geschützte (auch kritische) Memories konnten unter Größendruck archiviert
  werden. Flags werden jetzt durchgereicht und geschützte Memories vorab
  ausgeschlossen.
- **UTF-8-Korruption beim JSONL-Cap** (`neo-arch.readJsonlTailLines`): Backward-
  64KB-Chunks wurden einzeln dekodiert → Multibyte-Zeichen (ä/ö/ü/ß/Emoji) an
  Chunk-Grenzen wurden zu U+FFFD und von `capJsonl` zurückgeschrieben. Jetzt
  werden rohe Bytes gesammelt und einmal dekodiert.
- **Emotion-Intensität NaN→0 bei Alltagswörtern** (`tier1-lexicon`): Nuance-Labels
  (love/grateful/proud/relieved/…) ohne EMOTION_VAD-Eintrag erzeugten NaN, das
  still zu 0 geklemmt wurde (Signalverlust). Fallback EMOTION_VAD → NUANCE_VAD →
  neutral; `EmotionScore._validate` weist nicht-finite Werte ab.
- **False Tombstones im Obsidian Apply-Modus**: `scanWorkspace`-Fastpath ließ
  unveränderte Dateien aus `scan.files`, wodurch der Tombstone-Loop sie als
  gelöscht behandelte. `scanWorkspace` liefert jetzt die übersprungenen Pfade,
  `syncWorkspace` nimmt sie in `seen` auf.
- **Conversation-Reactivation-Recall ohne Status-Filter**: superseded/getombstonte
  Memories konnten via Semantic-Lens-Index reaktiviert werden. `normalizeMemoryEntry`
  filtert jetzt explizit-inaktive Status. (Die ursprünglich vermutete Cross-Agent-
  ACL-Lücke wurde herabgestuft: per-Agent-Namespacing + eigene Workspaces
  isolieren die CRR-Datenquellen bereits.)

## [6.8.9] — 2026-06-28 — Feature-Opt-out-Fix (Reranker-Invarianten)

### Fixed

- **Off-Switch für Emotion-Tier-2/-3 und Meta-Cognition wurde ignoriert** (`lib/setup/feature-profiles.js`): `enforceRerankerInvariants()` setzte `emotion.t2.enabled`, `emotion.t3.enabled` und `metaCognition.enabled` mit `overwrite: true` (Default), sobald der Reranker aktiv war (Recommended-Default). Dadurch wurde ein explizites `enabled: false` des Nutzers still überschrieben — diese LLM-treibenden Features ließen sich bei aktivem Reranker nicht abschalten. Inkonsistent zu den unmittelbar benachbarten Zeilen (`fallbackOnError`, `onlyWhenProviderAvailable`, `llmReport`, `llmReportMode`), die bereits `overwrite: false` nutzten. Fix: Die drei `enabled`-Zeilen verwenden jetzt ebenfalls `overwrite: false`. Default-on-Verhalten bleibt unverändert (greift über den `mergeMissing`-Pfad, wenn der Nutzer nichts angibt); ein expliziter Opt-out wird jetzt respektiert.

- **Kryptische Fehlermeldung bei kaputter OpenClaw-Config** (`lib/obsidian-bridge.js`): `writeDiscoveredObsidianWorkspaces()` warf bei ungültigem JSON einen rohen `SyntaxError` („Unexpected token …"), der dem Operator keinen Hinweis auf die betroffene Datei gab. Der `JSON.parse` ist jetzt gekapselt und wirft eine klare Meldung inklusive Config-Pfad.

### Tests

- Stabilisierung von `memory-store-merge-safety` und `memory-store-decision-trace`: Beide zählten globale LLM-Calls und schlugen seit v6.8.8 fehl, weil Emotion-Tier-3 (jetzt Default-an) pro `memory_store` einen zusätzlichen Klassifizierungs-Call auslöst. Tests isolieren das Verhalten jetzt explizit gegen das Emotion-Feature. Neue Regressionstests für die Reranker-Invarianten-Opt-outs und den Config-Parse-Fehlerpfad.

## [6.8.8] — 2026-06-28 — Emotion Tier 3 vollständig aktiviert

### Fixed

- **EmotionEngine._t3Enabled ignorierte callLlm** (`lib/emotion-engine.js`): Die Budget-Gate-Prüfung berücksichtigte nur `apiKey` und `openaiClient`, nicht aber `callLlm`. Dadurch lief Tier-3-Routing in der Engine nie tatsächlich ab — sie fiel still auf T1/T2 zurück, obwohl das Gateway-Log „tier-3 enabled via callLlm" anzeigte. Einzeiler-Fix: `callLlm` ist jetzt Kriterium für `_t3Enabled`.

- **Tier-3 fälschlicherweise an Cohere gekoppelt** (`index.js`): `emotionT3Enabled` prüfte, ob der Cohere-Reranker konfiguriert ist — kein Cohere → kein Tier 3, auch bei aktivem `merging`-LLM. Da `feature-profiles.js` `emotion.t3.enabled: true` im Recommended-Profil setzt, wäre Tier 3 bei allen Neuinstallationen ohne Cohere still deaktiviert geblieben. Neues Gate: Tier 3 aktiviert sich, wenn `mergingLlmCfg` **oder** `emotion.t3.apiKey` vorhanden ist. `onlyWhenProviderAvailable: true` (Default) sorgt für sauberes Soft-Skip ohne Fehler, wenn kein Provider konfiguriert ist.

- **`apply-media-patch.sh` aktualisiert `installs.json` manifestHash**: Nach dem Sync von `openclaw.plugin.json` wird der SHA-256-Hash in `installs.json` atomar nachgezogen, damit Gateway-Konfigurationsvalidierung stets gegen das aktuelle Schema prüft — verhindert `Unrecognized key`-Fehler bei Schema-Erweiterungen nach Patch-Deployments.

### Added

- **`emotion-engine-engine.js` erkennt `callLlm` als Provider**: Tier-3-Klassifizierung läuft jetzt vollständig über den plugin-internen `callLlm`-Pfad (konfigurierter Merging-LLM-Provider), ohne hardcodierten OpenAI-Client. Funktioniert mit jedem kompatiblen Endpunkt.

## [6.8.7] — 2026-06-27 — Cron Plugin Command Dispatch Fix

### Fixed
- **Gateway patch #16** (`apply-media-patch.sh`): OpenClaw 2026.6.11 (PR #85341 "internalize agent runtime") broke all `/plur1bus ...` cron `agentTurn` jobs — commands bypassed `handlePluginCommand` and went directly to the LLM, which hallucinated responses. Patch intercepts slash-commands in `runCronIsolatedAgentTurn` (before `executeCronRun`), calls the matching plugin command handler with correct `agentId` + `workspaceDir` from the cron context, then either returns early for silent jobs (e.g. `discover-semantic-links`, `consolidate-daily`) or injects the plugin result into `commandBody` for delivery jobs (e.g. `morning-review`/`evening-review`) so the LLM formats and sends correctly.

### Notes
- No code changes in plugin JS itself — only `apply-media-patch.sh` updated.
- No DB schema changes. No breaking changes.

## [6.8.6] — 2026-06-27 — Manifest Version Sync

### Fixed
- `openclaw.plugin.json`: version was stuck at `6.8.0` — now aligned with `package.json` (`6.8.6`). Fixes ClawHub package-manifest-version-drift warning.

### Notes
- No code changes. No DB schema changes.

## [6.8.5] — 2026-06-27 — Neo Worker Drain Await Fix

### Fixed
- `lib/neo-worker-runner.js`: `drainEmbeddingQueue()` call was missing `await` — the unresolved Promise was passed to `postMessage` and serialised as `{}`, so callers never received drain results. Now correctly awaited before posting back to the main thread.

### Notes
- No DB schema changes. No breaking changes.

## [6.8.4] — 2026-06-27 — Code-Review Micro-Fixes

### Fixed
- `lib/code-index/ts-source-indexer.js`: Replace O(n) `symbols.find(symbol => symbol.node === node)` in AST visitor with a `Map` lookup — O(1) per node, avoids repeated linear scan across the symbol array for every visited AST node.
- `scripts/auto-capture-lancedb.mjs`: Remove dead `const items = allItems` alias; use `allItems` directly in the subsequent filter and slice expressions.

### Notes
- No DB schema changes. No breaking changes.

## [6.8.3] — 2026-06-27 — Installer Performance + Robustness

### Fixed
- `install-memory-system.sh`: 7 sequential `jq` subprocess calls on `$FEATURE_UPDATE_PLAN` consolidated into one batch `eval`+`@sh` extract (5 scalar fields, 1 subprocess instead of 5).
- `install-memory-system.sh`: 2 sequential `jq` calls on `$PLUGIN_CONFIG` consolidated into one batch `eval`+`@sh` extract.
- `install-memory-system.sh`: `FINAL_PLUGIN_CONFIG_JSON` and `DETECTED_BY_JSON` intermediate variables eliminated — fields now inlined directly into the `INSTALL_EVENT_INPUT` jq-n call.
- `install-memory-system.sh`: Redundant `| jq -c .` pipe on `EXISTING_PLUGIN_CONFIG_JSON` removed (first `jq -cn` already produces compact JSON).
- `installer-config.mjs`: `readJsonEnv` now wraps `JSON.parse` in try/catch — invalid env JSON produces a clear error instead of an unhandled exception crash.

### Notes
- No DB schema changes. No breaking changes.

## [6.8.2] — 2026-06-27 — Installer Fixes + Code-Review Cleanup

### Fixed
- `installer-config.mjs`: `buildInstallLogEvent` now passes `input.featureMode` to the internal `createFeatureUpdatePlan` call instead of hardcoding `"preserve"` — audit ledger now correctly reflects `fresh` / `enable-all` installs.
- `installer-config.mjs`: Removed dead `afterDisabled` Set (built but never read in `createFeatureUpdatePlan`).
- `installer-config.mjs`: Simplified `newlyDisabled` filter — vacuous guard `!afterActive.has(feature.key)` removed (items in `after.disabled` are mutually exclusive with `after.active` by construction).
- `install-memory-system.sh`: LanceDB dimension-check summary warning now correctly distinguishes dry-run (`"Dry-run: …"`) from remote-live installs (`"Remote-Ziel: …"`) — live remote installs no longer emit a misleading `"Dry-run:"` prefix.

### Notes
- No DB schema changes.
- No breaking changes.
- Includes all installer improvements from v6.8.1 (i18n sync, typescript dep) and the PR #75 installer rewrite.

## [6.8.1] — 2026-06-27 — i18n Sync + TypeScript Dep Fix

### Fixed
- i18n dictionary synced with OpenClaw 2026.6.11: 752 missing keys added for IRC, Feishu, NextcloudTalk, Google Chat, new plugin-wizard and gateway-config screens (`wizard.irc.*`, `wizard.feishu.*`, `wizard.nextcloudTalk.*`, `wizard.googlechat.*`, `wizard.plugins.*`, `wizard.channels.*`, `wizard.remote.*`, `wizard.gateway.*`, `common.*`).
- `typescript` added as optional dependency (`^5.9.3`) — required by the new code-index feature; was installed in the environment but not declared, causing `ERR_MODULE_NOT_FOUND` in test environments without a pre-existing install.

### Notes
- No DB schema changes.
- No breaking changes.
- Backward-compatible with all v6.8.0 installations.

## [6.8.0] — 2026-06-26 — Performance, Code Context, Media, and Runtime Packaging

### Added
- Async media diarization merge pipeline with speaker naming, manual mapping, and contextual speaker-name proposals.
- Emotional-state injector plugin and shared mood-carrier library for cron-based state injection.
- Optional local JS/TS code index generation with bounded `<code-context>` query output.

### Changed
- Legacy auto-capture duplicate handling now batches inserts and can use ANN multi-query duplicate lookup when LanceDB exposes the needed API.
- Hot-path JSON writes are queued asynchronously and remaining high-cost prompt work was narrowed after the main-branch performance audit.
- Package metadata, README, release notes, and OpenClaw manifest now target `6.8.0`.

### Fixed
- Emotional-state injector files are included in the npm package via the tracked `.openclaw/extensions/emotional-state-injector/` package path.
- Error handling now preserves cause chains in DB/embedding paths and logs failures instead of silently swallowing them in touched hot paths.


## [6.8.7] — 2026-06-27 — Obsidian Bridge Installer Fix

### Fixed

- **Installer (`install-memory-system.sh`)**: `obsidianBridge` was never configured by the installer, leaving the Obsidian bridge permanently disabled after fresh installs. The bridge service requires `enabled: true` to activate; without it, `link-index.json` and `semantic-lens-index.json` silently stagnated.
- Added full `obsidianBridge` block to `PLUGIN_CONFIG`:
  - `enabled: true`, `watch: false`, `dryRun: false`, `autoApplyLowRisk: true`
  - `workspaces` array auto-built from detected agent/workspace pairs (`WORKSPACE_MAP`)
  - `graphLinks.semanticDiscovery` enabled (`maxPerRun: 500`, `threshold: 0.78`)
- **New Schritt 9d**: Installer now registers a daily OpenClaw-managed cron job (`plur1bus-semantic-discover-daily`, `0 2 * * * Europe/Berlin`) for `/plur1bus internal discover-semantic-links` — no hardcoded LLM model, no hardcoded thinking level (both `NULL`, gateway defaults apply).

### Notes

- No DB schema changes. No breaking changes.
- Existing installs: re-run installer or manually add `obsidianBridge` config + cron job.
- `link-index.json` / `semantic-lens-index.json` will update nightly from 02:00 CET onward.

## [6.7.8] — 2026-06-20 — Privacy Hardening

### Security
- Removed `.openclaw/scripts/` from repository tracking and added `.openclaw/` to `.gitignore`.
- Removed real names and hardcoded agent IDs/paths from operational scripts:
  - `scripts/cleanup-vault-missing-tasks.mjs`
  - `scripts/auto-capture-lancedb.mjs`
  - `scripts/run-semantic-link-index-phase43c.mjs`
  - `scripts/run-semantic-discover-once.mjs`
  - `scripts/run-graph-links-once.mjs`
- Operator-local agent/workspace data now supplied via environment variables:
  - `PLUR1BUS_VAULTS`
  - `PLUR1BUS_AGENTS`
  - `PLUR1BUS_WORKSPACES`
  - `PLUR1BUS_VAULT_PATH`

### Notes
- No real API keys were found in the public repository or release history.
- Remaining references to agent IDs in docs/tests/core constants are non-operational examples or product defaults.

## [6.7.4] — 2026-06-20 — Reply Outcome Tracking

### Added
- Reply-based Outcome Tracking: automatische Auswertung der nächsten User-Antwort auf injizierte Memories.
- Integration mit feedback-log / Memory-Dynamics für positive und negative Outcome-Signale.
- Append-only Audit-Log unter .adaptive-learning/reply-outcomes.jsonl.
- Tests für positive/negative Outcomes, Pending-Flow, canonical-ID-Filter und Idempotenz.

### Fixed
- Config-Schema-Audit-Tests an konservative v6.7.3-Defaults angeglichen (Tests waren gegenüber Full-Experience-Schema-Defaults veraltet).
- Schema-Defaults für `autoCapture`, `autoRecall`, `runtime.maxConcurrentRecall`, `runtime.embeddingCacheEnabled` und `reranker.enabled` an tatsächliche Code-Fallbacks angeglichen.

### Notes
- Keine DB-Schema-Änderung.
- Keine historischen Memory-Rewrites.
- Additive, rückwärtskompatible Änderung.

## [6.7.3] — 2026-06-20 — Source Sync + Multi-Namespace + Temporal Continuity

### Added

- **MultiNamespacePool** (`lib/multi-namespace-pool.js`): Shared pool für namespace-übergreifende LanceDB-Zugriffe. Ermöglicht Recall über mehrere Workspaces hinweg mit einheitlicher ACL-Prüfung.
- **Temporal Continuity Context** (`lib/temporal-context.js`, `formatTemporalContinuityContext`): Injects zeitlichen Kontinuitäts-Kontext in Recall-Blöcke — der Agent weiß, wie lange die letzte Session her ist und kann Lücken korrekt einordnen.
- **Conflict Summary Management** (`buildConflictSummaryFromLog`, `readConflictSummary`, `writeConflictSummary`): Verdichtet den Conflict-Log in eine persistente Summary-Datei pro Workspace. Reduces LLM-Kosten für Conflict-Review.
- **`shouldSkipAutoRecallForInternalTurn`** (`lib/runtime-scheduler.js`): Background-Turns (Dreaming, Cron) überspringen jetzt den Auto-Recall vollständig — verhindert unnötige LanceDB-Abfragen im Hintergrund.
- **`/plur1bus start` Onboarding** (`renderPlur1busStartStatus`, `consumePlur1busStartNotice`): Geführtes Setup mit Status-Anzeige beim ersten Start.

### Fixed

- **`workspaceKey` in auto-capture-lancedb.mjs** (`scripts/auto-capture-lancedb.mjs`): Schema-Mismatch bei `table.add()` behoben — `workspaceKey` war in der Spalten-Migrations-Liste und im Default-Row-Template des Cron-Scripts nicht vorhanden.
- **Source-Sync** (`patches/apply-memory-patches.sh`): Deploy-Source `/root/index.js` wird beim Gateway-Start automatisch mit der kanonischen Repo-Version abgeglichen (Nachfolge-Fix zu v6.7.2).

## [6.7.2] — 2026-06-20 — Deploy-Source Sync

### Fixed
- **Plugin-Deploy-Sync** (`patches/apply-memory-patches.sh`): `apply-memory-patches.sh` synchronisiert jetzt beim Gateway-Start automatisch `/root/index.js` (Deploy-Source für `apply-media-patch.sh`) mit der kanonischen Repo-Quelle (`index.js` im Plugin-Verzeichnis). Verhindert, dass ein veralteter Deploy-Stand neue Plugin-Features (z.B. `/plur1bus start` Onboarding-Handler) überdeckt, weil `apply-media-patch.sh` die Deploy-Source auf die Extensions kopiert.

## [6.7.1] — 2026-06-20 — Reranker Bugfix

### Fixed
- **Reranker: `local-transformers` kein automatischer Fallback mehr** (`index.js`): Bei Cohere-Reranker-Config wurde `LocalTransformersRerankerProvider` (ONNX/HuggingFace) immer instanziert, auch wenn `fallbackProvider` nicht gesetzt war. Das blockierte den Node.js-Event-Loop für 3–8 Sekunden pro Session-Start und erhöhte den Gateway-RSS auf 1.5–1.7 GiB. Fix: `LocalTransformersRerankerProvider` wird nur noch erstellt wenn `rerankerCfg.fallbackProvider === "local-transformers"` explizit in der Config steht. Default (kein `fallbackProvider` oder `"disabled"`) verwendet Cohere direkt ohne lokalen Fallback. Spiegelt das korrekte Verhalten aus `lib/providers/factory.js`.

## [6.7.0] — 2026-06-19 — PLUR1BUS Full Experience Defaults

### Added
- **Full Experience Defaults** (`lib/setup/feature-profiles.js`): 28 `CORE_FEATURES` sind default ON. Frische Installs bekommen die vollständige PLUR1BUS-Experience. Updates bewahren konfigurierte Werte; fehlende neue Core-Features werden als enabled-Default ergänzt (opt-out, nicht opt-in).
- **`/plur1bus start`** — Installations-Abschluss-Command: zeigt aktive Features, deaktivierte Features, Safety-Gates und Obsidian/Review/Dashboard-Status. Schreibt keine Feature-Selection-History.
- **Non-interactive Start Notice** — Pending-Notice-System (`writePlur1busStartNotice` / `consumePlur1busStartNotice`): Bei Non-Interactive-Updates wird eine Startup-Notice nach `~/.openclaw/state/plur1bus-pending-notice.json` geschrieben und beim nächsten Turn consume-after-display in `<plur1bus-start-notice>` injiziert.
- **Temporal Continuity Context** (`lib/temporal-context.js`): Injiziert bei jedem Turn den aktuellen Timestamp, das Delta seit dem letzten User-Turn und einen Gap-Bucket-Hint in `<temporal-context>`. Default ON, nie als Memory gespeichert.
- **`applyFullExperiencePolicy`** — Merge-Logik: Missing Core Features werden als enabled ergänzt; `stripFeatureSelectionHistory` entfernt `featurePolicy`, `featuresConfirmedAt`, `setupProfile` bei jedem Schreibvorgang.
- Provider Wizard: interaktive Wahl zwischen OpenAI und lokalem Embedding (intfloat/multilingual-e5-small)
- Provider Wizard: Reranker-Wahl Cohere / lokaler BGE / disabled / Advanced
- `lib/providers/factory.js`: gemeinsame Provider-Factory für index.js + auto-capture
- `lib/providers/dimension-guard.js`: Status-Objekt, blockiert Provider-Wechsel bei unknown
- `lib/namespace-config.js`: recallReadNamespaces-Semantik, write/legacy-readonly-Trennung
- `lib/multi-namespace-pool.js`: MultiNamespacePool — ein AgentDbPool pro Namespace
- `scripts/provider-wizard.mjs`: i18n-konformer Node-Wizard (alle Texte via lib/i18n.js)
- `scripts/reindex-provider.mjs`: Dry-Run/Report-Only Scaffold (kein --apply ohne Folgepatch)
- i18n: `setup.reranker.*` + `setup.embedding.*` Keys (de + en)
- `apiKeyEnv` als bevorzugtes Credential-Schema in normalizeEmbeddingConfig + normalizeRerankerConfig
- `resolveApiKey(cfg, {defaultEnv, optional, label})` — provider-sicher, kein globaler OPENAI-Fallback

### Changed
- `DEFAULT_LOCAL_RERANKER_MODEL`: Alibaba-NLP/gte-reranker-modernbert-base → BAAI/bge-reranker-v2-m3
- `auto-capture-lancedb.mjs`: liest Plugin-Config aus openclaw.json via PLUR1BUS_PLUGIN_DIR, kein harter OPENAI_API_KEY-Check
- `index.js`: Pool-Initialisierung → MultiNamespacePool; Store → getWriteDb; Recall → getReadDbs mit single/multi-namespace Branch
- `ChainedRerankerProvider`: null-Fallback sicher (kein Crash bei fallbackProvider=disabled)
- Cohere-Fallback default: `fallbackProvider=disabled` statt Auto-Local-BGE

### Fixed
- auto-capture: OPENAI_API_KEY nicht mehr aus process.env erforderlich (import aus PLUR1BUS_PLUGIN_DIR)
- ChainedRerankerProvider: constructor und rerank() crashen nicht mehr bei fallback=null

## [6.6.3] — 2026-06-18 — workspaceKey Schema Migration

### Fixed

- **`workspaceKey` fehlt in automatischer Schema-Migration** (`index.js`, `lib/db-adapter.js`): Das Feld `workspaceKey` wurde in 6.6.1 zum Datenmodell hinzugefügt, aber weder in der `allColumns`-Migrationsliste in `MemoryDB.init()` noch in `ensureReminderColumns()` in `db-adapter.js` ergänzt. Bestehende Tabellen, die vor 6.6.1 angelegt wurden, erhielten die Spalte beim Update deshalb nicht automatisch — `table.add()` warf `Found field not in schema: workspaceKey at row 0`. Fix: `workspaceKey` ist jetzt in allen drei Migrationspfaden enthalten (`allColumns`-Liste, `ensureReminderColumns`, `createTable`-Schema für neue Tabellen).

## [6.6.2] — 2026-06-18 — Dreaming Cron Fix

### Fixed

- **Dreaming Cron Lane-Timeout** (`index.js`): Die `before_prompt_build`-Hook führte für interne Dreaming/Sleep-Magic-Messages (`__openclaw_memory_core_short_term_promotion_dream__`, `__openclaw_memory_core_light_sleep__`, `__openclaw_memory_core_rem_sleep__`) die komplette LanceDB-Recall-Pipeline aus. Bei 8 Workspaces × ~130s Event-Loop-Blocking = ~1040s gesamt, was den `cron-nested`-Lane-Timeout (bisher 300s, jetzt 900s) konsequent riss. Fix: Diese drei Magic-Messages werden am Anfang des Hooks erkannt und mit Early-Return übersprungen. Das Dreaming benötigt keinen Recall-Kontext — es erzeugt ihn selbst. Behebt `consecutiveErrors: 14`.

## [6.6.1] — 2026-06-18 — Repair-Fix

### Fixed

- **Auto-Capture Schema-Mismatch** (`scripts/auto-capture-lancedb.mjs` v2.3.0): `table.add()` schrieb mit dem alten Basis-Schema (16 Felder) in PLUR1BUS-verwaltete LanceDB-Tabellen, die das erweiterte 57-Spalten-Schema haben. LanceDB warf `Append with different schema: fields did not match` für alle 37 fehlenden Felder (u.a. `retrievalCount`, `memoryKind`, `workspaceKey`, `remindAt` etc.). Fix: Alle PLUR1BUS-Schema-Felder mit sinnvollen Defaults ergänzt. Cron-Key-Quelle von `auth-profiles.json` (nicht mehr vorhanden) auf `grep '^OPENAI_API_KEY=' .env` migriert — konsistent mit `embed-promoted-memories`.

### Changed — Ops/Repair Tooling

- **`scripts/lib/deploy-integrity.mjs`**: Kanonische `DEPLOY_FILES`-Liste (27 Einträge) jetzt als exportiertes Modul-Const. Wird von beiden Verify- und Repair-Scripts importiert — keine Divergenz mehr möglich.
- **`scripts/verify-plugin-deploy.mjs`**: Importiert `DEPLOY_FILES` aus `deploy-integrity.mjs` statt eigene kürzere Liste zu pflegen.
- **`scripts/repair-installed-plugin.mjs`**: (a) Importiert `DEPLOY_FILES` aus `deploy-integrity.mjs`. (b) Backup wird jetzt **vor** `validateDeployment(repair:true)` erstellt (vorher: nach erster Modifikation). (c) Exit-Codes präzisiert: 0=alles OK, 1=Integrity-Failures, 2=Unexpected Error, 3=Warnings (LanceDB elevated / Dreaming Cron error, Integrity OK).
- **`scripts/maintain-lancedb.mjs`**: `--apply` erstellt jetzt vor dem Löschen ein Prune-Backup unter `~/.openclaw-backups/lancedb-prune-{ts}/` mit Kopien aller zu löschenden Manifest-JSON-Dateien und einem `_prune-manifest.json`-Index.
- **`scripts/verify-workspace-writer.mjs`** (neu): Erkennt Workspace-`memory`-Verzeichnisse und Dream-Diary-Pfade aus `openclaw.json` (Fallback: main/bernhardine/heisenberg), schreibt Healthcheck nur nach `tmp/.healthcheck-{agent}`, berührt keine echten Memory-Daten.

### Added

- **`package.json` `files`**: `scripts/` und `docs/` werden jetzt mit dem npm-Paket ausgeliefert — Repair/Ops-Scripts und Dokumentation sind nach Installation per `npx`/`npm exec` verfügbar.
- **`package.json` `lint`**: Scripts-Verzeichnis (`find scripts -name '*.mjs'`) wird jetzt ebenfalls per `node --check` geprüft.
- **Tests** (`tests/repair-scripts.test.js`): Neue Tests für Backup-vor-Repair, Exit-Codes, maintain-lancedb dry-run/apply/snapshot, verify-workspace-writer Healthcheck, keine Memory-Daten berührt.

## [6.6.0] — 2026-06-10 — Engram

### Added — Meta-Cognition (PR #21)

- **Recall-Quality-Metriken**: Precision, Recall, F1 aus User-Feedback (`/mf +/-/~`)
- **Coverage-Gap-Erkennung**: Topics mit wenig Memories oder niedriger `memoryStrength` identifizieren
- **Threshold-basierter Reflection-Trigger**: Auto-Run bei `sessionThreshold` (default: 50) oder `intervalDays` (default: 7)
- **Optioneller LLM-Report**: Natürlichsprachige Reflexions-Zusammenfassung wenn `llmReport: true`
- State-Persistenz in `_meta-cognition-state.json` pro Workspace

---

## [6.5.0] — 2026-06-10 — Engram

### Added — Proactive Nudges mit Embedding-Clustering (PR #20)

- **Embedding-basierte Pattern-Erkennung**: Cosine-Similarity über Embedding-Centroids für Turn-Clustering
- **Cluster-Persistenz**: Cluster werden pro Workspace/Agent gespeichert und überleben Restarts
- **Cooldown-Mechanismus**: Nudges werden rate-limited (default: 24h pro Workspace)
- **Konfigurierbare Thresholds**: `minClusterSize`, `similarityThreshold`, `maxNudgesPerDay`

---

## [6.4.0] — 2026-06-10 — Engram

### Added — Emotion Tier-Config (PR #19)

- **Budget-Gate pro Tier**: Tier-1 (Regex), Tier-2 (Heuristik), Tier-3 (LLM) einzeln aktivierbar/deaktivierbar
- **Konfigurierbares Modell pro Tier**: `gpt-4o-mini` für Tier-3 oder eigener Provider via `baseUrl`/`apiKey`
- **Feature-Toggle**: `emotionTier` auf spezifisches Tier locken oder `auto` für dynamische Eskalation
- **Graceful Degradation**: Fallback von Tier-3 auf Tier-2 wenn kein API-Key verfügbar

---

## [6.3.0] — 2026-06-10 — Engram

### Added — Explainability, GC Job, Feedback Analyzer (PR #15)

- **Explainability** (`--explain` Flag für `/memory`): Begründung pro Treffer mit Score-Breakdown
- **Garbage Collection Job**: Hintergrund-GC für expired/stale Memories mit konfigurierbaren Retention-Policies
- **Feedback Analyzer**: Analyse von User-Feedback (`/mf +/-/~`) für Recall-Quality-Verbesserung

### Fixed

- **Audit-Fixes v6.2.0** (Commit `c60b28a`): Validierung, Lint, CI — P2-Audit-Ergebnisse eingearbeitet

---

## [6.2.0] — 2026-06-10

### Summary

Stable minor release. Collects all 6.1.x work: deep emotion system (8 Plutchik dimensions, 20+ nuances, blends, emotion-specific decay), robust schema migration, active-memory fast-path redesign (plur1bus-direct, ~1-3s vs. 120s timeout), and full 57-column schema defaults in `normalizeEntryForTable`.

No breaking changes vs. 6.1.x. Upgrade from 5.x: run `node scripts/migrate-missing-columns.mjs` once per agent namespace after deploy.

## [6.1.5] — 2026-06-10 (Post-Deploy Fixes)

### Fixed

- **`workspaceKey` fehlte in `scripts/migrate-missing-columns.mjs`**: `reminder-store.js` queried `workspaceKey` als LanceDB-Spalte, aber das Migrations-Script kannte das Feld nicht → `plur1bus-reminder` crashte bei jedem Session-Inject mit `LanceError(Schema): No field named "workspaceKey"`. Spalte zur `ALL_COLUMNS`-Liste ergänzt. **Migration muss manuell ausgeführt werden** (Gateway stoppen, `node scripts/migrate-missing-columns.mjs` für jeden Agent-Namespace unter `memory/lancedb-namespaced/`, Gateway starten).

- **active-memory-fast-path: vollständiges Redesign (host-Patch)**: Der `active-memory-fast-path`-Patch in `apply-media-patch.sh` importierte `getActiveMemorySearchManager` aus `memory-host-search-*.js`, was immer `null` zurückgab, wenn `agents.defaults.memorySearch.enabled: false` gesetzt war (unser Standard-Setup). Folge: Silent-Fallthrough auf den 120s-LLM-Pfad → 100% Timeout-Rate bei allen Direct-Messages an main/bernhardine/heisenberg. Fix: Fast-Path umgebaut auf PLUR1BUS LanceDB Direct Access — OpenAI Embeddings API + direkter LanceDB-Zugriff (`/root/.openclaw/extensions/memory-lancedb-namespaced/node_modules/@lancedb/lancedb`). Umgeht `memory-host-search` vollständig. Latenz: ~1-3s statt 120s-Timeout. **Betrifft nur den Host-Patch in `apply-media-patch.sh`, nicht den Plugin-Code selbst.**

- **`normalizeEntryForTable` — LanceDB-Schema-Mismatch bei Reminder-Inserts**: Beim Speichern von Reminders (`saveReminder` via `reminder-store.js`) fehlten ca. 37 Schema-Felder im erstellten Record (z.B. `moodContextAtCapture`, `lastStrengthenedAt`, `updateSource`, `reconsolidationConfidence` etc.). LanceDB warf `Append with different schema: fields did not match` und rollte den Insert zurück. Ursache: Die bisherige Schnittstelle in `normalizeEntryForTable` ergänzte nur Reminder-Spalten als Defaults, nicht aber die vollständigen 57-Spalten-Defaults des 6.1.x-Schemas. Fix: Komplette Default-Abdeckung aller Schema-Spalten in `normalizeEntryForTable` ergänzt — verhindert Schema-Mismatch unabhängig davon, welche Felder der Aufrufer mitliefert.

## [6.1.4] — 2026-06-09

### Added — Uncommitted Features Consolidated

> **Consolidation-Release.** Alle Features aus `feature/emotion-integration` und uncommitted Changes aus `../memory-analysis` wurden in `main` gemergt. 550 Tests, 0 Failures.

- **ACL / Access Control** (`lib/acl-middleware.js`)
  - Agent- und Workspace-basierte Zugriffskontrolle für Memories
  - Filterung in `searchByTopic`, `getCard`, und Recall-Pipeline
  - Log-Audit für abgelehnte Zugriffe

- **Feedback-Loop** (`lib/feedback-log.js`, `lib/jobs/feedback-analyzer.js`)
  - `/mf <ID> +|-|~` Command für Memory-Feedback (👍/👎/neutral)
  - Persistente Feedback-Speicherung pro Workspace
  - Hintergrund-Analyse für Recall-Qualitäts-Verbesserung

- **Temporal Reasoning** (`lib/temporal-parser.js`, `lib/temporal-filter.js`)
  - Zeit-Ausdrücke im Query: "letzten Monat", "vor 3 Tagen", "Q2 2026"
  - Anchor-Resolution: Zeit-Referenzen werden auf konkrete Date-Ranges aufgelöst
  - Filterung vor Boost/Rerank für bessere Performance

- **Proactive Nudge** (`lib/proactive-nudge.js`, `lib/jobs/proactive-check.js`)
  - Proaktive Erinnerungs-Vorschläge basierend auf Mustern
  - Konfigurierbare Cron-Frequenz und Thresholds

- **Meta-Cognition** (`lib/meta-cognition.js`, `lib/jobs/reflection-job.js`)
  - Selbstreflexion über Memory-Nutzungsmuster
  - Wöchentliche Reflexions-Jobs mit Pattern-Erkennung

- **Collaborative Memory** (`lib/shared-memory.js`)
  - `/share <ID>` Command: Karten in Workspace-Pool teilen
  - ACL-geschützter Zugriff auf geteilte Memories

- **Explainability** (`lib/explainability.js`)
  - `--explain` Flag für `/memory`: zeigt Begründung pro Treffer
  - Transparente Recall-Entscheidungen für den Nutzer

- **Query Refinement** (`lib/query-refiner.js`)
  - Automatische Query-Erweiterung bei schlechten Ergebnissen
  - Kombination originaler + verfeinerter Suche mit Deduplizierung

- **Garbage Collection Job** (`lib/jobs/gc-job.js`)
  - Hintergrund-GC für expired/stale Memories
  - Konfigurierbare Retention-Policies

### Added — Tiefere Emotionen (Phase 1)

- **8 Plutchik-Dimensionen** (v3): `disgust` ergänzt als vollwertige Basisemotion.
- **20+ Emotionale Nuancen** pro Sprache (de/en): relief, pride, gratitude, nostalgia, loneliness, resentment, awe, contempt, guilt, shame, hope, envy, compassion, curiosity, boredom, excitement, love, disappointment, embarrassment, serenity.
- **Strukturierte Nuancen-Objekte**: `{ label, intensity, confidence, source, language }` statt bloßer Strings.
- **Emotionale Blends** (lib/emotion-blends.js): Regelbasierte Erkennung komplexer Emotionen mit semantischem Trigger und Evidence:
  - bittersweet, schadenfreude, awe, melancholy, suspense, love, contempt, fiero, relief, disappointment, nostalgia
  - Confidence-Threshold: 0.45 mit Trigger, 0.5 ohne Trigger (keine Fake-Blends bei schwachen Emotionen)
- **Mini-Kontextfenster**: `{ previous_top_emotion, previous_timestamp, transition, target_entity }` für Transition-Erkennung (z.B. fear→joy = relief).
- **Emotion-spezifischer Decay**: surprise (2min), fear (20min), joy/trust (30min), sadness/disgust/anger (2h), resentment (6h), shame (12h).
- **Erweiterte Emojis**: 40+ Emojis für Nuancen und Blends.
- **Erweiterte `describeMood()`**: Berücksichtigt Nuancen in der Stimmungsbeschreibung (z.B. "dankbar und fröhlich").
- **19 neue Tests** in `test/emotion-nuances.test.js` für Nuancen, Blends, Emojis, EmotionalState und Backward-Compatibility.

### Changed
- `inferEmotionalValence()` erkennt jetzt auch Blends (sync, Tier 1).
- `inferEmotionalValenceAsync()` erkennt Blends über alle Tiers mit Kontext-Tracking.
- `EmotionScore` erweitert um `nuances`, `complex_emotion`, `emotional_context`, `blend_factors`.

### Fixed
- **Unicode-Regex für deutsche Umlaute**: `/\b\w+\b/g` → `/\p{L}+/gu` in Tier 1 und Tier 2.

## [6.1.3] — 2026-06-07

### Fixed
- **`ensureDynamicsColumns` fehlte `replayCount` + `lastReplayed`**: `lib/db-adapter.js` hatte die Replay-Spalten nur in `MemoryDB.init()` (index.js), aber nicht im DB-Adapter. Telegram-Commands und andere Adapter-Consumer, die über `resolveTable` gehen, haben die Spalten daher nicht ergänzt bekommen. Jetzt konsistent mit `index.js`.
- **Standalone-Migrationsskript als `.mjs`**: `scripts/migrate-missing-columns.mjs` ist jetzt im Repo enthalten und wird von `.gitignore` explizit getrackt.

### Added
- `tests/db-adapter-replay-columns.test.js` — prüft, dass `ensureDynamicsColumns` die Spalten `replayCount` und `lastReplayed` zuverlässig ergänzt und idempotent bleibt.

## [6.1.2] — 2026-06-07

### Fixed
- **Robustere Schema-Migration**: `MemoryDB.init()` nutzte einen einzigen großen try/catch für alle `addColumns`-Aufrufe. Wenn eine Spalte fehlschlug, wurden alle nachfolgenden nicht mehr hinzugefügt. Jetzt: Schema wird einmal gelesen, dann wird jede Spalte einzeln mit eigenem try/catch migriert. Ein Fehler bei `replayCount` blockiert nicht mehr `lastReplayed` (oder umgekehrt).
- **Standalone-Migrationsskript**: `scripts/migrate-missing-columns.js` erlaubt manuelle Nachmigration auf Servern, die das Plugin nicht automatisch migriert hat (z.B. ältere LanceDB-Versionen ohne `addColumns`-Support im Runtime-Pfad).

### Added
- `tests/migration-robustness.test.js` — prüft, dass die Migration idempotent ist und fehlende Spalten zuverlässig ergänzt.

### Changed
- Keine DB-Schema-Änderungen (nur robustere Hinzufügung bestehender Spalten).
- Keine API-Änderungen.

## [6.1.1] — 2026-06-07

### Fixed
- **Package-Metadata-Version meldete 6.0.1 unter v6.1.0-Tag**: `package.json`, `package-lock.json` und `openclaw.plugin.json` wurden auf `6.1.1` synchronisiert, damit `npm pack` und Installation den korrekten Versions-String liefern.

### Changed
- Keine Laufzeit-Änderungen.
- Keine DB-Schema-Änderungen.

## [6.1.0] — Engram — 2026-06-07

> **General Availability.** Alle P5-Validierungen bestanden: P5A (8/8), P5B (6/6), P5C (5/5), P5D (8/8), P5E (9/9). 441 Tests, 0 Failures über 100 Test-Suites.

### Breaking Changes
- **Keine.** v6.1.0 ist vollständig abwärtskompatibel mit v6.0.x. Keine Schema-Migration, keine manuellen Eingriffe erforderlich.

### Upgrade-Hinweise
- In-place Upgrade von v6.0.x: Config-Defaults werden automatisch übernommen.
- Kein DB-Reset nötig; bestehende Memories bleiben erhalten.
- Rollback auf v6.0.x jederzeit sicher (`git checkout 917e403`); keine DB-Schema-Änderungen, keine Datenmigration nötig.

### Added — Recall Hardening (Engram)

- **P0 — Recall-Budget & Deduplizierung**
  - `maxPromptMemories` (default `12`): hartes Limit für Memories im Prompt-Kontext
  - `dedup` Threshold auf `0.78` erhöht: aggressivere Entfernung nahezu identischer Einträge
  - **Akronym-Erkennung**: semantisch ähnliche Akronyme werden bei der Deduplizierung als identisch behandelt
  - `canonicalMaxItems` (default `5`): maximale Anzahl kanonischer Repräsentanten pro Cluster

- **P1 — Typbasierte Half-Life**
  - `halfLifeDaysMap` mit typ-spezifischen Defaults:
    - `transient`: `60` Tage
    - `episodic`: `180` Tage
    - `longContext` / `project`: `600` Tage (P5D: datengestützte Anpassung für >0.88-Recall nach 100 Tagen)
  - Ersetzt das globale `halfLifeDays` durch kontextsensitives Vergessen

- **P2 — Performance & Skalierung**
  - **Embedding-Cache**: LRU-Cache für Embedding-Vektoren mit TTL
    - `embeddingCacheEnabled` (default `true`)
    - `embeddingCacheTtlMs` (default `300000` = 5 Minuten)
    - `embeddingCacheMaxEntries` (default `1000`)
  - **Recall-Kompression**: semantische Komprimierung langer Memory-Inhalte vor dem Prompt-Build
  - **Adaptive Recall-Tiers**: dynamische Budget-Allokation nach Memory-Typ (transient → episodic → longContext)
  - **Graph-Index**: beschleunigte Graph-Traversal durch invertierten Index auf Edge-Typen + Ziel-Memory
  - **Reinforcement-Loop**: erfolgreiche Recalls (niedrige Re-Rank-Distanz) stärken `memoryStrength` leicht

- **P2F — Hot-Path Metrics Debounce**
  - Telemetrie-Flush im Recall-Hot-Path wird auf 250 ms debounced
  - Vermeidet Synchronisations-Overhead bei schnell aufeinanderfolgenden Recall-Aufrufen

### Security — Hardening (P4C & P5)

- **SQL-Escaping** in `lib/filter-parser.js`: Standard-SQL-Konformität (`'\'` → `''`) zur Vermeidung von Injection in DB-where-Clauses.
- **ACL-Härtung** für destruktive Commands: `userId` muss in `allowedUserIds` enthalten sein; private DM erlaubt, Gruppen-Chat verweigert.
- **Path-Traversal-Schutz** verifiziert: `../../../etc/passwd` wird an mehreren Schichten blockiert.
- **Filter-Parser-Injection-Resistenz**: Parser resistiert gegen bösartige Eingaben in Filterausdrücken.

### Changed

- **P5D — Half-Life-Tuning für longContext / project**: `halfLifeDays` für `longContext` und `project` von `365` auf `600` Tage erhöht (datengestützt, um nach 100 Tagen noch >0.88 Recall-Qualität zu halten).
- **P3A — Config-Defaults konsolidiert**: `openclaw.plugin.json` um neue Recall-/Runtime-Keys ergänzt; JSDoc-Default für `dedupJaccard` korrigiert (`0.6` → `0.78`).
- **P4A — Toter Code entfernt**: 233 Zeilen ungenutzten Codes entfernt (`lib/memory-card-writer.js`, 6 tote Funktionen in `lib/obsidian-control-room.js`, `normalizeQuery` in `lib/embedding-cache.js`). Keine funktionale Regression.

### Fixed
- **Akronym-Tokenisierung**: `tokenizeAcronyms` erkennt jetzt korrekt Punkt- und Bindestrich-getrennte Akronyme (z. B. „A.I.", „REST-API") und normalisiert sie für die Deduplizierung.
- **`dedupJaccard` Default**: der Standardwert für `dedupJaccard` wurde von `0.0` auf `0.78` angehoben, um konsistent mit dem dokumentierten Deduplizierungsverhalten zu sein.

### Validation — v6-engram GA (P3–P5)

- **P3**: Config-Audit (41 Tests), E2E-Recall-Smoke (5 Tests), Performance-Benchmarks, Dead-Code-Audit.
- **P4**: Security-Regression (105 Tests), Upgrade-Simulation (12 Tests), Release-Packaging-Smoke, Public-API-Audit.
- **P5A**: Real-Upgrade-Dry-Run (8/8 Checks) — kein Datenverlust, keine Schema-Änderung nötig.
- **P5B**: Telegram-Command-Smoke (6/6) — ACL-Verhalten in Private/Group validiert.
- **P5C**: Obsidian-Bridge-Smoke (5/5) — Bidirektionaler Sync, Backup/Manifest/Audit, Path-Traversal-Schutz, atomare JSON-Writes.
- **P5D**: Recall-Quality-Golden-Set (8/8) — Akronyme, Decay, Dedup, Kompression validiert.
- **P5E**: Rollback-Test (9/9) — sicherer Rollback auf v6.0.x jederzeit möglich.

> **Bekannte Einschränkungen** siehe `docs/known-issues.md`.

## [6.0.1] — 2026-06-03

### Fixed
- **Emotional Recall-Boost war ein No-op**: `lib/recall-pipeline.js` kopierte `emotionalValence`/`emotionalIntensity`/`emotionalDominant` nicht ins Result-Entry → der stimmungsabhängige Boost rechnete immer mit einem Null-Vektor (Faktor 1.0). Felder werden jetzt durchgereicht und die Intensität an die deserialisierte Valenz angehängt.
- **Critical-Push war komplett inert**: `classify-recent` bekam weder ein Klassifikations-Modell noch `maxPerDay` aus der Config. Jetzt: echtes Modell (`criticalPush.model` → Fallback `merging.model`), `maxPerDay` aus Config, No-Poison-Guard (ohne Modell kein Markieren als `fakt`), und Push-Kandidaten werden als `pushMessages` im Job-Ergebnis für die Cron-Carrier-Zustellung zurückgegeben.
- **`recordHook` zerstörte den `agent_end`-State**: `current[hookName] = {…, ...meta}` ersetzte das ganze Objekt, sodass `processedDreams`/`processedEpisodes`/`lastProcessedMessageCount` sich gegenseitig löschten (High-Watermark & Idempotenz kaputt). Jetzt Merge-Semantik.
- **`MemoryDB.update` nicht atomar**: bei fehlgeschlagenem `add` nach `delete` wird das Original best-effort wiederhergestellt.
- **Schema-Lücke**: `criticalPush`, `dailyConsolidation`, `security`, `setupProfile`, `featuresConfirmedAt`, `morningReview`, `eveningReview` waren bei `additionalProperties:false` nicht im Config-Root-Schema → strikte Validierung hätte gültige v6-Configs (inkl. `featuresConfirmedAt`-Gate) abgelehnt. Keys ergänzt.
- Toter, unerreichbarer Cron-Command-Pfad (`resolvePlur1busCronCommandArgs` gab immer `null`) inkl. `agent_turn_prepare`-No-op-Hook entfernt.

### Security
- **`security.allowChatConfigCommands`** (default `true`): Operator-Opt-out, um in geteilten Channels alle config-mutierenden Chat-Commands (`/enable`, `/disable`, `/plur1bus setup`) zu sperren. Per-User-Authz ist nicht möglich, da das SDK dem Command-Handler keine Sender-Identität gibt.
- **File-Lock auf `openclaw.json`-Writes** (`withConfigLock`): verhindert lost-updates bei konkurrierenden Toggles/Setups.
- **Archive-First für das `memory_forget`-Tool**: schreibt vor dem Löschen ein JSON-Backup (wie `/forget`); schlägt das Archiv fehl, wird nicht gelöscht.
- **`safeSlug` härtet Punkt-Segmente**: `".."` kollabiert nicht mehr zu einem Traversal-Segment.
- Obsidian-Apply: `backupBeforeApply`/`auditLog` jetzt „an, außer explizit `false`" (deckt sich mit dem dokumentierten Default).

### Changed
- `lib/semantic-input.js`: `wasCompressed` spiegelt jetzt die tatsächliche Längenreduktion wider.

## [6.0.0] — 2026-06-03

### Breaking / Migration
- **Schema-Migration erforderlich** bei Upgrade von v5.2.11: `MemoryDB.init()` fügt automatisch alle v6-Spalten hinzu (emotionalValence, replayCount, memoryStrength, versionNumber, status, etc.). Bestehende Rows bleiben erhalten.
- `scripts/` und `tests/` wurden aus dem Repo entfernt und sind nicht mehr Teil der Distribution.

### Added — Phase 6: Consolidation Engine

- **Memory Compaction** (`lib/jobs/memory-compaction.js`)
  - Nicht-destruktive Deduplizierung: Aliases statt hartem Löschen
  - Ähnlichkeits-Clustering via Cosine Similarity (Threshold ≥0.88)
  - LLM-gestütztes Merging kompatibler Memories
  - Konflikt-Erkennung bei widersprüchlichen Entscheidungen
  - Auto-reduzierte Batch-Size für `local-transformers` (10 statt 50)
  - Fresh Embeddings für merged Text
  - Dry-Run Modus: keine DB-Mutationen, keine State-Writes

- **Conflict Resolver** (`lib/jobs/conflict-resolver.js`)
  - Automatische Konflikt-Auflösung via LLM
  - Reife-Filter: nur Konflikte älter als 7 Tage
  - Confidence-Threshold für Auto-Apply: ≥0.9
  - Deduplizierung bereits gelöster Konflikte
  - Topic-Gruppierung für kontextuellere Resolution

- **Atomic Job Locks** (`lib/job-lock.js`)
  - File-based Locking mit 10-Minuten-Staleness-Check
  - Verhindert parallele Ausführung von REM-Dream und Compaction

### Added — Phase 5: REM Dreaming

- **REM Dream Engine** (`lib/dreaming/rem-dream.js`)
  - Wöchentliche Muster-Erkennung über Sparse kNN-Graph
  - Cluster-Validierung: Min/Max-Size, Centroid-Similarity
  - LLM-basierte Pattern-Summary pro Cluster
  - Trend-Analyse: neu / stärker / schwächer / gleich / verschwunden
  - Idempotent via SHA256-Run-Key + `run-state.json`
  - Analysiert die **vorherige** abgeschlossene Woche (nicht die aktuelle)
  - Auto-reduzierte Limits für Local Provider (1000 Memories, topK 10)

### Added — Phase 4: Memory Graph

- **Memory Graph** (`lib/memory-graph.js`)
  - Drei Edge-Typen: semantic, temporal, episodic
  - Bidirektionale Adjazenzliste mit Deduplizierung
  - Graph-Traversal mit Depth-Limit und Zyklen-Erkennung
  - Assoziativer Spread in der Recall-Pipeline
  - Episode-Anchor-Edges für episodisches Binding
  - Vault-Ausgabe: Memory Constellation Report (Markdown)

### Added — Phase 3: Episodic Narrative

- **Episode Extraction** (`lib/episodes.js`)
  - Turn-Gruppierung zu Geschichten via LLM
  - Narrative Struktur: Setting, Trigger, Development, Resolution
  - Auto-Kürzung bei zu langen Sessions (>50 Turns)
  - Vault-Ausgabe: Episoden als Markdown-Dateien

### Added — Phase 2: Light Dreaming

- **Light Dream Engine** (`lib/dreaming/light-dream.js`)
  - Nach-Session-Reflexion: 3 Key Insights via LLM
  - Aktivierte Memories via Embedding-Suche
  - Memory-Strengthening: `replayCount + 1`, `lastReplayed` Update
  - Behavior-Card-Kandidaten aus expliziten Instruktionen/Korrekturen
  - Fire-and-forget im `agent_end` Hook
  - Idempotent via Session-Digest

### Added — Phase 1: Emotional Valence

- **Emotion Detection** (`lib/emotion.js`)
  - 28 Emotionen nach Plutchik-Rad-Modell
  - Intensity (0.0–1.0) + Dominant Emotion
  - Valence (positiv/negativ/neutral)
  - Mood Context: Emotionaler Zustand zum Zeitpunkt des Capture

- **Emotional State Pool** (`lib/emotional-state.js`)
  - Pro-Agent Emotional State Tracking
  - Stimmungsabhängiger Recall-Boost
  - `/state` zeigt aktuelle Emotion

### Added — Reranker & Provider

- **Chained Reranker** (`lib/providers/reranker-chained.js`)
  - Cohere Primary → Local Transformers Fallback
  - Automatischer Fallback bei API-Fehlern

### Changed

- **Schema Migration** (v5.3.0): Neue Spalten in LanceDB
  - `emotionalValence`, `emotionalIntensity`, `emotionalDominant`
  - `moodContextAtCapture`, `replayCount`, `lastReplayed`

- **Neo-Arch Erweiterung**
  - Neue JSONL-Dateien: `dream-diary.jsonl`, `episodes.jsonl`, `memory-graph.jsonl`, `pattern-analysis.jsonl`
  - `run-state.json` für Idempotenz-Tracking
  - Separate `NEO_JSON_FILES` (nicht gecappt/gedupt)

- **Recall Pipeline**
  - Emotional Boost: stimmungsabhängige Score-Anpassung
  - Assoziativer Spread: Graph-basierte Ergebnis-Erweiterung

- **Daily Consolidation** (`lib/jobs/daily-consolidation.js`)
  - Vollständige Phase-6-Integration
  - TTL-Expiration → Neo-Pruning → Compaction → Conflict Resolution
  - Vault-Ausgabe: Consolidation Report

### Fixed

- `crypto.randomUUID` nicht importiert in `memory-compaction.js`
- `getTable` undefiniert in `index.js` (Graph-Edge-Building)
- SQL-Injection via unsanitisierte `memoryId` in `light-dream.js`
- Kein Timeout bei Cohere `fetch` → 30s via `AbortController`
- Unbounded `readFileSync` in `conflict-resolver.js` → 50MB Limit
- `findBestPatternMatch` nutzt jetzt Jaccard-Ähnlichkeit

### Security

- `safeUuid()` für alle user-kontrollierten IDs in LanceDB where-Clauses
- `safeTimestamp()` für alle Zeitstempel-Filter

---

## [5.2.10] — 2026-05-XX

### Added
- Group session detection, sender attribution, clean text extraction

### Fixed
- `callLlm`: fallback to `reasoning_content` when `content` is empty
- `callLlm`: use `thinking: { type: "disabled" }` to suppress kimi-for-coding thinking

## [5.1.0] — 2026-04-XX

### Added
- Parallel capture, ANN index auto-reindex, query summarization

### Fixed
- Recall/capture feedback loop
- Bounded stores
- LanceDB AND-filter bug

## [4.2.0] — 2026-03-XX

### Added
- Obsidian Bridge: bidirektionale Synchronisation
- Feature Toggle System
- Neo-Arch: kognitive Schicht mit Candidates, Behavior Cards, Embeddings
