# Hermes 7.18.20 delta review

Candidate: 7.18.20-hermes.0, Python packages 7.18.20.
Upstream: `0c07263da42e169a8e1245eb2882a6be2a2552a0` (v7.18.20).

All 16 upstream commits and 51 paths are retained. Version metadata uses the separate Hermes channel.

Native additions: macOS automatic bootstrap no longer passes an explicit target interpreter; PM remains authoritative. Group reasoning previews are skipped before gateway dispatch. Host notice markers are untrusted in capture. Recall promotes originals over fragments and retains the first three results in full, with explicit truncation on lower results. Automatic capture uses the fixed Jev endpoint, explicit environment credentials, bounded timeout, and whole-plus-parts fallback. Decisions survive retries. User Light diary writes require the explicit opt-in and remain scope-isolated. Daily maintenance now exposes read-only workspace file ages and knowledge queue counts.

OpenClaw registration trace, cold-start lease guard and CLI pipe/read-timeout fixes remain host-specific; Hermes uses its own plugin runtime and host LLM services. The upstream native review-cron dispatcher and post-turn-refine job are retained in JavaScript, but equivalent Hermes scheduled review delivery is not yet implemented. Workspace status is available in the native maintenance report; this does not claim scheduled evening delivery. Existing partial parity is retained in `plur1bus_hermes.parity`; this is not a full parity certification.

Local packages are candidates. Cross-platform CI, Developer ID signing, notarization, registry publication and GitHub publication require their own evidence.

## Commits

- `0c07263d`
- `a35d7bac`
- `df40f582`
- `9ac6bea0`
- `cc65db5f`
- `535cc8f0`
- `33d5a013`
- `b98aff79`
- `8205e9fe`
- `d11e0153`
- `747787a6`
- `420d9674`
- `e80e268b`
- `88e66b0f`
- `c86d4cc9`
- `84ff33ee`

## Paths

- `AGENTS.md`
- `CHANGELOG.md`
- `docs/configuration.md`
- `index.js`
- `lib/control-plane-projection.js`
- `lib/dashboard-settings.js`
- `lib/dreaming/light-dream.js`
- `lib/group-reasoning-filter.js`
- `lib/i18n-dictionary.js`
- `lib/jev-chunk-decider.js`
- `lib/llm-router.js`
- `lib/llm-warmth.js`
- `lib/memory-chunking.js`
- `lib/neo-arch.js`
- `lib/obsidian-control-room.js`
- `lib/post-turn-queue.js`
- `lib/recall-pipeline.js`
- `lib/register-trace.js`
- `lib/relevant-memory-context.js`
- `lib/review-workspace-status.js`
- `lib/setup/control-ui-plugin-runtime.js`
- `lib/setup/control-ui-write.js`
- `lib/setup/feature-cron-bootstrap.js`
- `lib/setup/feature-cron-native.js`
- `lib/setup/feature-cron-plan.js`
- `lib/setup/feature-cron-plugin-runtime.js`
- `openclaw.plugin.json`
- `package-lock.json`
- `package.json`
- `scripts/lib/deploy-integrity.mjs`
- `scripts/setup-feature-crons.mjs`
- `tests/b12p-runtime-reachability.test.js`
- `tests/capture-chunking-switch.test.js`
- `tests/capture-chunking.test.js`
- `tests/capture-host-notices.test.js`
- `tests/critical-review-command.test.js`
- `tests/dream-diary.test.js`
- `tests/feature-cron-bootstrap-describe.test.js`
- `tests/feature-cron-bootstrap.test.js`
- `tests/feature-cron-plan.test.js`
- `tests/group-reasoning-filter.test.js`
- `tests/jev-chunk-decider.test.js`
- `tests/llm-router.test.js`
- `tests/obsidian-review-native-cron.test.js`
- `tests/openclaw-default-llm-callers.test.js`
- `tests/post-turn-queue.test.js`
- `tests/recall-chunk-group-cap.test.js`
- `tests/register-trace.test.js`
- `tests/release-750-compat.test.js`
- `tests/review-workspace-status.test.js`
- `tests/setup-feature-crons-pipe-output.test.js`
