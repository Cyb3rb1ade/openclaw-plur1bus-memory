# Release Checklist — PLUR1BUS Memory v6.1.0 (Engram)

> RC-Status: **Release Candidate**
> Ziel-Datum: 2026-06-07

---

## Pre-Release

- [x] CHANGELOG.md finalisiert (Version, Datum, Breaking Changes, Added, Fixed)
- [ ] **Tests:** 382 Tests, 0 Failures
- [ ] **Keine DB-Schema-Änderung** (abwärtskompatibel mit v6.0.x)
- [ ] **Neue Defaults dokumentiert**
  - `maxPromptMemories` = `12`
  - `dedup` / `dedupJaccard` = `0.78`
  - `canonicalMaxItems` = `5`
  - `halfLifeDaysMap` (transient: 60, episodic: 180, longContext/project: 365)
  - `embeddingCacheEnabled` = `true`
  - `embeddingCacheTtlMs` = `300000`
  - `embeddingCacheMaxEntries` = `1000`
- [ ] **Migrationshinweise:** keine manuelle Migration nötig
- [ ] **Rollback:** vorherigen Commit kann ausgecheckt werden (`git checkout HEAD~1`)

---

## Validation

- [ ] **openclaw.plugin.json** validiert (Schema, Version, Einträge)
- [ ] **Security-Regression-Tests** grün
  - `safeUuid()` / `safeTimestamp()` Coverage
  - `security.allowChatConfigCommands` Default-Verhalten
  - File-Lock auf `openclaw.json`-Writes
  - Archive-First für `memory_forget`
- [ ] **Upgrade-Simulation** grün
  - v6.0.x → v6.1.0 in-place Upgrade ohne Datenverlust
  - Config-Defaults werden übernommen
- [ ] **Dead-Code-Audit** durchgeführt
  - Keine unerreichbaren Pfade
  - Keine ungenutzten Exports
- [ ] **Performance-Benchmarks** dokumentiert
  - Embedding-Cache Hit-Rate
  - Recall-Latenz mit/ohne Kompression
  - Graph-Index Query-Time vs. vorher

---

## Post-Release

- [ ] Git-Tag `v6.1.0` gesetzt
- [ ] Release-Notes im Repo hinterlegt
- [ ] Rollback-Verfahren getestet und dokumentiert
