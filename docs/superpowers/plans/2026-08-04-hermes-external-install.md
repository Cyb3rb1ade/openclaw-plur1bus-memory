# Hermes-Port extern installierbar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** External users can install the PLUR1BUS Hermes port via pip Git-URL, documented in the root README, anchored to a pushed `hermes-v0.1.0` tag with a GitHub release.

**Architecture:** Packaging already exists (pyproject.toml in both subprojects). Plan = verify git-URL install in a fresh venv first (fix packaging if broken), insert one README section, then tag + release. Spec: `docs/superpowers/specs/2026-08-04-hermes-external-install-design.md`.

**Tech Stack:** Python ≥3.11 venv, pip git-URL installs, GitHub `gh` CLI.

**Repo:** `/Users/cyberblade/Documents/GitHub/openclaw-plur1bus-memory`, branch `codex/plur1bus2hermes`.

---

### Task 1: pip-Git-URL-Installation verifizieren

**Files:**
- Keine Repo-Änderung erwartet (nur falls der Build bricht: minimaler Fix an `plur1bus-hermes/pyproject.toml` bzw. `plur1bus-controls/pyproject.toml`).

- [ ] **Step 1: Frisches venv mit Base-Env-Sichtbarkeit anlegen**

```bash
python3 -m venv --system-site-packages /tmp/hermes-ext-venv
/tmp/hermes-ext-venv/bin/pip install --quiet --upgrade pip
```
(`--system-site-packages`, damit schwere Dependencies wie lancedb/torch aus dem bestehenden Miniforge-Env aufgelöst werden und kein Multi-GB-Download nötig ist.)

- [ ] **Step 2: Beide Pakete via Git-URL (file://-Äquivalent zum dokumentierten https-URL) installieren**

```bash
/tmp/hermes-ext-venv/bin/pip install "git+file:///Users/cyberblade/Documents/GitHub/openclaw-plur1bus-memory#subdirectory=plur1bus-hermes"
/tmp/hermes-ext-venv/bin/pip install "git+file:///Users/cyberblade/Documents/GitHub/openclaw-plur1bus-memory#subdirectory=plur1bus-controls"
```
Expected: beide enden mit `Successfully installed plur1bus-hermes-0.1.0 …` bzw. `plur1bus-controls-0.1.0`. **Achtung:** pip installiert den zuletzt gepushten Git-Stand — vorher `git status` prüfen (sauber) und nötige Commits vorziehen. Bei Build-Fehler: Ursache in der jeweiligen `pyproject.toml` minimal fixen, committen, Step 2 wiederholen.

- [ ] **Step 3: Import- und CLI-Smoke**

```bash
/tmp/hermes-ext-venv/bin/python -c "import plur1bus_hermes, plur1bus_controls; print('imports ok')"
/tmp/hermes-ext-venv/bin/plur1bus-hermes --help | head -5
```
Expected: `imports ok`, danach CLI-Hilfe. Falls der CLI-Import eine Heavy-Dependency zieht, die im Base-Env fehlt: mit `/tmp/hermes-ext-venv/bin/pip install <dep>` nachinstallieren und als Doku-Hinweis merken (nicht in pyproject ändern, wenn die Dep bereits deklariert ist).

- [ ] **Step 4: Regression — bestehende Suite bleibt grün**

```bash
cd /Users/cyberblade/Documents/GitHub/openclaw-plur1bus-memory/plur1bus-hermes
PYTHONPATH="src:../plur1bus-controls/src" python3 -m pytest -q 2>&1 | tail -2
```
Expected: `151 passed`.

### Task 2: Root-README Hermes-Beta-Abschnitt

**Files:**
- Modify: `README.md` (neuer Abschnitt zwischen dem `openclaw.json`-Hinweis am Ende von `## Installation` und `## Configuration`)

- [ ] **Step 1: Abschnitt einfügen** — exakt dieser Text (Englisch, passend zum README-Stil):

```markdown
## Hermes port (beta)

PLUR1BUS also ships as a Python memory provider for Hermes — no Node.js
runtime is required on the Hermes side.

**Requirements:** Hermes 0.19 or newer, Python 3.11 or newer. If Hermes runs
inside a virtual environment, export `HERMES_PYTHON=/path/to/that/python`
before installing so the runtime and the PLUR1BUS dependencies land in the
same environment.

Install both packages from the `hermes-v0.1.0` tag:

```bash
pip install "git+https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory.git@hermes-v0.1.0#subdirectory=plur1bus-hermes"
pip install "git+https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory.git@hermes-v0.1.0#subdirectory=plur1bus-controls"
```

The default embedding and reranking backends are local models
(`intfloat/multilingual-e5-base`, `BAAI/bge-reranker-v2-m3`); the first
install downloads several GB of dependencies (torch, sentence-transformers,
LanceDB).

For the full setup — credential prompts, `memory.provider: plur1bus`,
disabling Hermes' built-in `MEMORY.md`/`USER.md` injection, and enabling the
controls plugin — clone this repository and run:

```bash
scripts/install-hermes-plugins.sh
```

**Beta status:** the provider is installable and lifecycle-correct, but full
PLUR1BUS feature parity is still tracked in the migration plan — do not use
it for a production cutover yet. See `plur1bus-hermes/README.md` for details.
```

(In Markdown-Verschachtelung beachten: die zwei inneren bash-Blöcke stehen als eigene fenced blocks im Abschnitt.)

- [ ] **Step 2: Rendering-Sanity-Check**

```bash
grep -n '## Hermes port (beta)' README.md && grep -c 'hermes-v0.1.0' README.md
```
Expected: Zeilennummer des Abschnitts + mindestens `2` Treffer der Tag-Referenz.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document external hermes port installation (beta)"
```

### Task 3: Tag + GitHub Release

**Files:**
- Keine Dateiänderungen — git/GitHub-Operationen. Voraussetzung: Tasks 1–2 abgeschlossen und committed.

- [ ] **Step 1: Branch pushen**

```bash
cd /Users/cyberblade/Documents/GitHub/openclaw-plur1bus-memory
git push origin codex/plur1bus2hermes
```
Expected: Remote aktualisiert (enthält Spec-, README- und etwaige Packaging-Fix-Commits).

- [ ] **Step 2: Tag setzen und pushen**

```bash
git tag -a hermes-v0.1.0 -m "PLUR1BUS Hermes port 0.1.0 (beta) — first external install drop"
git push origin hermes-v0.1.0
git ls-remote --tags origin | grep hermes-v0.1.0
```
Expected: Tag auf dem README-Commit, Remote zeigt ihn.

- [ ] **Step 3: GitHub Release anlegen**

```bash
gh release create hermes-v0.1.0 \
  --title "PLUR1BUS Hermes port v0.1.0 (beta)" \
  --notes "First external install drop of the Python Hermes port (provider + controls), synced to PLUR1BUS 7.2.2.

Install:
\`\`\`bash
pip install \"git+https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory.git@hermes-v0.1.0#subdirectory=plur1bus-hermes\"
pip install \"git+https://github.com/Cyb3rb1ade/openclaw-plur1bus-memory.git@hermes-v0.1.0#subdirectory=plur1bus-controls\"
\`\`\`

Requirements: Hermes ≥ 0.19, Python ≥ 3.11. Default backends are local models (e5-base embeddings, bge-reranker-v2-m3) — first install downloads several GB (torch, sentence-transformers, LanceDB).

Beta: lifecycle-correct and installable, but not a production cutover — full parity is tracked in the migration plan. Verified: pytest 151/151, npm suite 3339 pass / 0 fail on macOS."
```

- [ ] **Step 4: Final-Verify**

```bash
gh release view hermes-v0.1.0 --json tagName,name,url
git status -sb
```
Expected: Release-Metadaten mit URL; Branch synchron mit origin, Arbeitsbaum sauber.

- [ ] **Step 5: Aufräumen**

```bash
rm -rf /tmp/hermes-ext-venv
```
