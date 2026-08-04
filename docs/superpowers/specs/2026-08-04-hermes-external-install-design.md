# Hermes-Port extern installierbar (pip + Release)

**Date:** 2026-08-04 · **Branch:** `codex/plur1bus2hermes`
**Ziel:** Externe User können den PLUR1BUS-Hermes-Port ohne manuelle Kopiervorgänge installieren: pip via Git-URL, dokumentiert im Root-README, referenziert über einen stabilen Tag.

## Ausgangslage

- `plur1bus-hermes/pyproject.toml` und `plur1bus-controls/pyproject.toml` existieren bereits (setuptools, src-Layout, Entry-Points, Version 0.1.0, requires-python >=3.11).
- `plur1bus-hermes` deklariert Dependencies: `lancedb==0.34.0`, `numpy==2.2.0`, `sentence-transformers>=3.0,<4`.
- `plur1bus-controls` importiert `plur1bus_hermes`, deklariert aber keine Dependencies.
- `scripts/install-hermes-plugins.sh` macht bereits `pip install "$repo_dir/plur1bus-hermes"` (lokaler Pfad) + rsync der Plugin-Daten + `hermes memory setup`.
- Es gibt noch keinen Hermes-Release-Tag.

## Entscheidungen (Auto-Modus, als Annahmen dokumentiert)

- **A:** controls bekommt **keine** hartkodierte Git-URL-Dependency (hält die PyPI-Option offen); stattdessen dokumentierte Zwei-Befehl-Installation.
- **B:** Version bleibt **0.1.0** (erster externer Drop, kein künstlicher Bump).
- **C:** Tag-Name **`hermes-v0.1.0`** (Präfix, um Kollision mit den JS-Releases `v7.x.x` zu vermeiden).

## Design

### 1. pip-Installation via Git-URL

Dokumentierter Hauptweg:

```bash
pip install "git+https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory.git@hermes-v0.1.0#subdirectory=plur1bus-hermes"
pip install "git+https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory.git@hermes-v0.1.0#subdirectory=plur1bus-controls"
```

Verifikation in frischem venv über das git+file://-Äquivalent: Wheel-Build, Import (`plur1bus_hermes`, `plur1bus_controls`), CLI-Smoke (`plur1bus-hermes --help`).

### 2. Root-README: Abschnitt „Hermes-Port (Beta)"

Neuer Abschnitt direkt nach dem OpenClaw-Installationsabschnitt:

- Voraussetzungen: Hermes ≥ 0.19, Python ≥ 3.11; `HERMES_PYTHON` auf den Hermes-Interpreter setzen, wenn Hermes ein venv nutzt.
- Die zwei pip-Befehle (s. o.).
- Vollsetup: `scripts/install-hermes-plugins.sh` (Credentials via `hermes memory setup`, setzt `memory.provider: plur1bus`, deaktiviert eingebautes MEMORY.md/USER.md, aktiviert controls).
- Beta-Hinweis: kein Produktiv-Cutover; volle Parität steht im Migrationsplan (`docs/superpowers/plans/2026-07-25-plur1bus-hermes-migration.md`).
- Verweis auf `plur1bus-hermes/README.md` für Details.

### 3. Release

- Tag `hermes-v0.1.0` auf den Branch-Tip nach dem README-Commit.
- Push: Branch `codex/plur1bus2hermes` + Tag.
- GitHub Release `hermes-v0.1.0` mit kurzen Notes (Umfang, Install-Befehle, Beta-Status, Verweis auf Review-Findings).

### 4. Verifikation

- Frisches venv: beide Pakete via Git-URL installieren, Import + CLI-Smoke.
- `pytest` in `plur1bus-hermes/` bleibt 151/151 grün (mit `PYTHONPATH=src:../plur1bus-controls/src`).
- `npm test` unberührt (keine JS-Änderungen).

## Fehlerbehandlung / Risiken

- **Wheel-Build schlägt fehl** (Packaging-Fehler): vor dem Tag fixen; kein Tag auf unverifiziertem Stand.
- **Schwere Dependencies** (sentence-transformers→torch): bestehende Design-Entscheidung (lokale Embeddings), wird in den Release-Notes erwähnt (Download-Größe).
- **Scope:** kein Umbau von `install-hermes-plugins.sh` auf Remote-Install (YAGNI), keine PyPI-Veröffentlichung (nur Git-URL).
