import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const indexSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");
// PR-03c/PR-03d (engine-extraction M1a) moved the auto-recall-off
// before_prompt_build branch and the recall assembly's
// automaticWorkspacePolicyDecision(...) call sites out of index.js and into
// these engine modules; the total call-site count below spans all of them so
// this guard still verifies every automatic decision point, not just the ones
// still textually present in index.js.
const engineSources = [
  "../engine/recall/minimal-maintenance.js",
  "../engine/recall/assemble-prompt-context.js",
].map((relative) => readFileSync(new URL(relative, import.meta.url), "utf8"));

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
    assert.ok((indexSource.match(/workspacePolicyGuard\.automatic\(/g) || []).length >= 2);
    const indexDecisionCalls = (indexSource.match(/automaticWorkspacePolicyDecision\(/g) || []).length;
    const engineDecisionCalls = engineSources.reduce(
      (sum, source) => sum + (source.match(/automaticWorkspacePolicyDecision\(/g) || []).length,
      0
    );
    assert.ok(indexDecisionCalls + engineDecisionCalls >= 4);
    assert.match(indexSource, /if \(!workspacePolicyGuard\.automatic\(memoryCtx\)\.allowed\) return undefined;/);
  });

  it("keeps policy status and mutation available while other commands fail closed", () => {
    assert.match(indexSource, /actionKey === "workspace"/);
    assert.match(indexSource, /workspacePolicyDecision\.reason \|\| "workspace_disabled"/);
    assert.match(indexSource, /text: "NO_REPLY"/);
  });

  it("registers the native policy runtime with a session-derived context", () => {
    assert.match(indexSource, /registerWorkspacePolicyRuntime\(\{/);
    assert.match(indexSource, /getSessionEntry\(\{\s*agentId,\s*sessionKey,/);
    assert.match(indexSource, /spawnedWorkspaceDir/);
  });
});
