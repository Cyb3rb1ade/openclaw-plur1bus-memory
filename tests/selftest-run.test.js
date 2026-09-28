/**
 * tests/selftest-run.test.js — HM1 Task 2: `runSelftest`, the engine half of
 * `openclaw plur1bus selftest`.
 *
 * Every run gets a temp state dir, a temp OPENCLAW_HOME (so the model cache
 * the plugin would use resolves inside the temp dir) and a temp home dir (so
 * the default harness home and the default store path never point at the
 * machine's real ones). No test loads a real model: an embedder is injected
 * through the engine's test seam, and model artefact validation through the
 * `modelArtifacts` seam.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { E5_EMBEDDING_PROFILE, BGE_RERANKER_PROFILE } from "../lib/providers/local-model-artifacts.js";
import { probeNativeAddons } from "../lib/selftest/addon-probes.js";
import { SELFTEST_SCHEMA, SELFTEST_STEPS, runSelftest } from "../lib/selftest/run-selftest.js";
import { makeTempDir } from "./helpers/temp-dir.js";

// Distinct vectors per text (character histogram), so two probe texts are
// two memories and not duplicates of each other.
function histogramEmbedder(calls = []) {
  const vector = (text) => {
    const v = new Array(384).fill(0);
    for (const ch of String(text)) v[ch.charCodeAt(0) % 384] += 1;
    const norm = Math.hypot(...v) || 1;
    return v.map((x) => x / norm);
  };
  const record = (kind) => async (text) => { calls.push(kind); return vector(text); };
  return {
    embed: record("embed"),
    embedQuery: record("query"),
    embedPassage: record("passage"),
    embedBatch: async (texts) => texts.map(vector),
    shutdown: async () => {},
  };
}

function sandbox(label = "st-") {
  const root = makeTempDir(label);
  const stateDir = join(root, "state");
  const openclawHome = join(root, "oc-home");
  const homeDir = join(root, "home");
  for (const dir of [stateDir, openclawHome, homeDir]) mkdirSync(dir, { recursive: true });
  return { root, stateDir, openclawHome, homeDir, env: { OPENCLAW_HOME: openclawHome } };
}

const presentModels = (seen = []) => ({
  validate: async (profile, cacheDir) => { seen.push({ op: "validate", model: profile.model, cacheDir }); return { ok: true, artifacts: [] }; },
  ensure: async (profile, cacheDir) => { seen.push({ op: "ensure", model: profile.model, cacheDir }); return { downloaded: 0, reused: profile.artifacts.length }; },
});

const okImporter = async () => ({});

function stepOf(report, id) {
  const step = report.steps.find((entry) => entry.id === id);
  assert.ok(step, `step ${id} is reported`);
  return step;
}

function selftestDirs(stateDir) {
  return readdirSync(stateDir).filter((name) => name.startsWith("plur1bus-selftest-"));
}

async function run(box, overrides = {}) {
  return runSelftest({
    stateDir: box.stateDir,
    env: box.env,
    homeDir: box.homeDir,
    importer: okImporter,
    modelArtifacts: presentModels(),
    engineInternals: { embeddings: histogramEmbedder() },
    ...overrides,
  });
}

describe("runSelftest", () => {
  it("reports every addon and names the failing platform package", async () => {
    const importer = async (specifier) => {
      if (specifier === "@lancedb/lancedb") throw new Error("Cannot find module '@lancedb/lancedb-linux-x64-gnu'");
      return {};
    };
    const addons = await probeNativeAddons({ importer, platform: "linux", arch: "x64" });
    assert.deepEqual(addons.map((entry) => entry.name), ["@lancedb/lancedb", "onnxruntime-node", "sharp"]);
    assert.equal(addons[0].ok, false);
    assert.equal(addons[0].package, "@lancedb/lancedb-linux-x64-gnu");
    assert.match(addons[0].error, /Cannot find module/);
    assert.equal(addons[1].ok, true);
    assert.equal(addons[1].package, undefined);

    const win = await probeNativeAddons({ importer: async () => { throw new Error("load failed"); }, platform: "win32", arch: "arm64" });
    assert.equal(win[0].package, "@lancedb/lancedb-win32-arm64-msvc");
    assert.match(win[1].package, /onnxruntime-node[\\/]bin[\\/]napi-v\d+[\\/]win32[\\/]arm64[\\/]onnxruntime_binding\.node$/);
    assert.equal(win[2].package, "@img/sharp-win32-arm64");

    const box = sandbox();
    const report = await run(box, { importer });
    assert.equal(report.schema, SELFTEST_SCHEMA);
    assert.equal(report.ok, false);
    assert.equal(report.addons.length, 3);
    assert.equal(report.addons[0].ok, false);
    assert.equal(report.addons[0].package.startsWith("@lancedb/lancedb-"), true);
    assert.match(report.errors[0], /@lancedb\/lancedb/);
    assert.equal(report.target, `${process.platform}-${process.arch}`);
    assert.equal(report.node, process.version);
    assert.match(report.pluginVersion, /^\d+\.\d+\.\d+/);
  });

  it("round trip captures and recalls two probe texts and deletes the temp store", async () => {
    const box = sandbox();
    const calls = [];
    const report = await run(box, { engineInternals: { embeddings: histogramEmbedder(calls) } });
    assert.deepEqual(report.steps.map((step) => step.id), SELFTEST_STEPS);
    for (const id of ["coexistence", "store.open", "embed", "capture", "recall", "store.delete"]) {
      const step = stepOf(report, id);
      assert.equal(step.ok, true, `${id}: ${step.detail}`);
      assert.equal(step.skipped, undefined, id);
      assert.equal(typeof step.ms, "number");
    }
    assert.equal(stepOf(report, "rerank").skipped, "reranker-not-local");
    assert.equal(report.ok, true, report.errors.join("; "));
    assert.deepEqual(report.model, { profile: E5_EMBEDDING_PROFILE.model, revision: E5_EMBEDDING_PROFILE.revision, state: "present" });
    assert.ok(calls.includes("passage") && calls.includes("query"));
    assert.deepEqual(selftestDirs(box.stateDir), []);
    assert.deepEqual(readdirSync(box.stateDir), [], "nothing is left beside the temp store either");
    assert.equal(report.harnessHome, null);
  });

  it("--keep leaves the temp store and reports its path", async () => {
    const box = sandbox();
    const report = await run(box, { keep: true });
    assert.equal(report.ok, true, report.errors.join("; "));
    const step = stepOf(report, "store.delete");
    assert.equal(step.skipped, "keep");
    const [dir] = selftestDirs(box.stateDir);
    assert.ok(dir, "the temp store is kept");
    assert.equal(step.detail, join(box.stateDir, dir));
    assert.ok(existsSync(step.detail));
  });

  it("a missing model without --download-models skips embed, capture and recall with a warning and stays ok", async () => {
    const box = sandbox();
    const seen = [];
    // The real validator against the (empty) temp model cache.
    const report = await run(box, { modelArtifacts: undefined, engineInternals: undefined });
    assert.equal(report.model.state, "missing");
    assert.ok(report.warnings.includes("model-missing"));
    for (const id of ["embed", "capture", "recall"]) assert.equal(stepOf(report, id).skipped, "model-missing", id);
    assert.equal(stepOf(report, "store.open").ok, true);
    assert.equal(report.ok, true, report.errors.join("; "));
    assert.deepEqual(selftestDirs(box.stateDir), []);

    // With --download-models the artefacts are fetched into the cache the
    // plugin's local provider resolves (${OPENCLAW_HOME}/models/plur1bus).
    const missingThenEnsure = {
      validate: async (profile, cacheDir) => { seen.push({ op: "validate", cacheDir }); return { ok: false, artifacts: [] }; },
      ensure: async (profile, cacheDir, options) => { seen.push({ op: "ensure", cacheDir, options }); return { downloaded: 4, reused: 0 }; },
    };
    const downloaded = await run(box, { downloadModels: true, modelArtifacts: missingThenEnsure });
    assert.equal(downloaded.model.state, "downloaded");
    assert.equal(downloaded.ok, true, downloaded.errors.join("; "));
    const ensure = seen.find((entry) => entry.op === "ensure");
    assert.equal(ensure.cacheDir, join(box.openclawHome, "models", "plur1bus"));
    assert.equal(ensure.options.acceptNonCommercialLicense, false);
  });

  it("a remote provider is skipped unless remote is true", async () => {
    const box = sandbox();
    let fetches = 0;
    const fetchImpl = async () => { fetches += 1; throw new Error("no network in tests"); };
    const pluginConfig = { embedding: { provider: "openai", model: "text-embedding-3-small" } };
    const report = await run(box, { pluginConfig, fetchImpl, engineInternals: undefined, modelArtifacts: undefined });
    for (const id of ["embed", "capture", "recall"]) assert.equal(stepOf(report, id).skipped, "remote-provider", id);
    assert.equal(report.model.state, "skipped");
    assert.equal(fetches, 0);
    assert.equal(report.ok, true, report.errors.join("; "));

    // With remote: true the configured provider is used (here the injected
    // embedder stands in for it), and no local model is validated.
    const seen = [];
    const remote = await run(box, { pluginConfig, remote: true, fetchImpl, modelArtifacts: presentModels(seen) });
    assert.equal(stepOf(remote, "embed").ok, true);
    assert.equal(stepOf(remote, "embed").skipped, undefined);
    assert.equal(remote.model.state, "skipped");
    assert.deepEqual(seen, []);
    assert.equal(fetches, 0);
  });

  it("rerank runs only for an enabled local reranker with artefacts", async () => {
    const box = sandbox();
    const reranks = [];
    const reranker = { rerank: async (query, docs) => { reranks.push({ query, docs }); return docs.map((_, index) => ({ index, score: 1 - index / 10 })); }, shutdown: async () => {} };
    const local = { reranker: { enabled: true, provider: "local-transformers" } };

    const seen = [];
    const report = await run(box, { pluginConfig: local, modelArtifacts: presentModels(seen), engineInternals: { embeddings: histogramEmbedder(), reranker } });
    assert.equal(stepOf(report, "rerank").ok, true, stepOf(report, "rerank").detail);
    assert.equal(stepOf(report, "rerank").skipped, undefined);
    // The rerank step ranks the two probe texts (recall may use the reranker too).
    assert.ok(reranks.some((call) => Array.isArray(call.docs) && call.docs.length === 2 && call.docs.every((doc) => typeof doc === "string" && doc.includes("selftest probe"))));
    assert.ok(seen.some((entry) => entry.op === "validate" && entry.model === BGE_RERANKER_PROFILE.model));
    assert.equal(report.ok, true, report.errors.join("; "));

    // Without artefacts, disabled, or not local: the step is skipped, never
    // downloaded, and the engine is built without a reranker.
    const noArtefacts = {
      validate: async (profile) => ({ ok: profile.role !== "reranker", artifacts: [] }),
      ensure: async () => { throw new Error("rerank artefacts are never downloaded"); },
    };
    const missing = await run(box, { pluginConfig: local, downloadModels: true, modelArtifacts: noArtefacts });
    assert.equal(stepOf(missing, "rerank").skipped, "reranker-model-missing");
    assert.equal(missing.ok, true, missing.errors.join("; "));
    const disabled = await run(box, { pluginConfig: { reranker: { enabled: false, provider: "local-transformers" } } });
    assert.equal(stepOf(disabled, "rerank").skipped, "reranker-disabled");
    const cohere = await run(box, { pluginConfig: { reranker: { enabled: true, provider: "cohere" } } });
    assert.equal(stepOf(cohere, "rerank").skipped, "reranker-not-local");
  });

  it("a baseDbPath inside a harness home fails coexistence", async () => {
    const box = sandbox();
    const harnessHome = join(box.root, "harness home");
    mkdirSync(harnessHome, { recursive: true });
    writeFileSync(join(harnessHome, "manifest.json"), "{}\n");
    const env = { ...box.env, PLUR1BUS_HOME: harnessHome };

    const inside = await run(box, { env, pluginConfig: { baseDbPath: join(harnessHome, "lancedb") } });
    const step = stepOf(inside, "coexistence");
    assert.equal(step.ok, false);
    assert.equal(step.detail, "store-inside-harness-home");
    assert.ok(inside.errors.includes("store-inside-harness-home"));
    assert.equal(inside.ok, false);
    assert.equal(inside.harnessHome, harnessHome);

    // A host path resolver that answers nothing (seen in a real OpenClaw CLI
    // action) falls back to the plain path.
    const unresolved = await run(box, { env, pluginConfig: { baseDbPath: join(harnessHome, "lancedb") }, resolvePath: () => undefined });
    assert.equal(stepOf(unresolved, "coexistence").detail, "store-inside-harness-home");

    // A harness home beside the store is reported, not refused.
    const beside = await run(box, { env, pluginConfig: { baseDbPath: join(box.root, "lancedb") } });
    assert.equal(stepOf(beside, "coexistence").ok, true);
    assert.equal(beside.harnessHome, harnessHome);
    assert.equal(beside.ok, true, beside.errors.join("; "));

    // The default store (~/.openclaw/memory/lancedb-namespaced) inside a
    // default harness home at ~/.plur1bus is not possible, but a directory
    // without manifest.json is no harness home at all.
    const bare = join(box.root, "not a home");
    mkdirSync(bare);
    const noManifest = await run(box, { env: { ...box.env, PLUR1BUS_HOME: bare }, pluginConfig: { baseDbPath: join(bare, "lancedb") } });
    assert.equal(stepOf(noManifest, "coexistence").ok, true);
    assert.equal(noManifest.harnessHome, null);
  });

  it("works under a state dir with spaces and non-ASCII", async () => {
    const box = sandbox();
    const stateDir = join(box.root, "p b", "Jürgen", ".openclaw-work");
    mkdirSync(stateDir, { recursive: true });
    const report = await run(box, { stateDir });
    assert.equal(report.ok, true, report.errors.join("; "));
    assert.equal(stepOf(report, "recall").ok, true);
    assert.deepEqual(readdirSync(stateDir), []);
  });

  it("never includes config values in the report", async () => {
    const box = sandbox();
    const secret = "sk-TEST-DO-NOT-LOG";
    const pluginConfig = {
      embedding: { provider: "openai", apiKey: secret, baseUrl: "https://secret.example.invalid/v1" },
      reranker: { enabled: true, provider: "cohere", apiKey: secret },
      baseDbPath: join(box.root, "lancedb"),
    };
    for (const remote of [false, true]) {
      const report = await run(box, { pluginConfig, remote });
      const text = JSON.stringify(report);
      assert.equal(text.includes(secret), false, `remote=${remote}`);
      assert.equal(text.includes("secret.example.invalid"), false, `remote=${remote}`);
    }
  });
});
