# Review-Findings: PLUR1BUS 7.2.2 ↔ Hermes-Port

**Date:** 2026-08-04 · **Basis:** Merge `c225835` (origin/main v7.2.2 → codex/plur1bus2hermes) · **Fenster:** v7.1.2..v7.2.2
**Methode:** 5 parallele read-only Review-Lanes (Explore-Subagents via AgentSwarm).

## Übersicht

| Lane | Ergebnis |
|---|---|
| A — NEO/Episoden | Keine BREAKs. Port-NEO-Store liegt eigenständig unter `~/.hermes/plur1bus/neo/<agent>/`; einziger Upstream-Berührungspunkt ist die offline read-only Snapshot-Migration `_stage_neo`. Alle 6 geprüften Commits OK. |
| B — Embedding/Reindex | Keine BREAKs. Reindex-Bridge rein additiv, Pfade/Dimensionen/Endpoint-Shapes kompatibel. 2 Hinweise (s.u.). |
| C — Plugin-Deployment | **2 BREAKs** (C1, C2). Upstream-Deploy-Härtung selbst bricht nichts. |
| D — Crons/Index | **1 BREAK niedriger Schwere** (D1). Carrier-/Stagger-Änderungen für Port n/a bzw. schon besser gelöst. |
| E — Parität | **1 BREAK** (E1). 10 OK. Bestätigt Design-Annahme „Port ≈ 7.1.9": einziger BREAK liegt nach der Sync-Basis. |

## BREAK-Befunde

### C1 — `.gitignore` verschluckt 9 Branch-Deploy-Scripts

`scripts/*` + Allowlist (`.gitignore:26`): `mtplx-bind-agent.sh`, `install-mtplx-agent.sh`, `install-mtplx-embed-agent.sh`, `install-mtplx-embed.sh`, `mtplx-hermes-up`, `mtplx-embed`, `configure-hermes-omlx.sh`, `install-hermes-plugins.sh`, `run-hermes-workspace-migration-job.sh` sind ignored/untracked, werden aber von getrackten Dateien referenziert (`CHANGELOG.md:12-17`, `plur1bus-hermes/README.md:13,24`, `mtplx-embed/README.md:60-62,77`). Ein frischer Clone kann den dokumentierten Installationsweg nicht ausführen.
**Fix:** 9 Allowlist-Zeilen `!scripts/<name>` in `.gitignore`, Scripts committen (vorher auf Secrets prüfen).

### C2 — `package.json` `files` unvollständig

Branch nahm `plur1bus-hermes/` + `plur1bus-controls/` auf, nicht aber `mtplx-embed/` + `hermes-model-providers/` — inkonsistent zur eigenen Commit-Intention.
**Fix:** Beide Einträge in `files` ergänzen.

### D1 — Afterthought-/Proactive-Kadenz (niedrige Schwere)

`plur1bus-hermes/src/plur1bus_hermes/jobs.py:88-93`: Rate-Gate 1_800 s (altes Upstream-30-min-Intervall). Upstream `a130015` (7.1.9) hob auf 3 h — Motivation war Tokenverbrauch des Model-Carriers. **Lane-E-Gegenbefund:** Port-Afterthought ist LLM-frei/deterministisch (`proactive.py:203-208`), der Token-Grund greift nicht; die Stunden-Kadenz trifft das 30–120-min-Fenster (`proactive.py:197`) besser.
**Entscheidung:** Verhalten bleibt; als bewusste Divergenz per Kommentar in `jobs.py` dokumentieren (erfüllt Lane-Kriterium „dokumentierte Abweichung").

### E1 — Kein Retry bei fehlgeschlagenem Capture (Analogon zu 7.2.1 `de49e30`)

`plur1bus-hermes/src/plur1bus_hermes/runtime.py:471-485` (`_finish_future`): schlägt der Capture-Future fehl, landet der Turn nur in `capture-errors.jsonl` und wird nie erneut versucht; `capture-queue.jsonl` (`provider.py:432`) wird nirgends gelesen. Upstream 7.2.1 klassifiziert genau das als „dauerhafter Episodenverlust" und retryt ≤5× (`MAX_POSTPROCESSING_RETRIES`).
**Fix:** Retry-Pfad in `runtime.py` — fehlgeschlagene Payloads mit Retry-Zähler in `state/capture-retry.jsonl`, zu Beginn von `capture_async` erneut einreihen, nach 5 Versuchen laut warnen + aufgeben. TDD (pytest).

## OK-Nachweise (Auswahl)

- **A:** Lock-Takeover n/a (kein prozessübergreifendes Lock im Port, `threading.RLock` in `domain.py:67`); Turn-Stamps pro Turn frisch (`domain.py:72,98`); Tool-Result-Records generisch durchgereicht (`legacy_assets.py:175-190`); 6f64111-Migration löscht Legacy-Quellen nie.
- **B:** Provider-Vertrag `embedPassage()`/`dimensions()` vorhanden; `{model, input, encoding_format, instruction?}`-Shape identisch JS/Port/Sidecar; 4096-dim beidseitig config-getrieben; Branch-Tests embedding-cache 44/44, providers 8/8 grün.
- **C:** `openclaw.plugin.json` byte-identisch mit 7.2.2; beide branch-geänderten `lib/`-Dateien in DEPLOY_FILES; Versions-Preflight (fc0b5ce) besteht.
- **D:** Consolidation-Stagger dfe2931 n/a — Port hat eigenes Per-Agent-Staggering von Anfang an (`job_install.py:56-61`); Carrier-Cluster n/a (launchd + Python direkt, kein Model-Carrier).
- **E:** 7.1.4 agentId n/a (kein host-Route im Port); 7.1.5/7.1.6 temperature dokumentierte Abweichung (`llm_backend.py:51-59`); 7.1.5 LanceDB-Timeout strukturell erfüllt (synchrones python-lancedb); `:active-memory:`-Skip n/a.

## Hinweise (kein Fix in diesem Plan)

- **Upstream-Test-Bug (macOS):** 9 neue Upstream-Tests rot (`promoted-memory-reindex.test.js` 3, `embed-promoted-memories-cli.test.js` 6) — `resolveInside` realpath'd (`lib/sql-safety.js:99`), Tests nutzen unresolvte `/var`-Pfade. Byte-identisch zu v7.2.2, nicht merge-induziert. Wird in Task 6 verifiziert; falls reproduziert, minimaler Fix in `lib/promoted-memory-reindex.js` (realpath-Normalisierung) und **als Upstream-Fix-Kandidat melden**.
- **`queryInstruction` inert auf JS-Seite:** `lib/providers/config-normalize.js:55-73` whitelistet das Feld weg; optionaler 1-Zeilen-Fix, nicht merge-relevant.
- **Gen3-Blindstelle (prä-existent):** `_stage_neo` ignoriert kanonische `<name>--<hash>`-Verzeichnisse; existiert seit v7.1.0, kein Fenster-Bruch. Optionaler Fix: Alias-Menge in `legacy_assets.py:115` um kanonische Dirs ergänzen.
- **Hygiene:** `* 2.py`-iCloud-Duplikate im Port (`provider 2.py` weicht ab, Rest byte-identisch). Kein Laufzeiteffekt; separat aufräumen.
- **`scripts/create-openclaw-memory-snapshot.sh`** ebenfalls ignored/untracked, aber unreferenziert — beim C1-Fix mit erfassen oder löschen.
