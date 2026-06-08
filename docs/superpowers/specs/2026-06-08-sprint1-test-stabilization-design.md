# Sprint 1 — Test Stabilization Design

**Goal:** Bring all 6 known smoke-test failures to zero without touching runtime behavior or introducing new features.

**Principle:** Prove the existing architecture works before building on top of it.

---

## Background

Commit `7319a7e` (feat(wiki+setup)) introduced three test files that have been failing since they were added:

| File | Failures | Root cause |
|---|---|---|
| `tests/smoke-feature-profiles.test.js` | 3 (+ 1 in `recommended-mode-full`) | Tests assert `obsidianBridge.status === "pending_setup"` — a field that doesn't exist in the implementation |
| `tests/smoke-lancedb.test.js` | 1 | `@lancedb/lancedb` not resolved — probable missing `node_modules/` |
| `tests/smoke-migration.test.js` | 1 | Same as above |

---

## Task A — Fix `smoke-feature-profiles` (4 test failures)

**What's wrong:**  
The implementation uses `requireVaultPathConfirmation: true` as the pending-state indicator for `obsidianBridge` (because the OpenClaw runtime schema does not accept a `status` field inside `obsidianBridge`). The tests were written expecting `status: "pending_setup"` on that object — a field that was never added to `recommendedProfile()`.

**Decision (Option B):** Align tests to the implementation. No production code changes.

**Files changed:** `tests/smoke-feature-profiles.test.js` only.

**Specific assertion changes:**

1. Test `"recommendedProfile has all features enabled but pending_setup where needed"`:  
   - Remove: `assert.strictEqual(p.obsidianBridge.status, "pending_setup")`  
   - Add: `assert.strictEqual(p.obsidianBridge.requireVaultPathConfirmation, true)`

2. Test `"recommendedProfile sets obsidian status to pending_setup"`:  
   - Remove: `assert.strictEqual(p.status, "pending_setup")`  
   - Keep: `assert.strictEqual(p.requireVaultPathConfirmation, true)` (this assertion is already there or equivalent)

3. Test `"isApplyBlocked with pending_setup features when vault not confirmed"`:  
   - Input config: swap `obsidianBridge: { enabled: true, status: "pending_setup" }` → `obsidianBridge: { enabled: true, requireVaultPathConfirmation: true }`
   - Assertions remain the same (`result.reason === "pending_setup"`, `result.pending` includes `obsidianBridge`)

**Rationale:** `requireVaultPathConfirmation` is the runtime truth. Adding `status` would create a second source of truth with no owner — a future `setupState` refactor (if ever done) would address this cleanly. For now, the tests must reflect reality.

---

## Task B — Fix `smoke-lancedb` + `smoke-migration` (2 failures)

**What's probably wrong:**  
`/root/node_modules/` doesn't exist. The package has `@lancedb/lancedb` as a declared dependency with a `package-lock.json`, but `npm install` was never run in the source repo (the runtime extension at `/root/.openclaw/extensions/memory-lancedb-namespaced/` has its own `node_modules/`).

**Approach — verify before assuming:**

1. Run `npm install` in `/root/`
2. Immediately run both tests:
   ```
   node --test tests/smoke-lancedb.test.js
   node --test tests/smoke-migration.test.js
   ```
3. **If green:** Done. Commit `package-lock.json` update if changed.
4. **If still red:** Stop. Document the actual error, derive a targeted fix (ESM resolution issue, lockfile drift, etc.), and treat it as a separate sub-task.

**Non-goal:** Do not patch the tests to mock `@lancedb/lancedb` unless `npm install` demonstrably fails to fix them.

---

## Success Criteria

- `node --test tests/smoke-feature-profiles.test.js` → 0 failures
- `node --test tests/smoke-lancedb.test.js` → 0 failures  
- `node --test tests/smoke-migration.test.js` → 0 failures
- `npm test` overall → only pre-existing failures outside these 3 files (if any)
- No changes to `lib/setup/feature-profiles.js` or any runtime file
- No new features introduced

---

## Out of Scope

- `setupState` refactoring (future sprint)
- `/wiki` command (Sprint 2)
- Memory graph / Obsidian link improvements (Sprint 3)
- Any test that was already passing before this sprint
