# Obsidian Bridge UX — U6 + U2 + Smoke Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the redundant `"adversarial"` review profile (U6), add `writeCommandsMarkdown()` to write `plur1bus/commands.md` per workspace (U2), and add smoke tests for U1/U2/U4/U7.

**Architecture:** U6 uses normalize-on-read — `normalizeReviewProfile()` remaps `"adversarial"` → `"standard"` at every call site (creation + display), no schema version bump. U2 adds a single new export to `lib/obsidian-control-room.js` called in `rebuildDashboards()`. Smoke tests cover the four UX items in `tests/smoke-ux.test.js` using TDD.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert`, `node:fs` tmpdir fixtures.

---

## File Map

> All changes go to root-level `lib/` — `plur1bus/lib/` is the archived `@cyb3rb1ade/plur1bus-memory` v5.2.11 standalone package; do not touch it.

| Action | File | What changes |
|--------|------|-------------|
| Modify | `lib/obsidian-control-room.js` | Export `normalizeReviewProfile`, remove `"adversarial"` from `REVIEW_PROFILES`, add remap, fix 3 default arrays, fix display in `renderReviewItem`, add `writeCommandsMarkdown` export |
| Modify | `lib/obsidian-bridge.js` | Import + call `writeCommandsMarkdown` in `rebuildDashboards()` |
| Modify | `lib/obsidian/dashboard-generator.js` | Export `reviewProgressSection` |
| Create | `tests/smoke-ux.test.js` | Smoke tests for U6, U1, U2, U4, U7 |

---

## Task 1: U6 — Export `normalizeReviewProfile` and write failing tests

**Files:**
- Modify: `lib/obsidian-control-room.js:901`
- Create: `tests/smoke-ux.test.js`

- [ ] **Step 1: Export `normalizeReviewProfile`**

  In `lib/obsidian-control-room.js`, find line 901:
  ```js
  function normalizeReviewProfile(profile) {
    return REVIEW_PROFILES.includes(profile) ? profile : "standard";
  }
  ```
  Change to:
  ```js
  export function normalizeReviewProfile(profile) {
    return REVIEW_PROFILES.includes(profile) ? profile : "standard";
  }
  ```

- [ ] **Step 2: Create `tests/smoke-ux.test.js` with the U6 test suite**

  ```js
  import { describe, it } from "node:test";
  import assert from "node:assert";
  import { mkdtempSync, readFileSync } from "node:fs";
  import { tmpdir } from "node:os";
  import { join } from "node:path";
  import { normalizeReviewProfile, REVIEW_PROFILES } from "../lib/obsidian-control-room.js";

  describe("smoke-ux: U6 — normalizeReviewProfile", () => {
    it("maps adversarial to standard", () => {
      assert.strictEqual(normalizeReviewProfile("adversarial"), "standard");
    });

    it("preserves standard", () => {
      assert.strictEqual(normalizeReviewProfile("standard"), "standard");
    });

    it("preserves maintenance", () => {
      assert.strictEqual(normalizeReviewProfile("maintenance"), "maintenance");
    });

    it("unknown profile falls back to standard", () => {
      assert.strictEqual(normalizeReviewProfile("totally-unknown"), "standard");
    });

    it("REVIEW_PROFILES does not include adversarial", () => {
      assert.strictEqual(REVIEW_PROFILES.includes("adversarial"), false);
    });
  });
  ```

- [ ] **Step 3: Run the tests — verify they FAIL**

  ```bash
  node --test tests/smoke-ux.test.js 2>&1 | head -40
  ```

  Expected: `maps adversarial to standard` fails (currently returns `"adversarial"`), `REVIEW_PROFILES does not include adversarial` fails (currently it is included). The other three tests should already pass.

---

## Task 2: U6 — Implement profile reduction

**Files:**
- Modify: `lib/obsidian-control-room.js` (6 locations)

- [ ] **Step 1: Add the remap in `normalizeReviewProfile` (line 901)**

  Change:
  ```js
  export function normalizeReviewProfile(profile) {
    return REVIEW_PROFILES.includes(profile) ? profile : "standard";
  }
  ```
  To:
  ```js
  export function normalizeReviewProfile(profile) {
    if (profile === "adversarial") return "standard";
    return REVIEW_PROFILES.includes(profile) ? profile : "standard";
  }
  ```

- [ ] **Step 2: Remove `"adversarial"` from `REVIEW_PROFILES` (line 62)**

  Change:
  ```js
  export const REVIEW_PROFILES = Object.freeze([
    "standard",
    "conservative",
    "adversarial",
    "maintenance",
    "project_manager",
    "semantic_deep",
  ]);
  ```
  To:
  ```js
  export const REVIEW_PROFILES = Object.freeze([
    "standard",
    "conservative",
    "maintenance",
    "project_manager",
    "semantic_deep",
  ]);
  ```

- [ ] **Step 3: Update default array in `prepareReviewBundle` (line ~1371)**

  Change:
  ```js
  : ["standard", "maintenance", "adversarial"];
  ```
  To:
  ```js
  : ["standard", "maintenance"];
  ```

- [ ] **Step 4: Update default array in `runMorningReview` (line ~1476)**

  Change:
  ```js
  reviewProfiles: options.reviewProfiles || ["standard", "maintenance", "adversarial"],
  ```
  To:
  ```js
  reviewProfiles: options.reviewProfiles || ["standard", "maintenance"],
  ```

- [ ] **Step 5: Update default array in weekly command handler (line ~3273)**

  Change:
  ```js
  reviewProfiles: ["maintenance", "adversarial", "project_manager"]
  ```
  To:
  ```js
  reviewProfiles: ["maintenance", "project_manager"]
  ```

- [ ] **Step 6: Normalize display in `renderReviewItem` (line ~1303)**

  The function currently renders:
  ```js
  `- Review profile: ${item.reviewProfile}`,
  ```
  Change to:
  ```js
  `- Review profile: ${normalizeReviewProfile(item.reviewProfile)}`,
  ```
  This ensures old persisted bundle items tagged `"adversarial"` display as `"standard"` immediately without any file rewrite.

---

## Task 3: U6 — Verify tests pass and commit

**Files:** none new

- [ ] **Step 1: Run the U6 tests**

  ```bash
  node --test tests/smoke-ux.test.js 2>&1
  ```

  Expected: all 5 tests in `smoke-ux: U6 — normalizeReviewProfile` PASS.

- [ ] **Step 2: Run full test suite — verify no regressions**

  ```bash
  npm test 2>&1 | tail -20
  ```

  Expected: same pass/fail ratio as before (≥520 pass, only the pre-existing flaky perf test fails).

- [ ] **Step 3: Commit**

  ```bash
  git add lib/obsidian-control-room.js tests/smoke-ux.test.js
  git commit -m "feat(obs-bridge): U6 — remove adversarial profile, normalize-on-read"
  ```

---

## Task 4: U2 — Write failing test for `writeCommandsMarkdown`

**Files:**
- Modify: `tests/smoke-ux.test.js`

- [ ] **Step 1: Add the U2 test suite to `tests/smoke-ux.test.js`**

  Add this import at the top (alongside the existing `normalizeReviewProfile` import):
  ```js
  import {
    normalizeReviewProfile,
    REVIEW_PROFILES,
    writeCommandsMarkdown,
  } from "../lib/obsidian-control-room.js";
  ```

  Then add this test suite after the U6 suite:
  ```js
  describe("smoke-ux: U2 — writeCommandsMarkdown", () => {
    it("writes commands.md to vault and returns written:true", () => {
      const vaultPath = mkdtempSync(join(tmpdir(), "smoke-ux-u2-"));
      const result = writeCommandsMarkdown({ vaultPath }, {});
      assert.strictEqual(result.written, true, "expected written:true");
      const content = readFileSync(join(vaultPath, "plur1bus", "commands.md"), "utf8");
      assert.ok(content.includes("plur1bus_type: command_reference"), "frontmatter present");
      assert.ok(content.includes("/plur1bus_morning"), "command list present");
    });

    it("returns written:false when vaultPath is missing", () => {
      const result = writeCommandsMarkdown({}, {});
      assert.strictEqual(result.written, false, "expected written:false for bad config");
    });
  });
  ```

- [ ] **Step 2: Run test — verify it FAILS with import error**

  ```bash
  node --test tests/smoke-ux.test.js 2>&1 | head -20
  ```

  Expected: `SyntaxError` or `TypeError: writeCommandsMarkdown is not a function` — the export does not exist yet.

---

## Task 5: U2 — Implement `writeCommandsMarkdown` and wire into bridge

**Files:**
- Modify: `lib/obsidian-control-room.js` (add new export after `generateMemoryCardTemplate`)
- Modify: `lib/obsidian-bridge.js` (import + call)

- [ ] **Step 1: Add `writeCommandsMarkdown` to `lib/obsidian-control-room.js`**

  Insert after the closing brace of `generateMemoryCardTemplate` (after line 2058, before `runVaultDoctor`):

  ```js
  export function writeCommandsMarkdown(rawConfig = {}, options = {}) {
    const paths = resolveObsidianBridgePaths(rawConfig, options);
    if (!paths.ok) return { written: false, reason: "paths-not-ok" };
    const generatedAt = (options.now ? new Date(options.now) : new Date()).toISOString();
    const content = [
      "---",
      "plur1bus_type: command_reference",
      `generated_at: ${generatedAt}`,
      `obsidian_bridge_version: ${OBSIDIAN_CONTROL_ROOM_VERSION}`,
      "---",
      "",
      "# PLUR1BUS Commands",
      "",
      obsidianCommandHelp(),
      "",
    ].join("\n");
    const destPath = resolveUnder(paths.reviewPath, "commands.md", paths.cfg);
    atomicWriteText(destPath, content);
    return { written: true, path: destPath };
  }
  ```

- [ ] **Step 2: Update the import in `lib/obsidian-bridge.js` (line 35)**

  Change:
  ```js
  import { expireStaleBundles } from "./obsidian-control-room.js";
  ```
  To:
  ```js
  import { expireStaleBundles, writeCommandsMarkdown } from "./obsidian-control-room.js";
  ```

- [ ] **Step 3: Call `writeCommandsMarkdown` in `rebuildDashboards()` after `generateDashboards()`**

  In `lib/obsidian-bridge.js`, find the `generateDashboards(vaultCfg, {...})` call and the line that follows it (`built += ...`). Add the `writeCommandsMarkdown` call right after:

  ```js
  const result = generateDashboards(vaultCfg, {
    agentId: workspace.agentId,
    workspaceKey: workspace.workspaceId,
    records: allRecords,
    readExistingRecords: true,
  });
  built += Array.isArray(result) ? result.length : result?.count ?? 0;

  writeCommandsMarkdown(vaultCfg, { logger });   // U2: write commands.md per workspace
  ```

  This line is already inside the `try { ... } catch (err) { logger.warn(...) }` block — failure is logged, not thrown.

---

## Task 6: U2 — Verify tests pass and commit

- [ ] **Step 1: Run the U2 tests**

  ```bash
  node --test tests/smoke-ux.test.js 2>&1
  ```

  Expected: all 2 tests in `smoke-ux: U2 — writeCommandsMarkdown` PASS, plus the 5 U6 tests still pass.

- [ ] **Step 2: Run full test suite**

  ```bash
  npm test 2>&1 | tail -20
  ```

  Expected: no new failures.

- [ ] **Step 3: Commit**

  ```bash
  git add lib/obsidian-control-room.js lib/obsidian-bridge.js tests/smoke-ux.test.js
  git commit -m "feat(obs-bridge): U2 — writeCommandsMarkdown writes plur1bus/commands.md per workspace"
  ```

---

## Task 7: Smoke tests for U1, U4, U7

**Files:**
- Modify: `lib/obsidian/dashboard-generator.js` (export `reviewProgressSection`)
- Modify: `tests/smoke-ux.test.js` (add 3 test suites)

- [ ] **Step 1: Export `reviewProgressSection` from `lib/obsidian/dashboard-generator.js` (line 34)**

  Change:
  ```js
  function reviewProgressSection(records) {
  ```
  To:
  ```js
  export function reviewProgressSection(records) {
  ```

- [ ] **Step 2: Add imports for U1/U4/U7 to `tests/smoke-ux.test.js`**

  Add at the top alongside existing imports:
  ```js
  import { reviewProgressSection } from "../lib/obsidian/dashboard-generator.js";
  import {
    normalizeReviewProfile,
    REVIEW_PROFILES,
    writeCommandsMarkdown,
    quickapplySummary,
    generateMemoryCardTemplate,
  } from "../lib/obsidian-control-room.js";
  ```

- [ ] **Step 3: Add U1 test suite to `tests/smoke-ux.test.js`**

  ```js
  describe("smoke-ux: U1 — reviewProgressSection", () => {
    it("counts pending/applied/rejected/total correctly", () => {
      const records = [
        { status: "pending" },
        { status: "applied" },
        { status: "rejected" },
        { status: "pending" },
      ];
      const section = reviewProgressSection(records);
      assert.ok(section.includes("Pending review items: 2"), `expected pending=2, got:\n${section}`);
      assert.ok(section.includes("Applied: 1"), `expected applied=1, got:\n${section}`);
      assert.ok(section.includes("Rejected: 1"), `expected rejected=1, got:\n${section}`);
      assert.ok(section.includes("Total tracked: 4"), `expected total=4, got:\n${section}`);
    });

    it("returns all-zero counts for empty array", () => {
      const section = reviewProgressSection([]);
      assert.ok(section.includes("Pending review items: 0"));
      assert.ok(section.includes("Applied: 0"));
      assert.ok(section.includes("Total tracked: 0"));
    });

    it("treats missing status as pending", () => {
      const section = reviewProgressSection([{ id: "x" }, { status: "applied" }]);
      assert.ok(section.includes("Pending review items: 1"));
      assert.ok(section.includes("Applied: 1"));
    });
  });
  ```

- [ ] **Step 4: Add U4 test suite to `tests/smoke-ux.test.js`**

  ```js
  describe("smoke-ux: U4 — quickapplySummary", () => {
    it("shows plural applied count for 2 items", () => {
      const out = quickapplySummary({ applied: [{}, {}], blocked: [], items: [], hygieneItems: [] });
      assert.ok(out.includes("2 Einträge gespeichert"), `got: ${out}`);
    });

    it("shows singular for 1 applied item", () => {
      const out = quickapplySummary({ applied: [{}], blocked: [], items: [], hygieneItems: [] });
      assert.ok(out.includes("1 Eintrag gespeichert"), `got: ${out}`);
    });

    it("shows pending warning when medium-risk items remain", () => {
      const out = quickapplySummary({
        applied: [{}],
        blocked: [],
        items: [{ status: "pending", risk: "medium" }],
        hygieneItems: [],
      });
      assert.ok(out.includes("wartet"), `expected 'wartet', got: ${out}`);
    });

    it("shows nothing-to-do when all fields are empty", () => {
      const out = quickapplySummary({ applied: [], blocked: [], items: [], hygieneItems: [] });
      assert.ok(out.includes("Nichts zu tun"), `got: ${out}`);
    });
  });
  ```

- [ ] **Step 5: Add U7 test suite to `tests/smoke-ux.test.js`**

  ```js
  describe("smoke-ux: U7 — generateMemoryCardTemplate", () => {
    it("contains all 12 required frontmatter fields", () => {
      const template = generateMemoryCardTemplate({ workspaceId: "main", agentId: "main" });
      const required = [
        "plur1bus_type", "workspace_id", "agent_id", "memory_id",
        "category", "importance", "scope", "source_kind",
        "sync_status", "content_hash", "validated", "updated_at",
      ];
      for (const field of required) {
        assert.ok(template.includes(field + ":"), `missing field: ${field}`);
      }
    });

    it("sets sync_status to draft", () => {
      const template = generateMemoryCardTemplate({});
      assert.ok(template.includes("sync_status: draft"), "sync_status should be draft");
    });

    it("leaves content_hash blank (filled by bridge on first scan)", () => {
      const template = generateMemoryCardTemplate({});
      assert.ok(/content_hash: *\n/.test(template), "content_hash should be blank");
    });

    it("sets validated to false", () => {
      const template = generateMemoryCardTemplate({});
      assert.ok(template.includes("validated: false"), "validated should be false");
    });
  });
  ```

- [ ] **Step 6: Run all smoke-ux tests — expect PASS**

  ```bash
  node --test tests/smoke-ux.test.js 2>&1
  ```

  Expected: all tests across all 5 suites (U6, U1, U2, U4, U7) pass. U1/U4/U7 implementations already exist; these tests should pass immediately.

- [ ] **Step 7: Commit**

  ```bash
  git add lib/obsidian/dashboard-generator.js tests/smoke-ux.test.js
  git commit -m "test(obs-bridge): smoke-ux tests for U1/U4/U7 + export reviewProgressSection"
  ```

---

## Task 8: Full regression pass

- [ ] **Step 1: Run full test suite**

  ```bash
  npm test 2>&1 | tail -30
  ```

  Expected: ≥520 pass, no new failures beyond the pre-existing flaky perf timing test.

- [ ] **Step 2: Push**

  ```bash
  git push
  ```

---

## Verification Summary

```bash
# All UX smoke tests pass
node --test tests/smoke-ux.test.js

# No new regressions
npm test
```

Manual: after `rebuildDashboards` runs, `plur1bus/commands.md` appears in vault with `plur1bus_type: command_reference` in frontmatter and the `/plur1bus_morning` command line visible.
