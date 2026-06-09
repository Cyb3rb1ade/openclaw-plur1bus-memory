# Obsidian Bridge Sprint 3 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Activate P3 (bundle cooldown config), wire D1/B (stale-bundle expiry), and build D1/A (auto-approve+apply low-risk items) for the Obsidian Bridge.

**Architecture:** Three targeted changes. P3 is a config-only change. D1/B wires an already-implemented function into the `rebuildDashboards()` workspace loop. D1/A adds a new two-phase function (`autoApproveAndApplyLowRisk`) that auto-promotes low-risk, adversarially-passed pending items and then delegates to the existing `applyApprovedReviewBundle`. All operations are per-workspace by construction (callers pass workspace-specific `rawConfig`).

**Tech Stack:** Node.js ESM, `node:test` for tests, no LanceDB in tests (pure filesystem + JSON).

---

## File Map

| File | Change |
|---|---|
| `tests/smoke-obsidian-bridge-sprint3.test.js` | NEW — 6 tests |
| `.openclaw/openclaw.json` | Add `bundleCooldownMs: 900000` to obsidian-bridge entry |
| `openclaw.plugin.json` | Add `staleBundleMaxAgeDays` + `autoApplyLowRisk` schema entries |
| `lib/obsidian-bridge.js` | Add import of `expireStaleBundles`; add `staleBundleMaxAgeDays` to `normalizeObsidianBridgeConfig` return; call `expireStaleBundles(vaultCfg, …)` in `rebuildDashboards()` workspace loop |
| `lib/obsidian-control-room.js` | Add `autoApplyLowRisk` + `staleBundleMaxAgeDays` to `normalizeObsidianControlRoomConfig` return; add new `autoApproveAndApplyLowRisk()` export after `expireStaleBundles`; call it at end of `prepareReviewBundle()` |

---

## Task 1: Write the Failing Tests (TDD First)

**Files:**
- Create: `tests/smoke-obsidian-bridge-sprint3.test.js`

- [ ] **Step 1: Create the test file**

```javascript
import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  expireStaleBundles,
  autoApproveAndApplyLowRisk,
} from "../lib/obsidian-control-room.js";

// Bundle records live at {vaultPath}/plur1bus/review-bundles/{bundleId}.items.json
function writeBundleRecord(vaultPath, bundleId, record) {
  const dir = join(vaultPath, "plur1bus", "review-bundles");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${bundleId}.items.json`), JSON.stringify(record, null, 2), "utf8");
}

function readBundleRecord(vaultPath, bundleId) {
  return JSON.parse(
    readFileSync(join(vaultPath, "plur1bus", "review-bundles", `${bundleId}.items.json`), "utf8")
  );
}

function makeItem(overrides = {}) {
  return {
    id: `rbi-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: "task_suggestion",
    status: "pending",
    risk: "low",
    adversarialReview: { status: "pass" },
    proposedByAgent: "test-agent",
    target: "",
    action: "add test data",
    reason: "auto-test task",
    ...overrides,
  };
}

function makeBundle(bundleId, items, overrides = {}) {
  return {
    bundle: {
      bundleId,
      status: "pending_user_review",
      createdAt: new Date().toISOString(),
      agentId: "test-agent",
      workspaceKey: "test-ws",
      ...overrides,
    },
    items,
    hygieneItems: [],
    maintenance: { findings: [] },
  };
}

describe("smoke-obsidian-bridge-sprint3", () => {
  // ---------------------------------------------------------------
  // D1/B: expireStaleBundles
  // ---------------------------------------------------------------

  it("expireStaleBundles: bundle older than maxAgeDays is expired", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-sprint3-"));
    const now = new Date("2026-06-08T12:00:00.000Z");
    const old = new Date(now - 8 * 86_400_000).toISOString(); // 8 days ago
    const bundleId = "rb-expire-old";
    writeBundleRecord(dir, bundleId, makeBundle(bundleId, [makeItem()], { createdAt: old }));

    const result = expireStaleBundles({ vaultPath: dir }, { staleBundleMaxAgeDays: 7, now });

    assert.strictEqual(result.expired, 1, "expired count should be 1");
    assert.ok(result.expiredIds.includes(bundleId), "expiredIds should include bundleId");
    const saved = readBundleRecord(dir, bundleId);
    assert.strictEqual(saved.bundle.status, "expired", "bundle.status should be 'expired'");
    assert.ok(saved.items.every((i) => i.status === "rejected"), "all items should be rejected");
  });

  it("expireStaleBundles: bundle younger than maxAgeDays is untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-sprint3-"));
    const now = new Date("2026-06-08T12:00:00.000Z");
    const recent = new Date(now - 3 * 86_400_000).toISOString(); // 3 days ago
    const bundleId = "rb-expire-recent";
    writeBundleRecord(dir, bundleId, makeBundle(bundleId, [makeItem()], { createdAt: recent }));

    const result = expireStaleBundles({ vaultPath: dir }, { staleBundleMaxAgeDays: 7, now });

    assert.strictEqual(result.expired, 0, "should not expire recent bundle");
    const saved = readBundleRecord(dir, bundleId);
    assert.strictEqual(saved.bundle.status, "pending_user_review", "bundle.status should remain pending");
  });

  // ---------------------------------------------------------------
  // D1/A: autoApproveAndApplyLowRisk
  // ---------------------------------------------------------------

  it("autoApproveAndApplyLowRisk: low-risk+pass items are approved and applied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-sprint3-"));
    const bundleId = "rb-auto-apply";
    const item1 = makeItem({ id: "rbi-auto-001" });
    const item2 = makeItem({ id: "rbi-auto-002" });
    writeBundleRecord(dir, bundleId, makeBundle(bundleId, [item1, item2]));

    const result = await autoApproveAndApplyLowRisk(
      { vaultPath: dir, autoApplyLowRisk: true },
      bundleId,
      {}
    );

    assert.strictEqual(result.autoApproved, 2, "autoApproved should be 2");
    assert.strictEqual(result.autoApplied, 2, "autoApplied should be 2");
    const saved = readBundleRecord(dir, bundleId);
    assert.ok(saved.items.every((i) => i.status === "applied"), "all items should be applied");
  });

  it("autoApproveAndApplyLowRisk: medium-risk items are skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-sprint3-"));
    const bundleId = "rb-medium-skip";
    const item = makeItem({ id: "rbi-med-001", risk: "medium" });
    writeBundleRecord(dir, bundleId, makeBundle(bundleId, [item]));

    const result = await autoApproveAndApplyLowRisk(
      { vaultPath: dir, autoApplyLowRisk: true },
      bundleId,
      {}
    );

    assert.strictEqual(result.autoApproved, 0, "medium-risk items should not be auto-approved");
    const saved = readBundleRecord(dir, bundleId);
    assert.strictEqual(saved.items[0].status, "pending", "item should remain pending");
  });

  it("autoApproveAndApplyLowRisk: adversarial-fail items are skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-sprint3-"));
    const bundleId = "rb-adv-fail";
    const item = makeItem({ id: "rbi-fail-001", adversarialReview: { status: "fail" } });
    writeBundleRecord(dir, bundleId, makeBundle(bundleId, [item]));

    const result = await autoApproveAndApplyLowRisk(
      { vaultPath: dir, autoApplyLowRisk: true },
      bundleId,
      {}
    );

    assert.strictEqual(result.autoApproved, 0, "adversarial-fail items should not be auto-approved");
  });

  it("autoApproveAndApplyLowRisk: gate=false (default) is a no-op", async () => {
    const dir = mkdtempSync(join(tmpdir(), "obs-sprint3-"));
    const bundleId = "rb-gate-off";
    const item = makeItem({ id: "rbi-gate-001" });
    writeBundleRecord(dir, bundleId, makeBundle(bundleId, [item]));

    const result = await autoApproveAndApplyLowRisk(
      { vaultPath: dir, autoApplyLowRisk: false },
      bundleId,
      {}
    );

    assert.strictEqual(result.autoApproved, 0, "gate=false must be a no-op");
    const saved = readBundleRecord(dir, bundleId);
    assert.strictEqual(saved.items[0].status, "pending", "item should remain pending with gate off");
  });
});
```

- [ ] **Step 2: Run tests to verify failure state**

```bash
node --test tests/smoke-obsidian-bridge-sprint3.test.js 2>&1
```

Expected output: Tests 1-2 (`expireStaleBundles`) PASS. Tests 3-6 (`autoApproveAndApplyLowRisk`) FAIL with `SyntaxError` or import error because `autoApproveAndApplyLowRisk` is not yet exported.

If tests 1-2 also fail, investigate — `expireStaleBundles` is already implemented at `lib/obsidian-control-room.js:1945`.

---

## Task 2: P3 — Enable bundleCooldownMs

**Files:**
- Modify: `.openclaw/openclaw.json`

The `plugins.entries.obsidian-bridge` key currently holds `{}`. Add the cooldown value.

- [ ] **Step 1: Edit `.openclaw/openclaw.json`**

Find the `"obsidian-bridge"` entry under `plugins.entries` and change it from `{}` to:

```json
{
  "bundleCooldownMs": 900000
}
```

This enables the 15-minute cooldown that is already implemented in `prepareReviewBundle` (line 1334) but never fired because the value defaulted to 0.

- [ ] **Step 2: Verify the JSON is valid**

```bash
node -e "JSON.parse(require('fs').readFileSync('/root/.openclaw/openclaw.json', 'utf8')); console.log('JSON valid')"
```

Expected: `JSON valid`

- [ ] **Step 3: Commit**

```bash
git add .openclaw/openclaw.json
git commit -m "feat(obs-bridge): enable bundle cooldown 15 min (P3)"
```

---

## Task 3: Schema and Config Field Additions

**Files:**
- Modify: `openclaw.plugin.json` (lines ~788-792, after `bundleCooldownMs` entry)
- Modify: `lib/obsidian-bridge.js` (line ~282, end of `normalizeObsidianBridgeConfig` return)
- Modify: `lib/obsidian-control-room.js` (line ~641, end of `normalizeObsidianControlRoomConfig` return)

- [ ] **Step 1: Add schema entries to `openclaw.plugin.json`**

Locate the `bundleCooldownMs` schema entry (around line 788):
```json
"bundleCooldownMs": {
  "type": "number",
  "default": 0
},
```

Insert immediately after it (before `"dryRun"`):
```json
"staleBundleMaxAgeDays": {
  "type": "number",
  "default": 7
},
"autoApplyLowRisk": {
  "type": "boolean",
  "default": false
},
```

- [ ] **Step 2: Add `staleBundleMaxAgeDays` to `normalizeObsidianBridgeConfig` in `lib/obsidian-bridge.js`**

At line ~282, the return object ends with:
```javascript
    intervalMs: Number(cfg.intervalMs || options.intervalMs || 5000),
  };
```

Change to:
```javascript
    intervalMs: Number(cfg.intervalMs || options.intervalMs || 5000),
    staleBundleMaxAgeDays: Number.isFinite(Number(cfg.staleBundleMaxAgeDays)) ? Number(cfg.staleBundleMaxAgeDays) : 7,
  };
```

- [ ] **Step 3: Add `autoApplyLowRisk` and `staleBundleMaxAgeDays` to `normalizeObsidianControlRoomConfig` in `lib/obsidian-control-room.js`**

At line ~641, the return object ends with:
```javascript
    bundleCooldownMs: Number(cfg.bundleCooldownMs || 0),
  };
```

Change to:
```javascript
    bundleCooldownMs: Number(cfg.bundleCooldownMs || 0),
    staleBundleMaxAgeDays: Number.isFinite(Number(cfg.staleBundleMaxAgeDays)) ? Number(cfg.staleBundleMaxAgeDays) : 7,
    autoApplyLowRisk: cfg.autoApplyLowRisk === true,
  };
```

- [ ] **Step 4: Commit**

```bash
git add openclaw.plugin.json lib/obsidian-bridge.js lib/obsidian-control-room.js
git commit -m "feat(obs-bridge): add staleBundleMaxAgeDays + autoApplyLowRisk schema + config fields"
```

---

## Task 4: D1/B — Wire expireStaleBundles in rebuildDashboards

**Files:**
- Modify: `lib/obsidian-bridge.js`

`expireStaleBundles` is fully implemented at `lib/obsidian-control-room.js:1945` but never called. It must be called once per workspace inside `rebuildDashboards()` using the workspace-specific `vaultCfg`.

- [ ] **Step 1: Add import of `expireStaleBundles` in `lib/obsidian-bridge.js`**

The current last import line is:
```javascript
import { resolveInside } from "./sql-safety.js";
```

Add after it:
```javascript
import { expireStaleBundles } from "./obsidian-control-room.js";
```

- [ ] **Step 2: Call `expireStaleBundles` in the `rebuildDashboards()` workspace loop**

In `rebuildDashboards()` (around line 1641), the workspace loop body starts:
```javascript
for (const workspace of workspaces) {
  try {
    const vaultCfg = { ...rawConfig, vaultPath: workspace.path, reviewRoot: cfg.reviewRoot || "plur1bus" };

    // Step A: Write memory mirrors for LanceDB records (if provided)
```

Insert the expiry call immediately after `vaultCfg` is created, before Step A:
```javascript
    const vaultCfg = { ...rawConfig, vaultPath: workspace.path, reviewRoot: cfg.reviewRoot || "plur1bus" };

    // D1/B: expire stale review bundles — runs per-workspace using workspace-specific vaultCfg
    expireStaleBundles(vaultCfg, { staleBundleMaxAgeDays: cfg.staleBundleMaxAgeDays ?? 7, logger });

    // Step A: Write memory mirrors for LanceDB records (if provided)
```

- [ ] **Step 3: Run the D1/B tests**

```bash
node --test tests/smoke-obsidian-bridge-sprint3.test.js 2>&1 | grep -E "expireStaleBundles|PASS|FAIL"
```

Expected: Both `expireStaleBundles` tests PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/obsidian-bridge.js
git commit -m "feat(obs-bridge): wire expireStaleBundles in rebuildDashboards per-workspace loop (D1/B)"
```

---

## Task 5: D1/A — Implement autoApproveAndApplyLowRisk

**Files:**
- Modify: `lib/obsidian-control-room.js`

Two changes: (1) add the new exported function after `expireStaleBundles`; (2) call it at the end of `prepareReviewBundle()` as best-effort.

- [ ] **Step 1: Add `autoApproveAndApplyLowRisk` after `expireStaleBundles`**

After the closing brace of `expireStaleBundles` (around line 1978), insert:

```javascript
// D1/A: auto-approve pending low-risk items that passed adversarial review, then apply them.
// Opt-in via cfg.autoApplyLowRisk — default false so existing setups are not affected.
// vault_hygiene items are excluded (D2 handles those separately).
// If options.memoryStore is absent, memory_promotion items land in blocked (safe deferral).
export async function autoApproveAndApplyLowRisk(rawConfig = {}, bundleId, options = {}) {
  const cfg = normalizeObsidianControlRoomConfig(rawConfig);
  if (!cfg.autoApplyLowRisk) return { autoApproved: 0, autoApplied: 0, blocked: [] };

  let loaded;
  try {
    loaded = loadBundleRecord(rawConfig, bundleId, options);
  } catch (_) {
    return { autoApproved: 0, autoApplied: 0, blocked: [] };
  }
  if (!loaded?.record) return { autoApproved: 0, autoApplied: 0, blocked: [] };

  const candidates = loaded.record.items.filter(
    (item) =>
      item.status === "pending" &&
      item.risk === "low" &&
      item.adversarialReview?.status === "pass" &&
      item.type !== "vault_hygiene"
  );
  if (candidates.length === 0) return { autoApproved: 0, autoApplied: 0, blocked: [] };

  const nowIsoStr = (options.now ? new Date(options.now) : new Date()).toISOString();
  for (const item of candidates) {
    item.status = "approved";
    item.approvedAt = nowIsoStr;
    item.approvedBy = "auto";
  }
  saveBundleRecord(loaded);

  const applyResult = await applyApprovedReviewBundle(rawConfig, bundleId, options);
  return {
    autoApproved: candidates.length,
    autoApplied: applyResult.applied.length,
    blocked: applyResult.blocked,
  };
}
```

- [ ] **Step 2: Wire the call at the end of `prepareReviewBundle()`**

`prepareReviewBundle` (line 1329) ends with:
```javascript
  return {
    status: paths.ok ? "prepared" : "blocked",
    ok: paths.ok,
    error: paths.ok ? null : paths.error,
    applied: false,
    bundle,
    items,
    hygieneItems,
    maintenance,
    written,
    pipeline,
  };
}
```

Change to:
```javascript
  const result = {
    status: paths.ok ? "prepared" : "blocked",
    ok: paths.ok,
    error: paths.ok ? null : paths.error,
    applied: false,
    bundle,
    items,
    hygieneItems,
    maintenance,
    written,
    pipeline,
  };

  if (bundleId && result.items?.length > 0) {
    try {
      await autoApproveAndApplyLowRisk(rawConfig, bundleId, options);
    } catch (_) { /* best-effort — never block bundle creation */ }
  }

  return result;
}
```

- [ ] **Step 3: Run all 6 Sprint 3 tests**

```bash
node --test tests/smoke-obsidian-bridge-sprint3.test.js 2>&1
```

Expected: All 6 tests PASS (0 failures).

If tests 3-6 still fail, check: Is `autoApproveAndApplyLowRisk` exported? Does the import in the test file match? Are `loadBundleRecord` and `saveBundleRecord` accessible from inside the new function (they are private functions in the same file — confirm they are in scope)?

- [ ] **Step 4: Commit**

```bash
git add lib/obsidian-control-room.js
git commit -m "feat(obs-bridge): auto-approve+apply low-risk adversarially-passed items (D1/A)"
```

---

## Task 6: Full Regression Check

- [ ] **Step 1: Run the full test suite**

```bash
npm test 2>&1
```

Expected: 519 or more passing, same baseline as before Sprint 3. Only the pre-existing 2 flaky perf timing failures are acceptable.

If new failures appear, fix them before continuing.

- [ ] **Step 2: Run Sprint 3 tests one final time**

```bash
node --test tests/smoke-obsidian-bridge-sprint3.test.js 2>&1
```

Expected: 6/6 pass.

- [ ] **Step 3: Commit the test file if not already committed**

```bash
git add tests/smoke-obsidian-bridge-sprint3.test.js
git status
```

If the test file is unstaged, commit it:
```bash
git commit -m "test(obs-bridge): smoke tests for Sprint 3 (expireStaleBundles + autoApproveAndApplyLowRisk)"
```

---

## Success Criteria

- `node --test tests/smoke-obsidian-bridge-sprint3.test.js` → 6/6 pass
- `npm test` → no new failures vs. pre-sprint baseline
- `bundleCooldownMs: 900000` is set in `.openclaw/openclaw.json` → `grep bundleCooldownMs .openclaw/openclaw.json` outputs `"bundleCooldownMs": 900000`
- `expireStaleBundles` is called inside `rebuildDashboards()` workspace loop → `grep -n expireStaleBundles lib/obsidian-bridge.js` shows a call site
- `autoApproveAndApplyLowRisk` is exported and called at end of `prepareReviewBundle` → `grep -n autoApproveAndApplyLowRisk lib/obsidian-control-room.js` shows definition + call
