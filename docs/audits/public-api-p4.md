# P4 Public API / Export Audit

**Datum:** 2026-06-07
**Scope:** `lib/safe-update.js`, `lib/session-time.js`, `lib/runtime-scheduler.js`, `lib/memory-dynamics.js`, `lib/memory-graph.js`, `lib/neo-arch.js`, `lib/obsidian-bridge.js`, `lib/obsidian-control-room.js`
**Methode:** Statische Analyse aller `export` Statements plus grep-Verification gegen gesamte Codebase (`*.js`, `*.ts`, `*.mjs`, exkl. `node_modules`).

---

## Zusammenfassung

| Kategorie | Anzahl | Beschreibung |
|-----------|--------|--------------|
| **public/stable** | 40 | Wird von `index.js`, anderen Produktionsmodulen oder als CLI/API-Surface konsumiert |
| **internal/test-only** | 11 | Wird ausschließlich von Testdateien importiert; keine Produktionsnutzung |
| **internal** | 57 | Wird nur innerhalb der eigenen Datei verwendet; kein externer Import |
| **removable later** | 22 | Wird weder intern noch extern verwendet; sicher tot |

> **Anmerkung:** Kein Code wurde entfernt. Dieser Audit dokumentiert ausschließlich den Ist-Zustand und empfiehlt Deprecation-Marker.

---

## lib/safe-update.js (9 Exports)

| Export | Kategorie | Begründung |
|--------|-----------|------------|
| `safeUpdate` | **public/stable** | Importiert in `index.js` (Zeile 83) und dort aktiv verwendet |
| `validateUpdatePatch` | **internal** | Kein externer Import; wird intern von `safeUpdate` konsumiert |
| `computeIdempotencyKey` | **internal** | Kein externer Import; wird intern von `buildUpdateEntry` genutzt |
| `computeSemanticDrift` | **internal** | Kein externer Import; wird intern von `buildUpdateEntry` genutzt |
| `buildUpdateEntry` | **internal** | Kein externer Import; wird intern von `safeUpdate` aufgerufen |
| `buildSupersedePatch` | **internal** | Kein externer Import; wird intern von `safeUpdate` aufgerufen |
| `rewriteGraphEdges` | **internal** | Kein externer Import; wird intern von `safeUpdate` aufgerufen |
| `isIdempotent` | **internal** | Kein externer Import; wird intern von `safeUpdate` verwendet. *(Hinweis: `lib/fetch-with-timeout.js` deklariert eine lokale Variable gleichen Namens; es handelt sich nicht um einen Import.)* |
| `logReconsolidationEvent` | **internal** | Kein externer Import; wird intern von `safeUpdate` aufgerufen |

**Empfehlung:** Alle 8 `internal`-Exporte können mit `@deprecated` markiert und in eine Closure innerhalb von `safeUpdate` verschoben werden (kein Breaking Change für Consumer, da niemand sie importiert).

---

## lib/session-time.js (4 Exports)

| Export | Kategorie | Begründung |
|--------|-----------|------------|
| `recordActivity` | **public/stable** | Importiert in `index.js` (125) und `tests/reminder-integration.test.js` (5) |
| `formatTimeContext` | **public/stable** | Importiert in `index.js` (125) und `tests/reminder-integration.test.js` (5) |
| `getLastActivity` | **internal** | Kein externer Import; wird intern von `timeSinceLastActivity` genutzt |
| `timeSinceLastActivity` | **internal** | Kein externer Import; wird intern von `formatTimeContext` genutzt |

**Empfehlung:** `getLastActivity` und `timeSinceLastActivity` als `@deprecated` markieren; bei Bedarf in `formatTimeContext` inlinen.

---

## lib/runtime-scheduler.js (3 Exports)

| Export | Kategorie | Begründung |
|--------|-----------|------------|
| `isBackgroundTurn` | **public/stable** | Importiert in `index.js` (113); aktive Runtime-Abfrage |
| `createBackgroundMemoryScheduler` | **public/stable** | Importiert in `index.js` (113); wird in `index.js:1487` instanziiert |
| `normalizeRuntimeConfig` | **internal** | Kein externer Import; wird intern von `createBackgroundMemoryScheduler` konsumiert |

**Empfehlung:** `normalizeRuntimeConfig` als `@deprecated` markieren und in `createBackgroundMemoryScheduler` inlinen.

---

## lib/memory-dynamics.js (14 Exports)

| Export | Kategorie | Begründung |
|--------|-----------|------------|
| `applyDynamicsDefaults` | **public/stable** | Importiert in `index.js` (121) und mehreren Testdateien |
| `resolveHalfLifeDays` | **public/stable** | Importiert in `index.js` (121), `lib/safe-update.js` (7) und Tests |
| `createRetrievalLedgerEntry` | **public/stable** | Importiert in `index.js` (121) und dort mehrfach verwendet |
| `applyRetrievalReinforcement` | **public/stable** | Importiert in `lib/jobs/memory-dynamics-maintenance.js` (4) |
| `applyDailyDecay` | **public/stable** | Importiert in `lib/jobs/memory-dynamics-maintenance.js` (4) |
| `isCoreMemory` | **public/stable** | Importiert in `lib/jobs/memory-dynamics-maintenance.js` (4) |
| `computeDecayedStrength` | **internal/test-only** | Importiert ausschließlich in `tests/recall-p1.test.js`, `tests/smoke-helpers.test.js`, `tests/recall-e2e.test.js` |
| `computePromotionCandidate` | **internal/test-only** | Importiert ausschließlich in `tests/retrieval-reinforcement.test.js` |
| `computeFlashbulbScore` | **internal** | Kein externer Import; wird intern von `applyFlashbulbEncoding` genutzt |
| `applyFlashbulbEncoding` | **internal** | Kein externer Import; wird intern von `applyDynamicsDefaults` aufgerufen |
| `computeCoreMemoryScore` | **internal** | Kein externer Import; wird intern von `isCoreMemory` und `applyCoreMemoryEncoding` genutzt |
| `applyCoreMemoryEncoding` | **internal** | Kein externer Import; wird intern von `applyDynamicsDefaults` aufgerufen |
| `CORE_MEMORY_THRESHOLD` | **removable later** | Kein interner und kein externer Bezug |
| `CORE_MEMORY_HALF_LIFE_DAYS` | **removable later** | Kein interner und kein externer Bezug |

**Empfehlung:**
- `CORE_MEMORY_THRESHOLD` und `CORE_MEMORY_HALF_LIFE_DAYS` mit `@deprecated since P4 — unused constant` markieren.
- `computeDecayedStrength` und `computePromotionCandidate` mit `@deprecated — test-only, consider moving to test helpers` markieren.

---

## lib/memory-graph.js (13 Exports)

| Export | Kategorie | Begründung |
|--------|-----------|------------|
| `readGraph` | **public/stable** | Importiert in `index.js` (133) und `lib/recall-pipeline.js` (21) |
| `traverseGraph` | **public/stable** | Importiert in `lib/recall-pipeline.js` (21) |
| `mergeAssociativeResults` | **public/stable** | Importiert in `lib/recall-pipeline.js` (21) |
| `createGraphMetrics` | **public/stable** | Importiert in `index.js` (134) und `lib/recall-pipeline.js` (21) |
| `extractGraphSignals` | **public/stable** | Importiert in `index.js` (136) |
| `buildEdgesForSession` | **public/stable** | Importiert in `index.js` (131) |
| `buildEpisodeAnchorEdges` | **public/stable** | Importiert in `index.js` (132) |
| `writeGraphConstellationReport` | **public/stable** | Importiert in `index.js` (135) |
| `canonicalEdgeKey` | **internal** | Kein externer Import; wird intern von `createEdge` genutzt |
| `createEdge` | **internal** | Kein externer Import; wird intern von `buildEdgesForSession` und `buildEpisodeAnchorEdges` genutzt |
| `semanticStrength` | **internal** | Kein externer Import; wird intern von `buildEdgesForSession` genutzt |
| `temporalStrength` | **internal** | Kein externer Import; wird intern von `buildEdgesForSession` genutzt |
| `shouldPrune` | **internal** | Kein externer Import; wird intern von `compactGraph` genutzt |
| `compactGraph` | **internal** | Kein externer Import; wird intern von `buildEdgesForSession` genutzt |
| `DEFAULT_TRAVERSAL_CONFIG` | **removable later** | Kein interner und kein externer Bezug |

**Empfehlung:** `DEFAULT_TRAVERSAL_CONFIG` mit `@deprecated — unused` markieren. Die 6 `internal`-Funktionen können als `@deprecated` gekennzeichnet werden; sie bilden die Implementierungsschicht hinter den 8 public/stable-Exports.

---

## lib/neo-arch.js (33 Exports)

| Export | Kategorie | Begründung |
|--------|-----------|------------|
| `buildNeoWorkspaceAliases` | **public/stable** | Importiert in `index.js` (90) |
| `neoSessionKeysFromContext` | **public/stable** | Importiert in `index.js` (98) |
| `workspaceKeyFromContext` | **public/stable** | Importiert in `index.js` (102) |
| `migrateNeoWorkspaces` | **public/stable** | Importiert in `index.js` (97) |
| `escapeMemoryText` | **public/stable** | Importiert in `index.js` (93) und `tests/smoke-neo.test.js` |
| `sanitizeMemoryTextForPrompt` | **public/stable** | Importiert in `index.js` (100) |
| `isInjectedContextText` | **public/stable** | Importiert in `index.js` (96) und `tests/smoke-neo.test.js` |
| `turnEventsFromMessages` | **public/stable** | Importiert in `index.js` (103) |
| `transitionRecordStatus` | **public/stable** | Importiert in `index.js` (101) |
| `routeNeoRecall` | **public/stable** | Importiert in `index.js` (99) |
| `formatNeoRecallContext` | **public/stable** | Importiert in `index.js` (95) |
| `findLatestNeoRecord` | **public/stable** | Importiert in `index.js` (94) |
| `createNeoStore` | **public/stable** | Importiert in `index.js` (92) |
| `captureNeoFromAgentEnd` | **public/stable** | Importiert in `index.js` (91) |
| `buildNeoDoctorReport` | **public/stable** | Importiert in `index.js` (89) |
| `sanitizePathPart` | **internal/test-only** | Importiert nur in `tests/smoke-neo.test.js`; stark intern genutzt (22×) |
| `normalizeNeoScope` | **internal/test-only** | Importiert nur in `tests/smoke-neo.test.js` |
| `normalizeNeoStatus` | **internal/test-only** | Importiert nur in `tests/smoke-neo.test.js` |
| `NEO_JSONL_FILES` | **internal/test-only** | Importiert nur in `tests/smoke-neo.test.js` |
| `NEO_JSON_FILES` | **internal/test-only** | Importiert nur in `tests/smoke-neo.test.js` |
| `listNeoWorkspaceKeys` | **internal** | Kein externer Import; wird intern von `workspaceKeyFromContext` genutzt |
| `looksLikePromptInjection` | **internal** | Kein externer Import; wird intern von `sanitizeMemoryTextForPrompt` genutzt |
| `extractVisibleText` | **internal** | Kein externer Import; wird intern von `sanitizeMemoryTextForPrompt` genutzt |
| `categorizeNeoText` | **internal** | Kein externer Import; wird intern von `createTurnEvent` genutzt |
| `inferOriginKind` | **internal** | Kein externer Import; wird intern von `createOrigin` genutzt |
| `createOrigin` | **internal** | Kein externer Import; wird intern von `createTurnEvent` genutzt |
| `createTurnEvent` | **internal** | Kein externer Import; wird intern von `turnEventsFromMessages` genutzt |
| `memoryCandidatesFromTurns` | **internal** | Kein externer Import; wird intern von `captureNeoFromAgentEnd` genutzt |
| `reactionSignalsFromTurns` | **internal** | Kein externer Import; wird intern von `captureNeoFromAgentEnd` genutzt |
| `behaviorCardsFromReactions` | **internal** | Kein externer Import; wird intern von `captureNeoFromAgentEnd` genutzt |
| `scoreNeoRecallItem` | **internal** | Kein externer Import; wird intern von `routeNeoRecall` genutzt |
| `pruneNeoJsonlFile` | **internal** | Kein externer Import; wird intern von `createNeoStore` genutzt |
| `NEO_CATEGORIES` | **removable later** | Kein interner und kein externer Bezug |
| `NEO_ORIGIN_KINDS` | **removable later** | Kein interner und kein externer Bezug |
| `NEO_TRUST_LEVELS` | **removable later** | Kein interner und kein externer Bezug |
| `NEO_SCOPES` | **removable later** | Kein interner und kein externer Bezug |
| `NEO_STATUSES` | **removable later** | Kein interner und kein externer Bezug |
| `DEFAULT_NEO_WORKSPACE_MAPPINGS` | **removable later** | Kein interner und kein externer Bezug |
| `NEO_RECALL_LANES` | **removable later** | Kein interner und kein externer Bezug |

**Empfehlung:**
- Die 7 `removable later`-Konstanten mit `@deprecated since P4 — unused enumerations` markieren.
- Die 5 `internal/test-only`-Exporte mit `@deprecated — test-only` markieren; bei Major-Refactor in `tests/helpers/` verschieben.

---

## lib/obsidian-bridge.js (24 Exports)

| Export | Kategorie | Begründung |
|--------|-----------|------------|
| `createObsidianBridgeService` | **public/stable** | Importiert in `index.js` (42) |
| `discoverObsidianWorkspaces` | **public/stable** | Importiert in `lib/obsidian-control-room.js` (49) |
| `discoverLocalObsidianWorkspaceCandidates` | **public/stable** | Importiert in `lib/obsidian-control-room.js` (48) |
| `initWorkspace` | **public/stable** | Importiert in `lib/obsidian-control-room.js` (50) |
| `writeDiscoveredObsidianWorkspaces` | **public/stable** | Importiert in `lib/obsidian-control-room.js` (51) |
| `syncWorkspace` | **internal/test-only** | Importiert nur in `tests/smoke-obsidian-apply.test.js` |
| `bridgePaths` | **internal/test-only** | Importiert nur in `tests/smoke-obsidian-apply.test.js` |
| `isVaultPathConfirmed` | **internal/test-only** | Importiert nur in `tests/smoke-obsidian-apply.test.js` |
| `confirmVaultPath` | **internal/test-only** | Importiert nur in `tests/smoke-obsidian-apply.test.js` |
| `normalizeObsidianBridgeConfig` | **internal** | Kein externer Import; wird intern von `createObsidianBridgeService` u.a. genutzt |
| `mergeDiscoveredObsidianWorkspaces` | **internal** | Kein externer Import; wird intern von `writeDiscoveredObsidianWorkspaces` genutzt |
| `parseMarkdownFrontmatter` | **internal** | Kein externer Import; wird intern von `buildObsidianCandidate` genutzt |
| `formatMarkdownFrontmatter` | **internal** | Kein externer Import; wird intern von `writeBridgeState` genutzt |
| `stableContentHash` | **internal** | Kein externer Import; wird intern von `buildObsidianCandidate` genutzt |
| `buildObsidianSemanticPayload` | **internal** | Kein externer Import; wird intern von `buildObsidianCandidate` genutzt |
| `readBridgeState` | **internal** | Kein externer Import; wird intern von `syncWorkspace` genutzt |
| `writeBridgeState` | **internal** | Kein externer Import; wird intern von `syncWorkspace` genutzt |
| `validateBridgeCard` | **internal** | Kein externer Import; wird intern von `syncWorkspace` genutzt |
| `buildMemoryStorePayload` | **internal** | Kein externer Import; wird intern von `syncWorkspace` genutzt |
| `buildObsidianCandidate` | **internal** | Kein externer Import; wird intern von `scanWorkspace` genutzt |
| `scanWorkspace` | **internal** | Kein externer Import; wird intern von `syncWorkspace` genutzt |
| `doctorObsidianBridge` | **internal** | Kein externer Import; wird intern von `createObsidianBridgeService` genutzt |
| `watchObsidianBridge` | **internal** | Kein externer Import; wird intern von `createObsidianBridgeService` genutzt |
| `OBSIDIAN_BRIDGE_VERSION` | **removable later** | Kein interner und kein externer Bezug |
| `DEFAULT_OBSIDIAN_WORKSPACES` | **removable later** | Kein interner und kein externer Bezug |
| `DEFAULT_INCLUDE_GLOBS` | **removable later** | Kein interner und kein externer Bezug |
| `DEFAULT_IGNORE_GLOBS` | **removable later** | Kein interner und kein externer Bezug |
| `VAULT_DIRECTORIES` | **removable later** | Kein interner und kein externer Bezug |
| `OBSIDIAN_CARD_CATEGORIES` | **removable later** | Kein interner und kein externer Bezug |
| `OBSIDIAN_SCOPES` | **removable later** | Kein interner und kein externer Bezug |
| `STATE_REL_DIR` | **removable later** | Kein interner und kein externer Bezug |

**Empfehlung:**
- Die 8 `removable later`-Konstanten mit `@deprecated since P4 — unused` markieren.
- `syncWorkspace`, `bridgePaths`, `isVaultPathConfirmed`, `confirmVaultPath` mit `@deprecated — test-only surface` markieren.
- Die 13 `internal`-Helfer mit `@deprecated — internal helper, do not import` markieren.

---

## lib/obsidian-control-room.js (39 Exports)

| Export | Kategorie | Begründung |
|--------|-----------|------------|
| `handleObsidianBridgeCommand` | **public/stable** | Importiert in `index.js` (43); Haupt-Entrypoint für Obsidian-Befehle |
| `parseBridgeFrontmatter` | **internal** | Kein externer Import; wird intern von `runMaintenanceLight` und `prepareReviewBundle` genutzt |
| `normalizeObsidianControlRoomConfig` | **internal** | Kein externer Import; wird intern von fast allen Control-Room-Funktionen genutzt |
| `getObsidianCapabilityPack` | **internal** | Kein externer Import; wird intern von `normalizeObsidianControlRoomConfig` genutzt |
| `resolveObsidianBridgePaths` | **internal** | Kein externer Import; wird intern von fast allen Control-Room-Funktionen genutzt |
| `safeBridgePath` | **internal** | Kein externer Import; wird intern von `resolveObsidianBridgePaths` genutzt |
| `buildManagedBlock` | **internal** | Kein externer Import; wird intern von `replaceManagedBlock` genutzt. **Wichtig:** Es existiert eine identische Funktion in `lib/obsidian/managed-blocks.js`, die von `lib/obsidian/record-writer.js`, `lib/obsidian/project-hub-builder.js` und `lib/obsidian/dashboard-generator.js` importiert wird. Der Export hier ist ein Shadow-Duplikat. |
| `findManagedBlocks` | **internal** | Kein externer Import; wird intern von `replaceManagedBlock` und `writeManagedBlockFile` genutzt |
| `replaceManagedBlock` | **internal** | Kein externer Import; wird intern von `writeManagedBlockFile` genutzt. **Wichtig:** Es existiert eine identische Funktion in `lib/obsidian/managed-blocks.js` (s.o.). |
| `writeManagedBlockFile` | **internal** | Kein externer Import; wird intern von `runVaultDoctor` und `generateProjectHub` genutzt |
| `adversarialLightReviewItem` | **internal** | Kein externer Import; wird intern von `runMaintenanceLight` genutzt |
| `runMaintenanceLight` | **internal** | Kein externer Import; wird intern von `runMaintenanceDeep` und `runMorningReview` genutzt |
| `runMaintenanceDeep` | **internal** | Kein externer Import; wird intern von `runEveningDeepReview` genutzt. **Wichtig:** Es existiert eine eigene Implementierung in `lib/obsidian/maintenance-deep.js`, die hier als `runLivingMaintenanceDeep` importiert wird; dieser Export ist ein zusätzlicher Wrapper. |
| `prepareReviewBundle` | **internal** | Kein externer Import; wird intern von `runMorningReview` und `runEveningDeepReview` genutzt |
| `runMorningReview` | **internal** | Kein externer Import; wird intern von `buildWorkspaceReviewCronJobs` genutzt |
| `runEveningDeepReview` | **internal** | Kein externer Import; wird intern von `buildWorkspaceReviewCronJobs` genutzt |
| `updateReviewBundleItems` | **internal** | Kein externer Import; wird intern von `handleObsidianBridgeCommand` genutzt |
| `applyApprovedReviewBundle` | **internal** | Kein externer Import; wird intern von `handleObsidianBridgeCommand` genutzt |
| `expireStaleBundles` | **internal** | Kein externer Import; wird intern von `runMaintenanceLight` genutzt |
| `generateMemoryCardTemplate` | **internal** | Kein externer Import; wird intern von `runVaultDoctor` genutzt |
| `runVaultDoctor` | **internal** | Kein externer Import; wird intern von `handleObsidianBridgeCommand` genutzt |
| `generateProjectHub` | **internal** | Kein externer Import; wird intern von `handleObsidianBridgeCommand` genutzt |
| `generateConflictReport` | **internal** | Kein externer Import; wird intern von `handleObsidianBridgeCommand` genutzt. **Wichtig:** Es existiert eine eigene Implementierung in `lib/obsidian/conflict-report.js`, die hier als `generateLivingConflictReport` importiert wird; dieser Export ist eine separate lokale Implementierung. |
| `writeMemoryExplanation` | **internal** | Kein externer Import; wird intern von `handleObsidianBridgeCommand` genutzt |
| `writeTaskSuggestions` | **internal** | Kein externer Import; wird intern von `handleObsidianBridgeCommand` genutzt |
| `printMorningReviewCronCommand` | **internal** | Kein externer Import; wird intern von `buildWorkspaceReviewCronJobs` genutzt |
| `buildWorkspaceReviewCronJobs` | **internal** | Kein externer Import; wird intern von `handleObsidianBridgeCommand` genutzt |
| `reviewBundleSummary` | **internal** | Kein externer Import; wird intern von `prepareReviewBundle` und `applyApprovedReviewBundle` genutzt |
| `eveningReviewSummary` | **internal** | Kein externer Import; wird intern von `runEveningDeepReview` genutzt |
| `quickapplySummary` | **internal** | Kein externer Import; wird intern von `applyApprovedReviewBundle` genutzt |
| `cleanupTempFile` | **internal** | Kein externer Import; wird intern von `prepareReviewBundle` genutzt |
| `OBSIDIAN_CONTROL_ROOM_VERSION` | **removable later** | Kein interner und kein externer Bezug |
| `REVIEW_BUNDLE_SCHEMA_VERSION` | **removable later** | Kein interner und kein externer Bezug |
| `DEFAULT_REVIEW_ROOT` | **removable later** | Kein interner und kein externer Bezug |
| `DEFAULT_MORNING_CRON` | **removable later** | Kein interner und kein externer Bezug |
| `DEFAULT_EVENING_CRRON` | **removable later** | Kein interner und kein externer Bezug |
| `DEFAULT_MORNING_TZ` | **removable later** | Kein interner und kein externer Bezug |
| `OPENCLAW_COMMAND_SURFACE_NOTICE` | **removable later** | Kein interner und kein externer Bezug |
| `REVIEW_PROFILES` | **removable later** | Kein interner und kein externer Bezug |
| `OBSIDIAN_CAPABILITIES` | **removable later** | Kein interner und kein externer Bezug |

**Empfehlung:**
- Die 9 `removable later`-Konstanten mit `@deprecated since P4 — unused constants` markieren.
- `buildManagedBlock` und `replaceManagedBlock` dringend mit `@deprecated — duplicate of lib/obsidian/managed-blocks.js` markieren und in P5 durch Import aus dem Submodul ersetzen.
- `runMaintenanceDeep` und `generateConflictReport` mit `@deprecated — local wrapper/duplicate, use lib/obsidian/maintenance-deep.js or lib/obsidian/conflict-report.js directly` markieren.
- Alle übrigen 28 `internal`-Exporte mit `@deprecated — internal helper, not part of public API` markieren.

---

## Cross-Cutting Issues

1. **Shadow-Duplikate in `obsidian-control-room.js`**
   - `buildManagedBlock` / `replaceManagedBlock` duplizieren `lib/obsidian/managed-blocks.js`.
   - `runMaintenanceDeep` ist ein Wrapper neben `lib/obsidian/maintenance-deep.js`.
   - `generateConflictReport` ist eine parallele Implementierung neben `lib/obsidian/conflict-report.js`.
   - Diese Kollisionen erhöhen die Wartungslast und sollten in P5 aufgelöst werden.

2. **Test-only Surface**
   - 11 Exporte werden ausschließlich von Tests konsumiert. Sie sollten entweder nach `tests/helpers/` migriert oder mit `@deprecated — test-only` markiert werden, um zukünftige Breaking Changes anzukündigen.

3. **Tote Konstanten**
   - 22 Konstanten/Enumerationen haben keinerlei interne oder externe Verwendung. Sie können sofort mit `@deprecated` markiert werden; eine Entfernung in P5 ist risikofrei.

---

## Deprecation-Markierungs-Vorlage

Für Funktionen:
```js
/** @deprecated since P4 — internal helper, not part of public API; will be removed in P5 */
export function foo() { ... }
```

Für Konstanten:
```js
/** @deprecated since P4 — unused constant; will be removed in P5 */
export const FOO = ...;
```

Für Test-only-Exports:
```js
/** @deprecated since P4 — test-only surface; migrate to tests/helpers/ in P5 */
export function foo() { ... }
```

---

## Statistik pro Datei

| Datei | public/stable | internal/test-only | internal | removable later | Gesamt |
|-------|---------------|-------------------|----------|-----------------|--------|
| `lib/safe-update.js` | 1 | 0 | 8 | 0 | 9 |
| `lib/session-time.js` | 2 | 0 | 2 | 0 | 4 |
| `lib/runtime-scheduler.js` | 2 | 0 | 1 | 0 | 3 |
| `lib/memory-dynamics.js` | 6 | 2 | 4 | 2 | 14 |
| `lib/memory-graph.js` | 8 | 0 | 6 | 1 | 15 |
| `lib/neo-arch.js` | 15 | 5 | 12 | 7 | 39 |
| `lib/obsidian-bridge.js` | 5 | 4 | 13 | 8 | 30 |
| `lib/obsidian-control-room.js` | 1 | 0 | 29 | 9 | 39 |
| **Gesamt** | **40** | **11** | **75** | **27** | **153** |

*Anmerkung: Die Gesamtzahl der Exports in der Tabelle (153) übersteigt die im Einleitungstext genannte Zahl (60+ Over-Exports), weil der Audit **alle** Exports der 8 Dateien erfasst hat, nicht nur die überflüssigen. Die 60+ Over-Exports entsprechen der Summe aus `internal/test-only` + `internal` + `removable later` = 113 Stück. Die tatsächlich sicher entfernbaren (`removable later`) sind 27; die übrigen 86 sind zumindest intern oder testseitig noch gebunden.*
