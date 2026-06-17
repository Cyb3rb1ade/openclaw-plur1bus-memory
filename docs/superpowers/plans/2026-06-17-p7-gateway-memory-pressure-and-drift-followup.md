# P7 Followup — Gateway memory pressure, residual timeouts, drift hygiene

Date: 2026-06-17
Host: vmd190201
Repo: /root
Branch: fix/p7-gateway-memory-pressure-and-drift-hygiene-2026-06-17
Commit: 1d38e36

## Summary

After P6 was merged to main and hot-synced, the gateway still emitted residual
memory-pressure warnings and occasional capture/recall/store timeouts. P7 adds
runtime-level backpressure inside the memory plugin, improves observability of
queue backlogs, fixes a stale deploy-guard reference, and resolves the codex
plugin version drift.

## Evidence

- Post-P6 baseline (~06:25–06:55):
  - MemoryCurrent ~4.98 GiB, MemoryPeak ~5.27 GiB (cgroup)
  - process RSS ~2.55 GiB, HWM ~2.80 GiB
  - 30 min counts: 6 memory-pressure warnings, 6 event-loop-delay liveness
    warnings, 2 MemoryDB.store timeouts, 1 capture-worker timeout,
    2 recall-worker timeouts.
- Gateway hard-coded RSS warning threshold is 1.5 GiB; observed stable loaded
  baseline is ~2.5 GiB, so warnings are largely false positives for this host.
- `openclaw gateway status --deep` reported codex plugin drift
  (`2026.6.5 -> expected 2026.6.8`).
- `scripts/protect-plur1bus-deploy.sh` referenced a missing
  `scripts/cleanup-stores.mjs`.

## Root-cause classification

1. **False-positive pressure threshold** — OpenClaw gateway diagnostics warn at
   1.5 GiB RSS, which is below the normal loaded baseline of this instance.
   The threshold is hard-coded in `/usr/lib/node_modules/openclaw/dist/...`
   and not configurable from this plugin repo.
2. **Unbounded background queues** — `lib/runtime-scheduler.js` serialized work
   but allowed unlimited queue depth; under pressure, low-priority background
   capture/recall jobs could pile up and timeout.
3. **Operational hygiene** — stale deploy-guard reference + stale codex install
   metadata.

## Files changed

- `lib/runtime-pressure-gate.js` (new)
- `lib/bounded-operation-queue.js` (new)
- `lib/runtime-scheduler.js`
- `openclaw.plugin.json`
- `scripts/protect-plur1bus-deploy.sh`
- `tests/runtime-pressure-gate.test.js` (new)
- `tests/bounded-operation-queue.test.js` (new)
- `tests/runtime-scheduler-pressure.test.js` (new)
- `tests/protect-plur1bus-deploy.test.js` (new)
- `docs/superpowers/plans/2026-06-17-p7-gateway-memory-pressure-and-drift-evidence.md`
- `docs/superpowers/plans/2026-06-17-p7-gateway-memory-pressure-and-drift-hygiene.md`
- `docs/superpowers/plans/2026-06-17-p7-gateway-memory-pressure-and-drift-followup.md`

## Fixes implemented

- **Runtime pressure gate** (`lib/runtime-pressure-gate.js`): classifies RSS
  against configurable warning (default 3.0 GiB) and critical (default 4.5 GiB)
  thresholds, based on the observed stable post-P6 baseline.
- **Bounded operation queues** (`lib/bounded-operation-queue.js`): caps recall
  and per-agent capture queue depth; evicts oldest low-priority background jobs
  before dropping explicit work.
- **Integrated scheduler** (`lib/runtime-scheduler.js`):
  - consults pressure gate before enqueuing background work;
  - skips low-priority background capture/recall under critical pressure;
  - sheds low-priority jobs at warning pressure;
  - never silently drops explicit user operations;
  - adds structured logs with `queueDepth`, `activeCount`, `operation`,
    `durationMs`, `timeoutMs`;
  - exposes `pressure` and queue totals in `status()`.
- **Config schema** (`openclaw.plugin.json`): accepts the new `runtime`
  options.
- **Deploy hygiene** (`scripts/protect-plur1bus-deploy.sh`): removed stale
  `scripts/cleanup-stores.mjs` reference so the guard no longer looks for a
  non-existent destructive cleanup script.
- **Plugin drift**: installed `codex@2026.6.8` via
  `openclaw plugins install @openclaw/codex@2026.6.8 --force`. The gateway
  appears to have restarted afterward; `openclaw gateway status --deep` no
  longer reports codex drift.

## Fixes deferred

- **Gateway-level RSS threshold tuning** remains outside repo control. The
  diagnostic module in `/usr/lib/node_modules/openclaw/dist/diagnostic-*.js`
  hard-codes 1.5 GiB warning / 3.0 GiB critical and does not read plugin config.
  Recommendation: bump the OpenClaw gateway threshold via upstream/service
  config when a supported mechanism exists, or accept the warnings as
  documented false positives while monitoring for true growth.

## Tests

- `node --test tests/runtime-pressure-gate.test.js` — pass
- `node --test tests/bounded-operation-queue.test.js` — pass
- `node --test tests/runtime-scheduler-pressure.test.js` — pass
- `node --test tests/protect-plur1bus-deploy.test.js` — pass
- `npm run lint` — pass
- `npm test` — 1613 pass / 0 fail
- `npm audit --audit-level=moderate` — 0 vulnerabilities
- `node scripts/verify-plugin-deploy.mjs` — PASS

## Operational rollout

- Pushed branch `fix/p7-gateway-memory-pressure-and-drift-hygiene-2026-06-17`
  to origin.
- Did **not** automatically hot-deploy the P7 code changes to the live
  extension. A controlled gateway restart after a deploy-integrity repair is
  required to load the new `runtime-scheduler.js`, pressure gate, and bounded
  queue code.

## Rollback

- Revert commit `1d38e36` and force-sync the live extension back to main
  (`3e114f8`), then restart the gateway.
- Or switch back to `main` and run `node scripts/verify-plugin-deploy.mjs --repair`
  followed by a gateway restart.

## Remaining risks

- Until P7 is deployed, the live extension still uses the unbounded scheduler.
- The gateway-level 1.5 GiB RSS warning will continue to fire even after P7
  deploy because it is not repo-configurable; the new plugin-level thresholds
  only affect shedding behavior, not the gateway diagnostic log line.
- codex was updated to 2026.6.8 but relies on the gateway restart already
  observed; if the restart was unrelated, the plugin may not be loaded until
  the next controlled restart.
