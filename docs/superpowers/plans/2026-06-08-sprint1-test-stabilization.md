# Sprint 1 — Test Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring all 6 known smoke-test failures to zero without touching runtime behavior or introducing new features.

**Architecture:** Two independent fixes — (A) align 4 test assertions to the existing `requireVaultPathConfirmation` implementation, and (B) install missing `node_modules/` so LanceDB tests can resolve their import. No production code changes.

**Tech Stack:** Node.js 22, `node --test` (built-in test runner), `@lancedb/lancedb ^0.26.2`, ESM

---

### Task 1: Fix smoke-feature-profiles and smoke-recommended-mode assertions

**Files:**
- Modify: `tests/smoke-feature-profiles.test.js`
- Modify: `tests/smoke-recommended-mode.test.js`

**Context:** `recommendedProfile()` in `lib/setup/feature-profiles.js` returns `obsidianBridge: { ..., requireVaultPathConfirmation: true }` — there is no `status` field on this object. The schema rejects `status` inside `obsidianBridge`. Three tests in smoke-feature-profiles and one test in smoke-recommended-mode were written against a `status: "pending_setup"` field that was never added.

- [ ] **Step 1: Run the tests to see the current failures**

```bash
node --test tests/smoke-feature-profiles.test.js tests/smoke-recommended-mode.test.js
```

Expected: 4 failures mentioning `status` and `pending_setup`.

- [ ] **Step 2: Fix assertion in smoke-feature-profiles — Test 1 (line 28)**

Open `tests/smoke-feature-profiles.test.js`. Find this line inside the test `"recommendedProfile has all features enabled but pending_setup where needed"`:

```javascript
assert.strictEqual(p.obsidianBridge.status, "pending_setup");
```

Replace with:

```javascript
assert.strictEqual(p.obsidianBridge.requireVaultPathConfirmation, true);
```

- [ ] **Step 3: Fix assertion in smoke-feature-profiles — Test 2 (lines ~110-114)**

Find the test named `"recommendedProfile sets obsidian status to pending_setup"`:

```javascript
test("recommendedProfile sets obsidian status to pending_setup", () => {
  const p = recommendedProfile();
  assert.ok(p.obsidianBridge.enabled);
  assert.strictEqual(p.obsidianBridge.status, "pending_setup");
  assert.strictEqual(p.obsidianBridge.requireVaultPathConfirmation, true);
});
```

Replace with:

```javascript
test("recommendedProfile sets obsidianBridge requireVaultPathConfirmation", () => {
  const p = recommendedProfile();
  assert.ok(p.obsidianBridge.enabled);
  assert.strictEqual(p.obsidianBridge.requireVaultPathConfirmation, true);
});
```

(Remove the `status` assertion, rename the test to match what it actually checks.)

- [ ] **Step 4: Fix input in smoke-feature-profiles — Test 3 (lines ~116-125)**

Find the test named `"isApplyBlocked with pending_setup features when vault not confirmed"`. Change only the `obsidianBridge` input — replace `status: "pending_setup"` with `requireVaultPathConfirmation: true`. Keep all assertions unchanged:

```javascript
it("isApplyBlocked with pending_setup features when vault not confirmed", () => {
  const config = {
    featuresConfirmedAt: "2026-06-03",
    obsidianBridge: { enabled: true, requireVaultPathConfirmation: true },
  };
  const result = isApplyBlocked(config);
  assert.strictEqual(result.blocked, true);
  assert.strictEqual(result.reason, "pending_setup");
  assert.ok(result.pending.some((p) => p.feature === "obsidianBridge"));
});
```

(Only `status: "pending_setup"` → `requireVaultPathConfirmation: true` on line 119. All assertions and the `featuresConfirmedAt` key are unchanged.)

- [ ] **Step 5: Fix assertion in smoke-recommended-mode (line 36)**

Open `tests/smoke-recommended-mode.test.js`. Find this assertion inside the test for `recommended-mode-full` or the profile check:

```javascript
assert.strictEqual(p.obsidianBridge.status, "pending_setup");
```

Replace with:

```javascript
assert.strictEqual(p.obsidianBridge.requireVaultPathConfirmation, true);
```

- [ ] **Step 6: Run tests and verify 0 failures**

```bash
node --test tests/smoke-feature-profiles.test.js tests/smoke-recommended-mode.test.js
```

Expected: all tests pass, 0 failures.

- [ ] **Step 7: Commit**

```bash
git add tests/smoke-feature-profiles.test.js tests/smoke-recommended-mode.test.js
git commit -m "fix(tests): align obsidianBridge assertions to requireVaultPathConfirmation

Tests asserted obsidianBridge.status === 'pending_setup', a field that was
never added to recommendedProfile(). The implementation uses
requireVaultPathConfirmation: true as the single pending-state indicator
(schema rejects 'status' inside obsidianBridge). Aligns 4 assertions across
2 test files to match the implementation — no production code changed."
```

---

### Task 2: Fix LanceDB and Migration test environment

**Files:**
- Run: `npm install` in `/root/`
- Verify: `tests/smoke-lancedb.test.js`, `tests/smoke-migration.test.js`
- Possibly modify: `package-lock.json` (if lock drifted)

**Context:** `/root/node_modules/` does not exist. `@lancedb/lancedb` is declared in `package.json` but `npm install` was never run in the source repo. The extension at `/root/.openclaw/extensions/memory-lancedb-namespaced/` has its own `node_modules/`, but tests import from the source repo root and cannot resolve the package.

- [ ] **Step 1: Run tests to confirm the exact error**

```bash
node --test tests/smoke-lancedb.test.js tests/smoke-migration.test.js
```

Expected: `ERR_MODULE_NOT_FOUND` for `@lancedb/lancedb` (or similar).

- [ ] **Step 2: Install dependencies**

```bash
npm install
```

Expected: resolves without errors, creates `/root/node_modules/`.

- [ ] **Step 3: Run tests immediately after install**

```bash
node --test tests/smoke-lancedb.test.js tests/smoke-migration.test.js
```

**If green:** Proceed to Step 4.

**If still red:** Stop. Read the actual error message carefully. Document the root cause (ESM resolution issue, lockfile drift, native binary mismatch, etc.) in a comment on this task and do NOT attempt a fix — the design spec says this is a separate sub-task if `npm install` doesn't resolve it.

- [ ] **Step 4: Check whether package-lock.json changed**

```bash
git diff package-lock.json | head -30
```

If the lock file changed (versions resolved differently), the update is intentional — include it in the commit.

- [ ] **Step 5: Run full test suite to verify no regressions**

```bash
npm test
```

Confirm only the previously known failures outside these 3 files appear (if any). The 3 smoke files must be green.

- [ ] **Step 6: Commit**

```bash
git add package-lock.json
git commit -m "fix(deps): run npm install to resolve @lancedb/lancedb in source repo

node_modules/ was missing in the source repo root — npm install was never
run after the package was added. Tests smoke-lancedb and smoke-migration
now resolve their imports correctly."
```

(Only add `package-lock.json` if it changed. If it was already current and `node_modules/` is gitignored, there may be nothing to commit — that's fine, the fix is the installed directory, not a tracked file change.)
