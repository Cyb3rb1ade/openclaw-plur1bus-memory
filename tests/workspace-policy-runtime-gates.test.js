import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const indexSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");
// PR-03c/PR-03d/PR-03e/PR-03f (engine-extraction M1a) moved the auto-recall-off
// before_prompt_build branch, the recall assembly, the agent_end capture
// pipeline and the /plur1bus command runner — with their
// automaticWorkspacePolicyDecision(...), workspacePolicyGuard.automatic(...)
// and workspace-command call sites — out of index.js and into these engine
// modules; the totals below span all of them so this guard still verifies
// every automatic decision point, not just the ones still textually present
// in index.js.
const engineSources = [
  "../engine/recall/minimal-maintenance.js",
  "../engine/recall/assemble-prompt-context.js",
  "../engine/capture/capture-turn.js",
  "../engine/commands/plur1bus-command.js",
].map((relative) => readFileSync(new URL(relative, import.meta.url), "utf8"));
// PR-03g moved the chat-command registration and the six user-facing command
// bodies into the OpenClaw adapter; it carries the `workspace` command call
// sites and the native policy-runtime registration.
const commandsSource = readFileSync(new URL("../adapter/openclaw/register-commands.js", import.meta.url), "utf8");
const allRuntimeSources = [indexSource, ...engineSources, commandsSource];

describe("workspace policy runtime gates", () => {
  it("constructs one policy store and guard below the PLUR1BUS state root", () => {
    assert.match(indexSource, /createWorkspacePolicyStore\(\{\s*stateRoot: baseDbPath,/);
    assert.match(indexSource, /const memoryMaintenanceGate = createMemoryMaintenanceGate\(\{\s*externalStatus:/);
    assert.match(indexSource, /createWorkspacePolicyGuard\(\{/);
    assert.match(indexSource, /maintenanceGate: memoryMaintenanceGate,/);
  });

  it("guards the complete five-tool surface before execute", () => {
    assert.match(indexSource, /guardWorkspaceTools\(workspaceTools, workspacePolicyGuard\.decision\(memoryCtx\)\)/);
  });

  it("checks automatic capture, recall, outcome, and maintenance paths", () => {
    const guardCalls = allRuntimeSources.reduce(
      (sum, source) => sum + (source.match(/workspacePolicyGuard\.automatic\(/g) || []).length,
      0
    );
    assert.ok(guardCalls >= 2);
    const indexDecisionCalls = (indexSource.match(/automaticWorkspacePolicyDecision\(/g) || []).length;
    const engineDecisionCalls = engineSources.reduce(
      (sum, source) => sum + (source.match(/automaticWorkspacePolicyDecision\(/g) || []).length,
      0
    );
    assert.ok(indexDecisionCalls + engineDecisionCalls >= 4);
    assert.ok(allRuntimeSources.some(
      (source) => /if \(!workspacePolicyGuard\.automatic\(memoryCtx\)\.allowed\) return undefined;/.test(source)
    ));
  });

  it("keeps policy status and mutation available while other commands fail closed", () => {
    // PR-03f moved the /plur1bus dispatcher — and with it the whole
    // `workspace` action branch — out of index.js; both anchors now live in
    // engine/commands/plur1bus-command.js, so the guard reduces over every
    // runtime source instead of index.js alone. `text: "NO_REPLY"` still has a
    // call site in index.js (the operator command path) and stays pinned there.
    assert.ok(allRuntimeSources.some((source) => /actionKey === "workspace"/.test(source)));
    assert.ok(allRuntimeSources.some(
      (source) => /workspacePolicyDecision\.reason \|\| "workspace_disabled"/.test(source)
    ));
    assert.match(indexSource, /text: "NO_REPLY"/);
  });

  it("registers the native policy runtime with a session-derived context", () => {
    // PR-03g moved the chat-command registration — including the
    // registerWorkspacePolicyRuntime({…}) call — out of index.js into
    // adapter/openclaw/register-commands.js; all three anchors left index.js
    // (1 -> 0, 2 -> 0, 1 -> 0), so the guard follows them there.
    assert.match(commandsSource, /registerWorkspacePolicyRuntime\(\{/);
    assert.match(commandsSource, /getSessionEntry\(\{\s*agentId,\s*sessionKey,/);
    assert.match(commandsSource, /spawnedWorkspaceDir/);
  });
});
