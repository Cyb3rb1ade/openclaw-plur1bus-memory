# Obsidian Bridge UX — U6 (Profile Reduction) + U2 (commands.md) + Smoke Tests

**Date:** 2026-06-09
**Status:** Approved

---

## Context

Two open UX items remain from the original Obsidian Bridge backlog (2026-05-27), plus four items (U1/U2/U4/U7) that were already implemented but have no dedicated tests. This spec covers:

- **U6** — Reduce active review profiles from 3 to 2 (`standard` + `maintenance`). The `adversarial` profile is redundant: adversarial review is now a pipeline step applied to all items regardless of profile tag. Keeping it as a named profile causes user confusion and doubles the rendering noise in bundle output.
- **U2** — Complete the commands-discoverability feature. The help bot command exists (`obsidianCommandHelp()`) but no code path writes `plur1bus/commands.md` to the vault. The vault file is the missing piece.
- **Smoke tests** — Add `tests/smoke-ux.test.js` covering U1/U2/U4/U7 (implementations already exist, tests do not).

---

## U6: Review Profile Reduction

### Design

**Approach: normalize-on-read.** Remove `"adversarial"` from the `REVIEW_PROFILES` constant and add a one-line remap in `normalizeReviewProfile()` before the validation check. No schema version bump; no migration script. All existing bundle files that carry `reviewProfile: "adversarial"` on items will be silently mapped to `"standard"` the next time they pass through `normalizeReviewItem()`.

### Changes

**`lib/obsidian-control-room.js`**

1. `REVIEW_PROFILES` constant (line 62): remove `"adversarial"` from the frozen array.

2. `normalizeReviewProfile()` (line 901): add remap before the validation:
   ```js
   function normalizeReviewProfile(profile) {
     if (profile === "adversarial") return "standard";
     return REVIEW_PROFILES.includes(profile) ? profile : "standard";
   }
   ```

3. `prepareReviewBundle()` default (line 1371): change fallback array from
   `["standard", "maintenance", "adversarial"]` → `["standard", "maintenance"]`.

4. `runMorningReview()` default (line 1476): same change.

5. Weekly command handler (line 3273): change
   `["maintenance", "adversarial", "project_manager"]` → `["maintenance", "project_manager"]`.

### Backward compatibility

`normalizeReviewProfile("adversarial")` now returns `"standard"`. Any persisted bundle item with `reviewProfile: "adversarial"` reads back as `"standard"` without any file rewrite or one-off migration. The mapping is transparent to callers.

---

## U2: commands.md Writer

### Design

Add `export function writeCommandsMarkdown(rawConfig, options = {})` to `lib/obsidian-control-room.js`. It builds a markdown file from the existing `obsidianCommandHelp()` output and writes it via `atomicWriteText` to `{vaultPath}/plur1bus/commands.md`. Call it from `rebuildDashboards()` in `lib/obsidian-bridge.js`, per workspace, after `generateDashboards()`.

### File content

```markdown
---
plur1bus_type: command_reference
generated_at: <ISO timestamp>
---

# PLUR1BUS Commands

<obsidianCommandHelp() output>
```

### Changes

**`lib/obsidian-control-room.js`**

Add after the existing `autoApproveAndApplyLowRisk` export (near line 2060):

```js
export function writeCommandsMarkdown(rawConfig = {}, options = {}) {
  const paths = resolveObsidianBridgePaths(rawConfig, options);
  if (!paths.ok) return { written: false, reason: "paths-not-ok" };
  const generatedAt = (options.now ? new Date(options.now) : new Date()).toISOString();
  const content = [
    "---",
    "plur1bus_type: command_reference",
    `generated_at: ${generatedAt}`,
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

**`lib/obsidian-bridge.js`**

1. Add import: `import { …, writeCommandsMarkdown } from "./obsidian-control-room.js";`
2. In `rebuildDashboards()`, after `generateDashboards()` call (line ~1676), add:
   ```js
   writeCommandsMarkdown(vaultCfg, { logger });
   ```
   Wrapped in the existing try/catch block — failure is logged as a warning, not thrown.

---

## Smoke Tests (tests/smoke-ux.test.js)

Four test groups, one per UX item. All test pure functions or functions with injectable deps; no real filesystem writes.

### U1 — `reviewProgressSection` (`lib/obsidian/dashboard-generator.js:34`)

```
given: [{status:'pending'}, {status:'applied'}, {status:'rejected'}, {status:'pending'}]
expect: section contains "Pending review items: 2", "Applied: 1", "Rejected: 1", "Total tracked: 4"
```

Also test empty array → all counts zero.

### U2 — `writeCommandsMarkdown` (`lib/obsidian-control-room.js`)

Use a `node:fs` tmpdir fixture (same pattern as sprint-3 tests). Call `writeCommandsMarkdown` with a rawConfig pointing to the tmpdir as `vaultPath`. Verify:
- Return value `{ written: true }`
- Written file at `<tmpdir>/plur1bus/commands.md` contains `plur1bus_type: command_reference`
- Written file contains the `/plur1bus_morning` line from `obsidianCommandHelp()`
- When `vaultPath` is omitted (bad config), returns `{ written: false }` without throwing

### U4 — `quickapplySummary` (`lib/obsidian-control-room.js:3087`)

```
given: { applied: [{}, {}], blocked: [] }
expect: output contains "2 Einträge gespeichert"

given: { applied: [{}], blocked: [], items: [{status:'pending', risk:'medium'}] }
expect: output contains "1 Eintrag" and contains "wartet"
```

### U7 — `generateMemoryCardTemplate` (`lib/obsidian-control-room.js:2031`)

```
given: { workspaceId: "main", agentId: "main" }
expect: output contains all 12 required fields:
  plur1bus_type, workspace_id, agent_id, memory_id, category, importance,
  scope, source_kind, sync_status, content_hash, validated, updated_at
expect: sync_status value is "draft"
expect: content_hash line ends with ": " (intentionally blank)
expect: validated value is "false"
```

---

## Implementation order

1. U6 changes (3 files, ~6 lines) — pure logic, no new exports
2. U2 `writeCommandsMarkdown` + bridge wiring
3. `tests/smoke-ux.test.js`
4. Run `npm test` — verify no regressions

---

## Verification

```bash
# New tests pass
node --test tests/smoke-ux.test.js

# Full suite — no new failures vs. sprint 3 baseline
npm test
```

Manual check: trigger `rebuildDashboards` and confirm `plur1bus/commands.md` appears in vault with correct frontmatter.
