# P3 Release-Härtung: Dead Code / Redundancy Audit

**Datum:** 2026-06-07  
**Umfang:** `index.js`, `lib/**/*.js` (ohne `tests/`, `scripts/`)  
**Methode:** Statische Analyse (Export-Import-Matching, Funktionsaufruf-Tracking, Body-Deduplizierung, Keyword-Suche nach legacy/fallback/deprecated)

---

## Executive Summary

Das Codebase hat ca. 15 k LoC produktiven JS-Code. Die Analyse identifiziert:

- **1 totes Modul** (133 LoC) – nie importiert
- **8 tote interne Funktionen** – nicht exportiert, nirgends aufgerufen
- **>60 exportierte Symbole** – nie außerhalb ihrer Datei importiert (verdächtig / über-exportiert)
- **13 Redundanz-/Duplikat-Fälle** – identische oder quasi-identische Funktionskörper
- **7 Legacy-/Fallback-Pfade** – teilweise dokumentiert als veraltet, teilweise aktiv aber unklar ob noch benötigt

Kein großflächig auskommentierter Code (>20 Zeilen) gefunden.

---

## 1. Tote Module (P0)

| Datei | Zeilen | Begründung | Maßnahme |
|-------|--------|------------|----------|
| `lib/memory-card-writer.js` | 133 | Exportiert 4 Symbole (`polishContent`, `slugifyTitle`, `buildCardMarkdown`, `writeCard`). **Nirgends importiert.** Kommentar erwähnt "Production-Wiring (Phase 5)", aber es gibt keinen Consumer. | **Entfernen** oder in aktiven Pfad (Obsidian-Card-Write) re-integrieren. |

---

## 2. Tote Funktionen (nicht exportiert, nie aufgerufen)

| Datei | Funktion | Zeile | Begründung | Priorität |
|-------|----------|-------|------------|-----------|
| `index.js` | `updateKnowledgeMd` | ~1371 | `async function` definiert, aber **kein einziger Aufruf** im gesamten Source-Tree. | P0 |
| `lib/obsidian-control-room.js` | `compactPathList` | 2340 | Nicht exportiert, kein Aufruf. | P1 |
| `lib/obsidian-control-room.js` | `telegramBucketLines` | 2498 | Nicht exportiert, kein Aufruf. | P1 |
| `lib/obsidian-control-room.js` | `statusMarker` | 2575 | Nicht exportiert, kein Aufruf. | P1 |
| `lib/obsidian-control-room.js` | `reviewStatus` | 2582 | Nicht exportiert, kein Aufruf. | P1 |
| `lib/obsidian-control-room.js` | `reviewCommands` | 2700 | Nicht exportiert, kein Aufruf. | P1 |
| `lib/obsidian-control-room.js` | `reviewItemBuckets` | 2785 | Nicht exportiert, kein Aufruf. | P1 |
| `lib/embedding-cache.js` | `normalizeQuery` | 12 | Nicht exportiert, kein Aufruf. | P1 |

---

## 3. Exportierte Symbole, die nie importiert werden (verdächtig / über-exportiert)

Diese Symbole sind `export`-deklariert, kommen aber in keiner anderen Datei als Import oder Referenz vor. Teilweise sind sie interne Helfer, die aus Test-Gründen exportiert werden; teilweise sind sie echte Kandidaten für Dead-Code-Entfernung.

### 3a. Klar redundant (interne Helfer, die nicht nach außen müssen)

| Datei | Symbol(e) | Status | Begründung |
|-------|-----------|--------|------------|
| `lib/safe-update.js` | `validateUpdatePatch`, `computeIdempotencyKey`, `computeSemanticDrift`, `buildUpdateEntry`, `buildSupersedePatch`, `rewriteGraphEdges`, `logReconsolidationEvent` | verdächtig | Nur `safeUpdate` wird aus `index.js` importiert. Die restlichen 7 Exporte sind interne Helfer, die nicht nach außen exponiert werden müssen. |
| `lib/session-time.js` | `getLastActivity`, `timeSinceLastActivity` | verdächtig | Nur `recordActivity` und `formatTimeContext` werden aus `index.js` konsumiert. |
| `lib/runtime-scheduler.js` | `normalizeRuntimeConfig` | verdächtig | Nur `createBackgroundMemoryScheduler` und `isBackgroundTurn` werden konsumiert. |
| `lib/install/soul-patcher.js` | `SOUL_BLOCK_ID`, `soulRuntimeRules` | verdächtig | Werden nur lokal von `patchSoulMd` verwendet, das einzige extern konsumierte Symbol. |
| `lib/critical-push-state.js` | `saveCounts`, `cleanupOldCounts` | verdächtig | Werden nur intern verwendet, nie importiert. |
| `lib/db-adapter.js` | `computeCutoff` | verdächtig | Niemand importiert diesen Export. |
| `lib/filter-parser.js` | `suggestValidValues` | verdächtig | Niemand importiert diesen Export. |
| `lib/input-limits.js` | `validateCorrectionText`, `validateTopicQuery`, `validateAgentId`, `validateChatId`, `validateUserId` | verdächtig | Niemand importiert diese 5 Validatoren. |
| `lib/memory-dynamics.js` | `CORE_MEMORY_THRESHOLD`, `CORE_MEMORY_HALF_LIFE_DAYS`, `computeFlashbulbScore`, `applyFlashbulbEncoding`, `computeCoreMemoryScore`, `applyCoreMemoryEncoding` | verdächtig | Niemand importiert diese Konstanten/Funktionen. |
| `lib/memory-graph.js` | `canonicalEdgeKey`, `createEdge`, `semanticStrength`, `temporalStrength`, `DEFAULT_TRAVERSAL_CONFIG`, `shouldPrune`, `compactGraph` | verdächtig | Niemand importiert diese Low-Level-Graph-Helfer. |

### 3b. Modul-übergreifend verdächtig (viele ungenutzte Exporte)

| Datei | Anzahl ungenutzter Exporte | Begründung |
|-------|---------------------------|------------|
| `lib/neo-arch.js` | ~25+ | Enorme Datei (1.294 LoC). Viele Exporte (`listNeoWorkspaceKeys`, `looksLikePromptInjection`, `extractVisibleText`, `categorizeNeoText`, `inferOriginKind`, `createOrigin`, `createTurnEvent`, `memoryCandidatesFromTurns`, `reactionSignalsFromTurns`, `behaviorCardsFromReactions`, `scoreNeoRecallItem`, `pruneNeoJsonlFile`, …) werden nie importiert. Das Modul scheint eine "neue" Architektur zu beschreiben, von der nur ein Bruchteil aktiv genutzt wird. |
| `lib/obsidian-bridge.js` | ~25+ | Viele Exporte (`OBSIDIAN_BRIDGE_VERSION`, `DEFAULT_OBSIDIAN_WORKSPACES`, `normalizeObsidianBridgeConfig`, `parseMarkdownFrontmatter`, `formatMarkdownFrontmatter`, `stableContentHash`, `buildObsidianSemanticPayload`, `scanWorkspace`, `initWorkspace`, `syncWorkspace`, `doctorObsidianBridge`, `watchObsidianBridge`, …) werden nie importiert. Könnte öffentliche API sein, sollte aber dokumentiert werden. |
| `lib/obsidian-control-room.js` | ~30+ | Fast alle Exporte werden nie importiert. Die Datei ist 3.502 LoC groß und scheint primär als **eigenständiger Command-Router** zu fungieren, der dynamisch geladen wird oder über `handleObsidianBridgeCommand` indirekt konsumiert wird. Die Exporte sind möglicherweise beabsichtigt, sollten aber auf echte Nutzung geprüft werden. |
| `lib/dreaming/light-dream.js` | 4 | `extractKeyInsights`, `findActivatedMemories`, `strengthenMemory`, `inferBehaviorPatternsFromDream` werden nur intern von `lightDream` aufgerufen, nie extern importiert. |
| `lib/dreaming/rem-dream.js` | 10+ | `getPreviousWeekWindow`, `loadCandidateMemories`, `buildSparseNeighborGraph`, `findConnectedComponents`, `validateClusters`, `sampleRepresentativeMemories`, `summarizeClusterWithLlm`, `computePatternKey`, `findBestPatternMatch`, `analyzeTrends` – alles interne Helfer, die nicht exportiert werden müssen. |
| `lib/episodes.js` | 5 | `groupTurnsIntoEpisodes`, `calculateVividness`, `createEpisode`, `enrichEpisodeNarratively`, `recallEpisodically` – interne Helfer, die nicht exportiert werden müssen. |

---

## 4. Duplizierte Logik (Redundanz)

| Funktion / Logik | Vorkommen | Begründung | Empfohlene Maßnahme |
|------------------|-----------|------------|---------------------|
| `readJson(path, fallback)` | `lib/atomic-json.js` (intern), `lib/obsidian-bridge.js`, `lib/obsidian-control-room.js`, `lib/jobs/schicht15-tracker.js`, `lib/neo-arch.js` | Identisches Muster: `existsSync ? JSON.parse(readFileSync) : fallback`. Es gibt kein Shared-Utility dafür (außer `atomic-json.js`, das nur `atomicJsonUpdate` exportiert). | Zentral in `lib/atomic-json.js` oder neues `lib/json-utils.js` bereitstellen. |
| `workspaceEntryId(entry, fallback)` | `lib/obsidian-bridge.js`, `lib/obsidian-control-room.js`, `lib/obsidian/safe-paths.js` | Fast identische Implementierungen mit leicht unterschiedlichen Default-Werten. | Einheitlich nach `lib/obsidian/safe-paths.js` migrieren; andere Dateien importieren. |
| `workspaceEntryAgent(entry, fallback)` | `lib/obsidian-bridge.js`, `lib/obsidian-control-room.js`, `lib/obsidian/safe-paths.js` | Dito. | Zentralisieren. |
| `safeSlug(value, fallback)` | `lib/obsidian-control-room.js`, `lib/obsidian/safe-paths.js` | Identischer Körper. | `safe-paths.js` ist die kanonische Quelle; Control-Room sollte importieren. |
| `ensureDir(dir)` | `lib/obsidian-bridge.js`, `lib/obsidian-control-room.js`, `lib/obsidian/safe-paths.js` | Identisch `mkdirSync(dir, {recursive:true})`. | Zentralisieren. |
| `parseYamlScalar / parseScalar` | `lib/obsidian/frontmatter.js`, `lib/obsidian-bridge.js`, `lib/obsidian-control-room.js` | Fast identische YAML-Scalar-Parsing-Logik. | `lib/obsidian/frontmatter.js` als kanonische Quelle nutzen. |
| `parseFrontmatter / parseBridgeFrontmatter` | `lib/obsidian/frontmatter.js`, `lib/obsidian-bridge.js`, `lib/obsidian-control-room.js` | Fast identisches Frontmatter-Parsing. | `lib/obsidian/frontmatter.js` nutzen. |
| `sha256Hex` | `lib/obsidian/managed-blocks.js`, `lib/obsidian-control-room.js` | Identische SHA-256-Hex-Implementierung. | `managed-blocks.js` exportiert bereits; Control-Room sollte importieren statt duplizieren. |
| `stableJson` | `lib/obsidian-bridge.js`, `lib/obsidian-control-room.js` | Identisch `JSON.stringify(obj, Object.keys(obj).sort())`. | Zentralisieren. |
| `firstSourceQuote` | `lib/obsidian-bridge.js`, `lib/obsidian-control-room.js` | Identische Logik. | Zentralisieren. |
| `vectorFromOutput` | `lib/providers/embedding-local-transformers.js`, `lib/providers/openclaw-memory-embedding-adapters.js` | Fast identischer Vektor-Extraction-Code. | In `lib/providers/dimensions.js` oder Shared-Provider-Utility auslagern. |
| `resolveOpenClawConfigPath` | `lib/telegram-commands/feature-toggle.js`, `lib/telegram-commands/status-data.js` | Identischer Pfad-Resolver. | In Shared-Utility (z.B. `lib/telegram-commands/_utils.js`) auslagern. |
| `clamp01(x)` | `lib/emotion.js`, `lib/emotional-state.js`, `lib/memory-graph.js`, `lib/neo-arch.js` | 4x die gleiche 1-Zeiler-Funktion. | In `lib/text-utils.js` oder Shared-Math-Utility zentralisieren. |
| `_flushGraphRecallMetrics` ↔ `recordObsidianSyncMetrics` | `lib/metrics.js` (Zeilen 17 und 56) | Quasi-identischer Körper (nur Key-Name und Zielstruktur unterscheiden sich). | Generischen `_flushMetrics(workspaceDir, key, metrics)`-Helper extrahieren. |
| `getISOWeek` | `lib/dreaming/rem-dream.js`, `lib/jobs/consolidation-report.js` | Identische ISO-Week-Implementierung. | Zentralisieren. |

---

## 5. Legacy-Fallbacks & Veraltete Pfade

| Datei | Fundstelle | Status | Begründung | Empfohlene Maßnahme |
|-------|------------|--------|------------|---------------------|
| `lib/providers/dimensions.js` | `LEGACY_DEFAULT_MODEL = "text-embedding-3-small"` | redundant | Wird in `index.js` als `DEFAULT_MODEL` verwendet. Der Kommentar "Legacy" suggeriert, dass ein neuerer Default existiert (z.B. `text-embedding-3-large`). | Auf aktuelles Default-Model umstellen oder Konstante umbenennen. |
| `lib/providers/env.js` | `LEGACY_OPENAI_PATH = join(__providerDir, "../../../memory-lancedb-stock/node_modules/openai/index.js")` | verdächtig | Versucht einen alten `node_modules`-Pfad zu importieren. Nur als Fallback für "alte lokale Repo-Setups". | Prüfen, ob dieser Pfad in aktuellen Setups noch existiert. Wenn nicht → entfernen. |
| `index.js` | Zeile 165: `// Legacy Reranker — Cohere Rerank API v2 (kept for old local test imports)` | redundant | Codeblock ist aktiv, aber explizit als Legacy markiert. | In Test-Helpers verschieben oder hinter Feature-Flag verstecken. |
| `index.js` | Zeile 14-15: "Cron-Fallback via scripts/auto-capture-lancedb.mjs bei Hook-Blockade" | verdächtig | Dokumentiert ein Fallback für alte OpenClaw-Builds. Der Cron-Script existiert, aber es ist unklar, ob er in aktuellen Deployments noch läuft. | Dokumentieren, ob der Fallback für P3 noch unterstützt werden muss. |
| `lib/obsidian/managed-blocks.js` | `legacyTrailingNewline` (Zeile 39) | verdächtig | Prüft einen alten SHA-256-Hash mit Trailing-Newline. Falls der neue Hash fehlschlägt, wird der Legacy-Hash akzeptiert. | Nach einer Übergangsfrist (z.B. 90 Tage nach P3-Release) entfernen. |
| `lib/obsidian-control-room.js` | `legacyHygieneItems` / `legacyHygiene` (Zeile 2874, 2944) | redundant | Mergt `items.filter(i => i.type === "vault_hygiene")` in die neue `hygieneItems`-Struktur. Kommentar sagt "legacy items array and the new hygieneItems array". | Sobald alle Workspaces migriert sind, die Legacy-Filters entfernen. |
| `lib/obsidian-bridge.js` | `legacyKeys`, `legacy_obsidian`, `backup_legacy_obsidian` | verdächtig | Mehrere Legacy-Key-Aliase und Backup-Logik für alte `.obsidian`-Verzeichnisse. | Auditieren, ob die Migration abgeschlossen ist. Wenn ja, `legacyKeys`-Handling vereinfachen. |
| `lib/install/soul-patcher.js` | `migrateLegacy` / `legacy heading detected` | verdächtig | Migration von alten "PLUR1BUS Memory Runtime Rules"-Blöcken. | Nach vollständiger Migration aller User-Vaults entfernen. |

---

## 6. Kommentierter Code

- **Keine signifikanten auskommentierten Code-Blöcke** gefunden (>20 Zeilen).
- Nur 2 einzelne Zeilen mit auskommentierten `const`/`function`-Deklarationen (kein Handlungsbedarf).

---

## 7. Empfohlene Maßnahmen & Priorisierung

### P0 – Sofort (vor P3-Release)

1. **`lib/memory-card-writer.js` entfernen oder reaktivieren**  
   133 LoC toter Code. Falls die Funktionalität für P3 geplant ist, muss ein Consumer geschrieben werden; andernfalls löschen, um Wartungslast zu vermeiden.

2. **`updateKnowledgeMd` in `index.js` prüfen**  
   Große `async function` (~Zeile 1371), die nirgends aufgerufen wird. Möglicherweise ein Relikt aus einem Refactoring. Entweder wieder anschließen oder entfernen.

3. **Duplikate `readJson` / `workspaceEntryId` / `safeSlug` zentralisieren**  
   Hohe Wartungslast durch Copy-Paste. Mindestens ein Shared-Utility (`lib/atomic-json.js` erweitern oder `lib/obsidian/safe-paths.js` als Single Source of Truth etablieren).

### P1 – Next Sprint

4. **6 tote Hilfsfunktionen in `lib/obsidian-control-room.js` entfernen**  
   `compactPathList`, `telegramBucketLines`, `statusMarker`, `reviewStatus`, `reviewCommands`, `reviewItemBuckets`.

5. **`normalizeQuery` in `lib/embedding-cache.js` entfernen**  
   Nicht exportiert, nie aufgerufen.

6. **Over-Exported-APIs bereinigen**  
   `lib/safe-update.js`, `lib/session-time.js`, `lib/runtime-scheduler.js`, `lib/memory-dynamics.js`, `lib/memory-graph.js`: Nicht-exportierte interne Helfer wieder auf `function`/`const` (ohne `export`) reduzieren. Das verhindert, dass externe Module versehentlich interne APIs nutzen.

7. **Legacy-Fallbacks auditieren**  
   - `LEGACY_OPENAI_PATH` in `lib/providers/env.js`: Existiert der Pfad noch?
   - `legacyTrailingNewline` in `lib/obsidian/managed-blocks.js`: Kann nach P3 weg?
   - `legacyHygieneItems` in `lib/obsidian-control-room.js`: Sind alle Workspaces migriert?

8. **`_flushGraphRecallMetrics` / `recordObsidianSyncMetrics` in `lib/metrics.js` deduplizieren**  
   Generischen Helper extrahieren.

### P2 – Nice to have

9. **`lib/neo-arch.js` aufräumen**  
   1.294 LoC, davon ~25+ Exporte ungenutzt. Entweder aufsplitten (nur aktive Funktionen behalten) oder ungenutzte Exporte entfernen.

10. **`lib/obsidian-bridge.js` und `lib/obsidian-control-room.js` auf echte API-Nutzung prüfen**  
    Viele Exporte könnten beabsichtigte öffentliche API sein. Falls ja, dokumentieren; falls nein, bereinigen.

11. **`clamp01`, `getISOWeek`, `stableJson`, `firstSourceQuote`, `vectorFromOutput`, `resolveOpenClawConfigPath` zentralisieren**  
    Kleinere Duplikate, die über Zeit zu Inkonsistenzen führen können.

12. **Legacy-Reranker (Cohere API v2) aus `index.js` in Test-Helpers verschieben**  
    Reduziert Bundle-Size und Startup-Komplexität.

---

## Anhang: Audit-Metadaten

- **Tooling:** Node.js-Skripte (Regex-basierte Export/Import-Matching, Body-Deduplizierung, Keyword-Suche)
- **Einschränkungen:** Dynamische Imports (`await import(...)`) und `import * as ns` werden teilweise nicht als explizite Verwendung gezählt. Einzelne Funde wurden manuell verifiziert.
- **Keine Code-Änderungen** durchgeführt (nur Read-Analyse).
