# Release Checklist — PLUR1BUS Memory v6.1.0 (Engram) GA

> Status: **General Availability**  
> Ziel-Datum: 2026-06-07  
> Git-Tag: `v6-engram-rc1` gepusht; GA-Tag `v6.1.0` / `v6-engram` bereit

---

## Pre-Release

- [x] CHANGELOG.md finalisiert (Version, Datum, Breaking Changes, Added, Fixed, Security, Known Issues)
- [x] **Tests:** 441 Tests, 0 Failures über 100 Test-Suites
- [x] **Keine DB-Schema-Änderung** (abwärtskompatibel mit v6.0.x)
- [x] **Neue Defaults dokumentiert**
  - `maxPromptMemories` = `12`
  - `dedup` / `dedupJaccard` = `0.78`
  - `canonicalMaxItems` = `5`
  - `halfLifeDaysMap` (transient: 60, episodic: 180, longContext/project: 600)
  - `embeddingCacheEnabled` = `true`
  - `embeddingCacheTtlMs` = `300000`
  - `embeddingCacheMaxEntries` = `1000`
- [x] **Migrationshinweise:** keine manuelle Migration nötig
- [x] **Rollback:** vor-v6 Commit dokumentiert (`917e403`), jederzeit sicher ausführbar

---

## Validation (P3–P5)

- [x] **P3 — Config & Smoke:** 41 Config-Audit-Tests + 5 E2E-Recall-Smoke-Tests grün
- [x] **P3 — Performance:** Benchmarks für Recall-Latenz, Graph-Index, Kompression dokumentiert
- [x] **P3 — Dead-Code-Audit:** 233 Zeilen toter Code entfernt, keine Regression
- [x] **P4 — Security-Regression:** 105 Tests grün
  - `safeUuid()` / `safeTimestamp()` Coverage
  - `security.allowChatConfigCommands` Default-Verhalten
  - File-Lock auf `openclaw.json`-Writes
  - Archive-First für `memory_forget`
  - SQL-Escaping in `filter-parser.js` und allen DB-where-Clauses
  - ACL-Härtung via `safeSlug` (Punkt-Segment-Kollaps verhindert)
  - Destructive-Command-UserId-Validierung
- [x] **P4 — Release-Packaging:** `npm install` erfolgreich, `openclaw.plugin.json` validiert
- [x] **P4 — Upgrade-Simulation:** v6.0.x → v6.1.0 in-place Upgrade ohne Datenverlust
- [x] **P4 — Public-API-Audit:** 40 public/stable, 11 internal/test-only, 75 internal dokumentiert
- [x] **P5A — Real Upgrade Dry Run:** 8/8 Checks bestanden, kein Datenverlust
- [x] **P5B — Telegram Command Smoke:** 6/6 Tests bestanden, ACL-Verhalten validiert
- [x] **P5C — Obsidian Bridge Smoke:** 5/5 Tests bestanden
  - Bidirektionaler Sync: OK
  - Conflict-Report: OK
  - Apply-Mode mit Backup: OK
  - Path-Traversal-Schutz: OK
  - Atomic JSON parallele Writes: OK
- [x] **P5D — Recall Quality Golden Set:** 8/8 Tests bestanden
  - longContext / project `halfLifeDays` 365 → 600 Tage angepasst
- [x] **P5E — Rollback Test:** 9/9 Checks bestanden, Rollback auf `917e403` als unkritisch eingestuft

---

## Post-Release

- [x] Git-Tag `v6-engram-rc1` gesetzt und gepusht
- [ ] Git-Tag `v6.1.0` (oder `v6-engram`) setzen und pushen
- [x] Release-Notes im Repo hinterlegt (CHANGELOG.md, docs/known-issues.md)
- [x] Rollback-Verfahren getestet und dokumentiert (`docs/audits/rollback-p5.md`)
