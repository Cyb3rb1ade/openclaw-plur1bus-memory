# Release Checklist — PLUR1BUS Memory v7.0.0 (Humanization)

> Status: **Released**  
> Release-Datum: 2026-07-16  
> Git-Tag: `v7.0.0` gepusht (Commit `3607b32`) · ClawHub: `@cyb3rb1ade/plur1bus-memory@7.0.0` (latest)

---

## Pre-Release

- [x] CHANGELOG.md finalisiert (Breaking/Changed, Added, Fixed, Verification)
- [x] **Tests:** 2466 passing, 0 failing (1 skipped) über 492 Test-Suites — vor und nach dem Versions-Bump
- [x] **Keine DB-Schema-Änderung** (abwärtskompatibel mit 6.9.x; LanceDB-Schema unverändert)
- [x] **Versionen synchron:** `package.json` = `openclaw.plugin.json` = `7.0.0`
- [x] **README aktualisiert:** Version-Header + "New in v7.0.0"-Block
- [x] **Breaking Changes dokumentiert:**
  - Persona-Evolution wendet Vorschläge automatisch an (kein Propose/Accept mehr); Sicherheit über Bounds (12-Bullet-Cap, Seed-End-Boundary, Append-Dedup)
  - Afterthought-Skip-Contract nutzt `NO_REPLY`-Token; bestehende Crons werden beim Setup-Lauf automatisch migriert
- [x] **Migrationshinweise:** keine manuelle Migration nötig (Cron-Migration und AGENTS.md-Patching laufen automatisch)
- [x] **Rollback:** Vor-Release-Stand = Tag `v6.9.10`; Downgrade jederzeit über ClawHub-Tag bzw. Git-Tag möglich

---

## Validation

- [x] **Voller Test-Lauf auf Release-Commit:** `npm test` grün (inkl. Daily-Decay-Bounded-Selection-Fix `e72cb2b`)
- [x] **agents-patcher (TDD):** managed Block `<!-- plur1bus:telegram-reaction-rules -->` — appendet nur bei vorhandener Reaction-Guidance, idempotent, No-Touch sonst
- [x] **Feature-Cron-Automation:** idempotenter Setup über npm postinstall, `/plur1bus setup crons`, Doctor-Hinweis und deferred `gateway_start`-Bootstrap; Delivery-Derivation nie geraten (bei Konflikt disabled + Hinweis)
- [x] **Live-Verifikation Reaction-Regeln:** Telegram-Reaction 🤣 auf aktuelle Nachricht erfolgreich (ok:true); Regeln in allen vier Workspace-AGENTS.md aktiv
- [x] **Update-Pfad:** `update-openclaw.sh` patcht `workspace*/AGENTS.md` über den agents-patcher bei jedem Update

---

## Post-Release

- [x] Git-Tag `v7.0.0` gesetzt und gepusht
- [x] ClawHub-Publish aus GitHub-Quelle (`Cyb3rb1ade/openclaw-plur1bus-memory@3607b32`): `--dry-run` geprüft (246 Dateien, 2.5 MB) → publish → inspect bestätigt `Latest: 7.0.0`, source-linked
- [x] Release-Notes im Repo (CHANGELOG.md)
- [ ] ClawHub-Scan-Ergebnis prüfen (stand bei Publish auf "pending")
- [ ] Betrieb beobachten: Persona-Auto-Apply-Ergebnisse und Afterthought-`NO_REPLY`-Verhalten in den nächsten Cron-Läufen

---

## Frühere Releases

Die v6.1.0-(Engram-)GA-Checkliste liegt in der Git-History dieser Datei (Stand vor 2026-07-16).
