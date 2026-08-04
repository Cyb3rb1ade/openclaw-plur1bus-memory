# PLUR1BUS 7.2.2 erneut auf Hermes umsetzen (Merge + Nachprüfung)

**Date:** 2026-08-04
**Branch:** `codex/plur1bus2hermes`
**Ziel:** Der Hermes-Port soll auf dem Stand von PLUR1BUS 7.2.2 (`v7.2.2` = `e77381b` = `origin/main`) stehen — technisch per Merge, fachlich per Nachprüfung des gesamten Änderungsfensters seit dem Port-Design.

## Ausgangslage

- `origin/main` ist auf 7.2.2 (`e77381b`, „chore: release PLUR1BUS 7.2.2").
- `codex/plur1bus2hermes` (HEAD `cd68d49`) basiert git-technisch auf `v7.1.9` (`073ba11`, Merge-Base) und hat 2 eigene Commits, davon 1 ungepusht.
- Die Hermes-Portierung wurde am 2026-07-25 entworfen (`docs/superpowers/plans/2026-07-25-plur1bus-hermes-migration.md`), einen Tag nach dem 7.1.2-Release. Der Port-Inhalt spiegelt daher den Stand **7.1.2** wider.
- Überlappung Upstream (7.1.9→7.2.2) ↔ Hermes-Branch: nur `.gitignore`, `CHANGELOG.md`, `package.json`.
- Änderungsfenster **v7.1.2..v7.2.2**: 41 Commits, 63 Dateien, ~8.500 Insertions — darunter vom Port gespiegelte Kernmodule: `index.js`, `lib/runtime-scheduler.js`, `lib/llm-router.js`, `lib/afterthought.js`, `lib/db-adapter.js`, Cron-Setup.

## Entscheidungen (mit User bestätigt)

1. **Vorgehen:** Merge von `origin/main` (7.2.2) in `codex/plur1bus2hermes`. Kein Rebase, keine Neuportierung.
2. **Anpassungstiefe:** Merge + fachliche Nachprüfung der Hermes-Module gegen die Upstream-Änderungen.
3. **Review-Fenster:** `v7.1.2..v7.2.2` (volles Fenster seit Port-Design), nicht nur 7.1.9→7.2.2.
4. **Abschluss:** Nach grünen Tests Push von `codex/plur1bus2hermes` zu origin.

## Design

### 1. Merge

- Backup-Branch `backup/plur1bus2hermes-pre-722` auf `cd68d49` anlegen (lokal, kein Push).
- `git merge origin/main` in `codex/plur1bus2hermes`.
- Erwartete Konflikte nur in `.gitignore`, `CHANGELOG.md`, `package.json`.
  - Lösungsregel: Upstream-Stand 7.2.2 übernehmen, Hermes-Ergänzungen (Dependencies, Ignore-Einträge, Changelog-Block) darüber behalten.
- Abbruch jederzeit via `git merge --abort` möglich.

### 2. Fachliche Nachprüfung (5 Prüfspuren, parallelisiert via Subagents)

| Spur | Upstream-Änderung (Fenster 7.1.2→7.2.2) | Hermes-Berührungspunkt |
|---|---|---|
| **NEO/Episoden** | `lib/neo-arch.js` (Lock-Takeover, Timestamps, Tool-Result-Capture), `lib/episode-watermark.js` | plur1bus-hermes-Module mit Episoden-/NEO-Zugriff |
| **Embedding/Reindex** | `lib/promoted-memory-reindex.js`, `scripts/embed-promoted-memories.mjs` | `mtplx-embed/`, vom Port geänderte `lib/embedding-cache.js`, `lib/providers/embedding-openai.js` |
| **Plugin-Deployment** | `openclaw.plugin.json`, `scripts/verify-plugin-deploy.mjs`, `scripts/lib/deploy-integrity.mjs` | Layout von `plur1bus-controls/`, `hermes-model-providers/` |
| **Crons/Index** | `index.js`, `lib/setup/feature-cron-plan.js` (gestaffelte Consolidation-Crons) | Proactive-/Cron-Logik in plur1bus-hermes |
| **Parität (gesamtes Fenster)** | `lib/runtime-scheduler.js`, `lib/llm-router.js`, `lib/afterthought.js`, `lib/db-adapter.js`, `index.js` | Port-Spiegelungen: Scheduler→Hermes-Cron, LLM→`ctx.llm`, Capture/Recall-Pipeline, `tests/test_parity.py` |

- Gefundene Brüche werden **minimal** gefixt.
- Stellen, an denen kein Fix nötig ist, werden kurz als geprüft vermerkt. Ergebnisprotokoll: `docs/superpowers/specs/2026-08-04-plur1bus-722-hermes-review-findings.md`.

### 3. Verifikation

- `npm test` im Repo-Root (JS-Suite, inkl. neuer Upstream-Tests).
- `pytest` in `plur1bus-hermes/` (Python-Suite des Ports).
- Beide Suiten müssen grün sein; sonst nachbessern vor dem Push.

### 4. Abschluss

- Push von `codex/plur1bus2hermes` zu origin (enthält dann auch den bisher ungepushten Commit `cd68d49`).
- Backup-Branch bleibt lokal bestehen.

## Fehlerbehandlung / Risiken

- **Merge-Konflikte:** Nur in den 3 bekannten Dateien erwartet; Lösungsregel oben. Unerwartete Konflikte → Merge aborten, Befund melden.
- **Paritätsbrüche:** Größtes fachliches Risiko (Port spiegelt 7.1.2). Fixes bleiben minimal und folgen den Mustern in `plur1bus-hermes/`.
- **Scope-Disziplin:** Keine unrelated Refactors, keine Upstream-Änderungen außer Konfliktlösung.
