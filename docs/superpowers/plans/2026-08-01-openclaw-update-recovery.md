# OpenClaw Update Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the live installation to the exact official PLUR1BUS v7.1.9 release, eliminate the mixed-release deployment path, stagger daily consolidation, restore a safe promoted-memory reindex bridge, and publish the generic fixes in a draft GitHub pull request.

**Architecture:** Repository changes are isolated on `agent/openclaw-update-hardening` and divided into three independently testable units: deploy integrity, cron scheduling, and promoted-memory reindexing. Server-specific diagnostics and rollout stay in the private OpenClaw scripts; live mutation occurs only after a snapshot and exact-tag verification.

**Tech Stack:** Node.js ESM, Node test runner, Bash, OpenClaw CLI, LanceDB through PLUR1BUS `MemoryDB`, systemd user services, SQLite, Git/GitHub CLI.

## Global Constraints

- Deploy the exact official `v7.1.9` tag; never label modified code as 7.1.9.
- Create a PLUR1BUS snapshot before plugin deployment, consolidation execution, or reindex writes.
- Use `safeAgentId()` and `resolveInside()` for every agent-derived filesystem path.
- Reindex defaults to dry-run and requires explicit `--apply` for writes.
- Reindex uses normalized provider configuration and `MemoryDB.store()`; it must not hard-code an embedding model, dimension, or LanceDB row schema.
- Preserve user-customized cron schedules; migrate only exact previously shipped canonical schedules.
- Keep server paths, chat IDs, model policy, and the private update script out of the public commit.
- Every changed export receives focused JSDoc.
- No silent catches; errors are rethrown, returned, or emitted through safe warning/debug paths.

---

### Task 1: Make Deployment Integrity Validate the Plugin Entry Point

**Files:**
- Modify: `scripts/lib/deploy-integrity.mjs`
- Modify: `scripts/verify-plugin-deploy.mjs`
- Modify: `tests/deploy-integrity.test.js`
- Modify: `tests/installer-stub-guard.test.js`

**Interfaces:**
- Consumes: `DEPLOY_FILES`, `validateDeployment({ deployDir, repoDir, files, repair, dryRun })`, `smokeTestExports(expectations)`.
- Produces: `collectRelativeImports(entryRelativePath, repoDir): string[]` and an entry-point smoke expectation for `index.js` with export `default`.

- [ ] **Step 1: Add failing manifest-closure tests**

Add tests proving that relative runtime imports reachable from `index.js` are included and that an intentionally omitted transitive import is reported:

```js
it("covers every reachable relative runtime import from index.js", () => {
  const reachable = collectRelativeImports("index.js", REPO_ROOT);
  const missing = reachable.filter((file) => !DEPLOY_FILES.includes(file));
  assert.deepStrictEqual(missing, []);
});

it("finds a missing transitive import", () => {
  writeFileSync(join(dir, "repo", "index.js"), 'import "./lib/a.js";\nexport default {};\n');
  writeFileSync(join(dir, "repo", "lib", "a.js"), 'import "./b.js";\n');
  writeFileSync(join(dir, "repo", "lib", "b.js"), "export const b = true;\n");
  assert.deepStrictEqual(collectRelativeImports("index.js", join(dir, "repo")), [
    "index.js", "lib/a.js", "lib/b.js",
  ]);
});
```

- [ ] **Step 2: Run the deployment tests and confirm RED**

Run:

```bash
node --test tests/deploy-integrity.test.js tests/installer-stub-guard.test.js
```

Expected: FAIL because `collectRelativeImports` is not exported and `index.js` is not entry-point-smoke-tested.

- [ ] **Step 3: Implement deterministic import closure**

Implement a parser limited to static relative ESM imports/exports, resolving `.js`, `.mjs`, and explicit file paths inside `repoDir`. Reject escapes and return a sorted de-duplicated repository-relative list. Extend `DEPLOY_FILES` with any real runtime imports discovered by the test.

```js
export function collectRelativeImports(entryRelativePath, repoDir) {
  const pending = [entryRelativePath];
  const seen = new Set();
  while (pending.length > 0) {
    const relativePath = pending.shift();
    if (seen.has(relativePath)) continue;
    const absolutePath = resolvePath(repoDir, relativePath);
    if (absolutePath !== resolvePath(repoDir) && !absolutePath.startsWith(`${resolvePath(repoDir)}${sep}`)) {
      throw new Error(`deploy-integrity import escapes repository: ${relativePath}`);
    }
    seen.add(relativePath);
    const source = readFileSync(absolutePath, "utf8");
    for (const match of source.matchAll(/(?:import|export)\s+(?:[^"']*?\s+from\s+)?["'](\.[^"']+)["']/g)) {
      const resolved = resolveRelativeModule(dirname(absolutePath), match[1]);
      if (resolved) pending.push(relative(repoDir, resolved).split(sep).join("/"));
    }
  }
  return [...seen].sort();
}
```

- [ ] **Step 4: Add deployed `index.js` to the real-import smoke test**

In `scripts/verify-plugin-deploy.mjs`, prepend:

```js
{ file: "index.js", exports: ["default"] },
```

The existing `smokeTestExports()` path then catches missing transitive exports such as `validateTimeZone` before restart.

- [ ] **Step 5: Run targeted tests and commit**

Run:

```bash
node --test tests/deploy-integrity.test.js tests/installer-stub-guard.test.js tests/repair-scripts.test.js
git add scripts/lib/deploy-integrity.mjs scripts/verify-plugin-deploy.mjs tests/deploy-integrity.test.js tests/installer-stub-guard.test.js
git commit -m "fix: validate complete plugin deployments"
```

Expected: all targeted tests PASS.

---

### Task 2: Stagger and Conservatively Migrate Daily Consolidation Crons

**Files:**
- Modify: `lib/setup/feature-cron-plan.js`
- Modify: `scripts/setup-feature-crons.mjs`
- Modify: `tests/feature-cron-plan.test.js`
- Modify: `tests/feature-cron-bootstrap.test.js`

**Interfaces:**
- Consumes: `planFeatureCrons(existingJobs, specs, { agents, channelConfig, account })` and the existing `plan.update` executor.
- Produces: `staggerConsolidationSchedule(baseSchedule, agentIndex): object`, `planConsolidationScheduleMigration(job, spec, agentIndex): object|null`.

- [ ] **Step 1: Write failing schedule and migration tests**

Add tests for exact 15-minute staggering, idempotency, and preservation:

```js
assert.deepStrictEqual(staggerConsolidationSchedule({ kind: "cron", expr: "0 4 * * *" }, 0), { kind: "cron", expr: "0 4 * * *" });
assert.deepStrictEqual(staggerConsolidationSchedule({ kind: "cron", expr: "0 4 * * *" }, 1), { kind: "cron", expr: "15 4 * * *" });
assert.deepStrictEqual(staggerConsolidationSchedule({ kind: "cron", expr: "0 4 * * *" }, 2), { kind: "cron", expr: "30 4 * * *" });

const shipped = ownedConsolidationJob({ id: "c-main", agentId: "main", expr: "0 3 * * *" });
assert.deepStrictEqual(planFeatureCrons([shipped], [CONSOLIDATION_SPEC], { agents: THREE_AGENTS }).update[0].schedule, { kind: "cron", expr: "0 4 * * *" });

const custom = ownedConsolidationJob({ id: "c-main", agentId: "main", expr: "7 5 * * *" });
assert.deepStrictEqual(planFeatureCrons([custom], [CONSOLIDATION_SPEC], { agents: THREE_AGENTS }).update, []);
```

- [ ] **Step 2: Run cron tests and confirm RED**

```bash
node --test tests/feature-cron-plan.test.js tests/feature-cron-bootstrap.test.js
```

Expected: FAIL on the old `0 3 * * *` schedule and absent migration.

- [ ] **Step 3: Implement canonical schedule and conservative migration**

Change the consolidation spec to `0 4 * * *` with `timezone: "Europe/Berlin"`. Apply `agentIndex * 15` minutes for `consolidate-daily`. Migration accepts only the exact shipped schedules `0 3 * * *` and the observed previous canonical `0 4 * * *`, requires exact PLUR1BUS name/message/agent ownership and a job ID, and emits the agent-specific target only when different.

```js
const SHIPPED_CONSOLIDATION_SCHEDULES = new Set(["0 3 * * *", "0 4 * * *"]);

export function staggerConsolidationSchedule(baseSchedule, agentIndex) {
  return staggerCronMinutes(baseSchedule, agentIndex, 15);
}

export function planConsolidationScheduleMigration(job, spec, agentIndex) {
  if (!job?.id || spec?.feature !== "consolidate-daily") return null;
  if (!SHIPPED_CONSOLIDATION_SCHEDULES.has(job?.schedule?.expr)) return null;
  const schedule = staggerConsolidationSchedule(spec.schedule, agentIndex);
  return job.schedule.expr === schedule.expr ? null : { id: job.id, name: job.name, schedule };
}
```

- [ ] **Step 4: Verify CLI edit rendering**

Extend the bootstrap test to assert:

```js
assert.deepStrictEqual(cronEdits[0], [
  "cron", "edit", "c-bernhardine", "--cron", "15 4 * * *",
]);
```

Run the setup twice against the updated fixture and assert the second plan has no creates or updates.

- [ ] **Step 5: Run targeted tests and commit**

```bash
node --test tests/feature-cron-plan.test.js tests/feature-cron-bootstrap.test.js tests/setup-feature-crons-symlink.test.js
git add lib/setup/feature-cron-plan.js scripts/setup-feature-crons.mjs tests/feature-cron-plan.test.js tests/feature-cron-bootstrap.test.js
git commit -m "fix: stagger daily consolidation crons"
```

Expected: all targeted tests PASS.

---

### Task 3: Add a Safe Promoted-Memory Reindex Bridge

**Files:**
- Create: `lib/promoted-memory-reindex.js`
- Create: `scripts/embed-promoted-memories.mjs`
- Create: `tests/promoted-memory-reindex.test.js`
- Create: `tests/embed-promoted-memories-cli.test.js`
- Modify: `scripts/lib/deploy-integrity.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `safeAgentId`, `resolveInside`, `validateInput`, `normalizeEmbeddingConfig`, `createEmbeddingProvider`, and exported `MemoryDB`.
- Produces: `parsePromotionMarkers(content): Promotion[]`, `discoverPromotionTargets(config, openclawHome): Target[]`, `stablePromotionId(agentId, marker): string`, `planPromotionReindex(options): Plan`, `applyPromotionReindex(plan, dependencies): Result`, and CLI flags `--agent`, `--openclaw-home`, `--plugin-dir`, `--dry-run`, `--apply`, `--json`.

- [ ] **Step 1: Write failing pure parser/discovery tests**

Use temporary workspaces and assert marker parsing, workspace deduplication, exact agent filtering, invalid agent rejection, and root/sys/legacy MEMORY.md selection:

```js
assert.deepStrictEqual(parsePromotionMarkers([
  "<!-- openclaw-memory-promotion:marker-1 -->",
  "- Durable fact [score=0.91 recalls=5]",
].join("\n")), [{ marker: "marker-1", text: "Durable fact" }]);

assert.throws(
  () => discoverPromotionTargets({ agents: { list: [{ id: "../escape", workspace: "workspace" }] } }, home),
  /Invalid agent ID/,
);
```

- [ ] **Step 2: Write failing orchestration tests with injected dependencies**

Inject a fake embedder and fake MemoryDB factory. Verify dry-run performs no embed/store, provider dimensions flow into DB construction, stable IDs make retries idempotent, partial failures set `ok: false`, and reports contain no plaintext or secrets:

```js
const result = await applyPromotionReindex(plan, {
  apply: true,
  createEmbedder: async () => ({ dimensions: 384, embed: async () => Array(384).fill(0.1) }),
  createMemoryDb: ({ vectorDim }) => fakeDb(vectorDim),
});
assert.strictEqual(seenVectorDim, 384);
assert.deepStrictEqual(result.counts, { planned: 2, inserted: 1, skipped: 0, failed: 1 });
assert.strictEqual(result.ok, false);
assert.doesNotMatch(JSON.stringify(result), /Durable fact|secret-key/);
```

- [ ] **Step 3: Run reindex tests and confirm RED**

```bash
node --test tests/promoted-memory-reindex.test.js tests/embed-promoted-memories-cli.test.js
```

Expected: FAIL because the modules do not yet exist.

- [ ] **Step 4: Implement the pure planner and safe provenance**

Use SHA-256 UUID-compatible IDs derived from `agentId + NUL + marker`; validate marker/text with bounded `validateInput`. Resolve configured workspaces inside `openclawHome` unless an explicitly passed allowed workspace root is used. Keep only marker hashes and stable IDs in reports/state.

```js
export function stablePromotionId(agentId, marker) {
  const digest = createHash("sha256").update(`${safeAgentId(agentId)}\0${marker}`).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}
```

- [ ] **Step 5: Implement provider-backed application through MemoryDB**

The CLI reads plugin config, normalizes `config.embedding`, creates the provider, derives `provider.dimensions()`, and passes that exact dimension to `new MemoryDB(dbPath, vectorDim, logger)`. Before `store`, check the stable ID through `db.getById(id)`; then store the current schema entry:

```js
await db.store({
  id,
  text,
  summary: text.slice(0, 200),
  origin: "dreaming-promotion",
  vector: await embedder.embed(text),
  importance: 0.9,
  category: "curated",
  createdAt: now,
  agentId,
  storedBy: agentId,
  sourceMessageRole: "internal",
  sourceTimestamp: now,
  evidenceQuote: text.slice(0, 200),
  scope: "agent-private",
  workspaceId,
  workspaceKey,
});
```

Always close each `MemoryDB` in `finally`. Dry-run stops before provider construction or DB initialization.

- [ ] **Step 6: Implement CLI contract and deployment inclusion**

`scripts/embed-promoted-memories.mjs` exports `parseArgs()` and `runCli()` for tests, defaults to dry-run, rejects simultaneous `--dry-run`/`--apply`, and exits 2 for argument errors or 1 for partial runtime failure. Add the script and `lib/promoted-memory-reindex.js` to `DEPLOY_FILES`, and add:

```json
"reindex-promotions": "node scripts/embed-promoted-memories.mjs --dry-run"
```

- [ ] **Step 7: Run targeted tests and commit**

```bash
node --test tests/promoted-memory-reindex.test.js tests/embed-promoted-memories-cli.test.js tests/deploy-integrity.test.js
git add lib/promoted-memory-reindex.js scripts/embed-promoted-memories.mjs tests/promoted-memory-reindex.test.js tests/embed-promoted-memories-cli.test.js scripts/lib/deploy-integrity.mjs package.json
git commit -m "feat: add safe promoted-memory reindex bridge"
```

Expected: all targeted tests PASS and a fixture CLI dry-run makes no database files.

---

### Task 4: Harden the Private Update Diagnostics

**Files:**
- Create locally: private diagnostics helper beside the update script
- Create locally: private shell regression test beside the helper
- Modify locally: private `update-openclaw.sh`
- Modify locally: private media/startup patch script

**Interfaces:**
- Produces shell functions `classify_patch_output`, `read_device_scopes`, `detect_asr_status`, `find_bad_delivery_targets`, and `journal_since_gateway_start`.
- The update script consumes newline-delimited/JSON-safe results and increments separate fatal-error and review-warning counters.

- [ ] **Step 1: Back up private scripts and write failing shell fixtures**

Copy the current scripts into a timestamped backup directory using explicit paths. The regression test supplies fixture strings and asserts:

```bash
assert_eq review "$(classify_patch_output '[patch] anchor not found — manual check needed')"
assert_eq ok "$(classify_patch_output '[patch] retired >=2026.4.25')"
assert_eq 'de-DE' "$(extract_asr_language 'language=de-DE')"
assert_eq '12345' "$(bare_delivery_target 'telegram:12345')"
```

It also creates a temporary SQLite database with `device_auth_tokens` and verifies `operator.read` is found without JSON.

- [ ] **Step 2: Run the private fixture test and confirm RED**

From the directory containing the private update script, run:

```bash
bash tests/update-openclaw-diagnostics.test.sh
```

Expected: FAIL because the helper functions do not exist.

- [ ] **Step 3: Implement diagnostics helpers and wire them into the update script**

Implement exact matching for `language=de` versus `language=de-DE`, recognize ASR port 8000, query SQLite device scopes with JSON fallback, derive bare delivery fixes from the job's current target, and use journal cursor/time from the current gateway invocation. Patch classification maps explicit retired/native/already-patched outcomes to `ok`, unresolved anchors/unexpected content/manual review to `review`, and nonzero patch execution to `fatal`.

- [ ] **Step 4: Correct source roots and post-start integrity ordering**

Replace obsolete repository references with a validated canonical repository variable. The startup patch must deploy/verify the full pinned release rather than `index.js` plus `runtime-scheduler.js`; the update script invokes final deploy-integrity after `ExecStartPre` completes. Reject a source root whose package name/version does not match the selected pinned release.

- [ ] **Step 5: Correct health and reindex behavior**

Use current-start journal evidence for plugin health. Replace the missing-script warning with a dry-run call to the newly deployed `scripts/embed-promoted-memories.mjs`; never auto-apply. Report the correct canonical repository path without exposing it in public Git changes.

- [ ] **Step 6: Validate private scripts**

From the directory containing the private update script, run:

```bash
bash tests/update-openclaw-diagnostics.test.sh
bash -n update-openclaw.sh
bash -n ../patches/apply-media-patch.sh
```

Expected: tests PASS and both scripts parse successfully.

---

### Task 5: Recover the Live v7.1.9 Installation and Crons

**Files/State:**
- Read: official repository tag `v7.1.9`
- Mutate after snapshot: installed PLUR1BUS extension, OpenClaw cron state, gateway user service
- Do not mutate: LanceDB schema or memory content except explicitly authorized consolidation/reindex operations

**Interfaces:**
- Consumes the repository verifier, exact official tag, OpenClaw cron CLI, and systemd user service.
- Produces a coherent v7.1.9 deployed tree and non-colliding consolidation schedules.

- [ ] **Step 1: Verify exact official tag and clean source**

```bash
git rev-parse v7.1.9
git status --short
git ls-remote --tags origin refs/tags/v7.1.9
plur1bus_release_dir="$(mktemp -d /tmp/plur1bus-v7.1.9.XXXXXX)"
git worktree add --detach "$plur1bus_release_dir" v7.1.9
```

Expected: local and remote tag hashes agree; production source contains no uncommitted files.

- [ ] **Step 2: Create snapshot and deployment backups**

```bash
./scripts/backup-snapshot.sh
```

Record the returned snapshot path. Back up the installed extension and private scripts to an explicit timestamped directory before overwriting.

- [ ] **Step 3: Deploy the complete official release and verify before restart**

Run the repository's protected deploy/repair workflow against the exact tag source:

```bash
node "$plur1bus_release_dir/scripts/verify-plugin-deploy.mjs" --repair --repo-dir "$plur1bus_release_dir"
node "$plur1bus_release_dir/scripts/verify-plugin-deploy.mjs" --repo-dir "$plur1bus_release_dir"
```

Expected: every manifest hash is `OK`, deployed `index.js` imports, and the report ends `PASS`.

- [ ] **Step 4: Restart and verify gateway/plugin readiness**

```bash
systemctl --user restart openclaw-gateway
openclaw gateway probe
openclaw plugins inspect memory-lancedb-namespaced
gateway_start="$(systemctl --user show openclaw-gateway -p ActiveEnterTimestamp --value)"
journalctl --user -u openclaw-gateway --since "$gateway_start" --no-pager
```

Expected: gateway probe succeeds, PLUR1BUS is enabled/loaded as 7.1.9, no import error references `validateTimeZone`, and expected sockets are listening.

- [ ] **Step 5: Correct delivery target and consolidation schedules**

Use `openclaw cron edit <id> --to <bare-current-target>` for the affected job. Edit the three owned consolidation jobs to `0 4 * * *`, `15 4 * * *`, and `30 4 * * *` with `Europe/Berlin`. Re-list JSON state and assert no `telegram:` target remains on active Telegram jobs.

- [ ] **Step 6: Run consolidation sequentially**

Run main, wait for terminal state, then Bernhardine, then Heisenberg. For each job assert plugin execution began, terminal state is successful, and no `stalled before execution start` error occurs. Stop and restore from snapshot if a memory integrity error appears.

- [ ] **Step 7: Run reindex dry-run only**

From the deployed extension directory, run:

```bash
node scripts/embed-promoted-memories.mjs --dry-run --json
```

Expected: valid redacted plan, zero writes, and per-agent counts. Apply is deferred unless the dry-run shows candidates and the snapshot path has been confirmed.

---

### Task 6: Full Verification and GitHub Draft Pull Request

**Files:**
- Modify: `docs/superpowers/plans/2026-08-01-openclaw-update-recovery.md` only to check completed steps if desired
- No private files staged

**Interfaces:**
- Produces a verified branch pushed to GitHub and a draft PR.

- [ ] **Step 1: Run repository verification**

```bash
node --test tests/deploy-integrity.test.js tests/installer-stub-guard.test.js tests/repair-scripts.test.js
node --test tests/feature-cron-plan.test.js tests/feature-cron-bootstrap.test.js tests/setup-feature-crons-symlink.test.js
node --test tests/promoted-memory-reindex.test.js tests/embed-promoted-memories-cli.test.js
node --test --test-concurrency=1 tests/*.test.js
npm audit
git diff --check
```

Expected: all tests pass, audit reports zero vulnerabilities, and diff check is clean.

- [ ] **Step 2: Review public change scope**

```bash
git status --short
git diff --stat v7.1.9...HEAD
git diff v7.1.9...HEAD
```

Confirm no absolute server path, real chat ID, private model policy, credential, or private update-script content is present.

- [ ] **Step 3: Verify remote tag immutability and authentication**

```bash
gh auth status
git ls-remote --tags origin refs/tags/v7.1.9
```

Expected: authenticated GitHub session and unchanged official tag.

- [ ] **Step 4: Push and create draft PR**

```bash
git push -u origin agent/openclaw-update-hardening
gh pr create --draft --fill --base main --head agent/openclaw-update-hardening --title "Harden OpenClaw update recovery and memory maintenance"
```

The PR body states root cause, exact backward-compatible schedule migration, reindex safety contract, test evidence, and live rollout evidence without private identifiers.

- [ ] **Step 5: Inspect the published draft**

```bash
gh pr view --json url,isDraft,title,baseRefName,headRefName
```

Expected: draft PR targets `main` from `agent/openclaw-update-hardening`.
