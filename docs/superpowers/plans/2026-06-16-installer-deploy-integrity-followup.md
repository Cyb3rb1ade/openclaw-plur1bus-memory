# Installer / Deploy-Integrity Hotfix — 2026-06-16

Branch: `fix/installer-deploy-integrity-2026-06-16`

## 1. Incident Summary

During a routine OpenClaw update (2026.6.8-beta.2 → 2026.6.8), the deployed
`memory-lancedb-namespaced` extension failed to register after a gateway
restart:

```
[plugins] memory-lancedb-namespaced failed during register from
/root/.openclaw/extensions/memory-lancedb-namespaced/index.js:
TypeError: (0 , _neoArch.buildNeoWorkspaceAliases) is not a function
```

Memory capture/recall for all three agents (main, bernhardine, heisenberg)
would have silently stopped working at the next gateway restart, with no
crash and no operator-visible signal until someone went looking.

## 2. Betroffene Dateien

Deployed extension (`/root/.openclaw/extensions/memory-lancedb-namespaced/`):

- `lib/neo-arch.js` — overwritten with a one-line broken re-export stub:
  `export * from "../../lib/neo-arch.js";`, resolving to
  `/root/.openclaw/extensions/lib/neo-arch.js`, which does not exist.
- `lib/relevant-memory-context.js` — overwritten with a real but stale
  (older) version, missing newer exports/behavior. Not a broken stub, but a
  silent regression with the same delivery mechanism.
- `index.js` — also repeatedly reverted to a stale (but non-crashing) older
  version by the same mechanism (see Root Cause).

## 3. Root Cause — gefunden: ja

**`/root/.openclaw/scripts/protect-plur1bus-deploy.sh`**, installed
2026-06-15, runs via system cron every 15 minutes:

```
*/15 * * * * /root/.openclaw/scripts/protect-plur1bus-deploy.sh >/dev/null 2>&1
```

It compares the deployed extension against a "canonical source" via
`md5sum`, and on any mismatch, silently `cp -a`s the canonical source over
the deployed files and (usually) restarts the gateway. Its source default
was:

```bash
SRC="${PLUR1BUS_SRC:-/root/plur1bus}"
```

`/root/plur1bus/` is a **stale, partially-decayed leftover subdirectory**.
Git history shows the repo was restructured at commit `79c9124` ("chore:
remove test/, docs/, plur1bus/ dirs; sync openclaw.plugin.json to 5.1.9") to
move the real package source to the repo root (`index.js`, `lib/`, `tests/`).
After that, later feature commits kept accidentally re-adding *some* new
files under `plur1bus/lib/...` (duplicate copies, never reconciled), while
the directory as a whole was never fully migrated or removed. The result,
verified directly:

| File in `/root/plur1bus/` | State |
|---|---|
| `lib/neo-arch.js` | 1-line broken re-export stub: `export * from "../../lib/neo-arch.js";` |
| `lib/relevant-memory-context.js` | Real but stale/older content |
| `index.js` | Real but stale (4080 lines vs. 4580 in the real repo-root `index.js`) |
| `openclaw.plugin.json`, `lib/runtime-scheduler.js`, `lib/jobs/daily-consolidation.js`, `lib/feedback-log.js`, `lib/semantic-lens-index.js`, `lib/conversation-reactivation-recall.js`, `scripts/cleanup-stores.mjs`, `test/neo-maintenance.test.js` | **Missing entirely** |

`protect-plur1bus-deploy.sh`'s `FILES` list assumes `/root/plur1bus/` is a
complete, current mirror of the package — true when the script was written,
false since. Every time a correct deployment from the real source (repo
root) was synced into the live extension, this cron job detected "drift"
against its own stale/broken source and reverted the fix within at most 15
minutes. The corruption is invisible until the next plugin (re)registration
— i.e. the next gateway restart — which is why it surfaced during the
OpenClaw version update rather than immediately.

Confirmed via `/root/.openclaw/logs/protect-deploy.log`:
```
2026-06-16T19:15:02+0200 DRIFT detected: mismatch:index.js mismatch:lib/neo-arch.js mismatch:lib/relevant-memory-context.js
2026-06-16T19:15:03+0200 restored canonical source from /root/plur1bus
2026-06-16T19:15:03+0200 ERROR: restore failed, marker still missing
2026-06-16T19:30:02+0200 DRIFT detected: missing-marker:isInjectedContextText
2026-06-16T19:45:02+0200 DRIFT detected: missing-marker:isInjectedContextText
2026-06-16T20:00:03+0200 DRIFT detected: mismatch:index.js mismatch:lib/neo-arch.js mismatch:lib/relevant-memory-context.js
2026-06-16T20:15:01+0200 DRIFT detected: missing-marker:isInjectedContextText
```
— a corrupt-then-revert loop, every 15 minutes, since at least 2026-05-29
(the log's earliest entry).

## 4. Was gefixt wurde

1. **`protect-plur1bus-deploy.sh`** (both the live copy at
   `/root/.openclaw/scripts/` and the tracked mirror at
   `scripts/protect-plur1bus-deploy.sh` in this repo):
   - `PLUR1BUS_SRC` default changed from `/root/plur1bus` (stale) to `/root`
     (the real repo root).
   - Added a stub-guard: before copying any file from `SRC` to `DEPLOY`, it
     is checked with the same broken-re-export detector used by the new
     validator (`scripts/lib/deploy-integrity.mjs`). A broken source file is
     never propagated, regardless of what `PLUR1BUS_SRC` is ever set to
     again.
2. **`update-openclaw.sh`** (live copy only, not mirrored into this repo —
   see "Offene Risiken"): added a `PLUR1BUS DEPLOY-INTEGRITY` step that runs
   `scripts/verify-plugin-deploy.mjs --repair` immediately before the
   `GATEWAY NEUSTART` step. If the deploy cannot be brought to a healthy
   state, the update script now exits non-zero **before** restarting the
   gateway, instead of restarting into a broken plugin.
3. Live incident resolved: deployed `lib/neo-arch.js` and
   `lib/relevant-memory-context.js` restored from the repo, verified via a
   real gateway restart (clean registration, no errors in the journal).

## 5. Welche Guardrails jetzt existieren

New module `scripts/lib/deploy-integrity.mjs`:

- `detectBrokenStub(filePath)` — parses a file for pure re-export lines
  (`export * from "..."` / `export { ... } from "..."`) and resolves each
  target relative to the file's own directory. Flags the file as broken if
  it consists *only* of such lines and at least one target doesn't exist.
- `validateFile({ deployPath, repoPath })` — checks existence, broken-stub
  status, and SHA-256 match against the repo source.
- `repairFile({ deployPath, repoPath, dryRun })` — copies the repo source
  over the deployed file; no-op in dry-run mode.
- `validateDeployment({ deployDir, repoDir, files, repair, dryRun })` —
  drives the above across a file list, with per-file repair.
- `smokeTestExports(expectations)` — actually `import()`s each deployed
  file and checks the real, verified export names exist. This is the
  layer that would have caught the original bug even if checksum/stub
  detection somehow missed it.

CLI `scripts/verify-plugin-deploy.mjs` — wraps the above for the
`memory-lancedb-namespaced` plugin specifically, validating:
`index.js`, `openclaw.plugin.json`, `lib/neo-arch.js`,
`lib/relevant-memory-context.js`, `lib/memory-merge-safety.js`,
`lib/contradiction-detector.js`, `lib/recall-pipeline.js`, plus a real-import
smoke test against `buildNeoWorkspaceAliases`, `isInjectedContextText`,
`formatRelevantMemoriesContext`, `isSafeDuplicate`, `normalizeMemoryText`,
`ContradictionDetector`, `runRecallPipeline`, `computeUseAssociative` (all
names verified against the actual source files, not guessed).

## 6. Wie man `--dry-run` / `--repair` nutzt

```bash
# Check only, no writes, exit 1 if anything is wrong:
node scripts/verify-plugin-deploy.mjs \
  --repo-dir /root --deploy-dir /root/.openclaw/extensions/memory-lancedb-namespaced

# Same check, but auto-repair anything broken from the repo source:
node scripts/verify-plugin-deploy.mjs --repair \
  --repo-dir /root --deploy-dir /root/.openclaw/extensions/memory-lancedb-namespaced

# Report what repair *would* do, without touching any file:
node scripts/verify-plugin-deploy.mjs --repair --dry-run \
  --repo-dir /root --deploy-dir /root/.openclaw/extensions/memory-lancedb-namespaced
```

Defaults: `--deploy-dir` defaults to
`/root/.openclaw/extensions/memory-lancedb-namespaced`; `--repo-dir`
defaults to the current working directory. Exit code 0 = healthy (or fully
repaired); non-zero = unresolved violations remain.

`protect-plur1bus-deploy.sh` env vars (unchanged interface, new default):
`PLUR1BUS_SRC` (default now `/root`), `PLUR1BUS_DEPLOY`, `PLUR1BUS_GW`,
`PLUR1BUS_NO_RESTART=1`.

## 7. Verifikation

- `npm test`: 1350 tests, 1349 pass. The 1 failure
  (`tests/shared-memory-conflict-limit.test.js`) is a pre-existing timing
  threshold flake unrelated to this change (confirmed present on `origin/main`
  before this branch existed).
- `npm run lint`: pre-existing breakage, unrelated to this change — see
  "Offene Risiken".
- `npm audit --audit-level=moderate`: 0 vulnerabilities.
- `node scripts/verify-plugin-deploy.mjs --repair` against the live deploy:
  PASS (all 7 files OK, all 7 smoke-test imports OK).
- Live gateway restart after the fix: `memory-lancedb-namespaced: registered`
  clean, `enabling autoCapture`, zero errors/exceptions in the journal.
- Manually re-ran the fixed `protect-plur1bus-deploy.sh`: exits 0, no drift
  detected (previously it detected drift and corrupted the deploy on
  essentially every run since 2026-05-29).
- Full-tree check beyond the 7 validated files — `diff -rq /root/lib
  /root/.openclaw/extensions/memory-lancedb-namespaced/lib`, plus `cmp` on
  `index.js`, `openclaw.plugin.json`, `package.json`: all clean, no
  remaining drift anywhere in the deployed tree.

## 8. Offene Risiken

- **Recall/capture errors observed during the incident, not confirmed
  resolved.** While the deploy was still corrupted, the journal showed
  (20:06–20:11): `recall-pipeline: rerank failed/timeout... TypeError:
  Cannot read properties of undefined (reading 'summary')`,
  `memory-lancedb-namespaced: recall failed for agent=bernhardine`, and
  `MemoryDB.store timed out after 15000ms` / `capture worker timed out
  after 60000ms`. These are plausibly downstream of the stale
  `relevant-memory-context.js` (the `summary` property read) rather than a
  separate bug — but that's a hypothesis, not verified. After the fix +
  restart, zero recurrences of these specific messages in the journal as of
  this writing — but that only shows registration succeeded and the errors
  haven't fired again in a short window, **not** that recall/capture are
  functionally correct end-to-end. This hotfix verified deploy-integrity
  (files match repo, plugin registers cleanly across a real restart); it did
  not verify memory functionality, which is explicitly out of scope here.
  If these recur, treat as a separate memory-logic bug report.
- **`SRC=/root` coupling:** `protect-plur1bus-deploy.sh` now enforces
  whatever is currently checked out in the `/root` working tree onto the
  live deploy, every 15 minutes. Harmless today (this branch's new files
  aren't in the protect script's `FILES` list, so its enforced content is
  identical to `main`), but worth knowing: checking out a different branch
  in `/root` now has a live, automatic effect on the running extension.
- **`update-openclaw.sh` is not mirrored into this repo.** It lives at
  `/root/.openclaw/scripts/update-openclaw.sh`, outside any git tree, and is
  a large (1700+ line) general OpenClaw-gateway operator script, not specific
  to this plugin — bringing the whole file under this repo's version control
  was judged out of scope ("nicht den ganzen Installer neu bauen"). Its
  `PLUR1BUS DEPLOY-INTEGRITY` addition is documented here (section 4) but is
  **not diffable in this PR**. Whoever maintains that script should apply the
  same change if it's ever reset from a template.
- **`protect-plur1bus-deploy.sh` has a tracked mirror, but no automated
  sync.** `scripts/protect-plur1bus-deploy.sh` (this repo) and
  `/root/.openclaw/scripts/protect-plur1bus-deploy.sh` (live, cron) must be
  kept in sync by hand. A future improvement could have `update-openclaw.sh`
  rsync the tracked copy over the live one on every update.
- **`/root/plur1bus/` itself is still stale/decayed** and still committed to
  git. Nothing currently reads it now that `protect-plur1bus-deploy.sh`'s
  default points elsewhere, but it remains a landmine for any *other* tool
  that might trust it later. Recommend a follow-up to either fully delete it
  or fully re-sync it — out of scope for this hotfix (explicitly: no memory
  logic changes, no installer rebuild).
- **`npm run lint` is broken independent of this change.** The script's
  `find . -name '*.js' ...` runs from the repo root, which is also the
  operator's home directory (`/root`), and walks unrelated trees (`.local`,
  `.cache`, etc.), eventually choking on a non-JS file that matches the glob.
  Confirmed present before this branch (baseline check). Not fixed here —
  out of scope for an installer/deploy-integrity hotfix.
- **`smokeTestExports` import-cache caveat:** each smoke-test run appends a
  unique query string to force a fresh ES module evaluation (Node caches
  modules by resolved URL otherwise). This means repeated runs in the same
  long-lived process will accumulate module instances. Fine for a one-shot
  CLI invocation (the only current use); would need revisiting if ever used
  inside a long-running watcher process.

## 9. Nächster Installer-Block

Not scheduled — no concrete next installer work item exists yet. If/when
`/root/plur1bus/` cleanup or the `update-openclaw.sh` mirroring is picked up,
link back to this doc for context.
