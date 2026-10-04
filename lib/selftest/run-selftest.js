/**
 * lib/selftest/run-selftest.js — `openclaw plur1bus selftest` without OpenClaw
 * (HM1 Task 2, D86, spec A.4, HM1-R6, HM1-R17).
 *
 * Runs in the CLI process, never calls a Gateway, never opens the user's
 * store and never reports a config value:
 *
 *   1. imports each native addon (addon-probes.js); `sharp` is optional and
 *      degrades the `vision` capability instead of failing the run;
 *   2. `coexistence`: refuses a configured store inside a harness home;
 *   3. checks, and with `downloadModels` fetches, the embedding model into the
 *      cache the plugin's own local provider uses;
 *   4. opens a throw-away store `mkdtemp(<stateDir>/plur1bus-selftest-)`,
 *      embeds, captures two probe texts, recalls both, reranks when a local
 *      reranker with artefacts is configured;
 *   5. closes the engine and deletes the temp store unless `keep`.
 *
 * A remote embedding provider is only called with `remote`. A missing model
 * without `downloadModels` skips embed/capture/recall with the warning
 * `model-missing` and leaves `ok` true. No `api.` here.
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createEngine } from "../../engine/create-engine.js";
import { PLUGIN_VERSION } from "../plugin-meta.js";
import { nativeAddonUnavailableReason, installSharpUnavailableStub, warnSharpUnavailable } from "../native/sharp-unavailable.js";
import { ensurePinnedModelArtifacts, validatePinnedModelArtifacts } from "../providers/local-model-artifacts.js";
import { redactError } from "../safe-logging.js";
import { capabilitiesFromAddons, nativeAddonIsRequired, probeNativeAddons, requiredNativeAddonsOk } from "./addon-probes.js";
import {
  buildSelftestEngineConfig,
  createSelftestHost,
  harnessHomes,
  inertEmbeddingConfig,
  localModelCacheDir,
  resolveOpenclawStateDir,
  selftestEmbeddingPlan,
  selftestRerankPlan,
  storeInsideHarnessHome,
  userStorePath,
} from "./selftest-host.js";

export const SELFTEST_SCHEMA = "plur1bus.selftest/1";
export const SELFTEST_STEPS = Object.freeze(["coexistence", "store.open", "embed", "capture", "recall", "rerank", "store.delete"]);
export const SELFTEST_DIR_PREFIX = "plur1bus-selftest-";

const PROBES = Object.freeze([
  Object.freeze({
    text: "The selftest probe lighthouse keeper named Amarok paints the tower blue every spring.",
    query: "Who paints the lighthouse tower blue every spring?",
    marker: "Amarok",
  }),
  Object.freeze({
    text: "The selftest probe orchard in Valdivia grows forty rare quince varieties.",
    query: "How many quince varieties grow in the Valdivia orchard?",
    marker: "Valdivia",
  }),
]);

const AGENT_ID = "selftest";
// A direct chat on a known channel: the workspace policy lets automatic
// capture through only for a classified conversation.
const PRINCIPAL = Object.freeze({
  agentId: AGENT_ID,
  channel: "telegram",
  accountId: "default",
  chat: Object.freeze({ id: "selftest", kind: "direct" }),
  trust: "proved",
});
const AGENT = Object.freeze({ origin: "user", background: false });

// The first embed loads the model; everything else is a small local op.
const EMBED_TIMEOUT_MS = 180_000;
const STEP_TIMEOUT_MS = 60_000;
const CLOSE_BUDGET_MS = 15_000;

const CREDENTIAL_KEY_RE = /(?:api[-_]?key|token|secret|password|credential|authorization|headers?|base[-_]?url|endpoint|url)$/i;

function detailOf(error) {
  return redactError(error).message.split("\n")[0].slice(0, 300);
}

// String values under credential-like keys, anywhere in the plugin config.
function sensitiveValues(value, key = "", out = new Set(), seen = new Set()) {
  if (typeof value === "string") {
    if (CREDENTIAL_KEY_RE.test(key) && value.trim().length >= 4) out.add(value.trim());
    return out;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return out;
  seen.add(value);
  for (const [childKey, child] of Object.entries(value)) {
    sensitiveValues(child, Array.isArray(value) ? key : childKey, out, seen);
  }
  return out;
}

function scrub(report, secrets) {
  if (secrets.size === 0) return report;
  const list = [...secrets].sort((a, b) => b.length - a.length);
  const walk = (value) => {
    if (typeof value === "string") return list.reduce((text, secret) => text.split(secret).join("[redacted]"), value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    return value;
  };
  return walk(report);
}

/**
 * @typedef {object} SelftestReport
 * @property {"plur1bus.selftest/1"} schema
 * @property {boolean} ok
 * @property {string} pluginVersion
 * @property {string} node
 * @property {string} target `<platform>-<arch>`
 * @property {Array<{name: string, ok: boolean, package?: string, error?: string}>} addons
 * @property {Array<{id: string, status: "ok"|"degraded", reason?: string}>} capabilities
 * @property {{profile: string|null, revision: string|null, state: "present"|"downloaded"|"missing"|"skipped"}} model
 * @property {Array<{id: string, ok: boolean, ms: number, skipped?: string, detail?: string}>} steps
 * @property {string|null} harnessHome
 * @property {string[]} warnings
 * @property {string[]} errors
 */

/**
 * Run the selftest.
 * @param {object} options
 * @param {string} [options.stateDir] Where the temp store is created (`--state-dir`). Default: OpenClaw's
 *   state dir per F2 (OPENCLAW_STATE_DIR, profile, OPENCLAW_HOME/HOME, ~/.openclaw, legacy ~/.clawdbot);
 *   a root that does not exist is never created — the temp store then goes under `tmpDir`.
 * @param {object} [options.pluginConfig] `plugins.entries.memory-lancedb-namespaced.config`.
 * @param {boolean} [options.downloadModels] Download a missing embedding model.
 * @param {boolean} [options.remote] Call a configured remote embedding provider.
 * @param {boolean} [options.keep] Keep the temp store.
 * @param {object} [options.env]
 * @param {string} [options.platform]
 * @param {string} [options.arch]
 * @param {(specifier: string) => Promise<unknown>} [options.importer] Addon importer (test seam).
 * @param {typeof fetch} [options.fetchImpl] Model download fetch.
 * @param {() => number} [options.now] Monotonic milliseconds for step timing.
 * @param {string} [options.homeDir] Home directory for the default store and harness home.
 * @param {(p: string) => string} [options.resolvePath] Host path resolver for a configured baseDbPath.
 * @param {object} [options.logger] Engine logger (default: silent).
 * @param {{validate?: Function, ensure?: Function}} [options.modelArtifacts] Artefact validation/download (test seam).
 * @param {object} [options.engineInternals] createEngine's test-only internals (test seam: a fake embedder/reranker).
 * @returns {Promise<SelftestReport>}
 */
export async function runSelftest({
  stateDir,
  pluginConfig = {},
  downloadModels = false,
  remote = false,
  keep = false,
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  importer,
  fetchImpl = globalThis.fetch,
  now = () => performance.now(),
  homeDir = homedir(),
  tmpDir = tmpdir(),
  resolvePath,
  logger,
  modelArtifacts,
  engineInternals,
  scrubReport = true,
} = {}) {
  const config = pluginConfig && typeof pluginConfig === "object" ? pluginConfig : {};
  const validateArtifacts = modelArtifacts?.validate ?? validatePinnedModelArtifacts;
  // A cache root that does not exist yet is "missing", not an error
  // (resolveInside lstat()s the root before looking at any artefact).
  const validate = async (profile, cacheDir) => {
    try {
      return await validateArtifacts(profile, cacheDir);
    } catch (error) {
      if (error?.code === "ENOENT") return { ok: false, artifacts: [] };
      throw error;
    }
  };
  const ensure = modelArtifacts?.ensure ?? ensurePinnedModelArtifacts;
  // The OpenClaw state dir: --state-dir, else F2. Creating a missing one
  // (e.g. ~/.openclaw beside a legacy ~/.clawdbot) would change which dir
  // OpenClaw picks next time, so a missing root sends the temp store to tmpDir.
  const openclawStateDir = stateDir ? resolve(stateDir) : resolveOpenclawStateDir({ env, homeDir });
  const root = existsSync(openclawStateDir) ? openclawStateDir : tmpDir;
  const report = {
    schema: SELFTEST_SCHEMA,
    ok: false,
    pluginVersion: PLUGIN_VERSION,
    node: process.version,
    target: `${platform}-${arch}`,
    addons: [],
    capabilities: [],
    model: { profile: null, revision: null, state: "skipped" },
    steps: [],
    harnessHome: null,
    warnings: [],
    errors: [],
  };

  const step = async (id, body) => {
    const started = now();
    const entry = { id, ok: false, ms: 0 };
    try {
      const outcome = (await body()) ?? {};
      if (outcome.skipped) {
        entry.ok = true;
        entry.skipped = outcome.skipped;
      } else {
        entry.ok = outcome.ok !== false;
      }
      if (outcome.detail !== undefined) entry.detail = outcome.detail;
    } catch (error) {
      entry.ok = false;
      entry.detail = detailOf(error);
    }
    entry.ms = Math.max(0, Math.round(now() - started));
    if (!entry.ok) report.errors.push(id === "coexistence" ? entry.detail : `${id}: ${entry.detail ?? "failed"}`);
    report.steps.push(entry);
    return entry;
  };

  // 1. Native addons. `sharp` is optional: vision degrades, text paths continue.
  report.addons = await probeNativeAddons({ ...(importer ? { importer } : {}), platform, arch });
  report.capabilities = capabilitiesFromAddons(report.addons);
  for (const addon of report.addons) {
    if (addon.ok) continue;
    if (nativeAddonIsRequired(addon.name)) {
      report.errors.push(`addon ${addon.name} failed to load (${addon.package})`);
      continue;
    }
    const reason = nativeAddonUnavailableReason(addon.name);
    if (!report.warnings.includes(reason)) report.warnings.push(reason);
    warnSharpUnavailable(logger, addon.error || reason);
    // A test importer never loads the real module; only the production probe
    // needs the process-wide stub so a later transformers import can evaluate.
    if (addon.name === "sharp" && !importer) installSharpUnavailableStub();
  }

  // 2. Coexistence with a harness home (HM1-R17).
  await step("coexistence", async () => {
    const homes = harnessHomes({ env, platform, homeDir });
    report.harnessHome = homes[0] ?? null;
    const store = userStorePath(config, { homeDir, stateDir: openclawStateDir, resolvePath });
    const containing = homes.find((home) => storeInsideHarnessHome(store, home, platform));
    if (containing) {
      report.harnessHome = containing;
      return { ok: false, detail: "store-inside-harness-home" };
    }
    return { ok: true };
  });

  // 3. Embedding model (HM1-R6).
  let embedSkip = null;
  let plan;
  try {
    plan = selftestEmbeddingPlan(config, { remote });
  } catch (error) {
    report.errors.push(`model: ${detailOf(error)}`);
    embedSkip = "model-unavailable";
  }
  if (plan?.kind === "remote") {
    if (!plan.run) embedSkip = "remote-provider";
  } else if (plan?.kind === "local" && !plan.profile) {
    report.model = { profile: plan.model, revision: null, state: "skipped" };
    report.warnings.push("model-unpinned");
    embedSkip = "model-unpinned";
  } else if (plan?.kind === "local") {
    const { profile } = plan;
    report.model = { profile: profile.model, revision: profile.revision, state: "missing" };
    try {
      const cacheDir = localModelCacheDir(plan.embedding, env);
      const current = await validate(profile, cacheDir);
      if (current?.ok) {
        report.model.state = "present";
      } else if (downloadModels) {
        try {
          await ensure(profile, cacheDir, {
            acceptNonCommercialLicense: config.modelPreparation?.acceptNonCommercialLicense === true,
            fetchImpl,
          });
          report.model.state = "downloaded";
        } catch (error) {
          report.errors.push(`model: download failed: ${detailOf(error)}`);
          embedSkip = "model-missing";
        }
      } else {
        report.warnings.push("model-missing");
        embedSkip = "model-missing";
      }
    } catch (error) {
      report.errors.push(`model: ${detailOf(error)}`);
      embedSkip = "model-missing";
    }
  }

  // Rerank: an enabled local reranker whose artefacts are already present.
  let rerankSkip = null;
  let rerankPlan = null;
  try {
    rerankPlan = selftestRerankPlan(config);
    if (!rerankPlan.run) {
      rerankSkip = rerankPlan.reason;
    } else if (!(await validate(rerankPlan.profile, rerankPlan.cacheDir))?.ok) {
      rerankSkip = "reranker-model-missing";
    }
  } catch (error) {
    rerankSkip = "reranker-unavailable";
    report.warnings.push(`reranker: ${detailOf(error)}`);
  }

  // 4. Throw-away store round trip.
  let tempDir = null;
  let engine = null;
  await step("store.open", async () => {
    tempDir = await mkdtemp(join(root, SELFTEST_DIR_PREFIX));
    await mkdir(join(tempDir, "workspace"), { recursive: true });
    const engineConfig = buildSelftestEngineConfig({
      pluginConfig: config,
      baseDbPath: join(tempDir, "store"),
      embedding: embedSkip ? inertEmbeddingConfig() : plan.embedding,
      reranker: rerankSkip ? null : rerankPlan.reranker,
    });
    const host = createSelftestHost({ stateDir: tempDir, config: engineConfig, logger, env });
    engine = createEngine(host, engineConfig, engineInternals ? { internals: engineInternals } : {});
    const listed = await engine.memory.list({ since: 0 }, PRINCIPAL, AGENT);
    if (!Array.isArray(listed?.items)) return { ok: false, detail: "store did not answer a list" };
    return { ok: true };
  });

  const needsStore = (skip) => (engine ? skip : "store-unavailable");

  await step("embed", async () => {
    const skipped = needsStore(embedSkip);
    if (skipped) return { skipped };
    const [vector] = await engine.embedding.embed([PROBES[0].text], { kind: "passage", signal: AbortSignal.timeout(EMBED_TIMEOUT_MS) });
    if (!vector || vector.length === 0 || !Array.from(vector).every(Number.isFinite)) {
      return { ok: false, detail: "embedder returned no usable vector" };
    }
    return { ok: true, detail: `dimensions=${vector.length}` };
  });

  await step("capture", async () => {
    const skipped = needsStore(embedSkip);
    if (skipped) return { skipped };
    for (const [index, probe] of PROBES.entries()) {
      const outcome = await engine.capture({
        agentId: AGENT_ID,
        principal: PRINCIPAL,
        agent: AGENT,
        messages: [{ role: "user", content: probe.text }, { role: "assistant", content: "Noted." }],
        sessionKey: `agent:${AGENT_ID}:selftest-${index + 1}`,
        runId: `selftest-${index + 1}`,
        incognito: false,
        signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
      }).done;
      if (!(outcome?.stored >= 1)) {
        return { ok: false, detail: `probe ${index + 1} not stored (${outcome?.reason ?? "no reason"})` };
      }
    }
    return { ok: true, detail: `stored=${PROBES.length}` };
  });

  await step("recall", async () => {
    const skipped = needsStore(embedSkip);
    if (skipped) return { skipped };
    for (const [index, probe] of PROBES.entries()) {
      const result = await engine.recall({ query: probe.query, principal: PRINCIPAL, agent: AGENT, signal: AbortSignal.timeout(STEP_TIMEOUT_MS) });
      if (result?.degraded) return { ok: false, detail: `probe ${index + 1}: recall degraded (${result.degraded.reason})` };
      const text = (result?.blocks ?? []).map((block) => block.text).join("\n");
      if (!text.includes(probe.marker)) return { ok: false, detail: `probe ${index + 1} not recalled` };
    }
    return { ok: true, detail: `recalled=${PROBES.length}` };
  });

  await step("rerank", async () => {
    const skipped = needsStore(rerankSkip);
    if (skipped) return { skipped };
    const ranked = await engine.embedding.rerank(PROBES[0].query, PROBES.map((probe) => probe.text), {
      topN: PROBES.length,
      signal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    if (!Array.isArray(ranked) || ranked.length === 0) return { ok: false, detail: "reranker returned no ranking" };
    return { ok: true };
  });

  // 5. Close and delete the temp store.
  await step("store.delete", async () => {
    let closeError = null;
    if (engine) {
      try {
        await engine.close({ budgetMs: CLOSE_BUDGET_MS });
      } catch (error) {
        closeError = error;
      }
    }
    if (!tempDir) return { skipped: "store-unavailable" };
    if (keep) return { skipped: "keep", detail: tempDir };
    // Windows: Defender and LanceDB handles can hold files briefly (spec B.5).
    await rm(tempDir, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 });
    if (existsSync(tempDir)) return { ok: false, detail: `temp store still present: ${tempDir}` };
    if (closeError) return { ok: false, detail: `engine close failed: ${detailOf(closeError)}` };
    return { ok: true };
  });

  report.ok = report.errors.length === 0
    && requiredNativeAddonsOk(report.addons)
    && report.steps.every((entry) => entry.ok);
  return scrubReport ? scrub(report, sensitiveValues(config)) : report;
}
