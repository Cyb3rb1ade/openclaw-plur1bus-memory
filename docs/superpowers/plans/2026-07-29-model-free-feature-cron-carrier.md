# Model-free PLUR1BUS Feature Cron Carrier Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development
> for every behavior change and superpowers:verification-before-completion
> before reporting success.

**Goal:** Eliminate the outer model-backed agent turn from the half-hourly
Afterthought and Critical Push crons while preserving their schedules and
feature-internal LLM behavior.

**Architecture:** Exact slash-command payloads identify the two feature crons,
but the installed OpenClaw dispatcher still starts its agent executor after
calling a plugin command. A tested, idempotent host patch upgrades that
dispatcher so the complete plugin ReplyPayload is passed through OpenClaw's
existing finalization/delivery path and returned before `executeCronRun()`.
A small pure formatting module maps job results to direct cron replies or
explicit failures. Existing PLUR1BUS delivery-contract payloads are migrated
to their exact commands.

**Tech Stack:** Node.js ESM, OpenClaw plugin commands, `node:test`

---

### Task 1: Specify direct cron replies

**Files:**
- Create: `tests/internal-cron-reply.test.js`
- Create: `lib/internal-cron-reply.js`

- [ ] Add failing tests for Afterthought text, regular skips, and technical
      errors.
- [ ] Add failing tests for zero, one, and multiple Critical Push messages and
      classifier errors.
- [ ] Run the focused test and confirm the expected missing-module failure.
- [ ] Implement the smallest pure result formatters.
- [ ] Run the focused test and confirm it passes.

### Task 2: Dispatch direct replies from the plugin command

**Files:**
- Modify: `index.js`
- Modify: `tests/openclaw-default-llm-runtime.test.js`

- [ ] Add integration assertions that cron invocations return direct
      `NO_REPLY`/message responses while non-cron diagnostics remain JSON.
- [ ] Run focused integration tests and observe the pre-change failure.
- [ ] Use the pure formatter only for Cron-internal Afterthought and
      classify-recent invocations.
- [ ] Run focused integration tests and confirm they pass.

### Task 3: Make new and existing cron payloads exact commands

**Files:**
- Modify: `lib/setup/feature-cron-plan.js`
- Modify: `tests/feature-cron-plan.test.js`
- Modify: `tests/feature-cron-bootstrap.test.js`

- [ ] Change expectations so both feature specs require `message === command`.
- [ ] Add migration cases for both known PLUR1BUS Delivery Contract payloads.
- [ ] Run planner/bootstrap tests and observe the pre-change failures.
- [ ] Replace the shipped payloads and implement exact known-message
      migrations without touching custom prompts.
- [ ] Run planner/bootstrap tests and confirm they pass.

### Task 4: Verify the complete change

**Files:**
- Review all modified files

- [ ] Run all directly affected tests.
- [ ] Run `node --test tests/*.test.js`.
- [ ] Inspect the final diff for accidental runtime-policy or schedule changes.
- [ ] Confirm the working tree contains only intentional files.

### Task 5: Patch the installed OpenClaw cron boundary

**Files:**
- Create: `patches/apply-cron-plugin-direct-dispatch.mjs`
- Create: `tests/cron-plugin-direct-dispatch-patch.test.js`
- Create: `tests/cron-plugin-direct-dispatch-wiring.test.js`
- Modify: `patches/apply-memory-patches.sh`
- Modify: `scripts/install-memory-system.sh`

- [x] Add failing tests for structural upgrade, exact-command allowlisting,
      complete ReplyPayload preservation, error propagation, idempotence,
      rollback backup, patch-entrypoint wiring, and remote-installer copying.
- [x] Install the dispatcher into an audited unpatched OpenClaw bundle or
      upgrade the existing PLUR1BUS dispatcher; fail closed when required
      anchors or runtime exports are absent.
- [x] Route direct feature replies through `finalizeCronRun()` and return before
      `executeCronRun()`.
- [x] Preserve the legacy carrier behavior for multiline/custom prompts and
      all unrelated commands.
- [x] Ship the patch in release/deploy manifests, reapply it at gateway
      registration, and gate cron provisioning/migration on readiness.
- [x] Apply the transformer to a copy of the production runtime bundle and run
      `node --check` on the result.
