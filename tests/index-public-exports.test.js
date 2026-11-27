/**
 * tests/index-public-exports.test.js — PR-03a.
 *
 * 46 test files import internals from ../index.js. Moving a symbol into
 * engine/ or adapter/ without re-exporting it here breaks them, sometimes
 * quietly. This list is frozen for M1a; PR-14 is the PR that may change it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import * as index from "../index.js";

const PUBLIC_NAMES = [
  "AgentDbPool",
  "MemoryDB",
  "appendConflictLog",
  "applyEpistemicStatusToLanceDb",
  "applyEpistemicStatusToNeo",
  "applyValidTimeCloseToLanceDb",
  "buildConflictSummaryFromLog",
  "buildMaintenanceNudges",
  "completePendingConfirmation",
  "createRuntimeRerankerProvider",
  "guardUnsafeDirectCronTurn",
  "inspectCronNativeCapabilities",
  "parseConfirmationCommand",
  "parseFeatureCronBootstrapLastPlanCreateCount",
  "reconcileUnsafeDirectCronsWithService",
  "rememberPendingConfirmation",
  "resolveConfirmationIdentity",
  "runDeferredFeatureCronBootstrap",
  "selectSemanticDiscoveryWorkspaces",
];

describe("index.js public surface", () => {
  for (const name of PUBLIC_NAMES) {
    it(`exports ${name}`, () => {
      assert.equal(typeof index[name], "function", `${name} must stay exported from index.js`);
    });
  }

  it("exports exactly these names and nothing new", () => {
    const actual = Object.keys(index).filter((key) => key !== "default").sort();
    assert.deepEqual(actual, [...PUBLIC_NAMES].sort());
  });

  it("still default-exports the plugin", () => {
    assert.equal(index.default.id, "memory-lancedb-namespaced");
    assert.equal(index.default.kind, "memory");
    assert.equal(typeof index.default.register, "function");
  });
});
