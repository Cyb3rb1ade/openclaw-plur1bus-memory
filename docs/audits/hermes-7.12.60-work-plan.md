# Hermes 7.12.60 work plan

Baseline: published `7.12.56-hermes.0`, source `75f272fbf0127dea1ccea1cfaee7fdd9142466f4`.
Upstream target: `v7.12.60`, source `bcb80ccef6ce5ab9e4604cfe923901885cc59d9e`.
Exact delta: seven commits, 22 changed paths (13 production/metadata/docs, nine tests).
Worktree: `plur1bus-hermes-7.12.60-release`, branch `codex/hermes-port-7.12.60`.

## Tasks

1. Merge the official upstream tag, retain all Hermes code/history, align candidate versions.
2. Port afterthought candidate selection/window and explicit corrections to native open threads.
3. Honor the common background model on the native internal backend without changing existing explicit model/transport settings.
4. Port bounded compaction conflict retries; preserve authorization/exact generation selection.
5. Preserve REM retryability when narrative construction fails; native REM is deterministic, not an OpenClaw LLM job.
6. Adapt the primary-agent UI to Hermes' authoritative active profile, not a cross-profile scan or OpenClaw channel bindings.
7. Verify scheduler remains usable without channel bindings; retain profile selection, activation, migrations, Workshop and retrieval controls.
8. Review upstream changes, report reproducible defects through an issue or PR.
9. Run focused RED/GREEN regressions, complete local Python/JS/UI/installer gates, build and inspect candidate packages.
10. Document measured results and propose actual performance/token improvements separately. Do not implement optional optimizations or change timeouts to claim a speedup.

## Boundaries

Do not modify the user's dirty original checkout, productive Hermes profiles,
memories, model/provider selection or existing releases. This request authorizes
the port, tests and upstream bug reports; a new public release/local activation
is a separate action. Windows native execution and macOS signing are separate
from local package construction and must never be inferred from it.

## Progress

- Baseline/tag verified remotely; dedicated worktree created.
- Upstream merge staged; four metadata/history conflicts resolved without losing Hermes history.
- Temporary QA Python environment and clean npm dependencies provisioned.
- Native regression tests written before implementation; new focused gates green.
- Complete upstream delta retained and native adaptations implemented/documented.
- Both UI harnesses green; full JS suite green (4,668 passed, 76 skipped).
- Upstream defect #155 reported; existing optional-JS audit issue #150 updated.
- Final Python, host integration and artifact verification in progress.
