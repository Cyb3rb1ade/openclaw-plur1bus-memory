# B1 Command Reachability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore the registered `/forget` and `/correct` initiation paths so they reach candidate lookup and user-bound confirmation without changing command authorization, archive-first mutation, or `/memory` behavior.

**Architecture:** Keep the existing three command handlers and their dependency graph intact. Mirror the already-working `/memory` pattern by constructing an agent-scoped query summarizer inside each destructive command after `agentId` resolution, then prove the entire registered-command path against real temporary LanceDB state while mocking only the optional local model computation.

**Tech Stack:** Node.js ESM, `node:test`, LanceDB through the repository's real `MemoryDB`/DB adapter, OpenClaw plugin command/tool factories.

## Global Constraints

- Work only in `/root/openclaw-plur1bus-memory/.worktrees/fix-high-mid-audit-findings` on branch `fix/high-mid-audit-findings`; `main` remains untouched.
- Implement only Batch B1 / BUG-01 and stop after its reviewed commit.
- Preserve `/memory`, destructive-command authorization, user/chat-bound confirmations, archive-first `/forget` and `/correct`, aliases, and every unrelated feature.
- Do not add a separate low-finding fix, refactor another subsystem, or add test-only production APIs.
- Follow strict TDD: observe the focused regression failing for `summarizer is not defined` before editing `index.js`.
- Every changed or new export requires focused JSDoc; this batch changes no exports.

---

### Task 1: Restore registered forget/correct initiation

**Files:**
- Create: `tests/command-reachability.test.js`
- Modify: `tests/llm-result-cache-integration.test.js`
- Modify: `index.js:4002-4137`
- Create: `docs/audits/2026-07-19-bug-01-command-reachability-fix.md`
- Create or update outside Git: `/tmp/codex-security-scans/openclaw-plur1bus-memory/6dff096efe936f7ec3d0e11a8ba83bf08671ad4e_20260718T170344Z/artifacts/fix_report.md`

**Interfaces:**
- Consumes: `plugin.register(api)`, the registered `memory`, `forget`, and `correct` handlers, the registered `memory_store` factory, `LocalTransformersEmbeddingProvider.prototype.embedPassage`, and the existing confirmation/archive implementation.
- Produces: unchanged public command interfaces; both destructive initiation handlers receive an agent-scoped `Function|null` summarizer created by `makeQuerySummarizer(mergingLlmCfg, api.logger, agentId)`.

- [ ] **Step 1: Add the realistic registered-command regression and positive control**

Create `tests/command-reachability.test.js` with one shared real-plugin fixture and three tests. Set `OPENCLAW_HOME` before dynamically importing `index.js`, patch only the optional local embedding model boundary, seed each agent through the real `memory_store` tool, and invoke commands from registered APIs. The `/forget` completion proves archive-first deletion and then asserts the semantic not-found result without rejecting the expected query echo. For `/correct`, first let a real API/adapter generation migrate the fresh table, shut that generation down, and register a fresh API/pool generation on the same path. Use only that fresh registered handler for initiation, wrong-user rejection, owner-confirm, archive proof, and corrected recall. This models the normal already-migrated runtime/restart state without a test-only production hook or a product change for the separate first-generation schema-cache issue:

```js
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const VECTOR_DIM = 384;
const OWNER = "owner-user";
const OTHER_ALLOWED_USER = "other-allowed-user";
const CHAT_ID = "owner-chat";
const WORKSPACE_KEY = "workspace-a";

function makeApi(baseDbPath) {
  const commands = [];
  const shutdownHandlers = [];
  const noop = () => {};
  return {
    pluginConfig: {
      baseDbPath,
      embedding: { provider: "local-transformers", local: { dimensions: VECTOR_DIM } },
      merging: { enabled: false },
      emotion: { t3: { enabled: false } },
      obsidianBridge: { enabled: false },
      autoCapture: false,
      autoRecall: false,
      neo: { enabled: false },
      gc: { enabled: false },
      security: {
        allowedUserIds: [OWNER, OTHER_ALLOWED_USER],
        allowedChatIds: [CHAT_ID],
      },
    },
    logger: { info: noop, warn: noop, error: noop, debug: noop },
    resolvePath: (value) => value,
    registerCommand(command) { commands.push(command); },
    registerTool(factory) { this._toolFactory = factory; },
    registerService: noop,
    on(event, handler) {
      if (event === "gateway_stop") shutdownHandlers.push(handler);
    },
    _commands: commands,
    _shutdownHandlers: shutdownHandlers,
  };
}

function commandContext(workspaceDir, agentId, args, overrides = {}) {
  return {
    args,
    agentId,
    workspaceDir,
    workspaceKey: WORKSPACE_KEY,
    userId: OWNER,
    chatId: CHAT_ID,
    chatType: "private",
    ...overrides,
  };
}

function confirmationToken(text, command) {
  const match = String(text).match(new RegExp(`/${command} confirm ([0-9a-f-]+)`, "i"));
  assert.ok(match, `expected /${command} confirmation token, got: ${text}`);
  return match[1];
}

describe("registered memory command reachability", () => {
  const registeredApis = [];
  const shutdownApis = new WeakSet();
  let api;
  let baseDbPath;
  let workspaceDir;
  let openclawHome;
  let previousOpenclawHome;
  let plugin;
  let localProvider;
  let originalEmbedPassage;

  before(async () => {
    baseDbPath = mkdtempSync(join(tmpdir(), "plur1bus-b1-db-"));
    workspaceDir = mkdtempSync(join(tmpdir(), "plur1bus-b1-workspace-"));
    openclawHome = mkdtempSync(join(tmpdir(), "plur1bus-b1-home-"));
    previousOpenclawHome = process.env.OPENCLAW_HOME;
    process.env.OPENCLAW_HOME = openclawHome;

    const [pluginModule, providerModule] = await Promise.all([
      import("../index.js"),
      import("../lib/providers/embedding-local-transformers.js"),
    ]);
    plugin = pluginModule.default;
    localProvider = providerModule.LocalTransformersEmbeddingProvider;
    originalEmbedPassage = localProvider.prototype.embedPassage;
    localProvider.prototype.embedPassage = async () => Array(VECTOR_DIM).fill(0.125);

    api = registerApi();
  });

  after(async () => {
    for (const registeredApi of registeredApis) await shutdownApi(registeredApi);
    if (localProvider && originalEmbedPassage) {
      localProvider.prototype.embedPassage = originalEmbedPassage;
    }
    if (previousOpenclawHome === undefined) delete process.env.OPENCLAW_HOME;
    else process.env.OPENCLAW_HOME = previousOpenclawHome;
    for (const dir of [baseDbPath, workspaceDir, openclawHome]) {
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  });

  function registerApi() {
    const registeredApi = makeApi(baseDbPath);
    plugin.register(registeredApi);
    registeredApis.push(registeredApi);
    return registeredApi;
  }

  async function shutdownApi(registeredApi) {
    if (!registeredApi || shutdownApis.has(registeredApi)) return;
    for (const shutdown of registeredApi._shutdownHandlers || []) await shutdown();
    shutdownApis.add(registeredApi);
  }

  async function store(agentId, text, registeredApi = api) {
    const tools = registeredApi._toolFactory({
      agentId,
      workspaceDir,
      workspaceKey: WORKSPACE_KEY,
      userId: OWNER,
    });
    const storeTool = tools.find((tool) => tool.name === "memory_store");
    const result = await storeTool.execute(`seed-${agentId}`, { text, category: "fact" });
    assert.equal(result.details?.action, "stored", JSON.stringify(result));
    return result.details.id;
  }

  async function run(name, ctx, registeredApi = api) {
    const command = registeredApi._commands.find((entry) => entry.name === name);
    assert.ok(command, `${name} command must be registered`);
    return command.handler(ctx);
  }

  it("keeps registered /memory recall working", async () => {
    const agentId = "b1-memory";
    await store(agentId, "B1 positive memory control");

    const result = await run("memory", commandContext(workspaceDir, agentId, "B1 positive memory control"));

    assert.match(result.text, /B1 positive memory control/);
    assert.doesNotMatch(result.text, /failed|summarizer is not defined/i);
  });

  it("takes registered /forget through candidate lookup and a user-bound archive-first confirmation", async () => {
    const agentId = "b1-forget";
    const memoryId = await store(agentId, "B1 forget reachability target");
    const baseCtx = commandContext(workspaceDir, agentId, "B1 forget reachability target");

    const denied = await run("forget", { ...baseCtx, userId: "not-allowed" });
    assert.match(denied.text, /allowed list/i);

    const initiated = await run("forget", baseCtx);
    assert.doesNotMatch(initiated.text, /summarizer is not defined|failed/i);
    const token = confirmationToken(initiated.text, "forget");

    const wrongUser = await run("forget", { ...baseCtx, args: `confirm ${token}`, userId: OTHER_ALLOWED_USER });
    assert.match(wrongUser.text, /security\.wrong_user/);

    const completed = await run("forget", { ...baseCtx, args: `confirm ${token}` });
    assert.match(completed.text, new RegExp(memoryId));
    assert.match(completed.text, /deleted|archiviert/i);

    const archiveDir = join(openclawHome, ".openclaw", "memory", "_archive", agentId);
    assert.ok(readdirSync(archiveDir).some((name) => name.endsWith(`-${memoryId}.json`)));
    const recalled = await run("memory", commandContext(workspaceDir, agentId, "B1 forget reachability target"));
    assert.match(recalled.text, /nothing found|no (?:memory|memories|matches)|keine (?:erinnerung|treffer)/i);
    assert.doesNotMatch(recalled.text, new RegExp(memoryId));
  });

  it("takes registered /correct through candidate lookup and a user-bound archive-first confirmation", async () => {
    const agentId = "b1-correct";
    const migrationApi = registerApi();
    const memoryId = await store(agentId, "B1 old correction target", migrationApi);
    const migrationRecall = await run(
      "memory",
      commandContext(workspaceDir, agentId, "B1 old correction target"),
      migrationApi,
    );
    assert.match(migrationRecall.text, /B1 old correction target/);
    await shutdownApi(migrationApi);

    const commandApi = registerApi();
    const baseCtx = commandContext(workspaceDir, agentId, "B1 old correction target -> B1 corrected value");

    const initiated = await run("correct", baseCtx, commandApi);
    assert.doesNotMatch(initiated.text, /summarizer is not defined|failed/i);
    const token = confirmationToken(initiated.text, "correct");

    const wrongUser = await run(
      "correct",
      { ...baseCtx, args: `confirm ${token}`, userId: OTHER_ALLOWED_USER },
      commandApi,
    );
    assert.match(wrongUser.text, /security\.wrong_user/);

    const completed = await run("correct", { ...baseCtx, args: `confirm ${token}` }, commandApi);
    assert.match(completed.text, new RegExp(memoryId));
    assert.match(completed.text, /updated|aktualisiert/i);

    const archiveDir = join(openclawHome, ".openclaw", "memory", "_archive", agentId);
    assert.ok(readdirSync(archiveDir).some((name) => name.endsWith(`-${memoryId}.json`)));
    const recalled = await run(
      "memory",
      commandContext(workspaceDir, agentId, "B1 corrected value"),
      commandApi,
    );
    assert.match(recalled.text, /B1 corrected value/);
  });
});
```

- [ ] **Step 2: Run the focused regression and verify RED**

Run:

```bash
node --test tests/command-reachability.test.js
```

Expected: `/memory` passes; the `/forget` and `/correct` cases fail while extracting their confirmation tokens because the returned handler errors contain `summarizer is not defined`. A syntax, import, fixture, or storage failure is not acceptable RED and must be corrected before production code changes.

- [ ] **Step 3: Implement the smallest complete production fix**

In `runForgetCommand`, immediately after resolving `agentId`, add:

```js
const summarizer = makeQuerySummarizer(mergingLlmCfg, api.logger, agentId);
```

In `runCorrectCommand`, immediately after resolving `agentId`, add the same agent-scoped declaration:

```js
const summarizer = makeQuerySummarizer(mergingLlmCfg, api.logger, agentId);
```

Do not move, share, or change confirmation, authorization, candidate, archive, correction, registration, or alias logic.

- [ ] **Step 4: Verify GREEN on the same focused test**

Run:

```bash
node --test tests/command-reachability.test.js
```

Expected: 3 tests pass, 0 fail, with no warnings or stray output.

- [ ] **Step 5: Run the owning command/input suite**

Run:

```bash
node --test tests/command-reachability.test.js tests/forget-correct-confirm.test.js tests/telegram-command-smoke.test.js tests/plur1bus-start-flow.test.js tests/smoke-semantic-input.test.js
```

Expected: exit 0. This jointly proves registered handler reachability, `/memory`, input normalization, authorization, bound confirmation, real archive-first destructive completions, corrected recall, and the existing helper controls.

- [ ] **Step 6: Re-run the strongest BUG-01 trigger and perform the bypass review**

Run:

```bash
node --test --test-name-pattern='registered /forget|registered /correct' tests/command-reachability.test.js
```

Expected: both formerly broken registered command initiation paths pass and no response contains `summarizer is not defined`.

Then inspect all direct callers and equivalent sinks:

```bash
rg -n 'runForgetCommand|runCorrectCommand|makeQuerySummarizer|name: "(forget|correct|plur1bus_forget|plur1bus_correct)"' index.js
```

Confirm that top-level commands and `/plur1bus*` aliases converge on the same fixed handlers, completion branches do not need a summarizer, and the alternate oversized-input class is still rejected before normalization:

```bash
node --test tests/p1-robustness.test.js tests/telegram-command-smoke.test.js
```

The deterministic LLM-cache callsite guard must also recognize the two new exact agent-scoped `makeQuerySummarizer(mergingLlmCfg, api.logger, agentId)` callsites. Update its expected source-wide count from 3 to 5 and run:

```bash
node --test tests/llm-result-cache-integration.test.js
```

- [ ] **Step 7: Run syntax and authoritative repository gates**

Run:

```bash
npm run lint
```

Then run the authoritative serial suite:

```bash
node --test --test-concurrency=1 tests/*.test.js test/*.test.js
```

Expected: exit 0. If the known nested-spawn `EPERM` artifact appears, run `node --test tests/setup-feature-crons-symlink.test.js` directly and record both results; do not classify an unrelated failure as fixed.

- [ ] **Step 8: Write the BUG-01 finding receipt and scan fix report**

Create `docs/audits/2026-07-19-bug-01-command-reachability-fix.md` and the scan bundle's `artifacts/fix_report.md`. Record: outcome, vulnerable source-to-sink path, root cause, invariant, preserved behavior, exact changed files, RED/GREEN evidence, owning suite, original-trigger result, direct-caller/alternate-input bypass review, lint/serial-suite results, remaining uncertainty, and confirmation that `main` stayed at `6dff096efe936f7ec3d0e11a8ba83bf08671ad4e`.

- [ ] **Step 9: Review, verify scope, and commit only B1**

Generate the review package from the pre-B1 base SHA, obtain independent spec/code-quality review, fix every Critical/Important issue through the same focused tests, and re-review. Then run:

```bash
git diff --check
git status --short
git diff --stat 1735d8e..HEAD
```

Stage only the B1 plan, production fix, regression/guard tests, and repository finding receipt, then commit:

```bash
git add docs/superpowers/plans/2026-07-19-b1-command-reachability.md index.js tests/command-reachability.test.js tests/llm-result-cache-integration.test.js docs/audits/2026-07-19-bug-01-command-reachability-fix.md
git commit -m "fix(commands): restore forget and correct initiation"
```

Finally confirm the fix worktree is clean and `/root/openclaw-plur1bus-memory` on `main` is unchanged. Stop; do not begin B2.
