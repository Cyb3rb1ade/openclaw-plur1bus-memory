import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const indexSource = readFileSync(new URL("../index.js", import.meta.url), "utf8");
// PR-03c (engine-extraction M1a) moved the auto-recall-off before_prompt_build
// branch's automaticWorkspacePolicyDecision(...) call site out of index.js and
// into this engine module; the total call-site count below spans both files
// so this guard still verifies every automatic decision point, not just the
// ones still textually present in index.js.
const minimalMaintenanceSource = readFileSync(
  new URL("../engine/recall/minimal-maintenance.js", import.meta.url),
  "utf8"
);

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
    const engineDecisionCalls = (minimalMaintenanceSource.match(/automaticWorkspacePolicyDecision\(/g) || []).length;
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
