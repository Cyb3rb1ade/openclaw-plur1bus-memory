/**
 * tests/selftest-sharp-degrade.test.js — sharp must not take down selftest.
 *
 * `@huggingface/transformers` imports `sharp` at module load. When the native
 * addon throws ERR_DLOPEN_FAILED, vision degrades with
 * `native_addon_unavailable:sharp`, text embed/capture/recall stay ok, and
 * there is no unhandledRejection.
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  SHARP_UNAVAILABLE_REASON,
  importTransformersBehindSharpProbe,
  sharpStubInstalled,
} from "../lib/native/sharp-unavailable.js";
import { throwSharpUnavailable } from "../lib/native/sharp-stub.js";
import { SELFTEST_SCHEMA, runSelftest } from "../lib/selftest/run-selftest.js";
import { makeTempDir } from "./helpers/temp-dir.js";

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

function sandbox(label = "st-sharp-") {
  const root = makeTempDir(label);
  const stateDir = join(root, "state");
  const openclawHome = join(root, "oc-home");
  const homeDir = join(root, "home");
  for (const dir of [stateDir, openclawHome, homeDir]) mkdirSync(dir, { recursive: true });
  return { root, stateDir, openclawHome, homeDir, env: { OPENCLAW_HOME: openclawHome } };
}

const presentModels = () => ({
  validate: async () => ({ ok: true, artifacts: [] }),
  ensure: async () => ({ downloaded: 0, reused: 1 }),
});

function stepOf(report, id) {
  const step = report.steps.find((entry) => entry.id === id);
  assert.ok(step, `step ${id} is reported`);
  return step;
}

function dlopenError() {
  const error = new Error("The module '/tmp/sharp.node' failed: libvips-cpp.so.8.17.3: cannot open shared object file");
  error.code = "ERR_DLOPEN_FAILED";
  return error;
}

async function withUnhandledRejectionGuard(body) {
  const rejections = [];
  const onUnhandled = (reason) => { rejections.push(reason); };
  process.on("unhandledRejection", onUnhandled);
  try {
    const result = await body();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(rejections.length, 0, `unhandledRejection: ${String(rejections[0])}`);
    return result;
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
}

describe("selftest sharp degrade", () => {
  it("ERR_DLOPEN_FAILED on sharp degrades vision and keeps text embed/capture/recall", async () => {
    const report = await withUnhandledRejectionGuard(async () => {
      const box = sandbox();
      const importer = async (specifier) => {
        if (specifier === "sharp") throw dlopenError();
        return {};
      };
      return runSelftest({
        stateDir: box.stateDir,
        env: box.env,
        homeDir: box.homeDir,
        importer,
        modelArtifacts: presentModels(),
        engineInternals: { embeddings: histogramEmbedder() },
      });
    });

    assert.equal(report.schema, SELFTEST_SCHEMA);
    assert.equal(report.ok, true, report.errors.join("; "));
    const sharp = report.addons.find((addon) => addon.name === "sharp");
    assert.equal(sharp.ok, false);
    assert.match(sharp.error, /libvips-cpp|ERR_DLOPEN_FAILED|cannot open shared object/);
    assert.equal(report.warnings.includes(SHARP_UNAVAILABLE_REASON), true);
    assert.equal(report.errors.some((entry) => /sharp/i.test(entry)), false);
    const vision = report.capabilities.find((capability) => capability.id === "vision");
    assert.deepEqual(vision, { id: "vision", status: "degraded", reason: SHARP_UNAVAILABLE_REASON });
    for (const id of ["embed", "capture", "recall"]) {
      assert.equal(stepOf(report, id).ok, true, `${id}: ${stepOf(report, id).detail}`);
      assert.equal(stepOf(report, id).skipped, undefined, id);
    }
  });

  it("a working sharp probe leaves vision ok", async () => {
    const box = sandbox();
    const report = await runSelftest({
      stateDir: box.stateDir,
      env: box.env,
      homeDir: box.homeDir,
      importer: async () => ({}),
      modelArtifacts: presentModels(),
      engineInternals: { embeddings: histogramEmbedder() },
    });
    assert.equal(report.ok, true, report.errors.join("; "));
    assert.deepEqual(report.capabilities, [{ id: "vision", status: "ok" }]);
    assert.equal(report.warnings.includes(SHARP_UNAVAILABLE_REASON), false);
  });

  it("lancedb failure still fails the selftest when sharp is also missing", async () => {
    const box = sandbox();
    const importer = async (specifier) => {
      if (specifier === "@lancedb/lancedb") throw new Error("Cannot find module '@lancedb/lancedb-linux-x64-gnu'");
      if (specifier === "sharp") throw dlopenError();
      return {};
    };
    const report = await runSelftest({
      stateDir: box.stateDir,
      env: box.env,
      homeDir: box.homeDir,
      importer,
      modelArtifacts: presentModels(),
      engineInternals: { embeddings: histogramEmbedder() },
    });
    assert.equal(report.ok, false);
    assert.match(report.errors[0], /@lancedb\/lancedb/);
    assert.equal(report.errors.some((entry) => /sharp/i.test(entry)), false);
    assert.equal(report.warnings.includes(SHARP_UNAVAILABLE_REASON), true);
  });

  it("the sharp stub throws the reason code and is not a thenable", () => {
    assert.equal(typeof throwSharpUnavailable, "function");
    assert.throws(() => throwSharpUnavailable("sharp()"), (error) => {
      assert.equal(error.reason, SHARP_UNAVAILABLE_REASON);
      assert.equal(error.code, "ERR_DLOPEN_FAILED");
      assert.match(error.message, /native_addon_unavailable:sharp/);
      return true;
    });
  });

  it("transformers import after a failed sharp probe uses the stub and does not reject", async () => {
    const mod = await withUnhandledRejectionGuard(async () => {
      const transformers = await importTransformersBehindSharpProbe({
        sharpImporter: async () => { throw dlopenError(); },
      });
      const req = createRequire(import.meta.url);
      const cjs = req("sharp");
      const esm = await import("sharp");
      return { transformers, cjs, esm: esm.default ?? esm };
    });
    assert.equal(sharpStubInstalled(), true);
    assert.equal(typeof mod.transformers.pipeline, "function");
    assert.throws(() => mod.cjs(), (error) => error.reason === SHARP_UNAVAILABLE_REASON);
    assert.throws(() => mod.esm(), (error) => error.reason === SHARP_UNAVAILABLE_REASON);
  });
});
