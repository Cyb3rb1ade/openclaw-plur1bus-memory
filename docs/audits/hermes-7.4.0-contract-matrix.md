# Hermes 7.4.0 — Commit-/Vertragsmatrix `v7.3.4..v7.4.0`

Portierungsfenster: `v7.3.4..v7.4.0` (25 Commits, Peel `3479373f87dc8f70d460d09ddeb20ffb83355231`).
Merge in `codex/plur1bus2hermes`: `b664d5d` (`--no-ff`, Ancestry bewiesen).

Legende Status: **JS** = direkt übernommen (mitgeliefertes OpenClaw-Paket) ·
**PY** = Python-Port erforderlich und umgesetzt · **NR** = nachweislich nicht
erreichbar in Hermes (dokumentiert, keine Scheinschnittstelle).

| Upstream-Commit | Dateien | Vertrag | JS/OpenClaw-Pfad | Erreichbarer Hermes-Pfad | Status | Regressionstest |
|---|---|---|---|---|---|---|
| b3dfc16 (7.3.5) | `lib/dreaming/rem-dream.js` | Ähnlichkeit echt aus Vektoren (Kosinus), Index nur topK-Vorauswahl | `buildSparseNeighborGraph` | `dreaming.build_rem_dream` (Token-Jaccard echt gemessen, keine Distanz-Umformung) | JS + PY | `tests/rem-dream-similarity-scale.test.js`, `test_rem_dream_similarity.py` |
| b3dfc16 (7.3.5) | `lib/setup/feature-cron-plan.js`, `scripts/setup-feature-crons.mjs` | Keine Cron-Namens-/Schedule-Kollisionen, GC genau einmal | OpenClaw-Cronplan | OpenClaw-Cronpfad existiert in Hermes nicht; Hermes-Äquivalent: launchd-Staggering `(i*17)%60` / `(15+i*13)%60`, eindeutige Labels, agent-gebundenes GC | JS + PY (Äquivalent) | `tests/feature-cron-fresh-install-collisions.test.js`, `test_job_install.py` |
| 825243a | `lib/epistemic-capture.js` | User-Captures `observed`, andere Writes `untrusted`, `""` bleibt Legacy, Injektion → `untrusted` | `MemoryDB.store`, Store-Pfade | `runtime._remember` (einziger Karten-Neuschreibpfad), Epistemik-Spalte idempotent | JS + PY | `tests/epistemic-capture.test.js`, `test_epistemic_capture.py` |
| 825243a | `lib/epistemic-cutoff.js`, `lib/fsync-atomic.js` | Cutoff beim ersten Upgrade vor erstem Write, frühester `since` gewinnt, fail-closed | Plugin-Init + Store | `runtime.__init__` → `epistemic.ensure_epistemic_cutoff`, Downgrade `observed→untrusted` bei defektem Cutoff | JS + PY | `tests/epistemic-cutoff.test.js`, `test_epistemic_cutoff.py` |
| 825243a, 3e07caa, 1954ef4 | `lib/jobs/skill-miner*.js`, `lib/telegram-commands/skill-commands.js` | Miner-Admission ohne 30-Tage-Lookback, SKILL.md erst nach Approve, crash-sicher, Confirm-Tokens | Skill-Miner-Cron + Telegram | Kein Skill-Miner und keine Telegram-Oberfläche in Hermes (`parity.py`: `skill-farming` excluded); Epistemikvertrag gilt trotzdem für alle Hermes-Writes (s. o.) | JS + NR | `tests/skill-miner-*.test.js` (JS-seitig) |
| 825243a, 00897e4, 02e9db2 | `lib/tombstone-write-guard.js`, `index.js`, `scripts/auto-capture-lancedb.mjs`, `lib/dreaming/light-dream.js`, `lib/jobs/memory-compaction.js` | Jeder erreichbare Reinsert prüft Registry vor `table.add`; Content-Update prüft neuen Text; Same-Text-Replay ungeblockt; Light-Dream-Refusal vor Delete | Store/Update/updateCard/Compaction/Auto-Capture/Light-Dream | `runtime._remember` ✓ (bestand), `correct_async` (neuer Text über `_remember`) ✓; **neu:** Migrations-Writer (`migrate._copy_agent_cards`, `workspace_migrate._stage_agents`) mit Ziel-Registry-Guard; GC/Consolidation proposal-only, Reembed kopiert unverändert, Light-Dream nicht vorhanden | JS + PY | `tests/tombstone-*.test.js`, `test_tombstone_migration_guard.py` |
| a5be9b5 | `lib/inject-budget.js` | `recall.globalInjectMaxChars` Default 17000, Memory vor Zeit/Reminder gekürzt | `prependContext`-Assembly | `runtime.recall` ersetzt hartes `[:12000]`; Blocks memories/overlay/explanation droppable, compression non-droppable; Zeit/Reminder laufen in Hermes nicht durch diesen String | JS + PY | `tests/inject-budget.test.js`, `test_inject_budget.py` |
| a5be9b5 | `lib/prompt-memory-fields.js` | Prompt-Labels status/epistemic vereinheitlicht | Recall-Renderer | Hermes-Recall rendert schlichte Liste ohne Statuslabels; keine Label-Semantik erreichbar | JS + NR | `tests/prompt-memory-fields.test.js` |
| a5be9b5, a05dd11, 2aae511, bf823fb, b97cfe3 | `lib/curation-resolve.js`, `lib/drop-injected-conflicts.js`, `lib/jobs/apply-conflict-resolution.js` | Curation `keep\|drop`, `drop-injected` mit Preview+Nonce, Drift-Gate, IDOR-frei | `/plur1bus curation …` + Conflict-Apply-Job | Kein neo-`conflict`-Bestand, keine Behavior-Cards, keine injizierten Konflikte in Hermes; Controls-`critical accept\|reject\|edit` bleibt unverändert nonce-gebunden | JS + NR | `tests/curation-resolve.test.js`, `tests/drop-injected-conflicts.test.js` |
| a5be9b5, 9aeb02d | `lib/neo-arch.js`, `lib/episodes.js`, `lib/memory-graph.js`, `lib/dreaming/*.js` | Derived Records tragen Visibility; Reader prüfen Requester; Legacy ohne Stamp nur Own-Agent; rem-dream reicht Requester durch | neo-store append/read | Physische Scope-Partition (`neo/scopes/<key>`) + `aclBindings`-Stempel + `_row_matches_scope` Legacy-Fallback (bestand seit 7.3.1); **neu:** `visibility`-Objekt auf Dream-Records | JS + PY | `tests/derived-record-scope.test.js`, `test_rem_dream_visibility.py` |
| 72bbe5e | `lib/neo-arch.js` `isInjectedContextText` | Inject-Erkennung nur Zeilen-Header | neo-capture | **neu:** `inject_markers.py` (Zeilen-Header + Quick-Marker + JSON-Hints + Prompt-Injection-Regex), konsumiert von Epistemik-Capture | JS + PY | `tests/neo-tool-results.test.js`, `test_inject_markers.py` |
| 3479373 (7.4.0) | `scripts/install-memory-system.sh`, `scripts/setup-feature-crons.mjs` | `PLUR1BUS_SKIP_HOST_PATCH=1` konsistent, kein Host-Patch-Removal | OpenClaw-Installer | Beide mitgelieferten OpenClaw-Pfade übernommen; Hermes-Installer patcht nie den Host und wählt nie Provider/Modell | JS | `tests/host-patch-skip.test.js` |
| 3479373 (7.4.0) | `openclaw.plugin.json` | Schema `recall.globalInjectMaxChars` | Manifest | Merge übernommen; Python liest `recall.globalInjectMaxChars` aus Plugin-Config | JS + PY | `test_inject_budget.py` |
| — (Hermes-Befund) | `scripts/install-hermes-plugins.sh` | Sidecar-Fehler darf Hauptplugin-Aktivierung nicht überspringen | — | **neu:** Sidecar-Aufruf fehlertolerant mit Warnung | PY | `mtplx-embed/tests/test-hermes-plugin-installer.sh` |

## Ausdrückliche 7.4.0-Non-Goals (dürfen nicht versehentlich eingeführt werden)

- kein Hard-Filter für `conflict` — Python besitzt keinen `conflict`-Kartenstatus;
  Konflikt-Empfehlungen bleiben proposal-only, Karten behalten `active` und Recall-Sichtbarkeit.
- kein automatisches Konflikt-Resolve — kein Auto-Apply irgendwo (Consolidation proposal-only).
- keine Entfernung des Host-Patches — unverändert, nur optional überspringbar.
- kein Weight-Retuning — keine Score-Gewichte angefasst.
- kein Wechsel des konfigurierten Chat-Providers/Modells — Installer/Controls unverändert.
- keine Datenmigration produktiver LanceDB-Speicher — keine.
