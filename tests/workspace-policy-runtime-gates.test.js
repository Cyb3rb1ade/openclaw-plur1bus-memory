import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readRuntimeSources } from "./helpers/runtime-sources.js";

// PR-03c to PR-03i (engine-extraction M1a) moved the auto-recall-off
// before_prompt_build branch, the recall assembly, the agent_end capture
// pipeline, the /plur1bus command runner and the five model-facing tools —
// with their automaticWorkspacePolicyDecision(...),
// workspacePolicyGuard.automatic(...) and workspace-command call sites — out
// of index.js and into engine/**; the totals below span index.js and every
// engine module so this guard still verifies every automatic decision point,
// not just the ones still textually present in index.js. The adapter
// contributes no match to any of them, so it is not in the reduction; the
// registration anchors it does own are asserted against it directly.
//
// Task 13b split register() itself: its construction half is
// engine/create-engine.js (already one of the engine sources) and its
// registration half — including the two reply-outcome handlers that call
// automaticWorkspacePolicyDecision(...) — is adapter/openclaw/plugin.js, which
// therefore joins the reduction in index.js's place.
const { engine, adapter } = readRuntimeSources();
const engineSources = Object.values(engine);
const commandsSource = adapter.commands;
const memoryToolsSource = engine.memoryTools;
const pluginSource = adapter.plugin;
const allRuntimeSources = [pluginSource, ...engineSources];
describe("workspace policy runtime gates", () => {
  it("constructs one policy store and guard below the PLUR1BUS state root", () => {
    assert.match(engine.createEngine, /createWorkspacePolicyStore\(\{\s*stateRoot: baseDbPath,/);
    assert.match(engine.createEngine, /const memoryMaintenanceGate = createMemoryMaintenanceGate\(\{\s*externalStatus:/);
    assert.match(engine.createEngine, /createWorkspacePolicyGuard\(\{/);
    assert.match(engine.createEngine, /maintenanceGate: memoryMaintenanceGate,/);
  });

  it("guards the complete five-tool surface before execute", () => {
    assert.match(memoryToolsSource, /guardWorkspaceTools\(workspaceTools, workspacePolicyGuard\.decision\(memoryCtx\)\)/);
  });

  it("checks automatic capture, recall, outcome, and maintenance paths", () => {
    const guardCalls = allRuntimeSources.reduce(
      (sum, source) => sum + (source.match(/workspacePolicyGuard\.automatic\(/g) || []).length,
      0
    );
    assert.ok(guardCalls >= 2);
    const indexDecisionCalls = (pluginSource.match(/automaticWorkspacePolicyDecision\(/g) || []).length;
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
    // runtime source instead of index.js alone. The `text: "NO_REPLY"` site
    // that stayed in index.js (guardUnsafeDirectCronTurn) moved to
    // engine/commands/command-helpers.js in step 9 part 1 and is pinned there.
    assert.ok(allRuntimeSources.some((source) => /actionKey === "workspace"/.test(source)));
    assert.ok(allRuntimeSources.some(
      (source) => /workspacePolicyDecision\.reason \|\| "workspace_disabled"/.test(source)
    ));
    assert.match(engine.commandHelpers, /text: "NO_REPLY"/);
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
