/**
 * tests/engine-runtime-modules.test.js — step 9, part 1.
 *
 * The public names index.js has always exported are the engine modules'
 * bindings, not copies, and no engine module reaches back into index.js.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as index from "../index.js";
import { MemoryDB, applyEpistemicStatusToLanceDb, applyValidTimeCloseToLanceDb, applyEpistemicStatusToNeo } from "../engine/store/memory-db.js";
import { AgentDbPool } from "../engine/store/agent-db-pool.js";
import { buildMaintenanceNudges, appendConflictLog, buildConflictSummaryFromLog, guardUnsafeDirectCronTurn, parseConfirmationCommand, resolveConfirmationIdentity, rememberPendingConfirmation, completePendingConfirmation } from "../engine/commands/command-helpers.js";
import { createRuntimeRerankerProvider } from "../engine/providers/runtime-reranker.js";
import { selectSemanticDiscoveryWorkspaces } from "../engine/runtime/semantic-discovery.js";
import { dbg, setPluginLogger } from "../engine/runtime/debug-log.js";

describe("index.js re-exports the engine's bindings", () => {
  it("identity-equal for every moved public name", () => {
    const moved = { MemoryDB, AgentDbPool, applyEpistemicStatusToLanceDb, applyValidTimeCloseToLanceDb, applyEpistemicStatusToNeo, buildMaintenanceNudges, appendConflictLog, buildConflictSummaryFromLog, guardUnsafeDirectCronTurn, parseConfirmationCommand, resolveConfirmationIdentity, rememberPendingConfirmation, completePendingConfirmation, createRuntimeRerankerProvider, selectSemanticDiscoveryWorkspaces };
    for (const [name, binding] of Object.entries(moved)) assert.equal(index[name], binding, name);
  });

  it("dbg logs through the logger setPluginLogger installed", () => {
    const seen = [];
    setPluginLogger({ debug: (m) => seen.push(m) });
    dbg(new Error("probe"), "scope");
    assert.deepEqual(seen, ["[plur1bus] scope: probe"]);
    setPluginLogger(null);
  });
});
