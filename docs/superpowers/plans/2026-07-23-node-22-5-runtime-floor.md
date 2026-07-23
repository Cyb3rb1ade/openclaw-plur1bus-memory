# Node.js 22.5 Runtime Floor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Node.js 22.5.0 the minimum supported PLUR1BUS runtime across package metadata, CI, and installation documentation.

**Architecture:** The npm `engines` field remains the canonical package compatibility contract. A focused contract test keeps `package.json`, the lockfile root package, the CI minimum-version lane, and README installation guidance aligned; CI tests both the exact floor and the maintained Node.js 22 line.

**Tech Stack:** Node.js 22.5+, npm lockfile v3, GitHub Actions, native `node:test`.

## Global Constraints

- The exact runtime floor is Node.js `>=22.5.0`.
- Do not add a custom runtime gate or `engine-strict`.
- Do not change dependencies, PLUR1BUS feature behavior, storage formats, or configuration defaults.
- Do not rewrite archived audit evidence or historical design documents.

---

### Task 1: Align and enforce the Node.js runtime contract

**Files:**
- Create: `tests/node-runtime-floor.test.js`
- Modify: `package.json:51-53`
- Modify: `package-lock.json:19-21`
- Modify: `.github/workflows/ci.yml:27-38`
- Modify: `README.md:242-254`
- Modify: `README.md:415-419`

**Interfaces:**
- Consumes: npm's `engines.node` metadata, the GitHub Actions test matrix, and the README installation section.
- Produces: one repository-wide Node.js runtime contract with exact floor `>=22.5.0`.

- [ ] **Step 1: Add a failing runtime-contract test**

Create `tests/node-runtime-floor.test.js`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readRepoFile = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Node.js 22.5 is the package, CI, and installation runtime floor", () => {
  const packageJson = JSON.parse(readRepoFile("package.json"));
  const packageLock = JSON.parse(readRepoFile("package-lock.json"));
  const workflow = readRepoFile(".github/workflows/ci.yml");
  const readme = readRepoFile("README.md");

  assert.equal(packageJson.engines.node, ">=22.5.0");
  assert.equal(packageLock.packages[""].engines.node, ">=22.5.0");
  assert.match(workflow, /node-version:\s*\['22\.5\.0', 22\]/);
  assert.doesNotMatch(workflow, /20\.9\.0/);
  assert.match(readme, /Node\.js 22\.5 or newer/);
  assert.match(
    readme,
    /node:sqlite.*available throughout the supported Node\.js runtime range/,
  );
});
```

- [ ] **Step 2: Run the contract test and verify the old runtime contract fails**

Run:

```bash
node --test tests/node-runtime-floor.test.js
```

Expected: FAIL because `package.json` still declares `>=20.9.0`.

- [ ] **Step 3: Update package metadata and CI**

Set the root engine in `package.json` and `package-lock.json` to:

```json
"engines": {
  "node": ">=22.5.0"
}
```

Set the CI test matrix in `.github/workflows/ci.yml` to:

```yaml
strategy:
  matrix:
    node-version: ['22.5.0', 22]
```

Keep the existing Node.js 22 lint job unchanged.

- [ ] **Step 4: Update current installation documentation**

Add this sentence immediately below `## Installation` in `README.md`:

```markdown
PLUR1BUS requires Node.js 22.5 or newer.
```

Replace the existing SQLite persistence runtime note with:

```markdown
- Persistence uses the built-in `node:sqlite` module available throughout the supported Node.js runtime range; if SQLite initialization is unavailable, the cache falls back to memory-only.
```

- [ ] **Step 5: Run the focused contract and package checks**

Run:

```bash
node --test tests/node-runtime-floor.test.js
npm ci --ignore-scripts
npm audit
npm run lint
git diff --check
```

Expected: every command exits `0`; `npm audit` reports zero vulnerabilities.

- [ ] **Step 6: Run the full serial regression suite**

Run:

```bash
node --test --test-concurrency=1 tests/*.test.js test/*.test.js
```

Expected: zero failed tests; any pre-existing explicit skips remain skips.

- [ ] **Step 7: Commit the implementation**

```bash
git add tests/node-runtime-floor.test.js package.json package-lock.json .github/workflows/ci.yml README.md
git commit -m "chore: require Node.js 22.5 or newer"
```

- [ ] **Step 8: Push and verify PR #86**

Run:

```bash
git push origin fix/high-mid-audit-findings-continuation
```

Expected GitHub checks:

- `dependency-review`: success
- `lint`: success
- `test (22.5.0)`: success
- `test (22)`: success
