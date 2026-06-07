# P5 Runtime Validation: Real Upgrade Dry Run

**Agent:** Subagent A  
**Datum:** 2026-06-07  
**Status:** ✅ PASS (8/8 Checks, 18/18 Steps)

---

## Ziel

Simuliere ein Upgrade-Szenario mit echten/alten Daten und validiere, dass:
1. Bestehende Daten nicht verloren gehen
2. Keine manuelle DB-Schema-Änderung nötig ist
3. Alte Defaults erhalten bleiben
4. Neue Defaults für neue Daten greifen

---

## Testumgebung

- **Temporäres Testdatenverzeichnis:** `/tmp/plur1bus-p5-testdata`
- **Projektverzeichnis:** `/tmp/plur1bus-p5/p5-upgrade-dryrun`
- **Code-Änderungen:** Keine (nur Simulation + Audit-Dokument)

---

## Schritt 1: Alte Daten simuliert

### `run-state.json`
Enthält alte Metriken ohne neue Felder:
- `metrics.graphRecall` (nur `totalQueries`, `avgLatencyMs`, `lastRun`)
- `metrics.obsidianSync` (nur `lastSyncAt`, `filesSynced`)
- `jobRateLimits` ohne neue Runtime-Felder
- `sessionCounter` und `lastSessionAt`

### Alte Memories (3 Einträge)
| ID | Kategorie | halfLifeDays | memoryClass | lastDynamicsAt |
|---|---|---|---|---|
| old-mem-001 | fact | 30 | *(fehlt)* | 10 Tage alt |
| old-mem-002 | project | 30 | *(fehlt)* | 5 Tage alt |
| old-mem-003 | person | 30 | *(fehlt)* | 2 Tage alt |

### Alte Config
```json
{
  "recall": {
    "importanceBoost": 0.3
    // KEINE neuen Felder:
    // maxPromptMemories, canonicalMaxItems, dedupJaccard, candidateTopK, halfLifeDaysMap
  },
  "runtime": {
    // KEINE neuen Felder: embeddingCacheEnabled, metricsDebounceMs
  }
}
```

---

## Schritt 2: Migration-Logik getestet

### 2a) `applyDynamicsDefaults` auf alte Rows
Wenn `lastDynamicsAt` gesetzt ist, wird `applyDailyDecay` aufgerufen – **aber `halfLifeDays` bleibt unverändert**.

| Row | Erwartet | Ergebnis | Status |
|---|---|---|---|
| old-mem-001 (fact) | 30 | 30 | ✅ |
| old-mem-002 (project) | 30 | 30 | ✅ |
| old-mem-003 (person) | 30 | 30 | ✅ |

**Check `oldDataHalfLifePreserved`:** ✅ PASS

### 2b) `applyDynamicsDefaults` auf neue Rows
Neue Einträge (ohne `lastDynamicsAt`) bekommen typbasierte `halfLifeDays` aus dem Mapping.

| Kategorie | Erwartet | Ergebnis | memoryClass | Status |
|---|---|---|---|---|
| fact | 60 | 60 | standard | ✅ |
| project | 365 | 365 | standard | ✅ |
| person | 365 | 365 | standard | ✅ |
| other | 180 | 180 | standard | ✅ |

**Check `newDataDefaultsCorrect`:** ✅ PASS  
**Check `newDataGetsMemoryClass`:** ✅ PASS

### 2c) `resolveHalfLifeDays` mit Override
Config-Overrides (`halfLifeDaysMap`) werden korrekt angewendet.

| Override | Kategorie | Erwartet | Ergebnis | Status |
|---|---|---|---|---|
| `{ transient: 90 }` | fact | 90 | 90 | ✅ |
| `{ transient: 90 }` | general | 90 | 90 | ✅ |
| `{ episodic: 200 }` | other | 200 | 200 | ✅ |
| *(kein Override)* | project | 365 | 365 | ✅ |
| *(kein Override)* | person | 365 | 365 | ✅ |

**Check `overrideWorks`:** ✅ PASS

---

## Schritt 3: Prüfungen

### 3a) Kein Datenverlust ✅
Nach `applyDynamicsDefaults` bleiben bestehen:
- `id`, `text`, `category`, `createdAt`
- Alte `halfLifeDays`-Werte
- Bestehende `memoryStrength`

**Check `noDataLoss`:** ✅ PASS

### 3b) Keine DB-Schema-Änderung nötig ✅
Der `db-adapter.js` ergänzt fehlende Spalten idempotent via `addColumns`:
- `ensureDynamicsColumns` fügt `retrievalCount`, `lastRetrievedAt`, `memoryStrength`, `halfLifeDays`, `lastStrengthenedAt`, `lastDynamicsAt`, `memoryClass`, `neverForget`, `coreMemoryScore`, `coreMemoryReason` hinzu
- `ensureReconsolidationColumns` fügt `versionNumber`, `previousVersion`, `supersededBy`, `updateSource`, `updateEvidence`, `reconsolidationConfidence`, `status`, `versionCreatedAt`, `updatedAt` hinzu
- `ensureReminderColumns` fügt Reminder-Felder hinzu

Fehler bei `addColumns` werden geloggt, aber nicht propagiert – Retry beim nächsten Zugriff.

**Check `noSchemaChangeNeeded`:** ✅ PASS

### 3c) Alte Defaults bleiben erhalten ✅
Bestehende Memories mit `halfLifeDays: 30` behalten diesen Wert.
Die neue Kategorie-zu-Halbwertszeit-Map greift **nicht retroaktiv**.

**Check `oldDefaultsPreserved`:** ✅ PASS

### 3d) Neue Defaults greifen für neue Daten ✅
Neu erstellte Memories bekommen automatisch:
- `fact`, `general` → 60 Tage (transient)
- `other` → 180 Tage (episodic)
- `person`, `work` → 365 Tage (longContext)
- `project`, `decision` → 365 Tage (project)

**Check `newDefaultsWork`:** ✅ PASS

---

## Zusammenfassung

| Kriterium | Ergebnis |
|---|---|
| Datenverlust | Keiner |
| Schema-Migration | Nötig, aber automatisch (idempotent `addColumns`) |
| Alte Defaults | Erhalten |
| Neue Defaults | Greifen für neue Daten |
| Config-Override | Funktioniert |

**Gesamtergebnis:** ✅ **PASS** – Das Upgrade-Szenario ist robust. Alte Daten bleiben unverändert, neue Daten profitieren von den verbesserten Defaults, und die DB-Schema-Erweiterungen sind non-destruktiv.

---

## Artefakte

- **Testdaten:** `/tmp/plur1bus-p5-testdata/run-state.json`
- **Testskript:** `/tmp/plur1bus-p5-testdata/upgrade-dryrun.mjs`
- **Rohdaten:** `/tmp/plur1bus-p5-testdata/dryrun-results.json`
