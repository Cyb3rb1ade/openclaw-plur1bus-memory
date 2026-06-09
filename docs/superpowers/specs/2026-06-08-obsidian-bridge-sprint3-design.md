# Obsidian Bridge Sprint 3 — Design Spec

**Goal:** Activate the three remaining unfinished items in the Obsidian Bridge stabilization backlog: enable the bundle cooldown config (P3), wire the already-implemented stale-bundle-expiry function (D1/B), and build auto-approve+apply for low-risk items (D1/A). All operations run per-workspace.

**Scope:** 3 targeted changes. P1, D2, U3, U5 are already implemented in production code.

---

## Background: What Is Already Done

Code audit (2026-06-08) confirmed these items are already fully implemented:

| Item | Location |
|---|---|
| P1: Hash-Mismatch Fix | `DEFAULT_IGNORE_GLOBS` in `obsidian-bridge.js` — recursive globs with `// P1-Fix (2026-05-28)` comment |
| D2: vault_hygiene separation | `// D2:` comments in `obsidian-control-room.js:1385` and `:1924` |
| U3: Bundle-Markdown simplification | `// U3:` comment, `.items.json` separation at `:1291` |
| U5: Dashboard Freshness | `// U5:` comment and `> 🔄 Generated: …` header in `dashboard-generator.js:57` |

---

## What Needs to Be Built

### Item 1: P3 — Bundle-Cooldown aktivieren

**Status:** Logic fully implemented, config value missing.

`prepareReviewBundle()` already reads `bundleCooldownMs` from `paths.cfg` (line 1336), defaults to `0` if absent → cooldown never activates.

**Fix:** Set the value in `openclaw.json` obsidian-bridge plugin config.

```json
// in .openclaw/openclaw.json → plugins.entries.obsidian-bridge
{
  "bundleCooldownMs": 900000
}
```

15 minutes (900,000 ms) matches the original analysis recommendation.

`openclaw.plugin.json` already has the schema entry at line 788 — no schema change needed.

---

### Item 2: D1/B — Stale-Bundle-Expiry Wiring

**Status:** `expireStaleBundles()` fully implemented in `obsidian-control-room.js:1945`, never called.

**Fix:** Call it inside `rebuildDashboards()` workspace loop in `obsidian-bridge.js`, once per workspace using the workspace-specific `vaultCfg`.

```javascript
// in rebuildDashboards(), inside the `for (const workspace of workspaces)` loop
// at the top, before generateDashboards / writeGraphLinks
const staleDays = cfg.staleBundleMaxAgeDays ?? 7;
expireStaleBundles(vaultCfg, { staleBundleMaxAgeDays: staleDays, logger });
```

`vaultCfg` already has `vaultPath: workspace.path` set (line 1643), so each workspace's bundle store is targeted independently.

**Schema:** Add `staleBundleMaxAgeDays` to `openclaw.plugin.json` obsidian-bridge schema:

```json
"staleBundleMaxAgeDays": {
  "type": "number",
  "default": 7
}
```

---

### Item 3: D1/A — Auto-Approve Low-Risk (Two-Phase)

**Status:** Not implemented.

#### New function: `autoApproveAndApplyLowRisk(rawConfig, bundleId, options)`

Location: `lib/obsidian-control-room.js`, after `expireStaleBundles`.

```javascript
export async function autoApproveAndApplyLowRisk(rawConfig = {}, bundleId, options = {}) {
  const cfg = normalizeObsidianControlRoomConfig(rawConfig);
  if (!cfg.autoApplyLowRisk) return { autoApproved: 0, autoApplied: 0, blocked: [] };

  const loaded = loadBundleRecord(rawConfig, bundleId, options);
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

  // Phase 2: apply — reuses existing apply logic including revalidation + safety blocks
  const applyResult = await applyApprovedReviewBundle(rawConfig, bundleId, options);
  return {
    autoApproved: candidates.length,
    autoApplied: applyResult.applied.length,
    blocked: applyResult.blocked,
  };
}
```

**Criteria for auto-approve:**
- `item.status === 'pending'` — not already processed
- `item.risk === 'low'` — classified as low-risk
- `item.adversarialReview?.status === 'pass'` — adversarial check passed
- `item.type !== 'vault_hygiene'` — hygiene items are handled separately by D2

**Config gate:** `cfg.autoApplyLowRisk` (boolean, default `false`, opt-in). Read from `normalizeObsidianControlRoomConfig`.

**Apply behavior:** Calls existing `applyApprovedReviewBundle()` which handles revalidation, safety blocks, and `memoryStore`. If `options.memoryStore` is not available (e.g., called from non-bridge contexts), `memory_promotion` items will be `blocked` — safe deferral, not data loss.

#### Wiring: Called at end of `prepareReviewBundle()`

`prepareReviewBundle` already has the workspace-specific `rawConfig` (callers pass vault-specific config), so no per-workspace iteration needed here — each call already targets one workspace.

```javascript
// at end of prepareReviewBundle(), before the final return
if (bundleId && result.items?.length > 0) {
  try {
    await autoApproveAndApplyLowRisk(rawConfig, bundleId, options);
  } catch (_) { /* best-effort — never block bundle creation */ }
}
return result;
```

#### Config: `normalizeObsidianControlRoomConfig` addition

```javascript
autoApplyLowRisk: cfg.autoApplyLowRisk === true,
```

#### Schema: Add to `openclaw.plugin.json`

```json
"autoApplyLowRisk": {
  "type": "boolean",
  "default": false
}
```

---

## Files Changed

| File | Change |
|---|---|
| `lib/obsidian-control-room.js` | New `autoApproveAndApplyLowRisk()` function; `autoApplyLowRisk` field in `normalizeObsidianControlRoomConfig`; call it at end of `prepareReviewBundle` |
| `lib/obsidian-bridge.js` | Call `expireStaleBundles(vaultCfg, ...)` inside `rebuildDashboards()` workspace loop |
| `openclaw.plugin.json` | Add `staleBundleMaxAgeDays` and `autoApplyLowRisk` schema entries |
| `.openclaw/openclaw.json` | Add `bundleCooldownMs: 900000` to obsidian-bridge plugin config |
| `tests/smoke-obsidian-bridge-sprint3.test.js` | New test file (6 tests) |

---

## Tests: `tests/smoke-obsidian-bridge-sprint3.test.js`

All tests use mocked filesystem and time (`options.now`). No real LanceDB.

**1. `expireStaleBundles` — bundle older than maxAgeDays is expired**
- Write a `.items.json` with `bundle.status: 'pending'`, `bundle.createdAt` = 8 days ago
- Call `expireStaleBundles(cfg, { staleBundleMaxAgeDays: 7 })`
- Assert result: `expired: 1`, bundle status in file = `'expired'`

**2. `expireStaleBundles` — bundle younger than maxAgeDays is untouched**
- Same setup but `createdAt` = 3 days ago
- Assert result: `expired: 0`

**3. `autoApproveAndApplyLowRisk` — low-risk pass items are approved + applied**
- Bundle with 2 items: both `risk: 'low'`, `adversarialReview: { status: 'pass' }`, `status: 'pending'`, `type: 'task_suggestion'`
- Call with `autoApplyLowRisk: true`
- Assert: `autoApproved: 2`, `autoApplied: 2`, items in saved record have `status: 'applied'`

**4. `autoApproveAndApplyLowRisk` — medium-risk items are skipped**
- Bundle with 1 item: `risk: 'medium'`, `adversarialReview: { status: 'pass' }`, `status: 'pending'`
- Call with `autoApplyLowRisk: true`
- Assert: `autoApproved: 0`, item status unchanged

**5. `autoApproveAndApplyLowRisk` — adversarial fail items are skipped**
- Bundle with 1 item: `risk: 'low'`, `adversarialReview: { status: 'fail' }`, `status: 'pending'`
- Assert: `autoApproved: 0`

**6. `autoApproveAndApplyLowRisk` — no-op when autoApplyLowRisk is false (default)**
- Bundle with 1 low-risk pass item
- Call with `autoApplyLowRisk: false` (default)
- Assert: `autoApproved: 0`, item status unchanged

---

## Per-Workspace Guarantee

- **D1/B** runs inside the `rebuildDashboards()` workspace loop with `vaultCfg` — each workspace's bundle store is independently scanned.
- **D1/A** fires at the end of `prepareReviewBundle()` — every caller already passes workspace-specific `rawConfig` (the `vaultPath` is set before calling).
- **P3** is config-driven; `prepareReviewBundle()` reads `bundleCooldownMs` from `paths.cfg` which resolves per vault.

---

## Success Criteria

- `node --test tests/smoke-obsidian-bridge-sprint3.test.js` → 0 failures
- `npm test` → no regressions vs. 519/521 baseline
- Bundles are not created more than once per 15 minutes (P3)
- Bundles older than 7 days are rejected on next `rebuildDashboards` run (D1/B)
- Low-risk + adversarial-pass items are auto-applied after bundle creation when `autoApplyLowRisk: true` (D1/A)

---

## Out of Scope

- U6 (Review-Profile auf 2 reduzieren) — Rückwärtskompatibilität, eigener Sprint
- U1, U2, U4, U7 — UX-Features, eigener Sprint
- P2 (undefined-Links Fix) — `lib/obsidian/link-suggestions.js`, eigener Sprint
