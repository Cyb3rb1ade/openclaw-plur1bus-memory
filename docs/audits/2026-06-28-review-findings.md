# PLUR1BUS Memory — Bug- & Security-Review, 2026-06-28 (v6.8.9)

Scope: `index.js`, `lib/**`, `scripts/**` (Tests/Docs aus).
Methode: Semgrep (360 Regeln) + manuelle Layer-Review (Security/Concurrency/Config
vollständig) + 2 Wellen à 6/5 parallele read-only Subagent-Reviews über 12
Modul-Domänen. Alle HIGH unabhängig am Code verifiziert. Kein Line-by-Line-Audit
der 87k LOC; verbleibend nur triviale Hilfsmodule (i18n-dictionary etc.).

---

## BEHOBEN (committet 9e91a38b1, Release 6.8.9)
- Off-Switch emotion.t2/t3 + metaCognition (feature-profiles.js) — overwrite:false.
- Config-Parse-Fehlermeldung (obsidian-bridge.js:658).
- 4 rote Tests aus v6.8.8 isoliert + Regressionstests.

---

## SYSTEMISCHES MUSTER: "destruktiv vor durabel" (Datenverlust) — 3 Stellen
Alle markieren/löschen das Alte, BEVOR das Neue durabel ist. Crash/Timeout
dazwischen = unwiederbringlicher Verlust. Korrekte Reihenfolge überall:
erst neu schreiben, dann alt superseden/löschen.
- **H5** `safe-update.js:333` update(superseded) vor `db.store(newEntry)`:336. CONFIRMED.
- **H5b** `db-adapter.js:511` mark superseded vor `table.add(newVersion)`:540. CONFIRMED.
  Verschärft: `withTimeout` cancelt die LanceDB-Promise nicht → getimeoutetes
  supersede committet evtl. nachträglich.
- **H7** `light-dream.js:142` `db.table.delete(id)` vor `add([updated])` (Fallback
  ohne update()). SUSPECTED.

---

## HIGH — verifiziert

### H2 — neo-arch UTF-8-Korruption beim JSONL-Cap  [DATENKORRUPTION]
`readJsonlTailLines` (neo-arch.js:1364) dekodiert 64KB-Chunks ohne Byte-Carry →
ä/ö/ü/ß/Emoji an Chunk-Grenzen → U+FFFD; `capJsonl` schreibt es zurück. Im dt.
Store bei jedem Cap (>2MB) garantiert. CONFIRMED.

### H3 — GC archiviert neverForget/core-Memories  [DATENVERLUST-VERTRAG]
`buildActiveScanQuery().select()` (index.js:1041) + `normalizeActiveScanRow`
(1024) projizieren weder neverForget noch memoryClass; `selectCandidatesForGc`
(garbage-collector.js) hat keinen Schutz-Guard. Geschützte (auch kritische)
Memories archivierbar. CONFIRMED. Verwandt MEDIUM: `purgeExpired()` hard-delete
ohne neverForget-Guard.

### H4 — obsidian-bridge False Tombstones (Apply-Mode)  [DATENINTEGRITÄT]
scanWorkspace-Fastpath (1110) lässt unveränderte Dateien aus scan.files; `seen`
(1269) nur daraus; Tombstone-Loop (1472) behandelt Rest als gelöscht. Ab 2. Sync
in dryRun:false. Mit applyApproved=all: aktives Tombstoning lebender Dateien.
CONFIRMED.

### H5 / H5b — supersede-before-store Datenverlust  → siehe Muster oben. CONFIRMED.

### H6 — Emotion NaN→0 bei Alltagswörtern  [SIGNALVERLUST]
tier1-lexicon.js:342: Nuance-Labels (love/grateful/proud/relieved/curious/…) haben
keinen EMOTION_VAD-Eintrag → vad.v=NaN → intensity=NaN; `_validate` fängt NaN nicht
(NaN<-1 false). emotion.js klemmt zu 0. Empirisch reproduziert: "I love this
project"/"I am so grateful"/"I am proud" → intensity=0. CONFIRMED.

### H1 — CRR umgeht ACL  → HERABGESTUFT auf Defense-in-Depth
conversation-reactivation-recall.js ruft kein ACL. ABER: getById nutzt
`pool.getDb(agentId)` = dateisystem-isolierte DB `<ns>/<agentId>` (index.js:1117,
verifiziert), Lens ist workspaceDir-scoped, und jeder Agent hat eigenen Workspace.
→ beide Vektoren lesen nur Eigen-Daten des Agenten. Realer Cross-Agent-Leak nur
bei GETEILTEM Workspace (hat der User nicht). Echter Rest-Bug: fehlender
status-Filter (superseded/getombstonte Memories reaktivierbar) — MEDIUM,
architektur-unabhängig.

---

## MEDIUM (Subagent-Funde; HIGH selbst verifiziert, MEDIUM stichprobenartig)

**ACL / Scope (Defense-in-Depth, durch per-Agent-Namespacing entschärft):**
- `enforceDefaultScope`/acl-middleware in index.js **nie importiert** → toter Code.
  Inline-Default zwingt fehlenden Scope auf agent-private (deckt Hauptfall). Rest:
  Agent kann explizit scope:"user" auf kritische Memory setzen — nichts erzwingt
  agent-private für kritische Typen.
- `telegram-commands/memory-edit.js` importiert checkAccess, ruft es nie — delete/
  correct/share ohne ctx. Entschärft durch per-Agent-Tabellen + Bot-Auth.

**Datenintegrität / Korrektheit:**
- `memory_store`-Tool (index.js:4350) überspringt validateMemoryText (LLM-Pfad);
  Zwilling storeMemoryFromToolParams hat den P0-Fix. Zwei divergente Kopien.
- remote-embedding-Bridge (openclaw-memory-embedding-adapters.js:96) validiert
  Vektor-Dimension nicht → wrong-dim korrumpiert Suche.
- neo-arch record-index.json wächst unbounded, nie reconciled → O(n²) + RAM
  (= Incident 2026-05-29).
- neo-arch cap Read-Modify-Write verliert konkurrente Zeilen.
- memory-dynamics-maintenance: Watermark friert bei Teilfehler → Over-
  Reinforcement; `applyDailyDecayToAll` decayt nur erste 500 (keine Pagination).
- obsidian-bridge: permanente Suspension nach 5 Fehlern (Recovery defekt);
  rebuildDashboards ohne Reentrancy-Guard; `return` in finally verschluckt Fehler.
- obsidian-control-room Bundle-JSON Read-Modify-Write-Race → Status-Verlust.
- memory-graph extractGraphSignals deref auf rohem text (null→TypeError) + Dead Code.
- contradiction-detector unbounded O(n²) LLM-Calls (kein maxPairs).
- tier3-llm.js:131 out-of-range LLM-Werte (valence:1.5) werfen an tier1-Fallback
  vorbei (EmotionScore-Konstruktion außerhalb try/catch).
- episodes.js MAX_EPISODE_TURNS definiert, nie erzwungen → unbounded Episode/Prompt.
- light-dream prompt-injection-into-memory (kein Isolations-Guard wie rem-dream:325).
- embedding-cache Size-Accounting unter WAL kaputt (persist=true): kann zu
  voll-aber-leer-Datei werden, die alle Writes ablehnt.

**Timeout (User-relevant wg. Cooldown-Sensitivität):**
- reranker-cohere.js:19 ignoriert configured timeoutMs, hardcoded 30s.
- callLlm (index.js:1522) ohne internen Timeout (nur merge-check race-gewrappt).

## LOW (Auswahl)
graph-link-writer Display-Titel unescaped (| / ]] / end-marker → kaputter/
un-updatebarer Block); ein bad note bricht writeGraphLinks-Batch ab; fd-Leaks in
3 Lock-Writes; atomic-json verwaiste .tmp; sqlite-Handles nie geschlossen (persist);
batch-timeout-Mismatch (60s vs 120s); rohe err.message an Telegram-User; rem-dream
confidence:0→0.3; memory-dynamics NaN bei nicht-num. halfLifeDays; runtime-
scheduler recallCache nicht per-Agent genamespaced (SUSPECTED, Caller out-of-scope);
safe-update kein optimistic-lock; memory-fact-quality ReDoS-Verdacht.

---

## POSITIV VERIFIZIERT (keine Findings)
- SQL-Injection: keine — alle .where/.delete/.update via sql-safety
  (safeUuid/sqlString/safeTimestamp/escapeSqlString, Spalten-Whitelist).
- Command-Injection: spawnSync nur statische Array-Args. Kein eval/dyn require.
- Crypto: nur node:crypto, kein CryptoJS.
- Concurrency-Primitive + neo-worker-runtime lifecycle korrekt (kein double-settle).
- ACL im Haupt-Recall durchgesetzt; per-Agent-Dateisystem-Isolation ist die
  tragende Privacy-Schicht (nicht das Scope-Modell).
- **Historischer missing-await-Bug: in v6.8.9 genuin gefixt** (Capture-Pipeline,
  before_prompt_build, archive-before-delete-Ordering alle korrekt).
- resolveApiKey-Precedence korrekt; class-Provider Dim-Validierung sicher;
  cache-key-Kollision benign.
- **MEMORY.md-Altlasten entlastet:** Self-Hash-Mismatch FIXED, rapid-fire
  MITIGATED, Backlog BOUNDED, undefined-Links GUARDED, managed-block content-eating
  GUARDED.

## Nicht geprüft
i18n-dictionary, kleinere Utility-Module.
