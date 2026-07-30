# Feature-Cron Config Timeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the feature-cron setup runner 30 seconds to load OpenClaw's redacted effective configuration without widening any other CLI timeout.

**Architecture:** Keep `loadFeatureCronConfig()` and its fail-closed result contract unchanged. Increase only the timeout passed to the existing `openclaw gateway call config.get --json` boundary, protected by a direct unit regression that rejects the old 15-second budget.

**Tech Stack:** Node.js ESM, `node:test`, `node:assert`, OpenClaw CLI wrapper.

## Global Constraints

- Only the `config.get` timeout changes from 15,000 to 30,000 ms.
- Do not add retries or change the shared OpenClaw CLI wrapper default.
- Do not change cron schedules, delivery, model routing, or thinking policy.
- Preserve every existing fail-closed error result.
- PLUR1BUS 7.1.7 and tag `v7.1.7` remain immutable.

---

### Task 1: Extend the redacted config snapshot budget

**Files:**
- Modify: `tests/feature-cron-bootstrap.test.js`
- Modify: `scripts/setup-feature-crons.mjs:208-217`

**Interfaces:**
- Consumes: `loadFeatureCronConfig(openclawImpl)` where `openclawImpl(args, timeout)` returns `{ok, stdout, stderr, status, error}`.
- Produces: The unchanged success union `{ok: true, sourceConfig, runtimeConfig}` or fail-closed error union `{ok: false, error}` while requesting exactly `30000` ms for `config.get`.

- [ ] **Step 1: Write the failing regression test**

Add `loadFeatureCronConfig` to the existing import from
`../scripts/setup-feature-crons.mjs`, then add this focused suite before the
`runSetupFeatureCrons effective config snapshot` suite:

```js
describe("loadFeatureCronConfig timeout budget", () => {
  it("allows 30 seconds for the redacted gateway snapshot", () => {
    const sourceConfig = {
      plugins: {
        entries: {
          "memory-lancedb-namespaced": {
            enabled: true,
            config: { criticalPush: { enabled: true } },
          },
        },
      },
    };
    const runtimeConfig = { agents: { defaults: {} } };
    let receivedTimeout;

    const result = loadFeatureCronConfig((args, timeout) => {
      assert.deepStrictEqual(args, ["gateway", "call", "config.get", "--json"]);
      receivedTimeout = timeout;
      if (timeout < 30_000) {
        return {
          ok: false,
          stdout: "",
          stderr: "",
          status: 1,
          error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
        };
      }
      return {
        ok: true,
        stdout: JSON.stringify({ valid: true, sourceConfig, runtimeConfig }),
        stderr: "",
        status: 0,
      };
    });

    assert.equal(receivedTimeout, 30_000);
    assert.deepStrictEqual(result, { ok: true, sourceConfig, runtimeConfig });
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test \
  --test-name-pattern="allows 30 seconds for the redacted gateway snapshot" \
  tests/feature-cron-bootstrap.test.js
```

Expected: FAIL because `receivedTimeout` is `15000`, and
`loadFeatureCronConfig()` returns `config-call-failed`.

- [ ] **Step 3: Implement the minimal timeout change**

In `loadFeatureCronConfig()`, change only the timeout argument:

```js
result = openclawImpl(["gateway", "call", "config.get", "--json"], 30000);
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test \
  --test-name-pattern="allows 30 seconds for the redacted gateway snapshot" \
  tests/feature-cron-bootstrap.test.js
```

Expected: PASS.

- [ ] **Step 5: Run the complete feature-cron test file**

Run:

```bash
node --test tests/feature-cron-bootstrap.test.js
```

Expected: all tests pass with zero failures.

- [ ] **Step 6: Run repository verification**

Run:

```bash
npm run lint
npm test
git diff --check
```

Expected: lint exits 0; full suite reports zero failures; diff check exits 0.

- [ ] **Step 7: Commit the implementation**

```bash
git add scripts/setup-feature-crons.mjs tests/feature-cron-bootstrap.test.js
git commit -m "fix: allow slow feature cron config snapshots"
```

- [ ] **Step 8: Publish the follow-up for review**

```bash
git push --set-upstream origin codex/feature-cron-config-timeout
gh pr create \
  --base main \
  --head codex/feature-cron-config-timeout \
  --title "fix: allow slow feature cron config snapshots" \
  --body $'## Summary\n\n- allow 30 seconds for the redacted `config.get` snapshot used by feature-cron setup\n- keep all other CLI timeouts and fail-closed behavior unchanged\n\n## Evidence\n\nThe live gateway needed approximately 12.5–18 seconds for this call, so the previous 15-second child timeout returned `ETIMEDOUT` despite a healthy gateway.\n\n## Verification\n\n- focused regression demonstrated RED at 15 seconds and GREEN at 30 seconds\n- `node --test tests/feature-cron-bootstrap.test.js`\n- `npm run lint`\n- `npm test`\n- `git diff --check`'
```
