# P2 Sprint: Hot-Path / Atomic JSON Audit — Audit-Report

**Datum:** 2026-06-07
**Auditor:** Subagent F
**Scope:** `lib/atomic-json.js` + alle Call-Sites
**Status:** 🔴 Kritisch — Hot-Path-Blockade bestätigt

---

## 1. Zusammenfassung `lib/atomic-json.js`

| Aspekt | Bewertung |
|--------|-----------|
| **Export** | `atomicJsonUpdate(filePath, updater)` |
| **Mutex** | ✅ Promise-Queue pro Dateipfad (`fileQueues: Map`) |
| **Reentrancy** | ✅ Geschützt via `activeFiles: Set` |
| **Atomizität** | ✅ Write-to-temp + `renameSync` |
| **Fehler-Handling** | ✅ Queue bricht nach Fehler nicht ab (`.catch(() => {})`) |
| **I/O-Modus** | ❌ **Synchron** (`readFileSync`, `writeFileSync`, `renameSync`, `existsSync`) |

Die Implementierung ist korrekt für Race-Condition-Schutz, nutzt aber **synchrones File-I/O innerhalb einer Promise-Kette**. Das bedeutet: jeder Aufruf von `atomicJsonUpdate` blockiert den Node.js-Event-Loop für die Dauer der File-Operationen, obwohl er `async` zurückgibt.

---

## 2. Call-Site-Analyse

### 2.1 `lib/metrics.js` → `recordGraphRecallMetrics`

| Feld | Wert |
|------|------|
| **Import** | `lib/recall-pipeline.js:23` |
| **Call-Site** | `lib/recall-pipeline.js:486` |
| **Bedingung** | `graphMetricsData && workspaceDir` (d.h. `associativeEnabled && graphEdges.length > 0 && boosted.length > 0`) |
| **Trigger 1** | `index.js:3128` — `memory_recall` Tool-Execution |
| **Trigger 2** | `index.js:3610` — `before_prompt_build` Hook (jeder Prompt!) |

**Frequenz-Schätzung:**
- `before_prompt_build` feuert bei **jedem eingehenden Request** (einmal pro Prompt).
- `memory_recall` feuert zusätzlich bei expliziten Tool-Calls.
- Bei aktiviertem Memory-Graph (`associativeEnabled=true`) und vorhandenen `graphEdges` wird diese Funktion **pro Request** aufgerufen.

**→ KLASSIFIZIERUNG: 🔥 HOT-PATH**

### 2.2 `lib/metrics.js` → `recordObsidianSyncMetrics`

| Feld | Wert |
|------|------|
| **Import** | `lib/obsidian-bridge.js:28` |
| **Call-Site** | `lib/obsidian-bridge.js:1468` |
| **Bedingung** | Am Ende eines erfolgreichen Vault-Syncs |
| **Trigger** | Obsidian-Bridge-Service (Background-Sync, Datei-Watcher oder manuell) |

**Frequenz-Schätzung:**
- Abhängig von Vault-Größe und `watch`-Modus: alle paar Minuten bis Stunden.
- Nicht pro Request gebunden.

**→ KLASSIFIZIERUNG: 🧊 COLD-PATH**

### 2.3 `lib/job-rate-limit.js` → `recordJobRun`

| Feld | Wert |
|------|------|
| **Import** | `lib/jobs/reminder-dispatch.js:7`<br>`lib/jobs/daily-consolidation.js:19`<br>`lib/jobs/skill-miner.js:15` |
| **Call-Sites** | `reminder-dispatch.js:121`<br>`daily-consolidation.js:195`<br>`skill-miner.js:174` |
| **Trigger** | Nach erfolgreicher Job-Ausführung (Background-Jobs) |

**Frequenz-Schätzung:**
- `reminder-dispatch`: 1× täglich pro Agent/Workspace
- `daily-consolidation`: 1× täglich pro Agent/Workspace
- `skill-miner`: 1× wöchentlich pro Agent/Workspace

**→ KLASSIFIZIERUNG: 🧊 COLD-PATH**

### 2.4 `lib/job-rate-limit.js` → `checkJobRateLimit` (lesend, kein `atomicJsonUpdate`)

| Feld | Wert |
|------|------|
| **Call-Sites** | Gleiche Jobs wie oben (bei jedem Job-Start) |
| **I/O** | Synchrones `readFileSync` direkt (nicht via `atomic-json.js`) |

**→ KLASSIFIZIERUNG: 🧊 COLD-PATH** (nur bei Job-Starts, nicht pro Request)

---

## 3. Hot-Path-Impact-Analyse

### 3.1 Welcher Code läuft im Hot-Path?

```js
// lib/atomic-json.js — ausgeführt bei JEDEM Request mit Graph-Recall:
const data = readJson(filePath);              // readFileSync
writeFileSync(tmp, JSON.stringify(updated));  // writeFileSync
renameSync(tmp, filePath);                    // renameSync
```

Dies geschieht in `recordGraphRecallMetrics`, das in `runRecallPipeline` am Ende jeder Pipeline aufgerufen wird.

### 3.2 Aufruffrequenz

| Szenario | Frequenz |
|----------|----------|
| Standard-Chat-Request | 1× `before_prompt_build` → potenziell 1× `atomicJsonUpdate` |
| `memory_recall` Tool-Call | +1× `atomicJsonUpdate` |
| Batch von 100 Requests | 100× `atomicJsonUpdate` (serialisiert pro Datei, aber jede blockiert den Event Loop) |
| Stündlich (aktiver Agent) | ~60–120+ Schreiboperationen auf `run-state.json` |

### 3.3 Was passiert bei hoher Last?

- Die Promise-Queue serialisiert Schreibzugriffe auf `run-state.json` **pro Dateipfad**.
- Aber: die synchronen Operationen blockieren den Event-Loop für jeden einzelnen Schritt.
- Bei vielen parallelen Requests entsteht eine **kaskadierende Verzögerung** — jeder Request wartet auf den vorherigen File-Lock, während Node.js blockiert.
- Das betrifft nicht nur den aktuellen Workspace, sondern alle parallelen Operationen im selben Prozess.

---

## 4. Risikobewertung

| Risiko | Schwere | Begründung |
|--------|---------|------------|
| **Event-Loop-Blockade im Hot-Path** | 🔴 **Hoch** | Synchrones I/O bei jedem Request verlangsamt die gesamte Gateway-Response-Time. |
| **Kaskadierende Latenz unter Load** | 🔴 **Hoch** | Queue + sync I/O = jeder Request hält den nächsten auf. Bei 100+ req/h summiert sich das. |
| **Race Condition** | 🟡 **Mittel** | Durch `atomicJsonUpdate` weitgehend verhindert, aber `checkJobRateLimit` nutzt **keinen** Mutex (nur `readFileSync`). Parallele `recordJobRun` + `checkJobRateLimit` können theoretisch veraltete Daten lesen. |
| **Datei-Korruption** | 🟢 **Niedrig** | Temp-Datei + `renameSync` schützt gegen halbgeschriebene JSON-Dateien. |
| **Speicher-Wachstum der Queue** | 🟡 **Mittel** | `fileQueues` speichert Promises; bei sehr hoher Frequenz ohne Cleanup könnte der Map-Eintrag kurzlebig anwachsen (wird aber via `.finally()` gelöscht). |
| **Fehler-Suppression** | 🟡 **Mittel** | `readJson` ignoriert Parse-Fehler stillschweigend; das kann zu Datenverlust führen, wenn `run-state.json` korrupt ist. |

---

## 5. Empfohlene Maßnahmen

### 5.1 Sofortmaßnahme: Hot-Path entlasten (P0)

**Option A — Fire-and-Forget (schnellster Fix):**
```js
// In recall-pipeline.js:486
recordGraphRecallMetrics(workspaceDir, { ... }).catch(() => {});
// Statt await — blockiert die Pipeline nicht
```

> ⚠️ Risiko: Ungebundene Promises könnten bei Prozess-Crash verloren gehen. Akzeptabel für reine Metriken.

**Option B — In-Memory-Accumulator + periodisches Flush (beste Lösung):**
```js
// metrics.js
const pendingMetrics = new Map();
let flushTimer = null;

function queueMetrics(workspaceDir, metrics) {
  pendingMetrics.set(workspaceDir, { ...pendingMetrics.get(workspaceDir), ...metrics });
  if (!flushTimer) flushTimer = setTimeout(flushMetrics, 5000);
}

async function flushMetrics() {
  flushTimer = null;
  for (const [dir, metrics] of pendingMetrics) {
    await recordGraphRecallMetrics(dir, metrics);
  }
  pendingMetrics.clear();
}
```

**Option C — Async-I/O (fs/promises):**
- `readFileSync` → `readFile` (async)
- `writeFileSync` → `writeFile` (async)
- `renameSync` → `rename` (async)
- `existsSync` → `access` (async)

> Dies entlastet den Event Loop, ändert aber die Semantik leicht (Error-Handling muss geprüft werden).

### 5.2 Mittelfristig: Batching / Debounce für Metrics

- `recordGraphRecallMetrics` sollte nicht bei **jedem** Request schreiben.
- Debounce von z.B. 5–10 Sekunden oder Batch nach 10 Einträgen.
- Das reduziert I/O von "pro Request" auf "pro Zeitfenster".

### 5.3 Langfristig: Hot-Path komplett trennen

- Metriken, die im Hot-Path anfallen, sollten **nicht** in eine shared JSON-Datei geschrieben werden.
- Alternativen:
  - **In-Memory-Metriken** mit periodischem Dump (z.B. alle 60s)
  - **Ring-Buffer** pro Workspace (nur letzte N Werte)
  - **Separates lightweight Store** (z.B. SQLite WAL-Mode oder einfaches Append-Log)

### 5.4 `checkJobRateLimit` prüfen

- Derzeit synchrones `readFileSync` ohne Mutex.
- Da Cold-Path, nicht kritisch — aber für Konsistenz sollte auch hier `atomicJsonUpdate` oder ein Read-Lock genutzt werden, falls Jobs parallel starten.

---

## 6. Call-Site-Übersicht

| Call-Site | Funktion | Pfad | Frequenz | Kritikalität |
|-----------|----------|------|----------|--------------|
| `lib/recall-pipeline.js:486` | `recordGraphRecallMetrics` | HOT | Pro Request | 🔴 |
| `lib/obsidian-bridge.js:1468` | `recordObsidianSyncMetrics` | COLD | Pro Sync (minütlich/stündlich) | 🟢 |
| `lib/jobs/reminder-dispatch.js:121` | `recordJobRun` | COLD | 1×/Tag | 🟢 |
| `lib/jobs/daily-consolidation.js:195` | `recordJobRun` | COLD | 1×/Tag | 🟢 |
| `lib/jobs/skill-miner.js:174` | `recordJobRun` | COLD | 1×/Woche | 🟢 |
| `lib/telegram-commands/status-data.js:84` | `getMetrics` | COLD | Bei Admin-Abfrage | 🟢 |

---

## 7. Fazit

> **Die synchronen File-Ops in `lib/atomic-json.js` sind im Hot-Path über `recordGraphRecallMetrics` tatsächlich ein Performance-Problem.**

- Jeder Chat-Request mit aktiviertem Memory-Graph führt zu einem synchronen Read-Modify-Write auf `run-state.json`.
- Die Promise-Queue verhindert zwar Race Conditions, aber nicht die Event-Loop-Blockade.
- Bei Gateway-Restart oder hoher Last kann dies zu spürbaren Latenzen führen.

**Empfohlene Priorisierung:**
1. **P0:** `recordGraphRecallMetrics` aus dem synchronen Pipeline-Ablauf entfernen (Fire-and-Forget oder Batching)
2. **P1:** `atomicJsonUpdate` auf `fs/promises` umstellen (async I/O)
3. **P2:** Debounced Metrics-Flush implementieren
4. **P3:** Langfristig Hot-Path-Metriken in separaten Speicher auslagern

---

*Keine Code-Änderungen wurden vorgenommen. Dieser Report ist rein analytisch.*
