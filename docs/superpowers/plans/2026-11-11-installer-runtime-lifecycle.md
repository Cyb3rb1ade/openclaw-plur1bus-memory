# Installer Runtime Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install PLUR1BUS while safely coordinating affected Hermes runtimes and restoring them without manual terminal steps.

**Architecture:** A shared Python lifecycle adapter binds to the selected Hermes home and uses its existing verified runtime lifecycle. The installer holds this adapter across the transaction and exposes progress and recovery in both frontends.

**Tech Stack:** Python 3.12+, SwiftUI, Hermes 0.23 runtime protocols, GitHub Actions, Developer ID signing.

**Spec:** docs/superpowers/specs/2026-11-11-installer-runtime-lifecycle.md

## Global Constraints

- Target macOS ARM, Windows x64/ARM, Linux x64/ARM and WSL. Release 7.19.3-hermes.2; Python wheels 7.19.3.post2.
- Stop only verified runtimes of the chosen installation/home; never argv substring identity or broad process kills. Deduplicate shared gateways.
- Prefer Hermes pause/drain/service ownership; no host-source patches, no raw pip into PM generations. Stop-and-install confirmation explains possible active-work interruption after Hermes' configured shutdown interval; no silent interruption.
- Keep existing profile settings, secrets and memories. No secrets in diagnostics or receipts.
- Restore only the original running set, with durable recovery obligations; retain the stopped-runtime CLI option.
- macOS follows system language, English fallback; German remains available.
- Offline behavioral regressions first, then real temporary-home runtime tests; productive home only for the authorized final update.

## Review Focus

- One shared gateway serves seven profiles: stop/restart once, retain all served profiles.
- PID reuse/foreign installations/auto-respawning supervisors: never touch foreign processes or proceed while owned writers remain.
- Work starts between initial inventory and stop: normal Hermes drain/shutdown with explicit interruption disclosure, never an unannounced broad force-kill.
- Install fails after shutdown or the helper dies: durable restart debt, truthful state and recovery without mixed-version startup.
- PM publishes a new interpreter generation: resume through the current selected runtime and verify readiness, not merely successful spawn.

### Task 1: Shared lifecycle and transactional installer

**Files:** Create distribution/runtime_lifecycle.py and distribution/runtime_worker.py (additional focused sibling only with controller agreement); modify distribution/installer.py and distribution/build.py; add distribution/tests/test_runtime_lifecycle.py and focused installer tests.

**Interfaces:** apply_install gains keyword stop_runtimes=False alongside stopped=False; CLI --stop-runtimes opts into managed lifecycle. Existing --runtimes-stopped stays valid. Progress phases inspecting-runtimes, stopping-runtimes, waiting-for-runtimes, restarting-runtimes supplement existing phases. The outcome contains a runtimes record with original/stopped/restored state, without credentials. The GUI task consumes these flags/phases. Worker may refine helper signatures after inspecting Hermes APIs; public flags and phases are fixed.

- [ ] Write red behavioral tests for shared-PID deduplication, foreign/PID-reused rejection, no initial runtimes, graceful active-work handling, managed/manual ownership, pre-write failure restoration, safe partial-failure recovery, readiness failure and generation refresh.
- [ ] Implement the lifecycle and installer integration using existing Hermes mechanisms where available. Read-only installed Hermes source: /Users/cyberblade/.hermes/hermes-agent, HEAD ea4d2379167af59b23c93b8ff383c9014bd71c08. Known mechanisms: gateway.control_socket identify/pause-for-update; hermes_cli.update_cmd_posix_pause and update_cmd_windows with durable update_pause_record; canonical gateway.status identity readers. These are leads to inspect, not permission to stop the real runtime. Need scoped ownership and fail-closed checks around any broad upstream helper. `--stop-runtimes` explicitly consents to normal Hermes shutdown including bounded active-work interruption; CLI help and GUI explain it. Native PM generations allow some clients to stay alive, but plugin source/UI changes still require a deliberate reload/restart strategy; document and test the resulting handling for Desktop/CLI/job clients.
- [ ] Add a temporary-home live-process acceptance test or script which exercises a real Hermes shared gateway lifecycle and confirms settings and served profiles survive. Never use productive state in ordinary tests.
- [ ] Run focused red/green tests and the distribution suite with /private/tmp/plur1bus-7193-release.7shDfJty/venv/bin/python. Commit only owned files, report limitations and exact evidence.

### Task 2: Standard Desktop and interactive client shutdown

**Files:** distribution/runtime_worker.py and focused runtime client sibling if needed; distribution/runtime_lifecycle.py only for the shared contract; distribution/tests/test_runtime_lifecycle.py and client behavior tests.

**Interfaces:** Consume Task 1 worker inspect_clients(home, project, excluded_pids) and durable runtime transaction. Preserve --stop-runtimes and installation-outcome phases. Extend the existing record for client shutdown/reopen decisions.

- [ ] Pin red tests for a standard Desktop of the selected install versus another installation, one parent app with backend/renderer children, PID replacement, interactive CLI, installer ancestors, and an unclassified custom process.
- [ ] Close the selected installation's verified standard Desktop via native app shutdown and relaunch its original entry after successful installation; verify it releases/reloads its backend. End verified interactive CLI clients using Hermes canonical command and selected home/environment ownership under explicit stop consent; never replay arbitrary CLI commands, cron work or shell text. Saved sessions can be resumed by the user and the receipt must say which clients were closed. Keep unprovable custom holders as a specific pre-write refusal.
- [ ] Add native smoke where available and run the combined lifecycle/distribution suite. Commit and report exact supported paths and remaining exceptions; do not mark gateway-only support as full installer completion.

### Task 3: Guided setup and localized lifecycle UX

**Files:** distribution/macos/Setup.swift; distribution/macos/Resources/{en,de}.lproj/Localizable.strings; macOS welcome/conclusion files; relevant distribution/tests; guided console in distribution/installer.py; installation documentation.

**Interfaces:** Consume Tasks 1–2 --stop-runtimes and progress phases. Do not change the lifecycle engine contract without coordinating with the lifecycle implementers.

- [ ] Add regressions for explicit stop/restart consent, progress, restart failure versus no-write refusal, system-language fallback and guided console default. Include a real short-lived subprocess emitting its final installation-outcome immediately before exit: the Swift runner must drain the final stderr bytes before its completion callback, not lose the event when isRunning becomes false.
- [ ] Replace the false claim that runtimes are already stopped with a plain stop/install/restart explanation and action. Default guided installation uses managed lifecycle; include an explicit cancel path before any shutdown. Keep active-work delays visible.
- [ ] Build SwiftUI and test English, German and unsupported-language fallback. Commit and report.

### Task 4: Release and native acceptance

**Files:** distribution/version.json or actual existing version source; release documentation; platform workflows/acceptance scripts only where necessary; separate Hermes catalog pin after publication.

- [ ] Bump consistent installer/wheel metadata to 7.19.3-hermes.2 / 7.19.3.post2; build from a clean committed tree.
- [ ] Run native matrix and Windows ARM PM acceptance at exact source SHA. Run real macOS temporary-home fresh/upgrade plus runtime stop/restart acceptance; inspect packaged helper files.
- [ ] Final independent review, then sign/notarize/staple macOS PKG and verify all asset hashes. Publish a new prerelease (never mutate .1), keep OpenClaw latest unchanged; repin catalog PR when appropriate.
- [ ] Use new flow for the authorized local all-seven update. Verify unchanged config hashes, new receipts, imports, gateway readiness and all served profiles; report exact outcome and download link.
