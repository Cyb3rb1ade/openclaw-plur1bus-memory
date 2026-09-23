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

import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, statfsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

// Shared modules (v1.9.0) — zentrale Logik für Plugin und Cron-Scripts
import { distanceToScore } from "./lib/score.js";
import { generateSummary as libGenerateSummary } from "./lib/text-utils.js";
import { MEMORY_ORIGINS, MEMORY_SCOPES, categorizeMemoryWithReason } from "./lib/categorize.js";
import { computeMemoryImportance, shouldPromoteMemory } from "./lib/memory-fact-quality.js";
import { normalizeImportanceStatus } from "./lib/importance-status.js";
import {
  hasMeaningfulDifference,
  isSafeDuplicate,
  validateMergedTextPreservesFacts,
} from "./lib/memory-merge-safety.js";
import { stripFrontmatter, withFrontmatter } from "./lib/frontmatter.js";
import { readJsonSafe, writeJsonAtomic } from "./lib/atomic-file.js";
import { shouldRunCronBootstrap, featureCronsHintFromMarker } from "./lib/setup/feature-cron-bootstrap.js";
import { featureModelOverrides } from "./lib/featureModels.js";
import { createMemoryHostRuntime } from "./lib/setup/memory-host-runtime.js";
import { createOpenClawSkillWorkshopClient } from "./lib/setup/skill-workshop-plugin-runtime.js";
import { createWorkspacePolicyStore } from "./lib/workspace-policy.js";
import { createMemoryMaintenanceGate } from "./lib/memory-maintenance-gate.js";
import { resolveEmbeddingGenerationLayout } from "./lib/reembedding/generation-layout.js";
import { createMigrationStateStore } from "./lib/reembedding/state-store.js";
import { createLanceGenerationBackend } from "./lib/reembedding/lance-backend.js";
import { createReembeddingCoordinator } from "./lib/reembedding/coordinator.js";
import {
  createReembeddingSwitchRecovery,
  createReembeddingSwitchRuntime,
} from "./lib/reembedding/switch-runtime.js";
import { createGenerationRuntimeProbe } from "./lib/reembedding/runtime-probe.js";
import {
  createFailedModelPreparationCoordinator,
  createModelPreparationCoordinator,
} from "./lib/model-preparation/coordinator.js";
import { embeddingFingerprintId } from "./lib/reembedding/fingerprint.js";
import {
  createOpenClawEmbeddingSelectionMutator,
  embeddingFingerprintFromNormalizedConfig,
  redactedEmbeddingSecretRef,
} from "./lib/reembedding/runtime-config.js";
import {
  createControlPlaneHealthInspector,
  createControlPlaneHealthScan,
} from "./lib/control-plane-health.js";
import {
  createWorkspacePolicyGuard,
} from "./lib/workspace-policy-guard.js";
import {
  isGuardedDirectFeatureCronMessage,
  planUnsafeDirectCronDisables,
} from "./lib/setup/feature-cron-plan.js";
import { createObsidianBridgeService, discoverObsidianWorkspaces } from "./lib/obsidian-bridge.js";
import { discoverSemanticLinks } from "./lib/obsidian/semantic-link-discoverer.js";
import { writeMemoryNotes } from "./lib/obsidian/memory-note-writer.js";
import { handleObsidianBridgeCommand } from "./lib/obsidian-control-room.js";
import { mutationAllowed, parseObsidianCommandPlan } from "./lib/obsidian-mutation-policy.js";
import { isOwnedVaultConfirmed } from "./lib/obsidian-vault-authority.js";
import { withAccessReadDbs } from "./lib/shared-memory.js";
import { getSharedDeferredDynamicsQueue } from "./lib/deferred-dynamics-queue.js";
import {
  archiveCard,
  shareCard,
} from "./lib/telegram-commands/memory-edit.js";
import { validateMemoryText } from "./lib/input-limits.js";
import { createDbAdapter } from "./lib/db-adapter.js";
import { normalizeEpistemicStatus, transitionEpistemicStatus, combineEpistemicStatusForMerge } from "./lib/epistemic-status.js";
import { normalizeCapturedValidityWindow, validateValidTimeInputFields, buildValidTimeClosePatch, hasDisjointValidityWindows, combineValidTimeForMerge } from "./lib/valid-time.js";
import { createLocalModelGenerationLifecycle, runtimeIfUsable, shouldCoordinateLocalModelGeneration, configMutationLogNotice } from "./lib/runtime-shutdown.js";
import { createHostServices } from "./lib/host-services.js";
import { makeBoundedCache } from "./lib/bounded-cache.js";
import {
  openDirectoryCapability,
  pathMatchesDirectoryCapability,
  stableDirectoryCapabilitiesSupported,
} from "./lib/directory-capability.js";
import { activateSkillProposal, findProposalWorkspace, createSkillWorkshopLifecycleSynchronizer } from "./lib/telegram-commands/skill-commands.js";
import { markProposalStatus, patchProposal, readProposals as readSkillProposals } from "./lib/jobs/skill-miner/proposal-writer.js";
import { collectSkillWorkshopProposals } from "./lib/setup/skill-workshop-dashboard.js";
import { resolveLocale, readSoulToneCached, pickTone, t } from "./lib/i18n.js";
import {
  PLUGIN_KEY,
  detectPendingFeatures,
  isApplyBlocked,
  reportDormantFeature,
} from "./lib/setup/feature-profiles.js";
import { PLUGIN_CONFIG_PATH, resolveEffectiveConfig } from "./lib/setup/config-contract.js";
import {
  checkWikiAuth,
  parseWikiCommandInput,
  runWikiCommand,
} from "./lib/wiki-command.js";
import { checkAccess } from "./lib/acl-middleware.js";
import {
  buildMemoryAccountTopology,
  buildMemoryWorkspaceAliases,
  createHostIncognitoSessionClassifier,
  createHostRoutingLoader,
  getSharedMemoryTurnRouteRegistry,
  describePrimaryAgentIds,
  describeUserPoolLabels,
  describeWorkspacePoolLabels,
  resolveMemoryRequestContext,
  resolveToolMemoryRequestContext,
  normalizeWorkspaceTarget,
  workspacePoolKey,
  describeDirectSessionRoute as describeOperatorDirectSession,
} from "./lib/memory-request-context.js";
import { safeUuid, safeTimestamp, safeAgentId, resolveInside, appendDestructiveOpLog, safeStatus } from "./lib/sql-safety.js";
import { measureControlHealthStorage } from "./lib/control-plane-storage.js";
import { buildTombstone, appendTombstoneToRegistry, findBlockingTombstoneForCapture, backfillCommittedTombstone } from "./lib/tombstone.js";
import { decideEpistemicStatusForCapture, coerceNewWriteEpistemicStatus } from "./lib/epistemic-capture.js";
import { ensureEpistemicCutoff, readEpistemicCutoff } from "./lib/epistemic-cutoff.js";
import { assertCardWriteAllowed, isContentChangingUpdate, splitAgentDbPath } from "./lib/tombstone-write-guard.js";
import { validateConfirmation } from "./lib/security.js";
import { runRecallPipeline, mergeNamespaceRecallResults, emitRetrievalLedger } from "./lib/recall-pipeline.js";
import { applyRecallBudget, resolveRecallBudget } from "./lib/recall-budget.js";
import {
  createRecallDecisionTrace,
  addTraceStoreDecision,
  textPreview,
} from "./lib/recall-decision-trace.js";
import {
  buildNeoWorkspaceAliases,
  createNeoStore,
  findLatestNeoRecord,
  isNeoRecordAccessible,
  listNeoWorkspaceKeys,
  neoSessionKeysFromContext,
  searchNeoCandidatesGlobal,
  workspaceKeyFromContext,
} from "./lib/neo-arch.js";
import { getSharedNeoWorkerRuntime } from "./lib/neo-worker-runtime.js";
import {
  normalizeEmbeddingConfig,
  normalizeRerankerConfig,
  resolveLocalModelCacheDir,
} from "./lib/providers/config-normalize.js";
import { applyLegacyProviderDefaults } from "./lib/providers/legacy-provider-migration.js";
import { DEFAULT_LOCAL_RERANKER_MODEL, EMBEDDING_DIMENSIONS, LEGACY_DEFAULT_MODEL } from "./lib/providers/dimensions.js";
import { OpenAIEmbeddingProvider } from "./lib/providers/embedding-openai.js";
import { LocalTransformersEmbeddingProvider } from "./lib/providers/embedding-local-transformers.js";
import {
  ReloadSafeIpcScopedEmbeddingProvider,
  createScopedEmbeddingIpcServer,
} from "./lib/providers/scoped-embedding-ipc.js";
import {
  pinnedLocalModelProfile,
  validatePinnedModelArtifacts,
} from "./lib/providers/local-model-artifacts.js";
import { registerOpenClawMemoryEmbeddingProviders } from "./lib/providers/openclaw-memory-embedding-adapters.js";
import { CohereRerankerProvider } from "./lib/providers/reranker-cohere.js";
import { createConfiguredSecretInputResolver } from "./lib/providers/secret-input.js";
import { LocalTransformersRerankerProvider } from "./lib/providers/reranker-local-transformers.js";
import { ChainedRerankerProvider } from "./lib/providers/reranker-chained.js";
import {
  createBackgroundMemoryScheduler,
  isBackgroundTurn,
  shouldSkipAutoRecallForInternalTurn,
} from "./lib/runtime-scheduler.js";
import { createRecallPhaseTimer } from "./lib/recall-phase-timer.js";
import { createEmbeddingCache } from "./lib/embedding-cache.js";
import { withTimeout, TimeoutError } from "./lib/with-timeout.js";
import { isAbortError } from "./lib/abort.js";
import { redactError, safeDebug, safeWarn, settleSafeWarning, trySafeWarn } from "./lib/safe-logging.js";
import { safeWarnLlmFailure } from "./lib/llm-failure.js";
import { callLlm as callOpenAiLlm } from "./lib/llm-call.js";
import {
  LLM_ROUTE_KINDS,
  completeFeatureLlm,
  isLlmRouteAvailable,
  resolveFeatureLlmRoute,
} from "./lib/llm-router.js";
import {
  LLM_RESULT_CACHE_PURPOSES,
  createLlmResultCache,
  withLlmCallContext,
  withLlmResultCacheContext,
} from "./lib/llm-result-cache.js";
import {
  inferEmotionalValenceAsync,
  deserializeEmotionalValence,
  setEmotionConfig,
} from "./lib/emotion.js";
import { createEmotionalStatePool } from "./lib/emotional-state.js";
import { applyDynamicsDefaults, resolveHalfLifeDays } from "./lib/memory-dynamics.js";
import { applyRetroactiveInterference } from "./lib/retroactive-interference.js";
import { buildRemPartitions } from "./lib/dreaming/rem-dream.js";
import {
  completePendingReplyOutcomes,
  lastMessageText,
  recordAgentReplyForOutcome,
  sessionKeyFrom,
} from "./lib/reply-outcome-tracking.js";
import { MultiNamespacePool } from "./lib/multi-namespace-pool.js";
import { SharedMemoryPool } from "./lib/shared-memory-pool.js";
import { resolveNamespaceLayout } from "./lib/namespace-config.js";
import {
  getMergeResultByMediaOutputId,
} from "./lib/speaker-mapping-store.js";
import { proposeSpeakerNames, storeNewProposals } from "./lib/speaker-proposer.js";
import { registerTurnRouteHooks } from "./adapter/openclaw/register-turn-route.js";
import { registerMaintenanceHook } from "./adapter/openclaw/register-maintenance-hook.js";
import { registerRecallHook } from "./adapter/openclaw/register-recall-hook.js";
import { registerCaptureHook } from "./adapter/openclaw/register-capture-hook.js";
import { createPlur1busCommandRunner } from "./engine/commands/plur1bus-command.js";
import { registerChatCommands } from "./adapter/openclaw/register-commands.js";
import { registerPromptSupplements } from "./adapter/openclaw/register-prompt-supplements.js";
import { registerMemoryTools } from "./adapter/openclaw/register-tools.js";
import { registerDeferredFeatureCronBootstrap, registerUnsafeDirectCronGuard } from "./adapter/openclaw/register-cron.js";
import { registerGatewayShutdownServices, registerNeoServiceLifecycle, registerNeoWorkerWarmUp, registerObsidianBridgeLifecycle } from "./adapter/openclaw/register-gateway.js";

// Pfade relativ zum Plugin-Verzeichnis auflösen — der Stock-Pfad bleibt nur
// als Legacy-Fallback für lokale Repo-Setups erhalten.
const __pluginDir = dirname(fileURLToPath(import.meta.url));
const LANCEDB_LEGACY_PATH = join(__pluginDir, "../memory-lancedb-stock/node_modules/@lancedb/lancedb/dist/index.js");
const OPENAI_LEGACY_PATH  = join(__pluginDir, "../memory-lancedb-stock/node_modules/openai/index.js");
// v6.2.1 — Zusätzliche Fallback-Pfade für npm-Installationen (P0-Fix)
const LANCEDB_PLUGIN_PATH = join(__pluginDir, "node_modules/@lancedb/lancedb/dist/index.js");
const OPENAI_PLUGIN_PATH  = join(__pluginDir, "node_modules/openai/index.js");

const DEFAULT_BASE_DB_PATH = join(homedir(), ".openclaw", "memory", "lancedb-namespaced");
const DEFAULT_MODEL = LEGACY_DEFAULT_MODEL;
const MAX_PROMPT_REPLY_OUTCOME_READ_BYTES = 2 * 1024 * 1024;
// Wie viele bereits episodierte Turn-IDs im Hook-State vorgehalten werden.
// Dedup laeuft ueber Turn-IDs statt ueber den Batch-Digest, weil ein
// haengendes Watermark die naechste Slice verbreitert und den Digest damit
// aendert — die Turn-IDs bleiben dagegen stabil.
const EPISODED_TURN_ID_MEMORY = 2000;
// Nach so vielen erfolglosen Nachverarbeitungslaeufen wird das Watermark
// nachgezogen, damit ein dauerhaft kaputter Pfad die Slice nicht unbegrenzt
// wachsen laesst. Der uebersprungene Bereich wird dabei laut protokolliert.
const MAX_POSTPROCESSING_RETRIES = 5;

// Wie viele Zeichen von Alt- und Neu-Text die /correct-Bestätigung zeigt. Lang
// genug, damit erkennbar ist, welche Erinnerung überschrieben wird; kurz genug,
// dass zwei Auszüge plus Anleitung in eine Chat-Nachricht passen.
const CORRECTION_PREVIEW_CHARS = 300;

// PLUGIN_VERSION: read once from openclaw.plugin.json (Single Source of
// Truth, see file header). Used only for the fail-open feature-cron notice
// below — never for anything version-gating behavior.
let PLUGIN_VERSION = "0.0.0";
try {
  PLUGIN_VERSION = JSON.parse(readFileSync(join(__pluginDir, "openclaw.plugin.json"), "utf8")).version || PLUGIN_VERSION;
} catch (_err) { /* best-effort; stays "0.0.0" */ }

// Feature-cron setup hint cache: computed at most once per gateway process
// (see getFeatureCronsSetupHint below), fail-open, never throws.
// undefined = not yet computed; null = computed, no hint; string = hint text.
let _featureCronsHintCache;

const TABLE_NAME = "memories";

// Modulweiter Debug-Logger: wird in register() auf host.logger gesetzt. So
// können auch leere best-effort-catches (#10) ihren Fehler auf Debug-Level
// loggen statt ihn komplett zu schlucken — ohne in jedem Helper api zu haben.
let pluginLogger = null;
// Lightweight per-DB throttle for hot-path purgeExpired() calls (Scope C).
const PURGE_THROTTLE_MS = 5 * 60 * 1000;
const purgeThrottleMap = new Map();
function dbg(e, scope = "") {
  try {
    pluginLogger?.debug?.(`[plur1bus]${scope ? " " + scope : ""}: ${e?.message ?? e}`);
  } catch { /* debug darf niemals werfen */ }
}

async function runSpeakerProposalPipeline(agentId, mediaOutputIds) {
  if (!mediaOutputIds || mediaOutputIds.length === 0) {
    return { proposals: 0 };
  }
  try {
    let totalStored = 0;
    for (const mediaOutputId of mediaOutputIds) {
      const segments = getMergeResultByMediaOutputId(mediaOutputId);
      if (!segments || segments.length === 0) {
        continue;
      }
      const proposals = await proposeSpeakerNames(segments, agentId);
      if (proposals.length > 0) {
        const { stored } = storeNewProposals(agentId, proposals);
        totalStored += stored;
      }
    }
    if (totalStored > 0) {
      pluginLogger?.info?.(
        `[plur1bus] speaker proposal pipeline: stored ${totalStored} new proposal(s) for agent=${agentId}`,
      );
    }
    return { proposals: totalStored };
  } catch (err) {
    pluginLogger?.warn?.(`[plur1bus] speaker proposal pipeline failed: ${String(err)}`);
    return { proposals: 0 };
  }
}

// Lazy-loaded modules
let _lancedb = null;
let _OpenAI = null;

// ============================================================================
// Legacy Reranker — Cohere Rerank API v2 (kept for old local test imports)
// ============================================================================

class Reranker {
  constructor(apiKey, model = "rerank-v3.5") {
    this.apiKey = apiKey;
    this.model = model;
  }

  async rerank(query, documents, topN) {
    if (!documents || documents.length === 0) return [];

    const response = await fetch("https://api.cohere.com/v2/rerank", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        query,
        documents,
        top_n: topN,
        return_documents: false,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Cohere rerank failed (${response.status}): ${err}`);
    }

    const data = await response.json();
    // Returns [{index, relevance_score}, ...]  sorted by relevance_score desc
    return data.results;
  }
}

function semanticDiscoveryStats() {
  return {
    processed: 0,
    skipped: 0,
    unchanged: 0,
    errors: 0,
    indexUpdated: false,
    blocked: false,
    batchAborted: false,
  };
}

function addSemanticDiscoveryStats(total, result = {}) {
  total.processed += result.processed || 0;
  total.skipped += result.skipped || 0;
  total.unchanged += result.unchanged || 0;
  total.errors += result.errors || 0;
  total.indexUpdated = total.indexUpdated || result.indexUpdated === true;
  total.blocked = total.blocked || result.blocked === true;
  total.batchAborted = total.batchAborted || result.batchAborted === true;
  if (result.reason && !total.reason) total.reason = result.reason;
  return total;
}

/**
 * Select the configured Obsidian workspaces owned by a cron's triggering agent.
 *
 * @param {object} rawConfig
 * @param {string} agentId
 * @returns {Array<object>}
 */
export function selectSemanticDiscoveryWorkspaces(rawConfig = {}, agentId) {
  const workspaceAgentId = typeof agentId === "string" ? agentId.trim() : "";
  if (!workspaceAgentId) return [];
  return discoverObsidianWorkspaces(rawConfig, { workspace: workspaceAgentId });
}

async function runSemanticDiscoveryBatches({ db, semVaultCfg, pool, logger, defaultAgentId, mutationPolicy }) {
  const discoveryCfg = semVaultCfg?.graphLinks?.semanticDiscovery || {};
  const batchSize = Math.max(1, Math.min(Number(discoveryCfg.batchSize || 500), 5000));
  let remaining = Math.max(1, Number(discoveryCfg.maxPerRun || 500));
  const total = semanticDiscoveryStats();
  if (!mutationAllowed(mutationPolicy, "semantic_index_write")
    || !mutationAllowed(mutationPolicy, "vault_write")) {
    return { ...total, blocked: true, reason: "bound_confirmation_required" };
  }

  const scanBatches = typeof db.scanActiveBatches === "function"
    ? db.scanActiveBatches({ batchSize })
    : (async function* fallbackScan() { yield await db.scanActive(); })();

  for await (const lancedbRecords of scanBatches) {
    if (!Array.isArray(lancedbRecords) || lancedbRecords.length === 0) continue;
    await writeMemoryNotes(semVaultCfg, lancedbRecords, { logger, mutationPolicy });
    const result = await discoverSemanticLinks(semVaultCfg, lancedbRecords, {
      db,
      pool,
      logger,
      defaultAgentId,
      maxPerRun: remaining,
      mutationPolicy,
      confirm: true,
    });
    addSemanticDiscoveryStats(total, result);
    const consumed = (result.processed || 0) + (result.skipped || 0) + (result.unchanged || 0) + (result.errors || 0);
    remaining -= Math.max(consumed, 0);
    if (result.batchAborted || remaining <= 0) break;
  }

  return total;
}

async function getLanceDB() {
  if (!_lancedb) {
    try {
      _lancedb = await import("@lancedb/lancedb");
      return _lancedb;
    } catch (directErr) {
      // v6.2.1 — Versuche Plugin-eigenes node_modules (P0-Fix)
      if (existsSync(LANCEDB_PLUGIN_PATH)) {
        _lancedb = await import(LANCEDB_PLUGIN_PATH);
        return _lancedb;
      }
      // v6.2.1 — Versuche Legacy-Pfad (P0-Fix)
      if (existsSync(LANCEDB_LEGACY_PATH)) {
        _lancedb = await import(LANCEDB_LEGACY_PATH);
        return _lancedb;
      }
      throw new Error(
        `memory-lancedb-namespaced: LanceDB dependency not found. ` +
        `Install the plugin package dependencies: npm install @lancedb/lancedb. ` +
        `Direct import failed: ${directErr?.message || String(directErr)}`
      );
    }
  }
  return _lancedb;
}

async function getOpenAI() {
  if (!_OpenAI) {
    try {
      const m = await import("openai");
      _OpenAI = m.default;
      return _OpenAI;
    } catch (directErr) {
      // v6.2.1 — Versuche Plugin-eigenes node_modules (P0-Fix)
      if (existsSync(OPENAI_PLUGIN_PATH)) {
        const m = await import(OPENAI_PLUGIN_PATH);
        _OpenAI = m.default;
        return _OpenAI;
      }
      // v6.2.1 — Versuche Legacy-Pfad (P0-Fix)
      if (existsSync(OPENAI_LEGACY_PATH)) {
        const m = await import(OPENAI_LEGACY_PATH);
        _OpenAI = m.default;
        return _OpenAI;
      }
      throw new Error(
        `memory-lancedb-namespaced: openai dependency not found. ` +
        `Install the plugin package dependencies: npm install openai. ` +
        `Direct import failed: ${directErr?.message || String(directErr)}`
      );
    }
  }
  return _OpenAI;
}

function resolveEnvVars(value) {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const v = process.env[envVar];
    if (!v) throw new Error(`Environment variable ${envVar} is not set`);
    // Strip control chars that could corrupt HTTP headers or JSON strings
    return v.replace(/[\r\n\t\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").trim();
  });
}

function resolveOptionalEnvVars(value) {
  try {
    return resolveEnvVars(value);
  } catch (_) {
    return undefined;
  }
}

function resolveConfiguredApiKey(cfg = {}, defaultRef = "") {
  if (typeof cfg.apiKeyEnv === "string" && cfg.apiKeyEnv.trim()) {
    return process.env[cfg.apiKeyEnv.trim()] || undefined;
  }
  if (typeof cfg.apiKey === "string" && cfg.apiKey.trim()) {
    return resolveEnvVars(cfg.apiKey);
  }
  return defaultRef ? resolveOptionalEnvVars(defaultRef) : undefined;
}

function normalizedLlmErrorClass(error) {
  if (error instanceof TypeError) return "TypeError";
  if (error instanceof RangeError) return "RangeError";
  if (error instanceof SyntaxError) return "SyntaxError";
  if (error?.name === "TimeoutError" && error?.code === "ETIMEOUT") return "TimeoutError";
  if (typeof DOMException === "function"
    && error instanceof DOMException
    && error.name === "AbortError") {
    return "AbortError";
  }
  if (error instanceof Error) return "Error";
  return "NonError";
}

function commandOption(tokens = [], flag, fallback = "") {
  const index = tokens.indexOf(flag);
  if (index >= 0 && typeof tokens[index + 1] === "string" && !tokens[index + 1].startsWith("--")) {
    return tokens[index + 1];
  }
  return fallback;
}

// generateSummary kommt jetzt aus lib/text-utils.js — re-export für Tests
const generateSummary = libGenerateSummary;

// Liest die ersten `maxBytes` einer Datei synchron als String.
// Verwendet explizite Datei-Handles, um große Dateien nicht komplett in den
// Speicher zu laden (P1 Performance-Audit H1).
function readFileHeadSync(path, maxBytes = 8192) {
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const toRead = Math.min(size, maxBytes);
    const buf = Buffer.alloc(toRead);
    const bytesRead = readSync(fd, buf, 0, toRead, 0);
    return buf.toString("utf8", 0, bytesRead);
  } catch (_) {
    return "";
  } finally {
    if (typeof fd === "number") closeSync(fd);
  }
}

// ============================================================================
// LLM-based summarization for long messages (auto-capture)
// ============================================================================

/**
 * Summarize oversized captured text with deterministic agent-scoped LLM settings.
 * @param {string} text
 * @param {number} maxChars
 * @param {object} llmCfg
 * @param {object} logger
 * @param {string} agentId
 * @param {{agentId?: string, runtimeLlm?: object, signal?: AbortSignal}} [callContext]
 * @returns {Promise<string>}
 */
async function summarizeForCapture(text, maxChars, llmCfg, logger, agentId, callContext = {}) {
  try {
    const result = await callLlm([
      {
        role: "user",
        content: `Summarize this text into the most important facts, decisions, preferences, and actionable information. Keep all specific names, numbers, URLs, dates, technical details, and configuration values. Output ONLY the summary, no preamble. Target length: ${Math.round(maxChars / 4)} characters.\n\n${text.slice(0, 60000)}`,
      },
    ], withLlmCallContext(
      withLlmResultCacheContext(
        { ...llmCfg, maxTokens: Math.round(maxChars / 3), temperature: 0 },
        agentId,
        LLM_RESULT_CACHE_PURPOSES.CAPTURE_SUMMARY,
      ),
      callContext?.agentId || agentId,
      LLM_RESULT_CACHE_PURPOSES.CAPTURE_SUMMARY,
      { runtimeLlm: callContext?.runtimeLlm, signal: callContext?.signal },
    ));
    if (result && result.length > 20) return result;
  } catch (e) {
    safeWarnLlmFailure(logger, "capture-summary.llm", e, { fallback: "truncate" });
  }
  // Fallback: truncate if LLM fails
  return text.slice(0, maxChars);
}

// Baut eine querySummarizer-Funktion für runRecallPipeline.
// Fasst einen langen Prompt auf die semantisch wichtigsten Themen/Schlüsselwörter
// zusammen, statt ihn hart zu kürzen — so gehen keine Suchinformationen verloren.
/**
 * Build an agent-scoped deterministic recall query summarizer.
 * @param {object|null} llmCfg
 * @param {object} logger
 * @param {string} agentId
 * @param {{agentId?: string, runtimeLlm?: object, signal?: AbortSignal}} [callContext]
 * @returns {Function|null}
 */
function makeQuerySummarizer(llmCfg, logger, agentId, callContext = {}) {
  if (!llmCfg) return null;
  return async (query) => {
    const result = await callLlm([
      {
        role: "user",
        content: `Extract the key topics, names, events, decisions, and facts from the following text that are relevant for a semantic memory search. Output ONLY a compact summary (2-4 sentences, max 800 chars) capturing the most searchable information. Do not add commentary.\n\n${query.slice(0, 60000)}`,
      },
    ], withLlmCallContext(
      withLlmResultCacheContext(
        { ...llmCfg, maxTokens: 300, temperature: 0 },
        agentId,
        LLM_RESULT_CACHE_PURPOSES.RECALL_QUERY_SUMMARY,
      ),
      callContext?.agentId || agentId,
      LLM_RESULT_CACHE_PURPOSES.RECALL_QUERY_SUMMARY,
      { runtimeLlm: callContext?.runtimeLlm, signal: callContext?.signal },
    ));
    if (result && result.length > 20) return result;
    throw new Error("empty summarizer response");
  };
}

function normalizeBoundedRecallInteger(value, fallback, minimum, maximum) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function resolveRuntimeRecallBudget(query, ceiling, adaptiveBudget) {
  const cap = normalizeBoundedRecallInteger(ceiling, 12, 1, 100);
  if (adaptiveBudget?.enabled !== true) return cap;
  const tokenBudgetPct = Number.isFinite(adaptiveBudget.tokenBudgetPct)
    ? Math.min(1, Math.max(0, adaptiveBudget.tokenBudgetPct))
    : 0.3;
  const resolved = resolveRecallBudget({
    promptLength: String(query || "").length,
    hasProjectSignals: /\b(project|plan|milestone|roadmap|deadline)\b/i.test(String(query || "")),
    maxPromptMemories: cap,
    tokenBudgetPct,
  });
  return Math.min(cap, Math.max(1, Math.floor(resolved.budget)));
}

function applyMergedRecallBudget(merged, budget) {
  const effectiveBudget = normalizeBoundedRecallInteger(budget, 12, 1, 100);
  const canonical = Array.isArray(merged.canonical) ? merged.canonical.slice(0, effectiveBudget) : [];
  const remainingBudget = Math.max(0, effectiveBudget - canonical.length);
  const memories = applyRecallBudget(merged.memories || [], { budget: remainingBudget }).selected;
  return { ...merged, canonical, memories };
}

/**
 * Runs one existing recall pipeline per leased namespace and merges only after
 * every child settled, so a failed namespace cannot expose partial results.
 *
 * @param {{namespace?: string|null, db: MemoryDB}[]} readDbs
 * @param {Object} baseParams
 * @param {Object|null|undefined} trace
 * @param {Object|null|undefined} phaseTimer
 * @param {{strictReadErrors?: boolean}} [options]
 * @returns {Promise<{queryVector: Array|undefined, canonical: Array, memories: Array, trace: Object|undefined}>}
 */
async function runMergedNamespaceRecall(
  readDbs,
  baseParams,
  trace,
  phaseTimer,
  // Fix round 2: `recordNamespacePhases` defaults to false, so this stays a
  // pure no-op for every existing caller (index.js:4318's `recall:` tool
  // helper, engine/tools/memory-tools.js's manual `memory_recall` path) and
  // in production (assemble-prompt-context.js only sets it true when a
  // recallTimingSink is actually attached, which no real OpenClaw host does
  // — see that call site). This makes the fold below conditional rather than
  // relying on a test to prove the outer phaseTimer's observable summary()
  // (read in production by lib/runtime-scheduler.js:456's timeout-warning
  // log line) is unaffected.
  { strictReadErrors = false, recordNamespacePhases = false } = {},
) {
  if (!Array.isArray(readDbs) || readDbs.length === 0) {
    return { queryVector: undefined, canonical: [], memories: [], trace };
  }
  const providerEmbeddings = baseParams.embeddings;
  const embedOptions = baseParams.signal
    ? { agentId: baseParams.agentId, signal: baseParams.signal }
    : { agentId: baseParams.agentId };
  const requestEmbeddings = Object.freeze({
    embedQuery: (text) => typeof providerEmbeddings.embedQuery === "function"
      ? providerEmbeddings.embedQuery(text, embedOptions)
      : providerEmbeddings.embed(text, embedOptions),
    embed: (text) => providerEmbeddings.embed(text, embedOptions),
  });
  const timerConfig = phaseTimer?.summary?.() || {};
  phaseTimer?.start("namespace-recall");
  try {
    const requestNow = Date.now();
    const canonicalSourceIndex = readDbs.findIndex((source) => source.sourceKind === "private");
    const settled = await Promise.allSettled(readDbs.map(async ({ namespace, sourceKind, optional, db }, index) => {
      const childTrace = trace
        ? createNamespaceChildRecallTrace(trace, baseParams.query)
        : undefined;
      const childTimer = createRecallPhaseTimer({
        softBudgetMs: timerConfig.softBudgetMs,
        hardTimeoutMs: timerConfig.hardTimeoutMs,
        logger: baseParams.logger,
      });
      const childStrictReadErrors = readDbs.length === 1
        ? (strictReadErrors || baseParams.strictReadErrors === true)
        : optional !== true;
      const result = await runRecallPipeline({
        ...baseParams,
        embeddings: requestEmbeddings,
        dbTable: db.table,
        phaseTimer: childTimer,
        decisionTrace: childTrace,
        strictReadErrors: childStrictReadErrors,
        canonicalEnabled: index === canonicalSourceIndex ? baseParams.canonicalEnabled : false,
        retrievalLogger: null,
        deferFinalCap: true,
        candidateHardLimit: 100,
        now: requestNow,
      });
      // Task 19 fix round 2: fold this namespace's fine-grained phases
      // (embedding, vector_search, query_refinement, ... — see
      // lib/recall-pipeline.js's phaseTimer.start/end calls) into the outer
      // phaseTimer, which otherwise only ever sees one coarse
      // "namespace-recall" block covering all of them combined. `childTimer`
      // stays separate from `phaseTimer` for the actual timing (concurrent
      // namespace reads via Promise.allSettled would otherwise interleave
      // start/end calls on a shared timer); this only copies its finished,
      // already-measured entries over via the additive `record()` method,
      // after that namespace's own recall has fully settled. Gated on
      // `recordNamespacePhases` (default false) so this is skipped entirely
      // — not just harmlessly no-op, but never executed — unless a caller
      // opted in; production never does (see the function's JSDoc above).
      if (recordNamespacePhases) {
        for (const entry of childTimer.summary().completed) {
          phaseTimer?.record?.(`${namespace}:${entry.phase}`, entry.ms);
        }
      }
      return { namespace, sourceKind, optional, result };
    }));
    const requiredSettled = settled.filter((result, index) => readDbs[index].optional !== true);
    const failure = combineNamespaceRecallFailures(requiredSettled);
    if (failure) throw failure;

    const namespaceResults = [];
    for (let index = 0; index < settled.length; index++) {
      const result = settled[index];
      if (result.status === "rejected") {
        trySafeWarn(baseParams.logger, `namespace-recall.${readDbs[index].namespace}`, result.reason);
        continue;
      }
      namespaceResults.push({
        namespace: result.value.namespace,
        sourceKind: result.value.sourceKind,
        ...result.value.result,
      });
    }
    let merged = mergeNamespaceRecallResults(namespaceResults, {
      maxOut: baseParams.topN,
      canonicalMaxItems: baseParams.canonicalMaxItems,
      dedupEnabled: baseParams.dedupEnabled,
      dedupJaccard: baseParams.dedupJaccard,
      trace,
    });
    if (baseParams.adaptiveBudget?.enabled !== false) {
      merged = applyMergedRecallBudget(merged, baseParams.budget);
    }
    emitRetrievalLedger({
      retrievalLogger: baseParams.retrievalLogger,
      logger: baseParams.logger,
      entry: {
        agentId: baseParams.agentId,
        workspaceKey: baseParams.workspaceKey,
        query: baseParams.query,
        resultsCount: merged.memories.length,
        selectedIds: merged.memories.map((memory) => memory.entry.id),
      },
    });
    return merged;
  } catch (error) {
    try {
      phaseTimer?.fail?.("namespace-recall", error);
    } catch (phaseTimerError) {
      trySafeWarn(baseParams.logger, "namespace-recall.phaseTimer", phaseTimerError);
    }
    throw error;
  } finally {
    phaseTimer?.end("namespace-recall");
  }
}

function combineNamespaceRecallFailures(settled) {
  const failures = settled
    .filter((result) => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length === 0) return null;
  const timeoutFailures = failures.filter((error) => (
    error instanceof TimeoutError
    && error.settlement
    && typeof error.settlement.then === "function"
  ));
  if (timeoutFailures.length === 0) return failures[0];
  const primary = timeoutFailures[0];
  const settlements = [...new Set(timeoutFailures.map((error) => error.settlement))];
  if (settlements.length > 1) {
    primary.settlement = settleAllNamespaceReads(settlements);
  }
  return primary;
}

async function settleAllNamespaceReads(settlements) {
  const outcomes = await Promise.allSettled(settlements);
  const failed = outcomes.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return outcomes.map((result) => result.value);
}

function createNamespaceChildRecallTrace(masterTrace, query) {
  const config = masterTrace?.config || {};
  return createRecallDecisionTrace({
    query,
    maxTextPreviewChars: config.maxTextPreviewChars,
    maxCandidates: config.maxCandidates,
    maxDecisions: config.maxDecisions,
    maxGuards: config.maxGuards,
    maxStoreDecisions: config.maxStoreDecisions,
    config,
  });
}

// ============================================================================
// MemoryDB — pro Agent eine Instanz
// ============================================================================

const REINDEX_WRITE_THRESHOLD = 5000; // Rebuild ANN index every N writes (v6.2.1: increased from 500)
const REINDEX_MIN_ROWS = 256;         // Minimum rows before creating an index
const REINDEX_MIN_INTERVAL_MS = 3600000; // Max 1 reindex per hour (v6.2.1 P0-fix)

// Operation-level timeouts for LanceDB calls (P0 Performance-Audit K3).
const LANCEDB_READ_TIMEOUT_MS = 10_000;
const LANCEDB_WRITE_TIMEOUT_MS = 25_000;
const INIT_LATE_HANDLE_KIND = Symbol("MemoryDB.initLateHandleKind");
const MAX_BACKGROUND_LIFECYCLE_ERRORS = 50;

function logMemoryDbDebug(logger, scope, error, dbPath) {
  return safeDebug(logger, scope, error, { agent: basename(dbPath) });
}

async function waitForTimeoutSettlement(error) {
  let currentError = error;
  let waited = false;
  const seen = new Set();
  while (
    (currentError instanceof TimeoutError || isAbortError(currentError))
    && currentError.settlement
    && typeof currentError.settlement.then === "function"
    && !seen.has(currentError.settlement)
  ) {
    const settlement = currentError.settlement;
    seen.add(settlement);
    waited = true;
    try {
      const value = await settlement;
      return { waited, status: "fulfilled", value };
    } catch (settlementError) {
      currentError = settlementError;
    }
  }
  return waited
    ? { waited, status: "rejected", error: currentError }
    : { waited: false, status: "unavailable", error };
}

function normalizeVectorValue(vector) {
  if (!vector || Array.isArray(vector) || typeof vector !== "object") return vector;
  if (ArrayBuffer.isView(vector)) return Array.from(vector);
  if (Array.isArray(vector.values)) return vector.values.slice();
  if (ArrayBuffer.isView(vector.values)) return Array.from(vector.values);
  if (typeof vector.toArray === "function") {
    const arr = vector.toArray();
    if (Array.isArray(arr)) return arr.slice();
    if (ArrayBuffer.isView(arr)) return Array.from(arr);
    if (arr && typeof arr[Symbol.iterator] === "function") return Array.from(arr);
  }
  if (Number.isInteger(vector.length) && vector.length >= 0 && typeof vector.get === "function") {
    return Array.from({ length: vector.length }, (_, index) => vector.get(index));
  }
  return vector;
}

class MemoryDB {
  /**
   * @param {string} dbPath LanceDB agent path.
   * @param {number} vectorDim Vector dimension.
   * @param {object} [logger] Optional logger.
   * @param {{readOnly?: boolean, pathGuard?: (() => void), directoryCapability?: object|null, secureDirectoryRequired?: boolean, beforeLanceOperation?: ((operation: string, capability: object|null) => void), lancedbProvider?: (() => Promise<object>|object)}} [options] Non-mutating mode, trusted directory routing, and an injectable DB provider for lifecycle tests.
   */
  constructor(dbPath, vectorDim, logger = null, {
    readOnly = false,
    pathGuard = null,
    directoryCapability = null,
    secureDirectoryRequired = false,
    beforeLanceOperation = null,
    lancedbProvider = null,
  } = {}) {
    if (pathGuard !== null && typeof pathGuard !== "function") {
      throw new TypeError("MemoryDB pathGuard must be a function");
    }
    if (directoryCapability !== null && (
      typeof directoryCapability !== "object"
      || typeof directoryCapability.assertOpen !== "function"
      || typeof directoryCapability.close !== "function"
      || typeof directoryCapability.path !== "string"
    )) {
      throw new TypeError("MemoryDB directoryCapability must be a stable directory capability");
    }
    if (beforeLanceOperation !== null && typeof beforeLanceOperation !== "function") {
      throw new TypeError("MemoryDB beforeLanceOperation must be a function");
    }
    if (lancedbProvider !== null && typeof lancedbProvider !== "function") {
      throw new TypeError("MemoryDB lancedbProvider must be a function");
    }
    this.dbPath = dbPath;
    this.vectorDim = vectorDim;
    this.logger = logger;
    this.readOnly = readOnly === true;
    this.pathGuard = pathGuard;
    this.directoryCapability = directoryCapability;
    this.secureDirectoryRequired = secureDirectoryRequired === true;
    this.beforeLanceOperation = beforeLanceOperation;
    this.lancedbProvider = lancedbProvider;
    this.db = null;
    this.table = null;
    this.initPromise = null;
    this.shutdownPromise = null;
    this.pendingInitSettlements = new Set();
    this.pendingDebugSettlements = new Set();
    this.backgroundDiagnosticErrors = [];
    this.backgroundDiagnosticErrorOverflow = 0;
    this.initCleanupErrors = [];
    this.schemaFieldNames = null;
    this._writeCounter = 0;
    this._reindexing = false;
    this._lastReindexAt = 0;
    this.isShuttingDown = false;
    this.isShutdown = false;
  }

  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.isShutdown) return;
    this.isShuttingDown = true;
    const shutdownPromise = (async () => {
      const errors = [];
      const activeInit = this.initPromise;
      if (activeInit) {
        try {
          await activeInit;
        } catch (error) {
          errors.push(error);
          const logged = logMemoryDbDebug(this.logger, "MemoryDB.shutdown.activeInit", error, this.dbPath);
          const loggingOutcome = await settleSafeWarning(logged);
          if (!loggingOutcome.ok) errors.push(loggingOutcome.error);
        }
      }
      await this._drainPendingInitSettlements("shutdown");
      await this._drainPendingDebugSettlements();
      errors.push(...this._drainMemoryDbDiagnosticErrors());
      errors.push(...this.initCleanupErrors);
      this.initCleanupErrors = [];
      errors.push(...await this._closeHandles("shutdown"));
      try {
        this.directoryCapability?.close();
      } catch (error) {
        errors.push(error);
      } finally {
        this.directoryCapability = null;
      }
      this.initPromise = null;
      this.isShutdown = true;
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          `MemoryDB shutdown failed for ${this.dbPath} (${errors.length} lifecycle error${errors.length === 1 ? "" : "s"})`,
        );
      }
    })();
    this.shutdownPromise = shutdownPromise;
    try {
      return await shutdownPromise;
    } finally {
      this.isShuttingDown = false;
      if (this.shutdownPromise === shutdownPromise) this.shutdownPromise = null;
    }
  }

  async _acquireInitHandle(promise, label, kind, readOnly = this.readOnly) {
    try {
      return readOnly
        ? await this._read(promise, label)
        : await this._write(promise, label);
    } catch (error) {
      if (error instanceof TimeoutError && error.settlement) {
        error[INIT_LATE_HANDLE_KIND] = kind;
      }
      throw error;
    }
  }

  async _cleanupTimedOutInitHandles({
    rawStatus,
    rawValue,
    lateHandleKind,
    table,
    db,
  }) {
    const errors = [];
    const tables = new Set(table ? [table] : []);
    const connections = new Set(db ? [db] : []);
    let createdTable = null;

    if (rawStatus === "fulfilled") {
      if (lateHandleKind === "connection" && rawValue) connections.add(rawValue);
      if (lateHandleKind === "table" && rawValue) tables.add(rawValue);
      if (lateHandleKind === "created-table" && rawValue) {
        createdTable = rawValue;
        tables.add(rawValue);
      }
    }

    if (lateHandleKind === "created-table") {
      if (!createdTable && db) {
        try {
          const names = await db.tableNames();
          if (names.includes(TABLE_NAME)) {
            createdTable = await db.openTable(TABLE_NAME);
            tables.add(createdTable);
          }
        } catch (error) {
          errors.push(error);
        }
      }
      if (createdTable) {
        try {
          await createdTable.delete('id = "__schema__"');
        } catch (error) {
          errors.push(error);
        }
      }
    }

    for (const currentTable of tables) {
      try {
        if (typeof currentTable?.close === "function") await currentTable.close();
      } catch (error) {
        errors.push(error);
      }
    }
    for (const connection of connections) {
      try {
        if (typeof connection?.close === "function") await connection.close();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  _deferTimedOutInitCleanup(error) {
    if (!(error instanceof TimeoutError) || !error.settlement) return false;
    const rawSettlement = error.settlement;
    const lateHandleKind = error[INIT_LATE_HANDLE_KIND] || null;
    const table = this.table;
    const db = this.db;
    this.table = null;
    this.db = null;
    this.schemaFieldNames = null;

    const completion = (async () => {
      let rawStatus = "fulfilled";
      let rawValue;
      let rawError;
      try {
        rawValue = await rawSettlement;
      } catch (settlementError) {
        rawStatus = "rejected";
        rawError = settlementError;
      }
      const cleanupErrors = await this._cleanupTimedOutInitHandles({
        rawStatus,
        rawValue,
        lateHandleKind,
        table,
        db,
      });
      return { rawStatus, rawValue, rawError, cleanupErrors };
    })();
    const settlement = completion.then((outcome) => {
      if (outcome.rawError && outcome.cleanupErrors.length > 0) {
        throw new AggregateError(
          [outcome.rawError, ...outcome.cleanupErrors],
          `MemoryDB timed-out initialization and late cleanup failed for ${this.dbPath}`,
        );
      }
      if (outcome.cleanupErrors.length > 0) {
        throw new AggregateError(
          outcome.cleanupErrors,
          `MemoryDB timed-out initialization cleanup failed for ${this.dbPath}`,
        );
      }
      if (outcome.rawError) throw outcome.rawError;
      return outcome.rawValue;
    });
    settlement.then(
      () => {},
      (settlementError) => {
        this._trackMemoryDbDebug("MemoryDB.init.lateSettlement", settlementError);
      },
    );
    const record = { completion };
    this.pendingInitSettlements.add(record);
    completion.then(
      (outcome) => {
        if (outcome.cleanupErrors.length === 0) this.pendingInitSettlements.delete(record);
      },
      (completionError) => {
        this._trackMemoryDbDebug("MemoryDB.init.cleanupCompletion", completionError);
      },
    );
    error.settlement = settlement;
    return true;
  }

  _trackMemoryDbDebug(scope, error) {
    const outcome = logMemoryDbDebug(this.logger, scope, error, this.dbPath);
    if (!outcome.ok) {
      this._recordMemoryDbDiagnosticError(outcome.error);
      return;
    }
    if (!outcome.pending) return;
    let pending;
    pending = (async () => {
      try {
        const settled = await settleSafeWarning(outcome);
        if (!settled.ok) this._recordMemoryDbDiagnosticError(settled.error);
      } catch (settlementError) {
        this._recordMemoryDbDiagnosticError(settlementError);
      } finally {
        this.pendingDebugSettlements.delete(pending);
      }
    })();
    this.pendingDebugSettlements.add(pending);
  }

  async _drainPendingDebugSettlements() {
    await Promise.allSettled([...this.pendingDebugSettlements]);
  }

  _recordMemoryDbDiagnosticError(error) {
    if (this.backgroundDiagnosticErrors.length < MAX_BACKGROUND_LIFECYCLE_ERRORS) {
      this.backgroundDiagnosticErrors.push(error);
      return;
    }
    this.backgroundDiagnosticErrorOverflow += 1;
  }

  _drainMemoryDbDiagnosticErrors() {
    const errors = this.backgroundDiagnosticErrors.splice(0, this.backgroundDiagnosticErrors.length);
    if (this.backgroundDiagnosticErrorOverflow > 0) {
      errors.push(new Error(
        `MemoryDB background diagnostic failures omitted (${this.backgroundDiagnosticErrorOverflow})`,
      ));
      this.backgroundDiagnosticErrorOverflow = 0;
    }
    return errors;
  }

  async _drainPendingInitSettlements(context) {
    const records = [...this.pendingInitSettlements];
    if (records.length === 0) return [];
    const outcomes = await Promise.all(records.map((record) => record.completion));
    for (const record of records) this.pendingInitSettlements.delete(record);
    const cleanupErrors = outcomes.flatMap((outcome) => outcome.cleanupErrors);
    if (cleanupErrors.length > 0) {
      const aggregate = new AggregateError(
        cleanupErrors,
        `MemoryDB ${context} blocked by timed-out initialization cleanup for ${this.dbPath}`,
      );
      this.initCleanupErrors.push(aggregate);
      return [aggregate];
    }
    return [];
  }

  async _closeHandles(_context) {
    const errors = [];
    const table = this.table;
    const db = this.db;
    try {
      if (table && typeof table.close === "function") {
        // Close is lifecycle settlement, not an ordinary DB write. A timeout
        // wrapper cannot abort it and must not let cleanup/retry run ahead.
        await table.close();
      }
    } catch (error) {
      errors.push(error);
    }
    try {
      if (db && typeof db.close === "function") {
        await db.close();
      }
    } catch (error) {
      errors.push(error);
    } finally {
      this.table = null;
      this.db = null;
      this.schemaFieldNames = null;
    }
    return errors;
  }

  _read(promise, label) {
    return withTimeout(promise, LANCEDB_READ_TIMEOUT_MS, label);
  }

  _write(promise, label) {
    return withTimeout(promise, LANCEDB_WRITE_TIMEOUT_MS, label);
  }

  _assertWritable(operation) {
    if (this.readOnly) {
      throw new Error(`MemoryDB.${operation} rejected: database is read-only`);
    }
  }

  _assertTrustedPath() {
    if (this.isShuttingDown || this.isShutdown) {
      throw new Error(`MemoryDB is ${this.isShutdown ? "shutdown" : "shutting down"}: ${this.dbPath}`);
    }
    this.pathGuard?.();
    this.directoryCapability?.assertOpen();
  }

  _lancePath() {
    if (this.directoryCapability) return this.directoryCapability.path;
    if (this.secureDirectoryRequired) {
      throw new Error(`secure directory capability is unavailable for ${this.dbPath}`);
    }
    return this.dbPath;
  }

  _beforeLancePathOperation(operation) {
    this.beforeLanceOperation?.(operation, this.directoryCapability);
  }

  async refreshSchemaFields() {
    this._assertTrustedPath();
    if (!this.table) return;
    const schema = await this._read(this.table.schema(), "MemoryDB.schema");
    const fields = Array.isArray(schema?.fields) ? schema.fields : [];
    const textField = fields.find((field) => field.name === "text");
    if (!textField?.type) {
      throw new Error(`MemoryDB ownership schema verification failed: authoritative text field missing for ${this.dbPath}`);
    }
    // Utf8 vs. LargeUtf8 are both valid Arrow string types; LanceDB promotes a
    // column to LargeUtf8 once written values exceed the 32-bit offset range,
    // which happens routinely for `text` (long memory content) but not for
    // short id columns. Requiring bit-identical DataTypes here rejected
    // legitimate tables where `text` had been promoted but `agentId`/
    // `workspaceId` correctly stayed Utf8 — both are string-family, so both
    // are acceptable ownership-column types.
    const STRING_TYPES = new Set(["Utf8", "LargeUtf8"]);
    if (!STRING_TYPES.has(String(textField.type))) {
      throw new Error(`MemoryDB ownership schema verification failed: authoritative text field is not a string type for ${this.dbPath}`);
    }
    if (!this.readOnly) {
      for (const fieldName of ["agentId", "workspaceId"]) {
        const field = fields.find((candidate) => candidate.name === fieldName);
        if (!field || !STRING_TYPES.has(String(field.type))) {
          throw new Error(`MemoryDB ownership schema verification failed: ${fieldName} must match text DataType for ${this.dbPath}`);
        }
      }
    }
    this.schemaFieldNames = new Set(fields.map(f => f.name));
  }

  normalizeEntryForTable(entry) {
    const normalized = { ...entry, id: entry.id || randomUUID() };
    if (
      normalized.vector &&
      !Array.isArray(normalized.vector) &&
      typeof normalized.vector === "object"
    ) {
      normalized.vector = normalizeVectorValue(normalized.vector);
    }
    if (!normalized.type) normalized.type = "memory";
    if (typeof normalized.confirmed !== "boolean") normalized.confirmed = false;
    // All schema column defaults — LanceDB requires every field present on insert.
    // These cover both partial entries (e.g. reminders) and base memory fields.
    if (normalized.summary == null) normalized.summary = "";
    if (normalized.origin == null) normalized.origin = "dm";
    if (normalized.mergedFrom == null) normalized.mergedFrom = "[]";
    if (normalized.expiresAt == null) normalized.expiresAt = 0;
    if (normalized.agentId == null) normalized.agentId = "";
    if (normalized.storedBy == null) normalized.storedBy = "";
    if (normalized.sourceTurnId == null) normalized.sourceTurnId = "";
    if (normalized.sourceMessageRole == null) normalized.sourceMessageRole = "";
    if (normalized.sourceTimestamp == null) normalized.sourceTimestamp = 0;
    if (normalized.sourceUrl == null) normalized.sourceUrl = "";
    if (normalized.evidenceQuote == null) normalized.evidenceQuote = "";
    if (normalized.scope == null) normalized.scope = "agent-private";
    if (normalized.ownerUserId == null) normalized.ownerUserId = "";
    if (normalized.emotionalValence == null) normalized.emotionalValence = "";
    if (normalized.emotionalIntensity == null) normalized.emotionalIntensity = 0.0;
    if (normalized.emotionalDominant == null) normalized.emotionalDominant = "neutral";
    if (normalized.moodContextAtCapture == null) normalized.moodContextAtCapture = "";
    if (normalized.emotionStatus == null) normalized.emotionStatus = "final";
    normalized.importanceStatus = normalizeImportanceStatus(normalized.importanceStatus);
    if (normalized.replayCount == null) normalized.replayCount = 0;
    if (normalized.lastReplayed == null) normalized.lastReplayed = 0;
    if (normalized.retrievalCount == null) normalized.retrievalCount = 0;
    if (normalized.lastRetrievedAt == null) normalized.lastRetrievedAt = 0;
    if (normalized.memoryStrength == null) normalized.memoryStrength = 1.0;
    if (normalized.halfLifeDays == null) normalized.halfLifeDays = 30;
    if (normalized.lastStrengthenedAt == null) normalized.lastStrengthenedAt = 0;
    if (normalized.lastDynamicsAt == null) normalized.lastDynamicsAt = 0;
    if (normalized.memoryClass == null) normalized.memoryClass = "standard";
    if (normalized.neverForget == null) normalized.neverForget = 0;
    if (normalized.coreMemoryScore == null) normalized.coreMemoryScore = 0.0;
    if (normalized.coreMemoryReason == null) normalized.coreMemoryReason = "";
    if (normalized.versionNumber == null) normalized.versionNumber = 1;
    if (normalized.previousVersion == null) normalized.previousVersion = "";
    if (normalized.supersededBy == null) normalized.supersededBy = "";
    if (normalized.updateSource == null) normalized.updateSource = "";
    if (normalized.updateEvidence == null) normalized.updateEvidence = "";
    if (normalized.reconsolidationConfidence == null) normalized.reconsolidationConfidence = 0.0;
    if (normalized.status == null) normalized.status = "active";
    else if (normalized.status !== "") normalized.status = safeStatus(normalized.status);
    if (normalized.versionCreatedAt == null) normalized.versionCreatedAt = 0;
    if (normalized.updatedAt == null) normalized.updatedAt = 0;
    // createdAt war als einziges Zeitfeld ohne Default. Ein Writer, der es
    // vergisst, würde eine Zeile ohne Alter erzeugen, die im Recall dauerhaft
    // als age="unknown" erscheint. Jetzt-Zeitpunkt ist die einzig sinnvolle
    // Näherung für eine gerade entstehende Zeile.
    if (normalized.createdAt == null) normalized.createdAt = Date.now();
    if (normalized.workspaceId == null) normalized.workspaceId = "";
    if (normalized.workspaceKey == null) normalized.workspaceKey = "";
    if (normalized.memoryKind == null) normalized.memoryKind = "memory";
    if (normalized.reminderStatus == null) normalized.reminderStatus = "";
    if (normalized.remindAt == null) normalized.remindAt = 0;
    if (normalized.remindedAt == null) normalized.remindedAt = 0;
    if (normalized.dispatchedAt == null) normalized.dispatchedAt = 0;
    if (normalized.acknowledgedAt == null) normalized.acknowledgedAt = 0;
    if (normalized.cancelledAt == null) normalized.cancelledAt = 0;
    if (normalized.reminderKey == null) normalized.reminderKey = "";
    if (normalized.dispatchCount == null) normalized.dispatchCount = 0;
    if (normalized.lastDispatchAttemptAt == null) normalized.lastDispatchAttemptAt = 0;
    if (normalized.nextDispatchAttemptAt == null) normalized.nextDispatchAttemptAt = 0;
    if (normalized.epistemicStatus == null) normalized.epistemicStatus = "";
    if (normalized.epistemicStatusUpdatedAt == null) normalized.epistemicStatusUpdatedAt = 0;
    if (normalized.epistemicStatusActor == null) normalized.epistemicStatusActor = "";
    if (normalized.epistemicStatusReason == null) normalized.epistemicStatusReason = "";
    if (normalized.previousEpistemicStatus == null) normalized.previousEpistemicStatus = "";
    // Phase 2 — Bi-Temporal Memory. `0` = "no known bound in that direction",
    // never derived from createdAt/updatedAt (see lib/valid-time.js).
    if (normalized.validFrom == null) normalized.validFrom = 0;
    if (normalized.validUntil == null) normalized.validUntil = 0;
    if (!this.schemaFieldNames) return normalized;
    const filtered = {};
    for (const [key, value] of Object.entries(normalized)) {
      if (this.schemaFieldNames.has(key)) filtered[key] = value;
    }
    return filtered;
  }

  async init() {
    this._assertTrustedPath();
    if (this.initPromise) return this.initPromise;
    const generationPromise = (async () => {
      try {
        await this._drainPendingInitSettlements("retry");
        await this._drainPendingDebugSettlements();
        if (this.initCleanupErrors.length > 0) {
          throw new AggregateError(
            [...this.initCleanupErrors],
            `MemoryDB initialization blocked by prior cleanup failure for ${this.dbPath}`,
          );
        }
        this._assertTrustedPath();
        if (this.readOnly && this.secureDirectoryRequired && !this.directoryCapability) return false;
        if (this.readOnly && !this.secureDirectoryRequired && !existsSync(this.dbPath)) return false;
        const lancedb = this.lancedbProvider ? await this.lancedbProvider() : await getLanceDB();
        this._assertTrustedPath();
        this._beforeLancePathOperation("connect");
        const lancePath = this._lancePath();
        this.db = await this._acquireInitHandle(
          // Strong read consistency: without an interval a LanceDB table
          // object keeps the version it was opened with, so rows written
          // through another handle (memory_store in the gateway, another
          // process) stay invisible to it. On OpenClaw 2026.8.2 the gateway's
          // rem-dream reader missed three rows committed eight seconds
          // earlier for more than two minutes; a fresh process saw them
          // after 1.3 s. Zero checks the latest version on every read.
          lancedb.connect(lancePath, { readConsistencyInterval: 0 }),
          "MemoryDB.connect",
          "connection",
        );
      this._assertTrustedPath();
      const tables = await this._read(this.db.tableNames(), "MemoryDB.tableNames");
      if (tables.includes(TABLE_NAME)) {
        this._assertTrustedPath();
        this._beforeLancePathOperation("openTable");
        this.table = await this._acquireInitHandle(
          this.db.openTable(TABLE_NAME),
          "MemoryDB.openTable",
          "table",
        );
        this._assertTrustedPath();
        if (this.readOnly) {
          await this.refreshSchemaFields();
          return true;
        }
        // Migrate: add missing columns
        // Statt eines großen try/catch: Schema einmal lesen, dann pro Spalte
        // einzeln migrieren. So verhindert ein Fehler bei einer Spalte nicht
        // die Migration der übrigen.
        const schema = await this._read(this.table.schema(), "MemoryDB.schema");

        if (schema) {
          const textField = schema.fields?.find((field) => field.name === "text");
          if (!textField?.type) {
            throw new Error(`MemoryDB ownership migration failed: authoritative text field missing for ${this.dbPath}`);
          }
          const allColumns = [
            { name: 'summary', valueSql: "''" },
            { name: 'origin', valueSql: "'dm'" },
            { name: 'mergedFrom', valueSql: "'[]'" },
            { name: 'expiresAt', valueSql: '0' },
            { name: 'agentId', type: textField.type, valueSql: "''", securityCritical: true },
            { name: 'storedBy', valueSql: "''" },
            { name: 'sourceTurnId', valueSql: "''" },
            { name: 'sourceMessageRole', valueSql: "''" },
            { name: 'sourceTimestamp', valueSql: '0' },
            { name: 'sourceUrl', valueSql: "''" },
            { name: 'evidenceQuote', valueSql: "''" },
            { name: 'scope', valueSql: "'agent-private'" },
            { name: 'ownerUserId', valueSql: "''" },
            { name: 'type', valueSql: "'memory'" },
            { name: 'confirmed', valueSql: 'false' },
            { name: 'emotionalValence', valueSql: "''" },
            { name: 'emotionalIntensity', valueSql: '0.0' },
            { name: 'emotionalDominant', valueSql: "'neutral'" },
            { name: 'moodContextAtCapture', valueSql: "''" },
            // 7.12.22: Bestand gilt als fertig klassifiziert; nur neue Zeilen
            // aus dem entkoppelten Capture stehen auf pending_t3.
            { name: 'emotionStatus', valueSql: "'final'" },
            // Bestand gilt als geklaert; Phase 1 der Migration setzt ihn
            // ausdruecklich auf pending_backfill.
            { name: 'importanceStatus', valueSql: "'final'" },
            { name: 'replayCount', valueSql: '0' },
            { name: 'lastReplayed', valueSql: '0' },
            { name: 'retrievalCount', valueSql: '0' },
            { name: 'lastRetrievedAt', valueSql: '0' },
            { name: 'memoryStrength', valueSql: '1.0' },
            { name: 'halfLifeDays', valueSql: '30' },
            { name: 'lastStrengthenedAt', valueSql: '0' },
            { name: 'lastDynamicsAt', valueSql: '0' },
            { name: 'memoryClass', valueSql: "'standard'" },
            { name: 'neverForget', valueSql: '0' },
            { name: 'coreMemoryScore', valueSql: '0.0' },
            { name: 'coreMemoryReason', valueSql: "''" },
            { name: 'versionNumber', valueSql: '1' },
            { name: 'previousVersion', valueSql: "''" },
            { name: 'supersededBy', valueSql: "''" },
            { name: 'updateSource', valueSql: "''" },
            { name: 'updateEvidence', valueSql: "''" },
            { name: 'reconsolidationConfidence', valueSql: '0.0' },
            { name: 'status', valueSql: "'active'" },
            { name: 'versionCreatedAt', valueSql: '0' },
            { name: 'updatedAt', valueSql: '0' },
            { name: 'memoryKind', valueSql: "'memory'" },
            { name: 'reminderStatus', valueSql: "''" },
            { name: 'remindAt', valueSql: '0' },
            { name: 'remindedAt', valueSql: '0' },
            { name: 'dispatchedAt', valueSql: '0' },
            { name: 'acknowledgedAt', valueSql: '0' },
            { name: 'cancelledAt', valueSql: '0' },
            { name: 'reminderKey', valueSql: "''" },
            { name: 'dispatchCount', valueSql: '0' },
            { name: 'lastDispatchAttemptAt', valueSql: '0' },
            { name: 'nextDispatchAttemptAt', valueSql: '0' },
            { name: 'workspaceId', type: textField.type, valueSql: "''", securityCritical: true },
            { name: 'workspaceKey', valueSql: "''" },
            // Phase 1 — Explicit Trust State (epistemicStatus). See
            // lib/epistemic-status.js for the enum/matrix; absent/'' means
            // "legacy, resolves conservatively" (see plan §5), never "trusted".
            { name: 'epistemicStatus', valueSql: "''" },
            { name: 'epistemicStatusUpdatedAt', valueSql: '0' },
            { name: 'epistemicStatusActor', valueSql: "''" },
            { name: 'epistemicStatusReason', valueSql: "''" },
            { name: 'previousEpistemicStatus', valueSql: "''" },
            // Phase 2 — Bi-Temporal Memory (validFrom/validUntil). See
            // lib/valid-time.js for the semantics; `0` = "no known bound in
            // that direction", not the Unix epoch.
            { name: 'validFrom', valueSql: '0' },
            { name: 'validUntil', valueSql: '0' },
          ];

          for (const col of allColumns) {
            const hasCol = schema.fields.some(f => f.name === col.name);
            if (hasCol) continue;
            if (col.securityCritical) {
              const { securityCritical: _securityCritical, ...column } = col;
              await this._write(this.table.addColumns([column]), `MemoryDB.addColumns:${col.name}`);
              continue;
            }
            try {
              await this._write(this.table.addColumns([col]), `MemoryDB.addColumns:${col.name}`);
            } catch (e) {
              if (e instanceof TimeoutError) throw e;
              console.error(`[memory-lancedb-namespaced] migration error for column '${col.name}' in ${this.dbPath}: ${e.message}`);
            }
          }
        }
      } else if (this.readOnly) {
        const cleanupErrors = await this._closeHandles("read-only-missing-table");
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            cleanupErrors,
            `MemoryDB read-only missing-table cleanup failed for ${this.dbPath}`,
          );
        }
        return false;
      } else {
        this._assertTrustedPath();
        this._beforeLancePathOperation("createTable");
        this.table = await this._acquireInitHandle(this.db.createTable(TABLE_NAME, [
          {
            id: "__schema__",
            type: "memory",
            confirmed: false,
            text: "",
            summary: "",
            origin: "dm",
            vector: Array(this.vectorDim).fill(0),
            importance: 0,
            category: "other",
            createdAt: 0,
            mergedFrom: "[]",
            expiresAt: 0,
            agentId: "",
            storedBy: "",
            sourceTurnId: "",
            sourceMessageRole: "",
            sourceTimestamp: 0,
            sourceUrl: "",
            evidenceQuote: "",
            scope: "agent-private",
            ownerUserId: "",
            emotionalValence: "",
            emotionalIntensity: 0,
            emotionalDominant: "neutral",
            moodContextAtCapture: "",
            emotionStatus: "final",
            importanceStatus: "final",
            replayCount: 0,
            lastReplayed: 0,
            retrievalCount: 0,
            lastRetrievedAt: 0,
            memoryStrength: 1.0,
            halfLifeDays: 180,
            lastStrengthenedAt: 0,
            lastDynamicsAt: 0,
            memoryClass: "standard",
            neverForget: 0,
            coreMemoryScore: 0.0,
            coreMemoryReason: "",
            versionNumber: 1,
            previousVersion: "",
            supersededBy: "",
            updateSource: "",
            updateEvidence: "",
            reconsolidationConfidence: 0.0,
            status: "active",
            versionCreatedAt: 0,
            updatedAt: 0,
            workspaceId: "",
            workspaceKey: "",
            memoryKind: "memory",
            reminderStatus: "",
            remindAt: 0,
            remindedAt: 0,
            dispatchedAt: 0,
            acknowledgedAt: 0,
            cancelledAt: 0,
            reminderKey: "",
            dispatchCount: 0,
            lastDispatchAttemptAt: 0,
            nextDispatchAttemptAt: 0,
            // Phase 1 — Explicit Trust State (epistemicStatus). See
            // lib/epistemic-status.js for the enum/matrix; absent/'' means
            // "legacy, resolves conservatively" (see plan §5), never "trusted".
            epistemicStatus: "",
            epistemicStatusUpdatedAt: 0,
            epistemicStatusActor: "",
            epistemicStatusReason: "",
            previousEpistemicStatus: "",
            // Phase 2 — Bi-Temporal Memory (validFrom/validUntil). See
            // lib/valid-time.js for the semantics; `0` = "no known bound in
            // that direction", not the Unix epoch.
            validFrom: 0,
            validUntil: 0,
          },
        ]), "MemoryDB.createTable", "created-table", false);
      }
        if (!this.readOnly) {
          this._assertTrustedPath();
          // A prior process may have stopped after table creation but before
          // deleting the bootstrap row. Recovery is safe and idempotent.
          await this._write(this.table.delete('id = "__schema__"'), "MemoryDB.deleteSchemaRow");
        }
        await this.refreshSchemaFields();
      } catch (error) {
        if (this._deferTimedOutInitCleanup(error)) throw error;
        const cleanupErrors = await this._closeHandles("failed-init");
        if (cleanupErrors.length > 0) {
          throw new AggregateError(
            [error, ...cleanupErrors],
            `MemoryDB initialization and cleanup failed for ${this.dbPath}`,
          );
        }
        throw error;
      }
    })();
    this.initPromise = generationPromise;
    try {
      const initialized = await generationPromise;
      if (initialized === false && this.initPromise === generationPromise) {
        // A read-only namespace may legitimately appear after this non-mutating
        // probe. Keep concurrent callers coalesced for this generation, but do
        // not turn an absent table into a process-lifetime negative cache.
        this.initPromise = null;
      }
      return initialized;
    } catch (error) {
      if (this.initPromise === generationPromise) this.initPromise = null;
      throw error;
    }
  }

  async store(entry) {
    this._assertWritable("store");
    await this.init();
    const text = typeof entry?.text === "string" ? entry.text.trim() : "";
    const summary = typeof entry?.summary === "string" ? entry.summary.trim() : "";
    if (!text && !summary) {
      throw new Error("store() rejected: entry text and summary are both empty — refusing to store a memory without content.");
    }
    if (entry && (entry.epistemicStatus == null || entry.epistemicStatus === "")) {
      entry.epistemicStatus = coerceNewWriteEpistemicStatus(entry.epistemicStatus);
    }
    // Seit 7.12.70 fuehrt die Tabelle die Spalte chunkGroupId. Fehlt sie in
    // einer geschriebenen Zeile, weicht der Append vom Schema ab und LanceDB
    // lehnt ihn ab ("Append with different schema: missing=[chunkGroupId]") —
    // und zwar fuer JEDEN Schreiber, nicht nur fuer das Capture. Acht Stellen
    // bauen Zeilen aus expliziten Feldlisten; der Standardwert gehoert deshalb
    // hierher, an dieselbe Stelle, an der schon epistemicStatus nachgezogen
    // wird. Leer heisst "nicht aufgeteilt"; wer eine Gruppe hat, behaelt sie.
    if (entry && entry.chunkGroupId == null) entry.chunkGroupId = "";
    const { baseDbPath, agentId } = splitAgentDbPath(this.dbPath);
    const cutoffState = readEpistemicCutoff(baseDbPath);
    if (
      (cutoffState.reason === "cutoff_missing_after_upgrade" || cutoffState.reason === "cutoff_read_error")
      && entry.epistemicStatus === "observed"
    ) {
      entry.epistemicStatus = "untrusted";
    }
    const guard = assertCardWriteAllowed({
      baseDbPath,
      agentId: entry.agentId || entry.storedBy || agentId,
      text: text || summary,
      scope: entry.scope || "agent-private",
      workspaceIdentity: entry.workspaceId || entry.workspaceKey || "",
      ownerUserId: entry.ownerUserId || "",
    });
    if (!guard.allowed) {
      const error = new Error("tombstone_blocked");
      error.action = "tombstone_blocked";
      error.reason = "tombstone_blocked";
      throw error;
    }
    await this._write(this.table.add([this.normalizeEntryForTable(entry)]), "MemoryDB.store");
    this._writeCounter++;
    if (this._writeCounter % REINDEX_WRITE_THRESHOLD === 0) {
      this._maybeReindex().catch((err) => {
        this.logger?.warn?.(`memory-lancedb-namespaced: reindex scheduling failed: ${String(err)}`);
      });
    }
  }

  /**
   * Lädt die letzten N Memories für Graph-Edge-Building.
   * @param {Object} opts
   * @param {number} opts.limit — max Rows (default 100)
   * @param {string} [opts.sessionId] — optional Session-ID für temporal Filter
   * @param {boolean} [opts.includeGlobalRecent] — auch session-übergreifende laden
   * @param {string[]} [opts.fields] — Felder, die benötigt werden
   */
  /**
   * where-Klausel für den Graph-Scan, gebaut aus dem LIVE-Schema.
   *
   * Eine feste Klausel bricht, sobald eine referenzierte Spalte fehlt, und der
   * `catch` unten liefert dann stilles `[]` — `recentExisting` bliebe leer und
   * buildEdgesForSession verbände neue Erinnerungen nur untereinander, nie mit
   * dem Bestand. `epistemicStatus` fehlt auf allen produktiven Tabellen, bis das
   * Release die Spalte migriert; im readOnly-Modus wird die Migration ohnehin
   * übersprungen (siehe init).
   *
   * `epistemicStatus` zusätzlich NULL-sicher: `!= 'invalidated'` allein ist in
   * SQL dreiwertig und verwürfe Zeilen ohne gesetzten Wert.
   */
  _buildRecentGraphWhere() {
    const felder = this.schemaFieldNames;
    const hat = (name) => !felder || felder.size === 0 || felder.has(name);
    const teile = [];
    if (hat("memoryKind")) teile.push("(memoryKind = 'memory' OR memoryKind IS NULL OR memoryKind = '')");
    if (hat("status")) teile.push("(status IS NULL OR status = 'active' OR status = '')");
    if (hat("epistemicStatus")) teile.push("(epistemicStatus IS NULL OR epistemicStatus != 'invalidated')");
    return teile.length > 0 ? teile.join(" AND ") : "true";
  }

  async getRecentForGraph({ limit = 100, sessionId = "", includeGlobalRecent = true, fields = null } = {}) {
    await this.init();
    if (!this.table) return [];
    try {
      let rows = await this._read(
        this.table.query()
          .where(this._buildRecentGraphWhere())
          .limit(limit * 2)
          .toArray(),
        "MemoryDB.getRecentForGraph",
      );

      // Sort by createdAt DESC
      rows.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

      // If includeGlobalRecent: take top N regardless of session
      // If not: filter to same session first, fill rest with global
      if (sessionId && !includeGlobalRecent) {
        rows = rows.filter(r => r.sessionId === sessionId || r.sourceTurnId?.startsWith(sessionId));
      } else if (sessionId) {
        const sameSession = rows.filter(r => r.sessionId === sessionId || r.sourceTurnId?.startsWith(sessionId));
        const other = rows.filter(r => r.sessionId !== sessionId && !r.sourceTurnId?.startsWith(sessionId));
        rows = [...sameSession, ...other].slice(0, limit);
      }

      rows = rows.slice(0, limit);

      if (fields && Array.isArray(fields)) {
        return rows.map(r => {
          const obj = { id: r.id };
          for (const f of fields) {
            obj[f] = r[f];
          }
          return obj;
        });
      }
      return rows;
    } catch (e) {
      // Nicht stumm: ein leeres Ergebnis hier bedeutet, dass der Graph-Aufbau
      // keine Bestandserinnerungen sieht — das darf nicht unbemerkt bleiben.
      this.logger?.warn?.(`memory-lancedb-namespaced: getRecentForGraph failed for ${this.dbPath}: ${String(e?.message || e)}`);
      return [];
    }
  }

  async _maybeReindex() {
    this._assertWritable("reindex");
    this._assertTrustedPath();
    if (this._reindexing) return;
    // v6.2.1 — Zeitbasiertes Intervall enforce (P0-Fix)
    if (Date.now() - this._lastReindexAt < REINDEX_MIN_INTERVAL_MS) return;
    this._reindexing = true;
    try {
      const count = await this._read(this.table.countRows(), "MemoryDB.countRows");
      if (count < REINDEX_MIN_ROWS) return;
      const lance = await getLanceDB();
      await this._write(this.table.createIndex("vector", {
        config: lance.Index.hnswPq({ m: 16, efConstruction: 100, numSubVectors: 96 }),
        replace: true,
      }), "MemoryDB.createIndex");
      // v6.2.1 — Counter reset nach erfolgreichem Reindex (P0-Fix)
      this._writeCounter = 0;
      this._lastReindexAt = Date.now();
    } catch (err) {
      // Non-fatal: falls back to flat scan if reindex fails
      this.logger?.warn?.(`memory-lancedb-namespaced: reindex failed; falling back to flat scan: ${String(err)}`);
    } finally {
      this._reindexing = false;
    }
  }

  async search(vector, limit = 5, minScore = 0.3) {
    await this.init();
    const count = await this._read(this.table.countRows(), "MemoryDB.search.countRows");
    if (count === 0) return [];
    const results = await this.vectorSearchActive(vector, limit);
    const mapped = results.map((r) => ({
      entry: {
        id: r.id,
        type: r.type || "memory",
        confirmed: r.confirmed === true,
        text: r.text,
        summary: r.summary || "",
        origin: r.origin || "dm",
        category: r.category,
        importance: r.importance ?? 0.5,
        createdAt: r.createdAt,
        sourceUrl: r.sourceUrl || "",
        evidenceQuote: r.evidenceQuote || "",
        scope: r.scope || "agent-private",
        ownerUserId: r.ownerUserId || "",
        storedBy: r.storedBy || "",
        workspaceKey: r.workspaceKey || "",
        agentId: r.agentId || r.storedBy || "",
        workspaceId: r.workspaceId || r.workspaceKey || "",
        emotionalValence: deserializeEmotionalValence(r.emotionalValence),
        emotionalIntensity: r.emotionalIntensity ?? 0,
        emotionalDominant: r.emotionalDominant || "neutral",
        moodContextAtCapture: deserializeEmotionalValence(r.moodContextAtCapture),
        emotionStatus: r.emotionStatus || "final",
        replayCount: r.replayCount ?? 0,
        lastReplayed: r.lastReplayed ?? 0,
        retrievalCount: r.retrievalCount ?? 0,
        lastRetrievedAt: r.lastRetrievedAt ?? 0,
        memoryStrength: r.memoryStrength ?? 1.0,
        halfLifeDays: r.halfLifeDays ?? resolveHalfLifeDays(r.category, r.memoryClass, halfLifeOverrides),
        lastStrengthenedAt: r.lastStrengthenedAt ?? 0,
        lastDynamicsAt: r.lastDynamicsAt ?? 0,
        memoryClass: r.memoryClass || "standard",
        neverForget: r.neverForget ?? 0,
        coreMemoryScore: r.coreMemoryScore ?? 0.0,
        coreMemoryReason: r.coreMemoryReason || "",
        versionNumber: r.versionNumber ?? 1,
        previousVersion: r.previousVersion || "",
        supersededBy: r.supersededBy || "",
        updateSource: r.updateSource || "",
        updateEvidence: r.updateEvidence || "",
        reconsolidationConfidence: r.reconsolidationConfidence ?? 0.0,
        status: r.status || "active",
        versionCreatedAt: r.versionCreatedAt ?? 0,
        updatedAt: r.updatedAt ?? 0,
        memoryKind: r.memoryKind || "memory",
        reminderStatus: r.reminderStatus || "",
        remindAt: r.remindAt ?? 0,
        remindedAt: r.remindedAt ?? 0,
        dispatchedAt: r.dispatchedAt ?? 0,
        acknowledgedAt: r.acknowledgedAt ?? 0,
        cancelledAt: r.cancelledAt ?? 0,
        reminderKey: r.reminderKey || "",
        dispatchCount: r.dispatchCount ?? 0,
        lastDispatchAttemptAt: r.lastDispatchAttemptAt ?? 0,
        nextDispatchAttemptAt: r.nextDispatchAttemptAt ?? 0,
        epistemicStatus: r.epistemicStatus || "",
      },
      score: distanceToScore(r._distance),
    }));
    return mapped.filter((r) => r.score >= minScore);
  }

  async findSimilar(vector, text, threshold = 0.95) {
    await this.init();
    const count = await this._read(this.table.countRows(), "MemoryDB.findSimilar.countRows");
    if (count === 0) return [];
    const results = await this.vectorSearchActive(vector, 10);
    return results
      .filter((r) => {
        const score = distanceToScore(r._distance);
        return score >= threshold || r.text === text;
      })
      .map((r) => ({ entry: r, score: distanceToScore(r._distance) }));
  }

  async findMergeCandidate(vector, mergeThreshold, duplicateThreshold) {
    await this.init();
    const count = await this._read(this.table.countRows(), "MemoryDB.findMergeCandidate.countRows");
    if (count === 0) return null;
    const results = await this.vectorSearchActive(vector, 5);
    const candidates = results
      .map(r => ({
        entry: {
          id: r.id,
          text: r.text,
          importance: r.importance ?? 0.5,
          agentId: r.agentId || "",
          storedBy: r.storedBy || "",
          workspaceId: r.workspaceId || "",
          workspaceKey: r.workspaceKey || "",
          scope: r.scope || "agent-private",
          ownerUserId: r.ownerUserId || "",
          epistemicStatus: r.epistemicStatus || "",
          epistemicStatusActor: r.epistemicStatusActor || "",
          epistemicStatusReason: r.epistemicStatusReason || "",
          epistemicStatusUpdatedAt: r.epistemicStatusUpdatedAt ?? 0,
          previousEpistemicStatus: r.previousEpistemicStatus || "",
          validFrom: r.validFrom ?? 0,
          validUntil: r.validUntil ?? 0,
        },
        score: distanceToScore(r._distance),
      }))
      .filter(r => r.score >= mergeThreshold && r.score < duplicateThreshold)
      .sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }

  async vectorSearchActive(vector, limit) {
    this._assertTrustedPath();
    const fetchLimit = Math.max(limit, Math.min(limit * 3, 100));
    try {
      const builder = this.table.vectorSearch(vector);
      if (typeof builder.where === "function") {
        // (status = 'active' OR status IS NULL) parenthesized on its own —
        // AND binds tighter than OR in SQL, so appending the epistemicStatus
        // clause unparenthesized here would let an invalidated row with
        // status='active' through.
        return await this._read(builder.where("(status = 'active' OR status IS NULL) AND epistemicStatus != 'invalidated'").limit(limit).toArray(), "MemoryDB.vectorSearchActive");
      }
    } catch (err) {
      // Older LanceDB/query-builder surfaces and old schemas fall back here.
      // Timeouts must not be swallowed by the fallback path.
      if (err instanceof TimeoutError) throw err;
    }
    const rows = await this._read(this.table.vectorSearch(vector).limit(fetchLimit).toArray(), "MemoryDB.vectorSearchActive.fallback");
    return rows.filter((row) => (!row.status || row.status === "active") && row.epistemicStatus !== "invalidated").slice(0, limit);
  }

  /**
   * Audit-Recovery-Suche: findet bereits soft-deleted Zeilen (status="deleted").
   * Nur für die Idempotenz-/Audit-Recovery des memory_forget-Query-Pfads gedacht —
   * normale Suche verwendet ausschließlich vectorSearchActive. Bewertet
   * `_distance` exakt wie `search()` und filtert nach `minScore`. Liefert nur
   * IDs + Score, niemals Klartext gelöschter Inhalte.
   */
  async searchDeleted(vector, limit, minScore = 0.3) {
    this._assertTrustedPath();
    await this.init();
    const count = await this._read(this.table.countRows(), "MemoryDB.searchDeleted.countRows");
    if (count === 0) return [];
    const fetchLimit = Math.max(limit, Math.min(limit * 3, 100));
    let rows = null;
    try {
      const builder = this.table.vectorSearch(vector);
      if (typeof builder.where === "function") {
        rows = await this._read(builder.where("status = 'deleted'").limit(limit).toArray(), "MemoryDB.searchDeleted");
      }
    } catch (err) {
      if (err instanceof TimeoutError) throw err;
    }
    if (rows === null) {
      rows = await this._read(this.table.vectorSearch(vector).limit(fetchLimit).toArray(), "MemoryDB.searchDeleted.fallback");
    }
    return (rows || [])
      .filter((row) => row.status === "deleted")
      .map((row) => ({ id: row.id, score: distanceToScore(row._distance) }))
      .filter((r) => r.score >= minScore)
      .slice(0, limit);
  }

  async delete(id) {
    this._assertWritable("delete");
    await this.init();
    // safeUuid wirft Error wenn id nicht exakt UUID-Format hat
    const safe = safeUuid(id);
    await this._write(this.table.delete(`id = "${safe}"`), `MemoryDB.delete:${safe}`);
  }

  /**
   * Kanonischer Tombstone-Vorgang (soft-delete statt physischer Löschung).
   * Setzt `status="deleted"` und `epistemicStatus="invalidated"`; die Zeile
   * bleibt erhalten (Fingerprint/Audit), ist aber aus Active-Scans ausgeschlossen.
   *
   * @param {string} id
   * @param {object} [patch] zusätzliche Spaltenwerte
   * @returns {Promise<{ok: boolean, id: string, alreadyTombstoned?: boolean, notFound?: boolean}>}
   */
  async tombstone(id, patch = {}) {
    this._assertWritable("tombstone");
    await this.init();
    const safe = safeUuid(id);
    const rows = await this._read(this.table.query().where(`id = "${safe}"`).limit(1).toArray(), `MemoryDB.tombstone.query:${safe}`);
    if (!rows || rows.length === 0) {
      return { ok: false, notFound: true, id: safe };
    }
    if (String(rows[0].status || "") === "deleted") {
      return { ok: true, alreadyTombstoned: true, id: safe };
    }
    const values = { ...(patch || {}) };
    values.status = safeStatus("deleted");
    values.epistemicStatus = "invalidated";
    await this._write(this.table.update({ where: `id = "${safe}"`, values }), `MemoryDB.tombstone:${safe}`);
    return { ok: true, id: safe };
  }

  async getById(id) {
    await this.init();
    const safe = safeUuid(id);
    const rows = await this._read(this.table.query().where(`id = "${safe}"`).limit(1).toArray(), `MemoryDB.getById:${safe}`);
    return rows && rows.length > 0 ? rows[0] : null;
  }

  async update(id, patch) {
    this._assertWritable("update");
    await this.init();
    const safe = safeUuid(id);
    const rows = await this._read(this.table.query().where(`id = "${safe}"`).limit(1).toArray(), `MemoryDB.update.query:${safe}`);
    if (!rows || rows.length === 0) {
      throw new Error(`Memory not found: ${id}`);
    }
    const existing = rows[0];
    const patchObject = patch && typeof patch === "object" ? patch : {};
    if (isContentChangingUpdate(existing, patchObject)) {
      const { baseDbPath, agentId } = splitAgentDbPath(this.dbPath);
      const nextText = Object.hasOwn(patchObject, "text") ? patchObject.text : existing.text;
      const guard = assertCardWriteAllowed({
        baseDbPath,
        agentId: existing.agentId || existing.storedBy || agentId,
        text: nextText || patchObject.summary || existing.summary || "",
        scope: existing.scope || "agent-private",
        workspaceIdentity: existing.workspaceId || existing.workspaceKey || "",
        ownerUserId: existing.ownerUserId || "",
      });
      if (!guard.allowed) {
        const error = new Error("tombstone_blocked");
        error.action = "tombstone_blocked";
        error.reason = "tombstone_blocked";
        throw error;
      }
    }
    // Statusvalidierung: unbekannte Statuswerte dürfen nie gespeichert werden.
    if (Object.hasOwn(patchObject, "status") && patchObject.status !== "") {
      patchObject.status = safeStatus(patchObject.status);
    }
    const schemaFields = this.schemaFieldNames || new Set(Object.keys(existing));
    if (typeof this.table.update === "function") {
      const values = {};
      for (const [key, value] of Object.entries(patchObject)) {
        if (key === "id" || !schemaFields.has(key)) continue;
        values[key] = key === "vector" ? normalizeVectorValue(value) : value;
      }
      if (Object.keys(values).length > 0) {
        await this._write(
          this.table.update({ where: `id = "${safe}"`, values }),
          `MemoryDB.update.inPlace:${safe}`,
        );
      }
      return;
    }

    const updated = { ...existing, ...patchObject, id: existing.id };
    const normalizedUpdated = this.normalizeEntryForTable(updated);
    await this._write(this.table.delete(`id = "${safe}"`), `MemoryDB.update.delete:${safe}`);
    try {
      await this._write(this.table.add([normalizedUpdated]), `MemoryDB.update.add:${safe}`);
    } catch (addErr) {
      // delete+add ist nicht atomar — wenn das add fehlschlägt, würde die Row
      // verloren gehen. Best-effort: das Original wiederherstellen, dann den
      // Fehler weiterreichen.
      try {
        await this._write(this.table.add([this.normalizeEntryForTable(existing)]), `MemoryDB.update.restore:${safe}`);
      } catch (restoreErr) {
        this.logger?.warn?.(
          `memory-lancedb-namespaced: MemoryDB.update restore failed dbPath=${this.dbPath} id=${safe}: ${String(restoreErr)}`,
        );
        throw new AggregateError(
          [addErr, restoreErr],
          `MemoryDB.update replacement and restore failed for ${safe} at ${this.dbPath}`,
        );
      }
      throw addErr;
    }
  }

  normalizeActiveScanRow(r) {
    return {
      id: r.id,
      type: r.type || "memory",
      vector: (Array.isArray(r.vector) && r.vector.length > 0) ? r.vector : null,
      text: r.text || "",
      summary: r.summary || "",
      category: r.category || "",
      importance: r.importance ?? 0.5,
      createdAt: r.createdAt || "",
      scope: r.scope || "agent-private",
      agentId: r.agentId || "",
      storedBy: r.storedBy || "",
      workspaceId: r.workspaceId || "",
      workspaceKey: r.workspaceKey || "",
      memoryKind: r.memoryKind ?? "memory",
      ownerUserId: r.ownerUserId || "",
      status: r.status || "active",
      updatedAt: r.updatedAt ?? 0,
      versionCreatedAt: r.versionCreatedAt ?? 0,
      sourceTimestamp: r.sourceTimestamp ?? 0,
      // Carry protection flags so GC can honor the neverForget/core contract.
      neverForget: r.neverForget,
      memoryClass: r.memoryClass,
    };
  }

  // Scan-Spalten sind für Active- und Collectable-Scan identisch.
  _buildScanQuery(statusWhere) {
    this._assertTrustedPath();
    let query = this.table.query().where(statusWhere);
    if (typeof query.select === "function") {
      query = query.select([
        "id", "type", "vector", "text", "summary", "category", "importance", "createdAt",
        "scope", "agentId", "storedBy", "workspaceId", "workspaceKey", "memoryKind", "ownerUserId", "status",
        "updatedAt", "versionCreatedAt", "sourceTimestamp", "neverForget", "memoryClass",
      ]);
    }
    return query;
  }

  buildActiveScanQuery() {
    // Fail-closed Whitelist: NUR "active" (oder legacy NULL/leer) gilt als aktiv.
    // Ein unbekannter/falsch geschriebener Status (z. B. "archvied") wird NICHT
    // als aktiv interpretiert. (Vorher: Negativliste != deleted/archived, die
    // jeden Tippfehler als aktiv durchließ.)
    //
    // `superseded` ist hier bewusst NICHT enthalten: Recall, Shared Search und
    // die Vault-Notizen sollen keine überholten Fassungen sehen. Der GC braucht
    // sie trotzdem — dafür gibt es buildCollectableScanQuery().
    return this._buildScanQuery("status IS NULL OR status = 'active' OR status = ''");
  }

  /**
   * Scan für die Garbage Collection: alles, was noch Platz belegt und noch nicht
   * archiviert oder getombsteint ist — also zusätzlich `superseded`.
   *
   * Muss mit der Sammelbarkeits-Definition in lib/garbage-collector.js
   * (alles außer "archived"/"deleted") übereinstimmen. Seit Forget nur noch
   * soft-deleted, ist dies der einzige Pfad, über den überholte Fassungen
   * überhaupt noch Archivkandidaten werden können.
   */
  buildCollectableScanQuery() {
    return this._buildScanQuery("status IS NULL OR status = 'active' OR status = '' OR status = 'superseded'");
  }

  async *_scanBatches(buildQuery, label, options = {}) {
    await this.init();
    const batchSize = Math.max(1, Math.min(Number(options.batchSize || 500), 5000));
    let offset = 0;
    while (true) {
      let query = buildQuery().limit(batchSize);
      if (offset > 0) {
        if (typeof query.offset !== "function") break;
        query = query.offset(offset);
      }
      const rows = await this._read(
        query.toArray({ maxBatchLength: batchSize }),
        `${label}:${offset}`,
      );
      if (!rows || rows.length === 0) break;
      yield rows.map((r) => this.normalizeActiveScanRow(r));
      if (rows.length < batchSize) break;
      offset += rows.length;
    }
  }

  async *scanActiveBatches(options = {}) {
    yield* this._scanBatches(() => this.buildActiveScanQuery(), "MemoryDB.scanActiveBatches", options);
  }

  async *scanCollectableBatches(options = {}) {
    yield* this._scanBatches(() => this.buildCollectableScanQuery(), "MemoryDB.scanCollectableBatches", options);
  }

  async scanActive(options = {}) {
    const rows = [];
    for await (const batch of this.scanActiveBatches(options)) {
      rows.push(...batch);
    }
    return rows;
  }

  async scanCollectable(options = {}) {
    const rows = [];
    for await (const batch of this.scanCollectableBatches(options)) {
      rows.push(...batch);
    }
    return rows;
  }

  async purgeExpired() {
    this._assertWritable("purgeExpired");
    await this.init();
    const now = safeTimestamp(Date.now());
    const protectedWhere = "(neverForget IS NULL OR neverForget = 0) AND (memoryClass IS NULL OR memoryClass != 'core')";
    await this._write(this.table.delete(`expiresAt > 0 AND expiresAt < ${now} AND ${protectedWhere}`), "MemoryDB.purgeExpired");
  }

  /**
   * Hot-path wrapper that skips purgeExpired() if it ran for this DB recently.
   * Used by before_prompt_build; explicit/admin calls still use purgeExpired().
   */
  purgeExpiredThrottled(logger) {
    this._assertWritable("purgeExpiredThrottled");
    const last = purgeThrottleMap.get(this.dbPath);
    if (last && Date.now() - last < PURGE_THROTTLE_MS) {
      return Promise.resolve();
    }
    purgeThrottleMap.set(this.dbPath, Date.now());
    return this.purgeExpired().catch((e) => {
      logger?.warn?.(`memory-lancedb-namespaced: purgeExpired failed: ${String(e)}`);
    });
  }
}

function pathEntryExists(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
    throw error;
  }
}

function deriveExpectedCanonicalTarget(path) {
  const missingParts = [];
  const absolutePath = resolve(path);
  let existingAncestor = absolutePath;
  while (!pathEntryExists(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) throw new Error(`No existing ancestor for DB path: ${path}`);
    missingParts.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  const canonicalAncestor = realpathSync(existingAncestor);
  return {
    absolutePath,
    expectedTarget: missingParts.length > 0
      ? resolveInside(canonicalAncestor, ...missingParts)
      : canonicalAncestor,
  };
}

/**
 * Applies an epistemic-status transition to a LanceDB memory row.
 *
 * Thin persistence adapter — the actual matrix/actor-tier/authorization
 * validation lives in transitionEpistemicStatus() (lib/epistemic-status.js).
 * This function only: (1) enforces the same fail-closed checkAccess() gate
 * every other memory mutation goes through, (2) persists via the existing
 * MemoryDB.update() in-place patch mechanism, (3) writes the existing
 * destructive-op audit log — no new authorization surface, no new audit file.
 *
 * @param {object} db MemoryDB instance (getById()/update()).
 * @param {string} id memory id
 * @param {string} nextStatus target epistemicStatus
 * @param {{ctx: object, actor: string, actorTier?: string, reason?: string, evidence?: string, authorized?: boolean, workspaceDir?: string, now?: number}} opts
 * @returns {Promise<{ok: boolean, patch?: object, reason?: string}>}
 */
export async function applyEpistemicStatusToLanceDb(db, id, nextStatus, opts = {}) {
  const record = await db.getById(id);
  if (!record) return { ok: false, reason: "not_found" };
  const acl = checkAccess(opts.ctx, record);
  if (!acl.allowed) return { ok: false, reason: acl.reason };
  const patch = transitionEpistemicStatus(record, nextStatus, opts);
  // Log before mutating, not after. appendDestructiveOpLog is synchronous
  // and swallows its own errors (lib/sql-safety.js), so this ordering costs
  // nothing on the happy path. It matters on the unhappy path: if the
  // process dies between the two calls, "log written, mutation never
  // happened" is audit noise (a stray line describing an attempt), while
  // "mutation happened, log never written" is a silent, unaudited trust
  // change — worse for a feature whose purpose is to make trust changes
  // legible. This is a narrower, simpler ordering choice than
  // deleteWithAuditContinuation's late-settlement machinery, which is not
  // replicated here (out of scope, see plan §9).
  appendDestructiveOpLog(opts.workspaceDir, {
    operation: "trust_transition",
    memoryId: id,
    previousEpistemicStatus: patch.previousEpistemicStatus,
    newEpistemicStatus: patch.epistemicStatus,
    actor: patch.epistemicStatusActor,
    reason: patch.epistemicStatusReason,
    evidence: opts.evidence || "",
    agentId: opts.ctx?.agentId || null,
    userPrincipal: opts.ctx?.userPrincipal || null,
    timestamp: new Date().toISOString(),
  });
  await db.update(id, patch);
  return { ok: true, patch };
}

/**
 * Closes an existing memory row's validity window (Phase 2 — Bi-Temporal
 * Memory) with a real, asserted boundary — NOT a version-chain edit (see
 * plan §0/§7a): "Firma A" stays `status: "active"`, only its `validUntil`
 * is set. Mirrors applyEpistemicStatusToLanceDb()'s structure exactly: same
 * fail-closed checkAccess() gate, same in-place MemoryDB.update() patch
 * mechanism, same destructive-op audit log (no new audit file).
 *
 * @param {object} db MemoryDB instance (getById()/update()).
 * @param {string} id memory id
 * @param {*} validUntil caller-asserted end-of-validity boundary (ISO date/ms/etc.)
 * @param {{ctx: object, actor: string, reason?: string, workspaceDir?: string, now?: number}} opts
 * @returns {Promise<{ok: boolean, patch?: object, reason?: string}>}
 */
export async function applyValidTimeCloseToLanceDb(db, id, validUntil, opts = {}) {
  const safeId = safeUuid(id);
  const record = await db.getById(safeId);
  if (!record) return { ok: false, reason: "not_found" };
  const acl = checkAccess(opts.ctx, record);
  if (!acl.allowed) return { ok: false, reason: acl.reason };
  const patch = buildValidTimeClosePatch(record, {
    validUntil,
    actor: opts.actor,
    reason: opts.reason,
    now: opts.now,
  });
  appendDestructiveOpLog(opts.workspaceDir, {
    operation: "validity_close",
    memoryId: safeId,
    previousValidUntil: Number(record.validUntil || 0),
    newValidUntil: patch.validUntil,
    actor: opts.actor,
    reason: opts.reason || "",
    agentId: opts.ctx?.agentId || null,
    userPrincipal: opts.ctx?.userPrincipal || null,
    timestamp: new Date().toISOString(),
  });
  await db.update(safeId, patch);
  return { ok: true, patch };
}

/**
 * Maps a canonical memory request ctx onto the requester shape
 * isNeoRecordAccessible() expects. Same field-precedence style as the
 * plugin-internal neoRequester(ctx, event) helper (workspaceKey preferred
 * over a bare workspaceId; this module-level function has no access to
 * that closure, so the mapping is duplicated rather than shared) — but NOT
 * an exact copy: this accepts the canonical memory-request-context shape
 * (ctx.workspaceIdentity, ctx.userPrincipal) that checkAccess() and
 * applyEpistemicStatusToLanceDb() already use, since that is the ctx shape
 * a symmetric caller of this function's LanceDB sibling would pass, not
 * the narrower ctx+event shape neoRequester() is tuned for.
 *
 * @param {object} [ctx]
 * @returns {{requesterAgentId: string, requesterWorkspaceKey: string, requesterOwnerId: string}}
 */
function deriveNeoRequesterFromCtx(ctx = {}) {
  return {
    requesterAgentId: typeof ctx?.agentId === "string" ? ctx.agentId.trim() : "",
    requesterWorkspaceKey: [ctx?.workspaceKey, ctx?.workspaceIdentity, ctx?.workspaceId]
      .find((value) => typeof value === "string" && value.trim()) || "",
    requesterOwnerId: [ctx?.ownerId, ctx?.userPrincipal, ctx?.userId]
      .find((value) => typeof value === "string" && value.trim()) || "",
  };
}

/**
 * Applies an epistemic-status transition to a NEO record (candidate or
 * behavior card), persisted the same way transitionRecordStatus() results
 * already are — an append to the NEO store's candidates/behavior-cards log.
 *
 * Fail-closed like its LanceDB sibling applyEpistemicStatusToLanceDb(): NEO
 * records use their own scope model (visibility.scope / origin.scope +
 * isNeoRecordAccessible()), not checkAccess(), so this calls that instead.
 * This function is not wired into any command handler yet (see plan §11/
 * final report) — the gate exists anyway, on the same "no unauthorized
 * mutation API, wired or not" principle as every other mutation path in
 * this file.
 *
 * @param {object} store NEO store (appendCandidates()/appendBehaviorCards()/appendEmbeddingQueue()).
 * @param {object} item current NEO record.
 * @param {string} nextStatus target epistemicStatus.
 * @param {{ctx?: object, actor: string, actorTier?: string, reason?: string, evidence?: string, authorized?: boolean, now?: number, isBehaviorCard?: boolean}} opts
 * @returns {{ok: boolean, updated?: object, reason?: string}}
 */
export function applyEpistemicStatusToNeo(store, item, nextStatus, opts = {}) {
  const requester = deriveNeoRequesterFromCtx(opts.ctx);
  if (!isNeoRecordAccessible(item, requester)) {
    return { ok: false, reason: "acl.denied" };
  }
  const patch = transitionEpistemicStatus(item, nextStatus, opts);
  const updated = { ...item, ...patch };
  if (opts.isBehaviorCard) {
    store.appendBehaviorCards([updated]);
  } else {
    store.appendCandidates([updated]);
  }
  store.appendEmbeddingQueue?.([updated]);
  return { ok: true, updated };
}

/** Per-agent MemoryDB cache with callback-scoped operation leases. */
export class AgentDbPool {
  /**
   * @param {string} basePath Validated namespace base path.
   * @param {number} vectorDim Vector dimension.
   * @param {object} [logger] Optional logger.
   * @param {{readOnly?: boolean, pathGuard?: (() => void), secureRouting?: boolean, parentDirectoryCapability?: object|null, baseSegment?: string|null}} [options] Non-mutating mode and optional descriptor-bound namespace route.
   */
  constructor(basePath, vectorDim, logger = null, {
    readOnly = false,
    pathGuard = null,
    secureRouting = null,
    parentDirectoryCapability = null,
    baseSegment = null,
  } = {}) {
    if (pathGuard !== null && typeof pathGuard !== "function") {
      throw new TypeError("AgentDbPool pathGuard must be a function");
    }
    const parentRouted = parentDirectoryCapability !== null || baseSegment !== null;
    const stableRouting = secureRouting === true
      || (secureRouting !== false && stableDirectoryCapabilitiesSupported());
    if (parentRouted && !stableRouting) {
      throw new Error("explicit named namespace routing requires stable directory capabilities");
    }
    if (parentRouted && (
      !parentDirectoryCapability
      || typeof parentDirectoryCapability.openChild !== "function"
      || typeof parentDirectoryCapability.childMatches !== "function"
    )) {
      throw new TypeError("secure AgentDbPool routing requires a parent directory capability");
    }
    if (parentRouted && (typeof baseSegment !== "string" || !baseSegment)) {
      throw new TypeError("secure AgentDbPool routing requires a base segment");
    }
    pathGuard?.();
    const basePin = deriveExpectedCanonicalTarget(basePath);
    this.basePath = basePin.absolutePath;
    this.canonicalBasePath = basePin.expectedTarget;
    this.vectorDim = vectorDim;
    this.logger = logger;
    this.readOnly = readOnly === true;
    this.pathGuard = pathGuard;
    this.secureRouting = stableRouting;
    this.parentRouted = parentRouted;
    this.parentDirectoryCapability = parentDirectoryCapability;
    this.baseSegment = baseSegment;
    this.baseDirectoryCapability = null;
    this.agentPathPins = new Map();
    this.backgroundLifecycleErrors = [];
    this.backgroundLifecycleErrorOverflow = 0;
    if (this.secureRouting && this.parentRouted) {
      try {
        this.baseDirectoryCapability = this.parentDirectoryCapability.openChild(
          this.baseSegment,
          { create: !this.readOnly },
        );
      } catch (error) {
        if (!(this.readOnly && (error?.code === "ENOENT" || error?.code === "ENOTDIR"))) throw error;
      }
    }
    this.dbs = makeBoundedCache(50, async (id, db) => {
      if (db && typeof db.shutdown === "function") {
        try {
          await db.shutdown();
        } catch (error) {
          const contextual = this._contextualizeDbError(id, "eviction", error);
          const loggingError = await this._warnLifecycle(id, "eviction", contextual);
          if (loggingError) {
            throw new AggregateError(
              [contextual, loggingError],
              `agent=${id} eviction and warning delivery failed`,
            );
          }
          throw contextual;
        }
      }
    });
    this.activeOperations = new Set();
    this.clearPromise = null;
    this.shutdownPromise = null;
    this.isShutdown = false;
  }

  _contextualizeDbError(agentId, phase, error) {
    const safeMessage = redactError(error).message;
    const contextual = new Error(
      `agent=${agentId} ${phase} failed: ${safeMessage}`,
      { cause: error },
    );
    contextual.agentId = agentId;
    contextual.phase = phase;
    return contextual;
  }

  async _warnLifecycle(agentId, phase, error) {
    const warning = trySafeWarn(
      this.logger,
      `memory-lancedb-namespaced agent=${agentId} phase=${phase}`,
      error,
      { agentId, phase },
    );
    const outcome = await settleSafeWarning(warning);
    return outcome.ok
      ? null
      : this._contextualizeDbError(agentId, `${phase}-warning`, outcome.error);
  }

  _recordBackgroundLifecycleError(error) {
    const normalized = this._contextualizeDbError("pool", "background-lifecycle", error);
    if (this.backgroundLifecycleErrors.length < MAX_BACKGROUND_LIFECYCLE_ERRORS) {
      this.backgroundLifecycleErrors.push(normalized);
      return;
    }
    this.backgroundLifecycleErrorOverflow += 1;
  }

  _drainBackgroundLifecycleErrors() {
    const errors = this.backgroundLifecycleErrors.splice(0, this.backgroundLifecycleErrors.length);
    if (this.backgroundLifecycleErrorOverflow > 0) {
      const overflow = new Error(
        `agent DB pool background lifecycle failures omitted (${this.backgroundLifecycleErrorOverflow})`,
      );
      overflow.phase = "background-lifecycle-overflow";
      errors.push(overflow);
      this.backgroundLifecycleErrorOverflow = 0;
    }
    return errors;
  }

  _getOrCreateDb(id) {
    const cached = this.dbs.get(id);
    if (cached) {
      if (this.secureRouting) this._assertSecureAgentCapability(id, cached.directoryCapability);
      else this._resolveAgentPath(id);
      return cached;
    }
    const dbPath = resolve(this.canonicalBasePath, id);
    let directoryCapability = null;
    if (this.secureRouting) {
      const baseExists = this._assertBasePath({ create: !this.readOnly });
      if (baseExists) {
        try {
          directoryCapability = this.baseDirectoryCapability.openChild(id, { create: !this.readOnly });
        } catch (error) {
          if (!this.readOnly && (error?.code === "ELOOP" || error?.code === "ENOTDIR")) {
            throw new Error(`Path traversal blocked: ${dbPath}`, { cause: error });
          }
          if (!(this.readOnly && (error?.code === "ENOENT" || error?.code === "ENOTDIR"))) throw error;
        }
      }
    } else {
      this._resolveAgentPath(id);
    }
    let db;
    try {
      db = new MemoryDB(dbPath, this.vectorDim, this.logger, {
        readOnly: this.readOnly,
        pathGuard: this.secureRouting
          ? () => this._assertSecureAgentCapability(id, directoryCapability)
          : () => this._assertAgentPath(id),
        directoryCapability,
        secureDirectoryRequired: this.secureRouting,
        beforeLanceOperation: this.secureRouting
          ? (operation, capability) => this._onBeforeAgentLanceOperation(id, operation, capability)
          : null,
      });
      if (!(this.secureRouting && this.readOnly && !directoryCapability)) {
        this.dbs.set(id, db);
      }
    } catch (error) {
      directoryCapability?.close();
      throw error;
    }
    return db;
  }

  _onBeforeAgentLanceOperation(_id, _operation, _capability) {}

  _assertSecureAgentCapability(id, capability) {
    const baseExists = this._assertBasePath({ create: !this.readOnly });
    if (!capability) {
      if (!this.readOnly) {
        throw new Error(`agent DB directory capability is missing: ${id}`);
      }
      return false;
    }
    if (!baseExists || !this.baseDirectoryCapability.childMatches(id, capability)) {
      throw new Error(`agent DB linked identity changed after initialization: ${id}`);
    }
    return true;
  }

  _assertBasePath({ create = false } = {}) {
    this.pathGuard?.();
    if (this.secureRouting) {
      if (!this.parentRouted) {
        const configuredBaseExists = pathEntryExists(this.basePath);
        if (!configuredBaseExists && !create) {
          if (this.baseDirectoryCapability) {
            throw new Error(`DB base linked identity changed after initialization: ${this.basePath}`);
          }
          return false;
        }
        if (!configuredBaseExists) {
          const beforeCreate = deriveExpectedCanonicalTarget(this.basePath);
          if (beforeCreate.expectedTarget !== this.canonicalBasePath) {
            throw new Error("DB base canonical target changed before creation");
          }
        }
        if (!this.baseDirectoryCapability) {
          this.baseDirectoryCapability = openDirectoryCapability(this.canonicalBasePath, { create });
        }
        const configuredTarget = realpathSync(this.basePath);
        const baseMatches = configuredTarget === this.canonicalBasePath
          && pathMatchesDirectoryCapability(this.canonicalBasePath, this.baseDirectoryCapability);
        if (!baseMatches) {
          throw new Error(`DB base linked identity changed after initialization: ${this.basePath}`);
        }
        this.pathGuard?.();
        return true;
      }
      if (!this.baseDirectoryCapability) {
        try {
          this.baseDirectoryCapability = this.parentDirectoryCapability.openChild(this.baseSegment, { create });
        } catch (error) {
          if (!create && (error?.code === "ENOENT" || error?.code === "ENOTDIR")) return false;
          throw error;
        }
      }
      const baseMatches = this.parentDirectoryCapability.childMatches(this.baseSegment, this.baseDirectoryCapability);
      if (!baseMatches) {
        throw new Error(`DB base linked identity changed after initialization: ${this.baseSegment ?? this.basePath}`);
      }
      this.pathGuard?.();
      return true;
    }
    const entryExists = pathEntryExists(this.basePath);
    if (!entryExists) {
      if (!create) return false;
      const beforeCreate = deriveExpectedCanonicalTarget(this.basePath);
      if (beforeCreate.expectedTarget !== this.canonicalBasePath) {
        throw new Error("DB base canonical target changed before creation");
      }
      // Create at the pinned canonical target; lexical ancestor substitution
      // cannot redirect this mkdir to a different tree.
      mkdirSync(this.canonicalBasePath, { recursive: true });
    }
    const currentTarget = realpathSync(this.basePath);
    if (currentTarget !== this.canonicalBasePath) {
      throw new Error("DB base canonical target changed after initialization");
    }
    this.pathGuard?.();
    return true;
  }

  _assertAgentPath(id) {
    const baseExists = this._assertBasePath({ create: !this.readOnly });
    const configuredPath = resolve(this.canonicalBasePath, id);
    let pin = this.agentPathPins.get(id);
    if (!pin) {
      const existed = baseExists && pathEntryExists(configuredPath);
      const canonicalTarget = existed
        ? resolveInside(this.canonicalBasePath, id)
        : configuredPath;
      pin = Object.freeze({ configuredPath, canonicalTarget, existed });
      this.agentPathPins.set(id, pin);
    }
    const entryExists = baseExists && pathEntryExists(pin.configuredPath);
    if (!entryExists) {
      if (pin.existed) throw new Error(`agent DB canonical target changed: ${id} is now missing`);
      return pin.canonicalTarget;
    }
    const currentTarget = resolveInside(this.canonicalBasePath, id);
    if (currentTarget !== pin.canonicalTarget) {
      throw new Error(`agent DB canonical target changed after initialization: ${id}`);
    }
    return pin.canonicalTarget;
  }

  _resolveAgentPath(id) {
    return this._assertAgentPath(id);
  }

  /** Compatibility accessor; production operations must prefer withDb(). */
  getDb(agentId) {
    if (this.isShutdown) throw new Error("AgentDbPool is shutdown");
    if (this.clearPromise) throw new Error("AgentDbPool is clearing; use withDb() after clear settles");
    const id = safeAgentId(agentId || "default");
    return this._getOrCreateDb(id);
  }

  /**
   * Lease an agent DB until the callback settles.
   * @param {string} agentId Agent identity used for path and cache isolation.
   * @param {(db: MemoryDB) => unknown} fn Operation to run while the DB is leased.
   * @returns {Promise<unknown>} Callback result.
   */
  async withDb(agentId, fn) {
    if (this.isShutdown) throw new Error("AgentDbPool is shutdown");
    if (typeof fn !== "function") throw new TypeError("AgentDbPool.withDb requires a callback");
    while (this.clearPromise) await this.clearPromise;
    if (this.isShutdown) throw new Error("AgentDbPool is shutdown");
    const id = safeAgentId(agentId || "default");
    let startLease;
    const startGate = new Promise((resolve) => { startLease = resolve; });
    let acquired = false;
    const callbackPromise = (async () => {
      await startGate;
      this.dbs.acquire(id);
      acquired = true;
      const db = this._getOrCreateDb(id);
      return fn(db);
    })();
    let leasePromise;
    leasePromise = (async () => {
      try {
        try {
          await callbackPromise;
        } catch (error) {
          const settlement = await waitForTimeoutSettlement(error);
          if (settlement.status === "rejected") {
            const lateError = this._contextualizeDbError(id, "late-settlement", settlement.error);
            this._recordBackgroundLifecycleError(lateError);
            const loggingError = await this._warnLifecycle(
              id,
              "late-settlement",
              new Error("late database operation failed"),
            );
            if (loggingError) this._recordBackgroundLifecycleError(loggingError);
          }
        }
      } catch (trackingError) {
        const contextual = this._contextualizeDbError(id, "lease-tracking", trackingError);
        this._recordBackgroundLifecycleError(contextual);
        try {
          const loggingError = await this._warnLifecycle(id, "lease-tracking", trackingError);
          if (loggingError) this._recordBackgroundLifecycleError(loggingError);
        } catch (containmentError) {
          this._recordBackgroundLifecycleError(containmentError);
        }
      } finally {
        if (acquired) this.dbs.release(id);
        this.activeOperations.delete(leasePromise);
      }
    })();
    this.activeOperations.add(leasePromise);
    startLease();
    try {
      return await callbackPromise;
    } catch (error) {
      // The caller observes the original timeout/error immediately. leasePromise
      // independently retains the B7 lease through any attached settlement.
      throw error;
    } finally {
      if (!acquired) {
        // Failed acquisition has no callback settlement to retain.
        await leasePromise;
      }
    }
  }

  async shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.isShutdown) return;
    this.isShutdown = true;
    const shutdownPromise = (async () => {
      const errors = [];
      if (this.clearPromise) {
        try {
          await this.clearPromise;
        } catch (error) {
          if (error instanceof AggregateError) errors.push(...error.errors);
          else errors.push(error);
        }
      }
      await Promise.allSettled([...this.activeOperations]);
      errors.push(...this._drainBackgroundLifecycleErrors());
      for (const [agentId, db] of this.dbs.entries()) {
        if (!db || typeof db.shutdown !== "function") continue;
        try {
          await db.shutdown();
        } catch (error) {
          const contextual = this._contextualizeDbError(agentId, "shutdown", error);
          errors.push(contextual);
          const loggingError = await this._warnLifecycle(agentId, "shutdown", contextual);
          if (loggingError) errors.push(loggingError);
        }
      }
      try {
        await this.dbs.awaitPendingEvictions();
      } catch (error) {
        if (error instanceof AggregateError) errors.push(...error.errors);
        else errors.push(error);
      }
      this.dbs.clear();
      try {
        this.baseDirectoryCapability?.close();
      } catch (error) {
        errors.push(error);
      } finally {
        this.baseDirectoryCapability = null;
      }
      if (errors.length > 0) {
        throw new AggregateError(errors, `agent DB pool shutdown failures (${errors.length})`);
      }
    })();
    this.shutdownPromise = shutdownPromise;
    try {
      return await shutdownPromise;
    } finally {
      if (this.shutdownPromise === shutdownPromise) this.shutdownPromise = null;
    }
  }

  /** Close cached DBs and release their directory capabilities while keeping the pool reusable. */
  async clear() {
    if (this.isShutdown) return this.shutdownPromise;
    if (this.clearPromise) return this.clearPromise;
    const clearPromise = (async () => {
      await Promise.allSettled([...this.activeOperations]);
      const errors = this._drainBackgroundLifecycleErrors();
      for (const [agentId, db] of this.dbs.entries()) {
        if (!db || typeof db.shutdown !== "function") continue;
        try {
          await db.shutdown();
        } catch (error) {
          const contextual = this._contextualizeDbError(agentId, "clear", error);
          errors.push(contextual);
          const loggingError = await this._warnLifecycle(agentId, "clear", contextual);
          if (loggingError) errors.push(loggingError);
        }
      }
      try {
        await this.dbs.awaitPendingEvictions();
      } catch (error) {
        if (error instanceof AggregateError) errors.push(...error.errors);
        else errors.push(error);
      }
      this.dbs.clear();
      if (errors.length > 0) {
        throw new AggregateError(errors, `agent DB pool clear failures (${errors.length})`);
      }
    })();
    this.clearPromise = clearPromise;
    try {
      return await clearPromise;
    } finally {
      if (this.clearPromise === clearPromise) this.clearPromise = null;
    }
  }
}

const CONTROL_HEALTH_MAX_PARTITIONS = 128;
// The health scan opens every partition table (50+ on a busy install) and
// walks the store directory; measured 2-21 s depending on gateway load. The
// dashboard therefore serves the last snapshot at once and refreshes behind it.
const CONTROL_HEALTH_CACHE_TTL_MS = 5 * 60_000;
const CONTROL_HEALTH_REFRESH_INTERVAL_MS = 10 * 60_000;
const CONTROL_HEALTH_FAILED_RETRY_MS = 30_000;
const CONTROL_HEALTH_SAFE_DIRECTORY_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CONTROL_HEALTH_TABLE_PATH_NAMES = Object.freeze(["memories.lance", "memories"]);

function isAbsentControlHealthPath(error) {
  return error?.code === "ENOENT" || error?.code === "ENOTDIR";
}

function hasControlHealthLanceTable(partitionPath) {
  for (const tableName of CONTROL_HEALTH_TABLE_PATH_NAMES) {
    try {
      const tablePath = resolveInside(partitionPath, tableName);
      const stat = lstatSync(tablePath);
      if (stat.isDirectory() && !stat.isSymbolicLink()) return true;
    } catch (error) {
      if (isAbsentControlHealthPath(error)) continue;
      throw error;
    }
  }
  return false;
}

/** List only existing, ordinary, validated PLUR1BUS partition directory names. */
function listControlHealthPartitions(basePath) {
  let root;
  try {
    root = resolveInside(basePath);
  } catch (error) {
    if (isAbsentControlHealthPath(error)) return [];
    throw error;
  }
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if (isAbsentControlHealthPath(error)) return [];
    throw error;
  }
  const partitions = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !CONTROL_HEALTH_SAFE_DIRECTORY_NAME_RE.test(entry.name)) {
      continue;
    }
    const expected = resolve(root, entry.name);
    const canonical = resolveInside(root, entry.name);
    if (canonical !== expected) continue;
    if (!hasControlHealthLanceTable(canonical)) continue;
    partitions.push(safeAgentId(entry.name));
  }
  return partitions.toSorted((left, right) => left.localeCompare(right));
}


/** Create an isolated non-mutating LanceDB row-counter for control-plane health. */
function createControlHealthRowInspector(vectorDim, logger) {
  return async ({ basePath, partitionId }) => {
    const readPool = new AgentDbPool(basePath, vectorDim, logger, { readOnly: true });
    let result;
    let operationError = null;
    try {
      result = await readPool.withDb(partitionId, async (db) => {
        const initialized = await db.init();
        if (!initialized || !db.table) return 0;
        const count = await db.table.countRows();
        if (!Number.isSafeInteger(count) || count < 0) {
          throw new Error("invalid read-only PLUR1BUS health row count");
        }
        return count;
      });
    } catch (error) {
      operationError = error;
    }

    let shutdownError = null;
    try {
      await readPool.shutdown();
    } catch (error) {
      shutdownError = error;
    }
    if (operationError && shutdownError) {
      throw new AggregateError([operationError, shutdownError], "PLUR1BUS health row inspection and shutdown failed");
    }
    if (operationError) throw operationError;
    if (shutdownError) throw shutdownError;
    return result;
  };
}

class Embeddings {
  constructor(apiKey, model, baseUrl, dimensions, fallbackCfg, cacheOptions = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl;
    this.dimensions = dimensions;
    this._client = null;
    // fallbackCfg: { apiKey, model, baseUrl } — must produce same dimensions as primary
    this._fallbackCfg = fallbackCfg || null;
    this._fallbackClient = null;
    this._detectedDim = null; // gesetzt nach erstem embed-Call
    // v6.2.1 — Embedding-Cache aktivieren (P0-Fix)
    this._cache = cacheOptions.enabled !== false ? createEmbeddingCache({
      maxEntries: cacheOptions.maxEntries || 500,
      ttlMs: cacheOptions.ttlMs || 1800000,
    }) : null;
  }

  /**
   * v2.1.1: stellt sicher dass dimensions vor dem ersten embed-Call bekannt
   * sind. Bei Nicht-OpenAI-Provider ohne explizite dimensions: macht einen
   * Test-Call und liest die echte Dimension. Bei Mismatch (Config sagt X,
   * API liefert Y): wirft mit klarer Fehlermeldung — verhindert silent
   * Daten-Korruption.
   */
  async ensureDimensions(logger) {
    if (this._detectedDim !== null) return this._detectedDim;
    if (this.dimensions && this.dimensions > 0) {
      this._detectedDim = this.dimensions;
      return this.dimensions;
    }
    // Keine dimensions konfiguriert → Test-Call
    const isOpenAi = !this.model.includes("/") || this.model.startsWith("openai/") || this.model.startsWith("text-embedding-");
    if (isOpenAi) {
      // OpenAI ohne explizite dimensions: 3072 für large, 1536 für small/ada
      this._detectedDim = (this.model.includes("small") || this.model.includes("ada")) ? 1536 : 3072;
      logger?.info?.(`memory-lancedb-namespaced: OpenAI-Modell '${this.model}' → assumed ${this._detectedDim} dimensions`);
      return this._detectedDim;
    }
    // Nicht-OpenAI Provider (OpenRouter, etc.) ohne dimensions → Test-Call
    logger?.info?.(`memory-lancedb-namespaced: no dimensions configured for '${this.model}' — probing via test call…`);
    try {
      const client = await this.getClient();
      const r = await client.embeddings.create({ model: this.model, input: "dim probe", encoding_format: "float" });
      this._detectedDim = r.data[0].embedding.length;
      logger?.info?.(`memory-lancedb-namespaced: model '${this.model}' yields ${this._detectedDim}-dim vectors`);
      return this._detectedDim;
    } catch (e) {
      throw new Error(`Cannot determine embedding dimension for '${this.model}' (${e.message}). Please set 'dimensions' explicitly in openclaw.json.`);
    }
  }

  async getClient() {
    if (!this.apiKey) {
      throw new Error(
        "memory-lancedb-namespaced: embedding API key is not configured. " +
        "Set plugins.entries.memory-lancedb-namespaced.config.embedding.apiKey or OPENAI_API_KEY."
      );
    }
    if (!this._client) {
      const OpenAI = await getOpenAI();
      this._client = new OpenAI({
        apiKey: this.apiKey,
        baseURL: this.baseUrl,
      });
    }
    return this._client;
  }

  async getFallbackClient() {
    if (!this._fallbackClient && this._fallbackCfg) {
      if (!this._fallbackCfg.apiKey) {
        return null;
      }
      const OpenAI = await getOpenAI();
      this._fallbackClient = new OpenAI({
        apiKey: this._fallbackCfg.apiKey,
        baseURL: this._fallbackCfg.baseUrl,
      });
    }
    return this._fallbackClient;
  }

  // v2.1.0 — Build embedding-request body. encoding_format: "float" ist explizit
  // gesetzt weil OpenAI-SDK default base64 nutzt, was viele OpenRouter-Provider
  // (NVIDIA, manche andere) mit 400 ablehnen. dimensions ist nur für OpenAI-
  // Modelle gültig — andere Provider werfen sonst "unknown parameter" → wir
  // omitten es bei Nicht-OpenAI-Modellen (heuristisch via Modell-ID-Prefix).
  _buildEmbeddingRequest(model, text) {
    const isOpenAi = !model.includes("/") || model.startsWith("openai/") || model.startsWith("text-embedding-");
    const req = { model, input: text, encoding_format: "float" };
    if (isOpenAi && this.dimensions) req.dimensions = this.dimensions;
    return req;
  }

  /**
   * v2.1.1: Hard-Fail bei Dim-Mismatch. Wenn _detectedDim gesetzt ist und
   * der Embedding-Call etwas anderes liefert: Throw statt silent korrupter
   * Vektor in der DB. Schützt vor Provider-Wechsel ohne fresh DB.
   */
  _validateDim(vec) {
    if (this._detectedDim !== null && vec.length !== this._detectedDim) {
      throw new Error(`Embedding-Dimension-Mismatch: erwartet ${this._detectedDim}, bekam ${vec.length} (Modell: ${this.model}). Provider-Wechsel ohne fresh DB? Siehe Migration in CHANGELOG v2.1.0.`);
    }
    if (this._detectedDim === null) this._detectedDim = vec.length;
    return vec;
  }

  async embed(text, retries = 3) {
    // v6.2.1 — Cache-Lookup vor API-Call (P0-Fix)
    const cacheKey = text.trim().toLowerCase();
    if (this._cache) {
      const cached = this._cache.get("__global__", cacheKey, this.model);
      if (cached) return cached.vector;
    }

    const client = await this.getClient();
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await client.embeddings.create(this._buildEmbeddingRequest(this.model, text));
        const vector = this._validateDim(response.data[0].embedding);
        if (this._cache) this._cache.set("__global__", cacheKey, this.model, vector);
        return vector;
      } catch (err) {
        lastErr = err;
        if (attempt === retries) break;
        const isRateLimit = err?.status === 429 || String(err).includes("rate");
        const delay = isRateLimit ? Math.min(1000 * 2 ** attempt, 16000) : 500 * (attempt + 1);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    // Primary failed — try fallback if configured
    const fallbackClient = await this.getFallbackClient();
    if (fallbackClient && this._fallbackCfg) {
      try {
        const fallbackModel = this._fallbackCfg.model || this.model;
        const response = await fallbackClient.embeddings.create(this._buildEmbeddingRequest(fallbackModel, text));
        const vector = this._validateDim(response.data[0].embedding);
        if (this._cache) this._cache.set("__global__", cacheKey, this.model, vector);
        return vector;
      } catch (fallbackErr) {
        // Both failed — throw original error for clarity
        throw lastErr;
      }
    }
    throw lastErr;
  }
}

// categorizeMemory kommt jetzt aus lib/categorize.js

/**
 * Baut die Wartungs-Nudges (Knowledge-Update + Conflict-Review) für die
 * before_prompt_build-Hooks. Geteilt zwischen auto-recall on/off (#9 Dedup),
 * lokalisiert via i18n (#11), und liest conflict-log.jsonl nur EINMAL (#2).
 *
 * @returns {{knowledgeNudge: string, conflictNudge: string}}
 */
function buildMaintenanceNudges({ workspaceDir, schicht15Enabled, lang = "en", tone = "default", logger } = {}) {
  let knowledgeNudge = "";
  let conflictNudge = "";
  if (!workspaceDir) return { knowledgeNudge, conflictNudge };

  // Knowledge-update reminder
  if (schicht15Enabled) {
    try {
      const pending = readKnowledgePending(workspaceDir);
      if ((pending.pendingCount || 0) >= 3) {
        const daysSince = pending.lastUpdateAt
          ? Math.floor((Date.now() - new Date(pending.lastUpdateAt).getTime()) / 86400000)
          : null;
        const staleNote = daysSince !== null && daysSince >= 7
          ? t("nudge.knowledge_stale", { lang, tone, vars: { days: daysSince } })
          : "";
        const body = t("nudge.knowledge_pending", { lang, tone, vars: { count: pending.pendingCount, stale: staleNote } });
        knowledgeNudge = `\n<knowledge-update-reminder>\n${body}\n</knowledge-update-reminder>`;
      }
    } catch (e) {
      logger?.debug?.(`maintenance-nudge: knowledge pending read failed: ${e?.message || e}`);
    }
  }

  // Conflict-log reminder — P0-4: nur noch Summary lesen, kein Log-Scan im Prompt-Pfad.
  try {
    let summary = readConflictSummary(workspaceDir);
    if (!summary) {
      // Fallback: einmalig lazy rebuild mit Budget/Timeout, wenn Summary fehlt.
      summary = buildConflictSummaryFromLog(workspaceDir);
    }
    if (summary) {
      const sizeKb = Math.round((summary.sizeBytes || 0) / 1024);
      const lineCount = summary.count || 0;
      const oldestTimestamp = summary.oldestTimestamp || null;
      let showNudge = (summary.sizeBytes || 0) > 1_048_576;
      if (!showNudge && oldestTimestamp && Date.now() - oldestTimestamp > 30 * 86_400_000) {
        showNudge = true;
      }
      if (showNudge && lineCount > 0) {
        const body = t("nudge.conflict_review", { lang, tone, vars: { count: lineCount, sizeKb } });
        conflictNudge = `\n<conflict-review-reminder>\n${body}\n</conflict-review-reminder>`;
      }
    }
  } catch (e) {
    logger?.debug?.(`maintenance-nudge: conflict summary read failed: ${e?.message || e}`);
  }

  return { knowledgeNudge, conflictNudge };
}

function resolveNeoHooksConfig(api, commandConfig) {
  try {
    const cfg = commandConfig || runtimeIfUsable(api)?.config?.current?.();
    return cfg?.plugins?.entries?.["memory-lancedb-namespaced"]?.hooks || {};
  } catch (error) {
    // An empty object disables every Neo hook. Say so rather than looking
    // like a deliberately empty configuration.
    api?.logger?.warn?.(`memory-lancedb-namespaced: neo hook config unreadable, all neo hooks stay disabled: ${String(error)}`);
    return {};
  }
}

function formatJsonCommandResult(value) {
  return { text: JSON.stringify(value, null, 2) };
}

function finiteSkillMetric(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : 0;
}

function aggregateSkillMinerRuns(skillRuns, agent) {
  const successfulRuns = skillRuns.filter((run) => run.result && !run.failed);
  const failedRuns = skillRuns.filter((run) => run.failed === true);
  const reports = successfulRuns.map((run) => run.result);
  const aclBindings = skillRuns.length === 1 && successfulRuns.length === 1
    ? reports[0].aclBindings || null
    : null;
  const allSkipped = reports.length > 0 && reports.every((report) => report.skipped === true);
  const allFailed = reports.length === 0 && failedRuns.length > 0;

  return {
    timestamp: new Date().toISOString(),
    agent,
    ...((allSkipped || allFailed)
      ? { skipped: true, reason: allFailed ? "all_partitions_failed" : "all_partitions_skipped" }
      : {}),
    partialFailure: failedRuns.length > 0,
    failedPartitions: failedRuns.map((run) => run.scope),
    scanned: reports.reduce((total, report) => total + finiteSkillMetric(report.scanned), 0),
    proposalsCreated: reports.reduce((total, report) => total + finiteSkillMetric(report.proposalsCreated), 0),
    skippedLowEvidence: reports.reduce((total, report) => total + finiteSkillMetric(report.skippedLowEvidence), 0),
    skippedLowConfidence: reports.reduce((total, report) => total + finiteSkillMetric(report.skippedLowConfidence), 0),
    skippedDuplicate: reports.reduce((total, report) => total + finiteSkillMetric(report.skippedDuplicate), 0),
    pushMessages: reports.flatMap((report) => Array.isArray(report.pushMessages) ? report.pushMessages : []),
    dryRun: reports.length > 0 && reports.every((report) => report.dryRun === true),
    aclBindings,
  };
}

function formatKnownValidityLabel(entry) {
  const validFrom = Number(entry?.validFrom ?? 0);
  const validUntil = Number(entry?.validUntil ?? 0);
  const fromLabel = Number.isFinite(validFrom) && validFrom > 0
    ? new Date(validFrom).toISOString()
    : "unknown";
  const untilLabel = Number.isFinite(validUntil) && validUntil > 0
    ? new Date(validUntil).toISOString()
    : "open";
  return validFrom > 0 || validUntil > 0
    ? `, valid: [${fromLabel}, ${untilLabel})`
    : "";
}

/**
 * Path to the feature-cron setup marker file under baseDbPath (user-scoped,
 * same base the plugin already uses for everything else — never a
 * hardcoded system path), so this works identically for root and non-root
 * installs.
 */
function featureCronsMarkerPath(baseDbPath) {
  return join(baseDbPath, ".feature-crons-setup.json");
}

/**
 * Fail-open, at-most-once-per-process, condition-derived doctor/status
 * hint: does the feature-cron setup marker show anything still worth
 * running? The marker is written by the gateway_start deferred bootstrap
 * (and/or a successful `/plur1bus setup crons`) — this function only
 * *reads* it, it never writes ("checked" and "resolved" must stay
 * distinct signals; see featureCronsHintFromMarker).
 */
function getFeatureCronsSetupHint(baseDbPath) {
  if (_featureCronsHintCache !== undefined) return _featureCronsHintCache;
  try {
    const marker = readJsonSafe(featureCronsMarkerPath(baseDbPath), null);
    _featureCronsHintCache = featureCronsHintFromMarker(marker, PLUGIN_VERSION);
  } catch (_e) {
    _featureCronsHintCache = null;
  }
  return _featureCronsHintCache;
}

/**
 * Inspect the public OpenClaw capabilities required by model-free feature
 * crons. Missing capabilities are reported explicitly and leave only the
 * affected cron path fail-closed; OpenClaw runtime files are never modified.
 *
 * @param {object} api
 * @returns {boolean}
 */
function inspectCronNativeCapabilities(api) {
  const missing = [
    ["registerGatewayMethod", api?.registerGatewayMethod],
    ["registerCli", api?.registerCli],
  ].filter(([, capability]) => typeof capability !== "function").map(([name]) => name);
  if (missing.length === 0) {
    api.logger?.info?.("plur1bus-feature-crons: native command dispatch ready");
    return true;
  }
  api?.logger?.warn?.(
    `plur1bus-feature-crons: required OpenClaw capability unavailable (${missing.join(", ")}); `
      + "feature-cron setup will remain fail-closed and no host files will be patched",
  );
  return false;
}

/**
 * Claim known PLUR1BUS feature-cron turns before OpenClaw can admit them to
 * the outer model when the direct dispatcher was unavailable at registration.
 *
 * @param {object} event
 * @param {object} context
 * @param {{hostReady?: boolean}} [options]
 * @returns {{handled: true, reply: {text: string}}|undefined}
 */
function guardUnsafeDirectCronTurn(event, context, { hostReady } = {}) {
  if (
    hostReady !== false
    || context?.trigger !== "cron"
    || !isGuardedDirectFeatureCronMessage(event?.cleanedBody)
  ) {
    return undefined;
  }
  return { handled: true, reply: { text: "NO_REPLY" } };
}

/**
 * Use OpenClaw's in-process cron service to close the direct-job execution
 * window before the deferred CLI reconciliation starts.
 *
 * @param {object} api
 * @param {{getCron?: Function}|null} gatewayContext
 * @returns {Promise<{available: boolean, disabled: number, failed: number}>}
 */
async function reconcileUnsafeDirectCronsWithService(api, gatewayContext) {
  let cron;
  try {
    cron = gatewayContext?.getCron?.();
  } catch (error) {
    api.logger?.warn?.(
      `plur1bus-feature-crons: gateway cron service lookup failed (${error?.message || String(error)})`,
    );
    return { available: false, disabled: 0, failed: 0 };
  }
  if (!cron || typeof cron.list !== "function" || typeof cron.update !== "function") {
    api.logger?.warn?.("plur1bus-feature-crons: gateway cron service unavailable for immediate safety reconciliation");
    return { available: false, disabled: 0, failed: 0 };
  }

  let jobs;
  try {
    jobs = await withTimeout(
      Promise.resolve(cron.list({ includeDisabled: true })),
      5_000,
      "feature cron immediate safety list",
    );
  } catch (error) {
    api.logger?.warn?.(
      `plur1bus-feature-crons: immediate cron list failed (${error?.message || String(error)})`,
    );
    return { available: true, disabled: 0, failed: 1 };
  }

  const unsafeJobs = planUnsafeDirectCronDisables(jobs);
  let disabled = 0;
  let failed = 0;
  for (const job of unsafeJobs) {
    try {
      await withTimeout(
        Promise.resolve(cron.update(job.id, {
          enabled: false,
          name: job.safetyName,
        })),
        5_000,
        `feature cron immediate safety update ${job.id}`,
      );
      disabled += 1;
    } catch (error) {
      failed += 1;
      api.logger?.warn?.(
        `plur1bus-feature-crons: immediate safety-disable failed for ${job.id} (${error?.message || String(error)})`,
      );
    }
  }
  if (disabled > 0) {
    api.logger?.warn?.(
      `plur1bus-feature-crons: immediately safety-disabled ${disabled} exact direct job(s)`,
    );
  }
  return { available: true, disabled, failed };
}

/**
 * Deferred, best-effort feature-cron bootstrap for the gateway_start
 * handler registered above. Fail-open end to end: any failure here is
 * logged at debug/warn level and swallowed — it must never affect the
 * gateway or the message flow.
 *
 * Throttled via the same marker file the doctor/status hint reads
 * (see shouldRunCronBootstrap): skipped when a successful run for the current
 * plugin version happened in the last 20h. Host-patch failure forces the
 * safety run regardless of the marker.
 */
async function runDeferredFeatureCronBootstrap(api, {
  cfg,
  baseDbPath,
  spawnImpl,
  force = false,
  safetyRetryDelaysMs = [0, 1_000, 5_000, 30_000, 120_000, 600_000],
  waitImpl,
} = {}) {
  const markerPath = featureCronsMarkerPath(baseDbPath);
  let marker = null;
  try {
    marker = readJsonSafe(markerPath, null);
  } catch (_e) {
    marker = null;
  }

  if (!force && !shouldRunCronBootstrap(marker, { pluginVersion: PLUGIN_VERSION })) {
    api.logger?.debug?.("plur1bus-feature-crons: deferred bootstrap skipped (recent run recorded)");
    return { ok: true, safetyPending: false, attempts: 0 };
  }

  const scriptPath = join(__pluginDir, "scripts", "setup-feature-crons.mjs");
  const retrySchedule = force && Array.isArray(safetyRetryDelaysMs) && safetyRetryDelaysMs.length > 0
    ? safetyRetryDelaysMs
    : [0];
  const waitForRetry = waitImpl || ((delayMs) => new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, delayMs);
    timer?.unref?.();
  }));

  for (let attemptIndex = 0; attemptIndex < retrySchedule.length; attemptIndex += 1) {
    const delayMs = retrySchedule[attemptIndex];
    if (attemptIndex > 0 && delayMs > 0) await waitForRetry(delayMs);

    let stdout = "";
    let ok = false;
    try {
      let child;
      if (spawnImpl) {
        child = spawnImpl(process.execPath, [scriptPath, "--json"], {
          cwd: __pluginDir,
          detached: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } else {
        const { spawn } = await import("node:child_process");
        child = spawn(process.execPath, [scriptPath, "--json"], {
          cwd: __pluginDir,
          detached: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      }
      ok = await new Promise((resolvePromise) => {
        child.stdout?.on("data", (chunk) => { stdout += chunk; });
        child.stderr?.resume();
        child.on("error", () => resolvePromise(false));
        child.on("close", (code) => resolvePromise(code === 0));
      });
    } catch (err) {
      api.logger?.debug?.(`plur1bus-feature-crons: deferred bootstrap spawn failed: ${err?.message || err}`);
    }

    let parsedResult = null;
    try {
      parsedResult = stdout.trim() ? JSON.parse(stdout.trim()) : null;
    } catch {
      parsedResult = null;
    }

    if (ok) {
      const lastPlanCreateCount = parseFeatureCronBootstrapLastPlanCreateCount(stdout);
      try {
        writeJsonAtomic(
          markerPath,
          {
            pluginVersion: PLUGIN_VERSION,
            lastRunAt: new Date().toISOString(),
            ...(lastPlanCreateCount !== undefined ? { lastPlanCreateCount } : {}),
          },
          { pretty: true },
        );
      } catch (err) {
        api.logger?.debug?.(`plur1bus-feature-crons: marker write failed: ${err?.message || err}`);
      }
      _featureCronsHintCache = undefined;
      api.logger?.info?.(
        `plur1bus-feature-crons: deferred bootstrap ran (ok=${ok}${lastPlanCreateCount !== undefined ? `, planCreateCount=${lastPlanCreateCount}` : ""})`,
      );
    } else {
      api.logger?.info?.("plur1bus-feature-crons: deferred bootstrap attempt failed");
    }

    const failedSafetyRecovery = Array.isArray(parsedResult?.results)
      && parsedResult.results.some(
        (result) => result?.action === "safety-recovery" && result?.ok === false,
      );
    const safetyPending = force && (
      !ok
      || !parsedResult
      || parsedResult.skipped === true
      || failedSafetyRecovery
    );
    if (!safetyPending) {
      return { ok, safetyPending: false, attempts: attemptIndex + 1 };
    }
    if (attemptIndex + 1 < retrySchedule.length) {
      api.logger?.warn?.(
        `plur1bus-feature-crons: safety reconciliation pending; retry ${attemptIndex + 2}/${retrySchedule.length}`,
      );
    }
  }
  api.logger?.warn?.("plur1bus-feature-crons: safety reconciliation still pending after bounded retries");
  return { ok: false, safetyPending: true, attempts: retrySchedule.length };
}

/**
 * Parse the deferred feature-cron setup script's `--json` stdout into the
 * marker-facing pending count.
 *
 * Rules:
 * - Explicit numeric `lastPlanCreateCount` from the script wins.
 * - Otherwise preserve the legacy normal-path calculation:
 *   failed creates + disabled delivery-needing creates.
 * - If stdout is empty, unparseable, or parses to a non-object, return `1`
 *   so the marker keeps the doctor/status hint visible instead of looking
 *   like a success marker.
 *
 * @param {string} stdout
 * @returns {number}
 */
function parseFeatureCronBootstrapLastPlanCreateCount(stdout) {
  try {
    const parsed = typeof stdout === "string" && stdout.trim() ? JSON.parse(stdout.trim()) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return 1;
    }
    if (Number.isFinite(parsed.lastPlanCreateCount)) {
      return parsed.lastPlanCreateCount;
    }

    const failedCreates = Array.isArray(parsed.results)
      ? parsed.results.filter((r) => !r?.ok).length
      : 0;
    // Delivery-pflichtige Jobs, die mangels ableitbarem Ziel nur disabled
    // angelegt wurden, gelten weiterhin als "pending": der doctor/status-
    // Hinweis soll sichtbar bleiben, bis der Operator sie aktiviert hat
    // (README verspricht genau das).
    const disabledDeliveryCreates = Array.isArray(parsed.plan?.create)
      ? parsed.plan.create.filter((c) => c?.needsDelivery && c?.enabled === false).length
      : 0;
    return failedCreates + disabledDeliveryCreates;
  } catch (_e) {
    return 1;
  }
}

function findNeoRecord(store, id, requester = {}) {
  return findLatestNeoRecord(store, id, requester);
}

function summarizeNeoStore(store) {
  return {
    turns: store.readTurns(10_000).length,
    candidates: store.readCandidates(10_000).length,
    behaviorCards: store.readBehaviorCards(10_000).length,
    hooks: store.readHooks(),
  };
}

function textSuggestsGroupOrigin(text) {
  if (!text || typeof text !== "string") return false;
  return (
    /"is_group_chat"\s*:\s*true/.test(text) ||
    /"group_subject"\s*:/.test(text) ||
    /"group_channel"\s*:/.test(text) ||
    /Guild #/i.test(text) ||
    /\[Discord Guild /i.test(text)
  );
}

// ============================================================================
// Curation-Log
// ============================================================================

function appendCurationLog(workspaceDir, agentId, entry) {
  try {
    const dir = join(workspaceDir, ".adaptive-learning");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "curation-log.jsonl"), JSON.stringify(entry) + "\n", "utf8");
  } catch (_) { /* non-blocking — log errors silently */ }
}

function conflictSummaryPath(workspaceDir) {
  return join(workspaceDir, ".adaptive-learning", "conflict-review-summary.json");
}

function readConflictSummary(workspaceDir) {
  try {
    const path = conflictSummaryPath(workspaceDir);
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (data && typeof data.count === "number") return data;
  } catch (e) {
    console.warn("[conflict-summary] read failed:", e?.message);
  }
  return null;
}

function writeConflictSummary(workspaceDir, summary) {
  try {
    const path = conflictSummaryPath(workspaceDir);
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(summary) + "\n", "utf8");
    renameSync(tmp, path);
  } catch (e) {
    console.warn("[conflict-summary] write failed:", e?.message);
  }
}

function buildConflictSummaryFromLog(workspaceDir, options = {}) {
  const { maxLines = 1000, budgetMs = 50 } = options;
  const logPath = join(workspaceDir, ".adaptive-learning", "conflict-log.jsonl");
  if (!existsSync(logPath)) return null;
  const start = performance.now();
  let stat;
  try { stat = statSync(logPath); } catch (_) { return null; }
  const head = readFileHeadSync(logPath, 1024 * 1024);
  const lines = head.split("\n").filter((l) => l.trim());
  let count = 0;
  let oldestTimestamp = null;
  let newestTimestamp = null;
  let pendingCount = 0;
  for (let i = 0; i < Math.min(lines.length, maxLines); i++) {
    if (performance.now() - start > budgetMs) break;
    try {
      const record = JSON.parse(lines[i]);
      count++;
      const ts = record.timestamp ? new Date(record.timestamp).getTime() : null;
      if (ts) {
        if (oldestTimestamp === null) oldestTimestamp = ts;
        newestTimestamp = ts;
      }
      if (record.pending || record.status === "pending") pendingCount++;
    } catch (e) {
      console.warn("[conflict-summary] malformed line:", e?.message, lines[i].slice(0, 100));
    }
  }
  return {
    count,
    oldestTimestamp,
    newestTimestamp,
    sizeBytes: stat.size,
    pendingCount,
    lastUpdatedAt: new Date().toISOString(),
  };
}

function updateConflictSummary(workspaceDir, entry) {
  let summary = readConflictSummary(workspaceDir);
  if (!summary) {
    // Bootstrap: appendConflictLog hat den neuen Eintrag bereits in das Log
    // geschrieben bevor dieser Aufruf erfolgt. buildConflictSummaryFromLog
    // zählt ihn daher schon mit — kein weiteres Inkrement nötig.
    const fromLog = buildConflictSummaryFromLog(workspaceDir);
    if (fromLog) {
      fromLog.lastUpdatedAt = new Date().toISOString();
      writeConflictSummary(workspaceDir, fromLog);
      return;
    }
    // Log existiert (noch) nicht — mit Null starten, unten inkrementieren.
    summary = {
      count: 0,
      oldestTimestamp: null,
      newestTimestamp: null,
      sizeBytes: 0,
      pendingCount: 0,
      lastUpdatedAt: new Date().toISOString(),
    };
  }
  const line = JSON.stringify(entry);
  summary.count = (summary.count || 0) + 1;
  const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : null;
  if (ts) {
    if (summary.oldestTimestamp === null || ts < summary.oldestTimestamp) summary.oldestTimestamp = ts;
    if (summary.newestTimestamp === null || ts > summary.newestTimestamp) summary.newestTimestamp = ts;
  }
  summary.sizeBytes = (summary.sizeBytes || 0) + line.length + 1;
  if (entry.pending || entry.status === "pending") {
    summary.pendingCount = (summary.pendingCount || 0) + 1;
  }
  summary.lastUpdatedAt = new Date().toISOString();
  writeConflictSummary(workspaceDir, summary);
}

function appendConflictLog(workspaceDir, entry) {
  try {
    const dir = join(workspaceDir, ".adaptive-learning");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "conflict-log.jsonl"), JSON.stringify(entry) + "\n", "utf8");
    // P0-4: Summary für promptnahe Reads pflegen.
    updateConflictSummary(workspaceDir, entry);
  } catch (e) {
    console.warn("[conflict-log] write failed:", e?.message);
  }
}

// ============================================================================
// LLM helper — shared for merge-check and KNOWLEDGE.md updates
// ============================================================================

async function callLlm(messages, llmCfg) {
  const result = await completeFeatureLlm(messages, llmCfg, {
    runtimeLlm: llmCfg?.callContext?.runtimeLlm,
    agentId: llmCfg?.callContext?.agentId,
    purpose: llmCfg?.callContext?.purpose,
    maxTokens: llmCfg?.maxTokens,
    temperature: llmCfg?.temperature,
    jsonMode: llmCfg?.jsonMode,
    disableThinking: llmCfg?.disableThinking,
    timeoutMs: llmCfg?.timeoutMs,
    signal: llmCfg?.callContext?.signal ?? llmCfg?.signal,
    resultCacheContext: llmCfg?.resultCacheContext,
  }, {
    directCall: (directMessages, directCfg) => callOpenAiLlm(directMessages, directCfg, {
      loadOpenAI: getOpenAI,
      resultCache: directCfg?.resultCache,
    }),
  });
  if (result.status === "failed") throw result.error;
  return result.status === "ok" ? result.text : null;
}

/**
 * Compose deterministic result caching before call-local routing context.
 * @param {object} llmCfg
 * @param {string} agentId
 * @param {string} purpose
 * @param {object} overrides
 * @param {{agentId?: string, runtimeLlm?: object, signal?: AbortSignal}} [callContext]
 * @returns {object}
 */
function withDeterministicLlmContext(llmCfg, agentId, purpose, overrides = {}, callContext = {}) {
  return withLlmCallContext(
    withLlmResultCacheContext({ ...llmCfg, ...overrides }, agentId, purpose),
    callContext?.agentId || agentId,
    purpose,
    { runtimeLlm: callContext?.runtimeLlm, signal: callContext?.signal },
  );
}

/**
 * Ask the LLM for one deterministic agent-scoped merge decision.
 * @param {string} existingText
 * @param {string} newText
 * @param {object} llmCfg
 * @param {string} agentId
 * @param {{runtimeLlm?: object}} [callContext]
 * @returns {Promise<object|null>}
 */
async function callMergeCheck(existingText, newText, llmCfg, agentId, callContext = {}) {
  const A = String(existingText || "").slice(0, 2000);
  const B = String(newText || "").slice(0, 2000);
  const content = await callLlm([
    {
      role: "user",
      content: `Two memory fragments — should they be merged into one?\n\nFragment A: ${A}\nFragment B: ${B}\n\nRespond with JSON only: {"merge": boolean, "reason": "brief explanation", "mergedText": "merged version (only if merge=true)"}\nRules:\n- merge=true only if both fragments describe the same subject/fact from different angles\n- mergedText must contain ALL information from both fragments\n- mergedText must be longer than the shorter of the two fragments`,
    },
  ], withDeterministicLlmContext(
    llmCfg,
    agentId,
    LLM_RESULT_CACHE_PURPOSES.MERGE_DECISION,
    // No temperature: providers like the Kimi coding endpoint allow exactly
    // one value per thinking mode and answer HTTP 400 for anything else.
    { jsonMode: true, maxTokens: 300 },
    callContext,
  ));
  if (!content) return null;
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (_) {
    return null; // LLM returned invalid JSON — treat as no-merge
  }
  // Schema-Validierung: merge muss boolean sein, reason string, mergedText optional string
  if (typeof parsed?.merge !== "boolean" || typeof parsed?.reason !== "string") return null;
  if (parsed.merge && typeof parsed.mergedText !== "string") return null;
  return parsed;
}

// ============================================================================
// Schicht 1.5 — Pending-Tracking & knowledge_update
// ============================================================================

const KNOWLEDGE_PENDING_FILE = "knowledge-pending.json";
const KNOWLEDGE_PENDING_LOCK_FILE = "knowledge-pending.lock";
const KNOWLEDGE_LOCK_FILE    = "knowledge-update.lock";
const KNOWLEDGE_MD_FILE      = "memory/KNOWLEDGE.md";
const KNOWLEDGE_PENDING_CAP  = 200;

function pendingKey(sourceAgent, memoryId) {
  return `${sourceAgent}:${memoryId}`;
}

function normalizeKnowledgePending(raw) {
  const now = new Date().toISOString();
  const pending = [];
  if (Array.isArray(raw?.pending)) {
    for (const item of raw.pending) {
      if (!item?.sourceAgent || !item?.memoryId) continue;
      pending.push({
        key: item.key || pendingKey(item.sourceAgent, item.memoryId),
        sourceAgent: item.sourceAgent,
        memoryId: item.memoryId,
        queuedAt: item.queuedAt || raw.lastStoreAt || now,
        reason: item.reason || "schicht15-store-pending",
        category: item.category || "fact",
        importance: Number(item.importance ?? 0.5),
      });
    }
  }
  if (Array.isArray(raw?.pendingMemoryIds)) {
    for (const id of raw.pendingMemoryIds.filter(Boolean)) {
      pending.push({
        key: id,
        sourceAgent: null,
        memoryId: id,
        queuedAt: raw.lastStoreAt || now,
        reason: "legacy-pending-id",
        category: "fact",
        importance: 0.5,
      });
    }
  }
  const deduped = new Map();
  for (const item of pending) deduped.set(item.key, item);
  const sorted = [...deduped.values()].sort((a, b) => {
    const imp = (b.importance ?? 0) - (a.importance ?? 0);
    if (imp !== 0) return imp;
    return String(b.queuedAt || "").localeCompare(String(a.queuedAt || ""));
  });
  return {
    schema: 2,
    pending: sorted.slice(0, KNOWLEDGE_PENDING_CAP),
    pendingCount: Math.min(sorted.length, KNOWLEDGE_PENDING_CAP),
    pendingOverflowCount: Math.max(0, sorted.length - KNOWLEDGE_PENDING_CAP),
    lastStoreAt: raw?.lastStoreAt || null,
    lastUpdateAt: raw?.lastUpdateAt || null,
  };
}

function acquireKnowledgePendingLock(workspaceDir) {
  const dir = join(workspaceDir, ".adaptive-learning");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const lockPath = join(dir, KNOWLEDGE_PENDING_LOCK_FILE);
  if (existsSync(lockPath)) {
    const lockAge = Date.now() - statSync(lockPath).mtimeMs;
    if (lockAge > 60 * 1000) unlinkSync(lockPath);
    else throw new Error("knowledge pending lock held");
  }
  const fd = openSync(lockPath, "wx");
  writeFileSync(fd, new Date().toISOString());
  closeSync(fd);
  return lockPath;
}

function releaseKnowledgePendingLock(lockPath) {
  try { if (lockPath && existsSync(lockPath)) unlinkSync(lockPath); } catch (_e) { dbg(_e); }
}

function readKnowledgePendingUnlocked(workspaceDir) {
  try {
    const p = join(workspaceDir, ".adaptive-learning", KNOWLEDGE_PENDING_FILE);
    if (existsSync(p)) return normalizeKnowledgePending(JSON.parse(readFileSync(p, "utf8")));
  } catch (_e) { dbg(_e); }
  return normalizeKnowledgePending({});
}

function writeKnowledgePendingUnlocked(workspaceDir, state) {
  const dir = join(workspaceDir, ".adaptive-learning");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const p = join(dir, KNOWLEDGE_PENDING_FILE);
  const normalized = normalizeKnowledgePending(state);
  const tmpPath = p + ".tmp";
  writeFileSync(tmpPath, JSON.stringify(normalized, null, 2), "utf8");
  renameSync(tmpPath, p);
  return normalized;
}

function readKnowledgePending(workspaceDir) {
  let lockPath = null;
  try {
    lockPath = acquireKnowledgePendingLock(workspaceDir);
    return readKnowledgePendingUnlocked(workspaceDir);
  } catch (_) {
    return normalizeKnowledgePending({});
  } finally {
    releaseKnowledgePendingLock(lockPath);
  }
}

function readKnowledgePendingSnapshot(workspaceDir) {
  return readKnowledgePending(workspaceDir);
}

function trackKnowledgePending(workspaceDir, memory) {
  let lockPath = null;
  try {
    if (!memory?.sourceAgent || !memory?.memoryId) return;
    lockPath = acquireKnowledgePendingLock(workspaceDir);
    const state = readKnowledgePendingUnlocked(workspaceDir);
    const entry = {
      key: pendingKey(memory.sourceAgent, memory.memoryId),
      sourceAgent: memory.sourceAgent,
      memoryId: memory.memoryId,
      queuedAt: new Date().toISOString(),
      reason: memory.reason || "schicht15-store-pending",
      category: memory.category || "fact",
      importance: Number(memory.importance ?? 0.5),
    };
    state.pending = [...state.pending.filter(it => it.key !== entry.key), entry];
    state.lastStoreAt = new Date().toISOString();
    const written = writeKnowledgePendingUnlocked(workspaceDir, state);
    if ((written.pendingOverflowCount || 0) > 0) {
      appendCurationLog(workspaceDir, memory.sourceAgent, {
        event: "knowledge_pending.overflow",
        timestamp: new Date().toISOString(),
        agentId: memory.sourceAgent,
        memoryId: memory.memoryId,
        text: "",
        category: memory.category || "fact",
        origin: "system",
        reason: `pending_cap:${KNOWLEDGE_PENDING_CAP}, overflow:${written.pendingOverflowCount}`,
        relatedId: null,
      });
    }
  } catch (_e) { dbg(_e); }
  finally { releaseKnowledgePendingLock(lockPath); }
}

function removeKnowledgePending(workspaceDir, removeKeys, removeLegacyIds = []) {
  let lockPath = null;
  try {
    const keys = new Set(removeKeys || []);
    const legacy = new Set(removeLegacyIds || []);
    lockPath = acquireKnowledgePendingLock(workspaceDir);
    const state = readKnowledgePendingUnlocked(workspaceDir);
    state.pending = state.pending.filter(item => !keys.has(item.key) && !(item.sourceAgent === null && legacy.has(item.memoryId)));
    state.lastUpdateAt = new Date().toISOString();
    writeKnowledgePendingUnlocked(workspaceDir, state);
  } catch (_e) { dbg(_e); }
  finally { releaseKnowledgePendingLock(lockPath); }
}

// ============================================================================
// Schicht 1.5 — KNOWLEDGE.md
// ============================================================================

/**
 * Integrate one memory into KNOWLEDGE.md with deterministic agent-scoped LLM calls.
 * @param {string} workspaceDir
 * @param {string} text
 * @param {string} category
 * @param {number} importance
 * @param {object} llmCfg
 * @param {object} logger
 * @param {string} agentId
 * @param {Array<string>} sourceMemoryIds
 * @returns {Promise<void>}
 */
async function updateKnowledgeMd(workspaceDir, text, category, importance, llmCfg, logger, agentId, sourceMemoryIds) {
  if (!workspaceDir || !llmCfg) return;
  const memDir = join(workspaceDir, "memory");
  const knowledgePath = join(memDir, "KNOWLEDGE.md");

  let currentContent = "";
  try {
    if (existsSync(knowledgePath)) currentContent = readFileSync(knowledgePath, "utf8");
  } catch (_e) { dbg(_e); }

  // Strip frontmatter before sending to LLM (LLM should not touch it)
  const { frontmatter: existingFm, body: currentBody } = stripFrontmatter(currentContent);
  let mergedSources = sourceMemoryIds || [];
  if (existingFm) {
    const m = existingFm.match(/source_memories:\s*\n((?:\s+-\s+.+\n?)*)/);
    if (m) {
      const oldIds = m[1].split("\n").map(l => l.replace(/^\s+-\s+/, "").trim()).filter(Boolean);
      mergedSources = [...new Set([...oldIds, ...mergedSources])];
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  const updated = await callLlm([
    {
      role: "user",
      content: `Here is the current KNOWLEDGE.md body (empty = not yet created):\n${currentBody || "(empty)"}\n\nNew memory (category=${category}, importance=${importance.toFixed(1)}, date=${today}):\n${text}\n\nIntegrate this information into the KNOWLEDGE.md body.\n- Add a new entry under the appropriate section with today's date.\n- If an existing entry is logically identical, replace it instead of adding a duplicate.\n- Change NOTHING else.\n- Return ONLY the updated Markdown body, NO YAML frontmatter, NO code block wrapper.`,
    },
  ], withDeterministicLlmContext(
    llmCfg,
    agentId,
    LLM_RESULT_CACHE_PURPOSES.KNOWLEDGE_UPDATE,
    // No temperature: providers like the Kimi coding endpoint allow exactly
    // one value per thinking mode and answer HTTP 400 for anything else.
    { maxTokens: 3000 },
    llmCfg?.callContext,
  ));

  if (!updated) return;

  let finalBody = updated;

  if (finalBody.split("\n").length > 200) {
    const compacted = await callLlm([
      {
        role: "user",
        content: `The following KNOWLEDGE.md body has grown too large (>200 lines). Consolidate it thematically — do NOT simply truncate.\n\nRules:\n1. Keep ALL unique facts and decisions — lose no information.\n2. Group thematically related entries under a shared point.\n3. Structure: Domain → Category → consolidated fact (Context-Tree style).\n4. If multiple entries describe the same concept from different angles, write one entry covering all aspects.\n5. Keep the date of the oldest merged entry.\n6. Target: max 150 lines, achieved only through real consolidation.\n7. Return ONLY the updated Markdown body, NO YAML frontmatter, NO code block wrapper.\n\n${finalBody}`,
      },
    ], withDeterministicLlmContext(
      llmCfg,
      agentId,
      LLM_RESULT_CACHE_PURPOSES.KNOWLEDGE_UPDATE,
      // No temperature: providers like the Kimi coding endpoint allow exactly
      // one value per thinking mode and answer HTTP 400 for anything else.
      { maxTokens: 4000 },
      llmCfg?.callContext,
    ));

    const compactedLines = compacted?.split("\n").length ?? Infinity;
    if (compacted && compactedLines <= 150) {
      finalBody = compacted;
    } else {
      logger?.warn?.(`memory-lancedb-namespaced: KNOWLEDGE.md compaction skipped: result (${compactedLines} lines) not ≤150`);
    }
  }

  // Re-attach frontmatter
  const finalContent = withFrontmatter(finalBody, { agentId, sourceMemoryIds: mergedSources, today });

  if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });
  const tmpPath = knowledgePath + ".tmp";
  writeFileSync(tmpPath, finalContent, "utf8");
  renameSync(tmpPath, knowledgePath);
}

// applyImportanceBoost, dedupResults, parseKnowledgeMd, getKnowledgeChunks,
// searchCanonical, runRecallPipeline kommen jetzt aus lib/recall-pipeline.js.
// stripFrontmatter, buildFrontmatter, withFrontmatter aus lib/frontmatter.js.

/**
 * Create the configured runtime reranker and bind local models to the host generation lifecycle.
 * @param {object} [rawRerankerCfg] Reranker configuration.
 * @param {object|null} [logger] OpenClaw logger.
 * @param {{credentialResolver?: Function, localModelGeneration?: object}} [runtimeOptions] Runtime dependencies.
 * @returns {{reranker: object|null, rerankerCfg: object}} Provider and normalized configuration.
 */
function createRuntimeRerankerProvider(rawRerankerCfg = {}, logger = null, {
  credentialResolver,
  localModelGeneration = null,
} = {}) {
  const rerankerCfg = normalizeRerankerConfig(rawRerankerCfg || {});
  let reranker = null;
  if (rerankerCfg.provider === "cohere" && rerankerCfg.enabled) {
    const primary = new CohereRerankerProvider({ ...rerankerCfg, credentialResolver });
    if ((rerankerCfg.fallbackProvider ?? "disabled") === "local-transformers") {
      const fallback = new LocalTransformersRerankerProvider({
        ...(rerankerCfg.local || {}),
        model: rerankerCfg.fallbackModel || rerankerCfg.local?.model || DEFAULT_LOCAL_RERANKER_MODEL,
        revision: rerankerCfg.fallbackRevision,
        cacheDir: rerankerCfg.fallbackCacheDir,
        logger,
        localModelGeneration,
      });
      reranker = new ChainedRerankerProvider(primary, fallback, logger);
    } else {
      reranker = new ChainedRerankerProvider(primary, null, logger);
    }
  } else if (rerankerCfg.provider === "local-transformers" && rerankerCfg.enabled) {
    const primary = new LocalTransformersRerankerProvider({
      ...(rerankerCfg.local || rerankerCfg),
      logger,
      localModelGeneration,
    });
    if (rerankerCfg.fallbackOnError !== false && rerankerCfg.fallbackProvider === "local-transformers") {
      if (rerankerCfg.fallbackModel === primary.model) {
        throw new Error("local reranker fallback model must differ from the primary model");
      }
      const fallback = new LocalTransformersRerankerProvider({
        model: rerankerCfg.fallbackModel,
        revision: rerankerCfg.fallbackRevision,
        cacheDir: rerankerCfg.fallbackCacheDir,
        logger,
        localModelGeneration,
      });
      reranker = new ChainedRerankerProvider(primary, fallback, logger);
    } else {
      reranker = primary;
    }
  }
  return { reranker, rerankerCfg };
}

// ============================================================================
// Plugin Definition
// ============================================================================

// Reaction-nudge capability detection (Humanization F6): computed at most once
// per process, cached across handler invocations.
let _reactionsCapability = null;
function makeReactionsCapabilityChecker(api) {
  return async function detectReactionsCapabilityCached() {
    if (_reactionsCapability !== null) return _reactionsCapability;
    try {
      const { detectReactionsCapability } = await import("./lib/reaction-directive.js");
      const runtimeConfig = typeof runtimeIfUsable(api)?.config?.current === "function"
        ? runtimeIfUsable(api).config.current()
        : (runtimeIfUsable(api)?.config && typeof runtimeIfUsable(api).config === "object" ? runtimeIfUsable(api).config : null);
      _reactionsCapability = detectReactionsCapability(runtimeConfig);
    } catch (_) { _reactionsCapability = false; }
    try { api.logger?.info?.(`plur1bus: reaction capability auto-detect → ${_reactionsCapability}`); } catch (_) { /* non-blocking */ }
    return _reactionsCapability;
  };
}

/**
 * Parse a text confirmation command without accepting shortened nonce prefixes.
 * @param {unknown} args Raw command arguments.
 * @returns {{requested: boolean, nonce: string, error?: string}} Parsed confirmation intent.
 */
export function parseConfirmationCommand(args) {
  const input = String(args || "").trim();
  if (!/^confirm(?:\s|:|$)/i.test(input)) {
    return { requested: false, nonce: "" };
  }
  const match = input.match(/^confirm(?:\s+|:)([0-9a-fA-F-]+)$/i);
  if (!match) return { requested: true, nonce: "", error: "invalid_format" };
  try {
    return { requested: true, nonce: safeUuid(match[1]) };
  } catch {
    return { requested: true, nonce: "", error: "invalid_format" };
  }
}

/**
 * Resolve the exact explicit identity tuple used for confirmation creation and completion.
 * @param {object} memoryCtx Canonical Task 1 memory request context.
 * @returns {{userId: string|undefined, chatId: string}} Confirmation identity binding.
 */
export function resolveConfirmationIdentity(memoryCtx) {
  const confirmationChatId = memoryCtx?.conversationPrincipal || memoryCtx?.chatId || "";
  if (!confirmationChatId) throw new Error("memory confirmation requires a verified conversation");
  return {
    userId: memoryCtx?.userId,
    chatId: confirmationChatId,
  };
}

const MAX_PENDING_CONFIRMATIONS = 1024;

/**
 * Remove one pending confirmation and its matching nonce index atomically.
 * @param {Map<string, object>} confirmationStore Pending confirmation records.
 * @param {Map<string, string>} confirmationIndex Exact nonce-to-record-key index.
 * @param {string} key Confirmation record key.
 * @param {object} [pending] Confirmation record when already read.
 */
function deletePendingConfirmation(confirmationStore, confirmationIndex, key, pending = confirmationStore.get(key)) {
  confirmationStore.delete(key);
  const nonce = pending?.nonce;
  if (nonce && confirmationIndex.get(nonce) === key) confirmationIndex.delete(nonce);
}

/**
 * Remove expired confirmation records before insertion or lookup.
 * @param {Map<string, object>} confirmationStore Pending confirmation records.
 * @param {Map<string, string>} confirmationIndex Exact nonce-to-record-key index.
 * @returns {Set<string>} Nonces removed because they had expired.
 */
function sweepExpiredPendingConfirmations(confirmationStore, confirmationIndex) {
  const expiredNonces = new Set();
  const now = Date.now();
  for (const [key, pending] of confirmationStore) {
    if (Number(pending?.expiresAt) <= now) {
      if (pending?.nonce) expiredNonces.add(pending.nonce);
      deletePendingConfirmation(confirmationStore, confirmationIndex, key, pending);
    }
  }
  return expiredNonces;
}

/**
 * Store a pending confirmation under its exact nonce and nonce+target keys.
 * @param {Map<string, object>} confirmationStore Pending confirmation records.
 * @param {Map<string, string>} confirmationIndex Exact nonce-to-record-key index.
 * @param {object} pending Confirmation returned by createConfirmation().
 * @returns {object} The stored confirmation.
 */
export function rememberPendingConfirmation(confirmationStore, confirmationIndex, pending) {
  const nonce = safeUuid(pending?.nonce);
  const targetId = safeUuid(pending?.targetId);
  const key = `${nonce}:${targetId}`;
  sweepExpiredPendingConfirmations(confirmationStore, confirmationIndex);
  const previousKey = confirmationIndex.get(nonce);
  if (previousKey && previousKey !== key) {
    deletePendingConfirmation(confirmationStore, confirmationIndex, previousKey);
  }
  while (confirmationStore.size >= MAX_PENDING_CONFIRMATIONS) {
    const oldest = confirmationStore.entries().next().value;
    if (!oldest) break;
    deletePendingConfirmation(confirmationStore, confirmationIndex, oldest[0], oldest[1]);
  }
  confirmationStore.set(key, pending);
  confirmationIndex.set(nonce, key);
  return pending;
}

/**
 * Redeem one exact pending confirmation without scanning or consuming mismatches.
 * @param {object} options Completion inputs.
 * @param {Map<string, object>} options.confirmationStore Pending confirmation records.
 * @param {Map<string, string>} options.confirmationIndex Exact nonce-to-record-key index.
 * @param {string} options.expectedCommand Required command name.
 * @param {object} options.memoryCtx Canonical Task 1 memory request context.
 * @param {string} options.nonce Complete canonical UUID nonce.
 * @returns {{pending?: object, error?: string}} Completion result.
 */
export function completePendingConfirmation({
  confirmationStore,
  confirmationIndex,
  expectedCommand,
  memoryCtx,
  nonce,
}) {
  try {
    safeUuid(nonce);
  } catch {
    return { error: "invalid_format" };
  }
  const expiredNonces = sweepExpiredPendingConfirmations(confirmationStore, confirmationIndex);
  if (expiredNonces.has(nonce)) return { error: "security.expired" };
  const key = confirmationIndex.get(nonce);
  if (!key) return { error: "not_found_or_expired" };
  const pending = confirmationStore.get(key);
  if (
    !pending
    || pending.nonce !== nonce
    || pending.command !== expectedCommand
    || key !== `${nonce}:${pending.targetId}`
  ) {
    return { error: "not_found_or_expired" };
  }
  const result = validateConfirmation(
    pending.callbackData,
    confirmationStore,
    resolveConfirmationIdentity(memoryCtx),
  );
  if (!result.valid) {
    if (!confirmationStore.has(key)) confirmationIndex.delete(nonce);
    return { error: result.reason || "invalid" };
  }
  deletePendingConfirmation(confirmationStore, confirmationIndex, key, pending);
  return { pending };
}

const plugin = {
  id: "memory-lancedb-namespaced",
  name: "Memory (LanceDB, per-Agent)",
  description: "Per-agent isolated LanceDB memory",
  kind: "memory",

  register(api, registrationDependencies = {}) {
    if (!registrationDependencies || typeof registrationDependencies !== "object" || Array.isArray(registrationDependencies)) {
      throw new TypeError("plugin registration dependencies must be an object");
    }
    const {
      importRouting,
      commandRuntimeHooks = null,
      hostEvents,
      skillWorkshop: registeredSkillWorkshop,
      handleObsidianBridgeCommand: registeredObsidianCommandHandler = handleObsidianBridgeCommand,
      shareCard: registeredShareCard = shareCard,
    } = registrationDependencies;
    if (importRouting !== undefined && typeof importRouting !== "function") {
      throw new TypeError("importRouting must be a function");
    }
    if (commandRuntimeHooks !== null && (typeof commandRuntimeHooks !== "object" || Array.isArray(commandRuntimeHooks))) {
      throw new TypeError("commandRuntimeHooks must be an object when provided");
    }
    if (hostEvents !== undefined && (hostEvents === null || typeof hostEvents.emit !== "function")) {
      throw new TypeError("hostEvents must expose emit(name, payload) when provided");
    }
    if (registeredObsidianCommandHandler !== handleObsidianBridgeCommand && typeof registeredObsidianCommandHandler !== "function") {
      throw new TypeError("handleObsidianBridgeCommand must be a function when provided");
    }
    if (typeof registeredShareCard !== "function") {
      throw new TypeError("shareCard must be a function when provided");
    }
    if (
      registeredSkillWorkshop !== undefined
      && registeredSkillWorkshop !== null
      && (typeof registeredSkillWorkshop !== "object" || Array.isArray(registeredSkillWorkshop))
    ) {
      throw new TypeError("skillWorkshop must be an object when provided");
    }
    const emitCommandRuntimeHook = (name, value) => {
      const hook = commandRuntimeHooks?.[name];
      if (hook !== undefined && typeof hook !== "function") {
        throw new TypeError(`commandRuntimeHooks.${name} must be a function when provided`);
      }
      return hook?.(value);
    };
    const rawPluginConfig = api.pluginConfig || {};
    const namespacesExplicit = Object.hasOwn(rawPluginConfig, "namespaces");
    let cfg = resolveEffectiveConfig(rawPluginConfig);
    const coordinatesLocalModelGeneration = shouldCoordinateLocalModelGeneration(api);
    const requiresActiveSharedModelOwner = typeof api.registrationMode === "string"
      && api.registrationMode !== "full";
    const sharesActiveLocalModel = coordinatesLocalModelGeneration
      || requiresActiveSharedModelOwner;
    const localModelGeneration = createLocalModelGenerationLifecycle({
      enabled: coordinatesLocalModelGeneration,
    });
    const credentialResolver = createConfiguredSecretInputResolver({
      getConfig: () => host.runtime?.config?.current?.() || api.config || {},
    });
    const host = createHostServices(api, { events: hostEvents });
    pluginLogger = host.logger;
    if (typeof api.registerMemoryCapability === "function") {
      // The host asks the memory-slot owner for a runtime; without it the
      // Memory page reports "memory plugin unavailable". Everything the
      // runtime touches is created further down in this function, so the
      // dependencies are closures that resolve when the host actually calls.
      const memoryHostRuntime = createMemoryHostRuntime({
        logger: host.logger,
        hostConfig: () => host.runtime?.config?.current?.() ?? api.config ?? {},
        dbPath: () => baseDbPath,
        provider: () => ({
          provider: normalizedEmbeddingCfg.provider,
          model: normalizedEmbeddingCfg.model || model,
        }),
        embed: (text) => embeddings.embed(text),
        cardCount: async (forAgentId) => {
          const snapshot = await controlHealth.snapshot();
          const entry = snapshot?.cards?.byAgent?.find((item) => item.id === forAgentId);
          return Number.isSafeInteger(entry?.cards) ? entry.cards : null;
        },
        readCard: ({ agentId: forAgentId, cardId }) => memoryDbAdapter.getCard(forAgentId, cardId),
        // Host-originated searches carry no session, workspace identity or
        // user principal, so this reads the agent's private partition only.
        recall: async ({ agentId: forAgentId, query, limit, signal }) => {
          const memoryCtx = resolveMemoryRequestContext({ agentId: forAgentId });
          return withAccessReadDbs(pool, sharedMemoryPool, forAgentId, { ...memoryCtx, logger: host.logger }, async (readDbs) => {
            const initialized = [];
            for (const entry of readDbs) {
              const ok = await entry.db.init();
              if (ok !== false && entry.db.table) initialized.push(entry);
            }
            if (initialized.length === 0) return [];
            const phaseTimer = createRecallPhaseTimer({
              softBudgetMs,
              hardTimeoutMs: runtimeScheduler.config.recallTimeoutMs,
              logger: host.logger,
            });
            const { memories } = await runMergedNamespaceRecall(initialized, {
              query,
              embeddings,
              topN: limit,
              budget: resolveRuntimeRecallBudget(query, limit, adaptiveBudgetCfg),
              adaptiveBudget: adaptiveBudgetCfg,
              recallMinScore,
              dedupEnabled,
              dedupJaccard,
              canonicalEnabled: false,
              canonicalMinScore,
              canonicalMaxItems,
              reranker,
              rerankCandidates,
              candidateTopK,
              rerankerTimeoutMs: rerankerCfg.timeoutMs ?? 5000,
              rerankerFallbackOnError: rerankerCfg.fallbackOnError !== false,
              summaryMaxWords,
              logger: host.logger,
              agentId: forAgentId,
              memoryCtx,
              workspaceKey: null,
              phaseTimer,
              softBudgetFallback,
              queryRefinerEnabled: false,
              associativeEnabled: false,
              ...(signal ? { signal } : {}),
            }, undefined, phaseTimer, { strictReadErrors: false });
            return memories;
          });
        },
      });
      api.registerMemoryCapability({
        deterministicRecallToolName: "memory_recall",
        supportsPrivateTranscriptRecall: false,
        runtime: memoryHostRuntime,
      });
    } else {
      host.logger.info(
        "memory-lancedb-namespaced: OpenClaw registerMemoryCapability API unavailable; legacy tool and hook surfaces remain active.",
      );
    }
    const cronDirectDispatchReady = process.env.NODE_TEST_CONTEXT
      ? true
      : inspectCronNativeCapabilities(api);
    const openClawSkillWorkshop = registeredSkillWorkshop !== undefined
      ? registeredSkillWorkshop
      : (
          typeof api.registerGatewayMethod === "function" && typeof api.registerCli === "function"
            ? createOpenClawSkillWorkshopClient()
            : null
        );
    registerUnsafeDirectCronGuard({ api, cronDirectDispatchReady, guardUnsafeDirectCronTurn });
    const detectReactionsCapabilityCached = makeReactionsCapabilityChecker(api);
    const baseDbPath = api.resolvePath(cfg.baseDbPath || DEFAULT_BASE_DB_PATH);
    const epistemicCutoffBoot = ensureEpistemicCutoff(baseDbPath);
    if (!epistemicCutoffBoot.ok) {
      host.logger.warn(`memory-lancedb-namespaced: epistemic cutoff unavailable (${epistemicCutoffBoot.reason})`);
    }
    const configuredNamespaceLayout = resolveNamespaceLayout(baseDbPath, cfg.namespaces || {}, {
      explicit: namespacesExplicit,
      path: `${PLUGIN_CONFIG_PATH}.namespaces`,
    });
    const providerMigration = applyLegacyProviderDefaults(cfg, { baseDbPath });
    cfg = providerMigration.config;
    const llmResultCache = createLlmResultCache({
      enabled: cfg.runtime?.llmResultCacheEnabled !== false,
      ttlMs: cfg.runtime?.llmResultCacheTtlMs,
      maxEntries: cfg.runtime?.llmResultCacheMaxEntries ?? 256,
      persist: cfg.runtime?.llmResultCachePersist === true,
      maxBytes: cfg.runtime?.llmResultCacheMaxBytes ?? 67_108_864,
      metrics: cfg.runtime?.llmResultCacheMetrics !== false,
      baseDbPath,
      logger: host.logger,
    });
    // 7.12.58: Hintergrund-Features ohne eigenes Modell folgten dem Hauptmodell
    // des Agenten. Episodenextraktion, Traumdeutung, Gesprächsanalyse und die
    // Verdichtung bekommen hier fest `{}` übergeben, können also gar kein
    // eigenes Modell tragen — sie verbrauchten damit das Kontingent des
    // teuersten Modells für Arbeit, die nichts vom laufenden Gespräch braucht.
    // `llmRouter.defaultModel` ist der gemeinsame Boden dafür. Ein
    // feature-eigenes Modell hat weiterhin Vorrang, und Features mit eigenem
    // Transport bleiben unberührt: dort wäre ein fremdes Modell am fremden
    // Endpunkt sinnlos.
    const featureDefaultModel = typeof cfg.llmRouter?.defaultModel === "string"
      && cfg.llmRouter.defaultModel.trim()
      ? cfg.llmRouter.defaultModel.trim()
      : "";
    const createFeatureRoute = (feature, featureConfig = {}) => {
      const routeConfig = { ...featureConfig };
      const hasOwnTransport = Boolean(routeConfig.baseUrl || routeConfig.apiKey || routeConfig.headers);
      if (featureDefaultModel && !hasOwnTransport
        && !(typeof routeConfig.model === "string" && routeConfig.model.trim())) {
        routeConfig.model = featureDefaultModel;
      }
      let credentialUnavailable = false;
      if (typeof routeConfig.apiKey === "string" && routeConfig.apiKey.trim()) {
        try {
          const unresolvedReference = routeConfig.apiKey.replace(/\$\{[^{}]+\}/g, "");
          if (unresolvedReference.includes("${")) {
            throw new Error("Malformed environment reference");
          }
          routeConfig.apiKey = resolveEnvVars(routeConfig.apiKey);
        } catch (_) {
          credentialUnavailable = true;
          delete routeConfig.apiKey;
        }
      }
      const route = resolveFeatureLlmRoute(routeConfig, {
        feature,
        agentModels: featureModelOverrides(cfg, feature),
        runtimeLlm: host.runtime?.llm,
        logger: host.logger,
        resultCache: llmResultCache,
        credentialUnavailable,
        // 7.12.55: Nur wenn der Betreiber es einschaltet, schreibt der Router
        // die redigierte Fehlermeldung in eine eigene Datei — nie ins Log.
        diagnosticsPath: cfg.llmRouter?.errorDiagnostics === true
          ? join(baseDbPath, "llm-router-errors.log")
          : "",
      });
      return isLlmRouteAvailable(route) ? route : null;
    };
    if (providerMigration.changed) {
      host.logger.info(
        `memory-lancedb-namespaced: applied local provider defaults for empty legacy install (${providerMigration.migrations.join(", ")})`
      );
    }

    const obsidianBridgeCfg = cfg.obsidianBridge || {};
    const configuredObsidianWorkspaces = obsidianBridgeCfg.enabled !== false
      ? discoverObsidianWorkspaces(obsidianBridgeCfg)
      : [];
    const obsidianVaultsConfirmed = configuredObsidianWorkspaces.length > 0
      && configuredObsidianWorkspaces.every((workspace) => {
        const workspaceIdentity = normalizeWorkspaceTarget(
          workspace.workspaceId,
          "Obsidian setup workspace",
        );
        return isOwnedVaultConfirmed({
          baseDbPath,
          memoryCtx: {
            agentId: workspace.agentId,
            workspaceIdentity,
            workspaceId: workspaceIdentity,
          },
          vaultPath: workspace.path,
        });
      });

    // Explicit-profile setup notices: protected receipts are the runtime truth;
    // the safety-gate config bit alone does not mean confirmation is still pending.
    const applyBlocked = isApplyBlocked(cfg, { vaultConfirmed: obsidianVaultsConfirmed });
    if (applyBlocked.blocked) {
      if (applyBlocked.reason === "pending_setup") {
        const pending = detectPendingFeatures(cfg, { vaultConfirmed: obsidianVaultsConfirmed });
        for (const p of pending) {
          // A feature the operator explicitly switched on and left unconfigured
          // is worth a warning. One that is merely on by default is not: with
          // opt-out that would warn every user on every start about something
          // they never asked for.
          reportDormantFeature(host.logger, {
            explicit: p.explicit,
            message: `memory-lancedb-namespaced: PENDING SETUP — ${p.feature}: ${p.reason}. Run /plur1bus start for the setup status.`,
          });
        }
      }
    }

    const obsidianBridgeEnabled = obsidianBridgeCfg.enabled !== false;

    const embeddingCfg = cfg.embedding || {};
    const localModelCacheDir = resolveLocalModelCacheDir(embeddingCfg);
    const nonCommercialModelAccepted = cfg.modelPreparation?.acceptNonCommercialLicense === true;
    const normalizedEmbeddingCfg = normalizeEmbeddingConfig(embeddingCfg, {
      mode: "existing",
      acceptNonCommercialLicense: nonCommercialModelAccepted,
    });
    const apiKey = normalizedEmbeddingCfg.provider === "local-transformers"
      ? undefined
      : resolveConfiguredApiKey(normalizedEmbeddingCfg, "${OPENAI_API_KEY}");
    const model = normalizedEmbeddingCfg.model || DEFAULT_MODEL;
    const baseUrl = normalizedEmbeddingCfg.baseUrl;
    const dimensions = normalizedEmbeddingCfg.dimensions;
    const embeddingGenerationLayout = resolveEmbeddingGenerationLayout({
      stateRoot: configuredNamespaceLayout.baseDir,
      namespaceLayout: configuredNamespaceLayout,
      selection: cfg.reembedding || {},
    });
    const namespaceLayout = embeddingGenerationLayout.dataLayout;
    const fallbackEmbeddingCfg = normalizedEmbeddingCfg.fallback
      ? {
          apiKey: normalizedEmbeddingCfg.fallback.apiKey
            ? resolveEnvVars(normalizedEmbeddingCfg.fallback.apiKey)
            : resolveOptionalEnvVars("${OPENAI_API_KEY_FALLBACK}"),
          model: normalizedEmbeddingCfg.fallback.model || model,
          baseUrl: normalizedEmbeddingCfg.fallback.baseUrl,
        }
      : null;
    if (fallbackEmbeddingCfg) host.logger.info(`memory-lancedb-namespaced: embedding fallback configured (${fallbackEmbeddingCfg.model} @ ${fallbackEmbeddingCfg.baseUrl || "openai"})`);
    const autoCapture = cfg.autoCapture !== false;
    const autoRecall = cfg.autoRecall !== false;

    // v1.8.0 — Recall-Quality knobs (declared early because runtime scheduler consumes eventLoopLagSnapshot)
    const recallCfg = cfg.recall || {};
    // Seit 19.09.2026 nur noch zur Config-Validierung aufgelöst — die Pipeline
    // liest diesen Wert nicht mehr, darum wird er an keinen
    // runRecallPipeline/runMergedNamespaceRecall-Aufruf mehr weitergereicht.
    const importanceBoost  = recallCfg.importanceBoost  ?? 0.3;
    const dedupEnabled     = recallCfg.dedup            !== false; // default on
    const dedupJaccard     = recallCfg.dedupJaccard     ?? 0.78;
    const canonicalEnabled = recallCfg.canonicalFirst   !== false; // default on
    const canonicalMinScore = recallCfg.canonicalMinScore ?? 0.30;
    const canonicalMaxItems = recallCfg.canonicalMaxItems ?? 5;
    const maxPromptMemories = normalizeBoundedRecallInteger(recallCfg.maxPromptMemories, 12, 1, 100);
    const candidateTopK     = normalizeBoundedRecallInteger(recallCfg.candidateTopK, 40, 1, 100);
    const queryRefinerEnabled = recallCfg.queryRefinement?.enabled !== false;
    const adaptiveBudgetCfg = recallCfg.adaptiveBudget || {};
    const semanticCompressionCfg = recallCfg.semanticCompression || {};
    const halfLifeOverrides = recallCfg.halfLifeDaysMap   || {};
    const softBudgetMs      = recallCfg.softBudgetMs      ?? 35_000;
    const softBudgetFallback = recallCfg.softBudgetFallback !== false;
    const recallEventLoopLagSnapshot = recallCfg.eventLoopLagSnapshot !== false;
    const runtimeScheduler = createBackgroundMemoryScheduler({
      config: { ...(cfg.runtime || {}), eventLoopLagSnapshot: recallEventLoopLagSnapshot },
      logger: host.logger,
    });

    // Configurable thresholds
    const recallMinScore     = cfg.recallMinScore     ?? 0.15;
    const autoRecallMinScore = cfg.autoRecallMinScore ?? 0.2;
    const duplicateThreshold = cfg.duplicateThreshold ?? 0.95;
    const forgetThreshold    = cfg.forgetThreshold    ?? 0.3;
    const summaryMaxWords    = cfg.summaryMaxWords    ?? 150;
    const semanticLensCfg   = cfg.semanticLens || recallCfg.semanticLens || {};

    // Reply-based Outcome Tracking config (default ON — additive, append-only feedback loop)
    const replyOutcomeCfg = cfg.replyOutcomeTracking || {};
    const replyOutcomeEnabled = replyOutcomeCfg.enabled !== false;
    const replyOutcomeMaxAgeMs = replyOutcomeCfg.maxAgeMs;
    const replyOutcomeMaxMemoryIds = replyOutcomeCfg.maxMemoryIds;
    const replyOutcomeMaxReplyChars = replyOutcomeCfg.maxReplyChars;
    const replyOutcomeMaxAssistantChars = replyOutcomeCfg.maxAssistantChars;
    const replyOutcomeMaxOutcomeLogEntries = replyOutcomeCfg.maxOutcomeLogEntries;
    const replyOutcomeMaxFeedbackLogEntries = replyOutcomeCfg.maxFeedbackLogEntries;
    // 7.12.30: Die Memory-Dynamik des Reply-Outcome-Trackings (LanceDB-Updates
    // je erinnerter Erinnerung) laeuft nicht mehr im Prompt-Hook, sondern
    // seriell je Agent, angestossen nach dem Recall des Turns.
    const replyOutcomeDynamics = getSharedDeferredDynamicsQueue({
      logger: host.logger,
      maxBacklog: Math.max(1, Number(replyOutcomeCfg.dynamicsMaxBacklog) || 20),
      fallbackDelayMs: Math.max(0, Number(replyOutcomeCfg.dynamicsFallbackDelayMs ?? 10_000)),
    });
    const REPLY_OUTCOME_SYNC_LOG_MS = 1000;

    // Temporal continuity context config
    const temporalContextCfg = cfg.temporalContext || {};
    const temporalContextEnabled = temporalContextCfg.enabled !== false;

    // P2 Recall Decision Trace config
    const traceCfg = cfg.recall?.decisionTrace || {};
    const traceEnabled = traceCfg.enabled !== false;
    const traceInPrompt = traceEnabled && traceCfg.includeInPrompt === true;

    const riCfg = cfg.retroactiveInterference ?? {};

    // GC config
    const gcCfg = cfg.gc || {};
    const gcEnabled = gcCfg.enabled !== false; // default true

    // TTL presets
    const TTL_MAP = { session: 86_400_000, short: 14 * 86_400_000 };

    // Merging config
    const mergingCfg = cfg.merging || {};
    const mergingEnabled = mergingCfg.enabled !== false;
    const mergingAutoApply = mergingCfg.autoApply === true;
    const mergingThreshold = mergingCfg.threshold ?? 0.70;
    const mergingLlmCfg = mergingEnabled
      ? createFeatureRoute("merging", mergingCfg)
      : null;
    if (mergingEnabled && mergingLlmCfg) {
      host.logger.info(`memory-lancedb-namespaced: merging enabled (threshold: ${mergingThreshold}, route: ${mergingLlmCfg.kind})`);
    }

    // Dreaming-Narrative config: menschenähnliche, stimmungsgefärbte Träume
    // als additive Schicht über Light/REM Dream. Default an, aber effektiv
    // nur aktiv wenn mergingLlmCfg existiert (gleiche Vorbedingung wie die
    // Traum-Engines selbst).
    const dreamNarrativeRawCfg = cfg.dreaming?.narrative || {};
    const dreamNarrativeCfg = {
      enabled: dreamNarrativeRawCfg.enabled !== false,
      temperature: dreamNarrativeRawCfg.temperature ?? 0.9,
      storeAsMemory: dreamNarrativeRawCfg.storeAsMemory !== false,
      importanceMax: dreamNarrativeRawCfg.importanceMax ?? 0.45,
      // The narrative also goes into the agent's DREAMS.md, which is what the
      // host's Dreams page shows. Off only on explicit request.
      diary: dreamNarrativeRawCfg.diary !== false,
      timezone: typeof cfg.timezone === "string" && cfg.timezone.trim() ? cfg.timezone.trim() : null,
    };
    const resolveTemperamentName = (forAgentId) =>
      cfg.emotion?.temperaments?.[forAgentId]?.preset || null;

    // Schicht 1.5 config
    const schicht15Cfg = cfg.schicht15 || {};
    const schicht15Enabled = schicht15Cfg.enabled !== false;
    const schicht15MinImportance = schicht15Cfg.minImportance ?? 0.7;
    const schicht15MaxPromotions = schicht15Cfg.maxPromotionsPerRun ?? 3;
    const schicht15LlmCfg = schicht15Enabled
      ? createFeatureRoute("schicht15", schicht15Cfg)
      : null;
    if (schicht15LlmCfg) {
      host.logger.info(`memory-lancedb-namespaced: schicht15 enabled (minImportance: ${schicht15MinImportance}, route: ${schicht15LlmCfg.kind})`);
    }

    // Skill Miner config
    const skillMinerCfg = cfg.skillMiner || {};
    const skillMinerEnabled = skillMinerCfg.enabled !== false;
    const skillMinerLlmCfg = skillMinerEnabled
      ? createFeatureRoute("skillMiner", skillMinerCfg)
      : null;
    if (skillMinerLlmCfg) {
      host.logger.info(`memory-lancedb-namespaced: skillMiner enabled (route: ${skillMinerLlmCfg.kind})`);
    }
    // 7.12.48: Auto-Apply geminter Skills. "host" folgt dem Selbstlern-Modus
    // des Hosts (skills.workshop.autonomous.mode, ungesetzt = auto), damit
    // eine Installation, die dem Host nur Vorschlaege erlaubt, auch vom Miner
    // nur Vorschlaege bekommt.
    const hostSkillWorkshopMode = () => {
      const mode = (host.runtime?.config?.current?.() || api.config || {})?.skills?.workshop?.autonomous?.mode;
      return mode === "off" || mode === "propose" ? mode : "auto";
    };
    const skillMinerAutoApplyMode = skillMinerCfg.autoApply === "on" || skillMinerCfg.autoApply === "off"
      ? skillMinerCfg.autoApply
      : "host";
    const skillMinerAutoApplyEffective = () => skillMinerAutoApplyMode === "on"
      || (skillMinerAutoApplyMode === "host" && hostSkillWorkshopMode() === "auto");

    // Generic enhancement routes remain behind their existing feature gates,
    // but each prompt owns its model-selection descriptor.
    const captureSummaryLlmCfg = createFeatureRoute("capture-summary", {});
    const recallQueryLlmCfg = createFeatureRoute("recall-query-summary", {});
    const memoryCompactionLlmCfg = createFeatureRoute("memory-compaction", {});
    const conflictResolutionLlmCfg = createFeatureRoute("conflict-resolution", {});
    const remPatternLlmCfg = createFeatureRoute("rem-pattern-analysis", {});
    const conversationInsightsLlmCfg = createFeatureRoute("conversation-insights", {});
    const dreamNarrativeLlmCfg = createFeatureRoute("dream-narrative", {});
    const dreamEchoLlmCfg = createFeatureRoute("dream-echo", {});
    const episodeExtractionLlmCfg = createFeatureRoute("episode-extraction", {});
    const afterthoughtLlmCfg = createFeatureRoute("afterthought", cfg.afterthought || {});
    const personaVoiceLlmCfg = createFeatureRoute("persona-voice", cfg.personaVoice || {});
    // 7.12.38: Obergrenze des verwalteten Blocks (Seed + Gelerntes, Default 24)
    // und daraus abgeleiteter Deckel der injizierten Stimm-Direktive
    // (Formel wie directiveCharsForBullets in lib/persona-voice.js, das lazy
    // geladen wird: Zeilen x 130 + 80). Bremsen der taeglichen Evolution:
    // fruehestens alle N Tage und nur mit N neuen echten Outcomes.
    const personaMaxBullets = Number.isFinite(Number(cfg.personaVoice?.maxBullets)) && Number(cfg.personaVoice.maxBullets) >= 6
      ? Math.floor(Number(cfg.personaVoice.maxBullets))
      : 24;
    const personaDirectiveMaxChars = Number.isFinite(Number(cfg.personaVoice?.maxDirectiveChars)) && Number(cfg.personaVoice.maxDirectiveChars) >= 200
      ? Math.floor(Number(cfg.personaVoice.maxDirectiveChars))
      : personaMaxBullets * 130 + 80;
    const personaEvolveMinDaysBetween = Number.isFinite(Number(cfg.personaVoice?.minDaysBetween)) && Number(cfg.personaVoice.minDaysBetween) >= 0
      ? Number(cfg.personaVoice.minDaysBetween)
      : 2;
    const personaEvolveMinOutcomes = Number.isFinite(Number(cfg.personaVoice?.minOutcomes)) && Number(cfg.personaVoice.minOutcomes) >= 1
      ? Math.floor(Number(cfg.personaVoice.minOutcomes))
      : 10;
    const wikiLlmCfg = createFeatureRoute("wiki", {});
    const overlayLlmCfg = createFeatureRoute("continuity-overlay", cfg.continuityEngine?.overlays || {});
    const overlayAuditLlmCfg = createFeatureRoute("overlay-audit-contradiction", {});
    const memoryTextContradictionLlmCfg = createFeatureRoute("memory-text-contradiction", {});

    // Emotion Tier Config
    const emotionCfg = cfg.emotion || {};
    const emotionTier = emotionCfg.tier || "auto";
    const emotionT2Enabled = emotionCfg.t2?.enabled !== false;
    // Tier 3: enabled if wanted AND its feature-local route is available.
    // onlyWhenProviderAvailable (default: true) makes T3 soft-skip instead of error when no provider.
    const emotionT3WantsEnabled = emotionCfg.t3?.enabled !== false;
    // Abschluss-Review, Important 6: die Route wird jetzt IMMER aufgelöst,
    // unabhängig von emotionT3WantsEnabled — sonst friert eine Abschaltung
    // von emotion.t3 (oder ein Provider-Ausfall bei der Registrierung) auch
    // die Importance-Klärung im emotion-refine-Cron für immer ein, obwohl der
    // Encoding-Call (lib/encoding-llm.js) davon konzeptionell unabhängig ist.
    // emotionT3WantsEnabled bleibt das alleinige Tor für die eigentliche
    // Tier-3-Emotionsklassifikation (setEmotionConfig, Capture-Pfad unten).
    const emotionT3LlmCfg = createFeatureRoute("emotionT3", emotionCfg.t3 || {});
    const emotionT3HasProvider = Boolean(
      emotionT3LlmCfg
      && (emotionT3LlmCfg.kind === LLM_ROUTE_KINDS.DIRECT_OVERRIDE
        || typeof host.runtime?.llm?.complete === "function"),
    );
    const emotionT3OnlyWhenProviderAvailable = emotionCfg.t3?.onlyWhenProviderAvailable !== false;
    const emotionT3Enabled = emotionT3WantsEnabled && (emotionT3HasProvider || !emotionT3OnlyWhenProviderAvailable);
    const emotionT3CallLlm = (emotionT3Enabled && emotionT3LlmCfg)
      ? /**
         * Call the emotion provider with optional agent-scoped cache context.
         * @param {Array<object>} messages
         * @param {{agentId?: string, runtimeLlm?: object, signal?: AbortSignal}} [context]
         * @returns {Promise<string|null>}
         */
        (messages, context = {}) => {
          const emotionLlmCfg = withLlmCallContext(
            {
              ...emotionT3LlmCfg,
              maxTokens: 300,
              // No temperature: some providers (Kimi coding) reject anything
              // but one exact value per thinking mode and answer HTTP 400.
              // Letting the provider default apply keeps the call portable.
              disableThinking: true,
            },
            context.agentId,
            LLM_RESULT_CACHE_PURPOSES.EMOTION_CLASSIFICATION,
            { runtimeLlm: context.runtimeLlm, signal: context.signal },
          );
          return context.agentId
            ? callLlm(messages, withLlmCallContext(
                withLlmResultCacheContext(
                  { ...emotionLlmCfg },
                  context.agentId,
                  LLM_RESULT_CACHE_PURPOSES.EMOTION_CLASSIFICATION,
                ),
                context.agentId,
                LLM_RESULT_CACHE_PURPOSES.EMOTION_CLASSIFICATION,
                { runtimeLlm: context.runtimeLlm, signal: context.signal },
              ))
            : callLlm(messages, emotionLlmCfg);
        }
      : null;
    if (emotionT3Enabled && emotionT3LlmCfg) {
      host.logger.info(`memory-lancedb-namespaced: emotion tier-3 enabled (route: ${emotionT3LlmCfg.kind})`);
    } else if (emotionT3WantsEnabled && !emotionT3HasProvider) {
      host.logger.info("memory-lancedb-namespaced: emotion tier-3 deferred — no LLM provider configured (onlyWhenProviderAvailable)");
    }
    // Abschluss-Review, Important 6: eigene Call-Funktion für den
    // emotion-refine-Cron (lib/encoding-llm.js), unabhängig von
    // emotionT3Enabled — verfügbar, sobald irgendein Provider existiert,
    // selbst wenn der Operator emotion.t3 selbst abgeschaltet hat. Sonst
    // friert eine Abschaltung von emotion.t3 (oder ein Provider-Ausfall bei
    // der Registrierung) auch die Importance-Klärung für immer ein, obwohl
    // der Encoding-Call davon konzeptionell unabhängig ist. Gleicher Aufbau
    // wie emotionT3CallLlm oben, bewusst nicht als gemeinsame Hilfsfunktion
    // extrahiert, damit dessen bestehende Scoping-Verträge unangetastet
    // bleiben.
    const encodingLlmCfg = createFeatureRoute("emotion-encoding", emotionCfg.t3 || {});
    const encodingHasProvider = Boolean(encodingLlmCfg && (encodingLlmCfg.kind === LLM_ROUTE_KINDS.DIRECT_OVERRIDE
      || typeof host.runtime?.llm?.complete === "function"));
    const encodingCallLlm = encodingHasProvider
      ? (messages, context = {}) => {
          const emotionLlmCfg = withLlmCallContext(
            {
              ...encodingLlmCfg,
              // Messung + Begründung bei der Konstante
              // EMOTION_REFINE_ENCODING_MAX_TOKENS weiter unten (voller
              // Vorwärtsverweis: diese Funktion wird erst vom
              // emotion-refine-Cron aufgerufen, lange nachdem die
              // Konstante beim Registrieren initialisiert wurde).
              maxTokens: EMOTION_REFINE_ENCODING_MAX_TOKENS,
              disableThinking: true,
            },
            context.agentId,
            LLM_RESULT_CACHE_PURPOSES.EMOTION_CLASSIFICATION,
            { runtimeLlm: context.runtimeLlm, signal: context.signal },
          );
          return context.agentId
            ? callLlm(messages, withLlmCallContext(
                withLlmResultCacheContext(
                  { ...emotionLlmCfg },
                  context.agentId,
                  LLM_RESULT_CACHE_PURPOSES.EMOTION_CLASSIFICATION,
                ),
                context.agentId,
                LLM_RESULT_CACHE_PURPOSES.EMOTION_CLASSIFICATION,
                { runtimeLlm: context.runtimeLlm, signal: context.signal },
              ))
            : callLlm(messages, emotionLlmCfg);
        }
      : null;
    // Emotionale Dynamik (Spec 2026-07-01): aggressive T3-Eskalation,
    // Timeout-Schutz, Recall-Gewicht und Decay-Kopplung.
    const emotionT3EscalationConfidence = emotionCfg.t3?.escalationConfidence ?? 0.85;
    const emotionT3TimeoutMs = emotionCfg.t3?.timeoutMs ?? 4000;
    const emotionMoodInfluence = emotionCfg.moodInfluence ?? 0.3;
    const emotionIntensityHalfLifeFactor = emotionCfg.intensityHalfLifeFactor ?? 1.0;
    // R16 (Abschluss-Review 19.09.2026, Critical 1): Blitzlicht-Kodierung ist
    // erst für Phase 3 vorgesehen, nach einem Pilotlauf, der die
    // 0,70-Schwelle an einer echten Importance-Verteilung kalibriert. Default
    // aus hält sowohl den Capture-Pfad (90-Tage-Boden, memory-dynamics.js)
    // als auch den neuen Refine-Pfad (kein Blitzlicht, encoding-llm.js) exakt
    // auf dem Verhalten von vor diesem Branch.
    const memoryDynamicsCfg = cfg.memoryDynamics || {};
    const flashbulbEncodingEnabled = memoryDynamicsCfg.flashbulbEncoding === true;
    setEmotionConfig({
      tier: emotionTier,
      t2: { enabled: emotionT2Enabled },
      t3: { enabled: emotionT3Enabled, callLlm: emotionT3CallLlm, apiKey: null, baseUrl: undefined, timeoutMs: emotionT3TimeoutMs },
      escalationConfidence: emotionT3EscalationConfidence,
    });
    if (emotionTier !== "auto") {
      host.logger.info(`memory-lancedb-namespaced: emotion tier locked to ${emotionTier}`);
    }
    // 7.12.22: Tier 3 fuer neue Erinnerungen laeuft nicht mehr im Turn. Die
    // LLM-Klassifikation je gespeicherter Erinnerung (4–16 s, mehrere je
    // Turn) dominierte das agent_end-Budget. Im Modus "deferred" (Default)
    // bewertet der Capture-Pfad nur lexikalisch (Tier 1/2), speichert das
    // Ergebnis vorlaeufig und markiert Zeilen unter der Eskalationsschwelle
    // als emotionStatus=pending_t3; der Feature-Cron `emotion-refine` holt
    // Tier 3 nach. Die Stimmungszeile der Antwort ist davon unberuehrt, sie
    // entsteht im Recall aus der aktuellen Nachricht. Ein fest verdrahteter
    // Tier (emotion.tier != auto) und captureMode "inline" behalten das alte
    // Verhalten.
    const emotionT3CaptureMode = emotionCfg.t3?.captureMode === "inline" ? "inline" : "deferred";
    const emotionDeferredCapture = emotionT3CaptureMode === "deferred" && emotionT3Enabled && emotionTier === "auto";
    // 7.12.23: Kern-Erinnerungen (importance ab dieser Schwelle) bekommen im
    // Cron immer Tier 3, auch wenn Tier 1/2 sicher "neutral" sagt — dort
    // wirkt die emotionale Intensitaet auf Recall-Gewicht und Zerfall, und
    // das Lexikon uebersieht Ironie oder Sorge im Sachton. Werte > 1 schalten
    // die Regel ab. Default im Normalizer, nicht im Schema.
    const emotionT3RefineImportanceMinRaw = Number(emotionCfg.t3?.refineImportanceMin);
    const emotionT3RefineImportanceMin = Number.isFinite(emotionT3RefineImportanceMinRaw) && emotionT3RefineImportanceMinRaw >= 0
      ? emotionT3RefineImportanceMinRaw
      : 0.9;
    if (emotionT3Enabled) {
      host.logger.info(`memory-lancedb-namespaced: emotion tier-3 capture mode ${emotionDeferredCapture ? "deferred (emotion-refine cron)" : "inline"}`);
    }
    /**
     * Emotionsbewertung fuer eine neu zu speichernde Erinnerung.
     * @param {string} text
     * @param {{agentId?: string, signal?: AbortSignal, importance?: number}} [context]
     * @returns {Promise<{emotion: object, emotionStatus: "final"|"pending_t3"}>}
     */
    const classifyEmotionForStore = async (text, context = {}) => {
      if (!emotionDeferredCapture) {
        const emotion = await inferEmotionalValenceAsync(text, "user", null, context);
        return { emotion, emotionStatus: "final" };
      }
      // Gleiche Tier-1/2-Route wie sonst, nur ohne den Tier-3-Sprung; der
      // Cron greift genau dort, wo der Router eskaliert haette.
      const { importance, ...engineContext } = context;
      const emotion = await inferEmotionalValenceAsync(text, "user", null, { ...engineContext, skipTier3: true });
      // Fehlende Konfidenz (synchroner Tier-1-Fallback) zaehlt als unsicher.
      const confident = Number.isFinite(emotion?.confidence) && emotion.confidence >= emotionT3EscalationConfidence;
      const coreMemory = Number.isFinite(Number(importance)) && Number(importance) >= emotionT3RefineImportanceMin;
      return { emotion, emotionStatus: confident && !coreMemory ? "final" : "pending_t3" };
    };

    // Base DB path — früh auflösen, damit Meta-Cognition-State-Read (und
    // spätere Initialisierung) denselben Pfad verwenden.
    // Meta-Cognition Config
    const metaCognitionCfg = cfg.metaCognition || {};
    const metaCognitionEnabled = metaCognitionCfg.enabled !== false;
    const metaCognitionSessionThreshold = metaCognitionCfg.sessionThreshold ?? 50;
    const metaCognitionIntervalMs = (metaCognitionCfg.intervalDays ?? 7) * 24 * 60 * 60 * 1000;
    const metaCognitionLlmReport = metaCognitionCfg.llmReport === true;

    // Reminder-Extraktion aus Auto-Capture (reminders.autoExtract: false schaltet ab)
    const reminderAutoExtract = (cfg.reminders || {}).autoExtract !== false;
    // Shared mutable state: the capture hook rebinds these at turn time
    // (index.js:10857-10858), so they must survive being passed into a module.
    const metaReflectionState = { sessionCount: 0, lastAt: 0 };
    try {
      const metaStatePath = join(baseDbPath, "_meta-cognition-state.json");
      if (existsSync(metaStatePath)) {
        const metaState = JSON.parse(readFileSync(metaStatePath, "utf8"));
        metaReflectionState.sessionCount = metaState.sessionCountSinceReflection || 0;
        metaReflectionState.lastAt = metaState.lastReflectionAt || 0;
      }
    } catch (_) {
      // ignore corrupt state
    }

    // v2.1.1: hard-fail wenn Provider-Modell ohne dimensions konfiguriert ist.
    // OpenAI-Modelle: aus EMBEDDING_DIMENSIONS-Map fallback.
    // Nicht-OpenAI-Modelle (OpenRouter, custom baseUrl, etc.): MÜSSEN explizit
    // dimensions in der Config haben, sonst weiß die LanceDB nicht welche
    // Vektor-Dim erwartet wird → Schema-Mismatch beim ersten store.
    let vectorDim = dimensions;
    if (!vectorDim) {
      vectorDim = EMBEDDING_DIMENSIONS[model];
      if (!vectorDim) {
        const isOpenAi = !model.includes("/") || model.startsWith("openai/") || model.startsWith("text-embedding-");
        if (isOpenAi) {
          // Unbekanntes OpenAI-Modell — defensive default, mit Warnung
          vectorDim = 1536;
          host.logger.warn(`memory-lancedb-namespaced: unbekanntes OpenAI-Modell '${model}' — fallback auf 1536 dimensions. Empfohlen: 'dimensions' explizit setzen.`);
        } else {
          // Provider-Modell (OpenRouter, etc.) ohne dimensions — hart fail
          throw new Error(
            `memory-lancedb-namespaced: Modell '${model}' (Provider: ${baseUrl || "?"}) hat keine konfigurierten 'dimensions'. ` +
            `Setze plugins.entries.memory-lancedb-namespaced.config.embedding.dimensions explizit ` +
            `(z.B. 1024 für BAAI/Mistral, 2048 für NVIDIA-Nemotron, 3072 für Gemini). ` +
            `Test-Call: curl -H "Authorization: Bearer KEY" -d '{"model":"${model}","input":"test","encoding_format":"float"}' ${baseUrl || "https://api.openai.com/v1"}/embeddings ` +
            `→ data[0].embedding.length lesen.`
          );
        }
      }
    }
    const activeEmbeddingFingerprint = embeddingFingerprintFromNormalizedConfig({
      ...normalizedEmbeddingCfg,
      dimensions: vectorDim,
    });
    const activeEmbeddingFingerprintId = embeddingFingerprintId(activeEmbeddingFingerprint);
    registerOpenClawMemoryEmbeddingProviders(api, cfg, requiresActiveSharedModelOwner
      ? { scopedEmbeddingIpc: { stateRoot: baseDbPath, fingerprintId: activeEmbeddingFingerprintId } }
      : {});
    if (cfg.reembedding && (
      cfg.reembedding.fingerprintId !== activeEmbeddingFingerprintId
      || cfg.reembedding.dimensions !== vectorDim
    )) {
      throw new Error(
        "memory-lancedb-namespaced: active reembedding selection does not match the configured embedding fingerprint",
      );
    }
    const reembeddingStateStore = createMigrationStateStore({ stateRoot: baseDbPath, logger: host.logger });
    const memoryMaintenanceGate = createMemoryMaintenanceGate({
      externalStatus: () => {
        const switching = reembeddingStateStore.list().find((record) => record.state === "switching");
        return switching
          ? {
              active: true,
              reason: "reembedding_switch",
              since: Date.parse(switching.updatedAt),
            }
          : { active: false };
      },
    });
    const reembeddingConfigRevision = createHash("sha256")
      .update(JSON.stringify({
        fingerprintId: activeEmbeddingFingerprintId,
        selection: embeddingGenerationLayout.selection,
        namespaceMode: configuredNamespaceLayout.mode,
        activeWriteNamespace: configuredNamespaceLayout.activeWriteNamespace || null,
      }))
      .digest("hex");
    const reembeddingBackend = createLanceGenerationBackend({
      stateRoot: baseDbPath,
      activeRoot: embeddingGenerationLayout.activeRoot,
      activeSharedBaseDir: embeddingGenerationLayout.sharedBaseDir,
      activeNamespace: configuredNamespaceLayout.mode === "named"
        ? configuredNamespaceLayout.activeWriteNamespace
        : null,
      activeGeneration: embeddingGenerationLayout.selection.mode === "generation"
        ? embeddingGenerationLayout.selection.generation
        : "legacy-active",
      activeSelection: embeddingGenerationLayout.selection,
      activeFingerprint: activeEmbeddingFingerprint,
      activeSecretRef: redactedEmbeddingSecretRef(normalizedEmbeddingCfg),
      configRevision: reembeddingConfigRevision,
    });
    const neoCfg = cfg.neo || {};
    const neoEnabled = neoCfg.enabled !== false; // 3.0 default: additive cognitive layer on
    const neoRoot = api.resolvePath(neoCfg.statePath || join(baseDbPath, "_neo"));
    const neoMode = neoCfg.mode || "augment";
    const neoEmbeddingDrainCfg = neoCfg.embeddingDrain || {};
    const neoEmbeddingAutoDrainEnabled = neoEmbeddingDrainCfg.enabled !== false;
    const neoEmbeddingDrainImpact = neoEmbeddingDrainCfg.impact || "low";
    const neoEmbeddingDrainMaxItems = Math.max(1, Number(neoEmbeddingDrainCfg.maxItems || 250));
    // Teilbudget fuer den agent_end-Worker. Er lief bisher auf dem vollen
    // Capture-Signal: beim ersten Turn nach einer Ruhephase ist der Neo-Store
    // kalt (bernhardine: 250-625 MB) und der Worker brauchte am 09.09.2026
    // 56 der 60 Sekunden — die Erfassung danach lief in den Abbruch und
    // speicherte nichts. Zwei Minuten spaeter, warm, dauerte dieselbe Arbeit
    // 1 s. Ueberzieht er das Teilbudget, bricht nur er ab; die Erfassung
    // behaelt den Rest und Neo holt beim naechsten Turn warm auf.
    const neoAgentEndBudgetMs = Math.max(1000, Number(neoCfg.agentEndBudgetMs || 20000));
    // 7.12.27: Suche ueber alle Kandidaten (nicht nur das 500er-Fenster).
    // Defaults hier, nicht im Schema (Installer-Profile).
    const neoGlobalRecallCfg = neoCfg.recall?.global || {};
    const neoGlobalRecall = {
      enabled: neoGlobalRecallCfg.enabled !== false,
      topK: Math.max(1, Math.min(200, Number(neoGlobalRecallCfg.topK) || 30)),
      minSimilarity: Number.isFinite(Number(neoGlobalRecallCfg.minSimilarity)) ? Math.max(0, Math.min(1, Number(neoGlobalRecallCfg.minSimilarity))) : 0.35,
      halfLifeDays: Number(neoGlobalRecallCfg.halfLifeDays) > 0 ? Number(neoGlobalRecallCfg.halfLifeDays) : 30,
      maxCandidates: Math.max(100, Number(neoGlobalRecallCfg.maxCandidates) || 20000),
      dedupeThreshold: Number.isFinite(Number(neoGlobalRecallCfg.dedupeThreshold)) ? Math.max(0, Math.min(1, Number(neoGlobalRecallCfg.dedupeThreshold))) : 0.8,
      // 7.12.30: Budget fuer die Anfrage-Einbettung im Prompt-Recall; danach
      // laeuft der Neo-Pfad ohne Vektor weiter (Lanes lexikalisch).
      embedTimeoutMs: Math.max(500, Number(neoGlobalRecallCfg.embedTimeoutMs) || 4000),
    };
    const NEO_RECALL_PRELUDE_LOG_MS = 2000;
    const runNeoGlobalSearch = (store, neoItems, queryVector, requester) => {
      if (!neoGlobalRecall.enabled || !Array.isArray(queryVector) || queryVector.length === 0) return null;
      const excludeIds = new Set(neoItems.map((item) => (item?.id ? String(item.id) : "")).filter(Boolean));
      const global = searchNeoCandidatesGlobal(store, { queryVector, requester, excludeIds, ...neoGlobalRecall });
      for (const hit of global.hits) neoItems.push(hit.item);
      const top = global.hits[0];
      host.logger.info(`plur1bus-neo: global candidate search scanned=${global.scanned} unique=${global.unique} eligible=${global.eligible} withVector=${global.withVector} hits=${global.hits.length}${top ? ` topSim=${top.similarity.toFixed(3)} topAgeDays=${top.ageDays.toFixed(1)}` : ""} index=${global.index}${global.indexLines ? `/${global.indexLines}` : ""} ms=${global.ms}`);
      return new Set(global.hits.map((hit) => String(hit.item.id)));
    };
    // Der Wartungslauf nimmt sich die Warteschlange am Stueck vor. Die Frist
    // liegt bewusst unter dem RPC-Timeout des Feature-Cron-Pfads (540s), damit
    // der Aufrufer ein Ergebnis mit Restzahl bekommt statt eines Abbruchs.
    const NEO_MANUAL_DRAIN_MAX_ITEMS = 100000;
    const NEO_MANUAL_DRAIN_DEADLINE_MS = 480000;
    // emotion-refine (7.12.22): je Lauf hoechstens so viele pending_t3-Zeilen
    // mit Tier 3 nachbessern; die Frist bleibt deutlich unter dem RPC-Timeout.
    const EMOTION_REFINE_MAX_ROWS = 100;
    const EMOTION_REFINE_DEADLINE_MS = 240000;
    const EMOTION_REFINE_MAX_CONSECUTIVE_FAILURES = 3;
    // EMOTION_REFINE_ENCODING_MAX_TOKENS (19.09.2026): encodingCallLlm oben
    // (lib/encoding-llm.js) fragt seit der Acht-Dimensionen-Emotions-Label-
    // Map + Freitext-Grund eine deutlich längere Antwort ab als vorher — die
    // alten 300 Tokens reichten dafür nicht mehr. Gemessen an einem echten
    // Provider mit einem echten deutschen Erinnerungstext:
    //   max_tokens  400 -> 400 Tokens verbraucht, finish_reason "length"
    //                      (abgeschnittenes JSON, der Parser verwirft es)
    //   max_tokens  800 -> 800 Tokens verbraucht, finish_reason "length" (dito)
    //   max_tokens 1500 -> nur 345 Tokens verbraucht, finish_reason "stop"
    //                      (parst sauber)
    // Der Fehler blieb dabei stumm: HTTP 200, plausibel aussehendes JSON,
    // aber keine schließende Klammer — die Zeile bleibt unbewertet, ohne
    // dass irgendetwas außer einem Zähler das meldet. Der
    // Tier-3-Emotionsaufruf (emotionT3CallLlm oben) bekommt kein längeres
    // Antwortformat und bleibt deshalb unverändert bei 300 maxTokens.
    const EMOTION_REFINE_ENCODING_MAX_TOKENS_DEFAULT = 1500;
    const emotionT3EncodingMaxTokensRaw = Number(emotionCfg.t3?.encodingMaxTokens);
    // Untergrenze VOR dem Runden prüfen (>= 1, nicht > 0): sonst würde ein
    // Wert wie 0,5 die Prüfung noch bestehen und erst Math.floor() ihn auf 0
    // bringen — ein maxTokens von 0 darf aber nie beim Provider ankommen.
    const EMOTION_REFINE_ENCODING_MAX_TOKENS = Number.isFinite(emotionT3EncodingMaxTokensRaw) && emotionT3EncodingMaxTokensRaw >= 1
      ? Math.floor(emotionT3EncodingMaxTokensRaw)
      : EMOTION_REFINE_ENCODING_MAX_TOKENS_DEFAULT;
    // Hook-Drain: Marge fuer den laufenden Embed-Aufruf (die 7 s zwischen
    // Worker-Abbruch und Rueckkehr waren genau der) und Mindestrest, unter
    // dem sich ein Start nicht lohnt.
    const NEO_HOOK_DRAIN_MARGIN_MS = 10000;
    const NEO_HOOK_DRAIN_MIN_MS = 3000;
    const neoWorkspaceAliases = buildNeoWorkspaceAliases({ obsidianBridge: obsidianBridgeCfg, neo: neoCfg });
    const memoryWorkspaceAliases = buildMemoryWorkspaceAliases(cfg, neoWorkspaceAliases);
    let hostMemoryConfig = {};
    try {
      hostMemoryConfig = typeof host.runtime?.config?.current === "function" ? host.runtime.config.current() : (host.runtime?.config || {});
    } catch (error) {
      host.logger.warn(`memory-lancedb-namespaced: account topology snapshot unavailable: ${String(error)}`);
    }
    const memoryAccountTopology = buildMemoryAccountTopology(hostMemoryConfig);
    const hostRoutingLoader = createHostRoutingLoader({
      logger: host.logger,
      ...(importRouting ? { importRouting } : {}),
    });
    const classifyHostIncognitoSession = createHostIncognitoSessionClassifier({
      logger: host.logger,
      ...(importRouting ? { importRouting } : {}),
    });
    const turnRouteState = autoRecall ? { initPromise: null, registry: null } : null;
    const getMemoryTurnRoutes = autoRecall ? async () => {
      if (turnRouteState.registry) return turnRouteState.registry;
      if (!turnRouteState.initPromise) {
        turnRouteState.initPromise = (async () => {
          try {
            const routingCapability = await hostRoutingLoader();
            // 7.12.36: prozessweit geteilt — siehe lib/process-singleton.js.
            turnRouteState.registry = getSharedMemoryTurnRouteRegistry({ routingCapability, logger: host.logger });
            return turnRouteState.registry;
          } catch (error) {
            host.logger.warn(`memory-lancedb-namespaced: turn route registry unavailable: ${String(error)}`);
            return null;
          }
        })();
      }
      return turnRouteState.initPromise;
    } : null;
    const clearInitializedTurnRoutes = autoRecall ? async () => {
      if (!turnRouteState.initPromise) return;
      const turnRoutes = await turnRouteState.initPromise;
      turnRoutes?.clear();
    } : null;
    const workspacePolicyStore = createWorkspacePolicyStore({
      stateRoot: baseDbPath,
      logger: host.logger,
    });
    const workspacePolicyGuard = createWorkspacePolicyGuard({
      store: workspacePolicyStore,
      maintenanceGate: memoryMaintenanceGate,
      invalidate: async () => {
        await clearInitializedTurnRoutes?.();
      },
    });
    const automaticWorkspacePolicyDecision = (event = {}, ctx = {}) => {
      try {
        const workspaceDir = ctx?.workspaceDir ?? event?.workspaceDir;
        const memoryCtx = resolveMemoryRequestContext({
          agentId: ctx?.agentId ?? event?.agentId,
          workspaceDir,
          ...(workspaceDir
            ? {}
            : {
                workspaceKey: ctx?.workspaceKey ?? event?.workspaceKey,
                workspaceId: ctx?.workspaceId ?? event?.workspaceId,
              }),
          sessionKey: ctx?.sessionKey ?? event?.sessionKey,
          sessionId: ctx?.sessionId ?? event?.sessionId,
        }, { workspaceAliases: memoryWorkspaceAliases });
        return workspacePolicyGuard.automatic(memoryCtx);
      } catch (error) {
        host.logger.debug(`memory-lancedb-namespaced: workspace policy context unavailable: ${String(error)}`);
        return { allowed: false, reason: "workspace_identity_required" };
      }
    };
    const neoWorkerRuntime = neoEnabled
      ? getSharedNeoWorkerRuntime({ logger: host.logger })
      : null;
// 7.12.30: Sentinel fuer das Embedding-Budget im Prompt-Recall.
const NEO_EMBED_TIMEOUT = Symbol("plur1bus.neo.embedTimeout");
    registerNeoWorkerWarmUp({ api, host, neoWorkerRuntime });
    if (neoEnabled && neoMode === "slot") {
      host.logger.warn("memory-lancedb-namespaced: neo mode=slot requested but this branch keeps memory-core as default slot owner; no memory capability registration call will be made.");
    }
    // Versteckte Kopplung sichtbar machen: Light/REM-Dreaming und
    // Episoden-Extraktion brauchen eine aktive Merging-Route. Ohne sie laufen
    // diese Features still als No-op, obwohl sie "aktiv" wirken.
    if (neoEnabled && !mergingLlmCfg) {
      reportDormantFeature(host.logger, {
        explicit: cfg.neo?.enabled === true,
        message: "memory-lancedb-namespaced: light/REM dreaming and episode extraction require merging.enabled and an available LLM route. They will no-op until that route is available.",
      });
    }
    const sessionWorkspaceKeys = new Map();
    const rememberNeoWorkspace = (ctx = {}, event = {}) => {
      const workspaceKey = workspaceKeyFromContext(ctx, {
        event,
        defaultWorkspaceKey: neoCfg.corpusDefaultWorkspaceKey,
        rootDir: neoRoot,
        runtime: host.runtime ?? undefined,
        sessionWorkspaceKeys,
        workspaceAliases: neoWorkspaceAliases,
      });
      for (const sessionKey of neoSessionKeysFromContext(ctx, event)) {
        sessionWorkspaceKeys.set(sessionKey, workspaceKey);
      }
      if (sessionWorkspaceKeys.size > 1000) {
        for (const key of sessionWorkspaceKeys.keys()) {
          sessionWorkspaceKeys.delete(key);
          if (sessionWorkspaceKeys.size <= 800) break;
        }
      }
      return workspaceKey;
    };
    const getNeoStore = (ctx = {}, event = {}, purpose = "general") => {
      const workspaceKey = rememberNeoWorkspace(ctx, event);
      emitCommandRuntimeHook("onNeoStore", { purpose, workspaceKey });
      return createNeoStore(neoRoot, workspaceKey);
    };
    // 7.12.45: Der Vergleich folgt dem Partitionsschluessel (ownerStorageKey):
    // agent-private kennt nur den Agenten, workspace nur die Workspace-
    // Identitaet, user Agent + Owner. Bis dahin verglich er workspaceIdentity
    // und ownerUserId fuer ALLE Scopes — Altzeilen (Juli 2026) mit gesetztem
    // workspaceKey in agent-private-Zeilen (main 7 von 9385, bernhardine 21
    // von 12034) liessen den Guard werfen, die ganze Seite fiel weg, der
    // naechtliche Decay blieb bei main/bernhardine seit Tagen bei 0.
    const sameOwnerPartition = (left, right) => {
      if (!left || !right || left.scope !== right.scope) return false;
      if (left.scope === "workspace") return left.workspaceIdentity === right.workspaceIdentity;
      if (left.scope === "user") return left.agentId === right.agentId && left.ownerUserId === right.ownerUserId;
      return left.agentId === right.agentId;
    };
    const ownerStorageKey = (partition) => partition.scope === "workspace"
      ? partition.workspaceIdentity
      : `acl-owner-v1:${partition.scope}:${partition.agentId}:${partition.key}`;
    const createOwnerBoundNeoStore = (partition) => Object.freeze({
      ...createNeoStore(neoRoot, ownerStorageKey(partition)),
      aclBindings: partition,
    });
    const createOwnerBoundTarget = (partition, store, kind, outputRoot) => Object.freeze({
      aclBindings: partition,
      kind,
      workspaceDir: outputRoot,
      writeFile: ({ path, content }) => {
        const targetPath = resolveInside(outputRoot, path);
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, content, "utf8");
        return { written: true, path: targetPath };
      },
    });
    // 7.12.29: ACL-Ablehnungen tragen Code und Kontext. Aufrufer koennen sie
    // damit von Query-Fehlern unterscheiden (memory-compaction fiel bisher bei
    // einem ACL-Wurf auf eine Suche OHNE Where zurueck und scheiterte dann an
    // alten Fremd-Scope-Zeilen), und der Grund steht im Log — bis 7.12.28 war
    // aus "ACL denied for query" nicht ablesbar, welche Zeile gemeint war
    // (consolidate-daily[bernhardine], 10.09.2026 04:15).
    const aclDeniedError = (operation, row, reason, partition, kind = "denied") => {
      const id = row?.id ? String(row.id).slice(0, 64) : "";
      const scope = row?.scope || "agent-private";
      const error = new Error(`ACL ${kind === "denied" ? "denied" : "partition mismatch"} for ${operation}`);
      error.code = "PLUR1BUS_ACL_DENIED";
      error.aclReason = reason || kind;
      error.rowId = id;
      const owner = partition?.agentId || partition?.workspaceIdentity || partition?.ownerUserId || "?";
      pluginLogger?.warn?.(`memory-lancedb-namespaced: ACL ${kind} for ${operation}: id=${id || "?"} scope=${scope} agent=${row?.agentId || row?.storedBy || "?"} workspace=${row?.workspaceId || row?.workspaceKey || ""} reason=${reason || kind} partition=${partition?.scope || "?"}:${owner}`);
      return error;
    };
    const createOwnerBoundMemoryStore = (db, partition, requestContext) => {
      const assertRecord = (record, operation) => {
        const access = record ? checkAccess(requestContext, record) : { allowed: false, reason: "acl.no_memory" };
        if (!access.allowed) {
          throw aclDeniedError(operation, record, access.reason, partition);
        }
        const candidate = {
          ...record,
          scope: record.scope || "agent-private",
          agentId: record.agentId || record.storedBy || partition.agentId,
          storedBy: record.storedBy || record.agentId || partition.agentId,
          workspaceId: record.workspaceId || record.workspaceKey || partition.workspaceIdentity,
          workspaceKey: record.workspaceKey || record.workspaceId || partition.workspaceIdentity,
          ownerUserId: record.ownerUserId || partition.ownerUserId,
        };
        if (!sameOwnerPartition({
          scope: candidate.scope,
          agentId: candidate.agentId,
          workspaceIdentity: candidate.workspaceId || candidate.workspaceKey || "",
          ownerUserId: candidate.ownerUserId || "",
        }, partition)) {
          throw new Error(`ACL partition mismatch for ${operation}`);
        }
        return record;
      };
      const withOwnershipDefaults = (entry) => ({
        ...entry,
        scope: partition.scope,
        agentId: partition.agentId,
        storedBy: entry?.storedBy || partition.agentId,
        workspaceId: partition.workspaceIdentity,
        workspaceKey: partition.workspaceIdentity,
        ownerUserId: partition.ownerUserId,
      });
      return Object.freeze({
        aclBindings: partition,
        async getById(id) {
          const record = await db.getById(id);
          return record ? assertRecord(record, "getById") : null;
        },
        async store(entry) {
          const bound = withOwnershipDefaults(entry);
          assertRecord(bound, "store");
          return db.store(bound);
        },
        async update(id, patch) {
          const record = await db.getById(id);
          assertRecord(record, "update");
          return db.update(id, patch);
        },
        async delete(id) {
          const record = await db.getById(id);
          assertRecord(record, "delete");
          return db.delete(id);
        },
        async tombstone(id, values) {
          const record = await db.getById(id);
          assertRecord(record, "tombstone");
          return db.tombstone(id, values);
        },
      });
    };
    const createPartitionScopedDb = (db, partition, requestContext) => {
      const memoryStore = createOwnerBoundMemoryStore(db, partition, requestContext);
      const assertRows = (rows, operation) => {
        for (const row of rows || []) {
          const access = checkAccess(requestContext, row);
          if (!access.allowed) throw aclDeniedError(operation, row, access.reason, partition);
          const workspaceIdentity = row.workspaceId || row.workspaceKey || "";
          if (!sameOwnerPartition({
            scope: row.scope || "agent-private",
            agentId: row.agentId || row.storedBy || "",
            workspaceIdentity,
            ownerUserId: row.ownerUserId || "",
          }, partition)) throw aclDeniedError(operation, row, "acl.partition_mismatch", partition, "mismatch");
        }
      };
      const guardedBuilder = (builder) => new Proxy(builder, {
        get(target, property) {
          if (property === "toArray") {
            return async (...args) => {
              const rows = await target.toArray(...args);
              assertRows(rows, "query");
              return rows;
            };
          }
          const value = target[property];
          if (typeof value !== "function") return value;
          return (...args) => {
            const next = value.apply(target, args);
            return next && typeof next === "object" && typeof next.toArray === "function"
              ? guardedBuilder(next)
              : next;
          };
        },
      });
      const rawTable = db.table;
      const ACL_ROW_COLUMNS = ["id", "scope", "agentId", "storedBy", "workspaceId", "workspaceKey", "ownerUserId", "status"];
      const readAclRows = async (where) => {
        let query = rawTable.query().where(where);
        try {
          const schema = typeof rawTable.schema === "function" ? await rawTable.schema() : null;
          const names = new Set((schema?.fields || []).map((f) => f.name));
          const columns = ACL_ROW_COLUMNS.filter((c) => names.has(c));
          if (columns.length > 0 && typeof query.select === "function") query = query.select(columns);
        } catch (_) { /* volle Zeilen lesen */ }
        return typeof query.limit === "function" ? query.limit(1_000_000).toArray() : query.toArray();
      };
      const table = rawTable ? {
        schema: (...args) => rawTable.schema(...args),
        query: (...args) => guardedBuilder(rawTable.query(...args)),
        vectorSearch: (...args) => guardedBuilder(rawTable.vectorSearch(...args)),
        async add(entries) {
          assertRows(entries, "add");
          return rawTable.add(entries);
        },
        // 7.12.47: Der Guard braucht fuer die Pruefung nur die ACL-Spalten —
        // bisher las er jede betroffene Zeile komplett (Text + 3072-dim
        // Vektor); beim Batch-Decay ueber ~9000 Zeilen waeren das >100 MB.
        async update(options) {
          const rows = await readAclRows(options.where);
          assertRows(rows, "update");
          return rawTable.update(options);
        },
        async delete(where) {
          const rows = await readAclRows(where);
          assertRows(rows, "delete");
          return rawTable.delete(where);
        },
      } : null;
      return {
        ...db,
        table,
        async getById(id) { return memoryStore.getById(id); },
        async store(entry) { return memoryStore.store(entry); },
        async update(id, patch) { return memoryStore.update(id, patch); },
        async delete(id) { return memoryStore.delete(id); },
        async tombstone(id, values) { return memoryStore.tombstone(id, values); },
        // Expiry is a global destructive operation on MemoryDB; the partition
        // compaction API owns scoped mutations, so never expose the raw purge.
        async purgeExpired() { return 0; },
      };
    };
    const neoRequester = (ctx = {}, event = {}) => ({
      requesterAgentId: [ctx?.agentId, event?.agentId].find(value => typeof value === "string" && value.trim()) || "",
      // ACL binding may not inherit routing defaults; an omitted trusted binding fails closed.
      requesterWorkspaceKey: [ctx?.workspaceKey, event?.workspaceKey, ctx?.workspaceId, event?.workspaceId]
        .find(value => typeof value === "string" && value.trim()) || "",
      requesterOwnerId: [ctx?.ownerId, event?.ownerId, ctx?.userId, event?.userId].find(value => typeof value === "string" && value.trim()) || "",
    });
    const snapshotNeoContent = (content) => {
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .filter(block => block && typeof block === "object")
        .map(block => {
          if (block.type === "text" && typeof block.text === "string") {
            return { type: "text", text: block.text };
          }
          return {
            type: typeof block.type === "string" ? block.type : "unknown",
            name: typeof block.name === "string" ? block.name : undefined,
            fileName: typeof block.fileName === "string" ? block.fileName : undefined,
            filename: typeof block.filename === "string" ? block.filename : undefined,
            mediaType: typeof block.mediaType === "string" ? block.mediaType : undefined,
            mimeType: typeof block.mimeType === "string" ? block.mimeType : undefined,
            mime_type: typeof block.mime_type === "string" ? block.mime_type : undefined,
          };
        });
    };
    const snapshotNeoString = (value) => typeof value === "string" ? value : "";
    const snapshotNeoMessages = (messages = []) => Array.isArray(messages)
      ? messages
          .filter(msg => msg && typeof msg === "object")
          .map(msg => ({
            role: msg.role,
            content: snapshotNeoContent(msg.content),
            tool_call_id: msg.tool_call_id,
          }))
      : [];
    const recallInjectionKeys = new Set();
    const markNeoRecallInjection = (event = {}, ctx = {}) => {
      const key = [
        event.runId || ctx.runId || event.turnId || "",
        event.agentSessionKey || ctx.agentSessionKey || event.sessionKey || ctx.sessionKey || event.sessionId || ctx.sessionId || "",
        ctx.agentId || event.agentId || "",
        String(event.prompt || "").slice(0, 120),
      ].filter(Boolean).join("|");
      if (!key) return "";
      if (recallInjectionKeys.has(key)) return null;
      recallInjectionKeys.add(key);
      if (recallInjectionKeys.size > 1000) {
        for (const oldKey of recallInjectionKeys) {
          recallInjectionKeys.delete(oldKey);
          if (recallInjectionKeys.size <= 800) break;
        }
      }
      return `plur1bus:${key}`;
    };

    const pool = new MultiNamespacePool(namespaceLayout, vectorDim, AgentDbPool, host.logger);
    const sharedMemoryPool = new SharedMemoryPool(embeddingGenerationLayout.sharedBaseDir, vectorDim, AgentDbPool, host.logger);
    // The control surface gets its own bounded, read-only view. It must never
    // reuse a write pool: a status request is not allowed to create a Lance
    // table, directory, or card as a side effect.
    const controlHealthWorkspaceIdentityByKey = new Map();
    const controlHealthUserLabelByKey = new Map();
    let controlHealthPrimaryAgentIds = [];
    const controlHealthNamespaceRoots = namespaceLayout.mode === "named"
      ? namespaceLayout.recallReadNamespaces.map((id) => ({
          id,
          path: resolve(namespaceLayout.baseDir, id),
          dimensions: vectorDim,
        }))
      : [{ id: "legacy-flat", path: namespaceLayout.baseDbPath, dimensions: vectorDim }];
    const controlHealthScan = createControlPlaneHealthScan({
      namespaceRoots: controlHealthNamespaceRoots,
      sharedRoots: {
        workspace: {
          path: resolve(embeddingGenerationLayout.sharedBaseDir, ".plur1bus-shared", "workspaces"),
          dimensions: vectorDim,
        },
        user: {
          path: resolve(embeddingGenerationLayout.sharedBaseDir, ".plur1bus-shared", "users"),
          dimensions: vectorDim,
        },
      },
      listPartitions: ({ basePath }) => listControlHealthPartitions(basePath),
      inspectRows: createControlHealthRowInspector(vectorDim, host.logger),
      measureStorage: () => measureControlHealthStorage(baseDbPath),
      workspaceIdentityForKey: (key) => controlHealthWorkspaceIdentityByKey.get(key) ?? null,
      userIdentityForKey: (key) => controlHealthUserLabelByKey.get(key) ?? null,
      primaryAgentIds: () => controlHealthPrimaryAgentIds,
      maxPartitions: CONTROL_HEALTH_MAX_PARTITIONS,
    });
    // The workspace identities are refreshed inside the scan, not by the page
    // request: the warm-up at gateway start and the background refresh never
    // go through a request, and without this they would count shared
    // workspace cards under raw pool keys.
    // Pool keys are hashes; the page needs names. Durable policy records name
    // their workspace identity, the alias snapshot names every aliased
    // workspace (`main`) and its pre-alias directory identity (`main.dir`).
    // A bare `workspace:v1:<id>` identity is shown as `<id>`.
    const shortWorkspaceLabel = (identity) => (
      typeof identity === "string" && identity.startsWith("workspace:v1:") && identity.length > "workspace:v1:".length
        ? identity.slice("workspace:v1:".length)
        : identity
    );
    const syncControlHealthWorkspaceIdentities = () => {
      controlHealthWorkspaceIdentityByKey.clear();
      for (const record of workspacePolicyStore.list()) {
        controlHealthWorkspaceIdentityByKey.set(
          workspacePoolKey(record.workspaceIdentity),
          shortWorkspaceLabel(record.workspaceIdentity),
        );
      }
      for (const entry of describeWorkspacePoolLabels(memoryWorkspaceAliases)) {
        if (!controlHealthWorkspaceIdentityByKey.has(entry.poolKey)) {
          controlHealthWorkspaceIdentityByKey.set(entry.poolKey, entry.label);
        }
      }
      // User pools are named after the agent, channel and account whose
      // allowed direct-message user owns them; the user id stays off the page.
      controlHealthUserLabelByKey.clear();
      let liveHostConfig = hostMemoryConfig;
      try {
        const current = host.runtime?.config?.current;
        if (typeof current === "function") liveHostConfig = current() || hostMemoryConfig;
      } catch {
        liveHostConfig = hostMemoryConfig;
      }
      for (const entry of describeUserPoolLabels(liveHostConfig)) {
        controlHealthUserLabelByKey.set(entry.poolKey, entry.label);
      }
      controlHealthPrimaryAgentIds = describePrimaryAgentIds(liveHostConfig);
    };
    const controlHealth = createControlPlaneHealthInspector({
      scan: async () => {
        try {
          syncControlHealthWorkspaceIdentities();
        } catch (error) {
          host.logger.warn(`memory-lancedb-namespaced: control health workspace identities unavailable: ${error?.message || error}`);
        }
        return controlHealthScan();
      },
      ttlMs: CONTROL_HEALTH_CACHE_TTL_MS,
      staleWhileRevalidate: true,
      refreshIntervalMs: CONTROL_HEALTH_REFRESH_INTERVAL_MS,
      failedRetryMs: CONTROL_HEALTH_FAILED_RETRY_MS,
      onRefresh: ({ status, failed, durationMs }) => {
        const line = `memory-lancedb-namespaced: control health snapshot ${failed ? "failed" : "refreshed"} in ${Math.round(durationMs / 100) / 10}s (${status})`;
        if (failed) host.logger.warn(line);
        else host.logger.info(line);
      },
    });
    const legacyMigrationShutdown = new AbortController();
    if (commandRuntimeHooks) {
      const withDb = pool.withDb.bind(pool);
      pool.withDb = async (agentId, operation, ...args) => withDb(agentId, async (db, ...operationArgs) => {
        emitCommandRuntimeHook("onPoolAcquire", { agentId });
        const init = db.init?.bind(db);
        if (init) {
          db.init = async (...initArgs) => {
            emitCommandRuntimeHook("onDbInit", { agentId });
            return init(...initArgs);
          };
        }
        try {
          return await operation(db, ...operationArgs);
        } finally {
          if (init) db.init = init;
        }
      }, ...args);
    }
    const emotionalPool = createEmotionalStatePool({
      temperaments: emotionCfg.temperaments || {},
      moodInfluence: emotionMoodInfluence,
    });
    const embeddings = normalizedEmbeddingCfg.provider === "local-transformers"
      ? (requiresActiveSharedModelOwner
          ? new ReloadSafeIpcScopedEmbeddingProvider({
              stateRoot: baseDbPath,
              model: normalizedEmbeddingCfg.local.model,
              dimensions: dimensions || vectorDim,
              fingerprintId: activeEmbeddingFingerprintId,
            })
          : new LocalTransformersEmbeddingProvider({
          ...normalizedEmbeddingCfg.local,
          cacheDir: localModelCacheDir,
          acceptNonCommercialLicense: nonCommercialModelAccepted,
          dimensions: dimensions || vectorDim,
          embeddingCacheEnabled: cfg.runtime?.embeddingCacheEnabled,
          cacheMaxEntries: cfg.runtime?.embeddingCacheMaxEntries ?? normalizedEmbeddingCfg.cacheMaxEntries,
          cacheTtlMs: cfg.runtime?.embeddingCacheTtlMs ?? normalizedEmbeddingCfg.cacheTtlMs,
          embeddingCachePersist: cfg.runtime?.embeddingCachePersist,
          embeddingCachePersistDebug: cfg.runtime?.embeddingCachePersistDebug,
          embeddingCacheCoalesce: cfg.runtime?.embeddingCacheCoalesce,
          embeddingCacheMetrics: cfg.runtime?.embeddingCacheMetrics,
          embeddingCacheScope: cfg.runtime?.embeddingCacheScope,
          embeddingCacheMaxBytes: cfg.runtime?.embeddingCacheMaxBytes,
          cacheBasePath: baseDbPath,
          logger: host.logger,
          localModelGeneration,
          sharedModelPool: sharesActiveLocalModel,
          sharedModelOwner: coordinatesLocalModelGeneration,
          sharedModelRequireOwner: requiresActiveSharedModelOwner,
          sharedModelActivationManaged: coordinatesLocalModelGeneration,
        }))
      : new OpenAIEmbeddingProvider({
          ...normalizedEmbeddingCfg,
          apiKey: normalizedEmbeddingCfg.apiKey,
          apiKeyEnv: normalizedEmbeddingCfg.apiKeyEnv,
          credentialResolver,
          fallback: embeddingCfg.fallback,
          dimensions: dimensions || vectorDim,
          embeddingCacheEnabled: cfg.runtime?.embeddingCacheEnabled,
          cacheMaxEntries: cfg.runtime?.embeddingCacheMaxEntries ?? normalizedEmbeddingCfg.cacheMaxEntries,
          cacheTtlMs: cfg.runtime?.embeddingCacheTtlMs ?? normalizedEmbeddingCfg.cacheTtlMs,
          embeddingCachePersist: cfg.runtime?.embeddingCachePersist,
          embeddingCachePersistDebug: cfg.runtime?.embeddingCachePersistDebug,
          embeddingCacheCoalesce: cfg.runtime?.embeddingCacheCoalesce,
          embeddingCacheMetrics: cfg.runtime?.embeddingCacheMetrics,
          embeddingCacheScope: cfg.runtime?.embeddingCacheScope,
          embeddingCacheMaxBytes: cfg.runtime?.embeddingCacheMaxBytes,
          cacheBasePath: baseDbPath,
          logger: host.logger,
        });
    const scopedEmbeddingServer = coordinatesLocalModelGeneration
      && normalizedEmbeddingCfg.provider === "local-transformers"
      ? createScopedEmbeddingIpcServer({
          stateRoot: baseDbPath,
          embeddings,
          fingerprintId: activeEmbeddingFingerprintId,
          logger: host.logger,
        })
      : null;
    if (commandRuntimeHooks) {
      for (const method of ["embed", "embedQuery", "embedPassage", "embedBatch"]) {
        if (typeof embeddings[method] !== "function") continue;
        const original = embeddings[method].bind(embeddings);
        embeddings[method] = async (...args) => {
          emitCommandRuntimeHook("onEmbed", { method });
          return original(...args);
        };
      }
    }

    // This adapter also owns plugin-lifecycle resources, so it must exist even
    // on hosts without the optional chat-command registration capability.
    const memoryDbAdapter = createDbAdapter({
      basePath: embeddingGenerationLayout.activeRoot,
      getEmbedding: async (text) => {
        try {
          return await embeddings.embed(text);
        } catch (error) {
          safeDebug(host.logger, "memory-adapter.embedding-fallback", error);
          return null;
        }
      },
      embedder: {
        embed: async (text) => embeddings.embed(text),
      },
      logger: host.logger,
    });

    // 7.12.48: Das Skill-Ledger liegt je ACL-Partition unter dem Neo-Store.
    // Chat-Befehle und Nudge lasen bis 7.12.47 den Agenten-Workspace, wo nie
    // ein Ledger lag — kein Vorschlag wurde je angezeigt. Diese Helfer leiten
    // die Verzeichnisse genauso ab wie der Miner selbst.
    const skillLedgerDirsFor = (memoryCtx) => {
      const dirs = [];
      for (const partition of buildRemPartitions(memoryCtx)) {
        try { dirs.push(createOwnerBoundNeoStore(partition).paths.workspaceDir); } catch { /* Partition nicht baubar */ }
      }
      return [...new Set(dirs)];
    };
    const skillLedgerDirForAgent = (agentId) => {
      try {
        return skillLedgerDirsFor(resolveMemoryRequestContext({ agentId }, { workspaceAliases: memoryWorkspaceAliases }))[0] || null;
      } catch {
        return null;
      }
    };
    // Gemeinsame Aktivierungs-Abhaengigkeiten fuer Miner-Auto-Apply,
    // Dashboard und Chat: inspect → hash-gebundenes apply → Evidenz-Promotion.
    const skillActivationDeps = (agentId, { actor, actorTier, reason, memoryCtx, lang, tone } = {}) => ({
      agentId,
      lang,
      tone,
      logger: host.logger,
      skillWorkshop: openClawSkillWorkshop,
      // 7.12.52: Mit welcher Stufe die Belege gehoben werden. Die
      // Workshop-Stufe darf nur nach corroborated; die Aktivierung überspringt
      // dann alles andere, statt an einem illegalen Übergang zu scheitern.
      evidenceActorTier: actorTier,
      // 7.12.51: Wo der Host einen angewandten Skill ablegt. Nur benutzt, wenn
      // der Workshop den Vorschlag schon angewandt hat und keinen Zielpfad
      // mitliefert.
      workshopSkillPath: (skillName) => join(
        process.env.OPENCLAW_HOME || join(homedir(), ".openclaw"),
        "agents",
        agentId,
        "agent",
        "workshop-skills",
        skillName,
        "SKILL.md",
      ),
      memoryCtx,
      loadEvidenceRecord: async (memoryId) => {
        try {
          return await pool.withDb(agentId, (db) => db.getById(memoryId));
        } catch (error) {
          // null is indistinguishable from "no evidence exists", so record
          // that this was a failed read instead.
          host.logger.warn(`memory-lancedb-namespaced: evidence record unreadable for ${String(memoryId)}: ${String(error)}`);
          return null;
        }
      },
      applyEpistemicStatus: async (memoryId, nextStatus) => pool.withWriteDb(agentId, (db) => applyEpistemicStatusToLanceDb(db, memoryId, nextStatus, {
        ctx: memoryCtx,
        actor,
        actorTier,
        authorized: false,
        workspaceDir: memoryCtx?.workspaceDir,
        reason,
      })),
    });
    const dashboardSkillAction = async (agentId, proposalId, run) => {
      let memoryCtx;
      try {
        memoryCtx = resolveMemoryRequestContext({ agentId }, { workspaceAliases: memoryWorkspaceAliases });
      } catch {
        return { ok: false, reason: "not_found" };
      }
      const dirs = skillLedgerDirsFor(memoryCtx);
      const ledgerDir = findProposalWorkspace(dirs, proposalId);
      if (!ledgerDir) return { ok: false, reason: "not_found" };
      const proposal = readSkillProposals(ledgerDir).find((entry) => entry.id === proposalId);
      return run({ ledgerDir, memoryCtx, proposal });
    };
    const collectSkillWorkshopDashboard = () => {
      const entries = (host.runtime?.config?.current?.() || api.config || {})?.agents?.entries;
      const agents = [];
      for (const [agentId, entry] of Object.entries(entries && typeof entries === "object" ? entries : {})) {
        const ledgerDir = skillLedgerDirForAgent(agentId);
        if (!ledgerDir) continue;
        agents.push({ agentId, workspace: entry?.workspace, ledgerDirs: [ledgerDir] });
      }
      return {
        ...collectSkillWorkshopProposals({ agents }),
        available: Boolean(openClawSkillWorkshop),
        mode: skillMinerAutoApplyMode,
        hostMode: hostSkillWorkshopMode(),
        autoApply: skillMinerAutoApplyEffective(),
      };
    };

    if (typeof api.on === "function") {
      const synchronizeSkillWorkshopLifecycle = createSkillWorkshopLifecycleSynchronizer({
        resolveProposalWorkspaces: ({ eventWorkspaceDir }) => [
          eventWorkspaceDir,
          ...listNeoWorkspaceKeys(neoRoot).map((workspaceKey) =>
            resolve(neoRoot, "workspaces", workspaceKey)),
        ],
        onApplied: async ({ workspaceDir, eventWorkspaceDir, agentId, localProposal, workshopEvent }) => {
          const lifecycleMemoryCtx = resolveMemoryRequestContext({
            agentId,
            workspaceDir: eventWorkspaceDir,
          }, { workspaceAliases: memoryWorkspaceAliases });
          return activateSkillProposal(workspaceDir, localProposal.id, {
            agentId,
            logger: host.logger,
            committedWorkshopEvent: workshopEvent,
            memoryCtx: lifecycleMemoryCtx,
            loadEvidenceRecord: async (memoryId) => pool.withAuthoritativeReadDb(
              agentId,
              async (db) => db.getById(memoryId),
            ),
            applyEpistemicStatus: async (memoryId, nextStatus) => pool.withWriteDb(
              agentId,
              (db) => applyEpistemicStatusToLanceDb(db, memoryId, nextStatus, {
                ctx: lifecycleMemoryCtx,
                actor: "openclaw-skill-workshop",
                // "system" was never a legal tier, so every evidence
                // transition of an externally applied skill failed and the
                // local record stayed at activation_partial for good.
                actorTier: "system:skill-workshop",
                authorized: false,
                workspaceDir: eventWorkspaceDir,
                reason: "skill-workshop-lifecycle",
              }),
            ),
          });
        },
        onRejected: async ({ workspaceDir, localProposal }) => {
          const marked = markProposalStatus(workspaceDir, localProposal.id, "rejected");
          if (!marked.ok) return marked;
          return patchProposal(workspaceDir, localProposal.id, {
            openClawWorkshop: {
              ...localProposal.openClawWorkshop,
              status: "rejected",
            },
          });
        },
      });
      api.on(
        "skill_proposal_changed",
        async (event, context) => {
          try {
            return await synchronizeSkillWorkshopLifecycle(event, context);
          } catch (error) {
            safeWarn(host.logger, "skill-workshop-lifecycle", error, {
              proposalId: event?.proposal?.id,
              action: event?.action,
            });
            throw error;
          }
        },
        {
          registrationId: "plur1bus-skill-workshop-lifecycle-v1",
          timeoutMs: 30_000,
        },
      );
    }

    const createTargetEmbeddingProvider = async ({ fingerprint, secretRef } = {}) => {
      if (!fingerprint || typeof fingerprint !== "object") {
        throw new Error("reembedding target fingerprint is required");
      }
      if (fingerprint.provider === "local-transformers") {
        const profile = pinnedLocalModelProfile(fingerprint.model);
        if (!profile || profile.revision !== fingerprint.revision) {
          throw new Error(`reembedding local model is not pinned: ${String(fingerprint.model)}`);
        }
        if (profile.role !== "embedding") {
          throw new Error(`reembedding local model is not an embedding model: ${profile.model}`);
        }
        return new LocalTransformersEmbeddingProvider({
          model: fingerprint.model,
          revision: fingerprint.revision,
          dimensions: fingerprint.dimensions,
          queryPrefix: fingerprint.queryPrefix,
          passagePrefix: fingerprint.passagePrefix,
          cacheDir: localModelCacheDir,
          acceptNonCommercialLicense: nonCommercialModelAccepted,
          embeddingCacheEnabled: false,
          logger: host.logger,
          localModelGeneration,
          sharedModelPool: requiresActiveSharedModelOwner,
          sharedModelOwner: false,
          sharedModelRequireOwner: requiresActiveSharedModelOwner,
        });
      }
      return new OpenAIEmbeddingProvider({
        provider: fingerprint.provider,
        model: fingerprint.model,
        baseUrl: fingerprint.endpoint,
        dimensions: fingerprint.dimensions,
        ...(secretRef ? { apiKey: secretRef } : {}),
        credentialResolver,
        embeddingCacheEnabled: false,
        logger: host.logger,
      });
    };
    const embedWithTargetProvider = async (provider, text, purpose) => {
      if (purpose === "query" && typeof provider.embedQuery === "function") {
        return provider.embedQuery(text, { purpose: "reembedding" });
      }
      if (typeof provider.embedPassage === "function") {
        return provider.embedPassage(text, { purpose: "reembedding" });
      }
      return provider.embed(text, { purpose: "reembedding" });
    };
    const shutdownTargetProvider = async (provider, operationError = null) => {
      try {
        await provider?.shutdown?.();
      } catch (shutdownError) {
        if (operationError) {
          throw new AggregateError([operationError, shutdownError], "reembedding provider operation and shutdown failed");
        }
        throw shutdownError;
      }
      if (operationError) throw operationError;
    };
    const targetGenerationDataRoot = (generation) => {
      if (generation === null) {
        return configuredNamespaceLayout.mode === "named"
          ? resolveInside(configuredNamespaceLayout.baseDir, configuredNamespaceLayout.activeWriteNamespace)
          : configuredNamespaceLayout.baseDbPath;
      }
      const root = resolveInside(baseDbPath, "generations", generation);
      return configuredNamespaceLayout.mode === "named"
        ? resolveInside(root, configuredNamespaceLayout.activeWriteNamespace)
        : root;
    };
    const withTargetGenerationDb = async ({ generation, agentId, dimensions: targetDimensions }, operation) => {
      const targetPool = new AgentDbPool(
        targetGenerationDataRoot(generation),
        targetDimensions,
        host.logger,
      );
      let operationError = null;
      let result;
      try {
        result = await targetPool.withDb(agentId, operation);
      } catch (error) {
        operationError = error;
      }
      try {
        await targetPool.shutdown();
      } catch (shutdownError) {
        if (operationError) {
          throw new AggregateError([operationError, shutdownError], "reembedding target DB operation and shutdown failed");
        }
        throw shutdownError;
      }
      if (operationError) throw operationError;
      return result;
    };
    const readConfiguredReembeddingSelection = () => {
      const current = host.runtime?.config?.current?.() || api.config || {};
      const currentReembedding = current?.plugins?.entries?.[PLUGIN_KEY]?.config?.reembedding;
      return Object.freeze({ generation: currentReembedding?.activeGeneration ?? null });
    };
    const runTargetGenerationRuntimeProbe = async (input) => {
      const provider = await createTargetEmbeddingProvider(input);
      const probe = createGenerationRuntimeProbe({
        readActiveSelection: readConfiguredReembeddingSelection,
        embedTarget: ({ text, purpose }) => embedWithTargetProvider(provider, text, purpose),
        withTargetDb: withTargetGenerationDb,
        appendAudit: (entry) => appendDestructiveOpLog(baseDbPath, entry),
      });
      let operationError = null;
      let result;
      try {
        result = await probe(input);
      } catch (error) {
        operationError = error;
      }
      await shutdownTargetProvider(provider, operationError);
      return result;
    };
    const readReembeddingDiskStatus = async () => {
      const disk = statfsSync(baseDbPath);
      const freeBytes = Math.floor(Number(disk.bavail) * Number(disk.bsize));
      return { freeBytes: Math.min(Number.MAX_SAFE_INTEGER, freeBytes) };
    };
    const reembeddingCoordinator = createReembeddingCoordinator({
      stateStore: reembeddingStateStore,
      backend: reembeddingBackend,
      createTargetProvider: createTargetEmbeddingProvider,
      plannerDependencies: {
        statDisk: readReembeddingDiskStatus,
        inspectTargetArtifacts: async ({ fingerprint }) => {
          const profile = pinnedLocalModelProfile(fingerprint.model);
          if (!profile || profile.revision !== fingerprint.revision) {
            return { ready: false, verified: false };
          }
          const provider = await createTargetEmbeddingProvider({ fingerprint });
          let operationError = null;
          let inspected;
          try {
            inspected = provider.cacheDir
              ? await validatePinnedModelArtifacts(profile, provider.cacheDir)
              : { ok: false, artifacts: [] };
          } catch (error) {
            operationError = error;
          }
          await shutdownTargetProvider(provider, operationError);
          return { ready: inspected.ok, verified: inspected.ok };
        },
        probeTargetProvider: async ({ target, purpose }) => {
          const provider = await createTargetEmbeddingProvider(target);
          let operationError = null;
          let vector;
          try {
            vector = await embedWithTargetProvider(
              provider,
              `PLUR1BUS ${purpose} provider probe`,
              "passage",
            );
          } catch (error) {
            operationError = error;
          }
          await shutdownTargetProvider(provider, operationError);
          return vector;
        },
      },
      readPolicySnapshot: async () => workspacePolicyStore.list(),
      runValidationProbes: async ({ record, backend, provider }) => {
        const table = record.source.tables.find((candidate) => candidate.rowCount > 0);
        if (!table) throw new Error("reembedding semantic validation requires at least one source memory");
        const [sourceRow] = await backend.readSourceBatch(table.tableId, { offset: 0, limit: 1 });
        if (!sourceRow || typeof sourceRow.text !== "string" || !sourceRow.text.trim()) {
          throw new Error("reembedding semantic validation source memory is invalid");
        }
        const queryVector = await embedWithTargetProvider(provider, sourceRow.text, "query");
        const recalled = await backend.searchTarget(record.target.generation, table.tableId, queryVector, { limit: 5 });
        if (!recalled.some((candidate) => candidate.id === sourceRow.id)) {
          throw new Error("reembedding target generation did not recall the source validation memory");
        }
        return { semanticRecall: true, validationMemoryId: sourceRow.id, validationTable: table.tableId };
      },
    });
    let modelPreparationCoordinator = null;
    if (cfg.modelPreparation) {
      try {
        modelPreparationCoordinator = createModelPreparationCoordinator({
          stateRoot: baseDbPath,
          cacheDir: localModelCacheDir,
          config: cfg.modelPreparation,
          activeFingerprint: activeEmbeddingFingerprint,
          inventoryActiveGeneration: reembeddingBackend.inventoryActiveGeneration,
          statDisk: readReembeddingDiskStatus,
          logger: host.logger,
        });
      } catch (error) {
        safeWarn(host.logger, "model-preparation.initialize", error);
        modelPreparationCoordinator = createFailedModelPreparationCoordinator({
          config: cfg.modelPreparation,
          activeFingerprint: activeEmbeddingFingerprint,
        });
      }
    }
    const reembeddingConfigMutationAvailable = typeof host.runtime?.config?.mutateConfigFile === "function";
    const reembeddingSelectionMutator = reembeddingConfigMutationAvailable
      ? createOpenClawEmbeddingSelectionMutator({ api })
      : null;
    const reembeddingSwitchRuntime = reembeddingConfigMutationAvailable
      ? createReembeddingSwitchRuntime({
          stateStore: reembeddingStateStore,
          maintenanceGate: memoryMaintenanceGate,
          mutateSelection: reembeddingSelectionMutator,
        })
      : Object.freeze({
          async switchGeneration() {
            throw new Error("OpenClaw mutateConfigFile capability is required for reembedding switch");
          },
          async planManualRollback() {
            throw new Error("OpenClaw mutateConfigFile capability is required for reembedding rollback");
          },
        });
    const reembeddingSwitchRecovery = reembeddingConfigMutationAvailable
      ? createReembeddingSwitchRecovery({
          stateStore: reembeddingStateStore,
          readActiveSelection: readConfiguredReembeddingSelection,
          mutateSelection: reembeddingSelectionMutator,
          probeRuntime: runTargetGenerationRuntimeProbe,
        })
      : null;
    const configMutationNotice = configMutationLogNotice(api);
    if (configMutationNotice) {
      host.logger?.[configMutationNotice.level]?.(configMutationNotice.message);
    }

    // Reranker (optional — provider-aware since v3.1)
    // Cohere reranker — lokaler Fallback nur wenn fallbackProvider="local-transformers" explizit gesetzt
    const { reranker, rerankerCfg } = createRuntimeRerankerProvider(
      cfg.reranker || {},
      host.logger,
      { credentialResolver, localModelGeneration },
    );
    // Wie viele Kandidaten vor dem Re-Ranking holen (dann auf limit/top_n reduzieren)
    const rerankCandidates = rerankerCfg.candidates ?? candidateTopK;

    if (reranker) {
      const experimental = rerankerCfg.provider === "local-transformers" ? " experimental" : "";
      const modelName = reranker.model || reranker.id || "unknown";
      host.logger.info(`memory-lancedb-namespaced: reranker enabled (${rerankerCfg.provider}${experimental}, model: ${modelName})`);
    }

    host.logger.info(`memory-lancedb-namespaced: registered (baseDbPath: ${baseDbPath})`);

    function resolveStoreScopeAccess(memoryCtx, rawScope) {
      const scope = MEMORY_SCOPES.includes(rawScope) ? rawScope : "agent-private";
      if (!memoryCtx?.agentId) return { ok: false, error: "memory context requires an agent" };
      if (scope === "user" && !memoryCtx.userPrincipal) {
        return { ok: false, error: "user scope requires an authenticated user" };
      }
      if (scope === "workspace" && !memoryCtx.workspaceIdentity) {
        return { ok: false, error: "workspace scope requires a bound workspace" };
      }
      const workspaceIdentity = scope === "workspace" ? memoryCtx.workspaceIdentity : "";
      return {
        ok: true,
        scope,
        ownerUserId: scope === "user" ? memoryCtx.userPrincipal : "",
        ownershipFields: Object.freeze({
          agentId: memoryCtx.agentId,
          storedBy: memoryCtx.agentId,
          workspaceId: workspaceIdentity,
          workspaceKey: workspaceIdentity,
          ownerUserId: scope === "user" ? memoryCtx.userPrincipal : "",
        }),
      };
    }

    function candidateVisibleForStore(candidate, accessCtx) {
      if (!candidate) return false;
      return checkAccess(accessCtx, candidate.entry).allowed;
    }

    function findSafeDuplicateForValidity(candidates, text, validityWindow) {
      return candidates.find((candidate) => (
        isSafeDuplicate(candidate.entry.text, text)
        && stableValidTimeValue(candidate.entry.validFrom) === stableValidTimeValue(validityWindow.validFrom)
        && stableValidTimeValue(candidate.entry.validUntil) === stableValidTimeValue(validityWindow.validUntil)
      ));
    }

    const durableMergeQueues = new Map();

    function stableValidTimeValue(value) {
      const numeric = Number(value || 0);
      return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
    }

    function hasEquivalentEpistemicMetadata(left, right, { includeUpdatedAt = true } = {}) {
      const stringFields = [
        "epistemicStatus",
        "epistemicStatusActor",
        "epistemicStatusReason",
        "previousEpistemicStatus",
      ];
      if (stringFields.some((field) => String(left?.[field] ?? "") !== String(right?.[field] ?? ""))) {
        return false;
      }
      return !includeUpdatedAt
        || stableValidTimeValue(left?.epistemicStatusUpdatedAt) === stableValidTimeValue(right?.epistemicStatusUpdatedAt);
    }

    function durableMergeEpistemicMetadata(candidate) {
      return {
        epistemicStatus: combineEpistemicStatusForMerge(candidate.epistemicStatus, undefined),
        previousEpistemicStatus: normalizeEpistemicStatus(candidate.epistemicStatus),
        epistemicStatusActor: "system:merge",
        epistemicStatusReason: `memory_store merge with ${candidate.id}`,
        epistemicStatusUpdatedAt: Date.now(),
      };
    }

    function durableMergeWriteKey({
      workspaceKey,
      text,
      category,
      origin,
      importance,
      ttl,
      sourceUrl,
      evidenceQuote,
      scope,
      ownerUserId,
      validFrom,
      validUntil,
    }) {
      return JSON.stringify([
        workspaceKey,
        text,
        category,
        origin,
        importance,
        ttl,
        sourceUrl,
        evidenceQuote,
        scope,
        ownerUserId,
        stableValidTimeValue(validFrom),
        stableValidTimeValue(validUntil),
      ]);
    }

    function durableMergeIdentity(agentId, candidateId, writeKey) {
      const digest = createHash("sha256")
        .update(JSON.stringify(["memory_store_merge", agentId, candidateId, String(writeKey || "")]))
        .digest("hex");
      return {
        idempotencyKey: `sha256:${digest}`,
        replacementId: `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`,
      };
    }

    function destructiveDeleteIdempotencyKey(source, agentId, memoryId, via) {
      const digest = createHash("sha256")
        .update(JSON.stringify(["memory.deleted", source, agentId, memoryId, via]))
        .digest("hex");
      return `sha256:${digest}`;
    }

    async function deleteWithAuditContinuation({
      db,
      memoryId,
      workspaceDir,
      logEntry,
      onLateFailure,
    }) {
      const idempotencyKey = logEntry.idempotencyKey
        || destructiveDeleteIdempotencyKey(logEntry.source, logEntry.agentId, memoryId, logEntry.via);
      let deletionLogged = false;
      const appendDeletionLog = () => {
        if (deletionLogged) return;
        appendDestructiveOpLog(workspaceDir, { ...logEntry, memoryId, idempotencyKey });
        deletionLogged = true;
      };

      try {
        await db.delete(memoryId);
      } catch (deleteErr) {
        if (deleteErr instanceof TimeoutError && deleteErr.settlement) {
          const rawDeleteSettlement = deleteErr.settlement;
          deleteErr.settlement = rawDeleteSettlement.then(
            (value) => {
              appendDeletionLog();
              return value;
            },
            (lateDeleteError) => {
              onLateFailure?.(lateDeleteError);
              throw lateDeleteError;
            },
          );
        }
        throw deleteErr;
      }

      appendDeletionLog();
    }

    async function tombstoneMemoryWithAudit({
      db,
      card,
      agentId,
      workspaceDir,
      baseDbPath,
      source,
      via,
      query,
      archivePath,
      actor = "memory_forget",
      actorType = "tool",
      reason = "memory_forget tool",
    }) {
      const memoryId = String(card?.id || "");
      const tombstone = buildTombstone({
        card,
        agentId,
        actor,
        actorType,
        reason,
        sourceOp: source,
        archiveRef: archivePath,
        previousVersion: String(card?.previousVersion || ""),
      });

      let committed = false;
      const commitTombstone = (already) => {
        if (committed) return true;
        // In-Memory-Commit-Flag erst NACH erfolgreicher Persistierung setzen,
        // damit ein fehlgeschlagener Append keinen falschen "committed"-Zustand
        // vortäuscht und ein erneuter Forget nachtragen kann.
        if (baseDbPath && !already) {
          appendTombstoneToRegistry(baseDbPath, agentId, { ...tombstone, status: "committed" });
        }
        const auditOk = appendDestructiveOpLog(workspaceDir, {
          event: "memory.deleted",
          source,
          agentId,
          memoryId,
          canonicalOriginId: tombstone.canonicalOriginId,
          via,
          query,
          archivePath,
          tombstoneId: tombstone.tombstoneId,
          result: already ? "already_tombstoned" : "committed",
          timestamp: new Date().toISOString(),
        });
        committed = auditOk;
        return auditOk;
      };
      const failTombstone = (errorClass) => {
        if (baseDbPath) {
          appendTombstoneToRegistry(baseDbPath, agentId, { ...tombstone, status: "failed" });
        }
        appendDestructiveOpLog(workspaceDir, {
          event: "memory.deleted",
          source,
          agentId,
          memoryId,
          via,
          query,
          archivePath,
          tombstoneId: tombstone.tombstoneId,
          result: "failed",
          errorClass: errorClass || "Error",
          timestamp: new Date().toISOString(),
        });
      };

      // Phase 1: attempted (vor der Mutation).
      if (baseDbPath) {
        appendTombstoneToRegistry(baseDbPath, agentId, { ...tombstone, status: "attempted" });
      }
      let result;
      try {
        result = await db.tombstone(memoryId);
      } catch (err) {
        // LanceDB-Schreib-Timeout: die Mutation kann trotzdem "spät" committen.
        // Keine sofortige failed-Audit — das Ergebnis steht erst bei Settlement fest.
        if (err instanceof TimeoutError && err.settlement) {
          const rawSettlement = err.settlement;
          const derived = rawSettlement.then(
            (value) => {
              // Audit-Fehler beim Late-Settlement muss das Settlement ablehnen.
              if (!commitTombstone(false)) {
                throw new Error("tombstone audit write failed (late settlement)");
              }
              return value;
            },
            (lateErr) => {
              failTombstone(lateErr?.name || "Error");
              throw lateErr;
            },
          );
          // Rejection beobachten, damit ein Late-Audit-Fehler nicht als
          // unhandled rejection den Prozess beendet; das Settlement bleibt abgelehnt.
          derived.catch((lateErr) => {
            host.logger.warn(`memory-lancedb-namespaced: memory_forget late settlement audit failed for agent=${agentId} memory=${memoryId}: ${String(lateErr)}`);
          });
          err.settlement = derived;
          throw err;
        }
        failTombstone(err?.name || "Error");
        throw err;
      }
      if (result?.notFound) {
        if (baseDbPath) {
          appendTombstoneToRegistry(baseDbPath, agentId, { ...tombstone, status: "failed" });
        }
        return { ok: false, notFound: true };
      }
      if (result?.alreadyTombstoned) {
        // Crash-Recovery: Zeile bereits deleted — fehlenden committed Tombstone
        // und Audit nachtragen. Fehlschlag des Backfills ist ein Fehler (fail-closed),
        // kein stilles ok:true.
        if (baseDbPath) {
          const backfill = backfillCommittedTombstone(baseDbPath, card, {
            agentId,
            actor,
            actorType,
            reason,
            sourceOp: source,
            archiveRef: archivePath,
            previousVersion: String(card?.previousVersion || ""),
          });
          // Audit IMMER schreiben (auch bei alreadyCommitted), damit ein zuvor
          // verschluckter Audit-Schreibfehler nicht dauerhaft unerfasst bleibt.
          const backfillAuditOk = appendDestructiveOpLog(workspaceDir, {
            event: "memory.deleted",
            source,
            agentId,
            memoryId,
            canonicalOriginId: backfill.tombstone.canonicalOriginId,
            via,
            query,
            archivePath,
            tombstoneId: backfill.tombstone.tombstoneId,
            result: backfill.alreadyCommitted ? "already_tombstoned" : "committed",
            timestamp: new Date().toISOString(),
          });
          if (!backfillAuditOk) {
            throw new Error("tombstone audit write failed");
          }
        }
        return { ok: true, alreadyTombstoned: true };
      }
      // Phase 2: committed erst nach bestätigter Mutation.
      if (!commitTombstone(Boolean(result?.alreadyTombstoned))) {
        throw new Error("tombstone audit write failed");
      }
      return { ok: true, alreadyTombstoned: Boolean(result?.alreadyTombstoned) };
    }

    function durableMergeLineage(candidate) {
      return [
        candidate.id,
        `valid-time:${stableValidTimeValue(candidate.validFrom)}:${stableValidTimeValue(candidate.validUntil)}`,
      ];
    }

    function isExpectedMergeReplacement(entry, replacementId, candidateId, expectedEntry, expectedCandidate) {
      if (!entry || entry.id !== replacementId || entry.text !== expectedEntry.text) return false;
      if (entry.status && entry.status !== "active") return false;
      const stableFields = [
        "agentId",
        "storedBy",
        "workspaceId",
        "workspaceKey",
        "scope",
        "ownerUserId",
        "sourceUrl",
        "evidenceQuote",
      ];
      if (stableFields.some((field) => entry[field] !== expectedEntry[field])) return false;
      if (!hasEquivalentEpistemicMetadata(entry, expectedEntry, { includeUpdatedAt: false })) return false;
      if (Number(entry.validFrom || 0) !== Number(expectedEntry.validFrom || 0)) return false;
      if (Number(entry.validUntil || 0) !== Number(expectedEntry.validUntil || 0)) return false;
      try {
        const lineage = JSON.parse(entry.mergedFrom || "[]");
        if (!Array.isArray(lineage)) {
          host.logger.debug(`memory-lancedb-namespaced: invalid mergedFrom shape for replacement=${replacementId}`);
          return false;
        }
        return durableMergeLineage(expectedCandidate).every((marker) => lineage.includes(marker));
      } catch (error) {
        host.logger.debug(`memory-lancedb-namespaced: invalid mergedFrom for replacement=${replacementId}: ${String(error)}`);
        return false;
      }
    }

    function isExpectedMergeCandidate(entry, expectedEntry, candidateId, accessCtx) {
      if (!entry || entry.id !== candidateId || entry.text !== expectedEntry.text) return false;
      if (entry.status && entry.status !== "active") return false;
      if (!hasEquivalentEpistemicMetadata(entry, expectedEntry)) return false;
      if (stableValidTimeValue(entry.validFrom) !== stableValidTimeValue(expectedEntry.validFrom)) return false;
      if (stableValidTimeValue(entry.validUntil) !== stableValidTimeValue(expectedEntry.validUntil)) return false;
      return candidateVisibleForStore({ entry }, accessCtx);
    }

    function runDurableMergeQueued(queueKey, operation) {
      const predecessor = durableMergeQueues.get(queueKey) || Promise.resolve();
      const operationPromise = predecessor
        .catch((predecessorErr) => {
          // The predecessor already delivered its own failure. Keep the key
          // usable for the next independent attempt and make the continuation
          // visible without propagating the old rejection into the new work.
          host.logger.debug(`memory-lancedb-namespaced: durable merge predecessor failed for ${queueKey}: ${String(predecessorErr)}`);
        })
        .then(operation);
      const settlementTail = operationPromise.catch(async (error) => {
        const settlement = await waitForTimeoutSettlement(error);
        if (settlement.status === "rejected") {
          host.logger.debug(
            `memory-lancedb-namespaced: durable merge late settlement failed for ${queueKey}: ${String(settlement.error)}`,
          );
        }
      });
      durableMergeQueues.set(queueKey, settlementTail);
      settlementTail.then(
        () => {
          if (durableMergeQueues.get(queueKey) === settlementTail) durableMergeQueues.delete(queueKey);
        },
        (trackingError) => {
          host.logger.warn(`memory-lancedb-namespaced: durable merge settlement tracking failed for ${queueKey}: ${String(trackingError)}`);
          if (durableMergeQueues.get(queueKey) === settlementTail) durableMergeQueues.delete(queueKey);
        },
      );
      return operationPromise;
    }

    async function withDurableMerge({
      db,
      agentId,
      selectedCandidate,
      accessCtx,
      workspaceDir,
      writeKey,
      prepareReplacement,
    }) {
      const candidateId = safeUuid(selectedCandidate?.entry?.id);
      const selectedText = selectedCandidate?.entry?.text;
      const queueKey = JSON.stringify([agentId, candidateId]);
      return runDurableMergeQueued(queueKey, async () => {
        const authoritativeCandidate = await db.getById(candidateId);
        if (!isExpectedMergeCandidate(authoritativeCandidate, selectedCandidate.entry, candidateId, accessCtx)) {
          const staleErr = new Error("merge candidate is stale, no longer active, or no longer authorized");
          host.logger.warn(`memory-lancedb-namespaced: durable merge revalidation failed for agent=${agentId} candidate=${candidateId}: ${staleErr.message}`);
          throw staleErr;
        }

        const { idempotencyKey, replacementId } = durableMergeIdentity(agentId, candidateId, writeKey || selectedText);

        const preparedResult = await prepareReplacement(authoritativeCandidate, replacementId);
        if (!preparedResult) return null;

        let candidateAfterPreparation;
        try {
          candidateAfterPreparation = await db.getById(candidateId);
        } catch (revalidationErr) {
          host.logger.warn(`memory-lancedb-namespaced: durable merge post-prepare revalidation read failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId}: ${String(revalidationErr)}`);
          throw revalidationErr;
        }
        if (!isExpectedMergeCandidate(candidateAfterPreparation, authoritativeCandidate, candidateId, accessCtx)) {
          const staleErr = new Error("stale merge candidate changed during replacement preparation");
          host.logger.warn(`memory-lancedb-namespaced: durable merge post-prepare revalidation failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId}: ${staleErr.message}`);
          throw staleErr;
        }

        const mergedEntry = { ...preparedResult.mergedEntry, id: safeUuid(replacementId) };
        const prepared = { ...preparedResult, mergedEntry };
        let archivePath = "";
        try {
          archivePath = archiveCard(authoritativeCandidate, agentId);
        } catch (archiveErr) {
          host.logger.warn(`memory-lancedb-namespaced: durable merge archive failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId} archive=${archivePath || "unwritten"}: ${String(archiveErr)}`);
          throw archiveErr;
        }

        const finishDurableMerge = async () => {
          let verifiedReplacement;
          try {
            verifiedReplacement = await db.getById(replacementId);
          } catch (verificationErr) {
            host.logger.warn(`memory-lancedb-namespaced: durable merge verification read failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId} archive=${archivePath}: ${String(verificationErr)}`);
            throw verificationErr;
          }
          if (!isExpectedMergeReplacement(verifiedReplacement, replacementId, candidateId, mergedEntry, authoritativeCandidate)) {
            const verificationErr = new Error(`merge replacement verification failed for ${replacementId}`);
            host.logger.warn(`memory-lancedb-namespaced: durable merge verification failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId} archive=${archivePath}: ${verificationErr.message}`);
            throw verificationErr;
          }

          let candidateBeforeDelete;
          try {
            candidateBeforeDelete = await db.getById(candidateId);
          } catch (revalidationErr) {
            host.logger.warn(`memory-lancedb-namespaced: durable merge pre-delete revalidation read failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId} archive=${archivePath}: ${String(revalidationErr)}`);
            throw revalidationErr;
          }
          if (!isExpectedMergeCandidate(candidateBeforeDelete, authoritativeCandidate, candidateId, accessCtx)) {
            const staleErr = new Error("stale merge candidate changed before original deletion");
            host.logger.warn(`memory-lancedb-namespaced: durable merge pre-delete revalidation failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId} archive=${archivePath}: ${staleErr.message}`);
            throw staleErr;
          }

          try {
            await deleteWithAuditContinuation({
              db,
              memoryId: candidateId,
              workspaceDir,
              logEntry: {
                event: "memory.deleted",
                source: "memory_store_merge",
                agentId,
                via: "merge",
                archivePath,
                idempotencyKey,
                timestamp: new Date().toISOString(),
              },
              onLateFailure: (lateDeleteError) => {
                host.logger.warn(`memory-lancedb-namespaced: durable merge late delete failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId} archive=${archivePath}: ${String(lateDeleteError)}`);
              },
            });
          } catch (deleteErr) {
            host.logger.warn(`memory-lancedb-namespaced: durable merge delete failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId} archive=${archivePath}: ${String(deleteErr)}`);
            throw deleteErr;
          }
          return { ...prepared, authoritativeCandidate, archivePath, idempotencyKey };
        };

        let existingReplacement;
        try {
          existingReplacement = await db.getById(replacementId);
        } catch (idempotencyReadError) {
          host.logger.warn(`memory-lancedb-namespaced: durable merge idempotency read failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId}: ${String(idempotencyReadError)}`);
          throw idempotencyReadError;
        }
        if (existingReplacement) {
          if (!isExpectedMergeReplacement(existingReplacement, replacementId, candidateId, mergedEntry, authoritativeCandidate)) {
            throw new Error(`durable merge idempotency collision for ${replacementId}`);
          }
          return finishDurableMerge();
        }

        try {
          await db.store(mergedEntry);
        } catch (storeErr) {
          if (storeErr instanceof TimeoutError && storeErr.settlement) {
            const rawStoreSettlement = storeErr.settlement;
            storeErr.settlement = rawStoreSettlement.then(
              () => finishDurableMerge(),
              (lateStoreError) => {
                host.logger.warn(`memory-lancedb-namespaced: durable merge late store failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId} archive=${archivePath}: ${String(lateStoreError)}`);
                throw lateStoreError;
              },
            );
          }
          host.logger.warn(`memory-lancedb-namespaced: durable merge store failed for agent=${agentId} candidate=${candidateId} replacement=${replacementId} archive=${archivePath}: ${String(storeErr)}`);
          throw storeErr;
        }

        return finishDurableMerge();
      });
    }

    async function storeMemoryFromToolParams(storeCtx = {}, params = {}) {
      const memoryCtx = storeCtx.memoryCtx || resolveToolMemoryRequestContext({
        agentId: storeCtx.agentId,
        workspaceDir: storeCtx.workspaceDir,
        sessionKey: storeCtx.sessionKey,
        messageChannel: storeCtx.messageChannel,
        agentAccountId: storeCtx.agentAccountId,
        requesterSenderId: storeCtx.requesterSenderId,
        deliveryContext: storeCtx.deliveryContext,
      }, { workspaceAliases: memoryWorkspaceAliases });
      const storeAgentId = memoryCtx.agentId;
      const scopeAccess = resolveStoreScopeAccess(memoryCtx, params.scope);
      if (!scopeAccess.ok) return { error: scopeAccess.error };
      const { scope, ownerUserId, ownershipFields } = scopeAccess;
      const storeWorkspaceKey = ownershipFields.workspaceKey;
      // v6.2.1 — Input-Validierung für Memory-Text (P0-Fix)
      const textValidation = validateMemoryText(params.text);
      if (!textValidation.ok) {
        return { error: textValidation.error };
      }
      const validTimeValidation = validateValidTimeInputFields(params, ["validFrom", "validUntil"]);
      if (!validTimeValidation.ok) return { error: validTimeValidation.error };
      const trace = createRecallDecisionTrace({
        query: textPreview(params.text, traceCfg.maxTextPreviewChars ?? 160),
        mode: "store",
        maxTextPreviewChars: traceCfg.maxTextPreviewChars ?? 160,
        maxCandidates: traceCfg.maxCandidates ?? 50,
      });
      try {
        return await pool.withWriteDb(storeAgentId, async (storeDb) => {
        const vector = await embeddings.embed(params.text, { agentId: storeAgentId });
        const categoryResult = params.category
          ? { category: params.category, reason: "caller-provided" }
          : categorizeMemoryWithReason(params.text);
        const category = categoryResult.category;
        const categoryReason = categoryResult.reason;
        const origin = MEMORY_ORIGINS.includes(params.origin) ? params.origin : "dm";
        const importanceResult = computeMemoryImportance({
          text: params.text,
          category,
          categoryReason,
          explicitImportance: params.importance,
          origin,
        });
        const importance = importanceResult.importance;
        addTraceStoreDecision(trace, {
          action: "importance_assessed",
          memoryId: null,
          reason: `category=${category} (${categoryReason}); importance=${importance.toFixed(2)}; ${importanceResult.importanceReason}`,
        });
        const expiresAt = params.ttl && TTL_MAP[params.ttl] ? Date.now() + TTL_MAP[params.ttl] : 0;
        const storeAccessCtx = memoryCtx;
        const sourceUrl = typeof params.sourceUrl === "string" ? params.sourceUrl.slice(0, 500) : "";
        const evidenceQuote = typeof params.evidenceQuote === "string" ? params.evidenceQuote.slice(0, 200) : "";
        // Phase 2 — Bi-Temporal Memory (§7): caller-supplied only, never
        // guessed/extracted from text. Unparseable/absent -> 0 (unknown).
        const { validFrom: capturedValidFrom, validUntil: capturedValidUntil } = normalizeCapturedValidityWindow(params, { logger: host.logger });

        // 0. Tombstone-Block: eine gleichlautende, zuvor gelöschte Erinnerung im
        // selben autorisierten Scope darf nicht still reaktiviert werden.
        const blockingTombstone = findBlockingTombstoneForCapture(baseDbPath, {
          agentId: storeAgentId,
          text: params.text,
          scope,
          workspaceIdentity: ownershipFields.workspaceId || ownershipFields.workspaceKey,
          ownerUserId,
        });
        if (blockingTombstone) {
          if (blockingTombstone._blockReason) {
            host.logger.warn(`memory-lancedb-namespaced: tombstone registry ${blockingTombstone._blockReason} for agent=${storeAgentId}: ${blockingTombstone._diagnostic || ""} — blocking capture fail-closed`);
          }
          addTraceStoreDecision(trace, {
            action: "tombstone_blocked",
            memoryId: blockingTombstone.memoryId,
            reason: blockingTombstone._blockReason || `forgotten memory fingerprint match (scope=${scope})`,
          });
          return {
            content: [{ type: "text", text: "This information was previously forgotten and cannot be silently re-stored." }],
            details: { action: "tombstone_blocked", id: blockingTombstone.memoryId, decisionTrace: trace },
          };
        }

        // 1. Duplicate check
        const existing = (await storeDb.findSimilar(vector, params.text, duplicateThreshold))
          .filter((candidate) => candidateVisibleForStore(candidate, storeAccessCtx));
        if (existing.length > 0) {
          const safeDuplicate = findSafeDuplicateForValidity(
            existing,
            params.text,
            { validFrom: capturedValidFrom, validUntil: capturedValidUntil },
          );
          if (!safeDuplicate) {
            // Nothing went wrong here: a near-duplicate was found, merging was refused
            // because the validity windows differ, and the memory was stored separately.
            // That is the conservative outcome, and the decision is already durable in the
            // trace as unsafe_duplicate_rejected. Reporting a safe refusal at warn turned a
            // routine store into an operator alarm -- 192 of them in one seeded run.
            host.logger.info(`[memory-merge-safety] high similarity but no safe duplicate; storing separately: "${params.text.slice(0, 120)}"`);
            addTraceStoreDecision(trace, { action: "unsafe_duplicate_rejected", memoryId: existing[0].entry.id, reason: "high similarity but no safe duplicate" });
          } else {
            if (storeCtx.workspaceDir) appendCurationLog(storeCtx.workspaceDir, storeAgentId, { event: "memory.rejected_duplicate", timestamp: new Date().toISOString(), agentId: storeAgentId, memoryId: safeDuplicate.entry.id, text: params.text.slice(0, 200), category, origin, reason: `duplicate_score:${safeDuplicate.score.toFixed(3)}`, relatedId: safeDuplicate.entry.id });
            addTraceStoreDecision(trace, { action: "safe_duplicate", memoryId: safeDuplicate.entry.id, reason: `duplicate_score:${safeDuplicate.score.toFixed(3)}` });
            return { content: [{ type: "text", text: `Similar memory already exists: "${safeDuplicate.entry.text}"` }], details: { action: "duplicate", id: safeDuplicate.entry.id, decisionTrace: trace } };
          }
        }

        // 2. Merge check (+ conflict detection for decision category)
        if (mergingEnabled && mergingLlmCfg && mergingAutoApply) {
          const mergeCandidateRaw = await storeDb.findMergeCandidate(vector, mergingThreshold, duplicateThreshold);
          const mergeCandidate = candidateVisibleForStore(mergeCandidateRaw, storeAccessCtx) ? mergeCandidateRaw : null;
          if (mergeCandidate) {
            addTraceStoreDecision(trace, { action: "merge_candidate", memoryId: mergeCandidate.entry.id, reason: `merge_score:${mergeCandidate.score.toFixed(3)}` });
            const durableMerge = await withDurableMerge({
              db: storeDb,
              agentId: storeAgentId,
              selectedCandidate: mergeCandidate,
              accessCtx: storeAccessCtx,
              workspaceDir: storeCtx?.workspaceDir,
              writeKey: durableMergeWriteKey({
                workspaceKey: storeWorkspaceKey,
                text: params.text,
                category,
                origin,
                importance,
                ttl: params.ttl && TTL_MAP[params.ttl] ? params.ttl : "",
                sourceUrl,
                evidenceQuote,
                scope,
                ownerUserId,
                validFrom: capturedValidFrom,
                validUntil: capturedValidUntil,
              }),
              prepareReplacement: async (authoritativeCandidate, replacementId) => {
                let mergeResult = null;
                if (hasMeaningfulDifference(authoritativeCandidate.text, params.text)) {
                  host.logger.warn(`[memory-merge-safety] merge candidate has meaningful difference; storing separately: "${params.text.slice(0, 120)}" vs "${authoritativeCandidate.text.slice(0, 120)}"`);
                  addTraceStoreDecision(trace, { action: "merge_aborted", memoryId: authoritativeCandidate.id, reason: "meaningful difference" });
                } else {
                  try {
                    mergeResult = await Promise.race([
                      callMergeCheck(
                        authoritativeCandidate.text,
                        params.text,
                        mergingLlmCfg,
                        storeAgentId,
                        storeCtx.callContext,
                      ),
                      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 30000)),
                    ]);
                  } catch (mergeErr) {
                    host.logger.warn("memory-lancedb-namespaced: merge check skipped", {
                      errorClass: normalizedLlmErrorClass(mergeErr),
                    });
                  }
                }
                if (category === "decision" && storeCtx.workspaceDir && authoritativeCandidate.storedBy && authoritativeCandidate.storedBy !== storeAgentId) {
                  const mergeDecision = mergeResult?.merge === true ? "merged" : "stored_separately";
                  appendConflictLog(storeCtx.workspaceDir, { schemaVersion: 1, timestamp: new Date().toISOString(), newMemoryId: null, newAgentId: storeAgentId, newText: params.text.slice(0, 200), existingMemoryId: authoritativeCandidate.id, existingAgentId: authoritativeCandidate.storedBy, existingText: authoritativeCandidate.text.slice(0, 200), score: mergeCandidate.score, category, mergeDecision });
                }
                const minLen = Math.min(authoritativeCandidate.text.length, params.text.length);
                if (!(mergeResult?.merge === true && mergeResult.mergedText && mergeResult.mergedText.length > minLen)) {
                  return null;
                }
                if (!validateMergedTextPreservesFacts(authoritativeCandidate.text, params.text, mergeResult.mergedText)) {
                  host.logger.warn(`[memory-merge-safety] LLM mergedText loses facts; aborting merge and storing separately: "${mergeResult.mergedText.slice(0, 120)}"`);
                  addTraceStoreDecision(trace, { action: "merge_aborted", memoryId: authoritativeCandidate.id, reason: "LLM mergedText loses facts" });
                  return null;
                }
                if (hasDisjointValidityWindows(authoritativeCandidate, { validFrom: capturedValidFrom, validUntil: capturedValidUntil })) {
                  host.logger.warn(`[memory-merge-safety] disjoint validity windows; aborting merge and storing separately`);
                  addTraceStoreDecision(trace, { action: "merge_aborted", memoryId: authoritativeCandidate.id, reason: "disjoint validity windows" });
                  return null;
                }
                const mergedImportance = Math.max(importance, authoritativeCandidate.importance ?? 0.5);
                const mergedVector = await embeddings.embed(mergeResult.mergedText, { agentId: storeAgentId });
                const mergedValidTime = combineValidTimeForMerge(authoritativeCandidate, { validFrom: capturedValidFrom, validUntil: capturedValidUntil });
                const mergedEntry = applyDynamicsDefaults({ id: replacementId, text: mergeResult.mergedText, summary: generateSummary(mergeResult.mergedText, summaryMaxWords), origin, vector: mergedVector, importance: mergedImportance, category, createdAt: Date.now(), mergedFrom: JSON.stringify(durableMergeLineage(authoritativeCandidate)), expiresAt, ...ownershipFields, ...durableMergeEpistemicMetadata(authoritativeCandidate), sourceTurnId: "", sourceMessageRole: "", sourceTimestamp: Date.now(), sourceUrl, evidenceQuote, scope, validFrom: mergedValidTime.validFrom, validUntil: mergedValidTime.validUntil }, Date.now(), halfLifeOverrides, { flashbulbEncodingEnabled });
                return { mergedEntry, mergeResult, mergedImportance };
              },
            });
            if (durableMerge) {
              const { mergedEntry, mergeResult, mergedImportance, authoritativeCandidate } = durableMerge;
              if (storeCtx.workspaceDir) appendCurationLog(storeCtx.workspaceDir, storeAgentId, { event: "memory.merged", timestamp: new Date().toISOString(), agentId: storeAgentId, memoryId: mergedEntry.id, text: mergeResult.mergedText.slice(0, 200), category, origin, reason: `merged_with:${authoritativeCandidate.id} (${mergeResult.reason || ""})`, relatedId: authoritativeCandidate.id });
              if (storeCtx.workspaceDir && shouldPromoteMemory(category, mergedImportance, importanceResult.factQuality, schicht15MinImportance)) {
                trackKnowledgePending(storeCtx.workspaceDir, { sourceAgent: storeAgentId, memoryId: mergedEntry.id, category, importance: mergedImportance });
              }
              addTraceStoreDecision(trace, { action: "merge_allowed", memoryId: mergedEntry.id, reason: `merged_with:${authoritativeCandidate.id} (${mergeResult.reason || ""})` });
              return { content: [{ type: "text", text: `Memory merged [${category}|${origin}]: "${mergeResult.mergedText}" (ID: ${mergedEntry.id})` }], details: { action: "merged", id: mergedEntry.id, decisionTrace: trace } };
            }
          }
        } else if (category === "decision" && storeCtx.workspaceDir) {
          try {
            const conflictCandidateRaw = await storeDb.findMergeCandidate(vector, mergingThreshold, duplicateThreshold);
            const conflictCandidate = candidateVisibleForStore(conflictCandidateRaw, storeAccessCtx) ? conflictCandidateRaw : null;
            if (conflictCandidate && conflictCandidate.entry.storedBy && conflictCandidate.entry.storedBy !== storeAgentId) {
              appendConflictLog(storeCtx.workspaceDir, { schemaVersion: 1, timestamp: new Date().toISOString(), newMemoryId: null, newAgentId: storeAgentId, newText: params.text.slice(0, 200), existingMemoryId: conflictCandidate.entry.id, existingAgentId: conflictCandidate.entry.storedBy, existingText: conflictCandidate.entry.text.slice(0, 200), score: conflictCandidate.score, category, mergeDecision: "no_merge_llm_call" });
            }
          } catch (_e) { dbg(_e); }
        }

        // 3. Normal store
        const summary = generateSummary(params.text, summaryMaxWords);
        const entry = applyDynamicsDefaults({ id: randomUUID(), text: params.text, summary, origin, vector, importance, category, createdAt: Date.now(), mergedFrom: "[]", expiresAt, ...ownershipFields, sourceTurnId: "", sourceMessageRole: "", sourceTimestamp: Date.now(), sourceUrl, evidenceQuote, scope, validFrom: capturedValidFrom, validUntil: capturedValidUntil, epistemicStatus: decideEpistemicStatusForCapture({ text: params.text, sourceMessageRole: "", origin, cutoffFailed: !epistemicCutoffBoot.ok }) }, Date.now(), halfLifeOverrides, { flashbulbEncodingEnabled });
        await storeDb.store(entry);
        if (riCfg.enabled) {
          setImmediate(() => {
            const maintenance = pool.withWriteDb(storeAgentId, (maintenanceDb) =>
              applyRetroactiveInterference(maintenanceDb, entry, {
                threshold: riCfg.threshold ?? 0.65,
                multiplier: riCfg.multiplier ?? 0.9,
                maxAffected: riCfg.maxAffected ?? 5,
              }));
            return maintenance.catch((err) => {
              host.logger.warn("[retroactive-interference] failed", err?.message ?? err);
            });
          });
        }
        if (storeCtx.workspaceDir) appendCurationLog(storeCtx.workspaceDir, storeAgentId, { event: "memory.stored", timestamp: new Date().toISOString(), agentId: storeAgentId, memoryId: entry.id, text: params.text.slice(0, 200), category, origin, reason: "stored", relatedId: null });
        if (storeCtx.workspaceDir && shouldPromoteMemory(category, importance, importanceResult.factQuality, schicht15MinImportance)) {
          trackKnowledgePending(storeCtx.workspaceDir, { sourceAgent: storeAgentId, memoryId: entry.id, category, importance });
        }
        addTraceStoreDecision(trace, { action: "stored_separately", memoryId: entry.id, reason: "stored" });
        return { content: [{ type: "text", text: `Memory stored [${category}|${origin}]: ${summary} (ID: ${entry.id})` }], details: { action: "stored", id: entry.id, decisionTrace: trace } };
        });
      } catch (err) {
        return { content: [{ type: "text", text: `Memory store failed: ${String(err)}` }] };
      }
    }

    // One policy builder for every service-side vault write (bridge service
    // and the discover-semantic-links cron): the exact workspace identity,
    // the bridge's mode/dryRun/allowWrite, and the receipt for THIS vault.
    // The cron handler used to call the discoverer without any policy, which
    // the policy layer rightly reads as "blocked", so scheduled discovery
    // never wrote a single link.
    const obsidianServiceMutationPolicy = (workspace, { plan = ["dashboards", "build"], actionConfirmed } = {}) => {
      const workspaceIdentity = normalizeWorkspaceTarget(
        workspace.workspaceId,
        "Obsidian service workspace",
      );
      const memoryCtx = {
        agentId: workspace.agentId,
        workspaceIdentity,
        workspaceId: workspaceIdentity,
      };
      return parseObsidianCommandPlan(plan, {
        memoryCtx,
        baseDbPath,
        mode: obsidianBridgeCfg.mode,
        dryRun: obsidianBridgeCfg.dryRun,
        allowWrite: obsidianBridgeCfg.allowWrite,
        vaultConfirmed: isOwnedVaultConfirmed({
          baseDbPath,
          memoryCtx,
          vaultPath: workspace.path,
        }),
        ...(actionConfirmed === undefined ? {} : { actionConfirmed }),
      }).mutationPolicy;
    };

    if (obsidianBridgeEnabled) {
      const bridgeService = createObsidianBridgeService(obsidianBridgeCfg, {
        logger: host.logger,
        loadLanceDbRecords: async ({ workspace }) => {
          const workspaceIdentity = normalizeWorkspaceTarget(
            workspace.workspaceId,
            "Obsidian service workspace",
          );
          const memoryCtx = Object.freeze({
            agentId: safeAgentId(workspace.agentId),
            workspaceIdentity,
            workspaceId: workspaceIdentity,
            userPrincipal: "",
            workspaceAliases: memoryWorkspaceAliases,
          });
          return pool.withAuthoritativeReadDb(memoryCtx.agentId, async (mirrorDb) => {
            const initialized = await mirrorDb.init();
            if (initialized === false) return [];
            const records = await mirrorDb.scanActive();
            if (!Array.isArray(records)) {
              throw new TypeError("Obsidian memory mirror scan must return an array");
            }
            return records.filter((record) => checkAccess(memoryCtx, record).allowed);
          });
        },
        mutationPolicyForWorkspace: (workspace) => obsidianServiceMutationPolicy(workspace),
        memoryStore: async ({ workspace, payload }) => {
          const memoryCtx = resolveMemoryRequestContext({
            agentId: workspace.agentId,
            workspaceDir: workspace.path,
          }, { workspaceAliases: memoryWorkspaceAliases });
          const result = await storeMemoryFromToolParams({ memoryCtx, workspaceDir: memoryCtx.workspaceDir }, payload);
          const text = result?.content?.[0]?.text || "";
          if (text.startsWith("Memory store failed")) throw new Error(text);
          return result;
        },
      });
      registerObsidianBridgeLifecycle({ api, bridgeService, host, obsidianBridgeCfg });
    }

    registerDeferredFeatureCronBootstrap({
      api,
      baseDbPath,
      cfg,
      cronDirectDispatchReady,
      host,
      reconcileUnsafeDirectCronsWithService,
      runDeferredFeatureCronBootstrap,
    });

    registerPromptSupplements({
      api,
      embeddings,
      findNeoRecord,
      getNeoStore,
      host,
      neoCfg,
      neoEnabled,
      neoRequester,
      neoRoot,
      neoWorkspaceAliases,
      runNeoGlobalSearch,
      sessionWorkspaceKeys,
    });

    {
      const resolveCommandLocale = (commandCtx) => {
        emitCommandRuntimeHook("onLocale", { commandCtx });
        const messages = commandCtx?.messages || [];
        const lang = resolveLocale({ ctx: commandCtx, messages, fallback: "en" });
        const toneHint = commandCtx?.workspaceDir ? readSoulToneCached(commandCtx.workspaceDir) : null;
        const tone = pickTone(toneHint);
        return { lang, tone };
      };

      // Every chat command is also reachable as operator (`openclaw plur1bus-command`),
      // bound to a named direct chat session. The registry keeps the same specs
      // the host receives, so both paths run the identical handler.
      const pluginCommandHandlers = new Map();
      const registerPluginCommand = (spec) => {
        if (spec && typeof spec.name === "string" && typeof spec.handler === "function") {
          pluginCommandHandlers.set(spec.name.toLowerCase(), spec);
        }
        return api.registerCommand(spec);
      };

      if (typeof api.registerCommand === "function") {
        const parsePlur1busArgs = (commandCtx) => commandCtx.args?.trim().split(/\s+/).filter(Boolean) || [];
        const plur1busHelp = (mode = "quick", opts = {}) => ({
          text: mode === "advanced" ? t("plur1bus.help_advanced", opts) : t("plur1bus.help_quick", opts),
        });
        const obsidianActionNames = new Set([
          "conflicts",
          "cron",
          "dashboards",
          "evening",
          "evening-review",
          "morning",
          "morning-review",
          "review",
        ]);
        const isCronCommandContext = (commandCtx) => {
          const channel = String(commandCtx?.channel || "").toLowerCase();
          const origin = String(commandCtx?.origin || commandCtx?.source || commandCtx?.kind || "").toLowerCase();
          const sessionKey = String(commandCtx?.sessionKey || "").toLowerCase();
          return channel === "cron"
            || origin === "cron"
            || /^agent:[^:]+:cron(?::|$)/.test(sessionKey);
        };
        const resolveCronMemoryContext = async (commandCtx) => {
          const agentId = safeAgentId(commandCtx?.agentId || "default");
          const workspaceDir = await host.runtime.agent.resolveAgentWorkspaceDir(commandCtx?.config, agentId);
          return resolveMemoryRequestContext({
            agentId,
            workspaceDir,
            channel: "cron",
            accountId: "cron",
          }, { workspaceAliases: memoryWorkspaceAliases });
        };
        // Chat command dispatch is deliberately deny-by-classification: a new
        // action must be added to one of these predicates before it may acquire
        // a store or other memory-bearing dependency.
        const SENSITIVE_READ_ACTIONS = new Set([
          "behavior", "curation", "doctor", "dreaming", "embeddings", "memory",
          "origin", "persona", "recall", "reminder", "reminders", "skills", "start",
          "state", "status", "temperament",
        ]);
        const isSensitiveChatRead = (actionKey, subKey) => {
          if (actionKey === "neo") return subKey === "workspaces";
          if (actionKey === "critical") return ["", "list"].includes(subKey);
          if (!SENSITIVE_READ_ACTIONS.has(actionKey)) return false;
          if (actionKey === "skills") return ["review", "list", "show"].includes(subKey);
          if (actionKey === "reminder" || actionKey === "reminders") return ["", "list", "show", "help"].includes(subKey);
          if (actionKey === "memory") return !["promote", "demote", "prune", "tombstone", "disable-overlay", "supersede-overlay"].includes(subKey);
          if (actionKey === "behavior") return !["promote", "demote", "prune"].includes(subKey);
          return true;
        };
        const isDestructiveAction = (actionKey, subKey, tokens) => (
          actionKey === "setup"
          || actionKey === "migrate-legacy-shared"
          || actionKey === "enable"
          || actionKey === "disable"
          || actionKey === "forget"
          || actionKey === "correct"
          || (actionKey === "critical" && ["accept", "reject", "edit"].includes(subKey))
          || (actionKey === "temperament" && Boolean(subKey))
          || (actionKey === "persona" && ["regenerate", "accept"].includes(subKey))
          || (actionKey === "skills" && ["approve", "reject"].includes(subKey))
          || (actionKey === "curation" && ["resolve", "apply-conflict", "drop-injected", "confirm"].includes(subKey))
          || ((actionKey === "reminder" || actionKey === "reminders") && ["cancel", "delete"].includes(subKey))
          || (actionKey === "memory" && ["promote", "demote", "prune", "tombstone", "disable-overlay", "supersede-overlay"].includes(subKey))
          || (actionKey === "behavior" && ["promote", "demote", "prune"].includes(subKey))
          || (actionKey === "neo" && subKey === "workspaces" && tokens[2] === "migrate" && !tokens.includes("--dry-run"))
        );
        const knownPlur1busActions = new Set([
          ...SENSITIVE_READ_ACTIONS, "setup", "enable", "disable", "forget", "correct",
          "internal", "migrate-legacy-shared", "neo", "critical",
        ]);
        // Pending-confirmation state, shared by the /plur1bus dispatcher and by
        // the user-facing command handlers registered further down. Both hold
        // the *same* two Map objects — a copy would split the nonce index from
        // the record store and silently break every confirmation round-trip.
        // They are declared here, above the first reader, rather than next to
        // the handlers: PR-03f evaluates the dispatcher's context object at
        // this point, and a `const` declared later is in its temporal dead zone.
        const confirmationStore = new Map();
        const confirmationIndex = new Map();
        const callCommandLlm = async (messages, llmCfg) => {
          emitCommandRuntimeHook("onLlmCallContext", llmCfg?.callContext);
          return callLlm(messages, llmCfg);
        };
        // PR-03g declares these ten here, above both readers: the command
        // runner below thunks them, and adapter/openclaw/register-commands.js
        // assigns them further down. A `const` at the assignment site would
        // leave the runner's context object inside their temporal dead zone.
        let runMemoryCommand, runForgetCommand, runCorrectCommand, runCriticalCommand,
          runStatusCommand, runFeatureToggle, checkArgsLength, checkAuth,
          resolveDenialLocale, resolveRegisteredMemoryContext;
        // The ten thunked keys below are declared *after* this point (the
        // user-facing command bodies and their auth/locale helpers). The
        // runner only calls them at command time, so a lazy `(...args) =>`
        // wrapper keeps this object literal out of their temporal dead zone.
        // `resolveNeoHooksConfig` is pre-bound to `api`: the engine module
        // never sees the OpenClaw plugin handle.
        const runPlur1busCommand = createPlur1busCommandRunner({
          __pluginDir,
          afterthoughtLlmCfg,
          aggregateSkillMinerRuns,
          applyEpistemicStatusToLanceDb,
          baseDbPath,
          callCommandLlm,
          callLlm,
          cfg,
          checkArgsLength: (...args) => checkArgsLength(...args),
          checkAuth: (...args) => checkAuth(...args),
          commandOption,
          completePendingConfirmation,
          confirmationIndex,
          confirmationStore,
          conflictResolutionLlmCfg,
          createFeatureRoute,
          createOwnerBoundMemoryStore,
          createOwnerBoundNeoStore,
          createOwnerBoundTarget,
          createPartitionScopedDb,
          dbg,
          dreamEchoLlmCfg,
          dreamNarrativeCfg,
          dreamNarrativeLlmCfg,
          embeddings,
          EMOTION_REFINE_DEADLINE_MS,
          EMOTION_REFINE_MAX_CONSECUTIVE_FAILURES,
          EMOTION_REFINE_MAX_ROWS,
          encodingCallLlm,
          episodeExtractionLlmCfg,
          findNeoRecord,
          flashbulbEncodingEnabled,
          formatJsonCommandResult,
          getFeatureCronsSetupHint,
          getNeoStore,
          host,
          isCronCommandContext,
          isDestructiveAction,
          isSensitiveChatRead,
          knownPlur1busActions,
          legacyMigrationShutdown,
          memoryCompactionLlmCfg,
          memoryDbAdapter,
          mergingEnabled,
          metaCognitionLlmReport,
          NEO_MANUAL_DRAIN_DEADLINE_MS,
          NEO_MANUAL_DRAIN_MAX_ITEMS,
          neoCfg,
          neoEmbeddingDrainImpact,
          neoEnabled,
          neoGlobalRecall,
          neoRequester,
          neoRoot,
          neoWorkspaceAliases,
          normalizedEmbeddingCfg,
          obsidianActionNames,
          obsidianBridgeCfg,
          obsidianServiceMutationPolicy,
          openClawSkillWorkshop,
          overlayAuditLlmCfg,
          parsePlur1busArgs,
          personaEvolveMinDaysBetween,
          personaEvolveMinOutcomes,
          personaMaxBullets,
          personaVoiceLlmCfg,
          plur1busHelp,
          pool,
          registeredObsidianCommandHandler,
          rememberNeoWorkspace,
          rememberPendingConfirmation,
          remPatternLlmCfg,
          resolveCommandLocale,
          resolveConfirmationIdentity,
          resolveCronMemoryContext,
          resolveDenialLocale: (...args) => resolveDenialLocale(...args),
          resolveEnvVars,
          resolveNeoHooksConfig: (commandConfig) => resolveNeoHooksConfig(api, commandConfig),
          resolveRegisteredMemoryContext: (...args) => resolveRegisteredMemoryContext(...args),
          resolveTemperamentName,
          runCorrectCommand: (...args) => runCorrectCommand(...args),
          runCriticalCommand: (...args) => runCriticalCommand(...args),
          runFeatureToggle: (...args) => runFeatureToggle(...args),
          runForgetCommand: (...args) => runForgetCommand(...args),
          runMemoryCommand: (...args) => runMemoryCommand(...args),
          runSemanticDiscoveryBatches,
          runStatusCommand: (...args) => runStatusCommand(...args),
          runtimeScheduler,
          selectSemanticDiscoveryWorkspaces,
          sharedMemoryPool,
          skillActivationDeps,
          skillLedgerDirsFor,
          skillMinerAutoApplyEffective,
          skillMinerCfg,
          skillMinerEnabled,
          skillMinerLlmCfg,
          storeMemoryFromToolParams,
          summarizeNeoStore,
          vectorDim,
          workspacePolicyGuard,
        });
        // Operator path for chat commands: `/name args` runs the registered
        // handler with the same identity-bound context the channel would build
        // for that direct chat (channel, account, peer, sender = peer). The
        // session key must name a direct chat of the requested agent; the
        // handler's own authorization (allowedUserIds, confirmations) applies
        // unchanged, so this grants nothing the chat owner could not do.
        const runOperatorCommand = async ({ agentId, sessionKey, command, locale }) => {
          const trimmed = String(command || "").trim();
          const match = /^\/([A-Za-z0-9_-]+)(?:@\S+)?(?:\s+([\s\S]*))?$/.exec(trimmed);
          if (!match) throw new Error("command must look like /name [args]");
          const spec = pluginCommandHandlers.get(match[1].toLowerCase());
          if (!spec) throw new Error(`unknown PLUR1BUS command /${match[1]}`);
          const direct = describeOperatorDirectSession(sessionKey, await hostRoutingLoader());
          if (!direct) throw new Error("session key must name a direct chat session (agent:<id>:<channel>:<account>:direct:<peer>)");
          if (direct.agentId !== safeAgentId(agentId)) throw new Error("session key belongs to a different agent");
          // The host hands every command its workspaceDir; several handlers
          // read it straight off the context (tone hint, vault paths).
          const workspaceDir = await host.runtime?.agent?.resolveAgentWorkspaceDir?.(api.config, direct.agentId);
          const commandCtx = {
            agentId: direct.agentId,
            sessionKey: direct.sessionKey,
            channel: direct.channel,
            accountId: direct.accountId,
            from: `${direct.channel}:${direct.peerId}`,
            senderId: direct.peerId,
            chatType: "private",
            workspaceDir,
            config: api.config,
            args: (match[2] || "").trim(),
            commandBody: trimmed,
            origin: "operator",
            source: "cli",
          };
          // 7.12.24: Ohne Chatverlauf fiel die Sprache auf Englisch zurueck.
          // resolveLocale nimmt ctx.lang vor der Nachrichten-Erkennung.
          const operatorLang = (typeof locale === "string" && locale.trim())
            || (typeof cfg.language === "string" && cfg.language.trim())
            || "";
          if (operatorLang) commandCtx.lang = operatorLang;
          const result = await spec.handler(commandCtx);
          const text = typeof result === "string" ? result : result?.text;
          return { text: typeof text === "string" && text.length > 0 ? text : "NO_REPLY" };
        };
        // PR-03g: every chat-command registration below this point — and,
        // for M1a, the six user-facing command bodies and the four
        // auth/locale helpers they share — lives in
        // adapter/openclaw/register-commands.js. The ten returned bindings
        // are assigned into the `let`s declared above the command runner, so
        // PR-03f's thunks keep resolving at command time.
        ({
          runMemoryCommand,
          runForgetCommand,
          runCorrectCommand,
          runCriticalCommand,
          runStatusCommand,
          runFeatureToggle,
          checkArgsLength,
          checkAuth,
          resolveDenialLocale,
          resolveRegisteredMemoryContext,
        } = registerChatCommands({
          CORRECTION_PREVIEW_CHARS,
          activeEmbeddingFingerprintId,
          api,
          applyEpistemicStatusToLanceDb,
          baseDbPath,
          cfg,
          collectSkillWorkshopDashboard,
          completePendingConfirmation,
          configuredObsidianWorkspaces,
          confirmationIndex,
          confirmationStore,
          controlHealth,
          cronDirectDispatchReady,
          dashboardSkillAction,
          dimensions,
          embeddings,
          emitCommandRuntimeHook,
          emotionalPool,
          getNeoStore,
          host,
          hostRoutingLoader,
          llmResultCache,
          makeQuerySummarizer,
          memoryDbAdapter,
          memoryWorkspaceAliases,
          mergingEnabled,
          modelPreparationCoordinator,
          namespaceLayout,
          normalizedEmbeddingCfg,
          obsidianVaultsConfirmed,
          openClawSkillWorkshop,
          parseConfirmationCommand,
          pool,
          recallQueryLlmCfg,
          reembeddingConfigMutationAvailable,
          reembeddingCoordinator,
          reembeddingStateStore,
          reembeddingSwitchRuntime,
          registerPluginCommand,
          registeredShareCard,
          rememberPendingConfirmation,
          reranker,
          rerankerCfg,
          resolveCommandLocale,
          resolveConfirmationIdentity,
          runOperatorCommand,
          runPlur1busCommand,
          sharedMemoryPool,
          skillActivationDeps,
          vectorDim,
          workspacePolicyGuard,
          workspacePolicyStore,
        }));
        registerPluginCommand({
          name: "wiki",
          description: "PLUR1BUS — Wiki durchsuchen, hinzufügen, löschen",
          acceptsArgs: true,
          channels: ["telegram", "discord", "slack", "mattermost"],
          handler: async (ctx) => {
            const parsed = parseWikiCommandInput(ctx?.args);
            if (!parsed.ready) {
              const { lang, tone } = resolveCommandLocale(ctx);
              return {
                text: t(parsed.responseKey, {
                  lang,
                  tone,
                  vars: parsed.responseVars,
                }),
              };
            }

            const memoryCtx = await resolveRegisteredMemoryContext(ctx);
            const requestNow = Date.now();
            const denied = checkWikiAuth(memoryCtx, cfg, {
              destructive: parsed.destructive,
              chatKind: memoryCtx.chatKind,
              localeCtx: ctx,
            });
            if (denied) return denied;

            const wikiAgentId = memoryCtx.agentId;
            const sessionRuntime = ctx?.runtimeContext?.llm;
            return runWikiCommand({ ...ctx, args: parsed.args }, {
              pool,
              embeddings,
              reranker,
              callLlm,
              cfg,
              api,
              ctx: memoryCtx,
              now: requestNow,
              workspaceDir: memoryCtx.workspaceDir,
              workspaceAliases: memoryWorkspaceAliases,
              llmCfg: mergingEnabled ? withLlmCallContext(
                wikiLlmCfg,
                wikiAgentId,
                "wiki",
                { runtimeLlm: sessionRuntime },
              ) : null,
            });
          },
        });
      }

      registerNeoServiceLifecycle({ api, host, neoEnabled, neoRoot, neoWorkerRuntime });
    }

    // ========================================================================
    // Auto-Capture: Speichere User-Nachrichten automatisch
    // ========================================================================

    if (autoCapture) {
      host.logger.info(`memory-lancedb-namespaced: enabling autoCapture`);

      registerCaptureHook({
        api,
        EPISODED_TURN_ID_MEMORY,
        MAX_POSTPROCESSING_RETRIES,
        NEO_HOOK_DRAIN_MARGIN_MS,
        NEO_HOOK_DRAIN_MIN_MS,
        baseDbPath,
        callLlm,
        captureSummaryLlmCfg,
        cfg,
        classifyEmotionForStore,
        classifyHostIncognitoSession,
        conversationInsightsLlmCfg,
        dreamEchoLlmCfg,
        dreamNarrativeCfg,
        dreamNarrativeLlmCfg,
        duplicateThreshold,
        embeddings,
        emotionIntensityHalfLifeFactor,
        emotionalPool,
        episodeExtractionLlmCfg,
        epistemicCutoffBoot,
        flashbulbEncodingEnabled,
        generateSummary,
        getNeoStore,
        halfLifeOverrides,
        host,
        memoryWorkspaceAliases,
        mergingEnabled,
        metaCognitionEnabled,
        metaCognitionIntervalMs,
        metaCognitionLlmReport,
        metaCognitionSessionThreshold,
        metaReflectionState,
        neoAgentEndBudgetMs,
        neoCfg,
        neoEmbeddingAutoDrainEnabled,
        neoEmbeddingDrainImpact,
        neoEmbeddingDrainMaxItems,
        neoEnabled,
        neoRoot,
        neoWorkerRuntime,
        neoWorkspaceAliases,
        personaVoiceLlmCfg,
        pool,
        rememberNeoWorkspace,
        reminderAutoExtract,
        resolveTemperamentName,
        runSpeakerProposalPipeline,
        runtimeScheduler,
        skillMinerEnabled,
        snapshotNeoMessages,
        snapshotNeoString,
        summarizeForCapture,
        summaryMaxWords,
        textSuggestsGroupOrigin,
        vectorDim,
        waitForTimeoutSettlement,
        workspacePolicyGuard,
      });
    }

    // Reply-based Outcome Tracking: Assistant-Antwort an das Pending-Outcome anhängen.
    if (replyOutcomeEnabled && typeof api.on === "function") {
      api.on("agent_end", (event, ctx) => {
        const background = isBackgroundTurn(event, ctx);
        if (background || !ctx?.workspaceDir) return;
        if (!automaticWorkspacePolicyDecision(event, ctx).allowed) return;
        const assistantText = lastMessageText(event.messages || [], ["assistant"]);
        if (!assistantText) return;
        try {
          recordAgentReplyForOutcome(ctx.workspaceDir, {
            agentId: ctx?.agentId || "default",
            sessionKey: sessionKeyFrom(event, ctx),
            assistantText,
            now: Date.now(),
            maxAssistantChars: replyOutcomeMaxAssistantChars,
          });
        } catch (err) {
          host.logger.warn(`reply-outcome-tracking: recording agent reply failed: ${String(err)}`);
        }
      });
    }

    // ========================================================================
    // Tools (per-Agent via Factory)
    // ========================================================================

    registerMemoryTools({
      KNOWLEDGE_LOCK_FILE,
      TTL_MAP,
      adaptiveBudgetCfg,
      api,
      appendConflictLog,
      appendCurationLog,
      baseDbPath,
      callLlm,
      callMergeCheck,
      candidateTopK,
      candidateVisibleForStore,
      canonicalEnabled,
      canonicalMaxItems,
      canonicalMinScore,
      cfg,
      classifyEmotionForStore,
      dbg,
      dedupEnabled,
      dedupJaccard,
      duplicateThreshold,
      durableMergeEpistemicMetadata,
      durableMergeLineage,
      durableMergeWriteKey,
      embeddings,
      emotionIntensityHalfLifeFactor,
      emotionalPool,
      epistemicCutoffBoot,
      findSafeDuplicateForValidity,
      flashbulbEncodingEnabled,
      forgetThreshold,
      formatKnownValidityLabel,
      generateSummary,
      getNeoStore,
      halfLifeOverrides,
      host,
      makeQuerySummarizer,
      maxPromptMemories,
      memoryWorkspaceAliases,
      mergingAutoApply,
      mergingEnabled,
      mergingLlmCfg,
      mergingThreshold,
      namespaceLayout,
      normalizeBoundedRecallInteger,
      normalizedLlmErrorClass,
      pool,
      queryRefinerEnabled,
      readKnowledgePendingSnapshot,
      recallMinScore,
      recallQueryLlmCfg,
      removeKnowledgePending,
      rerankCandidates,
      reranker,
      rerankerCfg,
      resolveRuntimeRecallBudget,
      resolveStoreScopeAccess,
      runMergedNamespaceRecall,
      runtimeScheduler,
      schicht15Enabled,
      schicht15LlmCfg,
      schicht15MaxPromotions,
      schicht15MinImportance,
      sharedMemoryPool,
      softBudgetFallback,
      softBudgetMs,
      summaryMaxWords,
      tombstoneMemoryWithAudit,
      traceCfg,
      traceEnabled,
      trackKnowledgePending,
      withDeterministicLlmContext,
      withDurableMerge,
      workspacePolicyGuard,
    });

    // ========================================================================
    // Auto-Recall: Memories before prompt build injecten
    // ========================================================================

    // resolveCommandLocale ist im neoEnabled-Block definiert, aber autoRecall
    // kann unabhängig davon aktiviert sein. Wir brauchen eine eigene Kopie,
    // die außerhalb beider Blöcke verfügbar ist.
    const resolveCommandLocaleRecall = (commandCtx) => {
      const messages = commandCtx?.messages || [];
      const lang = resolveLocale({ ctx: commandCtx, messages, fallback: "en" });
      const toneHint = commandCtx?.workspaceDir ? readSoulToneCached(commandCtx.workspaceDir) : null;
      const tone = pickTone(toneHint);
      return { lang, tone };
    };

    // P0-1: Minimaler Maintenance-Pfad für interne/background Turns (Cron,
    // Heartbeat, Dreaming, Magic Messages). Führt Neo-Hook-Tracking und
    // GC-Purge durch, erzeugt aber KEINEN Recall-Context.
    function runMinimalBeforePromptMaintenance(event, ctx, { neoEnabled, gcEnabled }) {
      const agentId = ctx?.agentId;
      if (neoEnabled) {
        try {
          const neoStore = getNeoStore(ctx, event);
          neoStore.recordHook("before_prompt_build", {
            agentId: ctx?.agentId || "default",
            promptLength: event?.prompt?.length || 0,
            runner: event?.runner || event?.provider || "",
            skipped: true,
          });
        } catch (neoErr) {
          host.logger.warn(`plur1bus-neo: before_prompt_build maintenance tracking failed: ${String(neoErr)}`);
        }
      }
      // GC: purge expired memories (non-blocking, throttled on hot path)
      if (gcEnabled) {
        pool.withDb(agentId, (db) => db.purgeExpiredThrottled(host.logger)).catch((gcErr) => {
          host.logger.warn(`memory-lancedb-namespaced: GC purge on internal turn failed: ${String(gcErr)}`);
        });
      }
      return undefined;
    }

    // Reply-based Outcome Tracking: vor dem Recall die vorherige Pending-Antwort abschließen.
    if (replyOutcomeEnabled && typeof api.on === "function") {
      api.on("before_prompt_build", async (event, ctx) => {
        const skipInternalRecall = shouldSkipAutoRecallForInternalTurn(event, ctx);
        if (!ctx?.workspaceDir || !event?.prompt || skipInternalRecall) return;
        if (!automaticWorkspacePolicyDecision(event, ctx).allowed) return;
        const outcomeAgentId = ctx?.agentId || "default";
        const startedAt = Date.now();
        try {
          // 7.12.30: Der Host fuehrt die Handler nacheinander aus; dieser lief vor
          // dem Recall und wartete auf bis zu zwoelf LanceDB-Updates. Jetzt bleiben
          // nur Klassifikation und Log-Dateien hier, die DB-Arbeit geht in die
          // Warteschlange und startet nach dem Recall (siehe replyOutcomeDynamics).
          const completed = await completePendingReplyOutcomes(ctx.workspaceDir, {
            agentId: outcomeAgentId,
            sessionKey: sessionKeyFrom(event, ctx),
            workspaceKey: ctx?.workspaceKey || ctx?.workspaceDir || null,
            replyText: event.prompt,
            dbPool: pool,
            applyDynamics: true,
            dynamicsScheduler: (run, meta) => replyOutcomeDynamics.enqueue(outcomeAgentId, run, meta),
            logger: host.logger,
            maxAgeMs: replyOutcomeMaxAgeMs,
            maxMemoryIds: replyOutcomeMaxMemoryIds,
            maxReplyChars: replyOutcomeMaxReplyChars,
            maxAssistantChars: replyOutcomeMaxAssistantChars,
            maxOutcomeLogEntries: replyOutcomeMaxOutcomeLogEntries,
            maxFeedbackLogEntries: replyOutcomeMaxFeedbackLogEntries,
          });
          const ms = Date.now() - startedAt;
          if (Array.isArray(completed) && completed.length > 0) {
            const line = `reply-outcome: completed outcomes=${completed.length} memoryIds=${completed.reduce((sum, entry) => sum + (entry.memoryIds?.length || 0), 0)} syncMs=${ms} queued=${replyOutcomeDynamics.pending(outcomeAgentId)} agent=${outcomeAgentId}`;
            if (ms >= REPLY_OUTCOME_SYNC_LOG_MS) host.logger.info(line); else host.logger.debug(line);
          }
        } catch (err) {
          host.logger.warn(`reply-outcome-tracking: completing pending outcomes failed: ${String(err)}`);
        }
      });
    }

    if (autoRecall) {
      registerTurnRouteHooks({ api, host, autoRecall, getMemoryTurnRoutes, turnRouteState });

      registerRecallHook({
        api,
        MAX_PROMPT_REPLY_OUTCOME_READ_BYTES,
        NEO_EMBED_TIMEOUT,
        NEO_RECALL_PRELUDE_LOG_MS,
        adaptiveBudgetCfg,
        autoRecallMinScore,
        automaticWorkspacePolicyDecision,
        buildMaintenanceNudges,
        callLlm,
        candidateTopK,
        canonicalEnabled,
        canonicalMaxItems,
        canonicalMinScore,
        cfg,
        dbg,
        dedupEnabled,
        dedupJaccard,
        detectReactionsCapabilityCached,
        embeddings,
        emotionalPool,
        gcEnabled,
        getMemoryTurnRoutes,
        getNeoStore,
        host,
        hostRoutingLoader,
        makeQuerySummarizer,
        markNeoRecallInjection,
        maxPromptMemories,
        memoryAccountTopology,
        memoryTextContradictionLlmCfg,
        memoryWorkspaceAliases,
        mergingEnabled,
        namespaceLayout,
        neoEnabled,
        neoGlobalRecall,
        neoRequester,
        neoWorkerRuntime,
        normalizeBoundedRecallInteger,
        normalizedLlmErrorClass,
        overlayLlmCfg,
        personaDirectiveMaxChars,
        personaVoiceLlmCfg,
        pool,
        queryRefinerEnabled,
        recallQueryLlmCfg,
        // Test-only hook (Task 19 fix round): the golden-prefix probe sets
        // `api.__recallTimingSinkForTests` on its stub api object so it can
        // read the pipeline's per-phase timings; no real OpenClaw host ever
        // sets this property, so `recallTimingSink` is always `null` here in
        // production and `createPromptContextAssembler` treats it as a no-op.
        recallTimingSink: api.__recallTimingSinkForTests ?? null,
        replyOutcomeDynamics,
        replyOutcomeEnabled,
        replyOutcomeMaxAssistantChars,
        replyOutcomeMaxMemoryIds,
        rerankCandidates,
        reranker,
        rerankerCfg,
        resolveCommandLocaleRecall,
        resolveRuntimeRecallBudget,
        runMergedNamespaceRecall,
        runMinimalBeforePromptMaintenance,
        runNeoGlobalSearch,
        runtimeScheduler,
        schicht15Enabled,
        semanticCompressionCfg,
        semanticLensCfg,
        sharedMemoryPool,
        skillLedgerDirForAgent,
        skillMinerEnabled,
        softBudgetFallback,
        softBudgetMs,
        summaryMaxWords,
        temporalContextEnabled,
        traceCfg,
        traceEnabled,
        traceInPrompt,
        workspacePolicyGuard,
      });
    } else if (neoEnabled || schicht15Enabled || gcEnabled) {
      // Auto-recall is off — record hook dispatch and run non-recall maintenance/nudges only.
      registerMaintenanceHook({
        api,
        host,
        automaticWorkspacePolicyDecision,
        buildMaintenanceNudges,
        gcEnabled,
        getNeoStore,
        neoEnabled,
        pool,
        resolveCommandLocaleRecall,
        schicht15Enabled,
        stateDir: host.stateDir,
        temporalContextEnabled,
      });
    }

    // Manual tools remain available regardless of autoCapture/autoRecall:
    // memory_store, memory_recall, memory_forget and knowledge_update are not
    // controlled by the automatic hook opt-outs above. Lifecycle ownership is
    // intentionally registered after every hook/capability registration and
    // independently of the optional chat-command surface.
    registerGatewayShutdownServices({
      api,
      clearInitializedTurnRoutes,
      coordinatesLocalModelGeneration,
      embeddings,
      legacyMigrationShutdown,
      llmResultCache,
      localModelGeneration,
      memoryDbAdapter,
      modelPreparationCoordinator,
      pool,
      reembeddingCoordinator,
      reembeddingSwitchRecovery,
      reranker,
      scopedEmbeddingServer,
      sharedMemoryPool,
    });
  },
};

export { MemoryDB, buildMaintenanceNudges, appendConflictLog, buildConflictSummaryFromLog, createRuntimeRerankerProvider, inspectCronNativeCapabilities, guardUnsafeDirectCronTurn, parseFeatureCronBootstrapLastPlanCreateCount, reconcileUnsafeDirectCronsWithService, runDeferredFeatureCronBootstrap };
export default plugin;
