/**
 * memory-lancedb-namespaced
 *
 * Version: siehe openclaw.plugin.json (Single Source of Truth, gepflegt
 * via scripts/bump-version.sh). Dieser Header beschreibt das Verhalten,
 * keine bestimmte Version.
 *
 * Per-Agent-LanceDB unter {baseDbPath}/{agentId}/ via ctx.agentId-Routing.
 *
 * Auto-Capture:
 *   - Plugin-Hook, wenn OpenClaw conversation access erlaubt.
 *     OpenClaw 2026.5.3-1 whitelisted hooks.allowConversationAccess im
 *     Runtime-Schema; aeltere 4.x Builds brauchen weiterhin den lokalen
 *     Compat-Patch oder den Cron-Fallback.
 *   - Cron-Fallback via scripts/auto-capture-lancedb.mjs bei Hook-Blockade.
 *     Laeuft alle 5 Min, parst Session-JSONLs, schreibt mit voller Provenance.
 *     v1.8.2 hat drei Bugs gefixt (trajectory-Filter, dynamic agent discovery,
 *     byte-offset state; siehe CHANGELOG).
 *
 * Recall-Pipeline (v1.8.0+):
 *   Query → Embedding → LanceDB Top-N → Importance-Boost → optional Rerank
 *   → Inter-Result-Dedup → kombiniert mit Canonical-First (KNOWLEDGE.md)
 *   → Top-5 als <relevant-memories> injiziert.
 *
 * Provenance-Felder im Schema (v1.8.0+):
 *   sourceTurnId, sourceMessageRole, sourceTimestamp, sourceUrl,
 *   evidenceQuote, scope.
 */
//
// The plugin is adapter/openclaw/plugin.js (registration) over
// engine/create-engine.js (construction). This file stays the entry point:
// openclaw.plugin.json `extensions` and package.json `main` point here, and
// the test suite imports the default export and the named exports below.

import { registerPlur1bus } from "./adapter/openclaw/plugin.js";

const plugin = {
  id: "memory-lancedb-namespaced",
  name: "Memory (LanceDB, per-Agent)",
  description: "Per-agent isolated LanceDB memory",
  kind: "memory",

  register(api, registrationDependencies = {}) {
    return registerPlur1bus(api, registrationDependencies);
  },
};

export { MemoryDB, applyEpistemicStatusToLanceDb, applyValidTimeCloseToLanceDb, applyEpistemicStatusToNeo } from "./engine/store/memory-db.js";
export { buildMaintenanceNudges, appendConflictLog, buildConflictSummaryFromLog, guardUnsafeDirectCronTurn, parseConfirmationCommand, resolveConfirmationIdentity, rememberPendingConfirmation, completePendingConfirmation } from "./engine/commands/command-helpers.js";
export { createRuntimeRerankerProvider } from "./engine/providers/runtime-reranker.js";
export { inspectCronNativeCapabilities, reconcileUnsafeDirectCronsWithService, runDeferredFeatureCronBootstrap } from "./adapter/openclaw/host-probes.js";
export { parseFeatureCronBootstrapLastPlanCreateCount } from "./lib/feature-crons-hint.js";
export { selectSemanticDiscoveryWorkspaces } from "./engine/runtime/semantic-discovery.js";
export { AgentDbPool } from "./engine/store/agent-db-pool.js";
export default plugin;
