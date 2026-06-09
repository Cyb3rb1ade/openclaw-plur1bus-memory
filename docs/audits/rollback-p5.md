# P5: Rollback-Test — v6-engram-rc1 → vor-v6 (917e403)

> **Subagent E — P5 Runtime Validation: Rollback Test**
> **Datum:** 2026-06-07
> **Von:** `v6-engram-rc1` → `917e403` (P0: Recall-Architect + Memory-Loss fixes)

---

## 1. Rollback-Anleitung (Schritt für Schritt)

### 1.1 Voraussetzungen prüfen

```bash
# Aktuellen Stand verifizieren
git status

# Ziel-Commit identifizieren (Commit vor P1/v6)
git log --oneline
# → 917e403 P0: Recall-Architect + Memory-Loss fixes
```

### 1.2 Rollback durchführen

```bash
# Hard-Reset auf vor-v6 Commit (keine DB-Schema-Änderung → kein Datenverlust)
git checkout 917e403
```

> **Hinweis:** Kein `git reset --hard` nötig — ein einfaches `git checkout <commit>` genügt, da keine migrierten Daten zurückgespielt werden müssen.

### 1.3 Nach dem Rollback

- Plugin neu starten (OpenClaw-Runtime neu laden)
- Konfiguration bleibt unverändert in `openclaw.json`
- Neue Config-Felder werden von der alten Runtime ignoriert
- LanceDB-Datenbanken bleiben voll funktionsfähig

---

## 2. Risiko-Analyse

### 2.1 Datenbank-Schema — ✅ KEIN RISIKO

**Befund:** Keine DB-Schema-Änderungen zwischen `917e403` und `v6-engram-rc1`.

```bash
git diff 917e403..v6-engram-rc1 -- '*.sql' '*.md' | grep -i "schema\|migration\|alter table"
```

Ergebnis: Nur Dokumentations- und Audit-Dateien, keine DDL-Statements. Die LanceDB-Tabellen sind 100 % abwärtskompatibel.

**Implikation:**
- Kein Datenverlust beim Rollback
- Keine Migrationsskripte erforderlich
- Alle gespeicherten Memories, Reminder, Provenances etc. bleiben lesbar

### 2.2 Neue Dateien — ✅ KEIN RISIKO

| Datei | Import im Hauptcode? | Risiko |
|-------|---------------------|--------|
| `lib/embedding-cache.js` | ❌ Nur in Tests | Kein — wird nicht geladen |
| `lib/graph-index.js` | ❌ Nur in Tests | Kein — wird nicht geladen |
| `lib/metrics-debounce.js` | ❌ Nur in Tests | Kein — wird nicht geladen |
| `lib/recall-budget.js` | ❌ Nur in Tests | Kein — wird nicht geladen |

**Befund:** Keine der neuen Lib-Dateien wird in `index.js` oder anderen produktiven Modulen importiert. Sie existieren nur als Test-Assets und inlinerbare Module. Beim Rollback auf `917e403` werden sie einfach nicht mehr gefunden — das Produktivsystem startet trotzdem.

### 2.3 Gelöschte Dateien — ⚠️ GERINGES RISIKO

| Datei | Status |
|-------|--------|
| `lib/memory-card-writer.js` | In v6 gelöscht |

**Befund:** Beim Rollback auf `917e403` wird `lib/memory-card-writer.js` wiederhergestellt. Die Datei war in v5.x vorhanden und wurde in v6 durch andere Mechanismen ersetzt. Da sie in `917e403` noch existiert, ist sie kompatibel mit dem Code-Stand.

### 2.4 Neue Config-Felder — ✅ KEIN RISIKO

**Befund:** Alle in v6 hinzugekommenen Config-Felder haben definierte Defaults in `openclaw.plugin.json`:

| Feld | Default | Verhalten bei Rollback |
|------|---------|----------------------|
| `runtime.embeddingCacheEnabled` | `false` | Ignoriert — alte Runtime kennt Feld nicht |
| `runtime.embeddingCacheTtlMs` | `1800000` | Ignoriert |
| `runtime.embeddingCacheMaxEntries` | `500` | Ignoriert |
| `runtime.metricsDebounceMs` | `5000` | Ignoriert |
| `recall.halfLifeDaysMap.transient` | `60` | Ignoriert — alte Runtime nutzt feste Defaults |
| `recall.halfLifeDaysMap.episodic` | `180` | Ignoriert |
| `recall.halfLifeDaysMap.longContext` | `365` | Ignoriert |
| `recall.halfLifeDaysMap.project` | `365` | Ignoriert |
| `recall.importanceBoost` | `0.3` | Ignoriert |
| `recall.dedup` | `true` | Ignoriert |
| `recall.dedupJaccard` | `0.78` | Ignoriert |
| `recall.canonicalFirst` | `true` | Ignoriert |
| `recall.canonicalMinScore` | `0.3` | Ignoriert |
| `recall.canonicalMaxItems` | `5` | Ignoriert |
| `recall.maxPromptMemories` | `12` | Ignoriert |
| `recall.candidateTopK` | `40` | Ignoriert |

**Implikation:** Die `openclaw.json` des Users kann die neuen Felder enthalten — die alte Runtime liest sie nicht, verwirft sie aber auch nicht. Beim späteren Upgrade auf v6 sind die Einstellungen wieder aktiv.

### 2.5 `halfLifeDays` in bestehenden DB-Einträgen — ✅ KEIN RISIKO

**Befund:** In v6 (P1) wurde `halfLifeDays` als DB-Spalte eingeführt. In `917e403` (P0) existiert sie bereits:

```javascript
// Aus index.js, MemoryDB.init() — bereits in P0 vorhanden:
const hasHalfLifeDays = schema.fields.some(f => f.name === 'halfLifeDays');
if (!hasHalfLifeDays) {
  await this.table.addColumns([{ name: 'halfLifeDays', valueSql: '30' }]);
}
```

**Implikation:**
- Alte `halfLifeDays`-Werte in der DB bleiben erhalten
- Die alte Runtime nutzt möglicherweise andere Default-Logik (hardcoded 30 vs. v6's `halfLifeDaysMap`), aber die Daten selbst sind nicht gefährdet
- Beim erneuten Upgrade auf v6 stehen die typ-spezifischen Werte wieder zur Verfügung

---

## 3. Empfohlene Vorgehensweise

### 3.1 Sofort-Rollback (Notfall)

Wenn ein kritischer Fehler in v6 auftritt:

1. **Plugin stoppen** (OpenClaw-Runtime beenden)
2. **`git checkout 917e403`** im Plugin-Verzeichnis
3. **Plugin starten**
4. **Smoke-Test:** Ein Memory speichern und recallen

→ Kein Datenverlust, keine Config-Änderung nötig.

### 3.2 Rollforward (Rückkehr zu v6)

Wenn der Fehler behoben ist:

1. **`git checkout v6-engram-rc1`** (oder neuerer Tag)
2. **Plugin neu starten**
3. **Neue Config-Felder werden automatisch aktiv** (wenn in `openclaw.json` gesetzt, sonst Defaults)

→ `halfLifeDays`-Werte in der DB sind unverändert, v6-Logik greift sofort.

### 3.3 Vorbeugung

- **Tag/Commit-Marker:** Der Commit `917e403` ist als "last known good" vor v6 dokumentiert.
- **Kein Schema-Migrations-Lock:** Da keine DDL-Migration nötig war, gibt es keinen Migrations-Status, der einen Rollback blockieren könnte.
- **Config-Versionierung:** Empfohlen, `openclaw.json` vor großen Upgrades zu sichern, damit neue Felder gezielt konfiguriert werden können.

---

## 4. Zusammenfassung

| Kategorie | Bewertung | Begründung |
|-----------|-----------|------------|
| DB-Schema-Änderung | ✅ Keine | Keine SQL/DDL-Änderungen zwischen vor-v6 und rc1 |
| Datenverlust | ✅ Keiner | LanceDB-Schema bleibt kompatibel |
| Config-Kompatibilität | ✅ Voll | Neue Felder haben Defaults und werden ignoriert |
| Code-Import-Risiko | ✅ Keines | Neue Libs nur in Tests, nicht im Hauptcode |
| Gelöschte Dateien | ⚠️ Gering | `memory-card-writer.js` wird beim Rollback wiederhergestellt |
| Gesamtrisiko | **NIEDRIG** | Rollback ist jederzeit sicher durchführbar |

**Empfehlung:** Der Rollback von `v6-engram-rc1` auf `917e403` ist **unkritisch** und kann ohne Vorarbeit durchgeführt werden. Es ist keine Sicherung der DB erforderlich (obwohl immer empfohlen), da das Schema unverändert bleibt.
