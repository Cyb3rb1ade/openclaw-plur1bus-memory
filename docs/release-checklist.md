# Release Checklist — PLUR1BUS Memory v6.1.0-rc1 (Engram)

> RC-Status: **Release Candidate 1**
> Ziel-Datum: 2026-06-07

---

## Pre-Release

- [x] CHANGELOG.md finalisiert (Version, Datum, Breaking Changes, Added, Fixed, Known Issues)
- [x] **Tests:** 420 Tests, 0 Failures
- [x] **Keine DB-Schema-Änderung** (abwärtskompatibel mit v6.0.x)
- [x] **Neue Defaults dokumentiert**
  - `maxPromptMemories` = `12`
  - `dedup` / `dedupJaccard` = `0.78`
  - `canonicalMaxItems` = `5`
  - `halfLifeDaysMap` (transient: 60, episodic: 180, longContext/project: 365)
  - `embeddingCacheEnabled` = `true`
  - `embeddingCacheTtlMs` = `300000`
  - `embeddingCacheMaxEntries` = `1000`
- [x] **Migrationshinweise:** keine manuelle Migration nötig
- [x] **Rollback:** vorherigen Commit kann ausgecheckt werden (`git checkout HEAD~1`)

---

## Validation

- [x] **openclaw.plugin.json** validiert (Schema, Version, Einträge)
- [x] **Security-Regression-Tests** grün
  - `safeUuid()` / `safeTimestamp()` Coverage
  - `security.allowChatConfigCommands` Default-Verhalten
  - File-Lock auf `openclaw.json`-Writes
  - Archive-First für `memory_forget`
  - **SQL-Escaping** in `light-dream.js` und allen DB-where-Clauses
  - **ACL-Härtung** via `safeSlug` (Punkt-Segment-Kollaps verhindert)
- [x] **Upgrade-Simulation** grün
  - v6.0.x → v6.1.0-rc1 in-place Upgrade ohne Datenverlust
  - Config-Defaults werden übernommen
- [x] **Dead-Code-Audit** durchgeführt
  - 233 Zeilen toter Code entfernt
  - Keine unerreichbaren Pfade mehr vorhanden
  - Ungenutzte Exports in neo-arch.js/obsidian-*.js für P5+ markiert
- [x] **Performance-Benchmarks** dokumentiert
  - Embedding-Cache Hit-Rate (vorbereitet, noch nicht hot-verdrahtet)
  - Recall-Latenz mit/ohne Kompression
  - Graph-Index Query-Time vs. vorher

---

## Post-Release

- [ ] Git-Tag `v6.1.0-rc1` gesetzt
- [x] Release-Notes im Repo hinterlegt
- [ ] Rollback-Verfahren getestet und dokumentiert
