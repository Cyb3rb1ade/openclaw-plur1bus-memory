# PLUR1BUS 7.2.2 → Hermes-Branch Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring `codex/plur1bus2hermes` up to PLUR1BUS 7.2.2 — merge `origin/main`, verify the Hermes port against the full change window v7.1.2..v7.2.2, run both test suites, push.

**Architecture:** Mechanical merge first (only `CHANGELOG.md` can conflict), then five read-only review lanes dispatched as parallel explore subagents, then minimal fixes with regression tests, then verification and push. Spec: `docs/superpowers/specs/2026-08-04-plur1bus-722-hermes-merge-design.md`.

**Tech Stack:** git, Node.js (`npm test`), Python/pytest (`plur1bus-hermes/`), parallel subagents.

**Repo:** `/Users/cyberblade/Documents/GitHub/openclaw-plur1bus-memory`, branch `codex/plur1bus2hermes` (HEAD before start: `26c7b6f`).

---

### Task 1: Backup-Branch + Merge

**Files:**
- Keine Dateiänderungen — reine git-Operationen.

- [ ] **Step 1: Backup-Branch anlegen**

```bash
cd /Users/cyberblade/Documents/GitHub/openclaw-plur1bus-memory
git branch backup/plur1bus2hermes-pre-722
git branch --list 'backup/*'
```
Expected: `backup/plur1bus2hermes-pre-722` zeigt auf denselben Commit wie HEAD (`26c7b6f`).

- [ ] **Step 2: Merge ausführen**

```bash
git merge origin/main --no-edit
```
Expected: Merge läuft. `package.json` und `.gitignore` mergen automatisch (Branch und Upstream haben disjunkte Regionen geändert). Einziger möglicher Konflikt: `CHANGELOG.md` (beide Seiten haben direkt nach `## [Unreleased]` eingefügt).

- [ ] **Step 3: Merge-Status prüfen**

```bash
git status --short
```
Expected: Entweder sauber (Merge-Commit erstellt) oder `UU CHANGELOG.md`. Falls `UU`: weiter mit Task 2. Falls sauber: Task 2 überspringen, direkt zu Task 3.

### Task 2: CHANGELOG-Konflikt lösen (nur falls nötig)

**Files:**
- Modify: `CHANGELOG.md` (Konfliktbereich direkt nach `## [Unreleased]`)

- [ ] **Step 1: Konflikt ansehen**

```bash
sed -n '1,60p' CHANGELOG.md
```

- [ ] **Step 2: Auflösen — Branch-Block VOR den Upstream-Releases behalten**

Semantik: Die Branch-Einträge sind Unreleased-Änderungen und gehören direkt unter `## [Unreleased]`; die Upstream-Sektionen `## [7.2.2]`, `## [7.2.1]`, `## [7.2.0]` folgen danach. Konfliktmarker entfernen, Reihenfolge:

```markdown
## [Unreleased]

### Added

- **`mtplx` Hermes model provider.** ...
- **`scripts/install-mtplx-agent.sh` gained `--depth` and `--force-unverified`.** ...
- **`InternalLlmBackend` honours an optional `llm.requestExtra` object** ...
- **`scripts/install-mtplx-agent.sh`** — LaunchAgent ...
- **`scripts/mtplx-bind-agent.sh`** — bind one Hermes home ...
- **`mtplx-embed` sidecar.** ...

## [7.2.2] — 2026-08-03
```

(Die sechs `### Added`-Bullets stehen vollständig auf der Branch-Seite des Konflikts; wörtlich übernehmen, nicht kürzen.)

- [ ] **Step 3: Merge abschließen**

```bash
git add CHANGELOG.md
git commit --no-edit
git log --oneline -1
```
Expected: Merge-Commit „Merge remote-tracking branch 'origin/main' into codex/plur1bus2hermes".

- [ ] **Step 4: Auto-gemergte Dateien verifizieren**

```bash
grep -m1 '"version"' package.json
grep -c 'plur1bus-hermes/\|plur1bus-controls/' package.json
grep -c '__pycache__/\|migrate-neo-workspace-generations' .gitignore
```
Expected: `"version": "7.2.2"`, `2`, `2`. Bei Abweichung: manuell korrigieren (Branch-Zeilen in `package.json` „files": `"plur1bus-hermes/",` + `"plur1bus-controls/",`; `.gitignore`: Branch-Anhang `__pycache__/ … * 2/` muss am Ende stehen) und mit `git add … && git commit --amend --no-edit` nachziehen.

### Task 3: Fünf Review-Lanes als parallel Explore-Subagents dispatchen

**Files:**
- Create (durch Lane-Berichte, Task 4): `docs/superpowers/specs/2026-08-04-plur1bus-722-hermes-review-findings.md`

- [ ] **Step 1: Fünf explore-Subagents parallel dispatchen** (ein Agent-Aufruf pro Lane, alle in einer Nachricht, `subagent_type: "explore"`, thoroughness „medium"). Jeder Prompt enthält: Repo-Pfad, Branch `codex/plur1bus2hermes`, Review-Fenster `v7.1.2..v7.2.2`, und die Lane-Definition unten. Jeder Agent soll zurückliefern: Liste geprüfter Stellen, je Befund `BREAK` (Port muss angepasst werden) oder `OK` (kurz begründet), mit Datei:Zeile.

**Lane A — NEO/Episoden:**
- Upstream-Seite: `git log --oneline v7.1.2..v7.2.2 -- lib/neo-arch.js lib/episode-watermark.js` und die Diffs dazu (Lock-Takeover `d22d10f`, Timestamps `edac450`, Tool-Result-Capture `1dd4754`, Watermark `de49e30`).
- Port-Seite: `grep -rn "neo\|episode" plur1bus-hermes/src/ --include='*.py' -il`, dann prüfen, ob der Port NEO-Dateien/Journal selbst schreibt/liest und ob Lock-/Watermark-/Tool-Result-Semantik annähernd gespiegelt ist.
- BREAK-Kriterium: Port-Code berührt dieselben NEO-Artefakte mit alter Semantik (z. B. eigenes Lock ohne Stale-Recovery, fehlende Turn-Stamps).

**Lane B — Embedding/Reindex:**
- Upstream-Seite: `git log --oneline v7.1.2..v7.2.2 -- lib/promoted-memory-reindex.js scripts/embed-promoted-memories.mjs lib/embedding-cache.js lib/providers/embedding-openai.js` plus Diffs.
- Port-Seite: `mtplx-embed/`, `plur1bus-hermes/src/plur1bus_hermes/` (Embedding-Client, Cache), dazu `git diff v7.1.9...HEAD -- lib/embedding-cache.js lib/providers/embedding-openai.js` (Branch-Änderungen müssen mit Upstream-Stand koexistieren — Upstream hat diese Dateien im Fenster nicht geändert, also nur Konsistenz prüfen).
- BREAK-Kriterium: Reindex-Bridge erwartet JS-Artefakte/Pfade, die der Port anders belegt; Embedding-Dimensionen/Endpoints inkompatibel (4096-dim Qwen3 lt. CHANGELOG).

**Lane C — Plugin-Deployment:**
- Upstream-Seite: `git log --oneline v7.1.2..v7.2.2 -- openclaw.plugin.json scripts/verify-plugin-deploy.mjs scripts/lib/deploy-integrity.mjs scripts/repair-installed-plugin.mjs` plus Diffs (Deploy-Manifest enthält jetzt `package.json`, vgl. `93f668d`).
- Port-Seite: `openclaw.plugin.json` im Merge-Stand, `plur1bus-controls/`, `hermes-model-providers/`, `scripts/install-mtplx-*.sh`, `scripts/mtplx-*.sh` — prüfen, ob Deploy-/Verify-Manifeste die Hermes-Dateien erfassen müssen und ob `.gitignore`-Muster (`scripts/*` + Allowlist) die Branch-Scripts korrekt tracken (`git check-ignore -v` pro Script).
- BREAK-Kriterium: Branch-Dateien, die deployed/verifiziert werden müssten, fehlen im Manifest oder werden ignoriert.

**Lane D — Crons/Index:**
- Upstream-Seite: `git log --oneline v7.1.2..v7.2.2 -- index.js lib/setup/feature-cron-plan.js lib/setup/feature-cron-bootstrap.js lib/runtime-scheduler.js lib/internal-cron-reply.js` plus Diffs (gestaffelte Consolidation `dfe2931`, Carrier-Entfernung `c1ebbe7`, Token-Sparen `a130015`).
- Port-Seite: Cron-/Proactive-Code in `plur1bus-hermes/src/plur1bus_hermes/` (`grep -rn "cron\|schedule" --include='*.py'`), `plur1bus-controls/`.
- BREAK-Kriterium: Port übernimmt Cron-Schedules, die Upstream geändert hat (Staggering, kein Model-Carrier), ohne die Änderung.

**Lane E — Parität (Sicherheitsnetz, ganzes Fenster):**
- Upstream-Seite: `git log --oneline v7.1.2..v7.2.2 -- lib/runtime-scheduler.js lib/llm-router.js lib/afterthought.js lib/db-adapter.js index.js` plus Diffs.
- Port-Seite: gespiegelte Module in `plur1bus-hermes/src/plur1bus_hermes/` (Scheduler→Hermes-Cron, LLM→`ctx.llm`, Capture/Recall), `plur1bus-hermes/tests/test_parity.py` lesen — dokumentiert der Test, welche Upstream-Behaviors abgedeckt sind?
- BREAK-Kriterium: Upstream-Behavior-Änderung 7.1.2→7.2.2, die der Port weder enthält noch bewusst abweicht (Abweichung muss im Code-Kommentar stehen, wie in `llm_backend.py:51-59`).

- [ ] **Step 2: Lane-Berichte einsammeln**

Expected: 5 Berichte mit BREAK/OK-Befunden. Keine Code-Änderungen durch die Lanes (read-only).

### Task 4: Findings-Dokument schreiben

**Files:**
- Create: `docs/superpowers/specs/2026-08-04-plur1bus-722-hermes-review-findings.md`

- [ ] **Step 1: Dokument anlegen** — Struktur: eine Sektion pro Lane (A–E), darunter je Befund: `BREAK` oder `OK`, Datei:Zeile, ein Satz Begründung. BREAK-Befunde zusätzlich mit geplantem Minimal-Fix.

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/specs/2026-08-04-plur1bus-722-hermes-review-findings.md
git commit -m "docs: 7.2.2 hermes review lane findings"
```

### Task 5: BREAK-Befunde fixen (überspringen, wenn keine)

**Files:**
- Modify: die je Befund im Findings-Dokument genannten Port-Dateien
- Test: `plur1bus-hermes/tests/test_<bereich>.py` (Python-Port) bzw. `tests/<bereich>.test.js` (JS-Seite)

- [ ] **Step 1: Pro BREAK-Befund, TDD:** Erst Regressionstest schreiben, der das erwartete 7.2.2-Verhalten am Port festnagelt; Test muss fehlschlagen. Konventionen: Python-Tests liegen in `plur1bus-hermes/tests/` (pytest, plain `assert`), JS-Tests in `tests/` (node:test via `npm test`).

- [ ] **Step 2: Minimalen Fix implementieren** — nur den Befund, Muster aus derselben Datei folgen. Keine Refactors.

- [ ] **Step 3: Test grün machen + Commit pro Befund**

```bash
cd plur1bus-hermes && python -m pytest tests/test_<bereich>.py -q && cd ..
git add <geänderte dateien>
git commit -m "fix: <befund-kurz> (7.2.2 parity)"
```

### Task 6: JS-Suite grün

**Files:**
- Keine neuen Dateien.

- [ ] **Step 1: Suite laufen lassen**

```bash
npm test 2>&1 | tail -20
```
Expected: alle Tests passieren (inkl. neuer Upstream-Tests wie `tests/neo-lock-takeover.test.js`, `tests/promoted-memory-reindex.test.js`).

- [ ] **Step 2: Bei Rot:** Failing Test → Ursache (Merge-Artefakt vs. echter Bruch) → minimal fixen wie Task 5 → erneut Step 1.

### Task 7: Python-Suite grün

- [ ] **Step 1: Suite laufen lassen**

```bash
cd plur1bus-hermes && python -m pytest -q 2>&1 | tail -10; cd ..
```
Expected: alle Tests passieren. (Falls `pytest` fehlt: vorhandenes venv des Projekts nutzen — zuerst `ls plur1bus-hermes/.venv 2>/dev/null` prüfen; kein globales Install.)

- [ ] **Step 2: Bei Rot:** wie Task 6, Step 2.

### Task 8: Push

- [ ] **Step 1: Finaler Status**

```bash
git status -sb
git log --oneline origin/main..HEAD | head -20
```
Expected: Working tree sauber; Liste enthält Merge-Commit, Spec-/Findings-Commits, ggf. Fix-Commits.

- [ ] **Step 2: Pushen**

```bash
git push origin codex/plur1bus2hermes
```
Expected: Remote-Branch aktualisiert (enthält damit auch den vorher ungepushten Commit `cd68d49`).

- [ ] **Step 3: Abschluss-Verify**

```bash
git fetch origin && git status -sb
```
Expected: `## codex/plur1bus2hermes...origin/codex/plur1bus2hermes` ohne ahead/behind.
