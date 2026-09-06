# Hermes 7.12 feature recheck and local retrieval inventory

This is a **partial implementation checkpoint**, not a full-parity or release
certificate. Version strings remain `7.12.0-hermes.2` / `7.12.0.post2`; earlier
packages do not automatically contain these later source changes.

## Answer to the feature question

No: all PLUR1BUS features are not yet fully ported. The machine-readable
`plur1bus_hermes.parity` report deliberately remains `partial`, and `--strict`
must still exit nonzero. A passed test suite is not evidence of absent features.

The historical matrices mix genuinely missing implementations, intentionally
different native implementations, and unfinished acceptance. Rechecking current
source corrected stale claims about missing session/short TTL, installer model
migration controls, and independent proactive ticks after route registration.

### Implemented in this checkpoint

- Reviewed per-user scheduler definitions and explicit loading for launchd,
  systemd user timers (including suitably configured WSL), and Windows Task
  Scheduler. Data-root/config identity is part of job names. Preview is read-only;
  foreign/changed definitions are refused. No native Windows/WSL scheduler
  certification is claimed and no productive schedules were registered.
- Maintenance execution now uses OS-owned nonblocking locks, not PID signalling,
  stale-file deletion, or a fixed-age takeover. Shutdown failures release locks;
  nonempty legacy PID locks fail closed pending operator review.
- Reachable native reactivation signals for the first substantive query,
  continuation, idle gap and Hermes's pre-compression lifecycle. Cooldown and
  pending compression state are bounded, scoped to agent/scope/session, and
  RAM-only. A compression signal clears stale prefetch results; old-generation
  async callbacks cannot refill that cache. Automatic capture can be disabled
  without disabling the independent read-side signal.
- Additive booster exceptions preserve primary recall. These fixes do **not**
  turn synchronous LanceDB/index reads into hard-preemptible 50-ms operations.

### Substantive work still open

| Area | Already available | Remaining gap |
|---|---|---|
| Store/compaction merges | Explicit revision-approved, lossless merge proposals, lineage, repair and final source revalidation | Automatic store-time LLM merges and complete upstream automatic compaction contract |
| Obsidian | Managed mirrors, explicit sync/import and revision-bound CLI source consent | Complete watch/conflict/discovery and browser consent workflows |
| Backup/restore | Selected backup paths, package file rollback and migration database snapshots | Complete end-user export/restore workflow, including external configuration/artifact ownership |
| Re-embedding | Private-writer staged batches, metadata validation, retained originals and activation/recovery | Named-namespace cutover and coordination with non-cooperating processes |
| Recall/graph/cognition | Native graph, Lens/CRR, temporal fields, opt-in REM/LightDream/persona/reflection/episodes | Full graph/entity selection contracts, hard booster deadlines and remaining upstream configuration/formatting differences |
| Delivery/outcomes | Independent ticks after authorized route registration, explicit feedback and trusted critical replies | Durable cold-start route ownership and general automatic outcome/reaction handling |
| Cache/operator parity | Scoped caches, bounded native commands and dashboard controls | Exact upstream byte-pruning/purpose/consumer and all operator workflow contracts |
| Distribution | Installer, model/migration controls, tested portable bundles and unsigned macOS packaging recipe | Native Windows/WSL scheduler/runtime acceptance, other architecture gates, signing/interactive acceptance and publication |

Some limits are host boundaries, not sensible shim targets: OpenClaw SDK memory
slots/cron ownership/neo-conflict presentation have no identical Hermes contract;
general reaction events are not exposed through the current plugin hook surface;
published native skills are profile-wide, not a new per-agent ACL mechanism.
The unaudited Jina-v3 remote-code chain remains deliberately disabled. Do not
remove authorization, licensing, migration or parity guards to relabel this port
as complete.

## Fresh read-only local inventory

The requested models were **already configured before this checkpoint**. The
effective configuration and certified writer routes were resolved from the live
Hermes home, then the actual LanceDB vector column and row count were inspected.

| Profile | Effective agent | Rows | Actual vector dimensions |
|---|---|---:|---:|
| default | default | 61 | 768 |
| bernd | main | 9,086 | 768 |
| bernhardine | bernhardine | 13,105 | 768 |
| heisenberg | heisenberg | 672 | 768 |
| coder | coder | No memory table yet | Configured 768 |
| rapidmlx | rapidmlx | No memory table yet | Configured 768 |

All six effective configurations select
`jinaai/jina-embeddings-v5-text-nano-retrieval` via native local ONNX and
`BAAI/bge-reranker-v2-m3` via local Transformers. The first four have profile
overrides and certified active staged-generation routes; the latter two inherit
the model configuration and have no vectors to convert. Existing license
acceptance is present. Plugin enablement was not changed for any profile.

Fresh local model checks used offline mode, no provider fallback and no memory
text transmission: all five pinned Nano artifact hashes verified; a real query
embedding had 768 finite values and norm approximately 1 (0.43 s including
encoder startup). BGE ranked the relevant synthetic document first with finite
scores (4.758 s including cold model loading). These are two smoke tests, **not**
a broad quality benchmark, a gateway capture/recall conversation or an installed
candidate acceptance. No productive DB/config/model/gateway changes were needed
or performed. No repeat migration, vector slicing or deletion was performed.

## Verification boundary

At this checkpoint, the complete macOS Python invocation (provider, Controls,
distribution and dashboard tests) passed **568 tests + 55 subtests**, zero
failures. The final Linux ARM64 container recheck at source commit `df06a9f`
passed **543 tests + 55 subtests**, including the reactivation addition, zero
failures. This remains container/runtime evidence, not native WSL or Windows
scheduler registration evidence.

Regression evidence is in `test_platform_jobs.py`, `test_jobs.py`,
`test_cognitive_opt_in_and_reminders.py`, `test_hermes_api_710.py`, and
`test_valid_time_runtime.py`. Native scheduler command invocations are mocked in
unit tests; they do not register jobs in the developer's login session.

The scheduler follows the official [Task Scheduler principal schema](https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-principal-principaltype-element)
and [systemd service execution rules](https://github.com/systemd/systemd/blob/main/man/systemd.service.xml).
Full release acceptance remains governed by `distribution/ACCEPTANCE.md` and the
contract matrices, not by the existence of package files.
